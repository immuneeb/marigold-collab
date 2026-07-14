import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import * as http from "node:http";
import { homedir } from "node:os";
import { dirname, basename, join, resolve as resolvePath } from "node:path";
import { parse } from "node-html-parser";
import { ANCHOR_AGENT_JS } from "@marigold/core/agent-src";
import { applyInlineEdits, instrumentHtml, type CommentAnchor } from "@marigold/core/instrument";
import {
  isFullDocument,
  loadSidecar,
  prepareHtml,
  reanchorComments,
  saveSidecar,
  sha256Hex,
  WRAP_MAIN_CLASS,
  type LocalComment,
  type ReviewRound,
  type Sidecar,
} from "./store";
import { indexHtml, shellHtml } from "./shell";

interface Waiter {
  res: http.ServerResponse;
  timer: NodeJS.Timeout;
}

interface DocSession {
  docId: string;
  path: string; // absolute
  sidecar: Sidecar;
  contentHash: string;
  instrumented: string;
  sse: Set<http.ServerResponse>;
  waiters: Set<Waiter>;
  watcher: FSWatcher | null;
  refreshTimer: NodeJS.Timeout | null;
  // Inline edits write the file ourselves; the watcher still re-instruments +
  // re-anchors but must not reload the iframe (the DOM is already current).
  selfWriteUntil: number;
}

export interface LocalServerOptions {
  /** Allow POST /api/shutdown to exit the process (daemon mode only). */
  allowShutdown?: boolean;
  /** Debounce for file-change refresh, ms. */
  watchDebounceMs?: number;
}

export interface ReviewPayload {
  event: "review.completed";
  file: string;
  title: string;
  url: string;
  version: number;
  reviewSeq: number;
  overallComment: string | null;
  openComments: Array<{
    id: string;
    author: string;
    body: string;
    status: string;
    kind: "overall" | null;
    anchoredText: string | null;
    replies: Array<{ id: string; author: string; body: string; byAi: boolean }>;
  }>;
  counts: { open: number; resolved: number; orphaned: number };
  hint: string;
}

const FILE_RE = /\.(html?|svg)$/i;

// docId → file path, persisted so a restarted daemon can lazily re-open docs
// that still-open tabs keep fetching (docIds are path hashes — not reversible).
// Path resolved per call so tests can isolate via MARIGOLD_LOCAL_HOME.
function registryFile(): string {
  return join(process.env.MARIGOLD_LOCAL_HOME ?? homedir(), ".marigold-local", "docs.json");
}

type Registry = Record<string, { path: string; title?: string }>;

function registryLoad(): Registry {
  try {
    return JSON.parse(readFileSync(registryFile(), "utf8")) as Registry;
  } catch {
    return {};
  }
}

function registrySave(docId: string, path: string, title?: string): void {
  try {
    const reg = registryLoad();
    reg[docId] = { path, ...(title ? { title } : {}) };
    const file = registryFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(reg, null, 2) + "\n");
  } catch {
    /* registry is best-effort — worst case a restarted daemon 404s until re-open */
  }
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const b = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(b);
}

/** Same CSP posture as the prod render origin (core/render.ts), so a draft
 * that works locally renders identically once pushed to cloud Marigold.
 * The origin is named EXPLICITLY alongside 'self': the doc lives in a
 * sandboxed iframe whose document origin is opaque, and WebKit resolves
 * 'self' against that opaque origin — which silently blocked the anchor
 * agent script in Safari (no commenting, no selection). A host-source
 * matches regardless of sandboxing. */
function frameHeaders(origin: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": [
      `default-src 'self' ${origin}`,
      `script-src 'self' ${origin} 'unsafe-inline'`,
      `style-src 'self' ${origin} 'unsafe-inline'`,
      `img-src 'self' ${origin} data:`,
      `font-src 'self' ${origin} data:`,
      "connect-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors 'self' ${origin}`,
    ].join("; "),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error("invalid_json"), { status: 400 });
  }
}

