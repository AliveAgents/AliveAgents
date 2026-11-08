// updater.js
// Keeping an agent's own program up to date -- by itself, with nobody but the user deciding.
//
// The user's requirements (2026-09-22): an agent that runs an outdated version says so on its own display
// and updates when the user presses a button; Oscar has nothing to do with it (he must be able to work with
// agents that are not the user's and run entirely different code); and it has to be safe.
//
//   * Each agent asks the project's public GitHub repository itself, at start and once a day. The newest
//     commit of the branch is resolved first and everything is fetched from exactly that commit, so a push
//     in between cannot mix two versions.
//   * Only a signed release counts. release.json lists every file with its SHA-256 and carries an Ed25519
//     signature by the release key, whose private half never leaves the user's own PC (publish-release.js,
//     confirmed with Windows Hello). The public half ships with the program (release-key.pub). Write access
//     to the repository alone therefore cannot hand agents code: without the key, nothing installs.
//   * A release not newer than the installed one is ignored, so an old signed release with a known bug
//     cannot be played back.
//   * Nothing installs without the user. The face page shows the notice; its button goes through this
//     device's own confirmation dialog, which names the version (device-confirm.js).
//   * Files are downloaded, each checked against its hash, and only then put in place; the replaced ones
//     are kept in .update-backup/. Only program files are ever touched -- never net-config.json, keys,
//     tokens, sessions, the inbox, tools/ or node_modules/, even if a signed release listed them.
//   * Start scripts and package lists are not replaced under a running program (cmd.exe reads a batch file
//     at the old offset after it changed). A release that changes them says so and is installed by hand.
//   * The restart waits until the agent is idle; the process then exits with RESTART_CODE and the start
//     script starts it again. A start script from before this cannot, and the page then says so.
//   * A copy managed with git -- the user's development PC -- never updates itself: it is ahead of every
//     release, and an update would overwrite the newer work.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SOURCE = { owner: 'AliveAgents', repo: 'AliveAgents', branch: 'master' };
const MANIFEST_FILE = 'release.json';
const KEY_FILE = 'release-key.pub';
const RESTART_CODE = 75;
const FIRST_CHECK_MS = 60 * 1000;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30 * 1000;
const GIT_TIMEOUT_MS = 120 * 1000;
const FILE_MAX_BYTES = 5 * 1024 * 1024;
const VERSION_RE = /^\d{4}\.\d{2}\.\d{2}-\d{1,4}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

// Never written by an update, whatever a release says: this machine's own settings, secrets and state.
const PROTECTED_DIRS = new Set(['tools', 'node_modules', 'certs', 'inbox', 'inbox_out', 'presented_content', 'audio_out', '.git', '.claude', '.update-backup', '.update-staging']);
function isProtected(rel) {
  const base = path.posix.basename(rel).toLowerCase();
  return PROTECTED_DIRS.has(rel.split('/')[0].toLowerCase()) || base === 'net-config.json' || base === MANIFEST_FILE
    || base.includes('.local.') || base.endsWith('.pem') || base.startsWith('.session') || base.startsWith('token');
}
// Replaced only by hand: see the header.
function isManual(rel) {
  return /\.(bat|cmd|ps1|sh)$/i.test(rel) || rel === 'package.json' || rel === 'package-lock.json';
}
// A relative path inside the program folder, in plain characters, with no way out of it.
function isSafePath(rel) {
  return typeof rel === 'string' && rel.length <= 200 && /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(rel)
    && !rel.split('/').some((seg) => seg === '.' || seg === '..');
}

// Keys sorted, so a manifest signs and verifies the same however it was assembled.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
const unsigned = (manifest) => { const copy = Object.assign({}, manifest); delete copy.signature; return copy; };

