// overlay-server.js
// Shared local HTTP+WebSocket server that the browser overlay (the face) connects to. Every
// agent -- the hub (Oscar) AND every node (e.g. Nova) -- starts its own instance on its own
// machine, so each has its own face on the screen the respective human sits in front of.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const BLANK_STAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Agent</title>
<style>html,body{margin:0;height:100%;background:#000;}</style>
</head><body></body></html>`;

// Folder an agent can write self-generated presentation content into, via its own write access
// narrowly scoped to exactly this folder (see main-display feature) -- e.g. a small HTML page for
// something that doesn't have a ready URL yet (an email, an analysis).
// __dirname here is the project folder on WHICHEVER machine runs this file -- the hub and every
// node therefore automatically get their own, separate folder.
const CONTENT_DIR = path.join(__dirname, 'presented_content');
fs.mkdirSync(CONTENT_DIR, { recursive: true });

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };

function serveContent(req, res) {
  // path.basename completely discards ANY directory component -- "../../etc/passwd" becomes
  // "passwd" and thus necessarily stays inside CONTENT_DIR, no directory traversal possible. The
  // additional startsWith check afterward is deliberate defense in depth, not because
  // path.basename alone wouldn't already be sufficient.
  const requested = decodeURIComponent(req.url.split('?')[0].slice('/content/'.length));
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

// onUserInput(text) is DELIBERATELY optional: only the hub (Oscar) passes the browser's
// microphone through to task dispatch. A node omits this callback so that ONLY Oscar
// distributes tasks by voice -- not every node independently.
function startOverlayServer({ port, onUserInput, log = console.log }) {
  let state = { status: 'idle', text: '', agent: '' };
  const clients = new Set();
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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(BLANK_STAGE);
  });
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify(withMicFlag(state)));
    ws.on('close', () => clients.delete(ws));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'speech-ended') {
          // Only relevant for the browser-speech-synthesis fallback (without Piper audio).
          state = { status: 'idle', text: '', agent: state.agent };
          broadcast();
        }
        if (msg.type === 'user-input' && onUserInput && typeof msg.text === 'string' && msg.text.trim()) {
          onUserInput(msg.text.trim());
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
    getState: () => withMicFlag(state)
  };
}

module.exports = { startOverlayServer, getLanIp, CONTENT_DIR, FACES_DIR };
