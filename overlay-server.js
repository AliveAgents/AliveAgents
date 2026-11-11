// overlay-server.js
// Shared local HTTP+WebSocket server that the browser overlay (the face) connects to. Every
// agent -- the hub (Oscar) AND every node (e.g. Nova) -- starts its own instance on its own
// machine, so each has its own face on the screen the respective human sits in front of.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');
const faceDesign = require('./face-design.js');

// The page the overlay is opened on. Still a black, empty stage -- the face is the point -- but it
// now also carries the file drop rail in the bottom-left corner (see stage-page.html). The rail
// hides itself when /agents is unavailable, so on a node this is exactly the blank page it always
// was. Kept as a file rather than a template literal because it grew past the size where an
// inline string stays readable.
const STAGE_FILE = 'stage-page.html';
const BLANK_STAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Agent</title>
<style>html,body{margin:0;height:100%;background:#000;}</style>
</head><body></body></html>`;

function serveStage(req, res) {
  fs.readFile(path.join(__dirname, STAGE_FILE), (err, data) => {
    // Never inside someone else's page. This page carries the buttons that accept a change to who an
    // agent is; framed invisibly by a foreign site, a click meant for that site would land on them.
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
    // Falls back to the old inline stage if the file is missing, so a half-synced machine still
    // shows a usable page for its face instead of a 404.
    res.end(err ? BLANK_STAGE : data);
  });
}

// Folder an agent can write self-generated presentation content into, via its own write access
// narrowly scoped to exactly this folder (see main-display feature) -- e.g. a small HTML page for
// something that doesn't have a ready URL yet (an email, an analysis).
// __dirname here is the project folder on WHICHEVER machine runs this file -- the hub and every
// node therefore automatically get their own, separate folder.
const CONTENT_DIR = path.join(__dirname, 'presented_content');
fs.mkdirSync(CONTENT_DIR, { recursive: true });

// Nothing serves this folder over HTTP any more: a page reaches a screen as the page itself (see
// readOwnContent and showPage). Until 2026-09-15 it was served at /content/<per-process key>/ to the
// whole WiFi, and the key in every link was all that kept it private.

// Folder holding the face definitions (SVG+CSS+mouthParams per agent, see faces/kai.js/ava.js) --
// unlike presented_content/, deliberately NEVER expose this via Edit(...) to any agent: files
// here run as real code directly inside the browser script's privileged context (WS access, mic
// control), not safely sandboxed like presented_content/ inside an iframe. Only ever populated
// via project-folder sync (scp), never by an agent itself at runtime.
const FACES_DIR = path.join(__dirname, 'faces');
fs.mkdirSync(FACES_DIR, { recursive: true });

// ownRecipe: the face this agent had drawn for itself when it was set up, as data in its config, turned
// into a face here (face-design.js). Deliberately generated rather than written into faces/ by anyone --
// see that file. Passed in per server rather than kept module-wide: two servers in one process (the face
// preview) would otherwise share one face.
// guestRecipes: the generated faces of OTHER agents, by style name (see setGuestFace below). A
// generated face exists only as a recipe on the machine it belongs to, so when that agent speaks or
// presents on this screen the recipe travels with the message and is served from here.
function serveFace(req, res, ownRecipe, guestRecipes) {
  // Access-Control-Allow-Origin is needed here, not just nice to have: the overlay script always
  // runs on a FOREIGN page via @match *://*/* (never on localhost:8787 itself), so its
  // fetch(".../faces/<name>.js") is ALWAYS a cross-origin request from the browser's point of
  // view. Without this header the browser would refuse to let the script READ the response (the
  // request itself would still go through, but res.text() would never resolve) -- dynamic face
  // loading would silently fail in every real deployment, even though a local test (same origin)
  // would never have shown that. faces/ only ever contains non-sensitive UI code anyway, no
  // reason to restrict the header to a narrower origin.
  const CORS_HEADER = { 'Access-Control-Allow-Origin': '*' };
  const requested = decodeURIComponent(req.url.split('?')[0].slice('/faces/'.length));
  if (requested === 'own.js' && ownRecipe) {
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/javascript; charset=utf-8' }, CORS_HEADER));
    res.end(faceDesign.renderFaceFile('own', ownRecipe));
    return;
  }
  const guestName = requested.endsWith('.js') ? requested.slice(0, -3) : '';
  if (guestRecipes && guestRecipes.has(guestName)) {
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/javascript; charset=utf-8' }, CORS_HEADER));
    res.end(faceDesign.renderFaceFile(guestName, guestRecipes.get(guestName)));
    return;
  }
  const filePath = path.join(FACES_DIR, path.basename(requested));
  if (!filePath.startsWith(FACES_DIR + path.sep) || path.extname(filePath).toLowerCase() !== '.js') {
    res.writeHead(403, CORS_HEADER); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, CORS_HEADER); res.end('Not found'); return; }
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/javascript; charset=utf-8' }, CORS_HEADER));
    res.end(data);
  });
}

// The shared slide engine for multi-slide presentations (see deck-runtime.js/.css). Served from
// the project root, NOT from presented_content/ -- an agent must not be able to rewrite the
// engine its own deck runs on, and presented_content/ is exactly the one folder it can write to.
//
// A deck links these as "/deck.css" and "/deck.js", which resolve against the machine SHOWING it:
// since 2026-09-15 a presentation travels to its display over the encrypted agent link and is served
// there (see showPage), so nothing is fetched across the WiFi any more. Until then they resolved to
// the machine that wrote the deck. The price is that a deck now runs on the display's copy of the
// engine, so the engine has to stay compatible with decks written against an older one.
const DECK_FILES = {
  '/deck.js': { file: 'deck-runtime.js', type: 'application/javascript; charset=utf-8' },
  '/deck.css': { file: 'deck-runtime.css', type: 'text/css; charset=utf-8' }
};

function serveDeckAsset(req, res, entry) {
  fs.readFile(path.join(__dirname, entry.file), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': entry.type });
    res.end(data);
  });
}

// The browser overlay itself, served so Tampermonkey can update itself from it (see the
// @updateURL header in the file). Before this, every change to the overlay had to be copy-pasted
// into Tampermonkey by hand on every machine -- an invisible, unverifiable step that is easy to
// do on the wrong machine or skip entirely, and a stale copy then fails in ways that look like a
// backend bug. The path has to end in .user.js or Tampermonkey treats it as a plain script.
const USERSCRIPT_FILE = 'agent-face-overlay.user.js';

function serveUserscript(req, res) {
  fs.readFile(path.join(__dirname, USERSCRIPT_FILE), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
    res.end(data);
  });
}

// This machine's address on the home network -- what a joining machine is told to dial (enrollment).
// 192.168.x.x is preferred (typical home-router range, see hubHost in net-config.json) --
// virtual adapters (WSL/Hyper-V/VPN) tend to sit in other private ranges and would otherwise
// easily get mistaken as "the" LAN address.
function getLanIp() {
  const candidates = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) candidates.push(iface.address);
    }
  }
  return candidates.find((ip) => ip.startsWith('192.168.')) || candidates[0] || '127.0.0.1';
}

// Whether a request comes from this machine at all. The HTTP server still listens on all interfaces,
// but since 2026-09-15 it answers nothing that does not come from this machine: until then other
// machines fetched presentations and the deck engine from it, and that one exception had kept every
// route -- the face state included -- open to the whole WiFi.
function isLocalRequest(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// Whether a request comes from this machine's own face page, or from a program on this machine that is
// not a browser -- rather than from some web page that merely runs in this machine's browser. The
// address alone cannot tell those apart: every page the browser shows connects from 127.0.0.1, be it a
// presentation an agent wrote, a website an agent put on screen, or any site open in another tab. A
// WebSocket has no same-origin rule, so every one of them could open this socket and type as the
// user -- proven 2026-09-15 against the running hub, where a socket claiming to be https://evil.example
// got /network answered. A browser always sends Origin on a WebSocket handshake and on a POST, and a
// page cannot make it lie. A request without one comes from a local program, which already runs on
// this machine and could do anything anyway.
function isOwnPage(req, port) {
  if (!isLocalRequest(req)) return false;
  const origin = req.headers.origin;
  return origin === undefined || [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`].includes(origin);
}

