/**
 * The local viewer shell: header + pins overlay + comment sidebar wrapped
 * around the sandboxed doc iframe. A vanilla-JS port of the prod viewer
 * (apps/web/app/d/[slug]/viewer-client.tsx) speaking the same postMessage
 * protocol to the same anchor agent, styled with the same marigold tokens so
 * local and cloud feel like one product. Server-rendered per doc.
 */
export function shellHtml(docId: string, title: string): string {
  const t = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t} · Marigold Local</title>
<style>
  :root {
    --bg: #fffdf7; --fg: #1c1917; --muted: #78716c; --line: #e7e2d6;
    --card: #ffffff; --marigold: #e8870f; --marigold-dark: #b8690a; --accent-soft: #fdf3e3;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--fg); font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .muted { color: var(--muted); } .small { font-size: 13px; }
  button { font: inherit; }
  .btn, .btn-secondary, .btn-ghost { display: inline-flex; align-items: center; justify-content: center; border-radius: 10px; padding: 9px 14px; font-weight: 550; cursor: pointer; border: 1px solid transparent; }
  .btn { background: var(--marigold); color: #fff; } .btn:hover { background: var(--marigold-dark); }
  .btn-secondary { background: var(--accent-soft); color: var(--marigold-dark); border-color: var(--line); }
  .btn-ghost { background: transparent; color: var(--muted); border-color: var(--line); padding: 7px 12px; }
  .btn-ghost:hover { color: var(--fg); }
  textarea, input { width: 100%; padding: 8px 10px; border: 1px solid var(--line); border-radius: 10px; font: inherit; background: #fff; }
  textarea { resize: vertical; }
  input:focus, textarea:focus { outline: 2px solid var(--accent-soft); border-color: var(--marigold); }

  .viewer { display: flex; flex-direction: column; height: 100dvh; }
  .viewer-bar { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; border-bottom: 1px solid var(--line); background: var(--card); gap: 12px; }
  .viewer-left, .viewer-right { display: flex; align-items: center; gap: 10px; }
  .wordmark { font-weight: 650; font-size: 18px; }
  .viewer-title { font-weight: 600; letter-spacing: -0.01em; }
  .ugc-pill { font-size: 11px; color: var(--marigold-dark); background: var(--accent-soft); border: 1px solid var(--line); border-radius: 999px; padding: 2px 8px; }
  .savestate { white-space: nowrap; }
  .viewer-body { flex: 1; display: flex; min-height: 0; }
  .doc-pane { position: relative; flex: 1; min-width: 0; }
  .docframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
  .overlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  .pin { position: absolute; pointer-events: auto; width: 26px; height: 26px; padding: 0; font-size: 13px; line-height: 26px; text-align: center; border-radius: 14px 14px 14px 2px; border: 1px solid var(--marigold); background: #fff; box-shadow: 0 2px 6px rgba(28,25,23,.18); cursor: pointer; }
  .pin.sel, .pin:hover { background: var(--accent-soft); }
  .margin-add { position: absolute; right: 10px; pointer-events: auto; padding: 5px 10px; font-size: 13px; font-weight: 600; border-radius: 16px; border: 1px solid var(--marigold); color: var(--marigold-dark); background: #fff; box-shadow: 0 2px 8px rgba(28,25,23,.2); cursor: pointer; z-index: 5; }
  .margin-add:hover { background: var(--accent-soft); }

  .cmt-sidebar { width: 320px; flex: none; border-left: 1px solid var(--line); background: var(--card); overflow-y: auto; padding: 12px; display: flex; flex-direction: column; }
  .cmt-scroll { flex: 1; }
  .cmt-head { font-weight: 650; font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); padding: 4px 4px 10px; }
  .cmt-empty { padding: 8px 4px; }
  .cmt-thread { border: 1px solid var(--line); border-radius: 10px; padding: 10px; margin-bottom: 10px; background: #fff; cursor: pointer; }
  .cmt-thread.sel { border-color: var(--marigold); box-shadow: 0 0 0 2px var(--accent-soft); }
  .cmt-thread.resolved { opacity: .6; }
  .cmt-thread.draft { border-color: var(--marigold); cursor: default; }
  .cmt-anchor { font-size: 12px; color: var(--marigold-dark); background: var(--accent-soft); border-radius: 6px; padding: 4px 7px; margin-bottom: 8px; }
  .cmt-anchor .orphan { color: var(--muted); }
  .cmt-body { font-size: 13.5px; margin: 6px 0; }
  .cmt-body.reply { padding-left: 10px; border-left: 2px solid var(--line); }
  .cmt-author { font-weight: 600; margin-right: 6px; }
  .ai-chip { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .05em; color: var(--marigold-dark); background: var(--accent-soft); border-radius: 4px; padding: 1px 5px; margin-right: 6px; vertical-align: 1px; }
  .cmt-reply { display: flex; gap: 6px; margin-top: 8px; }
  .cmt-reply input { flex: 1; padding: 6px 9px; font-size: 13px; }
  .cmt-actions { display: flex; gap: 8px; margin-top: 8px; }
  .cmt-resolved { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 8px; }
  .cmt-resolved-toggle { width: 100%; text-align: left; border: 0; background: transparent; cursor: pointer; font-size: 12px; font-weight: 600; color: var(--muted); padding: 4px; border-radius: 6px; }
  .cmt-resolved-toggle:hover { background: var(--accent-soft); color: var(--fg); }

  .submit-panel { border-top: 1px solid var(--line); padding-top: 10px; margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
  .submit-panel .btn { width: 100%; }
  .submit-panel .hint { margin: 0; }
  .submit-panel .sent { color: var(--marigold-dark); font-weight: 600; }
</style>
</head>
<body>
<div class="viewer">
  <header class="viewer-bar">
    <div class="viewer-left">
      <span class="wordmark">🌼</span>
      <span class="viewer-title">${t}</span>
      <span class="ugc-pill" title="Served from your machine by marigold-local">local draft</span>
    </div>
    <div class="viewer-right">
      <span class="muted small savestate" id="savestate"></span>
      <button class="btn-ghost" id="commentBtn">+ Comment</button>
      <button class="btn-ghost" id="sidebarBtn">Comments</button>
    </div>
  </header>
  <div class="viewer-body">
    <div class="doc-pane">
      <iframe id="frame" class="docframe" sandbox="allow-scripts" src="/d/${docId}/frame?v=0" title="${t}"></iframe>
      <div class="overlay" id="overlay"></div>
    </div>
    <aside class="cmt-sidebar" id="sidebar">
      <div class="cmt-scroll">
        <div class="cmt-head">Comments</div>
        <div id="draftbox"></div>
        <div id="threads"></div>
        <div id="resolvedwrap"></div>
      </div>
      <div class="submit-panel">
        <textarea id="overall" rows="2" placeholder="Overall feedback (optional)…"></textarea>
        <button class="btn" id="submitBtn">Send feedback to agent</button>
        <p class="muted small hint" id="submitHint">Sends all open comments back to the agent for the next revision. The page live-reloads when the agent saves.</p>
      </div>
    </aside>
  </div>
</div>
<script>
(function () {
  "use strict";
  var DOC = ${JSON.stringify(docId)};
  var frame = document.getElementById("frame");
  var overlay = document.getElementById("overlay");
  var threadsEl = document.getElementById("threads");
  var resolvedWrap = document.getElementById("resolvedwrap");
  var draftBox = document.getElementById("draftbox");
  var saveEl = document.getElementById("savestate");
  var sidebar = document.getElementById("sidebar");

  var comments = [];
  var rects = {};
  var version = 0;
  var commenting = false;
  var draft = null;      // { anchor }
  var sel = null;        // { anchor, rect }
  var selected = null;   // comment id
  var showResolved = false;

  function post(msg) {
    msg.__mg = 1;
    try { frame.contentWindow.postMessage(msg, "*"); } catch (e) {}
  }
  function api(path, opts) {
    return fetch("/api/docs/" + DOC + path, opts).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (d) {
        throw new Error(d.error || ("HTTP " + r.status));
      });
      return r.json();
    });
  }
  function roots() { return comments.filter(function (c) { return !c.parentId; }); }
  function repliesOf(id) { return comments.filter(function (c) { return c.parentId === id; }); }
  function trackedIds() {
    return roots().filter(function (c) { return c.status !== "resolved" && c.anchor && c.anchor.marigoldId; })
      .map(function (c) { return c.anchor.marigoldId; });
  }
  function syncAgent() {
    post({ type: "editable", on: true });
    post({ type: "track", ids: trackedIds() });
  }

  // ── comments fetch + render ──
  function refresh() {
    return api("").then(function (d) {
      comments = d.comments || [];
      version = d.version;
      render();
      post({ type: "track", ids: trackedIds() });
    }).catch(function () {});
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function bodyLine(c, isReply) {
    var d = el("div", isReply ? "cmt-body reply" : "cmt-body");
    d.appendChild(el("span", "cmt-author", c.author || "Someone"));
    if (c.viaAssistant) { var chip = el("span", "ai-chip", "AI"); chip.title = "Written by the agent"; d.appendChild(chip); }
    d.appendChild(el("span", "", c.body));
    return d;
  }
  function threadCard(c) {
    var card = el("div", "cmt-thread" + (selected === c.id ? " sel" : "") + (c.status === "resolved" ? " resolved" : ""));
    card.addEventListener("click", function () {
      selected = c.id;
      if (c.anchor && c.anchor.marigoldId) post({ type: "scrollTo", id: c.anchor.marigoldId });
      render();
    });
    var quote = c.anchor && c.anchor.textQuote && c.anchor.textQuote.exact;
    if (quote) {
      var a = el("div", "cmt-anchor", "\\u201C" + quote.slice(0, 80) + "\\u201D");
      if (c.status === "orphaned") a.appendChild(el("span", "orphan", " · not on this version"));
      card.appendChild(a);
    }
    card.appendChild(bodyLine(c, false));
    repliesOf(c.id).forEach(function (r) { card.appendChild(bodyLine(r, true)); });

    var row = el("div", "cmt-reply");
    var input = el("input");
    input.placeholder = "Reply…";
    input.addEventListener("click", function (e) { e.stopPropagation(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && input.value.trim()) {
        api("/comments/" + c.id + "/replies", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: input.value.trim() })
        }).then(refresh);
        input.value = "";
      }
    });
    row.appendChild(input);
    var res = el("button", "btn-ghost", c.status === "resolved" ? "Reopen" : "Resolve");
    res.addEventListener("click", function (e) {
      e.stopPropagation();
      api("/comments/" + c.id, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: c.status === "resolved" ? "open" : "resolved" })
      }).then(refresh);
    });
    row.appendChild(res);
    card.appendChild(row);
    return card;
  }
  function render() {
    var rs = roots();
    var open = rs.filter(function (c) { return c.status !== "resolved"; });
    var resolved = rs.filter(function (c) { return c.status === "resolved"; });

    threadsEl.textContent = "";
    if (!open.length && !resolved.length && !draft) {
      threadsEl.appendChild(el("p", "muted small cmt-empty",
        "Select text and hit the \\uD83D\\uDCAC+ button to comment. Click text to edit it \\u2014 changes save to the file automatically."));
    }
    open.forEach(function (c) { threadsEl.appendChild(threadCard(c)); });

    resolvedWrap.textContent = "";
    if (resolved.length) {
      var wrap = el("div", "cmt-resolved");
      var tog = el("button", "cmt-resolved-toggle", (showResolved ? "\\u25BE" : "\\u25B8") + " Resolved (" + resolved.length + ")");
      tog.addEventListener("click", function () { showResolved = !showResolved; render(); });
      wrap.appendChild(tog);
      if (showResolved) resolved.forEach(function (c) { wrap.appendChild(threadCard(c)); });
      resolvedWrap.appendChild(wrap);
    }

    document.getElementById("sidebarBtn").textContent = "Comments" + (open.length ? " (" + open.length + ")" : "");
    renderPins();
    renderDraft();
  }
  function renderPins() {
    overlay.textContent = "";
    if (sel) {
      var b = el("button", "margin-add", "\\uD83D\\uDCAC+");
      b.title = "Comment on selection";
      b.style.top = Math.max(4, sel.rect.y + sel.rect.h / 2 - 16) + "px";
      b.addEventListener("click", function () {
        draft = { anchor: sel.anchor };
        sel = null;
        post({ type: "clearSelection" });
        render();
      });
      overlay.appendChild(b);
    }
    roots().filter(function (c) { return c.status !== "resolved"; }).forEach(function (c) {
      var id = c.anchor && c.anchor.marigoldId;
      var r = id && rects[id];
      if (!r) return;
      var pin = el("button", "pin" + (selected === c.id ? " sel" : ""), "\\uD83D\\uDCAC");
      pin.style.left = (r.x + r.w - 8) + "px";
      pin.style.top = (r.y - 8) + "px";
      pin.title = c.body;
      pin.addEventListener("click", function () { selected = c.id; render(); });
      overlay.appendChild(pin);
    });
  }
  function renderDraft() {
    draftBox.textContent = "";
    if (!draft) return;
    var card = el("div", "cmt-thread draft");
    var quote = draft.anchor && draft.anchor.textQuote && draft.anchor.textQuote.exact;
    if (quote) card.appendChild(el("div", "cmt-anchor", "\\u201C" + quote.slice(0, 80) + "\\u201D"));
    var ta = el("textarea");
    ta.rows = 3;
    ta.placeholder = "Add a comment…";
    card.appendChild(ta);
    var actions = el("div", "cmt-actions");
    var ok = el("button", "btn-secondary", "Comment");
    ok.addEventListener("click", function () {
      if (!ta.value.trim()) return;
      api("/comments", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchor: draft.anchor, body: ta.value.trim() })
      }).then(function () { draft = null; refresh(); });
    });
    var no = el("button", "btn-ghost", "Cancel");
    no.addEventListener("click", function () { draft = null; render(); });
    actions.appendChild(ok);
    actions.appendChild(no);
    card.appendChild(actions);
    draftBox.appendChild(card);
    ta.focus();
  }

  // ── inline-edit autosave (same serial-flush model as prod) ──
  var queue = new Map();
  var flushing = false;
  function setSave(s) { saveEl.textContent = s; }
  function flushEdits() {
    if (flushing || queue.size === 0) return;
    flushing = true;
    setSave("Saving…");
    var batch = [];
    queue.forEach(function (html, marigoldId) { batch.push({ marigoldId: marigoldId, html: html }); });
    queue.clear();
    api("/inline-edit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ edits: batch })
    }).then(function (d) {
      version = d.version;
      setSave("Saved to file ✓");
      setTimeout(function () { if (saveEl.textContent === "Saved to file ✓") setSave(""); }, 2500);
    }).catch(function (e) {
      batch.forEach(function (b) { if (!queue.has(b.marigoldId)) queue.set(b.marigoldId, b.html); });
      setSave("Save failed: " + e.message);
    }).finally(function () {
      flushing = false;
      if (queue.size > 0) flushEdits();
    });
  }

  // ── agent postMessage ──
  window.addEventListener("message", function (e) {
    if (e.source !== frame.contentWindow) return;
    var d = e.data;
    if (!d || d.__mg !== 1) return;
    if (d.type === "ready") syncAgent();
    else if (d.type === "rects") { rects = d.rects || {}; renderPins(); }
    else if (d.type === "placed") { commenting = false; setCommentBtn(); draft = { anchor: d.anchor }; render(); }
    else if (d.type === "selection") { sel = d.sel || null; renderPins(); }
    else if (d.type === "edited" && d.id) { queue.set(String(d.id), String(d.html || "")); flushEdits(); }
  });
  frame.addEventListener("load", syncAgent);

  // ── header controls ──
  var commentBtn = document.getElementById("commentBtn");
  function setCommentBtn() {
    commentBtn.textContent = commenting ? "Click an element…" : "+ Comment";
    commentBtn.className = commenting ? "btn-secondary" : "btn-ghost";
  }
  commentBtn.addEventListener("click", function () {
    commenting = !commenting;
    draft = null;
    setCommentBtn();
    post({ type: "commentMode", on: commenting });
    render();
  });
  document.getElementById("sidebarBtn").addEventListener("click", function () {
    sidebar.style.display = sidebar.style.display === "none" ? "flex" : "none";
  });

  // ── submit: the handoff back to the agent ──
  var submitBtn = document.getElementById("submitBtn");
  var overall = document.getElementById("overall");
  submitBtn.addEventListener("click", function () {
    submitBtn.disabled = true;
    api("/submit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ overallComment: overall.value.trim() || null })
    }).then(function () {
      overall.value = "";
      submitBtn.textContent = "Sent ✓ — agent is revising";
      setTimeout(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = "Send feedback to agent";
      }, 3000);
    }).catch(function (e) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Send feedback to agent";
      alert("Submit failed: " + e.message);
    });
  });

  // ── SSE: live reload + comment sync ──
  function connectSSE() {
    var es = new EventSource("/api/docs/" + DOC + "/events");
    es.addEventListener("reload", function (ev) {
      try { version = JSON.parse(ev.data).version; } catch (e) {}
      rects = {};
      frame.src = "/d/" + DOC + "/frame?v=" + version;
      refresh();
    });
    es.addEventListener("version", function (ev) {
      try { version = JSON.parse(ev.data).version; } catch (e) {}
    });
    es.addEventListener("comments", function () { refresh(); });
    es.onerror = function () { es.close(); setTimeout(connectSSE, 1500); };
  }
  connectSSE();

  refresh();
  // The iframe can finish loading before our listener attaches — push config a
  // few times after boot (posts are idempotent; mirrors the prod handshake).
  var tries = 0;
  var iv = setInterval(function () {
    syncAgent();
    if (++tries >= 4) clearInterval(iv);
  }, 250);
})();
</script>
</body>
</html>`;
}

/** Minimal index page listing the docs currently open on this daemon. */
export function indexHtml(docs: { docId: string; title: string; path: string }[]): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const items = docs.length
    ? docs
        .map(
          (d) =>
            `<li><a class="doclink" href="/d/${d.docId}"><span class="doctitle">${esc(d.title)}</span><span class="muted small">${esc(d.path)}</span></a></li>`,
        )
        .join("")
    : `<li><p class="muted" style="padding:14px 16px">No drafts open. Run <code>marigold-local open &lt;file.html&gt;</code></p></li>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Marigold Local</title><style>
  :root { --bg:#fffdf7; --fg:#1c1917; --muted:#78716c; --line:#e7e2d6; --card:#fff; --accent-soft:#fdf3e3; --marigold-dark:#b8690a; }
  body { background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif,system-ui,sans-serif; margin:0; }
  .container { max-width:720px; margin:0 auto; padding:40px 20px; }
  .muted { color:var(--muted); } .small { font-size:13px; }
  code { background:var(--accent-soft); padding:1px 6px; border-radius:5px; }
  ul { list-style:none; margin:20px 0 0; padding:0; border:1px solid var(--line); border-radius:12px; overflow:hidden; background:var(--card); }
  li + li { border-top:1px solid var(--line); }
  .doclink { display:flex; align-items:baseline; justify-content:space-between; gap:12px; padding:14px 16px; text-decoration:none; color:inherit; }
  .doclink:hover { background:var(--accent-soft); }
  .doctitle { font-weight:550; }
</style></head>
<body><div class="container"><h1>🌼 Marigold Local</h1><p class="muted">Fast local review loop for agent-authored pages.</p><ul>${items}</ul></div></body></html>`;
}
