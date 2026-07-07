import { and, asc, eq, gt, sql } from "drizzle-orm";
import { db, docEvents, docs, newId } from "@marigold/db";

// The feedback-loop events feed. An append-only, per-doc log of activity —
// comments, resolves, content changes — that watching agents long-poll (HTTP
// `GET /api/docs/:id/events`) or block on (MCP `get_feedback`) so a human
// comment reaches the agent in ≤1s instead of only when the human next prompts
// it. This module is the SOLE writer of `doc_events`; the web routes call
// `appendEvent` after a successful mutation (best-effort — see lib/events.ts).

/** The v1 event vocabulary. `type` is stored as text, so this is advisory. */
export type DocEventType =
  | "comment.created"
  | "comment.resolved"
  | "content.replaced"
  | "version.saved";

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
  /** The doc's current head seq (max over all events), 0 if none. */
  latest: number;
}

/**
 * Events after `sinceSeq`, ascending, capped at `limit`. `latest` is the doc's
 * current head seq so a caller can resume from it (`?since=latest`) or detect
 * that it is caught up. When the result is truncated by `limit`, resume from the
 * last returned event's seq — not `latest` — to avoid skipping the tail.
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
  const headRow = (
    await db
      .select({ m: sql<number>`coalesce(max(${docEvents.seq}), 0)` })
      .from(docEvents)
      .where(eq(docEvents.docId, opts.docId))
  )[0];
  return { events, latest: Number(headRow?.m ?? 0) };
}
