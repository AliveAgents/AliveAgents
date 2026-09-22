// permissions.js
// What an agent may do -- decided by the user, on the device the agent runs on, and by nobody else.
//
// The user's requirements (2026-09-15): every device sets its own agent's permissions on its own face page;
// only the user may set them; neither the agent, nor another agent, nor anything else may tick a box or get
// around one -- and no agent may change how the page presents them, so nobody is tricked into granting the
// wrong thing. Two things make that hold:
//
//   1. The settings live outside every folder an agent is given (HOME_ROOT/.permissions/), and the only way
//      to change them is a request from this device's own face page (isOwnPage in overlay-server.js). The
//      hub has no message for it; another machine cannot reach the page.
//   2. The page is not trusted with what a change means. An agent allowed to control the browser can run
//      script on it and swap labels. So the page only sends the switches it wants; this process compares
//      them with the ones in force, words the change from CATALOGUE below, and has the operating system ask
//      in a dialog of its own that shows exactly that text (device-confirm.js). Nothing is written before
//      the user confirms there.
//
// What this does NOT cover, and the user accepted it (agents get their own devices to work on): an agent
// with a command line runs as the same user as this program. It could rewrite the settings, and this code.
// That switch is shown in red and says so.

const fs = require('fs');
const path = require('path');
const { HOME_ROOT, permissionPath } = require('./agent-home.js');

const PERMISSIONS_DIR = path.join(HOME_ROOT, '.permissions');

// The switches, in the order the page shows them. roles: which kind of agent has the switch at all. needs:
// only offered when that exists on the device. does: how the confirmation dialog says it. danger: shown in
// red on the page, and the grant is spelled out in capitals in the dialog, with risk after it.
const CATALOGUE = [
  { key: 'webSearch', label: 'Search the web', does: 'search the web', roles: ['hub', 'node'] },
  { key: 'webFetch', label: 'Read web pages', does: 'read web pages', roles: ['hub', 'node'] },
  { key: 'browser', label: 'Control the browser', does: 'control the browser', roles: ['hub', 'node'],
    note: 'Chrome with the Claude extension. It can reach this page too -- which is why every change here is confirmed outside the browser, in a dialog that names it.' },
  { key: 'mcp', label: 'Extra tools (MCP servers)', does: 'use extra tools (MCP servers)', roles: ['hub', 'node'], needs: 'mcp' },
  { key: 'presentations', label: 'Create and show presentations', does: 'create and show presentations', roles: ['hub', 'node'] },
  { key: 'workspace', label: 'Write files in its own folder', does: 'write files in its own folder', roles: ['hub', 'node'] },
  { key: 'files', label: 'Receive files', does: 'receive files', roles: ['hub', 'node'] },
  { key: 'projectEdit', label: 'Change files in its project folder', does: 'change files in its project folder', roles: ['node'], needs: 'workDir' },
  { key: 'forward', label: 'Involve other agents', does: 'involve other agents', roles: ['hub', 'node'] },
  { key: 'identityRequests', label: 'Ask to change its name or responsibility', does: 'ask to change its name or responsibility', roles: ['node'] },
  { key: 'provision', label: 'Set up new agents', does: 'set up new agents', roles: ['hub'] },
  { key: 'shell', label: 'Use the command line', does: 'use the command line', roles: ['hub', 'node'],
    risk: 'any command on this device',
    danger: 'Runs any command on this device. The agent could then change these settings, and this program, directly.' },
  { key: 'unrestricted', label: 'Everything without asking', does: 'do everything without asking', roles: ['hub', 'node'],
    risk: 'every tool, nothing checked',
    danger: 'Includes the command line and every other tool. Same risk, and nothing is checked at all.' }
];