// onUserInput(text) is optional, and inputEnabled(source) says whether it is open right now, for 'voice'
// or 'typed'. The hub takes both at all times. A node takes TYPED text at any time (user's wish,
// 2026-11-11, "Text überall": typing on a phone is only possible at that phone, and what an agent may
// do is decided on its own device whichever way a sentence arrives), but opens its MICROPHONE only while
// its hub is out of reach (2026-09-22: take the phone along, leave the rest at home). Several listening
// microphones in one room hear each other's loudspeakers -- one agent reading out a mail could address
// another by name -- so while the hub is there, it stays the one microphone of the network.
// inputEnabled is checked here, on every message, not only by the page that hides the button.
// selfChat (a node) makes the page offer a chat box for this device's own agent.
// getAgents/onFileUpload are likewise hub-only: the file drop UI lists the whole network and
// routes uploads, which only the hub knows how to do. A node passes neither and the routes stay off.
// The class of a screen, as the face page reports it (screenClass in agent-face-overlay.user.js): the
// kind of device and a size range for its short and long side -- deliberately without orientation,
// so turning a phone changes nothing and nothing has to be re-announced. Only values from these lists
// survive. The class ends up described in files other agents read before they design a presentation,
// so free text arriving here would be a way to put words in their mouths. Used by this server for
// browser reports, and by the hub and every node for reports that crossed the network.
const SCREEN_KINDS = ['phone', 'tablet', 'large'];
const SCREEN_RANGES = ['under-480', '480-767', '768-1023', '1024-1439', '1440-plus'];

