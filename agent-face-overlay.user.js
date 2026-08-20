// ==UserScript==
// @name         Agent Face Overlay
// @namespace    agent-network
// @version      1.0
// @description  Shared shell for all agent faces -- automatically loads its own face
//               (faces/<name>.js from its own local overlay-server.js) on start and briefly
//               switches to the face of ANOTHER agent when that agent is presenting here
//               (main-display feature). Replaces the earlier separate Kai/Ava scripts (see
//               legacy/) -- now just ONE file, regardless of which agent runs on this machine.
// @match        *://*/*
// @noframes
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const WS_URL = 'ws://localhost:8787';
  // Deliberately hardcoded just like WS_URL, NOT derived from location: this script runs via
  // @match *://*/* on ARBITRARY pages, so location.origin would be whatever foreign page is
  // currently open, not this script's own overlay server (same reasoning that has always kept
  // WS_URL hardcoded, here just spelled out explicitly for face loading too for the first time).
  const FACES_BASE_URL = 'http://localhost:8787';
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

  function mount() {
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

  let mountedFaceName = null; // which face is CURRENTLY actually sitting in the DOM (null = fallback/nothing)
  let desiredFaceName = null; // requested by the last applyState call -- set SYNCHRONOUSLY, serves
  // the async load below as an "is my result even still current" check.

  async function mountFace(name) {
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
    faceStyleEl.textContent = def.css;
    if (typeof def.init === 'function') def.init(box);
    buildMouth(box, def.mouthParams);
    mountedFaceName = mountedAs;
  }

  // Triggered from applyState "fire-and-forget" (not awaited), so name/status/bubble/mic keep
  // updating synchronously right away, while the (async) face loading catches up in the
  // background -- a brief, harmless lag on the very first load or a switch, clearly better than
  // the previous PERMANENT wrong state (wrong face forever).
  function requestFace(name) {
    desiredFaceName = name;
    if (name === mountedFaceName) return; // already the right one mounted -- no re-fetch/
    // rebuild, otherwise applyState firing frequently (several times per conversation turn) would
    // keep re-rolling the once-randomly-rolled mouth timing values, visibly "jittering".
    mountFace(name);
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
  function connect() {
    socket = new WebSocket(WS_URL);
    socket.onmessage = (ev) => {
      try { applyState(JSON.parse(ev.data)); } catch (e) { /* ignore */ }
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
    // The microphone button only belongs to Oscar (the hub) -- a node like Nova doesn't get
    // micEnabled:true from the server and therefore never shows the button at all.
    micBtn.style.display = state.micEnabled === false ? 'none' : '';
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
      if (presentationFrame.src !== state.presentation.url) presentationFrame.src = state.presentation.url;
      presentationFrame.style.display = '';
    } else if (presentationFrame.style.display !== 'none') {
      presentationFrame.style.display = 'none';
      presentationFrame.src = 'about:blank'; // actually stop the content (could have its own audio/video), not just hide it
    }

    // Own face completely invisible while the reply is running on an ANOTHER screen (main-display
    // feature) -- unlike "presenting" above (which is about THIS screen as the display surface),
    // this here is about THIS screen as the one whose agent is currently speaking elsewhere.
    box.classList.toggle('own-hidden', !!state.ownDisplayHidden);

    // During someone else's presentation, the face shown here should be that of the ACTUAL
    // presenter, not this screen's own -- otherwise it would look like, say, Nova is speaking,
    // even though it's Oscar's voice/content. Fire-and-forget (see requestFace), no await needed here.
    requestFace(presenting ? state.presentation.faceStyle : state.faceStyle);

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
