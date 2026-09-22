// The hub's own record of who every machine on the network is: the name it is spoken to by and what
// it is responsible for, keyed by the machine's certificate name ("toby", "node2").
//
// Until 2026-09-15 a node told the hub both in its hello, and the hub believed it. The certificate
// proves WHICH machine is talking, but name and responsibility were free text from that machine:
// it could call itself "Nova", or write instructions into its responsibility, and that text went
// straight into every other agent's agents.md and into the routing prompt. Now the hub decides. A
// record is written when a machine is enrolled -- the user asked for that agent and typed the
// pairing code on it -- and changed only by the user: with /agent at the hub's console or in its
// local chat page, or by accepting an agent's own request with the buttons on that page. What a
// machine or an agent says about itself is at most a proposal the user can accept.
//
// Stored under "agents" in the hub's net-config.json, next to "peers": both are the hub's list of
// machines it trusts, one saying that they may connect, the other who they are.

const fs = require('fs');

// A letter first, so a name never looks like a number, a path or a marker. Spaces are allowed
// ("Ada Lovelace"). Stays inside what agent-home.js's safeAgentName accepts, so a recorded name is
// never replaced by "another agent" in display.md.
const NAME_RE = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/;
const DOMAIN_MAX = 200;
// The reason an agent gives when it asks for a change to its own entry. Shown only to the user.
const REASON_MAX = 300;

function cleanName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  return NAME_RE.test(name) ? name : null;
}

// Control characters and the two Unicode line separators, by code point. Deliberately not a regex
// literal with escapes: written that way, U+2028 once turned into a real line separator in this
// source file and ended the regex mid-way.
function isBreakingChar(ch) {
  const code = ch.codePointAt(0);
  return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029;
}

// One line of plain text of at most max characters, or null. Line breaks and control characters are
// what would let a responsibility break out of its table row in agents.md, so they become spaces
// rather than failing a pasted sentence over a stray newline. Too long is refused, not cut: half a
// sentence can say something the user never meant.
function cleanText(raw, max) {
  if (typeof raw !== 'string') return null;
  const text = Array.from(raw, (ch) => (isBreakingChar(ch) ? ' ' : ch)).join('').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : null;
}

function cleanDomain(raw) {
  return cleanText(raw, DOMAIN_MAX);
}

// Tolerates a byte order mark, like readJsonFile in the hub: Notepad and PowerShell 5.1 write one.
function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function createRegistry(file, log = console.log) {
  const records = new Map(); // nodeName -> { name, domain }

  function nodeWithName(name, exceptNode = null) {
    const wanted = String(name || '').toLowerCase();
    for (const [nodeName, record] of records) {
      if (nodeName !== exceptNode && record.name.toLowerCase() === wanted) return nodeName;
    }
    return null;
  }

  let stored = {};
  try { stored = readJson(file).agents || {}; } catch (e) { /* no file yet, or the hub reports the broken JSON itself */ }
  for (const [nodeName, entry] of Object.entries(typeof stored === 'object' ? stored : {})) {
    const name = cleanName(entry && entry.name);
    const domain = cleanDomain(entry && entry.domain);
    if (!name || domain === null || nodeWithName(name)) {
      // Hand-edited into something the hub would never have written. Skipping it leaves that
      // machine exactly where a machine without a record is: connected, but waiting for the user.
      log(`[network] Ignoring the entry for "${nodeName}" in ${file}: the name is missing, invalid or already taken, or the responsibility is longer than ${DOMAIN_MAX} characters.`);
      continue;
    }
    records.set(nodeName, { name, domain });
  }

  function set(nodeName, wanted) {
    const name = cleanName(wanted.name);
    const domain = cleanDomain(wanted.domain);
    if (!name || domain === null) throw new Error(`not a valid name and responsibility: ${JSON.stringify(wanted)}`);
    // Read back from disk rather than from a copy taken at startup: persistPeer writes the same
    // file, and writing a stale copy would silently undo whatever it added in between.
    const raw = fs.existsSync(file) ? readJson(file) : {};
    raw.agents = Object.assign({}, raw.agents && typeof raw.agents === 'object' ? raw.agents : {}, { [nodeName]: { name, domain } });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
    fs.renameSync(tmp, file); // a crash mid-write must not leave the hub without its peer list
    records.set(nodeName, { name, domain });
    return { name, domain };
  }

  return {
    get: (nodeName) => (records.has(nodeName) ? Object.assign({}, records.get(nodeName)) : null),
    entries: () => Array.from(records, ([nodeName, record]) => ({ nodeName, name: record.name, domain: record.domain })),
    nodeWithName,
    set
  };
}

module.exports = { createRegistry, cleanName, cleanDomain, cleanText, DOMAIN_MAX, REASON_MAX };
