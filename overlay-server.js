// overlay-server.js
// Shared local HTTP+WebSocket server that the browser overlay (the face) connects to. Every
// agent -- the hub (Oscar) AND every node (e.g. Nova) -- starts its own instance on its own
// machine, so each has its own face on the screen the respective human sits in front of.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

// A per-process secret that has to appear in every content URL. Generated fresh on every start,
// never written to disk.
//
// Why a secret and not a list of allowed addresses: presentations are fetched ACROSS machines (the
// display fetches the deck from whichever agent generated it), so this route cannot simply be
// restricted to localhost. An address allowlist was the obvious alternative and is the worse one --
// addresses change (2026-09-02: the whole network changed and every hardcoded address went stale),
// a list would need distributing to every machine, and a stale entry means presentations silently
// stop working. A secret in the path travels the same way the URL itself does: over the mutual-TLS
// link. Whoever holds the URL received it legitimately.
//
// It is not a password to guard forever -- it is a capability tied to one process lifetime. After a
// restart old URLs stop working, which is fine: presentations are ephemeral anyway.
const CONTENT_KEY = require('crypto').randomBytes(16).toString('hex');
const CONTENT_ROUTE = `/content/${CONTENT_KEY}/`;

function serveContent(req, res) {
  const bare = req.url.split('?')[0];
  // Compared at full length before anything else is done with the path. A request without the key
  // is refused outright rather than being allowed to reach the filesystem logic below.
  if (!bare.startsWith(CONTENT_ROUTE)) { res.writeHead(403); res.end('Forbidden'); return; }
  // path.basename completely discards ANY directory component -- "../../etc/passwd" becomes
  // "passwd" and thus necessarily stays inside CONTENT_DIR, no directory traversal possible. The
  // additional startsWith check afterward is deliberate defense in depth, not because
  // path.basename alone wouldn't already be sufficient.
  const requested = decodeURIComponent(bare.slice(CONTENT_ROUTE.length));
  const filePath = path.join(CONTENT_DIR, path.basename(requested));
  if (!filePath.startsWith(CONTENT_DIR + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

// Folder holding the face definitions (SVG+CSS+mouthParams per agent, see faces/kai.js/ava.js) --
// unlike presented_content/, deliberately NEVER expose this via Edit(...) to any agent: files
// here run as real code directly inside the browser script's privileged context (WS access, mic
// control), not safely sandboxed like presented_content/ inside an iframe. Only ever populated
// via project-folder sync (scp), never by an agent itself at runtime.
const FACES_DIR = path.join(__dirname, 'faces');
fs.mkdirSync(FACES_DIR, { recursive: true });

function serveFace(req, res) {
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
// A deck at /content/<file>.html links these as "/deck.css" and "/deck.js", which resolve to the
// SAME machine that generated the deck -- i.e. the presenting agent's own overlay server, not the
// main display's. That is the right one: the deck and the engine it was written against are then
// always the same vintage, even if the display machine is running an older copy of the project.
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

// For the URL an agent should write into its [PRESENTATION: ...] marker when it generated a page
// in presented_content/ itself -- MUST be the real LAN address, "localhost" would be unreachable
// from the main-display machine (an ENTIRELY DIFFERENT physical device).
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

// Only the machine a human actually stands at may hand files to agents. The HTTP server listens on
// all interfaces (it has to -- other machines fetch /content/ and /deck.js from it), so without
// this check anyone on the WiFi could push files into any agent's inbox. Everything else served
// here is either public by nature or already reachable, but an upload writes to disk on a machine
// the sender does not own.
function isLocalRequest(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// onUserInput(text) is DELIBERATELY optional: only the hub (Oscar) passes the browser's
// microphone through to task dispatch. A node omits this callback so that ONLY Oscar
// distributes tasks by voice -- not every node independently.
// getAgents/onFileUpload are likewise hub-only: the file drop UI lists the whole network and
// routes uploads, which only the hub knows how to do. A node passes neither and the routes stay off.
function startOverlayServer({ port, onUserInput, getAgents, onFileUpload, log = console.log }) {
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
  // Mixed into every broadcast instead of maintaining its own state property: the overlay hides
  // the mic button when this value is false (i.e. for every node that didn't get an onUserInput
  // callback -- see comment above).
  function withMicFlag(s) {
    return Object.assign({}, s, { micEnabled: !!onUserInput });
  }

  function broadcast() {
    const payload = JSON.stringify(withMicFlag(state));
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  const server = http.createServer((req, res) => {
    if (req.url && req.url.startsWith('/content/')) { serveContent(req, res); return; }
    if (req.url && req.url.startsWith('/faces/')) { serveFace(req, res); return; }
    const bare = req.url ? req.url.split('?')[0] : '';
    const deckAsset = DECK_FILES[bare];
    if (deckAsset) { serveDeckAsset(req, res, deckAsset); return; }
    if (bare === '/' + USERSCRIPT_FILE) { serveUserscript(req, res); return; }

    // -- File drop (hub only) ------------------------------------------------------------------
    if (bare === '/agents' && getAgents) {
      if (!isLocalRequest(req)) { res.writeHead(403); res.end('Only from this machine'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(getAgents()));
      return;
    }
    if (bare === '/upload' && onFileUpload && req.method === 'POST') {
      if (!isLocalRequest(req)) { res.writeHead(403); res.end('Only from this machine'); return; }
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
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    // Whether this socket may do more than watch the face. The HTTP server has to listen on all
    // interfaces (other machines fetch /content/ and /deck.js from it), which means anyone on the
    // WiFi can open this WebSocket -- and until 2026-09-02 that was enough to send "user-input"
    // and command the agents, or to subscribe to the whole chat transcript. Both are now limited
    // to the machine the human is actually sitting at. Watching the face stays open, since that is
    // what a second screen legitimately does.
    const privileged = isLocalRequest(req);
    clients.add(ws);
    ws.send(JSON.stringify(withMicFlag(state)));
    ws.on('close', () => { clients.delete(ws); clientVersions.delete(ws); chatClients.delete(ws); });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'client-hello' && typeof msg.version === 'string') {
          clientVersions.set(ws, msg.version.slice(0, 60));
          log(`[overlay] browser connected, overlay version ${clientVersions.get(ws)}`);
        }
        if (msg.type === 'speech-ended') {
          // Only relevant for the browser-speech-synthesis fallback (without Piper audio).
          state = { status: 'idle', text: '', agent: state.agent };
          broadcast();
        }
        if (msg.type === 'subscribe-chat' && privileged) { chatClients.add(ws); }
        if (msg.type === 'user-input' && privileged && onUserInput && typeof msg.text === 'string' && msg.text.trim()) {
          // The optional agent name comes from the stage page's per-agent chat box; the microphone
          // never sets it, so spoken input keeps going through normal routing untouched.
          onUserInput(msg.text.trim(), typeof msg.agent === 'string' ? msg.agent : null);
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

  return {
    setState: (next) => { state = next; broadcast(); },
    getState: () => withMicFlag(state),
    // One transcript line for the chat panel. Sent ONLY to sockets that subscribed, so the face
    // overlay never receives a message it would misread as state.
    pushChat: (entry) => {
      const payload = JSON.stringify(Object.assign({ type: 'chat', at: Date.now() }, entry));
      for (const ws of chatClients) {
        if (ws.readyState === ws.OPEN) ws.send(payload);
      }
    }
  };
}

// contentUrlPrefix(baseUrl) builds the prefix an agent is told to publish under, key included --
// so the key lives in exactly one place and callers cannot accidentally build a URL without it.
function contentUrlPrefix(baseUrl) {
  return `${baseUrl}/content/${CONTENT_KEY}`;
}

// Repairs a presentation URL an agent produced for a file of OUR OWN, no matter what host, port or
// key it wrote. Found live 2026-09-02: after the network changed, Oscar published a freshly written
// deck under the PREVIOUS network's address and without the access key -- not from the instruction
// it was given, but reproduced from its own conversation history, which contains dozens of turns
// carrying the old base URL. Telling the model "use the base exactly as given" is not enough,
// because the wrong pattern is the more familiar one.
//
// A cheap, reliable signal exists, so this is decided mechanically rather than left to the model
// (the convention this project already follows for routing): if the URL names a file that actually
// sits in this machine's presented_content/, it is ours and gets rebuilt from the current base.
// Anything else -- a real external page the agent wants to show -- is returned untouched.
function localizeContentUrl(url, baseUrl) {
  const str = String(url || '');
  const marker = str.indexOf('/content/');
  if (marker < 0) return str;
  let name;
  try {
    name = path.basename(decodeURIComponent(str.slice(marker).split('?')[0]));
  } catch (e) { return str; }
  if (!name) return str;
  const onDisk = path.join(CONTENT_DIR, name);
  if (!onDisk.startsWith(CONTENT_DIR + path.sep) || !fs.existsSync(onDisk)) return str;
  return `${contentUrlPrefix(baseUrl)}/${name}`;
}

module.exports = { startOverlayServer, getLanIp, CONTENT_DIR, FACES_DIR, contentUrlPrefix, localizeContentUrl };
