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
  isOwner: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [rects, setRects] = useState<Record<string, Rect>>({});
  const [commenting, setCommenting] = useState(false);
  const [draft, setDraft] = useState<{ anchor: Anchor } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

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
      if (d.type === "ready") post({ type: "track", ids: trackedIds });
      else if (d.type === "rects") setRects((d.rects as Record<string, Rect>) ?? {});
      else if (d.type === "placed") {
        setCommenting(false);
        setDraft({ anchor: d.anchor as Anchor });
        setOpen(true);
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [post, trackedIds]);

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
                  ? 'Click "+ Comment", then click an element in the doc.'
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
