// deck-runtime.js
// Slide engine for multi-slide presentations. Served by every machine's own overlay server at
// /deck.js (see overlay-server.js); a generated deck in presented_content/ only has to link
// /deck.css and this file and write plain <section> elements -- see the "presentation" skill.
//
// Runs inside the presentation iframe on the main-display machine, NOT in the overlay's own
// privileged context (unlike faces/*.js -- see the warning in overlay-server.js). It therefore
// has no access to the WebSocket, the microphone, or anything else the overlay script can reach;
// the only channel in is the postMessage handler at the bottom, which can do exactly one thing:
// change which slide is visible.
//
// Written as a plain classic script (no modules, no build step) so a deck file works when opened
// straight off disk too, which is how you debug one without a whole network running.

(function () {
  'use strict';

  var slides = [];
  var current = 0;
  var bar = null;
  var counter = null;
  var prevBtn = null;
  var nextBtn = null;

  function collectSlides() {
    // Three accepted shapes, most explicit first: an agent that wrote .deck-slide classes, the
    // documented <div class="deck"><section> structure, or just bare <section> elements. The last
    // one is the forgiving case -- a model that skipped the wrapper still gets a working deck
    // instead of a blank screen, which matters because the markup is generated mid-conversation
    // and never reviewed by anyone before it goes on screen.
    var found = document.querySelectorAll('.deck-slide');
    if (!found.length) found = document.querySelectorAll('.deck > section');
    if (!found.length) found = document.querySelectorAll('section');
    return Array.prototype.slice.call(found);
  }

  function buildChrome() {
    var progress = document.createElement('div');
    progress.className = 'deck-progress';
    bar = document.createElement('div');
    bar.className = 'deck-progress-bar';
    progress.appendChild(bar);

    counter = document.createElement('div');
    counter.className = 'deck-counter';

    var nav = document.createElement('div');
    nav.className = 'deck-nav';
    prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.setAttribute('aria-label', 'Previous slide');
    prevBtn.textContent = '←';
    nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.setAttribute('aria-label', 'Next slide');
    nextBtn.textContent = '→';
    prevBtn.addEventListener('click', function () { go(current - 1); });
    nextBtn.addEventListener('click', function () { go(current + 1); });
    nav.appendChild(prevBtn);
    nav.appendChild(nextBtn);

    document.body.appendChild(progress);
    document.body.appendChild(counter);
    document.body.appendChild(nav);
  }

  function go(index) {
    if (!slides.length) return;
    // Clamped rather than wrapped: an agent that miscounts its own [SLIDE] markers and asks for
    // slide 7 of 5 should land on the last slide and stay there, not silently loop back to the
    // title while it is still talking about the conclusion.
    var target = Math.max(0, Math.min(slides.length - 1, index));
    current = target;
    for (var i = 0; i < slides.length; i++) {
      slides[i].classList.toggle('deck-active', i === target);
    }
    if (bar) bar.style.width = slides.length > 1 ? (target / (slides.length - 1)) * 100 + '%' : '100%';
    if (counter) counter.textContent = (target + 1) + ' / ' + slides.length;
    if (prevBtn) prevBtn.disabled = target === 0;
    if (nextBtn) nextBtn.disabled = target === slides.length - 1;
  }

  function onKey(e) {
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ' || e.key === 'Enter') {
      go(current + 1); e.preventDefault();
    } else if (e.key === 'ArrowLeft' || e.key === 'PageUp' || e.key === 'Backspace') {
      go(current - 1); e.preventDefault();
    } else if (e.key === 'Home') {
      go(0); e.preventDefault();
    } else if (e.key === 'End') {
      go(slides.length - 1); e.preventDefault();
    }
  }

  // Touch, for the phones that can also serve as a display in this network.
  var touchStartX = null;
  function onTouchStart(e) { touchStartX = e.changedTouches[0].clientX; }
  function onTouchEnd(e) {
    if (touchStartX === null) return;
    var dx = e.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (Math.abs(dx) < 50) return; // a tap, or a stray finger -- not a swipe
    go(current + (dx < 0 ? 1 : -1));
  }

  // The one way in from outside. Two accepted shapes: this project's own
  // {type:'agent-slide', index:N} (what agent-face-overlay.user.js sends while the narration for
  // each segment plays), and reveal.js's JSON-string {method,args} convention, so a deck someone
  // hand-wrote against reveal's API still responds to the same driver.
  // Deliberately no origin check: the only reachable effect is "show a different slide of the
  // page you are already looking at", so there is nothing here worth authenticating -- and the
  // overlay legitimately posts from a foreign origin (it is injected into whatever page the
  // browser happens to be on), so pinning one would break the actual caller.
  function onMessage(e) {
    var data = e.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch (err) { return; }
    }
    if (!data || typeof data !== 'object') return;
    if (data.type === 'agent-slide' && typeof data.index === 'number') { go(data.index); return; }
    if (data.method === 'next') { go(current + 1); return; }
    if (data.method === 'prev') { go(current - 1); return; }
    if (data.method === 'slide' && data.args && typeof data.args[0] === 'number') { go(data.args[0]); }
  }

  // A phone can serve as the main display in this network, and without a viewport meta tag mobile
  // browsers lay the page out at ~980px and then scale it down -- the deck renders correctly but
  // unreadably small, which is exactly the failure you do not notice while testing on a laptop
  // (found doing precisely that). Injected here rather than left to the agent writing the deck:
  // it is a fixed piece of boilerplate with no per-deck decision in it, so requiring every
  // generated file to remember it would only add a way to get it wrong.
  function ensureViewportMeta() {
    if (document.querySelector('meta[name="viewport"]')) return;
    var meta = document.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1';
    (document.head || document.documentElement).appendChild(meta);
  }

  function init() {
    slides = collectSlides();
    if (!slides.length) return; // not a deck -- a plain single page, leave it completely alone
    ensureViewportMeta();
    for (var i = 0; i < slides.length; i++) slides[i].classList.add('deck-slide');
    buildChrome();
    go(0);
    document.addEventListener('keydown', onKey);
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('message', onMessage);
    // Without this the iframe has no focus until someone clicks it, and the arrow keys would go
    // to the host page instead -- the deck would look interactive but ignore the keyboard.
    try { window.focus(); } catch (err) {}

    // For debugging a deck by hand from the browser console.
    window.AgentDeck = { go: go, next: function () { go(current + 1); }, prev: function () { go(current - 1); }, count: slides.length };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
