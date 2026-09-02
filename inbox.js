// inbox.js
// Files a human hands to a specific agent, landing in that agent's own inbox/ folder on the
// machine where it actually runs -- so its Claude session can read them as ordinary local files.
//
// Deliberately NOT inside presented_content/: that folder is served over plain HTTP to every
// machine on the LAN (see serveContent in overlay-server.js), which is right for a slide deck and
// wrong for a photo someone handed to one agent in particular. inbox/ is never served, and the
// agent gets write access to exactly it (Edit(inbox/**)), so it can also move, rename or clean up
// what it finds there.
//
// Transfers are chunked because a single mTLS frame is capped (MAX_MSG_BYTES in agent-net.js, 8 MB)
// and a photo from a phone blows past that easily. Chunks are plain sequential messages over the
// same encrypted link -- deliberately NOT an HTTP fetch like presentations use, because those are
// meant to be displayed while these are private.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Raw bytes per chunk. Base64 inflates by ~33%, so 3 MB raw lands near 4 MB encoded -- comfortably
// under the 8 MB frame cap even with the surrounding JSON.
const CHUNK_BYTES = 3 * 1024 * 1024;

function inboxDir(root) {
  return path.join(root, 'inbox');
}

function ensureInbox(root) {
  const dir = inboxDir(root);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Strips every directory component, so a name like "../../start.bat" can only ever become
// "start.bat" inside inbox/. Names arrive from a browser and cross a network -- treated as hostile
// input even though both ends are ours.
function safeName(name) {
  // Control characters and the characters Windows forbids in a file name are dropped; spaces,
  // dashes and unicode are kept, because "Urlaub 2026 - Kreta.jpg" should still be called that.
  const base = path.basename(String(name || ''))
    .replace(/[\u0000-\u001f<>:"\/\\|?*]/g, '')
    .trim();
  // /^\.+$/ rather than just "." and "..": a name of only dots is not writable on Windows either.
  return base && !/^\.+$/.test(base) ? base : `file-${Date.now()}`;
}

// Never overwrite: two photos called IMG_1234.jpg from different phones are different photos, and
// silently replacing one would lose it.
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let candidate = path.join(dir, name);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
    n++;
  }
  return candidate;
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function listInbox(root) {
  const dir = inboxDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => !n.startsWith('.') && !n.endsWith('.part'))
    .map((n) => {
      const st = fs.statSync(path.join(dir, n));
      return st.isFile() ? { name: n, size: st.size, mtimeMs: st.mtimeMs } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
}

// The sentence an agent gets on a turn where its inbox is not empty.
//
// Rebuilt from the folder on EVERY turn rather than tracked as a pending list: if the agent moved
// or deleted something last turn, that has to be reflected, and a stale list would have it
// reasoning about files that are no longer there. Files that arrived since the previous turn are
// marked, so "what's new" stays answerable without a separate bookkeeping file.
// dirLabel: how the folder is named to the model. Defaults to the relative "inbox", which is
// correct while the agent runs in this folder -- but an agent with a workDir pointing at a real
// project would resolve that against the project and look in the wrong place, so the caller passes
// an absolute path in that case.
function buildInboxLine(files, newNames, dirLabel = 'inbox') {
  if (!files.length) return '';
  const parts = files.map((f) => {
    const isNew = newNames && newNames.has(f.name);
    return `${f.name} (${humanSize(f.size)})${isNew ? ' [NEW]' : ''}`;
  });
  const anyNew = files.some((f) => newNames && newNames.has(f.name));
  return `Files in your ${dirLabel}/ folder: ${parts.join(', ')}. ${anyNew ? 'The ones marked [NEW] arrived since your last reply. ' : ''}Read whichever are relevant to what was just asked and answer based on them. You may also move, rename or delete files in ${dirLabel}/ if that is what was asked -- it is yours to work in.`;
}

// -- Sending (hub side) ------------------------------------------------------------------------

// send(msg) is whatever puts one message on the wire (hub.send bound to a node). Returns the
// transfer id. Throws if send() throws, so the caller can report a failure to the browser.
function sendFile(send, { name, buffer, agentName }) {
  const transferId = crypto.randomBytes(8).toString('hex');
  const total = Math.ceil(buffer.length / CHUNK_BYTES) || 1;
  send({ type: 'file-begin', transferId, name: safeName(name), size: buffer.length, total, agentName });
  for (let i = 0; i < total; i++) {
    const slice = buffer.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
    send({ type: 'file-chunk', transferId, seq: i, data: slice.toString('base64') });
  }
  send({ type: 'file-end', transferId });
  return transferId;
}

// -- Receiving (node side, and the hub for its own agent) --------------------------------------

// Writes to "<name>.part" and renames only once the last chunk has arrived, so a transfer that
// dies halfway never leaves something that looks like a complete file the agent might then read.
function createReceiver({ root, log = console.log, onComplete }) {
  const active = new Map(); // transferId -> { fd, tmpPath, finalPath, name, received, total, size }

  function abort(transferId, reason) {
    const t = active.get(transferId);
    if (!t) return;
    try { fs.closeSync(t.fd); } catch (e) {}
    try { fs.unlinkSync(t.tmpPath); } catch (e) {}
    active.delete(transferId);
    log(`[inbox] transfer of "${t.name}" aborted: ${reason}`);
  }

  return {
    begin(msg) {
      const dir = ensureInbox(root);
      const name = safeName(msg.name);
      const finalPath = uniquePath(dir, name);
      const tmpPath = finalPath + '.part';
      try {
        const fd = fs.openSync(tmpPath, 'w');
        active.set(msg.transferId, { fd, tmpPath, finalPath, name: path.basename(finalPath), received: 0, total: msg.total, size: msg.size });
      } catch (e) {
        log(`[inbox] could not start receiving "${name}": ${e.message}`);
      }
    },
    chunk(msg) {
      const t = active.get(msg.transferId);
      if (!t) return;
      try {
        fs.writeSync(t.fd, Buffer.from(msg.data, 'base64'));
        t.received++;
      } catch (e) {
        abort(msg.transferId, e.message);
      }
    },
    end(msg) {
      const t = active.get(msg.transferId);
      if (!t) return;
      if (t.received !== t.total) { abort(msg.transferId, `expected ${t.total} chunks, got ${t.received}`); return; }
      try {
        fs.closeSync(t.fd);
        fs.renameSync(t.tmpPath, t.finalPath);
        active.delete(msg.transferId);
        log(`[inbox] received "${t.name}" (${humanSize(t.size)})`);
        if (onComplete) onComplete(t.name);
      } catch (e) {
        abort(msg.transferId, e.message);
      }
    },
    // Called when the link drops -- half-written files must not survive as .part clutter.
    abortAll() {
      for (const id of Array.from(active.keys())) abort(id, 'connection lost');
    }
  };
}

module.exports = { inboxDir, ensureInbox, listInbox, buildInboxLine, sendFile, createReceiver, safeName, humanSize, CHUNK_BYTES };