export class LocalServer {
  private byId = new Map<string, DocSession>();
  private byPath = new Map<string, DocSession>();
  /** Long-lived agent subscriptions (`marigold-draft listen`) — one stream
   * covers every draft. Presence for tabs = doc waiters OR any listener. */
  private agentListeners = new Set<http.ServerResponse>();
  readonly server: http.Server;
  private opts: Required<LocalServerOptions>;
  port = 0;
  readonly startedAt = new Date().toISOString();

  constructor(opts: LocalServerOptions = {}) {
    this.opts = { allowShutdown: false, watchDebounceMs: 120, ...opts };
    this.server = http.createServer((req, res) => {
      this.route(req, res).catch((e: Error & { status?: number }) => {
        if (!res.headersSent) json(res, e.status ?? 500, { error: e.message });
        else res.end();
      });
    });
  }

  listen(port: number): Promise<number> {
    return new Promise((resolveP, rejectP) => {
      this.server.once("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "EADDRINUSE" && port !== 0) {
          // Preferred port taken (likely a stale or foreign process) — let the
          // OS pick; the CLI reads the real port from server.json.
          this.server.removeAllListeners("error");
          this.listen(0).then(resolveP, rejectP);
        } else rejectP(e);
      });
      this.server.listen(port, "127.0.0.1", () => {
        const addr = this.server.address();
        this.port = typeof addr === "object" && addr ? addr.port : port;
        resolveP(this.port);
      });
    });
  }

  close(): void {
    for (const l of this.agentListeners) l.end();
    this.agentListeners.clear();
    for (const s of this.byId.values()) {
      s.watcher?.close();
      if (s.refreshTimer) clearTimeout(s.refreshTimer);
      for (const c of s.sse) c.end();
      for (const w of s.waiters) {
        clearTimeout(w.timer);
        w.res.end();
      }
    }
    this.server.close();
  }

  private origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }
  private urlFor(s: DocSession): string {
    return `${this.origin()}/d/${s.docId}`;
  }

  // ── doc lifecycle ──

  openDoc(path: string, title?: string): DocSession {
    const abs = resolvePath(path);
    if (!FILE_RE.test(abs)) {
      throw Object.assign(new Error("only .html/.htm/.svg files are supported"), { status: 400 });
    }
    if (!existsSync(abs)) {
      throw Object.assign(new Error(`file not found: ${abs}`), { status: 404 });
    }
    const existing = this.byPath.get(abs);
    if (existing) {
      if (title) {
        existing.sidecar.title = title;
        saveSidecar(abs, existing.sidecar);
      }
      return existing;
    }
    const sidecar = loadSidecar(abs, title);
    const session: DocSession = {
      docId: sidecar.docId,
      path: abs,
      sidecar,
      contentHash: "",
      instrumented: "",
      sse: new Set(),
      waiters: new Set(),
      watcher: null,
      refreshTimer: null,
      selfWriteUntil: 0,
    };
    this.rebuild(session, /* bumpVersion */ sidecar.version === 0);
    saveSidecar(abs, session.sidecar);

    // Watch the directory (rename-resilient for atomic-save editors) and filter
    // to our basename. The sidecar lives in the same dir but has a different name.
    const base = basename(abs);
    session.watcher = watch(dirname(abs), (_event, filename) => {
      if (filename && filename !== base) return;
      if (session.refreshTimer) clearTimeout(session.refreshTimer);
      session.refreshTimer = setTimeout(() => this.refreshFromDisk(session), this.opts.watchDebounceMs);
    });

    this.byId.set(session.docId, session);
    this.byPath.set(abs, session);
    registrySave(session.docId, abs, session.sidecar.title);
    return session;
  }

  /** Find a session by docId, lazily re-opening from the persisted registry —
   * this is what lets a tab opened before a daemon restart keep working. */
  private resolveSession(docId: string): DocSession | null {
    const existing = this.byId.get(docId);
    if (existing) return existing;
    const entry = registryLoad()[docId];
    if (!entry || !existsSync(entry.path)) return null;
    try {
      return this.openDoc(entry.path, entry.title);
    } catch {
      return null;
    }
  }

  /** Read the file, wrap+instrument, re-anchor. Returns true if content changed. */
  private rebuild(session: DocSession, bumpVersion: boolean): boolean {
    const src = this.readSource(session.path);
    const hash = sha256Hex(src);
    if (hash === session.contentHash) return false;
    session.contentHash = hash;
    session.instrumented = instrumentHtml(prepareHtml(src, session.sidecar.title));
    if (bumpVersion) session.sidecar.version += 1;
    reanchorComments(session.sidecar.comments, session.instrumented);
    return true;
  }

  /** Editors save atomically (write + rename), so briefly-missing/empty reads happen. */
  private readSource(path: string): string {
    for (let i = 0; ; i++) {
      try {
        const src = readFileSync(path, "utf8");
        if (src.trim()) return src;
      } catch {
        /* retry */
      }
      if (i >= 4) return "";
      const wait = 50;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
    }
  }

  private refreshFromDisk(session: DocSession): void {
    const selfWrite = Date.now() < session.selfWriteUntil;
    const changed = this.rebuild(session, true);
    if (!changed) return;
    saveSidecar(session.path, session.sidecar);
    if (selfWrite) {
      // The browser's DOM already reflects this write — just advance its version
      // pointer (used as the cache-buster on the NEXT reload) and sync comments.
      this.broadcast(session, "version", { version: session.sidecar.version });
      this.broadcast(session, "comments", {});
    } else {
      this.broadcast(session, "reload", { version: session.sidecar.version });
      this.broadcast(session, "comments", {});
    }
  }

  private broadcast(session: DocSession, event: string, data: unknown): void {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of session.sse) c.write(frame);
  }

  private agentPresent(session: DocSession): boolean {
    return session.waiters.size > 0 || this.agentListeners.size > 0;
  }

  /** Tell open tabs whether an agent is reachable (blocked on /wait or holding
   * a listen stream) — the shell shows this so "Send" never silently lands in
   * a void. */
  private broadcastAgentPresence(session: DocSession): void {
    this.broadcast(session, "agent", { listening: this.agentPresent(session) });
  }

  private broadcastAgentPresenceAll(): void {
    for (const s of this.byId.values()) this.broadcastAgentPresence(s);
  }

  /** Freeform text from EVERY round not yet handed to an agent — catch-up
   * delivers one payload for possibly many rounds, and an earlier round's
   * overall feedback must not be skipped just because a later round exists. */
  private pendingOverall(session: DocSession): string | null {
    const texts = session.sidecar.reviews
      .slice(session.sidecar.deliveredSeq)
      .map((r) => r.overallComment)
      .filter((t): t is string => !!t);
    return texts.length ? texts.join("\n\n") : null;
  }

  /** Hand any not-yet-delivered round to one agent stream (connect catch-up). */
  private emitPendingTo(session: DocSession, listener: http.ServerResponse): void {
    if (session.sidecar.reviews.length <= session.sidecar.deliveredSeq) return;
    const payload = this.reviewPayload(session, this.pendingOverall(session));
    payload.reviewSeq = session.sidecar.reviews.length;
    session.sidecar.deliveredSeq = payload.reviewSeq;
    saveSidecar(session.path, session.sidecar);
    listener.write(`event: review\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  // ── comments ──

  private addComment(
    session: DocSession,
    input: { parentId?: string | null; body: string; anchor?: CommentAnchor | null; author?: string; viaAssistant?: boolean; kind?: "overall" },
  ): LocalComment {
    session.sidecar.seq += 1;
    const c: LocalComment = {
      id: `c${session.sidecar.seq}`,
      parentId: input.parentId ?? null,
      author: input.author ?? (input.viaAssistant ? "AI" : "You"),
      body: input.body.slice(0, 4000),
      anchor: input.anchor ?? null,
      status: "open",
      viaAssistant: !!input.viaAssistant,
      createdAt: new Date().toISOString(),
      ...(input.kind ? { kind: input.kind } : {}),
    };
    session.sidecar.comments.push(c);
    saveSidecar(session.path, session.sidecar);
    this.broadcast(session, "comments", {});
    return c;
  }

  private reviewPayload(session: DocSession, overallComment: string | null): ReviewPayload {
    const cs = session.sidecar.comments;
    const rootsOf = (status: (s: string) => boolean) => cs.filter((c) => !c.parentId && status(c.status));
    const openRoots = rootsOf((s) => s !== "resolved");
    return {
      event: "review.completed",
      file: session.path,
      title: session.sidecar.title,
      url: this.urlFor(session),
      version: session.sidecar.version,
      reviewSeq: session.sidecar.reviews.length,
      overallComment,
      openComments: openRoots.map((c) => ({
        id: c.id,
        author: c.author,
        body: c.body,
        status: c.status,
        kind: c.kind ?? null,
        anchoredText: c.anchor?.textQuote?.exact ?? null,
        replies: cs
          .filter((r) => r.parentId === c.id)
          .map((r) => ({ id: r.id, author: r.author, body: r.body, byAi: r.viaAssistant })),
      })),
      counts: {
        open: rootsOf((s) => s === "open").length,
        resolved: rootsOf((s) => s === "resolved").length,
        orphaned: rootsOf((s) => s === "orphaned").length,
      },
      hint: `Revise ${session.path} (the page live-reloads on save). For each comment: make the edit, then \`marigold-local reply ${basename(session.path)} <id> "<what changed>"\` and \`marigold-local resolve ${basename(session.path)} <id>\`. Then run \`marigold-local open ${basename(session.path)} --json --no-browser\` to wait for the next round.`,
    };
  }

  // ── routing ──

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin());
    const p = url.pathname;
    const method = req.method ?? "GET";

    if (p === "/" && method === "GET") {
      const docs = [...this.byId.values()].map((s) => ({
        docId: s.docId,
        title: s.sidecar.title,
        path: s.path,
      }));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(indexHtml(docs));
      return;
    }

    if (p === "/favicon.ico" && method === "GET") {
      res.writeHead(200, {
        "content-type": "image/svg+xml",
        "cache-control": "public, max-age=86400",
      });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text y="13" font-size="13">🌼</text></svg>');
      return;
    }

    if (p === "/__mg/agent.js" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=3600",
        "x-content-type-options": "nosniff",
      });
      res.end(ANCHOR_AGENT_JS);
      return;
    }

    if (p === "/api/status" && method === "GET") {
      json(res, 200, {
        pid: process.pid,
        port: this.port,
        startedAt: this.startedAt,
        docs: [...this.byId.values()].map((s) => ({
          docId: s.docId,
          path: s.path,
          title: s.sidecar.title,
          url: this.urlFor(s),
          version: s.sidecar.version,
          openComments: s.sidecar.comments.filter((c) => !c.parentId && c.status !== "resolved").length,
          clients: s.sse.size,
        })),
      });
      return;
    }

    if (p === "/api/shutdown" && method === "POST") {
      json(res, 200, { ok: true });
      if (this.opts.allowShutdown) setTimeout(() => process.exit(0), 50);
      return;
    }

    // Long-lived agent stream: one connection covers every draft. Each
    // submitted round arrives as an SSE `review` event; rounds submitted while
    // nothing was listening are caught up on connect. This is what
    // `marigold-draft listen` (run under a persistent monitor) consumes.
    if (p === "/api/agent/listen" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(`event: hello\ndata: {"docs":${this.byId.size}}\n\n`);
      this.agentListeners.add(res);
      this.broadcastAgentPresenceAll();
      // Catch up on every known draft's pending rounds — including docs the
      // daemon hasn't loaded this lifetime (registry-wide sweep).
      for (const docId of Object.keys(registryLoad())) {
        const session = this.resolveSession(docId);
        if (session) this.emitPendingTo(session, res);
      }
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => {
        clearInterval(ping);
        this.agentListeners.delete(res);
        this.broadcastAgentPresenceAll();
      });
      return;
    }

    if (p === "/api/open" && method === "POST") {
      const body = await readBody(req);
      if (typeof body.path !== "string") {
        json(res, 400, { error: "path is required" });
        return;
      }
      const session = this.openDoc(body.path, typeof body.title === "string" ? body.title : undefined);
      json(res, 200, {
        docId: session.docId,
        url: this.urlFor(session),
        version: session.sidecar.version,
        reviewSeq: session.sidecar.reviews.length,
        connectedClients: session.sse.size,
      });
      return;
    }

    // /d/:id[/frame]
    const dm = p.match(/^\/d\/([\w-]+)(\/frame)?$/);
    if (dm && method === "GET") {
      const session = this.resolveSession(dm[1] ?? "");
      if (!session) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("draft not open — run: marigold-local open <file>");
        return;
      }
      if (dm[2]) {
        // Both spellings of the loopback origin — a tab might be on either.
        res.writeHead(200, frameHeaders(`http://127.0.0.1:${this.port} http://localhost:${this.port}`));
        res.end(session.instrumented);
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(shellHtml(session.docId, session.sidecar.title));
      }
      return;
    }

    // /api/docs/:id/...
    const am = p.match(/^\/api\/docs\/([\w-]+)(\/.*)?$/);
    if (!am) {
      json(res, 404, { error: "not found" });
      return;
    }
    const session = this.resolveSession(am[1] ?? "");
    if (!session) {
      json(res, 404, { error: "unknown doc — POST /api/open first" });
      return;
    }
    const sub = am[2] ?? "";

    if (sub === "" && method === "GET") {
      json(res, 200, {
        docId: session.docId,
        title: session.sidecar.title,
        path: session.path,
        version: session.sidecar.version,
        reviewSeq: session.sidecar.reviews.length,
        agentListening: this.agentPresent(session),
        comments: session.sidecar.comments,
      });
      return;
    }

    if (sub === "/events" && method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(
        `event: hello\ndata: {"version":${session.sidecar.version},"agentListening":${this.agentPresent(session)}}\n\n`,
      );
      session.sse.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => {
        clearInterval(ping);
        session.sse.delete(res);
      });
      return;
    }

    if (sub === "/comments" && method === "POST") {
      const body = await readBody(req);
      if (typeof body.body !== "string" || !body.body.trim()) {
        json(res, 400, { error: "body is required" });
        return;
      }
      const c = this.addComment(session, {
        body: body.body,
        anchor: (body.anchor as CommentAnchor | undefined) ?? null,
        author: typeof body.author === "string" ? body.author : undefined,
        viaAssistant: !!body.viaAssistant,
      });
      json(res, 200, { id: c.id });
      return;
    }

    const cm = sub.match(/^\/comments\/([\w-]+)(\/replies)?$/);
    if (cm) {
      const target = session.sidecar.comments.find((c) => c.id === cm[1]);
      if (!target) {
        json(res, 404, { error: "comment not found" });
        return;
      }
      if (cm[2] && method === "POST") {
        const body = await readBody(req);
        if (typeof body.body !== "string" || !body.body.trim()) {
          json(res, 400, { error: "body is required" });
          return;
        }
        // Replies always attach to the thread root (prod behavior).
        const rootId = target.parentId ?? target.id;
        const c = this.addComment(session, {
          parentId: rootId,
          body: body.body,
          author: typeof body.author === "string" ? body.author : undefined,
          viaAssistant: !!body.viaAssistant,
        });
        json(res, 200, { id: c.id });
        return;
      }
      if (!cm[2] && method === "PATCH") {
        const body = await readBody(req);
        if (body.status === "open" || body.status === "resolved") {
          target.status = body.status;
          saveSidecar(session.path, session.sidecar);
          this.broadcast(session, "comments", {});
          json(res, 200, { ok: true });
          return;
        }
        json(res, 400, { error: "status must be open|resolved" });
        return;
      }
    }

    if (sub === "/inline-edit" && method === "POST") {
      const body = await readBody(req);
      const edits = body.edits as { marigoldId: string; html: string }[] | undefined;
      if (!Array.isArray(edits) || edits.length === 0) {
        json(res, 400, { error: "edits[] required" });
        return;
      }
      const src = this.readSource(session.path);
      const full = isFullDocument(src);
      let next = applyInlineEdits(prepareHtml(src, session.sidecar.title), edits);
      if (!full) {
        // The user edited the wrapped document; write back just the fragment.
        const main = parse(next, { comment: true }).querySelector(`main.${WRAP_MAIN_CLASS}`);
        if (!main) {
          json(res, 500, { error: "could not unwrap fragment after edit" });
          return;
        }
        next = main.innerHTML.trim() + "\n";
      }
      session.selfWriteUntil = Date.now() + 800;
      writeFileSync(session.path, next);
      // Rebuild immediately so version/anchors are current even before the
      // (debounced) watcher fires; the watcher's rebuild then no-ops on hash.
      const changed = this.rebuild(session, true);
      if (changed) {
        saveSidecar(session.path, session.sidecar);
        this.broadcast(session, "version", { version: session.sidecar.version });
        this.broadcast(session, "comments", {});
      }
      json(res, 200, { version: session.sidecar.version });
      return;
    }

    if (sub === "/submit" && method === "POST") {
      const body = await readBody(req);
      const overall = typeof body.overallComment === "string" && body.overallComment.trim() ? body.overallComment.trim() : null;
      // Freeform text becomes a doc-level comment FIRST: it's then durable,
      // visible in the sidebar, part of openComments, and reaches agents on
      // every read path — not just the round payload of a live handoff.
      if (overall) this.addComment(session, { body: overall, kind: "overall" });
      const agentListening = this.agentPresent(session);
      const payload = this.reviewPayload(session, overall);
      const round: ReviewRound = {
        at: new Date().toISOString(),
        version: session.sidecar.version,
        overallComment: overall,
        openCommentIds: payload.openComments.map((c) => c.id),
      };
      // Durable before the handoff event — a missed waiter can still recover
      // the round from the sidecar (roughdraft's file-first lesson).
      session.sidecar.reviews.push(round);
      payload.reviewSeq = session.sidecar.reviews.length;
      if (agentListening) session.sidecar.deliveredSeq = payload.reviewSeq;
      saveSidecar(session.path, session.sidecar);
      if (session.waiters.size > 0) {
        // Blocking waiters take priority — never double-deliver a round.
        for (const w of session.waiters) {
          clearTimeout(w.timer);
          json(w.res, 200, payload);
        }
        session.waiters.clear();
      } else {
        for (const l of this.agentListeners) {
          l.write(`event: review\ndata: ${JSON.stringify(payload)}\n\n`);
        }
      }
      this.broadcastAgentPresence(session);
      this.broadcast(session, "submitted", { reviewSeq: payload.reviewSeq, agentListening });
      json(res, 200, { ok: true, reviewSeq: payload.reviewSeq, agentListening });
      return;
    }

    if (sub === "/wait" && method === "GET") {
      // A round submitted while no agent was listening is delivered to the
      // NEXT wait immediately — feedback can be late, never lost.
      if (session.sidecar.reviews.length > session.sidecar.deliveredSeq) {
        const payload = this.reviewPayload(session, this.pendingOverall(session));
        payload.reviewSeq = session.sidecar.reviews.length;
        session.sidecar.deliveredSeq = payload.reviewSeq;
        saveSidecar(session.path, session.sidecar);
        json(res, 200, payload);
        return;
      }
      const timeoutS = Math.min(Number(url.searchParams.get("timeout") ?? 25) || 25, 120);
      const waiter: Waiter = {
        res,
        timer: setTimeout(() => {
          session.waiters.delete(waiter);
          this.broadcastAgentPresence(session);
          res.writeHead(204);
          res.end();
        }, timeoutS * 1000),
      };
      session.waiters.add(waiter);
      this.broadcastAgentPresence(session);
      req.on("close", () => {
        clearTimeout(waiter.timer);
        if (session.waiters.delete(waiter)) this.broadcastAgentPresence(session);
      });
      return;
    }

    json(res, 404, { error: "not found" });
  }
}
