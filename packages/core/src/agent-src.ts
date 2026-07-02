// The trusted anchor agent. Injected into every doc (via a <script src> tag at
// ingest, or on the fly for legacy docs) and served by the render origin at
// /__mg/agent.js. It runs INSIDE the sandboxed, opaque-origin iframe and talks
// to the parent over postMessage. It only handles geometry + anchor capture and
// resolution — comment bodies never enter this frame. The parent validates
// messages by event.source (the iframe window), since a sandboxed iframe's
// origin is "null".
export const ANCHOR_AGENT_JS = String.raw`(function () {
  "use strict";
  var MG = "__mg";
  function send(msg) { msg[MG] = 1; try { parent.postMessage(msg, "*"); } catch (e) {} }
  var tracked = [];
  var commentMode = false;

  function cssEscape(s) {
    return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\\]]/g, "\\$&");
  }
  function elFor(id) { return document.querySelector('[data-marigold-id="' + cssEscape(id) + '"]'); }
  function norm(s) { return String(s || "").replace(/\s+/g, " ").trim(); }

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
  function schedule() { if (raf) return; raf = requestAnimationFrame(function () { raf = null; reportRects(); }); }

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
    while (el && el.nodeType === 1 && !(el.getAttribute && el.getAttribute("data-marigold-id"))) el = el.parentElement;
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
      marigoldId: target.getAttribute ? target.getAttribute("data-marigold-id") : null,
      css: cssPath(target),
      xpath: xPath(target),
      textQuote: quote,
      rect: {
        x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height,
        scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight
      }
    };
  }

  // ── selection → floating margin button in the parent (Google-Docs style) ──
  var selTimer = null;
  var lastSelKey = "";
  function reportSelection() {
    if (editingEl) return; // no comment button while typing in an edit
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
      sel: {
        anchor: anchorFor(range.commonAncestorContainer, exact),
        rect: { x: r.left, y: r.top, w: r.width, h: r.height }
      }
    });
  }
  document.addEventListener("selectionchange", function () {
    if (selTimer) clearTimeout(selTimer);
    selTimer = setTimeout(reportSelection, 180);
  });
  document.addEventListener("mouseup", function () { setTimeout(reportSelection, 0); });

  // ── in-place editing: double-click any element → contentEditable ──
  var editEnabled = false, editingEl = null, editingOrig = "";
  function onEditBlur() { endEdit(true); }
  function endEdit(save) {
    if (!editingEl) return;
    var el = editingEl, orig = editingOrig;
    editingEl = null; editingOrig = "";
    el.removeEventListener("blur", onEditBlur);
    el.contentEditable = "false";
    el.style.outline = ""; el.style.outlineOffset = "";
    if (!save) { el.innerHTML = orig; send({ type: "editCancel" }); }
    else if (el.innerHTML !== orig) {
      send({ type: "edited", id: el.getAttribute("data-marigold-id"), html: el.innerHTML });
    }
    schedule();
  }
  document.addEventListener("dblclick", function (e) {
    if (!editEnabled || commentMode) return;
    var el = nearestMg(e.target);
    if (!el || el === editingEl) return;
    if (editingEl) endEdit(true);
    e.preventDefault();
    editingEl = el; editingOrig = el.innerHTML;
    el.contentEditable = "true";
    el.style.outline = "2px solid #e8870f"; el.style.outlineOffset = "2px";
    el.addEventListener("blur", onEditBlur);
    el.focus();
    send({ type: "editStart", id: el.getAttribute("data-marigold-id") });
  }, true);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && editingEl) { e.preventDefault(); endEdit(false); }
  });

  // ── explicit comment mode: click any element ──
  document.addEventListener("click", function (e) {
    if (!commentMode) return;
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
    else if (d.type === "commentMode") { commentMode = !!d.on; document.documentElement.style.cursor = commentMode ? "crosshair" : ""; }
    else if (d.type === "editable") { editEnabled = !!d.on; if (!d.on) endEdit(false); }
    else if (d.type === "clearSelection") { try { window.getSelection().removeAllRanges(); } catch (err) {} lastSelKey = ""; }
    else if (d.type === "scrollTo") { var el = elFor(d.id); if (el) el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  });

  window.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  if (window.ResizeObserver) { try { new ResizeObserver(schedule).observe(document.documentElement); } catch (e) {} }

  send({ type: "ready" });
})();`;