function normalizeScreen(s) {
  if (!s || typeof s !== 'object') return null;
  if (!SCREEN_KINDS.includes(s.kind) || !SCREEN_RANGES.includes(s.shortSide) || !SCREEN_RANGES.includes(s.longSide)) return null;
  return { kind: s.kind, shortSide: s.shortSide, longSide: s.longSide };
}

// -- Presentations travel as pages, not as links --------------------------------------------------
// Until 2026-09-15 a display fetched a deck over plain http from the machine that wrote it, with that
// agent's access key in the URL: readable by anything on the WiFi, and good for every presentation of
// that agent until it restarted. Now the presenter reads its own file and sends the page itself over
// the mTLS link, like the audio, and the display serves it to its own browser only, under a random
// link made for this one showing (showPage below). Real websites are still shown by their URL: they
// come from the internet, not from a machine on this network.
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const PAGE_NAME_RE = /^[A-Za-z0-9._-]{1,120}\.html?$/;
// How a link to an agent's own page looked before 2026-09-15. Agents' conversation histories are full
// of them, and models reproduce what they have seen, so they are still understood -- as a file name.
// Links to an agent's own page from before pages travelled with the presentation, in both forms they
// took -- /content/<name> and /content/<32-hex key>/<name> -- on an address of this network (private or
// local). Conversation histories still hold them: after the home network moved, Nova kept writing
// http://192.168.178.92:8787/content/..., which counted as a website, and every display waited on an
// address that no longer existed (2026-09-22). They mean the file name alone. The same path on a public
// site stays a website.
const LEGACY_PAGE_LINK_RE = /^https?:\/\/([^/?#]+)\/(?:presented_)?content\/(?:[0-9a-f]{32}\/)?([^/?#]+)\/?(?:[?#].*)?$/i;

function legacyPageName(str) {
  const m = LEGACY_PAGE_LINK_RE.exec(str);
  if (!m) return null;
  const host = m[1].replace(/^[^@]*@/, '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  const onThisNetwork = host === 'localhost' || host === '::1' || !host.includes('.') || host.endsWith('.local')
    || /^(127|10)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host);
  return onThisNetwork ? m[2] : null;
}

// The file name a presentation marker gives for one of the agent's own pages -- "tides.html", or an
// old-style link -- or null for anything else, a website included.
function ownPageName(marker) {
  const str = String(marker || '').trim();
  const legacy = legacyPageName(str);
  if (!legacy && /^[a-z][a-z0-9+.-]*:/i.test(str)) return null; // has a scheme: an address, not a file
  let name;
  try { name = decodeURIComponent(legacy || str); } catch (e) { return null; }
  return PAGE_NAME_RE.test(name) ? name : null;
}

// A website an agent wants on screen: an http(s) address that is not an old-style page link. Anything
// that is neither this nor a page that came along is not shown at all -- in particular, nothing that
// names another machine's page is ever fetched.
function isWebsite(marker) {
  const str = String(marker || '').trim();
  return /^https?:\/\//i.test(str) && !legacyPageName(str);
}

// The page one of THIS machine's own markers names, ready to travel: { name, html }, or null when the
// marker names no page, the file is missing, or it is too big to send.
function readOwnContent(marker) {
  const name = ownPageName(marker);
  if (!name) return null;
  try {
    const filePath = path.join(CONTENT_DIR, name);
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > PAGE_MAX_BYTES) return null;
    return { name, html: fs.readFileSync(filePath, 'utf8') };
  } catch (e) {
    return null;
  }
}

// A page that arrived over the network, checked before it is kept: a plain file name and a string of
// bounded size -- or null.
function normalizePage(page) {
  if (!page || typeof page !== 'object') return null;
  if (typeof page.name !== 'string' || !PAGE_NAME_RE.test(page.name)) return null;
  if (typeof page.html !== 'string' || Buffer.byteLength(page.html) > PAGE_MAX_BYTES) return null;
  return { name: page.name, html: page.html };
}

// A sandboxed page has no address of its own, and the browser does not let a page like that load
// anything from this machine -- /deck.js and /deck.css included. Found in the browser on 2026-09-15:
// the frame stayed black and the engine was never even requested (a sandboxed probe page's own
// iframe and fetch() to this machine had failed the same way). So the engine is written into the page
// as it is served. Anything the page loads from the web still loads normally.
function inlineDeckAssets(html) {
  const read = (file) => { try { return fs.readFileSync(path.join(__dirname, file), 'utf8'); } catch (e) { return ''; } };
  return String(html)
    .replace(/<link\b[^>]*href=["']\/deck\.css["'][^>]*>/gi, () => `<style>${read('deck-runtime.css').replace(/<\/style/gi, '<\\/style')}</style>`)
    .replace(/<script\b[^>]*src=["']\/deck\.js["'][^>]*>\s*<\/script>/gi, () => `<script>${read('deck-runtime.js').replace(/<\/script/gi, '<\\/script')}</script>`);
}

// What a log line may say about a presentation marker: the file name of an agent's page (never an old
// link's key), or a website's address as it is.
function presentationLabel(marker) {
  return ownPageName(marker) || String(marker || '');
}

// onScreenChange(screen|null) is called when the class of the screen this machine's face page is
// shown on changes -- a browser on THIS machine opened the page or closed it. With several open, the
// smallest counts: a presentation designed for it works on the larger ones too.
// getDecisions/onDecision are hub-only as well: the decisions only the user may make (see pendingIdentity
// in agent-bridge-server.js), listed for the buttons on this page, and a click on one of them.
// onPageMessage(msg, reply) receives the face page's requests that carry a reqId (permissions, passkey
// confirmations -- see permissions.js); reply(obj) answers exactly the page that asked.
// faceRecipe: this agent's own face as data (face-design.js). With one, the page may ask for /faces/own.js
// and gets a face nobody else has; without one it keeps asking for the hand-written faces in faces/.
function startOverlayServer({ port, onUserInput, inputEnabled = () => true, selfChat = false, getAgents, onFileUpload, onScreenChange, getDecisions, onDecision, onPageMessage, faceRecipe = null, log = console.log }) {
  const ownRecipe = faceRecipe ? faceDesign.cleanRecipe(faceRecipe, String(port)) : null;
  // Generated faces of other agents, kept only as long as they are needed: a handful of the last
  // speakers, dropped oldest first. Nothing here survives a restart -- the recipe comes with the
  // message that makes the face appear, so there is nothing to keep.
  const guestRecipes = new Map();
  const GUEST_KEEP = 8;
  let state = { status: 'idle', text: '', agent: '' };
  const clients = new Set();
  // Sockets that asked for the chat transcript. Deliberately opt-in rather than broadcast to
  // everyone: the face overlay parses every message it receives AS state, so a typed message sent
  // to it would look like a state with no status and no presentation -- and would tear down a
  // running presentation. Only the stage page subscribes.
  const chatClients = new Set();
  // ws -> the overlay version it announced on connect (see /clients above). A WeakMap would be
  // tidier, but Array.from(clients) needs plain lookups and the set is tiny and self-cleaning
  // (entries are deleted on close).
  const clientVersions = new Map();
  const clientScreens = new Map();
  let reportedScreen = 'null';
  // Pages this machine is showing, by the random id in their link (see showPage). Only the last few are
  // kept: enough for the face page to be reloaded in the middle of a presentation, not an archive.
  const shownPages = new Map();
  const SHOWN_KEEP = 5;
  const SHOWN_PORT_OFFSET = 100;
  function serveShown(req, res, bare) {
    const [, , id, rawName] = bare.split('/');
    let name = '';
    try { name = decodeURIComponent(rawName || ''); } catch (e) { /* stays empty, refused below */ }
    const page = shownPages.get(id);
    if (!page || page.name !== name) { res.writeHead(404); res.end('Not found'); return; }
    // Sandboxed, and without a referrer, so an image the page loads from the web does
    // not tell that server which page it is sitting in.
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': 'sandbox allow-scripts allow-popups',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'no-store'
    });
    res.end(inlineDeckAssets(page.html));
  }
  function updateScreen() {
    let smallest = null;
    for (const s of clientScreens.values()) {
      if (!smallest) { smallest = s; continue; }
      const a = SCREEN_RANGES.indexOf(s.shortSide);
      const b = SCREEN_RANGES.indexOf(smallest.shortSide);
      if (a < b || (a === b && SCREEN_RANGES.indexOf(s.longSide) < SCREEN_RANGES.indexOf(smallest.longSide))) smallest = s;
    }
    const json = JSON.stringify(smallest);
    if (json === reportedScreen) return;
    reportedScreen = json;
    if (onScreenChange) {
      try { onScreenChange(smallest); } catch (e) { log('[overlay] screen change handler failed: ' + e.message); }
    }
  }
  // Mixed into every broadcast instead of maintaining its own state property: the overlay hides
  // the mic button when this value is false (a node while its hub is reachable -- see above).
  function withMicFlag(s) {
    return Object.assign({}, s, {
      micEnabled: !!onUserInput && !!inputEnabled('voice'),
      chatHere: !!selfChat && !!onUserInput && !!inputEnabled('typed')
    });
  }

  function broadcast() {
    const payload = JSON.stringify(withMicFlag(state));
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  const server = http.createServer((req, res) => {
    // Nothing here is for another machine (see isLocalRequest). Presentations were the one exception,
    // and they now travel over the encrypted agent link instead.
    if (!isLocalRequest(req)) { res.writeHead(403); res.end('Only on this machine'); return; }
    const bare = req.url ? req.url.split('?')[0] : '';
    const deckAsset = DECK_FILES[bare];
    if (deckAsset) { serveDeckAsset(req, res, deckAsset); return; }
    if (bare.startsWith('/faces/')) { serveFace(req, res, ownRecipe, guestRecipes); return; }
    if (bare === '/' + USERSCRIPT_FILE) { serveUserscript(req, res); return; }

    // -- File drop (hub only) ------------------------------------------------------------------
    if (bare === '/agents' && getAgents) {
      if (!isOwnPage(req, port)) { res.writeHead(403); res.end("Only from this machine's own page"); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(getAgents()));
      return;
    }
    if (bare === '/upload' && onFileUpload && req.method === 'POST') {
      // Own page, not just this machine: a foreign page can POST here without the browser asking
      // anyone, and whatever lands in an inbox is read by an agent on its next turn.
      if (!isOwnPage(req, port)) { res.writeHead(403); res.end("Only from this machine's own page"); return; }
      const q = new URL(req.url, 'http://x').searchParams;
      const agent = q.get('agent');
      const name = q.get('name');
      if (!agent || !name) { res.writeHead(400); res.end('agent and name are required'); return; }
      // The body is the raw file. Deliberately not multipart: parsing that without a dependency is
      // fiddly, and one POST per file is simpler on both ends anyway.
      const parts = [];
      let total = 0;
      req.on('data', (c) => { parts.push(c); total += c.length; });
      req.on('error', () => { res.writeHead(400); res.end('upload interrupted'); });
      req.on('end', () => {
        let result;
        try {
          result = onFileUpload(agent, name, Buffer.concat(parts, total));
        } catch (e) {
          log('[files] upload failed: ' + e.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
          return;
        }
        res.writeHead(result && result.ok === false ? 409 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result || { ok: true }));
      });
      return;
    }
    // Answers "which overlay build is this machine's browser actually running" without anyone
    // having to open a dashboard or a console. A connected client that reports no version is
    // running a copy from before client-hello existed, i.e. an outdated one.
    if (bare === '/clients') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        connected: clients.size,
        versions: Array.from(clients).map((ws) => clientVersions.get(ws) || 'unknown (outdated overlay)')
      }, null, 1));
      return;
    }
    serveStage(req, res);
  });
  // The face state -- what this agent is saying right now, who is presenting, the presentation link with
  // its key -- goes to this machine's own face page and nowhere else. Until 2026-09-15 any socket could
  // watch it, from any web page in the local browser or any device on the WiFi, because a second screen
  // showing the face seemed harmless; in fact it was a running transcript of everything the agent said,
  // key included. Refused at the handshake, so a stranger receives nothing at all.
  const wss = new WebSocketServer({ server, verifyClient: ({ req }) => isOwnPage(req, port) });

  wss.on('connection', (ws) => {
    // Only the own face page (or a local program) gets this far -- see verifyClient above -- so every
    // socket may watch, type, follow the chat and answer decisions.
    clients.add(ws);
    ws.send(JSON.stringify(withMicFlag(state)));
    ws.on('close', () => {
      clients.delete(ws); clientVersions.delete(ws); chatClients.delete(ws);
      if (clientScreens.delete(ws)) updateScreen();
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'client-hello' && typeof msg.version === 'string') {
          clientVersions.set(ws, msg.version.slice(0, 60));
          log(`[overlay] browser connected, overlay version ${clientVersions.get(ws)}`);
          const screen = normalizeScreen(msg.screen);
          if (screen) { clientScreens.set(ws, screen); updateScreen(); }
        }
        if (msg.type === 'speech-ended') {
          // Only relevant for the browser-speech-synthesis fallback (without Piper audio).
          state = { status: 'idle', text: '', agent: state.agent };
          broadcast();
        }
        if (msg.type === 'subscribe-chat') {
          chatClients.add(ws);
          if (getDecisions) ws.send(JSON.stringify({ type: 'decisions', list: getDecisions() }));
        }
        // The optional agent name comes from the stage page's chat box; the microphone never sets it, so
        // spoken input keeps going through normal routing untouched -- and that same difference tells the
        // hub, and a node, whether the text was typed or spoken. The two are opened separately.
        const typed = typeof msg.agent === 'string';
        if (msg.type === 'user-input' && onUserInput && inputEnabled(typed ? 'typed' : 'voice') && typeof msg.text === 'string' && msg.text.trim()) {
          onUserInput(msg.text.trim(), typed ? msg.agent : null, typed ? 'typed' : 'voice');
        }
        // Answers exactly the page that asked, when it gave a reqId to match the answer with.
        const hasReqId = typeof msg.reqId === 'string' && msg.reqId.length <= 40;
        const reply = (answer) => {
          if (hasReqId && ws.readyState === ws.OPEN) ws.send(JSON.stringify(Object.assign({}, answer, { type: 'page-reply', reqId: msg.reqId })));
        };
        // These handlers are asynchronous; a failure inside one must reach the page as an answer, not end
        // the whole program as an unhandled rejection.
        const guarded = (run) => Promise.resolve().then(run).catch((e) => {
          log(`[overlay] A request from the face page failed: ${e && e.message}`);
          reply({ error: 'Something went wrong on this device. Nothing changed.' });
        });
        if (msg.type === 'decide' && onDecision && typeof msg.id === 'string' && typeof msg.accept === 'boolean') {
          guarded(() => onDecision(msg.id, msg.accept, reply));
        } else if (onPageMessage && hasReqId) {
          guarded(() => onPageMessage(msg, reply));
        }
      } catch (e) {
        // ignore invalid message
      }
    });
  });

  // Without this handler the whole process crashes uncontrollably if the port is already in use
  // (e.g. if start.bat AND start-node.bat accidentally get run on the same machine) -- before
  // this fix that just looked like "the connection drops" with no discernible reason.
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log(`[overlay] ERROR: port ${port} is already in use (maybe start.bat or a second instance is also running here?). Face server could not start.`);
    } else {
      log('[overlay] Server error: ' + err.message);
    }
  });

  server.listen(port, () => log(`[overlay] Face server ready: http://localhost:${port}/`));

  // Presentation pages are served from a port of their own, bound to this machine only. For the browser
  // a page there is a different site than the face page on `port`, so even if the sandbox header were
  // ever lost it would still not count as the face page, and isOwnPage would refuse it. Until
  // 2026-09-15 a deck came from the presenter's WiFi address and was foreign by nature; receiving it
  // over the agent link instead must not make it trusted by accident. Nothing else is served here.
  const shownPort = port + SHOWN_PORT_OFFSET;
  const shownServer = http.createServer((req, res) => {
    const bare = req.url ? req.url.split('?')[0] : '';
    if (req.method === 'GET' && bare.startsWith('/shown/')) { serveShown(req, res, bare); return; }
    res.writeHead(404); res.end('Not found');
  });
  shownServer.on('error', (err) => log(`[overlay] ERROR: presentation port ${shownPort} could not be opened (${err.code || err.message}) -- presentations will not show on this machine.`));
  shownServer.listen(shownPort, '127.0.0.1');

  return {
    setState: (next) => { state = next; broadcast(); },
    getState: () => withMicFlag(state),
    // Registers the generated face of ANOTHER agent for showing on this screen and returns the
    // style name to use for it ('' when there is nothing usable). The recipe arrives over the
    // network, so it is validated here exactly like this machine's own (cleanRecipe keeps only
    // known parts and numbers in range) -- a peer picks from the catalogue, it never sends code.
    setGuestFace: (agentName, recipe) => {
      const slug = String(agentName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!slug || !recipe) return '';
      let clean;
      try { clean = faceDesign.cleanRecipe(recipe, slug); } catch (e) { log('[overlay] unusable face recipe from ' + agentName); return ''; }
      const style = 'guest-' + slug;
      guestRecipes.delete(style);  // re-inserted so the most recent speaker is the last to be dropped
      guestRecipes.set(style, clean);
      while (guestRecipes.size > GUEST_KEEP) guestRecipes.delete(guestRecipes.keys().next().value);
      return style;
    },
    // One transcript line for the chat panel. Sent ONLY to sockets that subscribed, so the face
    // overlay never receives a message it would misread as state.
    pushChat: (entry) => {
      const payload = JSON.stringify(Object.assign({ type: 'chat', at: Date.now() }, entry));
      for (const ws of chatClients) {
        if (ws.readyState === ws.OPEN) ws.send(payload);
      }
    },
    // Keeps a page that arrived for this machine to show (or one of its own) and returns the link the
    // face page loads it from: http://127.0.0.1:<port+100>/shown/<random>/<name> -- the separate
    // presentation port, see shownServer -- made for this one showing and answered to this machine
    // only. null if the page does not pass normalizePage.
    showPage: (page) => {
      const clean = normalizePage(page);
      if (!clean) return null;
      const id = require('crypto').randomBytes(16).toString('hex');
      shownPages.set(id, clean);
      while (shownPages.size > SHOWN_KEEP) shownPages.delete(shownPages.keys().next().value);
      return `http://127.0.0.1:${shownPort}/shown/${id}/${encodeURIComponent(clean.name)}`;
    },
    // Anything every open face page should hear at once, such as changed permissions.
    pushPage: (obj) => {
      const payload = JSON.stringify(obj);
      for (const ws of chatClients) {
        if (ws.readyState === ws.OPEN) ws.send(payload);
      }
    },
    // The current list of decisions waiting for the user, to the same subscribers as the chat.
    pushDecisions: (list) => {
      const payload = JSON.stringify({ type: 'decisions', list });
      for (const ws of chatClients) {
        if (ws.readyState === ws.OPEN) ws.send(payload);
      }
    }
  };
}

module.exports = { startOverlayServer, getLanIp, CONTENT_DIR, FACES_DIR, normalizeScreen, readOwnContent, normalizePage, ownPageName, isWebsite, presentationLabel };
