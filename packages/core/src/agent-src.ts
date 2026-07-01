// The trusted anchor agent. Injected into every doc (via a <script src> tag at
// ingest) and served by the render origin at /__mg/agent.js. It runs INSIDE the
// sandboxed, opaque-origin iframe and talks to the parent over postMessage.
// It only handles geometry + anchor capture/resolution — comment bodies never
// enter this frame. The parent validates messages by event.source (the iframe
// window), since a sandboxed iframe's origin is "null".
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
  function textQuote(el) {
    var t = (el.textContent || "").replace(/\s+/g, " ").trim();
    return { prefix: "", exact: t.slice(0, 160), suffix: "" };
  }
  function anchorOf(el) {
    var cur = el;
    while (cur && cur.nodeType === 1 && !(cur.getAttribute && cur.getAttribute("data-marigold-id"))) cur = cur.parentElement;
    var target = (cur && cur.nodeType === 1) ? cur : el;
    var r = target.getBoundingClientRect();
    return {
      marigoldId: target.getAttribute ? target.getAttribute("data-marigold-id") : null,
      css: cssPath(target),
      xpath: xPath(target),
      textQuote: textQuote(target),
      rect: {
        x: r.left + window.scrollX, y: r.top + window.scrollY, w: r.width, h: r.height,
        scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight
      }
    };
  }

  document.addEventListener("click", function (e) {
    if (!commentMode) return;
    e.preventDefault(); e.stopPropagation();
    commentMode = false;
    document.documentElement.style.cursor = "";
    send({ type: "placed", anchor: anchorOf(e.target), point: { x: e.clientX, y: e.clientY } });
  }, true);

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d[MG] !== 1) return;
    if (d.type === "track") { tracked = d.ids || []; reportRects(); }
    else if (d.type === "getRects") { reportRects(); }
    else if (d.type === "commentMode") { commentMode = !!d.on; document.documentElement.style.cursor = commentMode ? "crosshair" : ""; }
    else if (d.type === "scrollTo") { var el = elFor(d.id); if (el) el.scrollIntoView({ block: "center", behavior: "smooth" }); }
  });

  window.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  if (window.ResizeObserver) { try { new ResizeObserver(schedule).observe(document.documentElement); } catch (e) {} }

  send({ type: "ready" });
})();`;
