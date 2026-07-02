// The trusted anchor agent. Injected into every doc (via a <script src> tag at
// ingest, or on the fly for legacy docs) and served by the render origin at
// /__mg/agent.js. It runs INSIDE the sandboxed, opaque-origin iframe and talks
// to the parent over postMessage. It handles geometry, anchor capture, in-place
// editing and block arrangement — comment bodies never enter this frame. The
// parent validates messages by event.source (the iframe window), since a
// sandboxed iframe's origin is "null".
//
// Editing model: element ids are position-derived, so structural changes make
// descendant ids untrustworthy. The agent tracks `stableIds` (ids present at
// load) and, whenever it persists a change, sends the content of the nearest
// STABLE container (or "__body__") — then invalidates that container's
// descendants. This guarantees an edit can never land on the wrong element.
export const ANCHOR_AGENT_JS = String.raw`(function () {
  "use strict";
  var MG = "__mg";
  function send(msg) { msg[MG] = 1; try { parent.postMessage(msg, "*"); } catch (e) {} }
  var tracked = [];
  var commentMode = false;
  var editEnabled = false;

  function cssEscape(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\\]]/g, "\\$&");
  }
  function elFor(id) { return document.querySelector('[data-marigold-id="' + cssEscape(id) + '"]'); }
  function norm(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
  function mgid(el) { return el && el.getAttribute ? el.getAttribute("data-marigold-id") : null; }

  // ── stable-id bookkeeping ──
  var stableIds = {};
  Array.prototype.forEach.call(document.querySelectorAll("[data-marigold-id]"), function (el) {
    stableIds[el.getAttribute("data-marigold-id")] = 1;
  });
  function isStable(el) { var id = mgid(el); return !!(id && stableIds[id]); }
  function stableTarget(el) {
    while (el && el !== document.body && el.nodeType === 1) {
      if (isStable(el)) return el;
      el = el.parentElement;
    }
    return "__body__";
  }
  function invalidateInside(node) {
    Array.prototype.forEach.call(node.querySelectorAll("[data-marigold-id]"), function (el) {
      delete stableIds[el.getAttribute("data-marigold-id")];
    });
  }
  function tempId() {
    var b = new Uint8Array(5), h = "";
    crypto.getRandomValues(b);
    for (var i = 0; i < b.length; i++) h += ("0" + b[i].toString(16)).slice(-2);
    return "mg-" + h;
  }

  // ── unified persistence: send the content of a stable container ──
  function captureContent(node) {
    var clone = node.cloneNode(true);
    Array.prototype.forEach.call(
      clone.querySelectorAll("#__mg_controls, script[data-mg-agent]"),
      function (n) { n.parentNode && n.parentNode.removeChild(n); }
    );
    return clone.innerHTML;
  }
  function sendEdit(fromEl) {
    var target = stableTarget(fromEl);
    var node = target === "__body__" ? document.body : target;
    var id = target === "__body__" ? "__body__" : mgid(target);
    send({ type: "edited", id: id, html: captureContent(node) });
    invalidateInside(node);
    schedule();
  }

  // ── geometry for comment pins ──
  function reportRects() {
    var rects = {};
    for (var i = 0; i < tracked.length; i++) {
      var el = elFor(tracked[i]);
      if (el) {
        var r = el.getBoundingClientRect();
        if (r.width || r.height) rects[tracked[i]] = { x: r.left, y: r.top, w: r.width, h: r.height };
      }
    }
    send({ type: "rects", rects: rects, vw: window.innerWidth, vh: window.innerHeight });
  }
  var raf = null;
  function schedule() { if (raf) return; raf = requestAnimationFrame(function () { raf = null; reportRects(); positionControls(); }); }

  // ── anchors ──
  function cssPath(el) {
    var parts = [];
    while (el && el.nodeType === 1 && el.tagName !== "HTML" && el.tagName !== "BODY") {
      var sel = el.tagName.toLowerCase();
      var p = el.parentElement;
      if (p) {
        var sibs = Array.prototype.filter.call(p.children, function (c) { return c.tagName === el.tagName; });
        if (sibs.length > 1) sel += ":nth-of-type(" + (sibs.indexOf(el) + 1) + ")";
      }
      parts.unshift(sel);
      el = el.parentElement;
    }
    return parts.join(" > ");
  }
  function xPath(el) {
    var parts = [];
    while (el && el.nodeType === 1) {
      var idx = 1, sib = el.previousElementSibling;
      while (sib) { if (sib.tagName === el.tagName) idx++; sib = sib.previousElementSibling; }
      parts.unshift(el.tagName.toLowerCase() + "[" + idx + "]");
      el = el.parentElement;
    }
    return "/" + parts.join("/");
  }
  function nearestMg(node) {
    var el = node && node.nodeType === 1 ? node : node ? node.parentElement : null;
    while (el && el.nodeType === 1 && !mgid(el)) el = el.parentElement;
    return el && el.nodeType === 1 ? el : null;
  }
  function anchorFor(el, exact) {
    var target = nearestMg(el) || el;
    var r = target.getBoundingClientRect();
    var quote = { prefix: "", exact: exact || norm(target.textContent).slice(0, 160), suffix: "" };
    if (exact) {
      var full = norm(target.textContent);
      var i = full.indexOf(exact);
      if (i >= 0) {
        quote.prefix = full.slice(Math.max(0, i - 32), i);
        quote.suffix = full.slice(i + exact.length, i + exact.length + 32);
      }
    }
    return {
      marigoldId: mgid(target),
      css: cssPath(target),
      xpath: xPath(target),
      textQuote: quote,
      rect: {
        x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height,
        scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight
      }
    };
  }

  // ── selection → floating margin comment button in the parent ──
  var selTimer = null;
  var lastSelKey = "";
  function reportSelection() {
    if (editingEl) return;
    var s = window.getSelection();
    if (!s || s.isCollapsed || s.rangeCount === 0) {
      if (lastSelKey) { lastSelKey = ""; send({ type: "selection", sel: null }); }
      return;
    }
    var exact = norm(s.toString()).slice(0, 200);
    if (exact.length < 2) return;
    var range = s.getRangeAt(0);
    var r = range.getBoundingClientRect();
    var key = exact + "|" + Math.round(r.top);
    if (key === lastSelKey) return;
    lastSelKey = key;
    send({
      type: "selection",
      sel: { anchor: anchorFor(range.commonAncestorContainer, exact), rect: { x: r.left, y: r.top, w: r.width, h: r.height } }
    });
  }
  document.addEventListener("selectionchange", function () {
    if (selTimer) clearTimeout(selTimer);
    selTimer = setTimeout(reportSelection, 180);
  });
  document.addEventListener("mouseup", function () { setTimeout(reportSelection, 0); });

  // ── in-place editing: double-click → contentEditable, blur = auto-save ──
  var editingEl = null, editingOrig = "";
  function onEditBlur() { endEdit(true); }
  function endEdit(save) {
    if (!editingEl) return;
    var el = editingEl, orig = editingOrig;
    editingEl = null; editingOrig = "";
    el.removeEventListener("blur", onEditBlur);
    el.contentEditable = "false";
    el.style.outline = ""; el.style.outlineOffset = "";
    if (!save) { el.innerHTML = orig; }
    else if (el.innerHTML !== orig) { sendEdit(el); }
    schedule();
  }
  function beginEdit(el) {
    if (editingEl === el) return;
    if (editingEl) endEdit(true);
    hideControls();
    editingEl = el; editingOrig = el.innerHTML;
    el.contentEditable = "true";
    el.style.outline = "2px solid #e8870f"; el.style.outlineOffset = "2px";
    el.addEventListener("blur", onEditBlur);
    el.focus();
    send({ type: "editStart", id: mgid(el) });
  }
  document.addEventListener("dblclick", function (e) {
    if (!editEnabled || commentMode) return;
    if (controls.contains(e.target)) return;
    var el = nearestMg(e.target);
    if (!el) return;
    e.preventDefault();
    beginEdit(el);
  }, true);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && editingEl) { e.preventDefault(); endEdit(false); }
  });

  // ── hover controls: move / duplicate / delete / add ──
  var controls = document.createElement("div");
  controls.id = "__mg_controls";
  controls.style.cssText = "position:fixed;display:none;z-index:2147483647;background:#fff;border:1px solid #e8870f;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.18);padding:2px;gap:2px;align-items:center;font:12px/1 system-ui,sans-serif;";
  var curTarget = null;
  function mkBtn(label, title, fn) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.style.cssText = "border:0;background:transparent;cursor:pointer;padding:4px 6px;border-radius:5px;font-size:12px;color:#b8690a;";
    b.addEventListener("mouseenter", function () { b.style.background = "#fdf3e3"; });
    b.addEventListener("mouseleave", function () { b.style.background = "transparent"; });
    b.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (curTarget && document.contains(curTarget)) fn(curTarget);
    });
    controls.appendChild(b);
    return b;
  }
  function swap(el, dir) {
    var sib = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
    while (sib && (sib.id === "__mg_controls" || (sib.hasAttribute && sib.hasAttribute("data-mg-agent")))) {
      sib = dir < 0 ? sib.previousElementSibling : sib.nextElementSibling;
    }
    if (!sib || !el.parentElement) return;
    if (dir < 0) el.parentElement.insertBefore(el, sib);
    else el.parentElement.insertBefore(sib, el);
    sendEdit(el.parentElement === document.body ? document.body : el.parentElement);
    positionControls();
  }
  function stripIds(node) {
    if (node.removeAttribute) node.removeAttribute("data-marigold-id");
    Array.prototype.forEach.call(node.querySelectorAll ? node.querySelectorAll("[data-marigold-id]") : [], function (n) {
      n.removeAttribute("data-marigold-id");
    });
  }
  mkBtn("↑", "Move up", function (el) { swap(el, -1); });
  mkBtn("↓", "Move down", function (el) { swap(el, 1); });
  mkBtn("⧉", "Duplicate", function (el) {
    var clone = el.cloneNode(true);
    stripIds(clone);
    clone.setAttribute("data-marigold-id", tempId());
    el.parentElement.insertBefore(clone, el.nextSibling);
    sendEdit(el.parentElement);
  });
  mkBtn("＋", "Add a paragraph below", function (el) {
    var p = document.createElement("p");
    p.setAttribute("data-marigold-id", tempId());
    p.textContent = "New paragraph";
    el.parentElement.insertBefore(p, el.nextSibling);
    sendEdit(el.parentElement);
    beginEdit(p);
    try {
      var r = document.createRange(); r.selectNodeContents(p);
      var s = getSelection(); s.removeAllRanges(); s.addRange(r);
    } catch (err) {}
  });
  mkBtn("✕", "Delete (previous versions keep a copy)", function (el) {
    var parent = el.parentElement;
    el.remove();
    hideControls();
    sendEdit(parent === document.body ? document.body : parent);
  });
  function ensureControls() { if (!controls.parentNode && document.body) document.body.appendChild(controls); }
  function hideControls() { controls.style.display = "none"; curTarget = null; }
  function positionControls() {
    if (!curTarget || controls.style.display === "none") return;
    if (!document.contains(curTarget)) { hideControls(); return; }
    var r = curTarget.getBoundingClientRect();
    controls.style.display = "flex";
    var w = controls.offsetWidth || 130;
    controls.style.left = Math.max(4, Math.min(window.innerWidth - w - 4, r.right - w)) + "px";
    controls.style.top = Math.max(4, r.top - 30) + "px";
  }
  document.addEventListener("mousemove", function (e) {
    if (!editEnabled || commentMode || editingEl) { if (controls.style.display !== "none") hideControls(); return; }
    if (controls.contains(e.target)) return;
    var el = nearestMg(e.target);
    if (!el || el === document.body) { hideControls(); return; }
    // Show synchronously (rAF gating is unreliable in throttled/background
    // frames, and must re-show even when hovering the same element again).
    ensureControls();
    curTarget = el;
    controls.style.display = "flex";
    positionControls();
  }, { passive: true });

  // ── explicit comment mode: click any element ──
  document.addEventListener("click", function (e) {
    if (!commentMode) return;
    if (controls.contains(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    commentMode = false;
    document.documentElement.style.cursor = "";
    send({ type: "placed", anchor: anchorFor(e.target, null), point: { x: e.clientX, y: e.clientY } });
  }, true);

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d[MG] !== 1) return;
    if (d.type === "track") { tracked = d.ids || []; reportRects(); }
    else if (d.type === "getRects") { reportRects(); }
    else if (d.type === "commentMode") { commentMode = !!d.on; document.documentElement.style.cursor = commentMode ? "crosshair" : ""; if (commentMode) hideControls(); }
    else if (d.type === "editable") { editEnabled = !!d.on; if (!d.on) { endEdit(false); hideControls(); } }
    else if (d.type === "clearSelection") { try { window.getSelection().removeAllRanges(); } catch (err) {} lastSelKey = ""; }
    else if (d.type === "scrollTo") { var el = elFor(d.id); if (el) el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  });

  window.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  if (window.ResizeObserver) { try { new ResizeObserver(schedule).observe(document.documentElement); } catch (e) {} }

  // Re-emit ready a few times: if the parent hasn't hydrated its message
  // listener yet, a single ready is lost. (The parent also proactively pushes
  // config after mount — two-sided handshake, can't be missed.)
  var readyTries = 0;
  (function pingReady() {
    send({ type: "ready" });
    if (++readyTries < 5) setTimeout(pingReady, 300);
  })();
})();`;