// What applies when the settings file exists but cannot be read: nothing that reaches beyond the agent's
// own folders or the network of agents. Deliberately not the seed, which may allow more than the user left.
const MINIMAL = { presentations: true, workspace: true, files: true, forward: true };

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// -- Command-line switches --------------------------------------------------------------------------
// The one place a Claude Code call learns what the agent may do. Hard-won facts, all measured:
//   * Edit(<dir>/**) is the rule that grants writing; Write(...) rules are accepted but never enforced
//     (2026-08-17). Absolute paths need permissionPath's doubled slash on Linux and Android (2026-09-14).
//   * "Skill" has to be allowed, or skills are discovered but cannot be invoked once --allowedTools
//     narrows the set.
//   * Headless, the shell tool runs WITHOUT asking unless --disallowedTools names it, and it is blocked
//     by NAME: "PowerShell" on Windows, "Bash" on Linux/Android -- so both are always named (2026-09-14).
//   * bypassPermissions is identical to --dangerously-skip-permissions.
//   * Leaving a tool out of --allowedTools is not enough (2026-09-15). Claude Code also reads the working
//     directory's .claude/settings.json: its "allow" entries count once the folder is trusted (a real
//     project someone has run Claude Code in), and its "defaultMode" counted even in an untrusted folder --
//     "bypassPermissions" there turned an ordinary turn into one without any checks. So the mode is always
//     given explicitly, every switched-off tool is named in --disallowedTools (a forbidden tool is not even
//     offered to the model), and an agent allowed to change its project folder is kept out of that
//     folder's .claude/ and .mcp.json, so it cannot write such a file for its next turn.
// paths: { contentDir, inboxDir, workspaceDir, projectDir, extraTools, mcpConfig }
function claudePermissionArgs(p, paths) {
  const rule = (dir) => `Edit(${permissionPath(dir)}/**)`;
  const tools = ['Skill'];
  if (p.presentations) tools.push(rule(paths.contentDir));
  if (p.files) tools.push(rule(paths.inboxDir));
  if (p.workspace) tools.push(rule(paths.workspaceDir));
  if (p.projectEdit && paths.projectDir) tools.push(rule(paths.projectDir));
  if (p.webSearch) tools.push('WebSearch');
  if (p.webFetch) tools.push('WebFetch');
  if (p.mcp && paths.extraTools) tools.push(...String(paths.extraTools).split(',').map((t) => t.trim()).filter(Boolean));
  if (p.shell) tools.push('PowerShell', 'Bash');
  const args = ['--allowedTools', tools.join(',')];
  if (p.unrestricted) {
    // Everything without asking is everything: no mode and no deny list to hold it back.
    args.push('--permission-mode', 'bypassPermissions');
  } else {
    args.push('--permission-mode', 'default');
    const deny = [];
    if (!p.webSearch) deny.push('WebSearch');
    if (!p.webFetch) deny.push('WebFetch');
    if (!p.shell) deny.push('PowerShell', 'Bash');
    if (!p.browser) deny.push('mcp__claude-in-chrome');
    if (!p.mcp && paths.extraTools) deny.push(...String(paths.extraTools).split(',').map((t) => t.trim()).filter(Boolean));
    if (!p.presentations) deny.push(rule(paths.contentDir));
    if (!p.files) deny.push(rule(paths.inboxDir));
    if (!p.workspace) deny.push(rule(paths.workspaceDir));
    if (paths.projectDir && !p.projectEdit) deny.push(rule(paths.projectDir));
    if (paths.projectDir && p.projectEdit) deny.push(`Edit(${permissionPath(paths.projectDir)}/.claude/**)`, `Edit(${permissionPath(paths.projectDir)}/.mcp.json)`);
    if (deny.length) args.push('--disallowedTools', deny.join(','));
  }
  if (p.mcp && paths.mcpConfig) args.push('--mcp-config', paths.mcpConfig);
  if (p.browser) args.push('--chrome');
  return args;
}

// The allowedTools entries a config names besides the two web tools -- in practice the tools of its
// MCP servers. They come with the "mcp" switch.
function extraToolsFrom(allowedTools) {
  return String(allowedTools || '').split(',').map((t) => t.trim())
    .filter((t) => t && t !== 'WebSearch' && t !== 'WebFetch').join(',');
}

// What a device starts with before anyone has touched its settings: exactly what its configuration
// already allowed, so updating changes nothing for a running agent.
function seedFromConfig({ role, allowedTools, chrome, mcpConfig, permissionMode }) {
  const tools = String(allowedTools || '').split(',').map((t) => t.trim());
  const unrestricted = permissionMode === 'bypassPermissions';
  return {
    webSearch: tools.includes('WebSearch'),
    webFetch: tools.includes('WebFetch'),
    browser: !!chrome,
    mcp: !!mcpConfig,
    presentations: true,
    workspace: true,
    files: true,
    projectEdit: role === 'node' && (unrestricted || permissionMode === 'acceptEdits'),
    forward: true,
    identityRequests: role === 'node',
    provision: role === 'hub',
    shell: unrestricted,
    unrestricted
  };
}

// The change as the confirmation dialog states it: worded here from CATALOGUE, from the switches in force
// and the ones asked for -- never from anything else the page sent. Dangerous grants come first and in
// capitals, so a long list cannot bury them. '' when nothing changes.
function describeChange(agentName, items, before, after) {
  const gained = items.filter((c) => after[c.key] && !before[c.key]);
  gained.sort((a, b) => (b.danger ? 1 : 0) - (a.danger ? 1 : 0));
  const lost = items.filter((c) => before[c.key] && !after[c.key]);
  const grant = (c) => (c.danger ? `${c.does.toUpperCase()} (${c.risk})` : c.does);
  const parts = [];
  if (gained.length) parts.push(`${agentName} may now ${gained.map(grant).join(', ')}.`);
  if (lost.length) parts.push(`${agentName} may no longer ${lost.map((c) => c.does).join(', ')}.`);
  return parts.join(' ');
}

