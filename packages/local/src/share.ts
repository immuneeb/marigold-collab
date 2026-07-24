/**
 * `marigold-draft share <file.html>` — graduate a local draft to hosted
 * Marigold through the zero-barrier quick door (POST /api/quick, no account).
 * Prints a share URL whose `?k=` IS the capability (anyone with the link can
 * view and comment) plus a claim URL for keeping the doc and controlling
 * access. Local comments stay in the local sidecar; the hosted copy starts a
 * fresh thread on the same anchoring engine.
 *
 * The network call is factored into `shareDraft(file, { fetchImpl })` with an
 * injectable fetch so it's testable without hitting prod.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { parse } from "node-html-parser";
import { ping } from "./telemetry";

export const DEFAULT_ORIGIN = "https://marigold.page";

// Injected by build.mjs (esbuild define) from package.json; "dev" when running
// straight from src (tests, tsx). Sent as X-Marigold-Source on the share
// upload so the server can attribute quick-door creations to the CLI — it
// rides the request you're already making; nothing else is sent or collected.
declare const __MARIGOLD_DRAFT_VERSION__: string | undefined;
const CLI_VERSION =
  typeof __MARIGOLD_DRAFT_VERSION__ === "string" ? __MARIGOLD_DRAFT_VERSION__ : "dev";

/** Same set the local `open` command accepts (server.ts FILE_RE). */
const FILE_RE = /\.(html?|svg)$/i;

/** Shape of the 201 body from POST /api/quick. */
export interface QuickSuccess {
  docId: string;
  slug: string;
  url: string;
  editKey: string;
  claimUrl: string;
  expiresAt: string;
}

/** A structured error carrying the quick door's `{ error, message, hint }`. */
export class ShareError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ShareError";
  }
}

export interface ShareOptions {
  title?: string;
  origin?: string;
  /** Injectable for tests; defaults to the global fetch (Node >=20). */
  fetchImpl?: typeof fetch;
}

/** Title precedence: explicit override → the file's <title> → filename sans ext. */
export function resolveShareTitle(html: string, file: string, override?: string): string {
  if (override && override.trim()) return override.trim();
  const titleTag = parse(html).querySelector("title")?.text?.trim();
  if (titleTag) return titleTag;
  return basename(file).replace(FILE_RE, "");
}

function resolveOrigin(override?: string): string {
  return (override ?? process.env.MARIGOLD_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/+$/, "");
}

export async function shareDraft(file: string, opts: ShareOptions = {}): Promise<QuickSuccess> {
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Mirror `open`: check the extension before touching the filesystem.
  if (!FILE_RE.test(file)) {
    throw new ShareError(`only .html, .htm, or .svg files can be shared (got "${basename(file)}")`);
  }
  if (!existsSync(file)) {
    throw new ShareError(`file not found: ${file}`);
  }
  const html = readFileSync(file, "utf8");
  const title = resolveShareTitle(html, file, opts.title);
  const origin = resolveOrigin(opts.origin);

  let res: Response;
  try {
    res = await fetchImpl(`${origin}/api/quick`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-marigold-source": `marigold-draft/${CLI_VERSION}`,
      },
      body: JSON.stringify({ title, html }),
    });
  } catch (e) {
    throw new ShareError(`could not reach hosted Marigold at ${origin} (${(e as Error).message})`);
  }

  if (res.status === 201) {
    ping("share.cloud");
    return (await res.json()) as QuickSuccess;
  }

  // Surface the server's error verbatim. Some errors carry an extra `message`
  // (theme/ingest failures) alongside `error` + `hint`.
  let body: { error?: string; message?: string; hint?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON error body — fall through to the status-only message */
  }
  const head = body.error ?? `share failed (${res.status})`;
  const message = body.message ? `${head}: ${body.message}` : head;
  throw new ShareError(message, body.hint, res.status);
}

function friendlyDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
}

/** The human/agent-friendly block printed on a successful share. */
export function formatShareResult(r: QuickSuccess): string {
  return `Shared to hosted Marigold.

  Share link — anyone with this link can view and comment:
    ${r.url}
  Link-visible only, never listed. Expires ~30 days after the last write (${friendlyDate(r.expiresAt)}).

  Keep it / control access:
    ${r.claimUrl}
  Open this and sign in: the doc moves into your account and this quick link stops
  granting edit. Then share by email at viewer / commenter / editor roles, with
  version history.

Local comments stay in the local sidecar; the hosted copy starts a fresh thread
(same anchoring engine, so comments re-anchor across revisions there too).`;
}
