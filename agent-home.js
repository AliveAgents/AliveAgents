// agent-home.js
// Every agent's own home directory, and the skills and data files that live in it.
//
// Why agents get a home at all -- measured 2026-09-14 with headless Claude Code before a line of
// this was written:
//
//   - Claude Code loads CLAUDE.md from the working directory AND from every parent directory. An
//     agent running anywhere inside this repository therefore loads the developer documentation
//     written for coding assistants: 4,487 extra tokens on every single turn for Oscar, and on
//     every routing decision the hub makes as well.
//   - --add-dir grants file access to a directory and makes the skills in its .claude/skills
//     available, but does NOT load that directory's CLAUDE.md.
//   - A skill can read a data file next to it only when that directory is the working directory
//     or an --add-dir. The same skill loaded through --plugin-dir found its file and was refused.
//
// So each agent gets ~/.aliveagents/<name>/, outside any repository. Its skills are generated
// into <home>/.claude/skills/ from agent-skills/ in this repo. An agent either works in its home,
// or -- with a workDir pointing at a real project -- gets the home passed as --add-dir. Either way
// the skills and their data files are reachable, and the repo's developer docs stay out.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Overridable, so a test or a second instance on the same machine never touches a real agent's
// home -- the same convention as AGENT_BRIDGE_PORT and friends.
const HOME_ROOT = process.env.ALIVEAGENTS_HOME || path.join(os.homedir(), '.aliveagents');
const SKILL_SOURCE = path.join(__dirname, 'agent-skills');

// Forward slashes in everything a model reads: identical on every platform, accepted by Windows.
const slash = (p) => String(p).replace(/\\/g, '/');

// A path the way Claude Code's permission rules need it -- which is not simply the absolute path.
// Inside a rule like Edit(<path>/**), a path starting with a single slash is read as relative to
// the project. On Linux and Android an absolute path therefore silently matched nothing and every
// write was refused. Measured on the phone 2026-09-14, same file, one rule each: the single-slash
// form was refused, a doubled leading slash and the ~/ form were allowed. Windows paths start with a
// drive letter and already worked unchanged, so only a leading slash is doubled. For rules only --
// prompts keep showing the ordinary path.
function permissionPath(p) {
  const s = slash(p);
  return s.startsWith('/') ? '/' + s : s;
}

function agentHome(name) {
  const safe = String(name || '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!safe) throw new Error('agentHome needs a name made of letters, digits, - or _');
  return path.join(HOME_ROOT, safe);
}

const skillsDirOf = (home) => path.join(home, '.claude', 'skills');
const rosterFile = (home) => path.join(skillsDirOf(home), 'network', 'agents.md');
const displayFile = (home) => path.join(skillsDirOf(home), 'presentation', 'display.md');
const workspaceDir = (home) => path.join(home, 'workspace');
const memoryDir = (home) => path.join(home, 'memory');

// tmp + rename, so an agent reading the roster in the middle of an update never sees half a file.
// Windows refuses the rename while another process holds the target open; a plain write is the
// right fallback there -- a torn read is unlikely and harmless, a missed update is not.
function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* never created */ }
    fs.writeFileSync(file, content);
  }
}

function copySkill(src, dst, vars) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) { copySkill(from, to, vars); continue; }
    if (!entry.name.endsWith('.md')) { fs.copyFileSync(from, to); continue; }
    // An unknown {{PLACEHOLDER}} is left standing on purpose: a missing variable should show up
    // in the skill text where someone will notice it, not quietly turn into an empty string.
    const text = fs.readFileSync(from, 'utf8')
      .replace(/\{\{([A-Z_]+)\}\}/g, (whole, key) => (vars[key] !== undefined ? String(vars[key]) : whole));
    fs.writeFileSync(to, text);
  }
}

