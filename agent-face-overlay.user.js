// ==UserScript==
// @name         Agent Face Overlay
// @namespace    agent-network
// @version      1.7
// @description  Shared shell for all agent faces -- automatically loads its own face
//               (faces/<name>.js from its own local overlay-server.js) on start and briefly
//               switches to the face of ANOTHER agent when that agent is presenting here
//               (main-display feature). Replaces the earlier separate Kai/Ava scripts (see
//               legacy/) -- now just ONE file, regardless of which agent runs on this machine.
// @match        *://*/*
// @noframes
// @grant        none
// @run-at       document-idle
// Served by this machine's own overlay-server.js, so Tampermonkey can pull new versions itself
// ("check for userscript updates", or automatically) instead of the file having to be pasted in
// by hand on every machine after every change. Bump @version above or the update is ignored --
// Tampermonkey only replaces an installed script with a STRICTLY higher version number.
// localhost on purpose: every machine serves its own copy, and this script only ever runs on a
// machine that has its own overlay server (same reasoning as WS_URL below).
// @updateURL    http://localhost:8787/agent-face-overlay.user.js
// @downloadURL  http://localhost:8787/agent-face-overlay.user.js
// ==/UserScript==

(function () {
  'use strict';

  // This file runs in two very different situations, and mounting twice would give you two faces
  // on top of each other -- which is exactly what happens on the agent's own stage page when
  // Tampermonkey ALSO has it installed. First one in wins; the second exits immediately.
  if (window.__agentOverlayMounted) return;
  window.__agentOverlayMounted = true;

  // Where this agent's own overlay server lives.
  //
  // As a Tampermonkey userscript this script runs via @match *://*/* on ARBITRARY pages, so
  // location would be whatever foreign page happens to be open -- hence the hardcoded fallback.
  // But when the agent's own stage page loads this file with a <script> tag, location IS the
  // right server, and the page says so by setting AGENT_SERVER_ORIGIN before loading it.
  //
  // That second path is what makes a phone practical: it runs its own agent, so the face is just
  // a URL in any browser, with no extension to install. Tampermonkey then remains only for the
  // one thing it is actually needed for -- floating the face over OTHER websites.
  const SERVER_ORIGIN = typeof window.AGENT_SERVER_ORIGIN === 'string' && window.AGENT_SERVER_ORIGIN
    ? window.AGENT_SERVER_ORIGIN
    : 'http://localhost:8787';
  const WS_URL = SERVER_ORIGIN.replace(/^http/, 'ws');
  const FACES_BASE_URL = SERVER_ORIGIN;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // -- Overlay markup: the SVG is deliberately left EMPTY -- this script only learns which face
  // to load in after the first server message (state.faceStyle), see requestFace below.
  const box = document.createElement('div');
  box.id = 'agent-face-overlay';
  box.className = 'state-idle';
  box.innerHTML = `
    <div class="agent-header"><span class="agent-dot"></span><span class="agent-name"></span><span class="agent-status"></span></div>
    <svg class="agent-svg" viewBox="0 0 260 282" xmlns="${SVG_NS}"></svg>
    <div class="agent-bubble"></div>
  `;

  // The microphone button and the presentation iframe are deliberately STANDALONE elements, not
  // part of box.innerHTML: once #agent-face-overlay gets moved/shrunk via the .presenting class
  // for the main-display feature, any position:fixed element nested inside it would otherwise no
  // longer be positioned relative to the viewport, but relative to #agent-face-overlay itself
  // (CSS: an ancestor with transform/filter/perspective becomes the containing block for fixed
  // descendants) -- so the mic button would end up moving into the corner along with it instead
  // of staying put in the bottom right. As sibling elements attached directly to
  // document.documentElement, both stay fixed-positioned independently of #agent-face-overlay's state.
  const micBtn = document.createElement('button');
  micBtn.className = 'agent-mic';
  micBtn.type = 'button';
  micBtn.title = 'Talk to the agent';
  micBtn.setAttribute('aria-label', 'Microphone');
  micBtn.textContent = '🎙';

  const presentationFrame = document.createElement('iframe');
  presentationFrame.id = 'agent-presentation-frame';
  presentationFrame.style.display = 'none';

  // -- Multi-slide presentations ---------------------------------------------------------------
  // The presenting agent advances its own deck: it speaks one segment per slide (split on
  // [SLIDE], see followup-tag.js) and the machine playing that audio raises state.presentation
  // .slide between segments. Here that turns into a postMessage into the deck (see
  // deck-runtime.js), NOT a reload -- re-pointing .src would restart the page and throw away
  // anything the deck had going (a chart it drew, a video, scroll position).
  //
  // A message can only arrive after the iframe document exists, so a slide raised while the page
  // is still loading has to be held back and flushed on 'load' -- otherwise the very common case
  // of a short first segment (deck still loading when slide 2 comes due) would silently drop the
  // first advance and leave the deck a slide behind for the rest of the presentation.
  let deckFrameReady = false;
  let pendingSlide = null;
  let shownSlide = null;

  function postSlide(index) {
    try {
      presentationFrame.contentWindow.postMessage({ type: 'agent-slide', index }, '*');
    } catch (e) {
      // Cross-origin or a frame torn down mid-flight -- a missed slide is not worth breaking
      // applyState over, the narration keeps running either way.
    }
  }

  function applySlide(rawIndex) {
    const index = Number(rawIndex) || 0;
    if (index === shownSlide) return;
    shownSlide = index;
    if (deckFrameReady) postSlide(index); else pendingSlide = index;
  }

  presentationFrame.addEventListener('load', () => {
    deckFrameReady = true;
    if (pendingSlide !== null) { postSlide(pendingSlide); pendingSlide = null; }
  });

  // Paging by hand once the agent has stopped talking. The deck brings its own keyboard handling,
  // but it only ever sees a key press after someone has clicked INTO the iframe first -- the deck
  // is cross-origin (it is served by whichever machine generated it, not by this page), so it
  // cannot take focus for itself. Until then every arrow key goes to the host page instead and
  // the deck looks broken. Forwarding from out here closes that gap: the keys work immediately,
  // without the click nobody thinks to make.
  // Only while a presentation is actually up -- otherwise this would swallow arrow keys on
  // whatever ordinary page the overlay happens to be injected into.
  document.addEventListener('keydown', (e) => {
    if (presentationFrame.style.display === 'none') return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
    let method = null;
    if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') method = 'next';
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') method = 'prev';
    if (!method) return;
    e.preventDefault();
    try { presentationFrame.contentWindow.postMessage({ method }, '*'); } catch (err) {}
  });

  // Shared stylesheet -- only what's identical across ALL faces (confirmed by diffing the former
  // Kai/Ava files: mic button, presentation iframe/.presenting, mouth-pixel animation variables,
  // shared keyframes, the thinking-dots base). Everything that actually differs between faces
  // (header, speech bubble, colors, visor-vs-eyes) lives in faces/*.js and ends up in faceStyleEl
  // further below.
  const style = document.createElement('style');
  style.textContent = `
    #agent-face-overlay{
      position:fixed; inset:0; z-index:2147483647;
      display:flex; flex-direction:column; align-items:center; justify-content:center;
      gap:16px; pointer-events:none; text-align:center;
      font-family:'Segoe UI',system-ui,sans-serif;
      transition:opacity .5s ease, color .5s ease;
    }
    #agent-face-overlay .agent-svg{
      width:min(58vw, 78vh, 680px); height:auto;
      filter:drop-shadow(0 0 34px currentColor);
      overflow:visible;
    }
    #agent-face-overlay .mouth-pixel{ fill:currentColor; transform-box:fill-box; transform-origin:center; }
    #agent-face-overlay .thinking-dots{ opacity:0; }
    #agent-face-overlay .thinking-dots circle{ fill:currentColor; }
    #agent-face-overlay.state-thinking .thinking-dots{ opacity:1; }
    #agent-face-overlay.state-thinking .thinking-dots circle{ animation:dot-bounce 1.1s ease-in-out infinite; }
    #agent-face-overlay.state-thinking .thinking-dots circle:nth-child(2){ animation-delay:.15s; }
    #agent-face-overlay.state-thinking .thinking-dots circle:nth-child(3){ animation-delay:.3s; }
    @keyframes dot-bounce{ 0%,60%,100%{ transform:translateY(0); opacity:.5; } 30%{ transform:translateY(-8px); opacity:1; } }
    @keyframes pixel-bob{ 0%,100%{ transform:translateY(0); } 50%{ transform:translateY(var(--amp,0px)); } }
    #agent-face-overlay.state-idle .mouth-pixel{
      --amp:var(--amp-idle,2px);
      animation:pixel-bob var(--dur-idle,2s) ease-in-out infinite;
      animation-delay:var(--delay-random,0s);
    }
    #agent-face-overlay.state-thinking .mouth-pixel{
      opacity:.35;
      --amp:var(--amp-think,3px);
      animation:pixel-bob var(--dur-think,.6s) ease-in-out infinite;
      animation-delay:var(--delay-index,0s);
    }
    #agent-face-overlay.state-speaking .mouth-pixel{
      --amp:var(--amp-speak,10px);
      animation:pixel-bob var(--dur-speak,.25s) ease-in-out infinite;
      animation-delay:var(--delay-random,0s);
    }
    #agent-face-overlay .agent-bubble.show{ opacity:1; transform:translateY(0); }
    /* Fixed color value, deliberately NOT currentColor/inherit: micBtn sits (because of the
       containing-block trap for .presenting, see above) as a SIBLING of #agent-face-overlay, not
       as a child -- so "inherit" would never inherit the face's color, only that of whichever
       foreign page happens to be behind it (on the black stage page: default black-on-black,
       effectively invisible). Was already broken this way in both old scripts, just never noticed. */
    .agent-mic{
      position:fixed; bottom:26px; right:26px; pointer-events:auto; z-index:2147483647;
      width:54px; height:54px; border-radius:50%; border:2px solid currentColor;
      background:rgba(10,10,14,.7); color:#e5e5e5; font-size:22px; line-height:1;
      cursor:pointer; display:flex; align-items:center; justify-content:center;
      transition:transform .15s ease, box-shadow .2s ease;
    }
    .agent-mic:hover{ transform:scale(1.07); }
    .agent-mic.listening{
      color:#4ade80; border-color:#4ade80;
      box-shadow:0 0 0 7px rgba(74,222,128,.22), 0 0 26px #4ade80;
      animation:mic-pulse 1s ease-in-out infinite;
    }
    .agent-mic.hearing{
      box-shadow:0 0 0 10px rgba(74,222,128,.4), 0 0 40px #4ade80;
    }
    @keyframes mic-pulse{ 0%,100%{ transform:scale(1); } 50%{ transform:scale(1.09); } }
    #agent-presentation-frame{
      position:fixed; inset:0; top:0; left:0; width:100vw; height:100vh;
      z-index:2147483646; border:0; margin:0; background:#000;
    }
    #agent-face-overlay.presenting{
      inset:auto; top:20px; left:20px;
      width:min(18vw, 200px);
      gap:6px;
      transition:top .5s ease, left .5s ease, width .5s ease, opacity .5s ease, color .5s ease;
    }
    #agent-face-overlay.presenting .agent-svg{ width:100%; }
    #agent-face-overlay.presenting .agent-header{ font-size:10px; letter-spacing:.12em; }
    #agent-face-overlay.presenting .agent-bubble{ display:none; }
    /* Main-display feature: own face completely invisible while the reply is running on ANOTHER
       screen -- reuses the same opacity transition as the base rule above, no new transition of
       its own needed. !important here isn't a style break, it's necessary:
       #agent-face-overlay.state-idle/thinking/speaking (in EVERY faces/*.js file) has the same
       specificity (ID + 1 class) and sits LATER in the DOM than this shared stylesheet (see
       mount()) -- without !important, whichever face rule got attached last would win on a tie
       and own-hidden would go nowhere (discovered via live testing: opacity stayed at .62 instead
       of reaching 0). own-hidden MUST override every face's CSS regardless of load order. */
    #agent-face-overlay.own-hidden{ opacity:0 !important; }
  `;

  // Per-face stylesheet -- content gets COMPLETELY REPLACED on every face change (never added
  // to): Kai and Ava (and every other face) use identical selector names (.agent-header,
  // .agent-bubble, .state-idle, ...) for their respective different rules -- if two faces were
  // present at once, plain CSS cascade order (not intent) would decide which one wins.
  const faceStyleEl = document.createElement('style');

  // Printed on every page the overlay mounts on, so "which copy of this file is Tampermonkey
  // actually running" is answerable in two seconds. An installed userscript does NOT update when
  // the file on disk changes -- it has to be pasted in by hand -- and an out-of-date copy fails in
  // ways that look like a backend bug (a deck that never advances, for instance).
  const OVERLAY_VERSION = '1.7 (own microphone while the hub is away)';

  function mount() {
    console.log(`[agent-overlay] version ${OVERLAY_VERSION} active`);
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(faceStyleEl);
    document.documentElement.appendChild(presentationFrame);
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(micBtn);
    // Deliberately NO buildMouth()/face setup here: which face gets loaded is only known after
    // the first WS message (state.faceStyle) -- see requestFace, triggered from applyState. A
    // brief (a fraction of a second, purely local) empty look on fresh load, deliberately
    // accepted instead of a permanently wrong face like before.
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);

  const svgEl = box.querySelector('.agent-svg');

  // -- Generic emergency face, baked directly into the script (not loaded separately) -- only
  // kicks in when NOTHING has been successfully loaded yet and the first load attempt fails
  // (e.g. the faces/ folder is missing, sync hasn't arrived yet). A LATER load failure (e.g. a
  // presenter's face briefly fails to load) does NOT fall back to this, it keeps the last
  // successfully mounted face instead -- see mountFace further below.
  const FALLBACK_FACE = {
    svgInner: `
      <rect class="face-shell" x="20" y="20" width="220" height="220" rx="14" fill="none" stroke="currentColor" stroke-width="4"/>
      <g class="mouth-pixels"></g>
    `,
    css: `
      #agent-face-overlay .agent-header{ font-size:13px; letter-spacing:.12em; text-transform:uppercase; }
      #agent-face-overlay .agent-dot{ width:8px; height:8px; border-radius:50%; background:currentColor; }
      #agent-face-overlay .agent-status{ opacity:.7; }
      /* Not in the layout while hidden: this is a centred flex column, and a bubble that keeps
         its text (opacity:0 alone) keeps its height and its gap, which shifts the face up by half
         of the last reply's height and never gives it back. Reported 2026-11-09: "the face keeps
         sliding further up over time" -- it was tracking how long the answers had become. */
      #agent-face-overlay .agent-bubble:not(.show){ display:none; }
      #agent-face-overlay .agent-bubble{
        font-size:15px; padding:10px 16px; border-radius:8px;
        background:rgba(10,10,14,.6); color:#eee; opacity:0; transform:translateY(6px);
        transition:opacity .25s ease, transform .25s ease;
      }
      #agent-face-overlay.state-idle{ color:#888; opacity:.6; }
      #agent-face-overlay.state-thinking{ color:#eab308; opacity:.9; }
      #agent-face-overlay.state-speaking{ color:#e5e5e5; opacity:1; }
    `,
    mouthParams: { centerX: 130, baseY: 190, depth: 8, spread: 70, rx: 2, curve: (baseY, depth, t) => baseY - depth * Math.sin(t * Math.PI) }
  };

  // -- Mouth: identical construction for EVERY face (this was already true before, byte-identical
  // code between Kai/Ava except for the curve formula) -- now shared ONCE, parameterized via
  // mouthParams instead of duplicated in every face file. curve is a real function (not a string
  // identifier): faces/*.js are trusted, locally distributed files that already run as real code anyway.
  function buildMouth(targetBox, mouthParams) {
    const g = targetBox.querySelector('.mouth-pixels');
    if (!g) return;
    g.innerHTML = ''; // discard old pixels from a previous face (safety net, svgEl.innerHTML before this already does this really)
    const { centerX, baseY, depth, spread, rx, curve } = mouthParams;
    const count = 11;
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const x = centerX - spread / 2 + t * spread;
      const y = curve(baseY, depth, t);

      const rect = document.createElementNS(SVG_NS, 'rect');
      rect.setAttribute('class', 'mouth-pixel');
      rect.setAttribute('x', x - 4);
      rect.setAttribute('y', y - 4);
      rect.setAttribute('width', 8);
      rect.setAttribute('height', 8);
      rect.setAttribute('rx', rx);

      const sign = Math.random() < 0.5 ? -1 : 1;
      const ampIdle = (1 + Math.random() * 2) * sign;
      const ampSpeak = (8 + Math.random() * 8) * sign;
      const ampThink = (i % 2 === 0 ? 1 : -1) * (3 + Math.random() * 2);
      const durIdle = (1.6 + Math.random() * 1.2).toFixed(2) + 's';
      const durSpeak = (0.15 + Math.random() * 0.2).toFixed(2) + 's';
      const delayRandom = (Math.random() * 1.5).toFixed(2) + 's';
      const delayIndex = (i * 0.05).toFixed(2) + 's';

      rect.style.setProperty('--amp-idle', ampIdle.toFixed(1) + 'px');
      rect.style.setProperty('--amp-speak', ampSpeak.toFixed(1) + 'px');
      rect.style.setProperty('--amp-think', ampThink.toFixed(1) + 'px');
      rect.style.setProperty('--dur-idle', durIdle);
      rect.style.setProperty('--dur-speak', durSpeak);
      rect.style.setProperty('--dur-think', '.6s');
      rect.style.setProperty('--delay-random', delayRandom);
      rect.style.setProperty('--delay-index', delayIndex);

      g.appendChild(rect);
    }
  }

  // -- Face loading: cache (name -> definition-or-still-running-promise), so a once-loaded face
  // never gets fetched again.
  const faceCache = {};
  function loadFace(name) {
    if (faceCache[name]) return faceCache[name];
    const promise = (async () => {
      // Only allow harmless characters before the name travels into a URL -- a cheap
      // client-side precaution; the actual directory-traversal protection sits server-side
      // (path.basename in overlay-server.js), this here only avoids unnecessary broken requests.
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('invalid face name');
      const res = await fetch(`${FACES_BASE_URL}/faces/${name}.js`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const src = await res.text();
      // faces/*.js registers itself on window.__agentFaces when executed (see those files) --
      // new Function instead of eval, functionally the same, a bit cleaner scope-wise.
      new Function(src)();
      const def = window.__agentFaces && window.__agentFaces[name];
      if (!def) throw new Error(`${name}.js did not register itself`);
      return def;
    })();
    faceCache[name] = promise;
    return promise;
  }

  // -- Per-agent tint.
  // A face definition brings its own three state colours. An agent may override them, which is
  // what lets two agents sharing a shell still be told apart from across the room -- and it is
  // also why this is NOT free-form CSS. The text below lands in a <style> element inside the
  // overlay's own privileged document, the one with WebSocket and microphone access, which is
  // exactly why faces/ is closed to agents in the first place. So three keys are read, each has
  // to be a bare #rrggbb literal, and if any of them is not, the whole tint is dropped in favour
  // of the face's own palette rather than partially applied. The hub validates this too
  // (normalizeTint in identity.js); repeating it here is the cheap half of defence in depth, and
  // the half that still holds if a message ever arrives from somewhere unexpected.
  const TINT_HEX = /^#[0-9a-fA-F]{6}$/;

  function tintCss(tint) {
    if (!tint || typeof tint !== 'object') return '';
    const { idle, thinking, speaking } = tint;
    for (const v of [idle, thinking, speaking]) {
      if (typeof v !== 'string' || !TINT_HEX.test(v)) return '';
    }
    // Appended AFTER the face's own CSS, so it wins on equal specificity without !important.
    return '#agent-face-overlay.state-idle{color:' + idle + ';}'
         + '#agent-face-overlay.state-thinking{color:' + thinking + ';}'
         + '#agent-face-overlay.state-speaking{color:' + speaking + ';}';
  }

  let mountedFaceName = null; // which face is CURRENTLY actually sitting in the DOM (null = fallback/nothing)
  let mountedTintCss = ''; // the tint applied alongside it -- part of the identity, so a change in
  // colour alone still has to re-mount even when the shell stays the same.
  let desiredFaceName = null; // requested by the last applyState call -- set SYNCHRONOUSLY, serves
  // the async load below as an "is my result even still current" check.

  async function mountFace(name, tint) {
    const wantTint = tintCss(tint);
    let def, mountedAs;
    if (!name) {
      def = FALLBACK_FACE;
      mountedAs = null;
    } else {
      try {
        def = await loadFace(name);
        mountedAs = name;
      } catch (e) {
        console.error('[agent-face] Could not load face "' + name + '":', e.message);
        if (mountedFaceName !== null) return; // ALREADY something real mounted -- stick with it
        // instead of jumping back to the generic emergency face over a single later error.
        def = FALLBACK_FACE;
        mountedAs = null;
      }
    }
    // Between the start of this load and here, a NEWER call may meanwhile have requested a
    // DIFFERENT target face (e.g. a presentation started and ended in quick succession) --
    // without this check, two overlapping loads could arrive in the wrong order and leave the
    // wrong face mounted at the end.
    if (desiredFaceName !== name) return;
    svgEl.innerHTML = def.svgInner;
    faceStyleEl.textContent = def.css + wantTint;
    if (typeof def.init === 'function') def.init(box);
    buildMouth(box, def.mouthParams);
    mountedFaceName = mountedAs;
    mountedTintCss = wantTint;
  }

  // Triggered from applyState "fire-and-forget" (not awaited), so name/status/bubble/mic keep
  // updating synchronously right away, while the (async) face loading catches up in the
  // background -- a brief, harmless lag on the very first load or a switch, clearly better than
  // the previous PERMANENT wrong state (wrong face forever).
  function requestFace(name, tint) {
    desiredFaceName = name;
    // The tint counts towards "is the right thing already mounted": without it, an agent taking
    // over the screen with the same shell but its own colours would keep the previous agent's.
    if (name === mountedFaceName && tintCss(tint) === mountedTintCss) return; // no re-fetch/
    // rebuild, otherwise applyState firing frequently (several times per conversation turn) would
    // keep re-rolling the once-randomly-rolled mouth timing values, visibly "jittering".
    mountFace(name, tint);
  }

  const nameEl = box.querySelector('.agent-name');
  const statusEl = box.querySelector('.agent-status');
  const bubble = box.querySelector('.agent-bubble');
  // micBtn was already declared above (at its creation) -- no querySelector needed, the button is
  // no longer part of box.innerHTML.

  const STATUS_LABELS = { idle: 'ready', thinking: 'thinking', speaking: 'speaking' };

  // -- Voices: prefers higher-quality online/natural voices if the browser has any (fallback for when Piper isn't available) --
  let voices = [];
  function loadVoices() { voices = speechSynthesis.getVoices(); }
  loadVoices();
  if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = loadVoices;

  function pickVoice() {
    return voices.find(v => /online|natural|neural/i.test(v.name))
        || voices.find(v => v.lang.startsWith('en'))
        || voices[0];
  }

  // -- WebSocket connection to the bridge server --
  let socket;
  // The screen this page is shown on, reduced to a CLASS before anything leaves the browser (user's
  // decision, 2026-09-15). Exact viewport numbers -- 412 x 915 at a pixel ratio of 2.625, say -- pin
  // a device down to a handful of phone models, a well-known fingerprinting signal, and a presenter
  // needs none of that: the kind of device and a rough size of its short and long side are enough to
  // design for. Fitting the last pixel is deck-runtime.js's job, done inside the slide frame with the
  // real numbers, which never travel.
  //
  // Deliberately no orientation, and no reporting on resize: turning a phone would otherwise send a
  // message and rewrite display.md on every agent in the network, for something the deck handles on
  // the device itself. So the class is sent once per connection, in the hello, and nothing more.
  // Only values from these fixed lists are sent; the server discards anything else anyway.
  function screenClass() {
    const shortSide = Math.min(window.innerWidth, window.innerHeight);
    const longSide = Math.max(window.innerWidth, window.innerHeight);
    const range = (v) => (v < 480 ? 'under-480' : v < 768 ? '480-767' : v < 1024 ? '768-1023' : v < 1440 ? '1024-1439' : '1440-plus');
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    const kind = shortSide < 600 ? 'phone' : (coarse && shortSide < 1024 ? 'tablet' : 'large');
    return { kind, shortSide: range(shortSide), longSide: range(longSide) };
  }

  function connect() {
    socket = new WebSocket(WS_URL);
    // Announces which build of this file the browser is actually running, so the machine can be
    // asked (http://localhost:8787/clients) instead of someone having to open Tampermonkey and
    // read a version number off a dashboard. A client that reports nothing is an OUTDATED copy --
    // that is the whole point: an installed userscript does not update when the file on disk
    // changes, and a stale one fails silently in ways that look like a backend fault (a deck that
    // never advances, most of a day spent looking in the wrong place, 2026-08-25).
    socket.onopen = () => {
      try { socket.send(JSON.stringify({ type: 'client-hello', version: OVERLAY_VERSION, screen: screenClass() })); } catch (e) {}
    };
    socket.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        // Face state has no "type"; typed messages (the stage page's chat stream) are addressed to
        // other subscribers. Without this guard one of those would be read as a state with no
        // status and no presentation -- and would tear down a running presentation mid-sentence.
        if (msg && msg.type) return;
        applyState(msg);
      } catch (e) { /* ignore */ }
    };
    socket.onclose = () => setTimeout(connect, 2000);
    socket.onerror = () => {};
  }
  connect();

  // -- Speech input: always-on listening, only reacts when the agent's name is said (or right
  // after a reply, where it may keep talking for a while without a name too). Pauses while the
  // agent itself is speaking, so it doesn't hear itself over the speakers.
  const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;
  let alwaysListening = false;
  let pausedForSpeaking = false;
  let activeConversationUntil = 0;
  let currentAgentName = '';
  let knownAgentNames = []; // Oscar + all currently connected remote agents (e.g. Nova)
  let hearingTimeout = null;
  let pendingTranscript = '';
  // Buffer for everything said since the last send -- deliberately survives even across Chrome's
  // frequent internal restarts of the recognition session (see below), so "do this and that ...
  // [pause] ... Nova" arrives as ONE coherent sentence, instead of the name-less first part
  // getting discarded before the name is even said.
  let transcriptBuffer = [];
  let lastSpeechAt = 0;
  const BUFFER_STALE_MS = 8000; // this much silence -> the old buffer counts as a finished/abandoned topic
  const FOLLOWUP_WINDOW_MS = 30000; // matched to the server-side LAST_AGENT_FALLBACK_MS
  // Prevents short word fragments misrecognized from background noise ("ok", "that's fine")
  // within the name-less follow-up window from passing as a real question -- an utterance
  // ADDRESSED by name is unaffected by this, staying short is legitimate there too (e.g. "Nova?").
  const MIN_WORDS_FOR_WINDOW_FOLLOWUP = 3;

  // Small Levenshtein distance, so mishearings from the free speech recognition (e.g. "Ava" ->
  // "AfA") still count as a name being said, instead of requiring an exact string match.
  function levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
    return dp[a.length][b.length];
  }

  function containsNameFuzzy(transcript, name) {
    if (!name) return false;
    const target = name.toLowerCase();
    const threshold = target.length <= 4 ? 1 : 2;
    const words = transcript.toLowerCase().split(/[^a-zäöüß]+/).filter(Boolean);
    return words.some(w => levenshtein(w, target) <= threshold);
  }

  // Appends a newly recognized piece of text to the running buffer and then checks the ENTIRE
  // buffer (not just the new piece) for a name being said -- so it still counts even if the name
  // only comes at the end of a multi-part sentence.
  function pushToBuffer(text) {
    if (!text) return;
    const now = Date.now();
    if (transcriptBuffer.length && now - lastSpeechAt > BUFFER_STALE_MS) {
      transcriptBuffer = []; // too long a pause -- the old remainder counts as its own, abandoned topic
    }
    transcriptBuffer.push(text);
    lastSpeechAt = now;
    evaluateBuffer();
  }

  function evaluateBuffer() {
    const combined = transcriptBuffer.join(' ').trim();
    if (!combined) return;
    // Check against ALL known names (Oscar + remote agents like Nova), not just whichever
    // one happens to currently sit in "agent" -- otherwise "Nova, ..." would never reach the
    // server, because this very wake-word check in the browser would already filter it out.
    const names = knownAgentNames.length ? knownAgentNames : [currentAgentName];
    const namedMatch = names.some(n => containsNameFuzzy(combined, n));
    const withinWindow = Date.now() < activeConversationUntil;
    const wordCount = combined.split(/\s+/).filter(Boolean).length;
    // Only let a name-less utterance through if it also looks like a genuine statement (minimum
    // word count) -- a name being said by itself, in contrast, ALWAYS counts, regardless of length.
    const addressed = namedMatch || (withinWindow && wordCount >= MIN_WORDS_FOR_WINDOW_FOLLOWUP);
    console.log('[agent-mic] buffer:', JSON.stringify(combined), '| knownAgentNames:', JSON.stringify(names), '| wordCount:', wordCount, '| namedMatch:', namedMatch, '| withinWindow:', withinWindow, '| addressed:', addressed, '| socketOpen:', !!(socket && socket.readyState === WebSocket.OPEN));
    if (addressed && socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'user-input', text: combined }));
      activeConversationUntil = Date.now() + FOLLOWUP_WINDOW_MS;
      transcriptBuffer = []; // sent -- clear the buffer for the next topic
    }
  }

  function startListening() {
    if (!SpeechRecognitionImpl) {
      bubble.textContent = 'This browser does not support speech recognition.';
      bubble.classList.add('show');
      setTimeout(() => bubble.classList.remove('show'), 3000);
      return;
    }
    pendingTranscript = '';
    recognizer = new SpeechRecognitionImpl();
    recognizer.lang = 'en-US';
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.onstart = () => micBtn.classList.add('listening');
    recognizer.onresult = (ev) => {
      micBtn.classList.add('hearing');
      clearTimeout(hearingTimeout);
      hearingTimeout = setTimeout(() => micBtn.classList.remove('hearing'), 700);

      const lastResult = ev.results[ev.results.length - 1];
      const transcript = lastResult[0].transcript.trim();
      console.log('[agent-mic] onresult:', JSON.stringify(transcript), '| isFinal:', lastResult.isFinal);
      if (lastResult.isFinal) {
        pendingTranscript = '';
        pushToBuffer(transcript);
      } else {
        pendingTranscript = transcript; // safety net, in case Chrome ends the session before this
      }
    };
    recognizer.onerror = (ev) => { console.log('[agent-mic] onerror:', ev.error); };
    recognizer.onend = () => {
      console.log('[agent-mic] onend, pendingTranscript:', JSON.stringify(pendingTranscript));
      micBtn.classList.remove('hearing');
      // Chrome quite often ends "continuous" recognition without marking the last sentence as
      // final. This remainder also goes into the buffer (not sent directly) -- Chrome restarts
      // the session right away, the buffer survives across that.
      if (pendingTranscript) {
        pushToBuffer(pendingTranscript);
        pendingTranscript = '';
      }
      if (alwaysListening && !pausedForSpeaking) {
        setTimeout(() => { if (alwaysListening && !pausedForSpeaking) startListening(); }, 150);
      } else {
        micBtn.classList.remove('listening');
      }
    };
    recognizer.start();
  }

  micBtn.addEventListener('click', () => {
    alwaysListening = !alwaysListening;
    if (alwaysListening) {
      transcriptBuffer = []; // clean start, no leftover from an earlier session
      startListening();
    } else {
      micBtn.classList.remove('listening');
      recognizer && recognizer.stop();
    }
  });

  function applyState(state) {
    // The microphone button belongs to the hub, and to a node only while its hub is out of reach
    // (micEnabled from the server, see node-agent.js). When it goes, listening stops with it -- the
    // server would ignore what it heard anyway.
    micBtn.style.display = state.micEnabled === false ? 'none' : '';
    if (state.micEnabled === false && alwaysListening) {
      alwaysListening = false;
      micBtn.classList.remove('listening');
      if (recognizer) recognizer.stop();
    }
    if (Array.isArray(state.agentNames)) knownAgentNames = state.agentNames;
    // The server is now the authoritative source for "until when does a reply still count as
    // current enough for a name-less follow-up question" -- it knows the ACTUAL end of every
    // reply (including from remote agents like Nova, whose "speaking" status never arrives
    // here in the browser at all, since she speaks on her OWN screen). Only ever extend, never
    // shorten, in case a stale message happens to arrive.
    if (typeof state.followupUntil === 'number') {
      activeConversationUntil = Math.max(activeConversationUntil, state.followupUntil);
    }

    const currentStatus = state.status || 'idle';
    const wasSpeaking = box.classList.contains('state-speaking');
    box.className = 'state-' + currentStatus; // REPLACES className entirely -- everything after this MUST come after this line

    // Main-display feature: an agent is currently presenting on THIS screen (see
    // agent-bridge-server.js/node-agent.js) -- the face shrinks into the corner (.presenting
    // class), the iframe fills the rest with state.presentation.url.
    const presenting = !!(state.presentation && state.presentation.url);
    box.classList.toggle('presenting', presenting);
    if (presenting) {
      // Resolved before comparing: .src always reads back absolute, so a relative link would never
      // compare equal and the deck would reload on every state update.
      let wantedSrc;
      try { wantedSrc = new URL(state.presentation.url, SERVER_ORIGIN).href; } catch (err) { wantedSrc = 'about:blank'; }
      if (presentationFrame.src !== wantedSrc) {
        presentationFrame.src = wantedSrc;
        // A fresh document starts on its own first slide and has no listener yet -- both flags
        // have to go back to their initial state, or a leftover shownSlide from the PREVIOUS
        // presentation would make applySlide() treat the new deck's slide 0 as "already shown".
        deckFrameReady = false;
        pendingSlide = null;
        shownSlide = null;
      }
      presentationFrame.style.display = '';
      applySlide(state.presentation.slide);
    } else if (presentationFrame.style.display !== 'none') {
      presentationFrame.style.display = 'none';
      presentationFrame.src = 'about:blank'; // actually stop the content (could have its own audio/video), not just hide it
      deckFrameReady = false;
      pendingSlide = null;
      shownSlide = null;
    }

    // Own face completely invisible while the reply is running on an ANOTHER screen (main-display
    // feature) -- unlike "presenting" above (which is about THIS screen as the display surface),
    // this here is about THIS screen as the one whose agent is currently speaking elsewhere.
    box.classList.toggle('own-hidden', !!state.ownDisplayHidden);

    // During someone else's presentation, the face shown here should be that of the ACTUAL
    // presenter, not this screen's own -- otherwise it would look like, say, Nova is speaking,
    // even though it's Oscar's voice/content. Fire-and-forget (see requestFace), no await needed here.
    requestFace(
      presenting ? state.presentation.faceStyle : state.faceStyle,
      presenting ? state.presentation.faceTint : state.faceTint);

    // The name shows the presenter during a presentation, otherwise this screen's own identity as
    // usual -- currentAgentName (for the wake word) deliberately ALWAYS stays this screen's own
    // identity, never the presenter's, otherwise speech recognition here would listen for the
    // wrong name during someone else's presentation.
    nameEl.textContent = (presenting ? state.presentation.agentName : state.agent) || '';
    currentAgentName = state.agent || currentAgentName;
    statusEl.textContent = STATUS_LABELS[currentStatus] || '';
    if (currentStatus === 'speaking') {
      if (alwaysListening && recognizer) {
        pausedForSpeaking = true;
        recognizer.stop(); // mic briefly off, so the agent doesn't hear itself over the speakers
      }
      bubble.textContent = state.text;
      bubble.classList.add('show');
      // Normal case: agents speak directly on the PC via Piper (no browser audio needed).
      // Only if Piper wasn't available does the server step in with needsBrowserSpeech.
      if (state.needsBrowserSpeech) {
        speak(state.text);
      }
    } else {
      bubble.classList.remove('show');
      if (wasSpeaking && alwaysListening) {
        pausedForSpeaking = false;
        activeConversationUntil = Date.now() + FOLLOWUP_WINDOW_MS;
        startListening(); // keep listening right away, no name needed for the follow-up reply
      }
    }
  }

  function notifySpeechEnded() {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'speech-ended' }));
    }
  }

  function speak(text) {
    if (!text || !('speechSynthesis' in window)) { notifySpeechEnded(); return; }
    speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) utter.voice = v;
    utter.onend = notifySpeechEnded;
    speechSynthesis.speak(utter);
  }
})();