// id: file name for this agent's settings ("oscar", "beta"). agentName: a string, or a function when the
// name can change while running. available: { mcp, workDir } -- switches whose thing does not exist here are
// always off. confirmer: from device-confirm.js; without one nothing can be changed.
function createPermissionStore({ id, role, agentName, seed, available = {}, dir = PERMISSIONS_DIR, log = console.log, confirmer = null }) {
  const settingsFile = path.join(dir, `${id}.json`);
  const items = CATALOGUE.filter((c) => c.roles.includes(role) && (!c.needs || available[c.needs]));
  const keys = items.map((c) => c.key);
  const nameNow = () => (typeof agentName === 'function' ? agentName() : agentName);
  let waiting = false;
  let reportedUnreadable = false;

  const only = (perms) => {
    const out = {};
    for (const k of keys) out[k] = !!(perms && perms[k] === true);
    return out;
  };

  // Read from disk on every call: a turn always runs on the settings as they are now.
  function effective() {
    if (!fs.existsSync(settingsFile)) {
      const seeded = only(seed);
      try { writeJsonAtomic(settingsFile, { permissions: seeded, seeded: new Date().toISOString() }); } catch (e) { log(`[permissions] could not write ${settingsFile}: ${e.message}`); }
      return seeded;
    }
    const settings = readJson(settingsFile);
    if (settings && settings.permissions && typeof settings.permissions === 'object') {
      reportedUnreadable = false;
      return only(settings.permissions);
    }
    if (!reportedUnreadable) {
      log(`[permissions] WARNING: ${settingsFile} cannot be read -- ${nameNow()} runs with the minimal set until the settings are saved again on this device's face page.`);
      reportedUnreadable = true;
    }
    return only(MINIMAL);
  }

  function status() {
    const current = effective();
    return {
      agentName: nameNow(),
      role,
      waiting,
      confirm: confirmer ? confirmer.state() : { label: null, available: false, checked: true, problem: 'This device has no confirmation dialog.' },
      items: items.map((c) => ({ key: c.key, label: c.label, note: c.note || '', danger: c.danger || '', value: current[c.key] }))
    };
  }

  // Resolves { ok }, { ok, unchanged } or { error } -- a sentence for the page.
  async function save(permissions) {
    if (waiting) return { error: 'A change is already waiting for confirmation on this device.' };
    if (!confirmer) return { error: 'This device has no confirmation dialog, so nothing can be changed here.' };
    const before = effective();
    const after = only(permissions);
    const text = describeChange(nameNow(), items, before, after);
    if (!text) return { ok: true, unchanged: true };
    waiting = true;
    try {
      const answer = await confirmer.ask(`AliveAgents: ${text}`);
      if (!answer.ok) return { error: `${answer.reason} Nothing changed.` };
      // The dialog described a change from what was in force when it opened. If that moved meanwhile, its
      // text no longer describes what would be written.
      if (JSON.stringify(effective()) !== JSON.stringify(before)) return { error: 'The settings changed while the dialog was open, so nothing was saved. Try again.' };
      writeJsonAtomic(settingsFile, { permissions: after, savedAt: new Date().toISOString(), confirmedWith: confirmer.state().label });
      log(`[permissions] ${text} (confirmed with ${confirmer.state().label})`);
      return { ok: true };
    } catch (e) {
      return { error: `Could not save: ${e.message}` };
    } finally {
      waiting = false;
    }
  }

  return { effective, status, save };
}

// Face-page messages about permissions, the same for hub and node. reply(obj) answers the page that asked;
// push(obj) tells every open page, before the answer, so the asking page already shows the new switches.
async function handlePageMessage(store, msg, reply, push) {
  if (msg.type === 'permissions-get') return reply({ status: store.status() });
  if (msg.type === 'permissions-save') {
    const result = await store.save(msg.permissions || {});
    if (result.ok && !result.unchanged) push({ type: 'permissions', status: store.status() });
    reply(result);
  }
}

const PAGE_MESSAGE_TYPES = ['permissions-get', 'permissions-save'];

module.exports = {
  CATALOGUE, MINIMAL, PERMISSIONS_DIR, PAGE_MESSAGE_TYPES,
  createPermissionStore, handlePageMessage, claudePermissionArgs, seedFromConfig, extraToolsFrom, describeChange
};
