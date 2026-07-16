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
      clone.querySelectorAll("#__mg_controls, script[data-mg-agent], [data-mg-ui]"),
      function (n) { n.parentNode && n.parentNode.removeChild(n); }
    );
    // Un-wire cloned <mg-control>s: agent-added state must never persist into
    // doc source (a serialized data-mg-wired would block re-init on reload).
    Array.prototype.forEach.call(
      clone.querySelectorAll("[data-mg-wired], [data-mg-state], [data-mg-disabled], [data-mg-sel], [data-mg-tap]"),
      function (n) {
        n.removeAttribute("data-mg-wired");
        n.removeAttribute("data-mg-state");
        n.removeAttribute("data-mg-disabled");
        n.removeAttribute("data-mg-sel");
        n.removeAttribute("data-mg-tap");
      }
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
  // Track drag state so hover controls never mutate the DOM mid-selection
  // (that can collapse the native selection and kill the comment flow).
  var selecting = false;
  function hasSelection() {
    var s = window.getSelection();
    return !!(s && !s.isCollapsed && s.rangeCount);
  }
  // ── unified pointer gestures (mouse + touch + pen) ──
  // Pointer Events fire on every element on every device — crucially, on a tap on
  // a non-interactive <p> on iOS, where a bare "click" is never dispatched. That
  // gap is exactly why commenting and tap-to-edit were dead on mobile. We detect a
  // tap (pointerdown + pointerup with little movement) and run the same placement/
  // edit logic the desktop click path uses. A drag or scroll (movement, or a
  // pointercancel when the browser claims the gesture for text selection) is never
  // a tap, so it can't fire an accidental comment or edit.
  var tapId = null, tapX = 0, tapY = 0, tapMoved = false, tapType = "";
  var suppressClick = false;
  document.addEventListener("pointerdown", function (e) {
    if (controls.contains(e.target)) return;
    tapId = e.pointerId; tapType = e.pointerType || "";
    tapX = e.clientX; tapY = e.clientY; tapMoved = false;
    selecting = true;
    // Don't yank the controls out from under an active touch edit (re-tapping to
    // move the caret would otherwise hide them); desktop still clears on drag.
    if (!editingEl) hideControls();
  }, { capture: true, passive: true });
  document.addEventListener("pointermove", function (e) {
    if (e.pointerId !== tapId) return;
    if (Math.abs(e.clientX - tapX) > 10 || Math.abs(e.clientY - tapY) > 10) tapMoved = true;
  }, { capture: true, passive: true });
  document.addEventListener("pointerup", function (e) {
    if (e.pointerId !== tapId) return;
    var moved = tapMoved, type = tapType;
    tapId = null;
    selecting = false;
    setTimeout(reportSelection, 0); // the reliable "report on release" path
    // Mouse taps fall through to the click handler below (desktop unchanged).
    // Touch and pen are handled here because their click is unreliable on iOS.
    if (!moved && type !== "mouse" && handleTap(e.target, e.clientX, e.clientY, null)) {
      // iOS may still synthesize a compatibility click ~300ms later — swallow it
      // so it can't re-fire the action or follow a link we just commented on.
      suppressClick = true;
      setTimeout(function () { suppressClick = false; }, 700);
    }
  }, { capture: true });
  document.addEventListener("pointercancel", function (e) {
    if (e.pointerId !== tapId) return;
    var moved = tapMoved, type = tapType, x = tapX, y = tapY;
    tapId = null; selecting = false;
    // Real iOS can still claim an armed tap as a native gesture (loupe /
    // long-press heuristics run in the UI process, beyond what user-select
    // suppresses) and deliver pointercancel instead of pointerup. With comment
    // mode armed, an unmoved touch is unambiguous intent — place the comment
    // at the touch point instead of silently dropping it. Movement still
    // means scroll, never a placement.
    if (commentMode && !moved && type !== "mouse") {
      var t = document.elementFromPoint(x, y) || e.target;
      if (t) handleTap(t, x, y, null);
    }
  }, { capture: true, passive: true });

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
  function beginEdit(el, caret) {
    if (editingEl === el) return;
    if (editingEl) endEdit(true);
    hideControls();
    lastSelKey = "";
    send({ type: "selection", sel: null });
    editingEl = el; editingOrig = el.innerHTML;
    el.contentEditable = "true";
    el.style.outline = "2px solid #e8870f"; el.style.outlineOffset = "2px";
    el.addEventListener("blur", onEditBlur);
    el.focus();
    // Place the caret where the user clicked (single-click-to-type feel).
    if (caret) { try { var s = window.getSelection(); s.removeAllRanges(); s.addRange(caret); } catch (err) {} }
    send({ type: "editStart", id: mgid(el) });
    // Touchscreens have no hover to surface the block controls, so reveal them
    // whenever an edit begins on a coarse pointer (independent of tap vs click).
    if (coarse) showControlsFor(el);
  }
  function caretFromPoint(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y);
      if (!p) return null;
      var r = document.createRange();
      r.setStart(p.offsetNode, p.offset); r.collapse(true);
      return r;
    }
    return null;
  }
  // Don't hijack clicks on genuinely interactive elements — keep them working.
  function isInteractive(node) {
    var el = node;
    while (el && el.nodeType === 1 && el !== document.body) {
      var t = el.tagName;
      if (t === "A" || t === "BUTTON" || t === "INPUT" || t === "TEXTAREA" ||
          t === "SELECT" || t === "LABEL" || t === "SUMMARY" || t === "OPTION" ||
          t === "MG-CONTROL") return true;
      el = el.parentElement;
    }
    return false;
  }
  // Keyboard: Escape cancels an in-place edit here; everything else the user
  // types while focus sits in this frame is invisible to the parent, so
  // whitelisted shortcut keys are forwarded up for the viewer shell to act on
  // (C = comment, N = next, ? = help, ...). Never forwarded mid-edit or from
  // the doc's own form fields.
  document.addEventListener("keydown", function (e) {
    if (editingEl) {
      if (e.key === "Escape") { e.preventDefault(); endEdit(false); }
      return;
    }
    var t = e.target;
    if (t && t.nodeType === 1 && (t.isContentEditable ||
        t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    var mod = e.metaKey || e.ctrlKey;
    var fwd = mod && e.altKey && e.code === "KeyM"; // Docs' insert-comment chord
    if (!fwd && !mod && !e.altKey) {
      var k = e.key.toLowerCase();
      fwd = k === "c" || k === "n" || k === "e" || k === "r" || e.key === "?" || e.key === "Escape";
    }
    if (fwd) send({
      type: "key", key: e.key, code: e.code,
      shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey
    });
  });

  // ── block controls: move / duplicate / delete / add. Revealed on hover
  // (desktop) or on tap (touch — see handleTap); a touchscreen has no hover. ──
  var coarse = false;
  try { coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches); } catch (e) {}
  var controls = document.createElement("div");
  controls.id = "__mg_controls";
  controls.style.cssText = "position:fixed;display:none;z-index:2147483647;background:#fff;border:1px solid #e8870f;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.18);padding:2px;gap:2px;align-items:center;font:12px/1 system-ui,sans-serif;touch-action:manipulation;";
  var curTarget = null;
  function mkBtn(label, title, fn) {
    var b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    // Coarse pointers get ~40px tap targets (was 20px) so the controls are
    // actually usable with a thumb.
    b.style.cssText = coarse
      ? "border:0;background:transparent;cursor:pointer;padding:12px 14px;border-radius:6px;font-size:18px;line-height:1;min-width:44px;color:#b8690a;-webkit-tap-highlight-color:transparent;"
      : "border:0;background:transparent;cursor:pointer;padding:4px 6px;border-radius:5px;font-size:12px;color:#b8690a;";
    b.addEventListener("mouseenter", function () { b.style.background = "#fdf3e3"; });
    b.addEventListener("mouseleave", function () { b.style.background = "transparent"; });
    // Don't let a tap on a control steal focus from the element being edited —
    // that would blur→save→clear curTarget before this handler's fn runs.
    b.addEventListener("pointerdown", function (e) { e.preventDefault(); });
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
  // Show synchronously (rAF gating is unreliable in throttled/background frames,
  // and must re-show even when re-targeting the same element).
  function showControlsFor(el) {
    if (!el || el === document.body) return;
    ensureControls();
    curTarget = el;
    controls.style.display = "flex";
    positionControls();
  }
  document.addEventListener("mousemove", function (e) {
    // Coarse pointers manage the controls via tap (handleTap/beginEdit); ignore
    // mouse movement entirely so the *compatibility* mousemove a touch tap emits
    // can't immediately hide the controls that tap just revealed.
    if (coarse) return;
    // Suppressed while editing, in comment mode, mid-drag, or when text is
    // selected — element controls must never fight text selection / commenting.
    if (!editEnabled || commentMode || editingEl || selecting || hasSelection()) {
      if (controls.style.display !== "none") hideControls();
      return;
    }
    if (controls.contains(e.target)) return;
    var el = nearestMg(e.target);
    if (!el || el === document.body) { hideControls(); return; }
    showControlsFor(el);
  }, { passive: true });

  // Arming comment mode must also suspend native touch text-selection: iOS
  // otherwise claims a tap on a paragraph as a selection/callout gesture and
  // fires pointercancel instead of pointerup, so handleTap never runs and the
  // tap "does nothing" (pointerdown is passive — we can't preventDefault there).
  // touch-action:manipulation keeps scrolling working while armed but drops
  // double-tap-zoom, whose detection delay can also swallow the tap.
  function setCommentModeUI(on) {
    var s = document.documentElement.style;
    s.cursor = on ? "crosshair" : "";
    s.webkitUserSelect = on ? "none" : "";
    s.userSelect = on ? "none" : "";
    s.webkitTouchCallout = on ? "none" : "";
    s.touchAction = on ? "manipulation" : "";
  }

  // A tap resolved from a pointerup (touch/pen) or a mouse click. Comment mode
  // anchors a comment where you tapped; otherwise a tap on editable text starts
  // an in-place edit (beginEdit reveals the block controls on coarse pointers).
  // Returns true when it acted, so the pointerup caller can swallow the trailing
  // synthetic click.
  function handleTap(target, x, y, ev) {
    if (controls.contains(target)) return false;
    // Explicit comment mode: tap any element to anchor a comment there.
    if (commentMode) {
      if (ev) { ev.preventDefault(); ev.stopPropagation(); }
      commentMode = false;
      setCommentModeUI(false);
      send({ type: "placed", anchor: anchorFor(target, null), point: { x: x, y: y } });
      return true;
    }
    // Single-tap to edit: place a caret and start typing (Google-Docs feel).
    if (!editEnabled || editingEl) return false;
    if (hasSelection()) return false;    // a drag-select → comment, not edit
    // Tapping a link/button or blank space while editing dismisses the controls
    // on touch (there's no click-away hover to do it); keep those elements working.
    if (isInteractive(target)) { if (coarse) hideControls(); return false; }
    var el = nearestMg(target);
    if (!el || el === document.body) { if (coarse) hideControls(); return false; }
    beginEdit(el, caretFromPoint(x, y)); // reveals controls on coarse pointers
    return true;
  }
  document.addEventListener("click", function (e) {
    // A touch tap already acted on pointerup; drop the synthesized click so it
    // can't double-fire or navigate a link under the comment we just placed.
    if (suppressClick) { suppressClick = false; e.preventDefault(); e.stopPropagation(); return; }
    if (controls.contains(e.target)) return;
    handleTap(e.target, e.clientX, e.clientY, e);
  }, true);

  // ── interactive controls (<mg-control>) — one-tap typed reader signals ──
  // The agent renders + wires author-placed <mg-control name=...> elements.
  // A tap computes the next value locally (optimistic paint) and relays it to
  // the parent shell, which persists it — this frame has no network path
  // (CSP connect-src 'none'). The parent hydrates saved values and enables
  // taps via an "interactions" message; until then controls render muted.
  // Types: reaction (👍/👎, or a values attr), rating (1..max stars), choice
  // (values enum), toggle (bool), button (fire-and-forget). Authors may
  // instead supply their own child elements carrying data-mg-value.
  var ctrlEnabled = false;
  var ctrlValues = {};
  var CTRL_STYLE =
    "mg-control{display:inline-flex;gap:6px;align-items:center;vertical-align:middle}" +
    "mg-control [data-mg-tap]{cursor:pointer;-webkit-user-select:none;user-select:none}" +
    "mg-control [data-mg-ui]{border:1px solid #d8d8d8;background:transparent;border-radius:999px;padding:4px 10px;font:13px/1 system-ui,sans-serif;color:inherit;opacity:.75}" +
    "mg-control [data-mg-ui]:hover{border-color:#e8870f;opacity:1}" +
    "mg-control [data-mg-ui][data-mg-sel]{background:#fdf3e3;border-color:#e8870f;color:#b8690a;opacity:1}" +
    "mg-control[data-mg-disabled] [data-mg-tap]{pointer-events:none;opacity:.45}";
  function injectCtrlStyle() {
    if (document.getElementById("__mg_ctrl_style")) return;
    var st = document.createElement("style");
    st.id = "__mg_ctrl_style";
    st.textContent = CTRL_STYLE;
    (document.head || document.documentElement).appendChild(st);
  }
  function ctrlTypeOf(el) {
    var t = (el.getAttribute("type") || "reaction").toLowerCase();
    return t === "rating" || t === "choice" || t === "toggle" || t === "button" ? t : "reaction";
  }
  function ctrlTaps(el) { return el.querySelectorAll("[data-mg-value]"); }
  function mkTap(label, value, title) {
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("data-mg-ui", "");
    b.setAttribute("data-mg-tap", "");
    b.setAttribute("data-mg-value", value);
    if (title) b.title = title;
    b.textContent = label;
    return b;
  }
  function renderCtrl(el, type) {
    var i;
    if (type === "rating") {
      var max = Math.max(1, Math.min(10, parseInt(el.getAttribute("max") || "5", 10) || 5));
      for (i = 1; i <= max; i++) el.appendChild(mkTap("★", String(i), i + " of " + max));
    } else if (type === "toggle") {
      el.appendChild(mkTap(el.getAttribute("label") || "✓", "true", ""));
    } else if (type === "button") {
      el.appendChild(mkTap(el.getAttribute("label") || "Go", el.getAttribute("value") || "pressed", ""));
    } else {
      var vals = (el.getAttribute("values") || (type === "reaction" ? "up,down" : ""))
        .split(",")
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length > 0; });
      for (i = 0; i < vals.length; i++) {
        var v = vals[i];
        var label = type === "reaction" ? (v === "up" ? "👍" : v === "down" ? "👎" : v) : v;
        el.appendChild(mkTap(label, v, v));
      }
    }
  }
  // Next value on tap: toggle flips; button always fires its value; the others
  // set — and re-tapping the selected value clears (null).
  function ctrlNext(type, cur, raw) {
    if (type === "toggle") return cur !== true;
    if (type === "button") return raw;
    if (type === "rating") { var n = parseInt(raw, 10) || 0; return cur === n ? null : n; }
    return cur === raw ? null : raw;
  }
  function paintCtrl(el, type, name) {
    var cur = ctrlValues[name];
    var has = cur !== undefined && cur !== null;
    if (has) el.setAttribute("data-mg-state", String(cur));
    else el.removeAttribute("data-mg-state");
    var taps = ctrlTaps(el);
    for (var i = 0; i < taps.length; i++) {
      var t = taps[i];
      var raw = t.getAttribute("data-mg-value");
      var sel = false;
      if (has) {
        if (type === "rating") sel = (parseInt(raw, 10) || 0) <= Number(cur);
        else if (type === "toggle") sel = cur === true;
        else sel = String(cur) === raw;
      }
      if (sel) t.setAttribute("data-mg-sel", "");
      else t.removeAttribute("data-mg-sel");
    }
  }
  function wireCtrl(el) {
    if (el.getAttribute("data-mg-wired")) return;
    el.setAttribute("data-mg-wired", "1");
    var name = el.getAttribute("name");
    var type = ctrlTypeOf(el);
    var taps = ctrlTaps(el);
    if (taps.length === 0) renderCtrl(el, type);
    else {
      // Author-supplied UI: mark the targets tappable (cursor/disabled styles).
      for (var j = 0; j < taps.length; j++) taps[j].setAttribute("data-mg-tap", "");
    }
    if (!ctrlEnabled) el.setAttribute("data-mg-disabled", "");
    el.addEventListener("click", function (e) {
      var t = e.target;
      while (t && t !== el && !(t.hasAttribute && t.hasAttribute("data-mg-value")))
        t = t.parentElement;
      if (!t || t === el || !t.hasAttribute("data-mg-value")) return;
      e.preventDefault();
      e.stopPropagation();
      if (!ctrlEnabled) return;
      var next = ctrlNext(type, ctrlValues[name], t.getAttribute("data-mg-value"));
      ctrlValues[name] = next;
      paintCtrl(el, type, name);
      send({ type: "interaction", name: name, controlType: type, value: next, anchor: anchorFor(el) });
    });
    paintCtrl(el, type, name);
  }
  function initControls() {
    var list = document.querySelectorAll("mg-control[name]");
    if (list.length === 0) return;
    injectCtrlStyle();
    for (var i = 0; i < list.length; i++) wireCtrl(list[i]);
  }
  function applyInteractions(d) {
    ctrlEnabled = !!d.enabled;
    ctrlValues = d.values && typeof d.values === "object" ? d.values : {};
    initControls(); // idempotent — wires any control added since load
    var list = document.querySelectorAll("mg-control[name]");
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (ctrlEnabled) el.removeAttribute("data-mg-disabled");
      else el.setAttribute("data-mg-disabled", "");
      paintCtrl(el, ctrlTypeOf(el), el.getAttribute("name"));
    }
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d[MG] !== 1) return;
    if (d.type === "track") { tracked = d.ids || []; reportRects(); }
    else if (d.type === "getRects") { reportRects(); }
    else if (d.type === "commentMode") { commentMode = !!d.on; setCommentModeUI(commentMode); if (commentMode) hideControls(); }
    else if (d.type === "editable") { editEnabled = !!d.on; if (!d.on) { endEdit(false); hideControls(); } }
    else if (d.type === "clearSelection") { try { window.getSelection().removeAllRanges(); } catch (err) {} lastSelKey = ""; }
    else if (d.type === "scrollTo") { var el = elFor(d.id); if (el) el.scrollIntoView({ block: "center", behavior: "smooth" }); }
    else if (d.type === "interactions") { applyInteractions(d); }
  });

  window.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  if (window.ResizeObserver) { try { new ResizeObserver(schedule).observe(document.documentElement); } catch (e) {} }

  initControls();

  // Re-emit ready a few times: if the parent hasn't hydrated its message
  // listener yet, a single ready is lost. (The parent also proactively pushes
  // config after mount — two-sided handshake, can't be missed.)
  var readyTries = 0;
  (function pingReady() {
    send({ type: "ready" });
    if (++readyTries < 5) setTimeout(pingReady, 300);
  })();
})();`;