// Rebuilt from scratch on every start. Wiping first is the point: a skill removed from the repo,
// or one this agent should not have (new-agent on a node), must not survive from an earlier run.
function prepareHome({ name, skills, vars = {} }) {
  const home = agentHome(name);
  const dir = skillsDirOf(home);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // Two folders next to the skills that belong to the agent and are NEVER wiped, unlike the skills:
  //   workspace/  its own files -- drafts, notes, generated output. The caller grants write access
  //               with an Edit rule on exactly this folder, and the workspace skill describes it.
  //   memory/     reserved for later (user's decision, 2026-09-14). Nothing reads or writes it yet;
  //               the agent gets no write access and is not told it exists. It is created now only
  //               so the layout of a home is settled before anything starts depending on it.
  fs.mkdirSync(workspaceDir(home), { recursive: true });
  fs.mkdirSync(memoryDir(home), { recursive: true });
  const memoryReadme = path.join(memoryDir(home), 'README.md');
  if (!fs.existsSync(memoryReadme)) {
    fs.writeFileSync(memoryReadme, [
      '# memory',
      '',
      'Reserved for later. Nothing reads or writes this folder yet: the agent has no write access to it and is not told it exists. It is separate from the built-in memory of Claude Code, which lives under ~/.claude/projects/.',
      ''
    ].join('\n'));
  }

  for (const skill of skills) {
    const src = path.join(SKILL_SOURCE, skill);
    if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error(`agent-skills/${skill}/SKILL.md is missing`);
    const dst = path.join(dir, skill);
    copySkill(src, dst, Object.assign({}, vars, { SKILL_DIR: slash(dst) }));
  }
  return home;
}

