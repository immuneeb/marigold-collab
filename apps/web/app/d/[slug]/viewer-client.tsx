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
  createdAt: string;
}
type Rect = { x: number; y: number; w: number; h: number };

export function ViewerClient(props: {
  docId: string;
  slug: string;
  title: string | null;
  versionId: string;
  iframeSrc: string;
  canComment: boolean;
  canEdit: boolean;
  isOwner: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [rects, setRects] = useState<Record<string, Rect>>({});
  const [commenting, setCommenting] = useState(false);
  const [draft, setDraft] = useState<{ anchor: Anchor } | null>(null);
  const [sel, setSel] = useState<{ anchor: Anchor; rect: Rect } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(true);
  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const roots = useMemo(
    () => comments.filter((c) => !c.parentId),
    [comments],
  );
  const repliesOf = useCallback(
    (id: string) => comments.filter((c) => c.parentId === id),
    [comments],
  );

  const post = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage({ __mg: 1, ...msg }, "*");
  }, []);

  const refresh = useCallback(async () => {
    const r = await fetch(`/api/docs/${props.docId}/comments`)
      .then((res) => (res.ok ? res.json() : { comments: [] }))
      .catch(() => ({ comments: [] }));
    setComments(r.comments ?? []);
  }, [props.docId]);

  const trackedIds = useMemo(
    () =>
      roots
        .filter((c) => c.status !== "resolved")
        .map((c) => c.anchor?.marigoldId)
        .filter((x): x is string => !!x),
    [roots],
  );

  // postMessage from the agent — validate it's THIS iframe's window.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const d = e.data as { __mg?: number; type?: string } & Record<string, unknown>;
      if (!d || d.__mg !== 1) return;
      if (d.type === "ready") {
        post({ type: "track", ids: trackedIds });
        post({ type: "editable", on: props.canEdit });
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
        if (id) setPendingEdits((p) => ({ ...p, [id]: html }));
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [post, trackedIds, props.canEdit]);

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

  async function saveEdits() {
    const edits = Object.entries(pendingEdits).map(([marigoldId, html]) => ({
      marigoldId,
      html,
    }));
    if (edits.length === 0) return;
    setSaving(true);
    setSaveError(null);
    const res = await fetch(`/api/docs/${props.docId}/inline-edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ versionId: props.versionId, edits }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setSaving(false);
      setSaveError(data.message ?? data.error ?? "Save failed");
      return;
    }
    // Fresh render token + re-anchored comments for the new version.
    window.location.reload();
  }

  function discardEdits() {
    // Simplest correct reset: reload the served (unedited) version.
    window.location.reload();
  }

  function startDraftFromSelection() {
    if (!sel) return;
    setDraft({ anchor: sel.anchor });
    setSel(null);
    post({ type: "clearSelection" });
    setOpen(true);
  }

  async function submitDraft(body: string) {
    if (!draft || !body.trim()) return;
    await fetch(`/api/docs/${props.docId}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        anchor: draft.anchor,
        body,
        versionId: props.versionId,
      }),
    });
    setDraft(null);
    await refresh();
  }
  async function sendReply(parentId: string, body: string) {
    if (!body.trim()) return;
    await fetch(`/api/comments/${parentId}/replies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
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

  const openCount = roots.filter((c) => c.status === "open").length;

  return (
    <div className="viewer">
      <header className="viewer-bar">
        <div className="viewer-left">
          <Link href="/" className="wordmark" style={{ textDecoration: "none" }}>
            🌼
          </Link>
          <span className="viewer-title">{props.title ?? "Untitled"}</span>
          <span className="ugc-pill" title="Rendered in an isolated origin">
            user-generated · isolated
          </span>
        </div>
        <div className="viewer-right">
          {props.canComment && (
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
          {props.canEdit && (
            <Link
              href={`/d/${props.slug}/edit`}
              className="btn-ghost"
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
          <Link href="/" className="btn-ghost">
            Dashboard
          </Link>
        </div>
      </header>

      {Object.keys(pendingEdits).length > 0 && (
        <div className="savebar">
          <span>
            {Object.keys(pendingEdits).length} unsaved edit
            {Object.keys(pendingEdits).length > 1 ? "s" : ""}
            {saveError && <span className="error"> — {saveError}</span>}
          </span>
          <span className="savebar-actions">
            <button
              className="btn btn-inline"
              disabled={saving}
              onClick={saveEdits}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button className="btn-ghost" disabled={saving} onClick={discardEdits}>
              Discard
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
          />
          <div className="overlay">
            {props.canComment && sel && (
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
                    💬
                  </button>
                );
              })}
          </div>
        </div>

        {open && (
          <aside className="cmt-sidebar">
            <div className="cmt-head">Comments</div>

            {draft && (
              <DraftBox
                preview={draft.anchor?.textQuote?.exact ?? ""}
                onCancel={() => setDraft(null)}
                onSubmit={submitDraft}
              />
            )}

            {roots.length === 0 && !draft && (
              <p className="muted small cmt-empty">
                {props.canComment
                  ? `Select text and hit the 💬+ button to comment.${props.canEdit ? " Double-click any text to edit it in place." : ""}`
                  : "No comments yet."}
              </p>
            )}

            {roots.map((c) => (
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
                canComment={props.canComment}
                onReply={(b) => sendReply(c.id, b)}
                onResolve={() =>
                  setStatus(c.id, c.status === "resolved" ? "open" : "resolved")
                }
              />
            ))}
          </aside>
        )}
      </div>
    </div>
  );
}

function DraftBox(props: {
  preview: string;
  onCancel: () => void;
  onSubmit: (body: string) => void;
}) {
  const [v, setV] = useState("");
  return (
    <div className="cmt-thread draft">
      {props.preview && (
        <div className="cmt-anchor">“{props.preview.slice(0, 80)}”</div>
      )}
      <textarea
        autoFocus
        rows={3}
        placeholder="Add a comment…"
        value={v}
        onChange={(e) => setV(e.target.value)}
      />
      <div className="cmt-actions">
        <button className="btn-secondary btn-inline" onClick={() => props.onSubmit(v)}>
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
  onSelect: () => void;
  onReply: (body: string) => void;
  onResolve: () => void;
}) {
  const [reply, setReply] = useState("");
  const { root } = props;
  const orphaned = root.status === "orphaned";
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
      <CommentBody c={root} />
      {props.replies.map((r) => (
        <CommentBody key={r.id} c={r} reply />
      ))}
      {props.canComment && (
        <div className="cmt-reply">
          <input
            placeholder="Reply…"
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                props.onReply(reply);
                setReply("");
              }
            }}
          />
          <button
            className="btn-ghost"
            onClick={(e) => {
              e.stopPropagation();
              props.onResolve();
            }}
          >
            {root.status === "resolved" ? "Reopen" : "Resolve"}
          </button>
        </div>
      )}
    </div>
  );
}

function CommentBody({ c, reply }: { c: Comment; reply?: boolean }) {
  return (
    <div className={reply ? "cmt-body reply" : "cmt-body"}>
      <span className="cmt-author">{c.authorName ?? "Someone"}</span>
      <span className="cmt-text">{c.body}</span>
    </div>
  );
}
