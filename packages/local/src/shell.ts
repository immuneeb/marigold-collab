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
<title>${t}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600&family=Figtree:wght@400;500;600&display=swap">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Ccircle cx='12.5' cy='12.5' r='10.5' fill='%23e8870f'/%3E%3Ccircle cx='35.5' cy='12.5' r='10.5' fill='%23e8870f'/%3E%3Ccircle cx='35.5' cy='35.5' r='10.5' fill='%23e8870f'/%3E%3Cpath d='M12.5 25 A10.5 10.5 0 0 1 23 35.5 A10.5 10.5 0 0 1 12.5 46 H4.5 A2.5 2.5 0 0 1 2 43.5 V35.5 A10.5 10.5 0 0 1 12.5 25 Z' fill='%23b8690a'/%3E%3C/svg%3E">
<style>
  :root {
    /* Marigold "Sunroom Workday" tokens (light only) */
    --cream: #FEFBF4; --white: #FFFFFF; --tint: #FAF0DC; --tint-strong: #F5E6C8;
    --line: #EFE7D4; --line-strong: #E0D5BC;
    --ink: #2B2117; --ink-2: #5C5142; --ink-3: #9A8A6E;
    --marigold: #EE8804; --marigold-press: #C77103; --marigold-deep: #9A5B06;
    --green: #3E7D3E; --red: #B8442C; --scrim: rgba(43,33,23,.35);
    --r-sm: 6px; --r-md: 8px; --r-lg: 10px; --r-xl: 14px;
    --shadow-card: 0 1px 3px rgba(43,33,23,.05);
    --shadow-pop: 0 12px 40px rgba(43,33,23,.18);
    --shadow-pin: 0 2px 6px rgba(43,33,23,.18);
    --ease: cubic-bezier(.2,0,0,1); --dur-fast: 120ms; --dur-med: 220ms;
    --font-display: "Bricolage Grotesque", "Figtree", system-ui, sans-serif;
    --font-sans: "Figtree", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    /* back-compat aliases for the few names still referenced below */
    --bg: var(--cream); --fg: var(--ink); --muted: var(--ink-3); --card: var(--white);
    --marigold-dark: var(--marigold-deep); --accent-soft: var(--tint);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { background: var(--cream); color: var(--ink); font: 400 14.5px/1.55 var(--font-sans); }
  .muted { color: var(--ink-3); } .small { font-size: 13px; }
  button { font: inherit; }
  .btn, .btn-secondary, .btn-ghost { display: inline-flex; align-items: center; justify-content: center; border-radius: var(--r-md); font: 600 13.5px/1 var(--font-sans); cursor: pointer; border: 1px solid transparent; transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); }
  .btn { background: var(--marigold); color: #fff; padding: 9px 15px; }
  .btn:hover { background: var(--marigold-press); }
  .btn-secondary { background: var(--tint); color: var(--marigold-deep); border-color: var(--line); padding: 9px 15px; }
  .btn-secondary:hover { background: var(--tint-strong); }
  .btn-ghost { background: transparent; color: var(--ink-2); border-color: var(--line); padding: 7px 12px; font-size: 13px; }
  .btn-ghost:hover { background: var(--tint); color: var(--ink); }
  textarea, input { width: 100%; padding: 8px 11px; border: 1px solid var(--line-strong); border-radius: var(--r-md); font: inherit; background: #fff; color: var(--ink); }
  textarea { resize: vertical; }
  input::placeholder, textarea::placeholder { color: var(--ink-3); }
  input:focus, textarea:focus { outline: none; border-color: var(--marigold); box-shadow: 0 0 0 2px var(--tint-strong); }

  .viewer { display: flex; flex-direction: column; height: 100dvh; }
  .viewer-bar { display: flex; align-items: center; justify-content: space-between; height: 52px; padding: 0 16px; border-bottom: 1px solid var(--line); background: var(--white); gap: 12px; flex: none; }
  .viewer-left { display: flex; align-items: center; gap: 11px; min-width: 0; }
  .viewer-right { display: flex; align-items: center; gap: 10px; }
  .brand { display: inline-flex; align-items: center; gap: 9px; flex: none; }
  .brand-mark { display: block; flex: none; }
  .wordmark { font: 600 16px/1 var(--font-display); letter-spacing: -0.015em; color: var(--ink); }
  .brand-divider { width: 1px; height: 20px; background: var(--line); flex: none; }
  .viewer-title { font: 600 14px/1.3 var(--font-sans); letter-spacing: -0.01em; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ugc-pill { flex: none; font: 600 11px/1.2 var(--font-sans); color: var(--marigold-deep); background: var(--tint); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 3px 9px; }
  .savestate { white-space: nowrap; color: var(--ink-3); }
  .viewer-body { flex: 1; display: flex; min-height: 0; }
  .doc-pane { position: relative; flex: 1; min-width: 0; background: var(--white); }
  .docframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
  .overlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  /* Highlights overlay the doc iframe, so they must never occlude its text:
     multiply blending darkens the backdrop toward the tint instead of painting
     over it — ink text underneath stays fully legible in both states. */
  .hl { position: absolute; pointer-events: none; background: rgba(250, 240, 220, 0.45); mix-blend-mode: multiply; border-bottom: 1.5px solid var(--tint-strong); border-radius: 2px; transition: background var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease); }
  .hl.sel { background: var(--tint); border-bottom: 2px solid var(--marigold); }
  .pin { position: absolute; pointer-events: auto; width: 26px; height: 26px; padding: 0; font: 600 12px/26px var(--font-sans); text-align: center; color: var(--marigold-deep); border-radius: 13px 13px 13px 3px; border: 1px solid var(--marigold); background: #fff; box-shadow: var(--shadow-pin); cursor: pointer; transition: background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease); }
  .pin:hover { background: var(--tint); }
  .pin.sel { background: var(--marigold); color: #fff; }
  .margin-add { position: absolute; right: 10px; pointer-events: auto; padding: 6px 11px; font: 600 12.5px/1 var(--font-sans); border-radius: var(--r-md); border: 1px solid var(--marigold); color: var(--marigold-deep); background: var(--tint); box-shadow: var(--shadow-pin); cursor: pointer; z-index: 5; }
  .margin-add:hover { background: var(--tint-strong); }

  .cmt-sidebar { width: 320px; flex: none; border-left: 1px solid var(--line); background: var(--cream); overflow-y: auto; padding: 12px; display: flex; flex-direction: column; }
  .cmt-scroll { flex: 1; }
  .cmt-head { font: 600 11px/1.3 var(--font-sans); text-transform: uppercase; letter-spacing: .08em; color: var(--ink-3); padding: 4px 4px 10px; }
  .cmt-empty { padding: 8px 4px; }
  .cmt-thread { border: 1px solid var(--line); border-radius: var(--r-lg); padding: 11px 13px; margin-bottom: 10px; background: var(--white); cursor: pointer; box-shadow: var(--shadow-card); }
  .cmt-thread.sel { border-color: var(--marigold); box-shadow: 0 0 0 2px var(--tint-strong); }
  .cmt-thread.resolved { opacity: .6; }
  .cmt-thread.draft { border-color: var(--marigold); cursor: default; }
  .cmt-anchor { font: 400 12px/1.5 var(--font-mono); color: var(--marigold-deep); background: var(--tint); border-radius: var(--r-sm); padding: 5px 9px; margin-bottom: 8px; }
  .cmt-anchor .orphan { color: var(--ink-3); font-family: var(--font-sans); }
  .cmt-overall { display: inline-block; font: 600 11px/1.2 var(--font-sans); color: var(--marigold-deep); background: var(--tint); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 3px 9px; margin-bottom: 8px; }
  .cmt-body { font: 400 13.5px/1.5 var(--font-sans); margin: 6px 0; color: var(--ink); }
  .cmt-body.reply { padding-left: 10px; border-left: 2px solid var(--line); }
  .cmt-author { font-weight: 600; margin-right: 6px; }
  .ai-chip { display: inline-block; font: 600 10px/1.2 var(--font-sans); letter-spacing: .04em; color: var(--marigold-deep); background: var(--tint); border-radius: 4px; padding: 2px 5px; margin-right: 6px; vertical-align: 1px; }
  .cmt-reply { display: flex; gap: 8px; margin-top: 8px; }
  .cmt-reply input { flex: 1; padding: 6px 9px; font-size: 13px; }
  .cmt-actions { display: flex; gap: 8px; margin-top: 8px; }
  .cmt-resolved { margin-top: 10px; border-top: 1px solid var(--line); padding-top: 8px; }
  .cmt-resolved-toggle { width: 100%; text-align: left; border: 0; background: transparent; cursor: pointer; font: 600 12px/1.4 var(--font-sans); color: var(--ink-3); padding: 4px; border-radius: var(--r-sm); }
  .cmt-resolved-toggle:hover { background: var(--tint); color: var(--ink); }

  .submit-panel { border-top: 1px solid var(--line); padding-top: 10px; margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
  .submit-panel .btn { width: 100%; }
  .submit-panel .hint { margin: 0; color: var(--ink-3); }
  .submit-panel .sent { color: var(--marigold-deep); font-weight: 600; }

  .connbar { display: none; padding: 9px 16px; background: var(--tint); border-bottom: 1px solid var(--marigold); font: 400 13.5px/1.5 var(--font-sans); color: var(--marigold-deep); }
  .connbar.show { display: block; }

  .agent-line { margin: 0; font: 400 12.5px/1.4 var(--font-sans); color: var(--ink-3); min-height: 18px; }
  .agent-line.on { color: var(--green); font-weight: 600; }
  .agent-line.busy { color: var(--marigold-deep); font-weight: 600; display: flex; align-items: center; gap: 7px; }
  .spin { display: inline-block; width: 11px; height: 11px; box-sizing: border-box; border: 2px solid var(--tint-strong); border-top-color: var(--marigold); border-radius: 50%; animation: mgspin .8s linear infinite; vertical-align: -1px; }
  @keyframes mgspin { to { transform: rotate(360deg); } }

  .kbd-overlay { position: fixed; inset: 0; z-index: 60; background: var(--scrim); display: flex; align-items: center; justify-content: center; padding: 20px; }
  .kbd-card { background: var(--white); border: 1px solid var(--line); border-radius: var(--r-xl); box-shadow: var(--shadow-pop); padding: 16px 18px; width: 100%; max-width: 460px; max-height: 80dvh; overflow-y: auto; }
  .kbd-title { display: flex; align-items: center; justify-content: space-between; font: 600 15px/1.3 var(--font-display); letter-spacing: -0.01em; padding-bottom: 8px; margin-bottom: 6px; border-bottom: 1px solid var(--line); }
  .kbd-close { border: 0; background: transparent; color: var(--ink-3); cursor: pointer; padding: 2px 7px; border-radius: var(--r-sm); }
  .kbd-close:hover { background: var(--tint); color: var(--ink); }
  .kbd-row { display: flex; align-items: baseline; gap: 14px; padding: 6px 0; }
  .kbd-keys { flex: none; width: 96px; white-space: nowrap; }
  .kbd-what { font-size: 13.5px; color: var(--ink-2); }
  kbd { display: inline-block; font: 600 12px/1 var(--font-mono); color: var(--marigold-deep); background: var(--tint); border: 1px solid var(--line); border-bottom-width: 2px; border-radius: var(--r-sm); padding: 4px 6px; }
</style>
</head>
<body>
<div class="viewer">
  <header class="viewer-bar">
    <div class="viewer-left">
      <span class="brand">
        <svg class="brand-mark" width="24" height="24" viewBox="0 0 48 48" aria-hidden="true">
          <circle cx="12.5" cy="12.5" r="10.5" fill="#e8870f"></circle>
          <circle cx="35.5" cy="12.5" r="10.5" fill="#e8870f"></circle>
          <circle cx="35.5" cy="35.5" r="10.5" fill="#e8870f"></circle>
          <path d="M12.5 25 A10.5 10.5 0 0 1 23 35.5 A10.5 10.5 0 0 1 12.5 46 H4.5 A2.5 2.5 0 0 1 2 43.5 V35.5 A10.5 10.5 0 0 1 12.5 25 Z" fill="#b8690a"></path>
        </svg>
        <span class="wordmark">Marigold</span>
      </span>
      <span class="brand-divider"></span>
      <span class="viewer-title">${t}</span>
      <span class="ugc-pill" title="Served from your machine by marigold-draft">Local draft</span>
    </div>
    <div class="viewer-right">
      <span class="muted small savestate" id="savestate"></span>
      <button class="btn-ghost" id="commentBtn" title="Add a comment — C">+ Comment</button>
      <button class="btn-ghost" id="sidebarBtn" title="Show or hide comments — ⇧C">Comments</button>
    </div>
  </header>
  <div class="connbar" id="connbar"></div>
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
        <p class="agent-line" id="agentLine"></p>
        <textarea id="overall" rows="2" placeholder="Overall feedback (optional)…"></textarea>
        <button class="btn" id="submitBtn" title="Send feedback — ⌘↵">Send feedback to agent</button>
        <p class="muted small hint" id="submitHint">Sends all open comments to the agent. The page reloads when it saves. <kbd>⌘↵</kbd></p>
      </div>
    </aside>
  </div>
</div>
<script>
(function () {
  "use strict";
  var DOC = ${JSON.stringify(docId)};
  var TITLE = ${JSON.stringify(title)};
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
  var connbar = document.getElementById("connbar");
  var DAEMON_DOWN = "Can\\u2019t reach the marigold-draft daemon \\u2014 it may have been stopped. Run 'marigold-draft open <file>' to restart it; this page reconnects by itself.";
  function showConn(msg) { connbar.textContent = msg; connbar.className = "connbar show"; }
  function clearConn() { if (connbar.className !== "connbar") { connbar.textContent = ""; connbar.className = "connbar"; } }
  function api(path, opts) {
    return fetch("/api/docs/" + DOC + path, opts).then(function (r) {
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (d) {
        throw new Error(d.error || ("HTTP " + r.status));
      });
      clearConn();
      return r.json();
    }, function () {
      // fetch itself rejected — daemon unreachable, not an HTTP error
      showConn(DAEMON_DOWN);
      throw new Error("daemon unreachable");
    });
  }
  function fail(prefix) {
    return function (e) {
      if (e && e.message !== "daemon unreachable") showConn(prefix + ": " + e.message);
    };
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
    card.setAttribute("data-thread", c.id);
    card.addEventListener("click", function () {
      selected = c.id;
      if (c.anchor && c.anchor.marigoldId) post({ type: "scrollTo", id: c.anchor.marigoldId });
      render();
    });
    if (c.kind === "overall") card.appendChild(el("div", "cmt-overall", "Overall feedback"));
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
    input.setAttribute("data-reply-for", c.id);
    input.addEventListener("click", function (e) { e.stopPropagation(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && input.value.trim()) {
        api("/comments/" + c.id + "/replies", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: input.value.trim() })
        }).then(refresh).catch(fail("Reply failed"));
        input.value = "";
      } else if (e.key === "Escape") {
        e.stopPropagation();
        input.blur();
      }
    });
    row.appendChild(input);
    var res = el("button", "btn-ghost", c.status === "resolved" ? "Reopen" : "Resolve");
    res.title = (c.status === "resolved" ? "Reopen" : "Resolve") + " — E when selected";
    res.addEventListener("click", function (e) {
      e.stopPropagation();
      api("/comments/" + c.id, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: c.status === "resolved" ? "open" : "resolved" })
      }).then(refresh).catch(fail("Update failed"));
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
        "Select text, then use + Comment to leave a note. Click text to edit it \\u2014 changes save to the file automatically. Press ? for keyboard shortcuts."));
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
      var b = el("button", "margin-add", "+ Comment");
      b.title = "Comment on selection";
      b.style.top = Math.max(4, sel.rect.y + sel.rect.h / 2 - 16) + "px";
      b.addEventListener("click", function () {
        draft = { anchor: sel.anchor };
        sel = null;
        post({ type: "clearSelection" });
        showSidebar();
        render();
      });
      overlay.appendChild(b);
    }
    roots().filter(function (c) { return c.status !== "resolved"; }).forEach(function (c, i) {
      var id = c.anchor && c.anchor.marigoldId;
      var r = id && rects[id];
      if (!r) return;
      var hl = el("div", "hl" + (selected === c.id ? " sel" : ""));
      hl.style.left = r.x + "px";
      hl.style.top = r.y + "px";
      hl.style.width = r.w + "px";
      hl.style.height = r.h + "px";
      overlay.appendChild(hl);
      var pin = el("button", "pin" + (selected === c.id ? " sel" : ""), String(i + 1));
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
    function submitDraft() {
      if (!ta.value.trim()) return;
      // Draft (and its text) survives a failed submit — nothing is lost.
      api("/comments", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchor: draft.anchor, body: ta.value.trim() })
      }).then(function () { draft = null; refresh(); }).catch(fail("Comment failed"));
    }
    ta.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && (e.shiftKey || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        submitDraft();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        draft = null;
        render();
      }
    });
    card.appendChild(ta);
    var actions = el("div", "cmt-actions");
    var ok = el("button", "btn-secondary", "Comment");
    ok.title = "Post \\u2014 \\u21E7\\u21B5";
    ok.addEventListener("click", submitDraft);
    var no = el("button", "btn-ghost", "Cancel");
    no.title = "Esc";
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
    else if (d.type === "placed") { commenting = false; setCommentBtn(); draft = { anchor: d.anchor }; showSidebar(); render(); }
    else if (d.type === "selection") { sel = d.sel || null; renderPins(); }
    else if (d.type === "key") { handleShortcut(d); } // shortcut pressed with focus inside the doc iframe
    else if (d.type === "edited" && d.id) { queue.set(String(d.id), String(d.html || "")); flushEdits(); }
  });
  frame.addEventListener("load", syncAgent);

  // ── header controls ──
  var commentBtn = document.getElementById("commentBtn");
  function setCommentBtn() {
    commentBtn.textContent = commenting ? "Click an element…" : "+ Comment";
    commentBtn.className = commenting ? "btn-secondary" : "btn-ghost";
  }
  function toggleCommentMode() {
    commenting = !commenting;
    draft = null;
    if (commenting) showSidebar(); // else the "Click an element…" state + composer stay hidden
    setCommentBtn();
    post({ type: "commentMode", on: commenting });
    render();
  }
  function toggleSidebar() {
    sidebar.style.display = sidebar.style.display === "none" ? "flex" : "none";
  }
  // The draft composer renders inside the sidebar, so any path that starts a
  // comment must reveal it first — otherwise the text box is there but unseen.
  function showSidebar() { sidebar.style.display = "flex"; }
  commentBtn.addEventListener("click", toggleCommentMode);
  document.getElementById("sidebarBtn").addEventListener("click", toggleSidebar);

  // ── keyboard shortcuts (Docs/Figma-familiar) ──
  // Mirrors the cloud viewer (apps/web viewer-client.tsx) for one muscle memory
  // across local and hosted — except new-comment is plain C here, since the
  // cloud viewer's \\u2318\\u2325M chord is "Minimize All" on macOS (the cloud
  // viewer wants the same treatment). The dispatcher consumes window keydowns
  // AND keys the anchor agent forwards from inside the doc iframe.
  function commentAction() {
    if (sel) {
      draft = { anchor: sel.anchor };
      sel = null;
      post({ type: "clearSelection" });
      showSidebar();
      render();
    } else {
      toggleCommentMode();
    }
  }
  function openRootsList() {
    return roots().filter(function (c) { return c.status !== "resolved"; });
  }
  function selectThread(c) {
    selected = c.id;
    showSidebar();
    if (c.anchor && c.anchor.marigoldId) post({ type: "scrollTo", id: c.anchor.marigoldId });
    render();
    var card = threadsEl.querySelector('[data-thread="' + c.id + '"]');
    if (card) card.scrollIntoView({ block: "nearest" });
  }
  function navComment(dir) {
    var list = openRootsList();
    if (!list.length) return;
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === selected) idx = i;
    var next = idx === -1
      ? list[dir === 1 ? 0 : list.length - 1]
      : list[(idx + dir + list.length) % list.length];
    selectThread(next);
  }
  function focusReply() {
    var list = openRootsList();
    var c = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === selected) c = list[i];
    if (!c) c = list[0];
    if (!c) return;
    selectThread(c);
    var input = threadsEl.querySelector('[data-reply-for="' + c.id + '"]');
    if (input) input.focus();
  }
  function resolveSelected() {
    if (!selected) return;
    var c = null;
    roots().forEach(function (x) { if (x.id === selected) c = x; });
    if (!c) return;
    api("/comments/" + c.id, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: c.status === "resolved" ? "open" : "resolved" })
    }).then(refresh).catch(fail("Update failed"));
  }

  var helpOpen = false;
  var helpEl = null;
  var SHORTCUTS = [
    ["C", "New comment \\u2014 uses your selection, or click an element to place it"],
    ["\\u21E7C", "Show or hide the comments panel"],
    ["N / \\u21E7N", "Next / previous comment"],
    ["R", "Reply to the selected comment"],
    ["E", "Resolve or reopen the selected comment"],
    ["\\u21E7\\u21B5", "Post, while writing a comment"],
    ["\\u2318\\u21B5", "Send feedback to the agent, from the feedback box"],
    ["Esc", "Cancel comment mode, discard a draft, or close this"],
    ["?", "Keyboard shortcuts"]
  ];
  function toggleHelp(force) {
    helpOpen = force != null ? !!force : !helpOpen;
    if (!helpOpen) {
      if (helpEl) { helpEl.remove(); helpEl = null; }
      return;
    }
    if (helpEl) return;
    helpEl = el("div", "kbd-overlay");
    helpEl.addEventListener("click", function () { toggleHelp(false); });
    var card = el("div", "kbd-card");
    card.addEventListener("click", function (e) { e.stopPropagation(); });
    var title = el("div", "kbd-title");
    title.appendChild(el("span", "", "Keyboard shortcuts"));
    var x = el("button", "kbd-close", "\\u2715");
    x.addEventListener("click", function () { toggleHelp(false); });
    title.appendChild(x);
    card.appendChild(title);
    SHORTCUTS.forEach(function (row) {
      var r = el("div", "kbd-row");
      var keys = el("span", "kbd-keys");
      row[0].split(" / ").forEach(function (k, i) {
        if (i) keys.appendChild(document.createTextNode(" / "));
        keys.appendChild(el("kbd", "", k));
      });
      r.appendChild(keys);
      r.appendChild(el("span", "kbd-what", row[1]));
      card.appendChild(r);
    });
    helpEl.appendChild(card);
    document.body.appendChild(helpEl);
  }

  function handleShortcut(k) {
    var mod = !!k.metaKey || !!k.ctrlKey;
    if (k.key === "Escape") {
      // Most-transient thing first, one layer per press.
      if (helpOpen) toggleHelp(false);
      else if (commenting) toggleCommentMode();
      else if (draft) { draft = null; render(); }
      else if (sel) { sel = null; post({ type: "clearSelection" }); renderPins(); }
      else if (selected) { selected = null; render(); }
      else return false;
      return true;
    }
    if (k.key === "?" && !mod && !k.altKey) { toggleHelp(); return true; }
    if (mod || k.altKey) return false;
    var kk = String(k.key || "").toLowerCase();
    // C = new comment (GitHub/Linear convention), \\u21E7C = toggle the panel.
    // Safe as a bare letter: the anchor agent only forwards keys when the reader
    // isn't mid-edit or in a doc form field, so typing a C never lands here.
    // Replaces the old \\u2318\\u2325M chord, which macOS grabs as "Minimize All"
    // before the page can see it.
    if (kk === "c") {
      if (k.shiftKey) { toggleSidebar(); return true; }
      commentAction();
      return true;
    }
    if (kk === "n") { navComment(k.shiftKey ? -1 : 1); return true; }
    if (kk === "r" && !k.shiftKey) { focusReply(); return true; }
    if (kk === "e" && !k.shiftKey) { resolveSelected(); return true; }
    return false;
  }
  function typingTarget(t) {
    return !!(t && t.nodeType === 1 && (t.isContentEditable ||
      t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT"));
  }
  window.addEventListener("keydown", function (e) {
    if (typingTarget(e.target)) return; // composers handle their own keys
    if (handleShortcut(e)) e.preventDefault();
  });

  // ── agent presence + submit lifecycle ──
  // idle → (submit) → revising (spinner, agent had a live waiter)
  //                 → away    (saved; no agent connected — delivered later)
  // reload/version ends revising/away with a "Revision ready" flash + notification.
  var agentListening = false;
  var submitState = "idle"; // idle | revising | away
  var agentLine = document.getElementById("agentLine");
  function renderAgentLine() {
    agentLine.textContent = "";
    agentLine.className = "agent-line";
    if (submitState === "revising") {
      agentLine.className = "agent-line busy";
      var s = document.createElement("span");
      s.className = "spin";
      agentLine.appendChild(s);
      agentLine.appendChild(document.createTextNode("Agent is revising\\u2026 the page reloads when it saves"));
    } else if (submitState === "away") {
      agentLine.textContent = "Feedback saved \\u2713 \\u2014 no agent connected. It\\u2019s delivered automatically when one checks in; to deliver now, tell your agent \\u201Ccheck the draft\\u201D.";
    } else if (agentListening) {
      agentLine.className = "agent-line on";
      agentLine.textContent = "\\u25CF Agent connected \\u2014 feedback lands instantly";
    } else {
      agentLine.textContent = "\\u25CB Agent not connected \\u2014 feedback is saved for when it returns; \\u201Ccheck the draft\\u201D in chat delivers it instantly";
    }
  }
  function flashAgentLine(text) {
    submitState = "idle";
    agentLine.className = "agent-line on";
    agentLine.textContent = text;
    setTimeout(renderAgentLine, 4000);
  }
  function notify(body) {
    try {
      if (!("Notification" in window) || Notification.permission !== "granted") return;
      if (!document.hidden) return; // visible tab: the reload itself is the signal
      var n = new Notification(TITLE, { body: body });
      n.onclick = function () { window.focus(); n.close(); };
    } catch (e) {}
  }

  var submitBtn = document.getElementById("submitBtn");
  var overall = document.getElementById("overall");
  overall.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !submitBtn.disabled) {
      e.preventDefault();
      submitBtn.click();
    }
  });
  submitBtn.addEventListener("click", function () {
    // First submit is the natural moment to ask for notification permission.
    try {
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
    } catch (e) {}
    submitBtn.disabled = true;
    api("/submit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ overallComment: overall.value.trim() || null })
    }).then(function (resp) {
      overall.value = "";
      refresh(); // the freeform text is now a doc-level comment — show its card
      submitState = resp.agentListening ? "revising" : "away";
      renderAgentLine();
      submitBtn.textContent = "Sent \\u2713";
      setTimeout(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = "Send feedback to agent";
      }, 2000);
    }).catch(function (e) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Send feedback to agent";
      fail("Submit failed")(e);
    });
  });

  // ── SSE: live reload + comment sync ──
  function connectSSE() {
    var es = new EventSource("/api/docs/" + DOC + "/events");
    es.addEventListener("hello", function (ev) {
      // (Re)connected — daemon is up; clear any stale banner and resync.
      clearConn();
      try { agentListening = !!JSON.parse(ev.data).agentListening; } catch (e) {}
      if (submitState === "idle") renderAgentLine();
      refresh();
    });
    es.addEventListener("agent", function (ev) {
      try { agentListening = !!JSON.parse(ev.data).listening; } catch (e) {}
      if (submitState === "idle") renderAgentLine();
    });
    es.addEventListener("reload", function (ev) {
      try { version = JSON.parse(ev.data).version; } catch (e) {}
      rects = {};
      frame.src = "/d/" + DOC + "/frame?v=" + version;
      refresh();
      if (submitState !== "idle") {
        flashAgentLine("\\u2713 Revision ready");
        notify("New revision is ready to view");
      } else {
        notify("The draft was updated");
      }
    });
    es.addEventListener("version", function (ev) {
      try { version = JSON.parse(ev.data).version; } catch (e) {}
    });
    es.addEventListener("comments", function () { refresh(); });
    es.onerror = function () { showConn(DAEMON_DOWN); es.close(); setTimeout(connectSSE, 1500); };
  }
  connectSSE();
  renderAgentLine();

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
    : `<li><p class="muted" style="padding:14px 16px">No drafts open. Run <code>marigold-draft open &lt;file.html&gt;</code></p></li>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Marigold</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600&family=Figtree:wght@400;500;600&display=swap">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 48 48'%3E%3Ccircle cx='12.5' cy='12.5' r='10.5' fill='%23e8870f'/%3E%3Ccircle cx='35.5' cy='12.5' r='10.5' fill='%23e8870f'/%3E%3Ccircle cx='35.5' cy='35.5' r='10.5' fill='%23e8870f'/%3E%3Cpath d='M12.5 25 A10.5 10.5 0 0 1 23 35.5 A10.5 10.5 0 0 1 12.5 46 H4.5 A2.5 2.5 0 0 1 2 43.5 V35.5 A10.5 10.5 0 0 1 12.5 25 Z' fill='%23b8690a'/%3E%3C/svg%3E">
<style>
  :root {
    --cream:#FEFBF4; --white:#FFFFFF; --tint:#FAF0DC; --line:#EFE7D4;
    --ink:#2B2117; --ink-2:#5C5142; --ink-3:#9A8A6E; --marigold-deep:#9A5B06;
    --r-lg:10px;
    --font-display:"Bricolage Grotesque","Figtree",system-ui,sans-serif;
    --font-sans:"Figtree",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --font-mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  }
  body { background:var(--cream); color:var(--ink); font:400 14.5px/1.55 var(--font-sans); margin:0; }
  .container { max-width:720px; margin:0 auto; padding:40px 24px; }
  .muted { color:var(--ink-3); } .small { font-size:13px; }
  code { font-family:var(--font-mono); font-size:12.5px; background:var(--tint); color:var(--marigold-deep); padding:2px 6px; border-radius:5px; }
  ul { list-style:none; margin:20px 0 0; padding:0; border:1px solid var(--line); border-radius:var(--r-lg); overflow:hidden; background:var(--white); box-shadow:0 1px 3px rgba(43,33,23,.05); }
  li + li { border-top:1px solid var(--line); }
  .doclink { display:flex; align-items:baseline; justify-content:space-between; gap:12px; padding:15px 18px; text-decoration:none; color:inherit; }
  .doclink:hover { background:var(--tint); }
  .doctitle { font:600 14.5px/1.3 var(--font-sans); color:var(--ink); }
  h1.brand { display:flex; align-items:center; gap:10px; font:600 22px/1 var(--font-display); letter-spacing:-0.015em; color:var(--ink); margin:0; }
  .brand-mark { flex:none; }
</style></head>
<body><div class="container"><h1 class="brand"><svg class="brand-mark" width="26" height="26" viewBox="0 0 48 48" aria-hidden="true"><circle cx="12.5" cy="12.5" r="10.5" fill="#e8870f"></circle><circle cx="35.5" cy="12.5" r="10.5" fill="#e8870f"></circle><circle cx="35.5" cy="35.5" r="10.5" fill="#e8870f"></circle><path d="M12.5 25 A10.5 10.5 0 0 1 23 35.5 A10.5 10.5 0 0 1 12.5 46 H4.5 A2.5 2.5 0 0 1 2 43.5 V35.5 A10.5 10.5 0 0 1 12.5 25 Z" fill="#b8690a"></path></svg>Marigold</h1><p class="muted" style="margin-top:10px">Fast local review loop for agent-authored pages.</p><ul>${items}</ul></div></body></html>`;
}
