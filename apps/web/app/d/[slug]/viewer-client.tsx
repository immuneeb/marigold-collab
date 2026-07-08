"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface Anchor {
  marigoldId?: string | null;
  textQuote?: { exact?: string };
}
interface Comment {
  id: string;
  parentId: string | null;
  anchoredVersionId: string | null;
  authorId: string | null;
  authorName: string | null;
  body: string;
  anchor: Anchor | null;
  status: string;
  assignedToAi: boolean;
  viaAssistant: boolean;
  // Authored by a quick-doc URL holder (no account) under a self-supplied name.
  guest: boolean;
  createdAt: string;
}
type Rect = { x: number; y: number; w: number; h: number };

// Must match the app-shell mobile breakpoint in globals.css (MUN-28).
const MOBILE_MQ = "(max-width: 720px)";

export function ViewerClient(props: {
  docId: string;
  slug: string;
  title: string | null;
  versionId: string;
  iframeSrc: string;
  canComment: boolean;
  canEdit: boolean;
  isOwner: boolean;
  signedIn: boolean;
  // Unclaimed quick doc opened via its ?k= URL: the key authorizes saves
  // (sent as X-Marigold-Key) and the banner offers graduation into an account.
  // `expiresAt` (ISO) drives the expiry countdown + urgency tiers in the banner.
  quick?: { editKey: string; claimUrl: string; expiresAt: string | null };
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [rects, setRects] = useState<Record<string, Rect>>({});
  const [commenting, setCommenting] = useState(false);
  const [draft, setDraft] = useState<{ anchor: Anchor } | null>(null);
  const [sel, setSel] = useState<{ anchor: Anchor; rect: Rect } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Comments panel. `null` = pre-hydration: the panel renders with the
  // `cmt-indeterminate` class and CSS decides — visible on desktop, hidden on
  // mobile — so the SSR paint is right on both form factors with no flash.
  // The mount effect then resolves it to a real boolean (closed on mobile).
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    setOpen((o) => (o === null ? !window.matchMedia(MOBILE_MQ).matches : o));
  }, []);
  const [showResolved, setShowResolved] = useState(false);
  // Auto-save machinery: edits stream in from the agent, get queued, and flush
  // serially; each save rolls a new version, so we chain versionId forward.
  const versionIdRef = useRef(props.versionId);
  const queueRef = useRef<Map<string, string>>(new Map());
  const flushingRef = useRef(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  // Title edits share the save indicator but not the version chain — a rename
  // is metadata and never rolls a version.
  const [title, setTitle] = useState(props.title ?? "");
  const savedTitleRef = useRef(props.title ?? "");
  // Escape reverts state, but blur() fires before React re-renders — the blur
  // handler still closes over the edited title, so it must skip the save.
  const cancelTitleRef = useRef(false);

  // Guest commenting on an unclaimed quick doc: the URL holder comments with the
  // quick key (X-Marigold-Key) under a self-supplied name (asked once, kept in
  // localStorage). Account docs are unchanged — `props.canComment` is the ACL.
  const guest = !!props.quick;
  const canComment = props.canComment || guest;
  // Resolve / assign-to-AI stay account-only: guests never see those controls
  // (and the API rejects them anyway). Owned docs keep their exact behavior.
  const canModerate = props.canComment;
  const [guestName, setGuestName] = useState("");
  useEffect(() => {
    if (!props.quick) return;
    try {
      const saved = localStorage.getItem("marigold:guestName");
      if (saved) setGuestName(saved);
    } catch {
      /* localStorage may be unavailable (private mode) — ask each time */
    }
  }, [props.quick]);
  const rememberGuestName = useCallback((name: string) => {
    const n = name.trim().slice(0, 40);
    setGuestName(n);
    try {
      localStorage.setItem("marigold:guestName", n);
    } catch {
      /* non-fatal: the name just won't persist across reloads */
    }
  }, []);

  const roots = useMemo(
    () => comments.filter((c) => !c.parentId),
    [comments],
  );
  const openRoots = useMemo(
    () => roots.filter((c) => c.status !== "resolved"),
    [roots],
  );
  const resolvedRoots = useMemo(
    () => roots.filter((c) => c.status === "resolved"),
    [roots],
  );
  const repliesOf = useCallback(
    (id: string) => comments.filter((c) => c.parentId === id),
    [comments],
  );

  const post = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ __mg: 1, ...msg }, "*");
  }, []);

  // Push config to the agent. Driven by BOTH the agent's `ready` and the
  // iframe's onLoad — `ready` alone is racy (it can fire before our listener
  // attaches, and would be lost forever), so onLoad is the reliable trigger.
  const syncAgent = useCallback(() => {
    post({ type: "editable", on: props.canEdit });
  }, [post, props.canEdit]);

  const refresh = useCallback(async () => {
    // On an unclaimed quick doc the key is the view capability — send it so a
    // guest (no session) can load the thread they're commenting in.
    const r = await fetch(
      `/api/docs/${props.docId}/comments`,
      props.quick
        ? { headers: { "x-marigold-key": props.quick.editKey } }
        : undefined,
    )
      .then((res) => (res.ok ? res.json() : { comments: [] }))
      .catch(() => ({ comments: [] }));
    setComments(r.comments ?? []);
  }, [props.docId, props.quick]);

  const trackedIds = useMemo(
    () =>
      roots
        .filter((c) => c.status !== "resolved")
        .map((c) => c.anchor?.marigoldId)
        .filter((x): x is string => !!x),
    [roots],
  );

  // Auto-save: drain the queue serially; each save rolls a new version and we
  // chain versionId forward. On failure the batch is re-queued (newest wins)
  // and we stop until the user retries — no hot retry loop.
  const flushEdits = useCallback(async () => {
    if (flushingRef.current || queueRef.current.size === 0) return;
    flushingRef.current = true;
    setSaveState("saving");
    setSaveError(null);

    const batch = [...queueRef.current].map(([marigoldId, html]) => ({
      marigoldId,
      html,
    }));
    queueRef.current.clear();
    let failed = false;

    try {
      const res = await fetch(`/api/docs/${props.docId}/inline-edit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(props.quick ? { "x-marigold-key": props.quick.editKey } : {}),
        },
        body: JSON.stringify({ versionId: versionIdRef.current, edits: batch }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? data.error ?? "Save failed");
      if (data.versionId) versionIdRef.current = data.versionId;
      setSaveState("saved");
      setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 2500);
    } catch (e) {
      failed = true;
      for (const edit of batch) {
        if (!queueRef.current.has(edit.marigoldId))
          queueRef.current.set(edit.marigoldId, edit.html);
      }
      setSaveState("error");
      setSaveError((e as Error).message);
    } finally {
      flushingRef.current = false;
      if (!failed && queueRef.current.size > 0) void flushEdits();
    }
  }, [props.docId, props.quick]);

  // Idempotent: no-op when the title already matches what's saved, so the
  // error bar's Retry can call it blindly alongside flushEdits.
  const saveTitle = useCallback(async () => {
    const next = title.trim();
    if (next === savedTitleRef.current) {
      if (next !== title) setTitle(next);
      return;
    }
    setSaveState("saving");
    setSaveError(null);
    try {
      const res = await fetch(`/api/docs/${props.docId}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          ...(props.quick ? { "x-marigold-key": props.quick.editKey } : {}),
        },
        body: JSON.stringify({ title: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ?? data.error ?? "Rename failed");
      savedTitleRef.current = data.title ?? "";
      setTitle(data.title ?? "");
      setSaveState("saved");
      setTimeout(() => setSaveState((s) => (s === "saved" ? "idle" : s)), 2500);
    } catch (e) {
      setSaveState("error");
      setSaveError((e as Error).message);
    }
  }, [props.docId, props.quick, title]);

  // postMessage from the agent — validate it's THIS iframe's window.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as { __mg?: number; type?: string } & Record<string, unknown>;
      if (!d || d.__mg !== 1) return;
      if (d.type === "ready") {
        post({ type: "track", ids: trackedIds });
        syncAgent();
      } else if (d.type === "rects") setRects((d.rects as Record<string, Rect>) ?? {});
      else if (d.type === "placed") {
        setCommenting(false);
        setDraft({ anchor: d.anchor as Anchor });
        setOpen(true);
      } else if (d.type === "selection") {
        setSel((d.sel as { anchor: Anchor; rect: Rect } | null) ?? null);
      } else if (d.type === "edited") {
        const id = String(d.id ?? "");
        const html = String(d.html ?? "");
        if (id) {
          queueRef.current.set(id, html); // latest edit per target wins
          void flushEdits();
        }
      }
    }
    window.addEventListener("message", onMsg);

    // The iframe is server-rendered, so it (and its agent) can finish loading
    // BEFORE React hydrates and attaches this listener — the agent's `ready`
    // and the iframe onLoad both race hydration and get lost. So after mount we
    // proactively push config to the agent, retrying briefly in case the iframe
    // is instead the slow one. Posts are idempotent.
    syncAgent();
    post({ type: "track", ids: trackedIds });
    let tries = 0;
    const iv = setInterval(() => {
      syncAgent();
      post({ type: "track", ids: trackedIds });
      if (++tries >= 4) clearInterval(iv);
    }, 250);
    return () => {
      window.removeEventListener("message", onMsg);
      clearInterval(iv);
    };
  }, [post, trackedIds, props.canEdit, flushEdits, syncAgent]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => post({ type: "track", ids: trackedIds }), [post, trackedIds]);

  function toggleComment() {
    const on = !commenting;
    setCommenting(on);
    setDraft(null);
    post({ type: "commentMode", on });
  }

  function startDraftFromSelection() {
    if (!sel) return;
    setDraft({ anchor: sel.anchor });
    setSel(null);
    post({ type: "clearSelection" });
    setOpen(true);
  }

  async function submitDraft(body: string, name?: string) {
    if (!draft || !body.trim()) return;
    const author = (name ?? guestName).trim();
    if (props.quick && !author) return; // guests must name themselves
    if (props.quick) rememberGuestName(author);
    await fetch(`/api/docs/${props.docId}/comments`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(props.quick ? { "x-marigold-key": props.quick.editKey } : {}),
      },
      body: JSON.stringify({
        anchor: draft.anchor,
        body,
        versionId: versionIdRef.current,
        ...(props.quick ? { author } : {}),
      }),
    });
    setDraft(null);
    await refresh();
  }
  async function sendReply(parentId: string, body: string, name?: string) {
    if (!body.trim()) return;
    const author = (name ?? guestName).trim();
    if (props.quick && !author) return; // guests must name themselves
    if (props.quick) rememberGuestName(author);
    await fetch(`/api/comments/${parentId}/replies`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(props.quick ? { "x-marigold-key": props.quick.editKey } : {}),
      },
      body: JSON.stringify({
        body,
        ...(props.quick ? { author } : {}),
      }),
    });
    await refresh();
  }
  async function setStatus(id: string, status: "open" | "resolved") {
    await fetch(`/api/comments/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await refresh();
  }
  async function setAssignAi(id: string, assignToAi: boolean) {
    await fetch(`/api/comments/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assignToAi }),
    });
    await refresh();
  }

  const openCount = roots.filter((c) => c.status === "open").length;

  return (
    <div className="viewer">
      <header className="viewer-bar">
        <div className="viewer-left">
          <Link href="/" className="wordmark" style={{ textDecoration: "none" }}>
            🌼
          </Link>
          {props.canEdit ? (
            <input
              className="viewer-title viewer-title-input"
              value={title}
              placeholder="Untitled"
              aria-label="Doc title"
              title="Click to rename"
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                if (cancelTitleRef.current) {
                  cancelTitleRef.current = false;
                  return;
                }
                void saveTitle();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                else if (e.key === "Escape") {
                  cancelTitleRef.current = true;
                  setTitle(savedTitleRef.current);
                  e.currentTarget.blur();
                }
              }}
            />
          ) : (
            <span className="viewer-title">{props.title ?? "Untitled"}</span>
          )}
          <span className="ugc-pill" title="Rendered in an isolated origin">
            user-generated · isolated
          </span>
        </div>
        <div className="viewer-right">
          {saveState === "saving" && (
            <span className="muted small savestate">Saving…</span>
          )}
          {saveState === "saved" && (
            <span className="muted small savestate">All changes saved ✓</span>
          )}
          {canComment && (
            <button
              className={commenting ? "btn-secondary btn-inline" : "btn-ghost"}
              onClick={toggleComment}
            >
              {commenting ? "Click an element…" : "+ Comment"}
            </button>
          )}
          <button className="btn-ghost" onClick={() => setOpen((o) => !o)}>
            Comments {openCount > 0 ? `(${openCount})` : ""}
          </button>
          {props.canEdit && !props.quick && (
            <Link
              href={`/d/${props.slug}/edit`}
              // hidden on mobile: source editing is a desktop task
              className="btn-ghost viewer-hide-mobile"
              title="Edit the HTML source"
            >
              Source
            </Link>
          )}
          {props.isOwner && (
            <Link href={`/d/${props.slug}/manage`} className="btn-ghost">
              Manage
            </Link>
          )}
          {props.signedIn ? (
            // hidden on mobile: the 🌼 wordmark already links home
            <Link href="/" className="btn-ghost viewer-hide-mobile">
              Dashboard
            </Link>
          ) : (
            <Link
              // Quick visitors come back to the keyed URL — a bare /d/<slug>
              // would land them on "No access" after signing in.
              href={`/login?callbackUrl=${encodeURIComponent(
                props.quick
                  ? `/d/${props.slug}?k=${props.quick.editKey}`
                  : `/d/${props.slug}`,
              )}`}
              className="btn-secondary btn-inline"
              title="Sign in to comment or edit"
            >
              Sign in
            </Link>
          )}
        </div>
      </header>

      {props.quick && (
        <ClaimBanner
          claimUrl={props.quick.claimUrl}
          expiresAt={props.quick.expiresAt}
        />
      )}

      {saveState === "error" && (
        <div className="savebar">
          <span className="error">Couldn&apos;t save: {saveError}</span>
          <span className="savebar-actions">
            <button
              className="btn btn-inline"
              onClick={() => {
                void flushEdits();
                void saveTitle();
              }}
            >
              Retry
            </button>
            <button
              className="btn-ghost"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </span>
        </div>
      )}

      <div className="viewer-body">
        <div className="doc-pane">
          <iframe
            ref={iframeRef}
            className="docframe"
            sandbox="allow-scripts"
            src={props.iframeSrc}
            title={props.title ?? "doc"}
            onLoad={() => {
              // Bonus init trigger (unreliable for SSR'd iframes — the mount
              // effect + agent ready-retries are the real handshake).
              post({ type: "track", ids: trackedIds });
              syncAgent();
            }}
          />
          <div className="overlay">
            {canComment && sel && (
              <button
                className="margin-add"
                style={{ top: Math.max(4, sel.rect.y + sel.rect.h / 2 - 16) }}
                onClick={startDraftFromSelection}
                title="Comment on selection"
              >
                💬+
              </button>
            )}
            {roots
              .filter((c) => c.status !== "resolved")
              .map((c) => {
                const id = c.anchor?.marigoldId;
                const r = id ? rects[id] : undefined;
                if (!r) return null;
                return (
                  <button
                    key={c.id}
                    className={`pin${selected === c.id ? " sel" : ""}`}
                    style={{ left: r.x + r.w - 8, top: r.y - 8 }}
                    onClick={() => {
                      setSelected(c.id);
                      setOpen(true);
                    }}
                    title={c.body}
                  >
                    {c.assignedToAi ? "✨" : "💬"}
                  </button>
                );
              })}
          </div>
        </div>

        {/* Mobile-only backdrop behind the bottom drawer (display:none on
            desktop); tapping it closes the drawer. */}
        {open === true && (
          <div
            className="cmt-backdrop"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />
        )}
        {open !== false && (
          <aside
            className={`cmt-sidebar${open === null ? " cmt-indeterminate" : ""}`}
          >
            <div className="cmt-head">
              <span>Comments</span>
              <button
                className="cmt-close"
                aria-label="Close comments"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </div>

            {draft && (
              <DraftBox
                preview={draft.anchor?.textQuote?.exact ?? ""}
                guest={guest}
                defaultName={guestName}
                onCancel={() => setDraft(null)}
                onSubmit={submitDraft}
              />
            )}

            {openRoots.length === 0 && resolvedRoots.length === 0 && !draft && (
              <p className="muted small cmt-empty">
                {canComment
                  ? `Select text and hit the 💬+ button to comment.${props.canEdit ? " Click text to edit it — changes save automatically. Hover an element for move / duplicate / add / delete." : ""}`
                  : "No comments yet."}
              </p>
            )}

            {openRoots.map((c) => (
              <Thread
                key={c.id}
                root={c}
                replies={repliesOf(c.id)}
                selected={selected === c.id}
                onSelect={() => {
                  setSelected(c.id);
                  if (c.anchor?.marigoldId)
                    post({ type: "scrollTo", id: c.anchor.marigoldId });
                }}
                canComment={canComment}
                canModerate={canModerate}
                canEdit={props.canEdit}
                guest={guest}
                guestName={guestName}
                onReply={(b, n) => sendReply(c.id, b, n)}
                onResolve={() => setStatus(c.id, "resolved")}
                onAssignAi={() => setAssignAi(c.id, !c.assignedToAi)}
              />
            ))}

            {resolvedRoots.length > 0 && (
              <div className="cmt-resolved">
                <button
                  className="cmt-resolved-toggle"
                  onClick={() => setShowResolved((v) => !v)}
                >
                  {showResolved ? "▾" : "▸"} Resolved ({resolvedRoots.length})
                </button>
                {showResolved &&
                  resolvedRoots.map((c) => (
                    <Thread
                      key={c.id}
                      root={c}
                      replies={repliesOf(c.id)}
                      selected={selected === c.id}
                      onSelect={() => {
                        setSelected(c.id);
                        if (c.anchor?.marigoldId)
                          post({ type: "scrollTo", id: c.anchor.marigoldId });
                      }}
                      canComment={canComment}
                      canModerate={canModerate}
                      canEdit={props.canEdit}
                      guest={guest}
                      guestName={guestName}
                      onReply={(b, n) => sendReply(c.id, b, n)}
                      onResolve={() => setStatus(c.id, "open")}
                      onAssignAi={() => setAssignAi(c.id, !c.assignedToAi)}
                    />
                  ))}
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type ExpiryTier = "comfortable" | "soon" | "urgent";

// >7d calm, 24h–7d amber, <24h red. Callers still pair the color with words.
function expiryTier(remaining: number): ExpiryTier {
  if (remaining < DAY) return "urgent";
  if (remaining < 7 * DAY) return "soon";
  return "comfortable";
}

// "in 42 minutes" / "in 6 hours" / "in 29 days". Nearest whole unit; the
// threshold uses raw remaining so the unit label and tier never disagree.
function formatCountdown(remaining: number): string {
  if (remaining <= 0) return "now";
  if (remaining < HOUR) {
    const m = Math.max(1, Math.round(remaining / MINUTE));
    return `in ${m} minute${m === 1 ? "" : "s"}`;
  }
  if (remaining < DAY) {
    const h = Math.round(remaining / HOUR);
    return `in ${h} hour${h === 1 ? "" : "s"}`;
  }
  const d = Math.round(remaining / DAY);
  return `in ${d} day${d === 1 ? "" : "s"}`;
}

function sameCalendarDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

// Unclaimed quick-doc banner: shows the localized expiry date + a live relative
// countdown, escalates color/wording as expiry nears, and pushes the claim CTA
// (claiming is how the holder keeps the doc and controls access). `expiresAt`
// is an ISO string; all time math is client-only to avoid an SSR timezone
// mismatch — the first render (server + client) is the calm `now == null` shell.
function ClaimBanner({
  claimUrl,
  expiresAt,
}: {
  claimUrl: string;
  expiresAt: string | null;
}) {
  const expMs = useMemo(
    () => (expiresAt ? Date.parse(expiresAt) : null),
    [expiresAt],
  );
  const [now, setNow] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setNow(Date.now());
    const iv = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(iv);
  }, []);

  const remaining = now != null && expMs != null ? expMs - now : null;
  // Pre-mount (now == null) and no-expiry cases render calm; useEffect fills in
  // the real tier right after hydration.
  const tier: ExpiryTier =
    remaining == null ? "comfortable" : expiryTier(remaining);
  const urgent = tier === "urgent";

  // Dismissable while there's slack; re-asserts (no dismiss) once urgent so an
  // expiring doc is never silently lost.
  if (dismissed && !urgent) return null;

  const absolute =
    now != null && expMs != null
      ? new Date(expMs).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : null;
  const countdown = remaining != null ? formatCountdown(remaining) : null;

  const headline =
    expMs == null
      ? "Expires if left unclaimed"
      : tier === "comfortable"
        ? "Expires"
        : tier === "soon"
          ? "Expires soon"
          : now != null && sameCalendarDay(now, expMs)
            ? "Expiring today"
            : "Expiring soon";

  return (
    <div
      className={`claimbar claimbar-${tier}`}
      role="region"
      aria-label="Quick doc expiry and claim"
    >
      <div className="claimbar-msg">
        <div className="claimbar-headline">
          <span className="claimbar-icon" aria-hidden="true">
            {urgent ? "⏳" : "⚡"}
          </span>
          <strong>{headline}</strong>
          {/* The date carries the separator so mobile can hide it and leave
              a clean "Expires in 30 days". */}
          {absolute && (
            <time className="claimbar-when" dateTime={expiresAt ?? undefined}>
              {absolute} ·
            </time>
          )}
          {countdown && <span className="claimbar-count">{countdown}</span>}
        </div>
        <div className="claimbar-explain">
          Anyone with the link can edit — claim to keep it.
        </div>
      </div>
      <div className="claimbar-actions">
        <Link href={claimUrl} className="btn btn-inline claimbar-cta">
          Claim this doc
        </Link>
        {!urgent && (
          <button
            className="btn-ghost claimbar-dismiss"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss"
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

function DraftBox(props: {
  preview: string;
  // Guest (quick-doc) commenter: prompt for a display name, prefilled from the
  // last-used one. Account commenters never see the name field.
  guest?: boolean;
  defaultName?: string;
  onCancel: () => void;
  onSubmit: (body: string, name?: string) => void;
}) {
  const [v, setV] = useState("");
  const [name, setName] = useState(props.defaultName ?? "");
  const nameMissing = !!props.guest && !name.trim();
  return (
    <div className="cmt-thread draft">
      {props.preview && (
        <div className="cmt-anchor">“{props.preview.slice(0, 80)}”</div>
      )}
      {props.guest && (
        <input
          className="cmt-guestname"
          placeholder="Your name"
          aria-label="Your name"
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      )}
      <textarea
        autoFocus
        rows={3}
        placeholder="Add a comment…"
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      <div className="cmt-actions">
        <button
          className="btn-secondary btn-inline"
          disabled={nameMissing || !v.trim()}
          onClick={() => props.onSubmit(v, name)}
        >
          Comment
        </button>
        <button className="btn-ghost" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Thread(props: {
  root: Comment;
  replies: Comment[];
  selected: boolean;
  canComment: boolean;
  // Account-only moderation (resolve / assign-to-AI). False for guests.
  canModerate: boolean;
  canEdit: boolean;
  guest?: boolean;
  guestName?: string;
  onSelect: () => void;
  onReply: (body: string, name?: string) => void;
  onResolve: () => void;
  onAssignAi: () => void;
}) {
  const [reply, setReply] = useState("");
  const [name, setName] = useState(props.guestName ?? "");
  useEffect(() => {
    if (props.guestName) setName(props.guestName);
  }, [props.guestName]);
  const { root } = props;
  const orphaned = root.status === "orphaned";
  // Guests name themselves once; after that the saved name is reused silently.
  const needName = !!props.guest && !(props.guestName ?? "").trim();
  return (
    <div
      className={`cmt-thread${props.selected ? " sel" : ""}${root.status === "resolved" ? " resolved" : ""}`}
      onClick={props.onSelect}
    >
      {root.anchor?.textQuote?.exact && (
        <div className="cmt-anchor">
          “{root.anchor.textQuote.exact.slice(0, 80)}”
          {orphaned && <span className="orphan"> · not on this version</span>}
        </div>
      )}
      {root.assignedToAi && root.status !== "resolved" && (
        <div className="ai-badge" title="An AI agent will address this comment">
          ✨ Assigned to AI
        </div>
      )}
      <CommentBody c={root} />
      {props.replies.map((r) => (
        <CommentBody key={r.id} c={r} reply />
      ))}
      {props.canComment && (
        <div className="cmt-reply">
          {needName && (
            <input
              className="cmt-guestname"
              placeholder="Your name"
              aria-label="Your name"
              maxLength={40}
              value={name}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setName(e.target.value)}
            />
          )}
          <input
            placeholder="Reply…"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                props.onReply(reply, name);
                setReply("");
              }
            }}
          />
          {props.canModerate && props.canEdit && root.status !== "resolved" && (
            <button
              className="btn-ghost"
              title={
                root.assignedToAi
                  ? "Remove from the AI queue"
                  : "Queue this for the doc's AI agent to address"
              }
              onClick={(e) => {
                e.stopPropagation();
                props.onAssignAi();
              }}
            >
              {root.assignedToAi ? "✨ Unassign" : "✨ AI"}
            </button>
          )}
          {props.canModerate && (
            <button
              className="btn-ghost"
              onClick={(e) => {
                e.stopPropagation();
                props.onResolve();
              }}
            >
              {root.status === "resolved" ? "Reopen" : "Resolve"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function CommentBody({ c, reply }: { c: Comment; reply?: boolean }) {
  return (
    <div className={reply ? "cmt-body reply" : "cmt-body"}>
      <span className="cmt-author">{c.authorName ?? "Someone"}</span>
      {c.guest && (
        <span className="guest-chip" title="Commented as a guest via the doc link">
          guest
        </span>
      )}
      {c.viaAssistant && (
        <span className="ai-chip" title="Written by an AI agent via MCP">
          AI
        </span>
      )}
      <span className="cmt-text">{c.body}</span>
    </div>
  );
}