// SHA-256 of a file's content with CRLF read as LF. Git may store and serve a text file with other line
// endings than the checkout it was published from (core.autocrlf), and a hash over raw bytes would then
// fail every download. A file with a NUL byte is binary and hashed exactly as it is.
function contentHash(buf) {
  const bytes = buf.includes(0) ? buf : Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function compareVersions(a, b) {
  const pa = String(a).split(/[.-]/).map(Number);
  const pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

function signManifest(manifest, privateKey) {
  const signature = crypto.sign(null, Buffer.from(canonical(unsigned(manifest))), privateKey).toString('base64');
  return Object.assign({}, unsigned(manifest), { signature });
}

// The manifest if it is well-formed and signed by publicKey, else null. Every path is checked here, so one
// bad entry rejects the whole release rather than being skipped.
function verifyManifest(manifest, publicKey) {
  try {
    if (!manifest || manifest.format !== 1 || !VERSION_RE.test(manifest.version) || typeof manifest.signature !== 'string') return null;
    const files = manifest.files;
    if (!files || typeof files !== 'object' || Array.isArray(files) || !Object.keys(files).length) return null;
    for (const [rel, hash] of Object.entries(files)) {
      if (!isSafePath(rel) || isProtected(rel) || !HASH_RE.test(hash)) return null;
    }
    const ok = crypto.verify(null, Buffer.from(canonical(unsigned(manifest))), publicKey, Buffer.from(manifest.signature, 'base64'));
    return ok ? manifest : null;
  } catch (e) {
    return null;
  }
}

function fileHash(file) {
  try { return contentHash(fs.readFileSync(file)); } catch (e) { return null; }
}

// root: the program folder. agentName: string or function. confirmer: device-confirm.js. isIdle(): true when
// nothing is running that a restart would cut off. onChange(publicState): tell the face pages. onRestart():
// end this process with RESTART_CODE (a parameter for the tests). env: for the tests.
function createUpdater({ root, agentName, confirmer, isIdle = () => true, onChange = () => {}, onRestart, log = console.log, env = process.env, autoUpdate = false }) {
  const nameNow = () => (typeof agentName === 'function' ? agentName() : agentName);
  const testSource = env.ALIVEAGENTS_UPDATE_SOURCE || '';
  const apiBase = testSource ? `${testSource}/api` : 'https://api.github.com';
  const rawBase = testSource ? `${testSource}/raw` : 'https://raw.githubusercontent.com';
  const restartable = env.ALIVEAGENTS_RESTARTABLE === '1';
  const restart = onRestart || (() => process.exit(RESTART_CODE));
  const managedByGit = fs.existsSync(path.join(root, '.git'));
  if (testSource) log(`[update] WARNING: releases come from ${testSource}, not from GitHub (ALIVEAGENTS_UPDATE_SOURCE -- for tests only).`);

  let state = { status: managedByGit ? 'git' : 'unknown', problem: null, latest: null, commit: null, changed: [], manual: [], checkedAt: null };
  let busy = false;
  let timers = [];

  const set = (next) => {
    state = Object.assign({}, state, next);
    try { onChange(publicState()); } catch (e) { /* a page that went away */ }
  };

  function installedVersion() {
    const key = publicKey();
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST_FILE), 'utf8')); } catch (e) { return null; }
    return key && verifyManifest(manifest, key) ? manifest.version : null;
  }

  function publicKey() {
    try { return crypto.createPublicKey(fs.readFileSync(path.join(root, KEY_FILE), 'utf8')); } catch (e) { return null; }
  }

  function publicState() {
    return {
      status: state.status, problem: state.problem, agentName: nameNow(), installed: installedVersion(), root,
      latest: state.latest ? { version: state.latest.version, published: state.latest.published } : null,
      changedCount: state.changed.length, manual: state.manual.slice(), restartable, checkedAt: state.checkedAt,
      git: managedByGit, autoUpdate: managedByGit && autoUpdate
    };
  }

  async function get(url, accept, maxBytes) {
    if (typeof fetch !== 'function') throw new Error('this Node.js is too old to download anything');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'AliveAgents-updater', Accept: accept || '*/*' } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
      const declared = Number(res.headers.get('content-length') || 0);
      if (declared > maxBytes) throw new Error('a file of the release is too big');
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error('a file of the release is too big');
      return buf;
    } finally {
      clearTimeout(timer);
    }
  }

  // What changed since the installed version, if anything newer is published.
  async function check() {
    if (busy) return publicState();
    busy = true;
    try {
      const key = publicKey();
      if (!key) { set({ status: 'no-key', problem: `${KEY_FILE} is missing, so no release can be checked.` }); return publicState(); }
      const { owner, repo, branch } = SOURCE;
      const shaBuf = await get(`${apiBase}/repos/${owner}/${repo}/commits/${branch}`, 'application/vnd.github.sha', 1024);
      const commit = shaBuf ? shaBuf.toString('utf8').trim() : '';
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('GitHub did not name the newest version');
      const raw = await get(`${rawBase}/${owner}/${repo}/${commit}/${MANIFEST_FILE}`, 'application/json', FILE_MAX_BYTES);
      if (!raw) { set({ status: 'none', problem: 'No signed release has been published yet.', latest: null, checkedAt: new Date().toISOString() }); return publicState(); }
      let manifest = null;
      try { manifest = verifyManifest(JSON.parse(raw.toString('utf8')), key); } catch (e) { manifest = null; }
      if (!manifest) {
        log('[update] The published release.json is not signed with this program\'s release key -- ignored.');
        set({ status: 'invalid', problem: 'The published release is not signed with this program\'s release key, so it is ignored.', latest: null, checkedAt: new Date().toISOString() });
        return publicState();
      }
      const installed = installedVersion();
      const changed = Object.keys(manifest.files).filter((rel) => fileHash(path.join(root, rel)) !== manifest.files[rel]);
      const now = new Date().toISOString();
      if ((installed && compareVersions(manifest.version, installed) <= 0) || !changed.length) {
        // Already in place (a copy deployed by hand, say): recorded, so the version shows from now on.
        if (!changed.length && installed !== manifest.version) writeManifest(manifest);
        set({ status: 'current', problem: null, latest: manifest, commit, changed: [], manual: [], checkedAt: now });
        return publicState();
      }
      // A start script that does not exist here is not running here either, so it can simply be written --
      // start-node.sh on Windows, the .bat files on a phone. Only one that is there waits for a hand.
      const manual = changed.filter((rel) => isManual(rel) && fs.existsSync(path.join(root, rel)));
      // A copy with a .git folder still gets TOLD -- it just does not install anything itself. Until
      // 2026-11-07 it did not even look, and since every phone is set up by cloning the repository,
      // that silently covered every agent on the network: Steve sat five weeks on an old version while
      // his face page said nothing at all. Checking is free and harmless; writing over a working copy
      // someone is editing is what the rule was there to prevent, and that part stays.
      if (managedByGit) {
        // A git copy is updated BY git: a fast-forward to the very commit whose release.json was just
        // verified against this installation's public key. Pinning the merge to that commit instead of
        // to whatever the branch happens to point at keeps the signature as the thing that authorises
        // the new code. Only ever with a clean working copy and only as a fast-forward, so nothing
        // local can be overwritten and no merge -- and therefore no conflict -- is possible. The rule
        // this branch used to keep by doing nothing still holds: a copy somebody edits is reported,
        // never written over. That is what the clean-copy check below decides, per machine.
        const byItself = autoUpdate && !manual.length;
        set({ status: 'git-update', problem: byItself ? null : 'This copy is managed with git, so it does not update itself.', latest: manifest, commit, changed, manual, checkedAt: now });
        log(`[update] Version ${manifest.version} is out (${changed.length} files).${byItself ? ' Bringing this git copy forward.' : ` This copy is managed with git: press Install on ${nameNow()}'s page, or "git pull" in ${root} and restart.`}`);
        if (byItself) whenIdle(() => { gitInstall(manifest).catch((e) => log(`[update] The git update failed: ${e.message}`)); });
        return publicState();
      }
      set({ status: manual.length ? 'manual' : 'available', problem: null, latest: manifest, commit, changed, manual, checkedAt: now });
      log(`[update] Version ${manifest.version} is available (${changed.length} files${manual.length ? `, needs a manual install: ${manual.join(', ')}` : ''}).`);
      return publicState();
    } catch (e) {
      log(`[update] Could not check for a new version: ${e.message}`);
      set({ status: state.status === 'available' || state.status === 'manual' ? state.status : 'offline', problem: `Could not check for a new version: ${e.message}` });
      return publicState();
    } finally {
      busy = false;
    }
  }

  function writeManifest(manifest) {
    const file = path.join(root, MANIFEST_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }

  // Resolves { ok } or { error } -- a sentence for the page.
  // Runs git in this folder. Never throws: every caller wants a sentence for the page, not a stack.
  function gitRun(args) {
    return new Promise((resolve) => {
      execFile('git', args, { cwd: root, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const text = (s) => String(s || '').trim();
        resolve({ ok: !err, out: text(stdout), err: text(stderr) || (err ? err.message : '') });
      });
    });
  }

  // The git half of installing. Every step is checked, and it stops at the first thing that is not
  // plainly safe rather than trying to repair anything.
  async function gitInstall(manifest) {
    if (busy) return { error: 'An update is already being checked or installed.' };
    busy = true;
    set({ status: 'installing', problem: null });
    const stop = (why) => {
      busy = false;
      log(`[update] Not updated: ${why}`);
      set({ status: 'git-update', problem: `Not updated: ${why}` });
      return { error: why };
    };
    if (state.manual.length) return stop(`this version also changes ${state.manual.join(', ')}, which is started by hand, so it is left alone.`);
    if (!/^[0-9a-f]{40}$/.test(String(state.commit || ''))) return stop('the published release does not name a commit.');
    if (!(await gitRun(['--version'])).ok) return stop('git is not available on this machine.');
    const dirty = await gitRun(['status', '--porcelain']);
    if (!dirty.ok) return stop(`git could not read this folder: ${dirty.err}`);
    if (dirty.out) return stop(`this copy has ${dirty.out.split('\n').length} file(s) of its own changed, so nothing was touched. Commit or discard them first.`);
    const fetched = await gitRun(['fetch', '--quiet', 'origin']);
    if (!fetched.ok) return stop(`git could not fetch from the remote: ${fetched.err}`);
    if (!(await gitRun(['cat-file', '-e', `${state.commit}^{commit}`])).ok) return stop('the published commit is not among what this folder fetched from its remote.');
    if (!(await gitRun(['merge-base', '--is-ancestor', 'HEAD', state.commit])).ok) return stop('this copy is not simply behind the published commit, so a fast-forward is not possible.');
    const merged = await gitRun(['merge', '--ff-only', state.commit]);
    if (!merged.ok) return stop(`the fast-forward failed: ${merged.err}`);
    busy = false;
    log(`[update] Fast-forwarded to version ${manifest.version} (${state.commit.slice(0, 7)}).`);
    set({ status: restartable ? 'restarting' : 'installed', problem: null, changed: [], manual: [] });
    if (restartable) restartWhenIdle();
    return { ok: true };
  }

  async function install() {
    if (managedByGit) { if (state.status !== 'git-update' || !state.latest) return { error: 'There is no update to install.' }; }
    else if (state.status !== 'available' || !state.latest) return { error: state.status === 'manual' ? 'This version changes the start scripts or packages, so it has to be installed by hand.' : 'There is no update to install.' };
    if (busy) return { error: 'An update is already being checked or installed.' };
    const manifest = state.latest;
    const { owner, repo } = SOURCE;
    const text = `AliveAgents: update ${nameNow()}'s program to version ${manifest.version}, published ${String(manifest.published || '').slice(0, 10)}. ${state.changed.length} files change.`;
    const answer = await confirmer.ask(text);
    if (!answer.ok) return { error: `${answer.reason} Nothing changed.` };
    // A git copy is brought forward by git, with the same confirmation in front of it.
    if (managedByGit) return gitInstall(manifest);
    busy = true;
    set({ status: 'installing', problem: null });
    const staging = path.join(root, '.update-staging');
    const backup = path.join(root, '.update-backup', `${installedVersion() || 'before'}-to-${manifest.version}`);
    const replaced = [];
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      // 1 -- everything downloaded and checked before anything is touched
      for (const rel of state.changed) {
        const buf = await get(`${rawBase}/${owner}/${repo}/${state.commit}/${rel}`, '*/*', FILE_MAX_BYTES);
        if (!buf || contentHash(buf) !== manifest.files[rel]) throw new Error(`${rel} did not match the signed release`);
        const staged = path.join(staging, rel);
        fs.mkdirSync(path.dirname(staged), { recursive: true });
        fs.writeFileSync(staged, buf);
      }
      // 2 -- put in place, keeping what was there
      for (const rel of state.changed) {
        const target = path.join(root, rel);
        if (fs.existsSync(target)) {
          fs.mkdirSync(path.dirname(path.join(backup, rel)), { recursive: true });
          fs.copyFileSync(target, path.join(backup, rel));
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(path.join(staging, rel), target);
        replaced.push(rel);
      }
      writeManifest(manifest);
    } catch (e) {
      // Whatever was already replaced goes back, so the program is never half one version, half another.
      for (const rel of replaced) {
        const saved = path.join(backup, rel);
        try { if (fs.existsSync(saved)) fs.copyFileSync(saved, path.join(root, rel)); else fs.rmSync(path.join(root, rel), { force: true }); } catch (err) { /* reported below */ }
      }
      fs.rmSync(staging, { recursive: true, force: true });
      busy = false;
      log(`[update] Installing ${manifest.version} failed, nothing changed: ${e.message}`);
      set({ status: 'available', problem: `Installing failed, nothing changed: ${e.message}` });
      return { error: `Installing failed, so nothing changed: ${e.message}` };
    }
    fs.rmSync(staging, { recursive: true, force: true });
    busy = false;
    log(`[update] Version ${manifest.version} installed (${replaced.length} files, the old ones are in ${path.relative(root, backup)}).`);
    set({ status: restartable ? 'restarting' : 'installed', changed: [], manual: [] });
    if (restartable) restartWhenIdle();
    return { ok: true };
  }

  // Not on the spot: an idle agent would otherwise be gone before the page that pressed the button had its
  // answer (found by the live test).
  function whenIdle(fn) {
    const tick = () => {
      if (isIdle()) { fn(); return; }
      timers.push(setTimeout(tick, 2000));
    };
    timers.push(setTimeout(tick, 1500));
  }

  function restartWhenIdle() {
    whenIdle(() => { log('[update] Restarting to use the new version.'); restart(); });
  }

  function start() {
    if (managedByGit) log(`[update] This copy is managed with git: new versions are ${autoUpdate ? 'brought in with a fast-forward once this folder is clean and idle' : 'reported, not installed'}.`);
    timers.push(setTimeout(() => { check(); }, FIRST_CHECK_MS));
    const daily = setInterval(() => { check(); }, CHECK_EVERY_MS);
    timers.push(daily);
  }

  function stop() {
    for (const t of timers) { clearTimeout(t); clearInterval(t); }
    timers = [];
  }

  // Face-page messages, the same for hub and node.
  async function handlePageMessage(msg, reply) {
    if (msg.type === 'update-get') return reply({ update: publicState() });
    if (msg.type === 'update-check') return reply({ update: await check() });
    if (msg.type === 'update-install') {
      const result = await install();
      return reply(Object.assign({ update: publicState() }, result));
    }
  }

  return { check, install, start, stop, publicState, handlePageMessage };
}

const PAGE_MESSAGE_TYPES = ['update-get', 'update-check', 'update-install'];

module.exports = {
  createUpdater, verifyManifest, signManifest, canonical, compareVersions, isSafePath, isProtected, isManual, contentHash, fileHash,
  PAGE_MESSAGE_TYPES, RESTART_CODE, MANIFEST_FILE, KEY_FILE, SOURCE, VERSION_RE
};
