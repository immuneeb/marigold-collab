import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db, docEvents, docs, newId } from "@marigold/db";

// The feedback-loop events feed. An append-only, per-doc log of activity —
// comments, resolves, content changes — that watching agents long-poll (HTTP
// `GET /api/docs/:id/events`) or block on (MCP `get_feedback`) so a human
// comment reaches the agent in ≤1s instead of only when the human next prompts
// it. This module is the SOLE writer of `doc_events`; the web routes call
// `appendEvent` after a successful mutation (best-effort — see lib/events.ts).

/** The v1 event vocabulary. `type` is stored as text, so this is advisory.
 * `interaction.*` events carry their full detail (name, value, reader) in
 * `payload` — self-contained, no enrichment fetch needed. */
export type DocEventType =
  | "comment.created"
  | "comment.resolved"
  | "content.replaced"
  | "version.saved"
  | "interaction.created"
  | "interaction.updated"
  | "interaction.cleared";

export interface DocEvent {
  id: string;
  docId: string;
  seq: number;
  type: string;
  actor: string | null;
  payload: Record<string, unknown> | null;
  createdAt: Date;
}

export interface AppendEventInput {
  docId: string;
  type: DocEventType;
  actor?: string | null;
  payload?: Record<string, unknown> | null;
}

function toEvent(row: typeof docEvents.$inferSelect): DocEvent {
  return {
    id: row.id,
    docId: row.docId,
    seq: row.seq,
    type: row.type,
    actor: row.actor ?? null,
    payload: (row.payload as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * Append one event to a doc's feed, assigning the next per-doc `seq`. The doc
 * row is locked `for update` (versioning.ts's ordinal pattern) so concurrent
 * appends serialize and can never collide on `seq` — the unique index is the
 * backstop. Called AFTER the mutation it records has committed, so the brief
 * lock never blocks the mutation itself.
 */
export async function appendEvent(input: AppendEventInput): Promise<DocEvent> {
  const id = newId("evt");
  return db.transaction(async (tx) => {
    // Serialize seq assignment for this doc against concurrent appends.
    await tx
      .select({ id: docs.id })
      .from(docs)
      .where(eq(docs.id, input.docId))
      .for("update");
    const maxRow = (
      await tx
        .select({ m: sql<number>`coalesce(max(${docEvents.seq}), 0)` })
        .from(docEvents)
        .where(eq(docEvents.docId, input.docId))
    )[0];
    const seq = Number(maxRow?.m ?? 0) + 1;
    const row = (
      await tx
        .insert(docEvents)
        .values({
          id,
          docId: input.docId,
          seq,
          type: input.type,
          actor: input.actor ?? null,
          payload: input.payload ?? null,
        })
        .returning()
    )[0]!;
    return toEvent(row);
  });
}

export interface ListEventsResult {
  events: DocEvent[];
  /**
   * The cursor to resume from: the last DELIVERED event's seq, or `sinceSeq`
   * unchanged when caught up. Deliberately NOT the doc head — deriving the
   * resume point from a separate max(seq) query would let an event committed
   * between the events scan and the head scan advance the cursor past an
   * undelivered event, silently dropping it from the feed.
   */
  latest: number;
}

/**
 * Events after `sinceSeq`, ascending, capped at `limit`. A single scan: the
 * resume cursor is derived from the rows actually returned, so it can never
 * skip an event (see `latest`). To start "from now", resolve the head with
 * `headSeq` first.
 */
export async function listEvents(opts: {
  docId: string;
  sinceSeq: number;
  limit?: number;
}): Promise<ListEventsResult> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const events = (
    await db
      .select()
      .from(docEvents)
      .where(
        and(eq(docEvents.docId, opts.docId), gt(docEvents.seq, opts.sinceSeq)),
      )
      .orderBy(asc(docEvents.seq))
      .limit(limit)
  ).map(toEvent);
  const latest = events.length ? events[events.length - 1]!.seq : opts.sinceSeq;
  return { events, latest };
}

/** The doc's current head seq (max over all events), 0 if none. Use to resolve
 * a "start from now" request before entering a long-poll. */
export async function headSeq(docId: string): Promise<number> {
  const row = (
    await db
      .select({ m: sql<number>`coalesce(max(${docEvents.seq}), 0)` })
      .from(docEvents)
      .where(eq(docEvents.docId, docId))
  )[0];
  return Number(row?.m ?? 0);
}

/**
 * Long-poll for new events: poll `listEvents` every `pollMs` until something
 * lands after `sinceSeq`, the `waitMs` deadline passes, or `signal` aborts —
 * then return the (possibly empty) batch. The single shared implementation
 * behind both the HTTP `GET /events` route and the MCP `get_feedback` tool so
 * their cadence/cursor logic can't drift apart.
 */
export async function waitForEvents(opts: {
  docId: string;
  sinceSeq: number;
  waitMs: number;
  pollMs?: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<ListEventsResult> {
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + Math.max(0, opts.waitMs);
  for (;;) {
    const res = await listEvents({
      docId: opts.docId,
      sinceSeq: opts.sinceSeq,
      limit: opts.limit,
    });
    if (res.events.length > 0 || opts.signal?.aborted || Date.now() >= deadline)
      return res;
    await new Promise((r) =>
      setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))),
    );
  }
}
