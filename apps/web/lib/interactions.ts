import { and, asc, eq, sql } from "drizzle-orm";
import { db, docInteractions, newId, users } from "@marigold/db";

// Reader interactions: the typed, element-anchored signals emitted by in-doc
// <mg-control> elements. One row per (doc, control name, reader), last-write-
// wins — shared between the HTTP capture route and the MCP `get_state` tool so
// their semantics can't drift (the listComments/waitForEvents pattern).

export const CONTROL_TYPES = [
  "reaction",
  "rating",
  "choice",
  "toggle",
  "button",
  "custom",
] as const;
export type ControlType = (typeof CONTROL_TYPES)[number];

// Author-chosen control identity — must be safe to key on and echo back.
export const CONTROL_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export type InteractionValue = string | number | boolean;

export interface InteractionRow {
  id: string;
  name: string;
  controlType: string;
  value: InteractionValue;
  anchor: unknown;
  anchoredVersionId: string | null;
  orphaned: boolean;
  readerKey: string;
  readerId: string | null;
  readerName: string | null;
  guest: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Normalize a control type; unknown strings become "custom" (stored, typed). */
export function sanitizeControlType(raw: unknown): ControlType {
  return CONTROL_TYPES.includes(raw as ControlType)
    ? (raw as ControlType)
    : "custom";
}

/**
 * Validate a typed value. Returns the value (string trimmed + capped), `null`
 * for an explicit clear, or `undefined` when the input isn't a legal value —
 * the caller turns that into a 400.
 */
export function sanitizeInteractionValue(
  raw: unknown,
): InteractionValue | null | undefined {
  if (raw === null) return null;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw === "string") {
    const s = raw.trim();
    return s.length >= 1 && s.length <= 200 ? s : undefined;
  }
  return undefined;
}

/** The uniqueness key for a reader: account userId, or the guest-name proxy
 * (same identity model as guest comments — the name IS the identity). */
export function readerKeyFor(
  userId: string | null,
  guestName?: string | null,
): string | null {
  if (userId) return userId;
  if (guestName) return `guest:${guestName.toLowerCase()}`;
  return null;
}

/**
 * Set a reader's value for a control — insert or last-write-wins update on
 * (docId, name, readerKey). Returns whether the row was newly created (drives
 * interaction.created vs interaction.updated on the feedback feed).
 */
export async function upsertInteraction(opts: {
  docId: string;
  name: string;
  controlType: ControlType;
  value: InteractionValue;
  anchor: unknown;
  versionId: string | null;
  readerKey: string;
  readerId: string | null;
  readerName?: string | null;
  guest?: boolean;
}): Promise<{ id: string; created: boolean }> {
  const row = (
    await db
      .insert(docInteractions)
      .values({
        id: newId("itx"),
        docId: opts.docId,
        name: opts.name,
        controlType: opts.controlType,
        value: opts.value,
        anchor: opts.anchor ?? null,
        anchoredVersionId: opts.versionId,
        orphaned: false,
        readerKey: opts.readerKey,
        readerId: opts.readerId,
        readerName: opts.readerName ?? null,
        guest: opts.guest ?? false,
      })
      .onConflictDoUpdate({
        target: [
          docInteractions.docId,
          docInteractions.name,
          docInteractions.readerKey,
        ],
        set: {
          controlType: opts.controlType,
          value: opts.value,
          // Refresh the anchor to where the reader just tapped — the newest
          // capture is the best re-anchoring input.
          ...(opts.anchor != null
            ? {
                anchor: opts.anchor,
                anchoredVersionId: opts.versionId,
                orphaned: false,
              }
            : {}),
          updatedAt: new Date(),
        },
      })
      // xmax = 0 only on a fresh insert — distinguishes created from updated
      // without a read-then-write race.
      .returning({
        id: docInteractions.id,
        created: sql<boolean>`(xmax = 0)`,
      })
  )[0]!;
  return { id: row.id, created: row.created };
}

/** Clear a reader's value for a control (re-tap toggled it off). Returns true
 * when a row was actually removed. */
export async function clearInteraction(opts: {
  docId: string;
  name: string;
  readerKey: string;
}): Promise<boolean> {
  const rows = await db
    .delete(docInteractions)
    .where(
      and(
        eq(docInteractions.docId, opts.docId),
        eq(docInteractions.name, opts.name),
        eq(docInteractions.readerKey, opts.readerKey),
      ),
    )
    .returning({ id: docInteractions.id });
  return rows.length > 0;
}

/** All interaction rows on a doc (optionally one reader's), oldest first.
 * Account readers show their profile name, guests the name they supplied. */
export async function listInteractions(
  docId: string,
  filter?: { readerKey?: string },
): Promise<InteractionRow[]> {
  const conds = [eq(docInteractions.docId, docId)];
  if (filter?.readerKey)
    conds.push(eq(docInteractions.readerKey, filter.readerKey));
  return db
    .select({
      id: docInteractions.id,
      name: docInteractions.name,
      controlType: docInteractions.controlType,
      value: sql<InteractionValue>`${docInteractions.value}`,
      anchor: docInteractions.anchor,
      anchoredVersionId: docInteractions.anchoredVersionId,
      orphaned: docInteractions.orphaned,
      readerKey: docInteractions.readerKey,
      readerId: docInteractions.readerId,
      readerName: sql<
        string | null
      >`coalesce(${users.displayName}, ${docInteractions.readerName})`,
      guest: docInteractions.guest,
      createdAt: docInteractions.createdAt,
      updatedAt: docInteractions.updatedAt,
    })
    .from(docInteractions)
    .leftJoin(users, eq(docInteractions.readerId, users.id))
    .where(and(...conds))
    .orderBy(asc(docInteractions.createdAt));
}