// Ends a sentence whose last part is a responsibility. Responsibilities are written as sentences
// ("Calendar and scheduling.") as often as not, and the second full stop after one read like a typo
// in every file and message quoting it.
function closeSentence(text) {
  const t = String(text).trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

// The roster file. Rewritten only when the list itself changes, so "last change" in it means what
// it says rather than "the last time anyone asked".
const lastRosterBody = new Map();

// selfDomain: what the agent reading this file is responsible for itself. Before it was in here,
// an agent could look up everyone's area except its own. Every name and responsibility in this
// file comes from the hub's record (agent-registry.js), set by the user -- none of it is a machine
// describing itself.
function writeRoster(home, selfName, peers, selfDomain = '') {
  const cell = (text) => String(text).replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const list = (peers || []).filter((p) => p && p.name && p.name !== selfName);
  const table = list.length
    ? ['| Name | Responsible for |', '|---|---|',
        ...list.map((p) => `| ${p.name} | ${cell(p.domain || '(not set)')} |`)
      ].join('\n')
    : 'Nobody else is online. There is no one to pass anything to right now.';
  const you = selfDomain
    ? `You are ${selfName}, responsible for: ${closeSentence(cell(selfDomain))} You are not listed below.`
    : `You are ${selfName}, so you are not listed below.`;
  const body = `${you}\n\n${table}`;
  const file = rosterFile(home);
  if (lastRosterBody.get(file) === body && fs.existsSync(file)) return false;
  lastRosterBody.set(file, body);
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  writeAtomic(file,
    `# Agents online right now\n\n${you} This file is rewritten the moment anyone joins, leaves or is renamed -- last change ${when}.\n\n${table}\n`);
  return true;
}

// Who the hub last said this agent is, { name, domain }. A node keeps it in its home so that the face
// shows the right name before the hub is reachable, and so that its next hello repeats the hub's
// record instead of the config from the day it was enrolled -- which would read, at the hub, like a
// machine claiming a different name. The caller validates what comes back; this only stores it.
const identityFile = (home) => path.join(home, 'identity.json');

function readIdentity(home) {
  try {
    const value = JSON.parse(fs.readFileSync(identityFile(home), 'utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch (e) {
    return null; // never confirmed by a hub yet
  }
}

function writeIdentity(home, identity) {
  writeAtomic(identityFile(home), JSON.stringify({ name: identity.name, domain: identity.domain }, null, 2) + '\n');
}

// What display.md says about a screen is built only from fixed phrases. The class values come from a
// browser and may have crossed the network, so anything not in these tables reads as "unknown" --
// nothing received is ever copied into text an agent reads before it designs a presentation.
const SCREEN_KIND_TEXT = { phone: 'a phone-sized screen', tablet: 'a tablet-sized screen', large: 'a large screen' };
const SCREEN_RANGE_TEXT = { 'under-480': 'under 480', '480-767': '480 to 767', '768-1023': '768 to 1023', '1024-1439': '1024 to 1439', '1440-plus': '1440 or more' };

function describeScreen(screen) {
  const kind = screen && SCREEN_KIND_TEXT[screen.kind];
  const shortSide = screen && SCREEN_RANGE_TEXT[screen.shortSide];
  const longSide = screen && SCREEN_RANGE_TEXT[screen.longSide];
  if (!kind || !shortSide || !longSide) {
    return 'Its size is unknown -- no browser is showing it right now -- so design for any size.';
  }
  return `It is ${kind}: its short side is ${shortSide} and its long side ${longSide} CSS pixels, and it may be held either way up.`;
}

// Agent names go into display.md inside a sentence. A name is checked before that rather than
// trusted, for the same reason as the screen class; one that does not look like a name is replaced
// by a neutral phrase.
const safeAgentName = (n) => (typeof n === 'string' && /^[A-Za-z0-9 _-]{1,40}$/.test(n) ? n : null);

// screen: the class of the screen a presentation would appear on right now (see screenClass in
// agent-face-overlay.user.js), or null. offlineMainDisplay: a main display that is set but cannot be
// reached -- named, so the agent understands why its own screen is used instead.
function writeDisplay(home, { selfName, mainDisplay, offlineMainDisplay, screen, contentDir }) {
  const displayName = safeAgentName(mainDisplay) || 'another agent';
  const offlineName = safeAgentName(offlineMainDisplay);
  let where;
  if (!mainDisplay && offlineMainDisplay) {
    where = `The main display${offlineName ? `, ${offlineName}'s screen,` : ''} is offline right now, so a presentation appears on your own screen.`;
  } else if (!mainDisplay) {
    where = 'No main display is set right now, so a presentation appears on your own screen.';
  } else if (mainDisplay === selfName) {
    where = 'The main display right now is your own screen.';
  } else {
    where = `The main display right now is ${displayName}'s screen.`;
  }
  const text = [
    '# Showing things on screen', '',
    where, '',
    describeScreen(screen), '',
    `Write pages into: ${slash(contentDir)}/`,
    'Name a page in the marker by its file name alone, for example [PRESENTATION: overview.html]. A website goes in with its full address.', ''
  ].join('\n');
  const file = displayFile(home);
  try { if (fs.readFileSync(file, 'utf8') === text) return false; } catch (e) { /* not written yet */ }
  writeAtomic(file, text);
  return true;
}

// An EVENT for the next message, never state. "Toby joined" stays true forever, which is exactly
// why it may go into a conversation that cannot forget; "Toby is online" does not, which is why
// that lives in agents.md instead. null for `before` means this process has not seen a turn yet,
// so there is nothing honest to compare against.
function describeRosterChange(before, after) {
  if (!before) return '';
  const was = new Set(before);
  const now = new Set(after);
  const joined = after.filter((n) => !was.has(n));
  const left = before.filter((n) => !now.has(n));
  if (!joined.length && !left.length) return '';
  const parts = [];
  if (joined.length) parts.push(`${joined.join(', ')} joined`);
  if (left.length) parts.push(`${left.join(', ')} went offline`);
  return `(Network update since your last reply: ${parts.join('; ')}.)`;
}

// The same kind of event about the agent itself: the user renamed it at the hub, or changed what it
// is responsible for, since its previous turn. The system prompt carries the current name from then
// on, but the conversation so far still says the old one, so it is told once.
function describeIdentityChange(before, now) {
  if (!before) return '';
  const changes = [];
  if (before.name !== now.name) changes.push(`your name is now ${now.name}`);
  if (before.domain !== now.domain) changes.push(now.domain ? `you are now responsible for: ${now.domain}` : 'you no longer have a particular responsibility');
  return changes.length ? `(The user changed who you are on the network since your last reply: ${closeSentence(changes.join('; '))})` : '';
}

// Why the agent's request to change its own name or responsibility did not go through, told once as
// an event. Only codes from this table produce text: the code arrives from the hub, and nothing that
// crossed the network is copied into what an agent reads.
const IDENTITY_DECLINES = {
  user: 'the user declined it, so nothing changed',
  invalid: 'it was not valid -- a name is 1 to 32 letters, digits, spaces, dashes or underscores starting with a letter, a responsibility is at most 200 characters, a short reason is required, and the JSON has to parse',
  'name-taken': 'another agent already answers to that name',
  unchanged: 'it asked for exactly what is already set',
  unconfirmed: 'the user has not confirmed who you are yet',
  unreachable: 'the hub could not be reached'
};

function describeIdentityDecline(code) {
  const why = Object.prototype.hasOwnProperty.call(IDENTITY_DECLINES, code) ? IDENTITY_DECLINES[code] : null;
  return why ? `(Your request to change your name or responsibility did not go through: ${why}.)` : '';
}

module.exports = { HOME_ROOT, agentHome, prepareHome, writeRoster, writeDisplay, describeRosterChange, describeIdentityChange, describeIdentityDecline, readIdentity, writeIdentity, closeSentence, rosterFile, displayFile, workspaceDir, memoryDir, slash, permissionPath };
