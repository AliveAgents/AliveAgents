// agent-bridge-server.js
// Local bridge server for THORSTEN (the hub): accepts input from the terminal or the microphone,
// calls the Claude Code CLI headlessly (claude -p ... --output-format json), and sends the state
// (idle / thinking / speaking + text) via WebSocket to the Tampermonkey overlay. Either speaks
// itself (via Piper, locally on THIS machine) or forwards the task to a remote, encrypted-
// connected agent (see agent-net.js) -- which then speaks on ITS OWN machine with its own voice
// and its own face (node-agent.js).

//
// Prerequisites:
//   npm install ws cross-spawn
//   Claude Code CLI installed and connected to your subscription via `claude setup-token`
//
// Start:
//   node agent-bridge-server.js
// Then just type in the terminal and press Enter -> the agent answers and "speaks".

const spawn = require('cross-spawn');
const readline = require('readline');
const fs = require('fs');
const path = require('path');
const { startHub, fingerprintOfCertPem, loadPeerCert } = require('./agent-net.js');
const { startHubBeacon } = require('./discovery.js');
const { createSpeaker } = require('./speech.js');
const { startOverlayServer, getLanIp, normalizeScreen, readOwnContent, normalizePage, isWebsite, presentationLabel } = require('./overlay-server.js');
const { extractFollowUpTag, buildSystemPointer, extractPresentationTag, splitSlideSegments, extractProvisionTag, extractIdentityTag } = require('./followup-tag.js');
const agentHome = require('./agent-home.js');
const { pickIdentity, normalizeTint } = require('./identity.js');
const agentRegistry = require('./agent-registry.js');
const permissionsLib = require('./permissions.js');
const deviceConfirm = require('./device-confirm.js');
const { startClaude, MESSAGE_MAX_CHARS, tooLongSentence } = require('./claude-cli.js');
const updaterLib = require('./updater.js');
const faceDesign = require('./face-design.js');
const enrollmentLib = require('./enrollment.js');
const inboxLib = require('./inbox.js');

// Spawn the real claude.exe directly instead of the bare 'claude' command whenever the bundled
// portable install is present. On Windows, 'claude' resolves to claude.cmd, and spawning a .cmd
// file forces Node to route the whole command line through cmd.exe -- which then re-parses EVERY
// argument using its own metacharacter rules, regardless of how carefully cross-spawn quoted them.
// Found live: a reply merely containing both a literal '"' and an '&' (e.g. quoting someone while
// mentioning "S&P 500") silently truncated the argument at the '&' and made cmd.exe try to run the
// text after it as a new command ('Der Befehl "P" ist entweder falsch geschrieben...'). Verified
// empirically that spawning claude.exe directly bypasses cmd.exe entirely and preserves the
// argument byte-for-byte, quotes/ampersands/emoji included. Falls back to plain 'claude' (PATH
// lookup) if the bundled .exe isn't present, e.g. a non-portable install.
const CLAUDE_EXE = (() => {
  const bundled = path.join(__dirname, 'tools', 'node', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  return fs.existsSync(bundled) ? bundled : 'claude';
})();

// Ports/config file are overridable via environment variable, so a second instance can be
// started in parallel for testing without disturbing the running one.
const PORT = Number(process.env.AGENT_BRIDGE_PORT) || 8787;
const SESSION_FILE = process.env.AGENT_SESSION_FILE || path.join(__dirname, '.session.json');

// Loaded up here rather than only where the hub starts (bottom of the file): provisioning needs
// the hub's own name and port while building a config for a joining machine, and that code is
// evaluated at module load. One read, one source of truth.
// See the same helper in node-agent.js: a UTF-8 byte order mark makes JSON.parse throw, and both
// Notepad and PowerShell 5.1's "Set-Content -Encoding UTF8" write one. Costs nothing to tolerate.
function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

const NET_CONFIG_FILE = process.env.AGENT_NET_CONFIG || path.join(__dirname, 'net-config.json');
let netConfig = null;
if (fs.existsSync(NET_CONFIG_FILE)) {
  try {
    netConfig = readJsonFile(NET_CONFIG_FILE);
  } catch (e) {
    console.error(`[net] ${NET_CONFIG_FILE} is not valid JSON: ${e.message}`);
  }
}
const NET_PORT = (netConfig && netConfig.port) || 8788;

const AGENT = {
  name: 'Oscar',
  personality: 'Direct and pragmatic, answering in 1-3 short, chat-style sentences. No preamble phrases like "As an AI, I would say".',
  // "low"|"medium"|"high"|"xhigh"|"max" or null for the CLI default -- same option as "effort" in
  // net-config.json for the nodes, set directly here because Oscar's identity (unlike the
  // nodes') doesn't come from net-config.json, it lives here in code.
  effort: null,
  // "opus"|"sonnet"|a full name like "claude-opus-5-5", or null for whatever the CLI is set to --
  // same option as "model" in net-config.json for the nodes, here in code for the same reason as
  // effort above.
  model: null,
  // e.g. "WebSearch,WebFetch" or null -- same principle as "allowedTools" in net-config.json for
  // the nodes. Without this, these tools are forbidden by default in headless mode.
  allowedTools: null,
  // Path to an MCP server JSON or an inline JSON string, or null -- same principle as "mcpConfig"
  // in net-config.json for the nodes.
  mcpConfig: null,
  // "manual"|"acceptEdits"|"auto"|"dontAsk"|"bypassPermissions"|"plan" or null for the CLI default
  // -- same principle as "permissionMode" in net-config.json for the nodes. Deliberately left at
  // null here: the user explicitly wanted ONLY Nova to be able to make changes without
  // confirmation, not Oscar. The field still exists (like effort/allowedTools/mcpConfig) so the
  // configuration stays uniform -- a higher level here would still require a deliberate code
  // change at this spot, not a simple config edit like for the nodes.
  permissionMode: null,
  // true|false -- same principle as "chrome" in net-config.json for the nodes. Was deliberately
  // false at first (user's wish: only Nova), switched on 2026-08-16 at explicit request, after
  // Nova's own Chrome pairing on laptop B failed to come together -- Oscar's machine already
  // had the extension connected (see the test further above), so pragmatically turned on here instead.
  chrome: true,
  // true|false -- sets Oscar himself as the main display, ONLY as a starting value (see the
  // main-display feature further below). The actual, intended way to reassign the role with
  // little effort is "/maindisplay <Name>" while running, not this field.
  mainDisplay: false,
  // Name of the face definition in faces/ (see overlay-server.js) the browser overlay loads --
  // Oscar's current actual appearance. Travels along during a presentation on an ANOTHER
  // screen (see presentFromOscar/playPresentationLocally below), so his own face appears there
  // instead of that screen's own.
  faceStyle: 'kai',
  // Pinned rather than derived. Every agent provisioned from now on gets its own generated
  // palette (see identity.js), but the coordinator keeps the red it has always had -- the one
  // face on the network nobody should have to re-learn. These are exactly kai's own colours
  // written out, so the value is explicit instead of implied, and identity.js reserves this
  // stretch of the colour wheel so no derived identity can land next to it.
  faceTint: { idle: '#8a4a4a', thinking: '#ff6a3d', speaking: '#ff2b3d' }
};

const speaker = createSpeaker({
  piperExe: path.join(__dirname, 'tools', 'piper', 'piper.exe'),
  voiceModel: path.join(__dirname, 'tools', 'piper', 'voices', 'en_US-ryan-high.onnx'),
  audioDir: path.join(__dirname, 'audio_out')
});

// Lock against overlapping replies -- now PER TARGET instead of global: a new request to a
// target aborts that target's OWN still-running work (barge-in still applies), but no longer
// invalidates the independent, still-running work of a DIFFERENT target. requestId remains the
// plain id generator AND the already-existing chain identifier (a follow-up chain carries the
// same value through every hop) -- no second, redundant counter needed.
let requestId = 0;
let currentClaudeChild = null;
const HUB_TARGET = '__thorsten__';
// targetKey ('__thorsten__' or agent name) -> the requestId currently considered "current" for
// this target. Replaces the "myRequestId !== requestId" comparison everywhere it concerns ONE
// specific target (see onSpeechFinished, say(), askOscarDirectly).
const activeRequestByTarget = new Map();
// "Is a claude call currently running here" -- independent of activeRequestByTarget (which only
// governs the staleness check). Prevents a follow-up reaction (advanceFollowUpQueue) from tearing
// a target out of its own, independent active work: it waits instead until the target is free
// again (see targetFreed/pendingReactionByTarget).
const busyTargets = new Set();
// At most ONE waiting follow-up reaction per target -- a new entry overwrites an older waiting
// one (same simplicity as elsewhere in this project), gets delivered once the target frees up.
const pendingReactionByTarget = new Map();
// Last line of defence against an agent that takes a question and never comes back: the node has
// its own, shorter watchdog (node-agent.js) and normally reports its own failure, so this one only
// catches a node that cannot even do that any more while its connection still looks fine -- a phone
// frozen by Android's power management is exactly that case. Without it the user gets no word at
// all, and the agent stays reserved (see targetFreed for what that blocks).
const routeWatchdogs = new Map(); // agent name -> timer
const ROUTE_TIMEOUT_MINUTES = 20;

// Aborts ONLY the own in-flight work (claude child process, running speech) of ONE target -- for
// a remote node that already happens locally on its own side (runTask()), so this is only
// relevant for Oscar here.
function interruptTarget(targetKey) {
  if (targetKey !== HUB_TARGET) return;
  speaker.stopSpeaking();
  if (currentClaudeChild) { try { currentClaudeChild.kill(); } catch (e) {} currentClaudeChild = null; }
}

function clearRouteWatchdog(targetKey) {
  const timer = routeWatchdogs.get(targetKey);
  if (timer) { clearTimeout(timer); routeWatchdogs.delete(targetKey); }
}

// Started when a question goes out to a remote agent, cancelled the moment it answers.
function armRouteWatchdog(agentName, requestId) {
  clearRouteWatchdog(agentName);
  routeWatchdogs.set(agentName, setTimeout(() => {
    routeWatchdogs.delete(agentName);
    // Something newer is already running there -- that request has a watchdog of its own.
    if (activeRequestByTarget.get(agentName) !== requestId) return;
    console.log(`[net] "${agentName}" has not answered for ${ROUTE_TIMEOUT_MINUTES} minutes -- no longer waiting for it.`);
    activeRequestByTarget.delete(agentName);
    targetFreed(agentName);
    cleanupFollowUp(requestId);
    tellUser(`${agentName} has not come back with anything for ${ROUTE_TIMEOUT_MINUTES} minutes, so I have stopped waiting. Ask again whenever you like.`);
  }, ROUTE_TIMEOUT_MINUTES * 60000));
}

// Called once a target has finished its claude call (the text is final) -- marks the target as
// free again and immediately delivers a possibly waiting follow-up reaction.
function targetFreed(targetKey) {
  busyTargets.delete(targetKey);
  clearRouteWatchdog(targetKey);
  const pending = pendingReactionByTarget.get(targetKey);
  if (pending) {
    pendingReactionByTarget.delete(targetKey);
    console.log(`[followup] "${targetKey}" is free again -- fetching the held-back reaction.`);
    pending();
  }
}

// Remembers who was addressed last (Oscar himself = nodeName:null). If an input with no
// recognizable name arrives shortly afterward (< LAST_AGENT_FALLBACK_MS), it goes straight to the
// same target WITHOUT a fresh sense classification -- an obvious continuation of the same
// conversation, saves the Haiku detour. Only after a longer pause does full routing kick back in.
let lastRoutedTarget = null;
let lastRoutedAt = 0;
const LAST_AGENT_FALLBACK_MS = 30000;

function rememberRouted(agentName, nodeName) {
  lastRoutedTarget = { agentName, nodeName };
  lastRoutedAt = Date.now();
}

// -- Agent network: remote nodes that connect here over an encrypted channel ---------
// remoteAgents: agent name (spoken) -> { nodeName, domain, screen }, e.g. "Nova" -> { nodeName:
// "node2", domain: "Website, Cloudflare, ..." }. Connected agents only. Name and domain come from
// the hub's own record (agent-registry.js), never from what a node says about itself; domain is
// what sense-based routing below decides by.
const remoteAgents = new Map();
const agentRecords = agentRegistry.createRegistry(NET_CONFIG_FILE);
// nodeName -> the one decision about that machine waiting for the user, { id, kind, name, domain, reason }:
//   kind 'introduction' -- a machine without a record, exactly as it introduced itself;
//   kind 'request'      -- a recorded agent asking for its own name or responsibility to change
//                          ([IDENTITY: ...], see receiveIdentityRequest).
// Shown only to the user, never to an agent, and applied only by the user: /agent confirm|reject typed
// at the console or on the hub's own page, or the buttons there (decideById). The id ties a click to
// exactly the request it was shown for, so one replaced in the meantime is never accepted by accident.
const pendingIdentity = new Map();
// nodeName -> the pending entry last announced to the user, so a phone whose WiFi drops every few
// minutes does not repeat the same notice on every reconnect.
const announcedIntroductions = new Map();
// nodeName -> an introduction the user declined, so it does not pop up again on every reconnect until
// the machine introduces itself differently.
const declinedIntroductions = new Map();
// nodeName -> a decline the agent has not heard about yet, because it was offline when it happened.
const queuedDeclines = new Map();
// nodeName -> the machine's last hello, so a machine that could not be admitted (no free name) can
// be admitted once the user gives it one, without having to reconnect.
const lastHello = new Map();
let hub = null;

// -- Main display: which node (or Oscar himself) is currently showing presentations -----
// mainDisplayTarget: { agentName, nodeName } | null -- nodeName:null means Oscar himself, same
// convention as lastRoutedTarget. mainDisplaySetManually prevents a reconnecting node with
// "mainDisplay":true in its config from silently undoing a deliberate "/maindisplay" decision the
// user made -- only a target that is NOT YET set may be automatically claimed via hello.
// currentPresentation reflects (for the case where Oscar's OWN screen is currently the main
// display) who is presenting there -- see setOverlayState further below, which carries this
// field along on every call.
let mainDisplayTarget = AGENT.mainDisplay ? { agentName: AGENT.name, nodeName: null } : null;
let mainDisplaySetManually = false;
let currentPresentation = null;
// requestId of the chain that started the currently running presentation. Since a whole
// follow-up chain carries the same requestId through every hop, this alone lets a purely
// mechanical check tell whether a later reaction belongs to the SAME presentation (show
// immediately, update the speaker) or to independent, foreign work (has to wait, see
// displayQueue) -- with no new relevance heuristic needed at all.
let presentationOwnerRequestId = null;
// Already-fully-synthesized outputs waiting for a free screen -- entries {targetKey, requestId,
// resume}. Deliberately NOT tied to activeRequestByTarget: an entry describes work that's already
// finished and should still be delivered even if the same target has meanwhile been dispatched
// again for something else (e.g. an additional reaction) -- otherwise a target's own, still-
// waiting presentation would get forgotten.
const displayQueue = [];
// requestId -> suggestedNext[], cached separately because the node currently serving as the main
// display doesn't need to know the FORWARD suggestions from the original reply.
const pendingPresentationSuggested = new Map();
// requestId -> { agentName, displayNode } for every presentation handed to a node serving as the
// main display. presentation-done names the presenter, and that name used to be believed from
// whichever node sent it; now only the node the deck actually went to can finish it, and it
// finishes it for the presenter recorded here.
const presentationRelays = new Map();

// Clears the currently shown presentation -- called EXCLUSIVELY once per genuinely new user
// input (right at the top of askAgent()), NEVER from routeToAgent/advanceFollowUpQueue, so a
// follow-up dispatch no longer immediately wipes a running presentation.
function clearDisplay() {
  currentPresentation = null;
  presentationOwnerRequestId = null;
  if (mainDisplayTarget && mainDisplayTarget.nodeName !== null && hub && hub.isUp(mainDisplayTarget.nodeName)) {
    try { hub.send(mainDisplayTarget.nodeName, { type: 'clear-presentation' }); } catch (e) {}
  }
  drainDisplayQueue();
}

// Shows at most the OLDEST waiting entry, the rest gets discarded -- deliberate policy: pure
// discarding would waste already-finished work, showing everything waiting could unnecessarily
// delay the reply to the new user input. A single entry costs practically nothing (the new reply
// needs a few seconds of LLM+TTS time anyway).
function drainDisplayQueue() {
  if (currentPresentation || displayQueue.length === 0) return;
  const entry = displayQueue.shift();
  const discarded = displayQueue.length;
  displayQueue.length = 0;
  console.log(`[maindisplay] Queue cleared -- fetching "${entry.targetKey}"${discarded ? `, ${discarded} more discarded` : ''}.`);
  entry.resume();
}

// Decides whether a fully synthesized output for targetKey may be shown right now, or has to
// wait in displayQueue because the (single, shared) screen is already showing something else
// belonging to a DIFFERENT chain. Only relevant when targetKey is even the current
// mainDisplayTarget -- otherwise "the screen" has nothing to do with this target at all.
function gateForDisplay(targetKey, myRequestId, speakerInfo, deliver) {
  const isDisplayTarget = mainDisplayTarget && (
    (mainDisplayTarget.nodeName === null && targetKey === HUB_TARGET) ||
    (mainDisplayTarget.nodeName !== null && targetKey === mainDisplayTarget.agentName)
  );
  if (!isDisplayTarget || !currentPresentation) { deliver(); return; }
  if (myRequestId === presentationOwnerRequestId) {
    // Same chain as the running presentation -- show immediately, update speaker/face, URL stays
    // unchanged (see agent-face-overlay.user.js: applyState already reads agentName/faceStyle
    // from state.presentation, needs no change of its own for this).
    currentPresentation = Object.assign({}, currentPresentation, speakerInfo);
    deliver();
    return;
  }
  console.log(`[maindisplay] "${targetKey}" is waiting -- screen currently shows a different chain.`);
  displayQueue.push({ targetKey, requestId: myRequestId, resume: deliver });
}

// For an agent (e.g. Nova) to be able to suggest on its own who on the network should react
// next, it first has to know WHO else is there -- previously only Oscar knew the full list.
// peerListFor(x) builds "everyone except x" (Oscar + all other nodes); broadcastPeerLists
// sends every connected node its own view excluding itself via {type:'peers'} -- called on every
// hello/onPeerDown, so the list never stays stale for long. Since the main-display feature it
// also carries WHO currently is the main display (or null), so every node locally knows
// whether/whom it should even offer a presentation to.
// What Oscar himself is responsible for, told to the other agents exactly like any node's domain.
// It used to be an empty string here while the file-drop page had its own copy of the sentence --
// so a node learned that "Oscar" exists but never what he is for, which is half of what a roster
// is good for in the first place.
const HUB_DOMAIN = 'Coordinator -- everything that has no clearer owner.';

function peerListFor(excludeAgentName) {
  const all = [{ name: AGENT.name, domain: HUB_DOMAIN }, ...Array.from(remoteAgents.entries()).map(([name, info]) => ({ name, domain: info.domain }))];
  return all.filter((p) => p.name !== excludeAgentName);
}

// The main display as the rest of the network should see it: only while it can actually be reached.
// One that is set but offline is reported as none, so every presenter falls back to its own screen
// without first trying and failing (user's decision, 2026-09-15); its name travels separately, so
// display.md can say why. Its screen class travels with it -- a presenter never learns more about
// another agent's screen than that.
function effectiveMainDisplay() {
  if (!mainDisplayTarget) return { name: null, screen: null, offline: null };
  if (!isReachable(mainDisplayTarget.agentName)) return { name: null, screen: null, offline: mainDisplayTarget.agentName };
  const screen = mainDisplayTarget.nodeName === null
    ? hubScreen
    : ((remoteAgents.get(mainDisplayTarget.agentName) || {}).screen || null);
  return { name: mainDisplayTarget.agentName, screen, offline: null };
}

function broadcastPeerLists() {
  const md = effectiveMainDisplay();
  for (const [agentName, info] of remoteAgents) {
    if (hub && hub.isUp(info.nodeName)) {
      // "you" tells a node who it is, and only once the hub has a record of it. A machine still
      // waiting for the user keeps its own config, so the introduction the user is about to confirm
      // is not replaced by the provisional name it was given in the meantime.
      const you = agentRecords.get(info.nodeName) ? { name: agentName, domain: info.domain } : undefined;
      hub.send(info.nodeName, { type: 'peers', list: peerListFor(agentName), you, mainDisplay: md.name, mainDisplayScreen: md.screen, mainDisplayOffline: md.offline });
    }
  }
}

function agentNameOfNode(nodeName) {
  for (const [name, info] of remoteAgents) if (info.nodeName === nodeName) return name;
  return null;
}

// Who already answers to this name, as words for the user -- or null when nodeName may have it.
// Case-insensitive, because the voice and routing match names that way: to them "toby" and "Toby"
// are the same agent.
function nameHeldBy(name, nodeName) {
  const lower = name.toLowerCase();
  if (lower === AGENT.name.toLowerCase()) return "that is the hub's own name";
  const recorded = agentRecords.nodeWithName(name, nodeName);
  if (recorded) return `"${recorded}" has it`;
  for (const [other, info] of remoteAgents) {
    if (info.nodeName !== nodeName && other.toLowerCase() === lower) return `"${info.nodeName}" is using it right now`;
  }
  return null;
}

// Who a machine that just said hello is. The hub's record decides; the hello is only the machine's
// introduction. A machine without a record -- every node enrolled before 2026-09-15 -- still joins,
// so nothing stops working, but provisionally: under the name it gave if that is valid and free, and
// with no responsibility, so its self-description reaches neither the other agents nor the routing
// prompt until the user has accepted it.
function admitIdentity(nodeName, hello) {
  const introduced = { name: agentRegistry.cleanName(hello.agentName), domain: agentRegistry.cleanDomain(hello.domain) || '' };
  const record = agentRecords.get(nodeName);
  if (record) {
    // A request the agent made stays waiting across a reconnect; only a leftover introduction goes.
    const waiting = pendingIdentity.get(nodeName);
    if (waiting && waiting.kind === 'introduction') clearPending(nodeName);
    if (introduced.name && introduced.name !== record.name) {
      console.log(`[network] "${nodeName}" introduced itself as "${introduced.name}" -- the hub's record says "${record.name}", and the record counts.`);
    }
    return { name: record.name, domain: record.domain, recorded: true };
  }
  // Kept under the same id while the introduction stays the same, so a card already on screen still
  // works after the phone's WiFi dropped and came back.
  const key = JSON.stringify(introduced);
  const waiting = pendingIdentity.get(nodeName);
  const alreadyWaiting = waiting && waiting.kind === 'introduction' && JSON.stringify({ name: waiting.name, domain: waiting.domain }) === key;
  if (!alreadyWaiting && declinedIntroductions.get(nodeName) !== key) {
    setPending(nodeName, { kind: 'introduction', name: introduced.name, domain: introduced.domain });
  }
  const fallback = nodeName.charAt(0).toUpperCase() + nodeName.slice(1);
  const name = [introduced.name, fallback].find((n) => n && !nameHeldBy(n, nodeName));
  return name ? { name, domain: '', recorded: false } : null;
}

// Fuzzy name comparison, so speech-recognition mishearings still match.
// Same logic as in the overlay -- short names are allowed to be off by one letter.
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

// Finds ALL known, currently reachable names (including Oscar himself) that occur in the
// input -- sorted by the position of their FIRST mention in the text, not by connection order.
// nodeName:null marks Oscar. Enables multi-addressing ("Nova and Thomas, figure out...")
// without an extra Claude call: the first match is addressed immediately, the rest goes into the
// follow-up queue upfront (see askAgent).
function findMentionedNames(userText) {
  const words = userText.toLowerCase().split(/[^a-zäöüß]+/).filter(Boolean);
  function firstMatchIndex(name) {
    const target = name.toLowerCase();
    const threshold = target.length <= 4 ? 1 : 2;
    return words.findIndex((w) => levenshtein(w, target) <= threshold);
  }
  const candidates = [
    { agentName: AGENT.name, nodeName: null },
    ...Array.from(remoteAgents.entries())
      .filter(([, info]) => hub && hub.isUp(info.nodeName))
      .map(([agentName, info]) => ({ agentName, nodeName: info.nodeName }))
  ];
  return candidates
    .map((c) => Object.assign({}, c, { wordIndex: firstMatchIndex(c.agentName) }))
    .filter((c) => c.wordIndex !== -1)
    .sort((a, b) => a.wordIndex - b.wordIndex);
}

// Detects "to everyone"/"to the whole network"/"all agents" etc. via pattern matching --
// deliberately NO Claude call and NO reliance on the addressed agent itself remembering to list
// everyone in its own marker (that was unreliable live: for a creative task like "tell a joke"
// the appended formatting instruction apparently got lost on the model). Only covers phrasings
// actually tried/plausible, no claim to cover every conceivable wording -- exactly like the name
// detection above.
const BROADCAST_RE = /\bto\s+everyone\b|\bbroadcast\b|\b(everyone|all|whole)\b.{0,15}\b(network|agents)\b|\b(network|agents)\b.{0,15}\b(everyone|all|whole)\b/i;
function isBroadcastRequest(userText) {
  return BROADCAST_RE.test(userText);
}

// No name mentioned, but agents are connected: instead of just matching keywords, Oscar asks
// via a quick Haiku call who is actually responsible in substance -- e.g. "the bookings on my
// site aren't working" lands with Nova even though "website" was never said.
// Extra Claude call, costs a few seconds of delay -- deliberately accepted for genuine
// understanding of meaning instead of just keyword matching.
function classifyRoute(userText, callback) {
  // The prompt goes in on stdin (claude-cli.js) -- it quotes the user's words, which may be a long pasted text.
  const candidates = Array.from(remoteAgents.entries())
    .filter(([, info]) => hub && hub.isUp(info.nodeName) && info.domain)
    .map(([name, info]) => `${name}: ${info.domain}`)
    .join(' | ');
  if (!candidates) { callback(null); return; }

  const prompt = `A user said: "${userText}". Available people in charge -- ${AGENT.name}: general assistant, for anything that doesn't clearly fall into another area. | ${candidates} -- Answer ONLY with the name of the best-matching person in charge, nothing else.`;
  const args = ['-p', '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json'];
  // ROUTER_DIR rather than this checkout -- see its definition. This runs on nearly every utterance.
  const child = startClaude(CLAUDE_EXE, args, prompt, { cwd: ROUTER_DIR });
  currentClaudeChild = child;

  let out = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.on('error', () => {
    if (currentClaudeChild === child) currentClaudeChild = null;
    callback(null);
  });
  child.on('close', (code) => {
    if (currentClaudeChild === child) currentClaudeChild = null;
    if (code !== 0) { callback(null); return; }
    let answer = '';
    try { answer = (JSON.parse(out).result || '').trim(); } catch (e) { answer = out.trim(); }
    const known = [AGENT.name, ...remoteAgents.keys()];
    const match = known.find((n) => answer.toLowerCase().includes(n.toLowerCase()));
    console.log(`[routing] "${userText}" -> classifier answered "${answer}", chosen: ${match || '(none)'}`);
    callback(match || null);
  });
}

// -- Follow-up replies: EVERY agent (including Oscar himself) may append a quiet marker to
// the end of its reply -- "[FORWARD: Name1, Name2]" -- to suggest who on the network should
// react next. The marker is cut out BEFORE speaking (see followup-tag.js) and only arrives here
// as a separate suggestedNext field, NEVER as part of the spoken text. If the marker is missing,
// that is a deliberate "nothing more to add from me" -- the chain ends there on its own, with no
// need for Oscar to guess or classify (the earlier Haiku classification call after every reply
// has thus been eliminated entirely).
// Oscar still remains the "final authority": every suggested name gets checked against the
// currently known, currently reachable agents (filterSuggested) -- a made-up or no-longer-
// connected name gets silently discarded instead of blindly attempted.
// Ping-pong (A->B->A) is deliberately ALLOWED (user's wish: "it can also be fine if it goes back
// and forth a bit more often") -- only a hard upper bound (MAX_FOLLOWUP_HOPS) prevents a genuine
// infinite loop, in case two agents were to keep forwarding to each other indefinitely for some reason.
// Built entirely dynamically from remoteAgents: a new agent needs no code change here, just
// config + certificate (see make-certs.sh).
const followUpQueues = new Map();            // requestId -> remaining names, in speaking order
const originalQuestionByRequest = new Map(); // requestId -> the original user question
const lastAnswerByRequest = new Map();       // requestId -> { answererName, answerText }
const chainLengthByRequest = new Map();      // requestId -> number of replies already spoken in this chain
// Overridable via env like AGENT_BRIDGE_PORT/AGENT_NET_CONFIG/AGENT_SESSION_FILE -- handy for
// quickly forcing a ping-pong while testing, without touching the value in code.
const MAX_FOLLOWUP_HOPS = Number(process.env.AGENT_MAX_FOLLOWUP_HOPS) || 8; // safety limit against genuine infinite loops

// When the limit kicks in, it doesn't stay silent -- Oscar says so out loud, instead of the
// conversation just breaking off unexplained. A small selection instead of one fixed line, purely for variety.
const CHAIN_LIMIT_LINES = [
  'Okay, last round, let\'s wrap this up.',
  'That\'s enough for now, we\'re done here.',
  'Good discussion, but let\'s call it for today.'
];

function cleanupFollowUp(myRequestId) {
  followUpQueues.delete(myRequestId);
  originalQuestionByRequest.delete(myRequestId);
  lastAnswerByRequest.delete(myRequestId);
  chainLengthByRequest.delete(myRequestId);
  pendingPresentationSuggested.delete(myRequestId);
}

function isReachable(name) {
  if (name === AGENT.name) return true;
  const info = remoteAgents.get(name);
  return !!(info && hub && hub.isUp(info.nodeName));
}

// Model replies should reproduce names exactly (unlike speech recognition, where Levenshtein is
// needed) -- a simple case-insensitive comparison is enough here.
function resolveKnownName(rawName) {
  const target = String(rawName || '').trim().toLowerCase();
  if (!target) return null;
  const known = [AGENT.name, ...remoteAgents.keys()];
  return known.find((n) => n.toLowerCase() === target) || null;
}

// This is the concrete implementation of "Oscar remains the final authority": only real,
// currently reachable names get through, no self-suggestion, no duplicates.
function filterSuggested(rawNames, answererName) {
  const seen = new Set();
  const result = [];
  for (const raw of rawNames || []) {
    const resolved = resolveKnownName(raw);
    if (!resolved || resolved === answererName || seen.has(resolved) || !isReachable(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

// Model replies should reproduce names exactly -- helper to go from an agent name to its target
// key for activeRequestByTarget/busyTargets (Oscar himself gets the sentinel HUB_TARGET,
// everyone else gets their own name).
function targetKeyFor(agentName) {
  return agentName === AGENT.name ? HUB_TARGET : agentName;
}

// Called after EVERY finished-speaking reply, regardless of whether it was Oscar himself or a
// remote agent. suggestedNext comes from the marker in that reply (see above).
function onSpeechFinished(myRequestId, answererName, answerText, suggestedNext = []) {
  if (myRequestId !== activeRequestByTarget.get(targetKeyFor(answererName))) { cleanupFollowUp(myRequestId); return; } // stale
  lastAnswerByRequest.set(myRequestId, { answererName, answerText });

  // "Who counts as last addressed" AND "when does the 30s window start" are both reset here --
  // no longer only at dispatch time (see routeToAgent/askOscarDirectly). Before, the window
  // ran from when the task was SENT, not from the actual END of the reply -- for a remote agent
  // with a noticeable thinking/speaking time (e.g. higher effort), this effectively left less
  // than 30s for a natural follow-up question, sometimes none at all.
  // The one place every finished reply passes through, whoever gave it -- so the chat transcript
  // is fed from here rather than from each agent's own path. A remote agent's text otherwise never
  // reaches this browser at all (it speaks on its own machine), which is exactly why typing to
  // Nova would previously have looked like it went nowhere.
  overlay.pushChat({ agent: answererName, from: 'agent', text: answerText });

  const info = answererName === AGENT.name ? null : remoteAgents.get(answererName);
  rememberRouted(answererName, info ? info.nodeName : null);
  // Give the browser overlay the authoritative point in time, instead of it having to guess from
  // a locally observed "speaking" transition -- for a remote agent like Nova, "speaking" never
  // even shows up on Oscar's OWN overlay (she speaks on her own screen after all), which meant
  // the previous browser-side window extension never applied for her.
  setOverlayState({ status: 'idle', text: '', agent: AGENT.name, followupUntil: lastRoutedAt + LAST_AGENT_FALLBACK_MS });

  const hops = (chainLengthByRequest.get(myRequestId) || 0) + 1;
  chainLengthByRequest.set(myRequestId, hops);
  if (hops >= MAX_FOLLOWUP_HOPS) {
    console.log(`[followup] #${myRequestId} automatically ended after ${hops} replies (safety limit).`);
    cleanupFollowUp(myRequestId);
    // Oscar speaks here as a "system" announcement, regardless of whether he was ever even a
    // target in THIS chain before (for a purely remote chain he never was) -- so HUB_TARGET first
    // has to be explicitly claimed for this requestId, otherwise say()'s own staleness check
    // would wrongly discard the announcement (activeRequestByTarget.get(HUB_TARGET) might still
    // hold the state of a completely different, older Oscar dispatch).
    activeRequestByTarget.set(HUB_TARGET, myRequestId);
    const line = CHAIN_LIMIT_LINES[Math.floor(Math.random() * CHAIN_LIMIT_LINES.length)];
    say(line, myRequestId, AGENT.name, false); // allowFollowUp=false: closing remark, no new round
    return;
  }

  const additions = filterSuggested(suggestedNext, answererName);
  if (additions.length) {
    console.log(`[followup] ${answererName} suggests: ${additions.join(', ')}`);
  } else if (suggestedNext.length) {
    // Deliberately distinguished from the "no marker at all" case (see the raw-text log in
    // node-agent.js/askOscarDirectly): here something WAS suggested, but got fully filtered
    // out -- e.g. a wrong/unknown name, or currently unreachable.
    console.log(`[followup] ${answererName} suggested (${suggestedNext.join(', ')}), but none of it was valid/reachable.`);
  }
  const queue = followUpQueues.get(myRequestId) || [];
  for (const name of additions) if (!queue.includes(name)) queue.push(name);

  if (queue.length === 0) { cleanupFollowUp(myRequestId); return; } // no one suggested -- chain ends here, as intended
  followUpQueues.set(myRequestId, queue);
  advanceFollowUpQueue(myRequestId);
}

// No more "myRequestId !== requestId" check here -- redundant: onSpeechFinished has already
// validated the chain against ITS OWN target before advanceFollowUpQueue is even called (see
// activeRequestByTarget). The actual dispatch to nextName claims its own target slot regardless.
function advanceFollowUpQueue(myRequestId) {
  const queue = followUpQueues.get(myRequestId);
  if (!queue || queue.length === 0) { cleanupFollowUp(myRequestId); return; }
  const [nextName, ...rest] = queue;
  followUpQueues.set(myRequestId, rest);

  const originalQuestion = originalQuestionByRequest.get(myRequestId) || '';
  const prior = lastAnswerByRequest.get(myRequestId);
  const priorPart = prior ? ` ${prior.answererName} said: "${prior.answerText}".` : '';
  // Deliberately NO instruction anymore to explicitly say "nothing to add" if nothing fits --
  // that was a leftover from before the marker mechanism, when it was the only way to signal the
  // end of the chain. That is now handled entirely by the (invisible) FORWARD marker (network skill),
  // completely separate from the spoken text -- a forced verbal announcement now only feels unnatural.
  const followUpText = `The original question was: "${originalQuestion}".${priorPart} React briefly, whatever fits right now.`;

  const dispatch = () => {
    if (nextName === AGENT.name) {
      askOscarDirectly(followUpText, myRequestId);
      return;
    }
    const info = remoteAgents.get(nextName);
    if (info && hub && hub.isUp(info.nodeName)) {
      routeToAgent({ agentName: nextName, nodeName: info.nodeName }, followUpText, myRequestId);
    } else {
      advanceFollowUpQueue(myRequestId); // target no longer reachable -- try the next one in the chain
    }
  };

  // Target is currently independently busy with something else -- do NOT interrupt (user's wish:
  // a reaction must not tear an agent out of its active work), instead deliver it once it frees
  // up again (see targetFreed).
  const targetKey = targetKeyFor(nextName);
  if (busyTargets.has(targetKey)) {
    console.log(`[followup] "${nextName}" is currently busy with independent work -- reaction will be delivered once free.`);
    pendingReactionByTarget.set(targetKey, dispatch);
    return;
  }
  dispatch();
}

// Oscar's own home, outside this checkout -- see agent-home.js. He works IN it: running here in the
// repository loaded the developer CLAUDE.md into every one of his turns, 4,487 tokens each,
// measured. His skills are generated fresh on every start, including new-agent, which only the hub
// can act on. Creating them also creates the home, which has to exist before it can be a cwd.
const HOME = agentHome.agentHome(AGENT.name);
const CONTENT_DIR_FOR_PROMPT = agentHome.slash(path.join(__dirname, 'presented_content'));
const INBOX_DIR_FOR_PROMPT = agentHome.slash(path.join(__dirname, 'inbox'));
// Oscar's own folder for files he creates -- see prepareHome in agent-home.js.
const WORKSPACE_DIR = agentHome.slash(agentHome.workspaceDir(HOME));
agentHome.prepareHome({
  name: AGENT.name,
  skills: ['network', 'presentation', 'inbox', 'workspace', 'sources', 'new-agent'],
  vars: { INBOX_DIR: INBOX_DIR_FOR_PROMPT, WORKSPACE_DIR }
});

// An empty room for the routing classifier. It needs no skills and no files, only a working
// directory outside this repository -- otherwise every routing decision, made on almost every
// utterance without a name in it, would pay for the developer CLAUDE.md as well.
const ROUTER_DIR = path.join(agentHome.HOME_ROOT, '.router');
fs.mkdirSync(ROUTER_DIR, { recursive: true });

// Keeps the two skill data files current. Called when a node joins or leaves, when the main display
// changes, and once before each of Oscar's turns; both writes are no-ops when nothing changed.
// remoteAgents only ever holds connected agents (a disconnect removes the entry), so no liveness
// check is needed here.
function refreshSkillData() {
  const peers = Array.from(remoteAgents.entries()).map(([name, info]) => ({ name, domain: info.domain }));
  agentHome.writeRoster(HOME, AGENT.name, peers, HUB_DOMAIN);
  const md = effectiveMainDisplay();
  agentHome.writeDisplay(HOME, {
    selfName: AGENT.name,
    mainDisplay: md.name,
    offlineMainDisplay: md.offline,
    // Oscar's decks land on his own screen unless a reachable node is the main display.
    screen: md.name && md.name !== AGENT.name ? md.screen : hubScreen,
    contentDir: CONTENT_DIR_FOR_PROMPT
  });
}

// Same reasoning as loadSessionId in node-agent.js: Claude Code files a session under the directory
// it ran in, so a session saved while Oscar still worked in the repository cannot be resumed from
// his home. Files from before this field existed belong to the repository.
function loadSessionId() {
  try {
    const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8').replace(/^﻿/, ''));
    const savedCwd = saved.cwd || __dirname;
    if (path.resolve(savedCwd) !== path.resolve(HOME)) {
      console.log(`[${AGENT.name}] Starting a new conversation: the saved one belongs to ${savedCwd}, ${AGENT.name} now works in ${HOME}.`);
      return null;
    }
    return saved.sessionId || null;
  } catch (e) { return null; }
}
function saveSessionId(id) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: id, cwd: HOME })); } catch (e) {}
}
let sessionId = loadSessionId();
// The other agents' names as of Oscar's previous turn, so he can be told once, as an event, who
// joined or left in between. null until his first turn in this process.
let rosterAtLastTurn = null;
// The class of the screen Oscar's own face page is shown on, or null (see onScreenChange below).
let hubScreen = null;
refreshSkillData();

// This PC's own confirmation dialog (device-confirm.js): the only thing that lets a change to Oscar's
// permissions, a decision card or a typed /agent through. It states the change in its own words, so what
// an agent does to the face page cannot change what the user agrees to.
const confirmer = deviceConfirm.createConfirmer();
// What Oscar may do: set on this machine's face page only, and confirmed with the dialog above
// (permissions.js). The AGENT fields above are just what a fresh machine starts with.
const permissionStore = permissionsLib.createPermissionStore({
  id: AGENT.name.toLowerCase(), role: 'hub', agentName: AGENT.name,
  seed: permissionsLib.seedFromConfig({ role: 'hub', allowedTools: AGENT.allowedTools, chrome: AGENT.chrome, mcpConfig: AGENT.mcpConfig, permissionMode: AGENT.permissionMode }),
  available: { mcp: !!AGENT.mcpConfig },
  confirmer
});
// Runs once the check is done, long after the overlay below exists.
confirmer.ready.then(() => overlay.pushPage({ type: 'permissions', status: permissionStore.status() }));

// Oscar's own program, kept up to date by itself (updater.js) -- the other agents look after their own,
// whatever code they run. Idle means no turn running for anyone and no presentation on screen.
const updater = updaterLib.createUpdater({
  root: __dirname, agentName: AGENT.name, confirmer,
  isIdle: () => busyTargets.size === 0 && !currentPresentation && !currentClaudeChild,
  onChange: (update) => overlay.pushPage({ type: 'update', update })
});
updater.start();

const overlay = startOverlayServer({
  port: PORT,
  // ONLY Oscar's overlay passes input through. targetAgent is set when it came from a per-agent
  // chat box on the stage page; the microphone leaves it null and routing works as it always has.
  // Oscar's own screen class, from a browser showing his face page on this machine. Changes when a
  // page opens or closes, not when a window is resized or a device turned.
  onScreenChange: (screen) => {
    hubScreen = screen;
    refreshSkillData();
    broadcastPeerLists(); // only changes what nodes see while Oscar himself is the main display
  },
  onUserInput: (text, targetAgent, source) => askAgent(text, targetAgent, source),
  // Decisions only the user makes (see pendingIdentity): the list behind the buttons on this machine's
  // own page, and a click on one of them. The face server accepts both only from that page.
  getDecisions: () => pendingDecisions(),
  onDecision: (id, accept, reply) => decideById(id, accept, reply),
  onPageMessage: (msg, reply) => (updaterLib.PAGE_MESSAGE_TYPES.includes(msg.type)
    ? updater.handlePageMessage(msg, reply)
    : permissionsLib.handlePageMessage(permissionStore, msg, reply, (obj) => overlay.pushPage(obj))),
  // Powers the file-drop page at /files. Hub-only -- a node knows neither the roster nor how to
  // route a file to somebody else.
  getAgents: () => [
    { name: AGENT.name, domain: HUB_DOMAIN, online: true },
    ...Array.from(remoteAgents.entries()).map(([name, info]) => ({
      name, domain: info.domain || '', online: !!(hub && hub.isUp(info.nodeName))
    }))
  ],
  onFileUpload: (agentName, fileName, buffer) => deliverFile(agentName, fileName, buffer)
});

// Thin wrapper around overlay.setState: ALWAYS attaches the list of all currently valid agent
// names (Oscar himself + all connected nodes). The browser needs this list to be able to
// address remote agents like Nova by voice too -- otherwise the wake-word recognition in the
// overlay only knows the one name currently sitting in "agent".
function setOverlayState(partial) {
  // agentNames, presentation, and faceStyle are deliberately the LAST arguments: this way the
  // freshly computed/current value always wins, even if "partial" (e.g. from overlay.getState())
  // happens to still hold an old state. presentation has to be carried along here by necessity,
  // because overlay.setState() REPLACES the state entirely instead of merging it (see
  // overlay-server.js) -- otherwise any incidental setOverlayState call while Oscar HIMSELF is
  // the main display would wipe a running presentation off his own screen. faceStyle is
  // Oscar's OWN face (invariant, never comes over the network) -- the face of a PRESENTING
  // agent instead travels along inside the presentation object itself, see playPresentationLocally.
  //
  // IMPORTANT: since the queueing logic landed, currentPresentation is a CENTRAL instance
  // maintained by the hub -- it also gets set when a REMOTE node is currently the actual display
  // (see playPresentationLocally/presentFromOscar/the present-request handler), so the hub can
  // even judge "is the screen currently occupied" at all. Without the following condition EVERY
  // presentation -- no matter who is showing it -- would unpromptedly also show up in Oscar's
  // OWN presentation iframe, even when he isn't the main display at all (a real bug, reported
  // live: Oscar's screen also showed foreign presentations, ownDisplayHidden only hides his
  // FACE, not the iframe). Oscar's OWN screen may only show something when HE HIMSELF is
  // actually the main-display node.
  //
  // Since 2026-09-15 Oscar's own screen also shows his decks when there is no reachable main display,
  // so "is Oscar the main display" stopped being the right test -- with none set, his deck played
  // with sound but never appeared (found live the same day). What is right: was this presentation
  // put on HIS screen. Only playPresentationLocally ever does that, and it marks the object so.
  const ownScreenPresentation = currentPresentation && currentPresentation.onOwnScreen ? currentPresentation : null;
  overlay.setState(Object.assign({}, partial, { faceTint: AGENT.faceTint, agentNames: [AGENT.name, ...remoteAgents.keys()], presentation: ownScreenPresentation, faceStyle: AGENT.faceStyle }));
}

// The style name under which a remote agent's face can be shown on THIS screen. An agent set up
// from here wears a generated face ('own', see buildNodeConfig), which exists only as a recipe in
// its own config -- so the recipe travels with the message and is registered with this machine's
// overlay server, which serves it under a name of its own. Anything else (the hand-written faces in
// faces/) is already on every machine and passes through unchanged.
function faceStyleFor(agentName, faceStyle, faceRecipe) {
  if (faceStyle !== 'own' || !faceRecipe) return faceStyle;
  return overlay.setGuestFace(agentName, faceRecipe) || faceStyle;
}
setOverlayState({ status: 'idle', text: '', agent: AGENT.name });

// Sets "speaking", synthesizes via Piper, and plays back locally (no browser audio needed -> no
// autoplay lock). Falls back to browser speech synthesis if Piper isn't available.
// Discards itself if a newer request has meanwhile taken over.
// allowFollowUp=false for error messages ("Claude CLI not found" etc.) -- those should not
// trigger a follow-up round, only genuine substantive replies should.
function say(text, myRequestId, speakerName = AGENT.name, allowFollowUp = true, suggestedNext = []) {
  speaker.synthesizeSpeech(text, (filePath) => {
    if (myRequestId !== activeRequestByTarget.get(HUB_TARGET)) {
      if (filePath) fs.unlink(filePath, () => {});
      cleanupFollowUp(myRequestId);
      return;
    }
    if (filePath) {
      const deliver = () => {
        setOverlayState({ status: 'speaking', text, agent: speakerName });
        speaker.playLocally(filePath, () => {
          fs.unlink(filePath, () => {});
          if (myRequestId === activeRequestByTarget.get(HUB_TARGET)) {
            setOverlayState({ status: 'idle', text: '', agent: AGENT.name });
          }
          if (allowFollowUp) onSpeechFinished(myRequestId, speakerName, text, suggestedNext);
        });
      };
      // Only relevant when Oscar himself is currently the main display AND something else is
      // already running -- gateForDisplay() delivers immediately if neither applies.
      gateForDisplay(HUB_TARGET, myRequestId, { agentName: AGENT.name, faceStyle: AGENT.faceStyle, faceTint: AGENT.faceTint }, deliver);
    } else {
      setOverlayState({ status: 'speaking', text, agent: speakerName, needsBrowserSpeech: true });
      // Without Piper there is no reliable "done speaking" point -- the follow-up chain stops here.
    }
  });
}

// Forwards to a remote agent. It speaks ITSELF on its own machine -- Oscar only waits for the
// informational callback and stays quiet/idle himself (no double-thinking).
function routeToAgent(target, userText, myRequestId) {
  console.log(`-> forwarded to ${target.agentName} (${target.nodeName})`);
  rememberRouted(target.agentName, target.nodeName);
  activeRequestByTarget.set(target.agentName, myRequestId);
  busyTargets.add(target.agentName);
  setOverlayState({ status: 'idle', text: '', agent: AGENT.name });
  // isMainDisplay tells the node whether IT ITSELF is currently the main display -- only then
  // does its own normal speech need to gate via speak-request/display-go (see node-agent.js).
  const isMainDisplay = !!(mainDisplayTarget && mainDisplayTarget.nodeName === target.nodeName);
  hub.send(target.nodeName, { type: 'task', requestId: myRequestId, text: userText, isMainDisplay });
  armRouteWatchdog(target.agentName, myRequestId);
}

// Plays a presentation on Oscar's OWN screen when he is currently the main display -- whether
// he himself is the presenter (presentFromOscar, no network hop needed) or a remote agent
// sends him something to display (the present-request handler further below). Mirrors the
// 'present' handler in node-agent.js, just without the detour through hub.send/link.send.
// Reads the slides out of a 'present'/'present-request' message. Two kinds of segment can arrive:
//   { audioBase64, text }   the presenter's own recorded voice -- what a Windows or Linux agent sends
//   { text, speakText }     text only -- what a phone sends, because its TTS engine cannot record to
//                           a file; the display speaks it in its own voice (added 2026-09-14)
// All segments must be usable, or narration and slides would drift apart, so one bad segment
// rejects the list. The older single-blob audioBase64 is still accepted, so a machine running an
// outdated copy degrades to a one-slide presentation instead of being ignored. Returns null if
// nothing usable arrived. Mirrored in node-agent.js.
function normalizePresentSegments(msg) {
  if (Array.isArray(msg.segments) && msg.segments.length) {
    const out = [];
    for (const s of msg.segments) {
      if (s && typeof s.audioBase64 === 'string') {
        out.push({ audioBase64: s.audioBase64, text: typeof s.text === 'string' ? s.text : '' });
      } else if (s && s.speakText === true && typeof s.text === 'string' && s.text.trim()) {
        out.push({ text: s.text, speakText: true });
      } else {
        out.length = 0;
        break;
      }
    }
    if (out.length) return out;
  }
  if (typeof msg.audioBase64 === 'string') {
    return [{ audioBase64: msg.audioBase64, text: typeof msg.text === 'string' ? msg.text : '' }];
  }
  return null;
}

// Turns those segments into files this machine can play, one per slide, and calls back with
// [{ filePath, text }] -- or with null, having removed anything already written, so the caller
// gets all or nothing. Audio is written as it came, unless this machine cannot play audio files:
// then the slide text is spoken by the local engine instead, which keeps the presentation
// narrated and in step, just not in the presenter's own voice. Mirrored in node-agent.js.
let presentFileSeq = 0;
function prepareSegmentFiles(wireSegments, callback) {
  const prepared = [];
  const canPlayAudio = speaker.canPlayAudioFiles();
  const fail = (why) => {
    console.error(`[maindisplay] ${why}`);
    for (const s of prepared) fs.unlink(s.filePath, () => {});
    callback(null);
  };
  const next = (i) => {
    if (i >= wireSegments.length) { callback(prepared); return; }
    const s = wireSegments[i];
    if (s.audioBase64 && canPlayAudio) {
      const filePath = path.join(__dirname, 'audio_out', `present-${Date.now()}-${++presentFileSeq}.wav`);
      try {
        fs.writeFileSync(filePath, Buffer.from(s.audioBase64, 'base64'));
      } catch (e) {
        fail(`Could not write audio data: ${e.message}`);
        return;
      }
      prepared.push({ filePath, text: s.text });
      next(i + 1);
      return;
    }
    if (!s.text) { fail('A slide arrived with audio this machine cannot play and no text to speak instead.'); return; }
    speaker.synthesizeSpeech(s.text, (filePath) => {
      if (!filePath) { fail('Could not turn a slide into speech.'); return; }
      prepared.push({ filePath, text: s.text });
      next(i + 1);
    });
  };
  next(0);
}

// segments: [{ filePath, text }] -- one entry per slide. A single-slide presentation is just the
// one-element case, so there is no separate code path for it.
// page: { name, html } when the presentation is an agent's own page (see readOwnContent in
// overlay-server.js) -- shown from memory under a fresh local link. Without one, url is a real website.
function playPresentationLocally(segments, agentName, url, text, presoRequestId, suggestedNext, faceStyle, faceTint, page) {
  const deliver = () => {
    const shownUrl = (page && overlay.showPage(page)) || url;
    currentPresentation = { agentName, url: shownUrl, faceStyle, faceTint: normalizeTint(faceTint), slide: 0, onOwnScreen: true };
    presentationOwnerRequestId = presoRequestId;
    setOverlayState({ status: 'speaking', text: segments[0].text, agent: AGENT.name });
    speaker.playSequence(segments.map((s) => s.filePath), (index) => {
      // Runs in the pause BEFORE each segment starts (see playSequence in speech.js) -- index 0
      // is already on screen from deliver() above, so only later slides are an actual change.
      // The staleness check matters here specifically: unlike a single blob, this callback fires
      // repeatedly over the whole presentation, so a newer chain could have taken the screen in
      // between -- without it, this one would keep flipping slides underneath the new owner.
      // !currentPresentation guards the same case found live on the node side: clearDisplay()
      // nulls this while the audio for the PREVIOUS presentation is still playing, and
      // Object.assign({}, null, {slide}) would rebuild a bogus presentation with a slide number
      // but no url -- which the overlay reads as "nothing is presented" and tears down.
      if (index === 0 || presoRequestId !== presentationOwnerRequestId || !currentPresentation) return;
      currentPresentation = Object.assign({}, currentPresentation, { slide: index });
      setOverlayState({ status: 'speaking', text: segments[index].text, agent: AGENT.name });
    }, () => {
      // currentPresentation is DELIBERATELY left in place here (user's wish: the presentation
      // stays up until the next genuinely new user input) -- only clearDisplay() still cleans
      // that up. Only status/text go back to idle, setOverlayState() still keeps carrying
      // currentPresentation along regardless. The deck also stays on its LAST slide, which is
      // what makes clicking back through it by hand afterwards work.
      if (presoRequestId === presentationOwnerRequestId) {
        setOverlayState({ status: 'idle', text: '', agent: AGENT.name });
      }
      onSpeechFinished(presoRequestId, agentName, text, suggestedNext); // checks staleness itself
    });
  };
  // If the screen already shows a DIFFERENT chain, wait instead of immediately overwriting it
  // (user's wish: an unrelated agent that just finished has to wait until the running
  // presentation is gone).
  if (currentPresentation && presoRequestId !== presentationOwnerRequestId) {
    console.log(`[maindisplay] "${agentName}" is waiting with its own presentation -- screen currently shows a different chain.`);
    displayQueue.push({ targetKey: targetKeyFor(agentName), requestId: presoRequestId, resume: deliver });
    return;
  }
  deliver();
}

// Oscar himself wants to present (marker in his own reply, see askOscarDirectly).
// Synthesizes via Piper as usual, but instead of playing right away: either directly locally (the
// hub is itself the main display -- there is no TLS connection to itself, so no network hop is
// possible) or forwarded via hub.send to the responsible node, while Oscar's own overlay jumps
// to idle (same principle as routeToAgent).
// slideTexts: one spoken segment per slide (see splitSlideSegments) -- a single-slide
// presentation is the one-element case, no separate path.
function presentFromOscar(slideTexts, myRequestId, url, suggestedNext) {
  const text = slideTexts.join(' ');
  // Oscar's own page travels as the page itself, wherever it is shown -- never as the key-carrying
  // link he wrote (see readOwnContent in overlay-server.js).
  const page = readOwnContent(url);
  if (!page && !isWebsite(url)) {
    console.error(`[maindisplay] Nothing to show for "${presentationLabel(url)}" -- no such page, too big, or not a website address. Speaking without it.`);
    say(text, myRequestId, AGENT.name, true, suggestedNext);
    return;
  }
  speaker.synthesizeAll(slideTexts, (filePaths) => {
    if (myRequestId !== activeRequestByTarget.get(HUB_TARGET)) {
      if (filePaths) for (const f of filePaths) fs.unlink(f, () => {});
      cleanupFollowUp(myRequestId);
      return;
    }
    if (!filePaths) {
      // Piper unavailable -- no reliable "done" point for a presentation, falls back to normal
      // (browser) speech instead of attempting a broken presentation.
      say(text, myRequestId, AGENT.name, true, suggestedNext);
      return;
    }
    const segments = filePaths.map((filePath, i) => ({ filePath, text: slideTexts[i] }));
    // mainDisplayTarget is re-checked HERE, not just before the call: synthesis is asynchronous,
    // and "/maindisplay" or a node dropping off can null it out in the meantime -- which would
    // make the .nodeName read below a TypeError that takes the whole hub down. Always a latent
    // risk, but a real one since a multi-slide deck synthesizes N segments instead of one and the
    // window is now seconds rather than a moment.
    // No main display (never set, switched off, or gone during synthesis), one that cannot be reached
    // right now, and Oscar being the main display himself all end up in the same place: his own
    // screen (user's decision, 2026-09-15).
    if (!mainDisplayTarget || mainDisplayTarget.nodeName === null || !isReachable(mainDisplayTarget.agentName)) {
      playPresentationLocally(segments, AGENT.name, url, text, myRequestId, suggestedNext, AGENT.faceStyle, AGENT.faceTint, page);
      return;
    }
    // ownDisplayHidden: Oscar's own overlay hides completely (not just idle) while the reply
    // is running on the FOREIGN main-display screen -- otherwise you'd see an idle face standing
    // around here while the actual reply happens elsewhere.
    setOverlayState({ status: 'idle', text: '', agent: AGENT.name, ownDisplayHidden: true });
    let wireSegments;
    try {
      // A phone has no recording to send -- its synthesis only parks text for its own TTS engine --
      // so it sends the slide texts, and the display speaks them (see normalizePresentSegments).
      wireSegments = speaker.producesAudioFiles()
        ? segments.map((s) => ({ audioBase64: fs.readFileSync(s.filePath).toString('base64'), text: s.text }))
        : segments.map((s) => ({ text: s.text, speakText: true }));
    } catch (e) {
      console.error('[maindisplay] Audio file unreadable, speaking normally instead:', e.message);
      say(text, myRequestId, AGENT.name, true, suggestedNext);
      return;
    }
    // The local files are kept until the deck is actually on its way: if sending fails, they are
    // what lets Oscar still show it on his own screen instead of only speaking it.
    const deliver = () => {
      try {
        pendingPresentationSuggested.set(myRequestId, suggestedNext);
        presentationRelays.set(myRequestId, { agentName: AGENT.name, displayNode: mainDisplayTarget.nodeName });
        presentationOwnerRequestId = myRequestId;
        currentPresentation = { agentName: AGENT.name, url, faceStyle: AGENT.faceStyle, faceTint: AGENT.faceTint, slide: 0 };
        // audioBase64 is only set for the single-slide case: it costs nothing there (same string,
        // one segment) and keeps a node running an older copy of the project working, since that
        // is the shape it expects. A multi-slide deck genuinely needs the new node code anyway,
        // so duplicating the first segment's audio into it would just inflate the message.
        hub.send(mainDisplayTarget.nodeName, {
          // The page itself, never the key-carrying link (see readOwnContent); url stays for websites.
          type: 'present', requestId: myRequestId, agentName: AGENT.name, url: page ? '' : url, page: page || undefined, text, faceStyle: AGENT.faceStyle, faceTint: AGENT.faceTint,
          segments: wireSegments,
          audioBase64: wireSegments.length === 1 ? wireSegments[0].audioBase64 : undefined
        });
        console.log(`[maindisplay] Oscar is presenting on "${mainDisplayTarget.agentName}"${wireSegments.length > 1 ? ` (${wireSegments.length} slides)` : ''}: ${presentationLabel(url)}`);
        for (const s of segments) fs.unlink(s.filePath, () => {});
      } catch (e) {
        // e.g. MAX_MSG_BYTES exceeded, the connection just dropped, or the display went away while
        // this waited in the queue -- avoid crashing (see agent-net.js) and show the deck on Oscar's
        // own screen instead of letting it vanish.
        console.error('[maindisplay] Could not send own presentation, showing it on his own screen instead:', e.message);
        pendingPresentationSuggested.delete(myRequestId);
        presentationRelays.delete(myRequestId);
        currentPresentation = null;
        presentationOwnerRequestId = null;
        playPresentationLocally(segments, AGENT.name, url, text, myRequestId, suggestedNext, AGENT.faceStyle, AGENT.faceTint, page);
      }
    };
    // If the target screen currently shows a DIFFERENT chain, wait instead of overwriting it.
    if (currentPresentation && myRequestId !== presentationOwnerRequestId) {
      console.log('[maindisplay] Oscar is waiting with his own presentation -- screen currently shows a different chain.');
      displayQueue.push({ targetKey: HUB_TARGET, requestId: myRequestId, resume: deliver });
      return;
    }
    deliver();
  });
}

// -- Files handed to an agent ------------------------------------------------------------------
// Comes from the drop page at /files (hub machine only). Oscar's own files are written straight to
// disk; everyone else's are pushed over the existing mTLS link, chunked, because a photo easily
// exceeds one frame. Deliberately pushed rather than fetched over HTTP the way presentations are:
// a slide deck is meant to be seen, a file someone handed to one agent is not.
function deliverFile(agentName, fileName, buffer) {
  if (agentName === AGENT.name) {
    if (!permissionStore.effective().files) return { ok: false, error: 'Oscar does not accept files (switched off in his permissions)' };
    const dir = inboxLib.ensureInbox(__dirname);
    const target = path.join(dir, inboxLib.safeName(fileName));
    // uniquePath lives in inbox.js for the receive path; here the same rule is applied by letting
    // the receiver helper do it -- keeps "never overwrite" in one place.
    const receiver = inboxLib.createReceiver({ root: __dirname, log: console.log, onComplete: (n) => { newInboxFiles.add(n); } });
    const id = 'local-' + Date.now();
    receiver.begin({ transferId: id, name: fileName, size: buffer.length, total: 1 });
    receiver.chunk({ transferId: id, data: buffer.toString('base64') });
    receiver.end({ transferId: id });
    return { ok: true, target: path.basename(target) };
  }
  const info = remoteAgents.get(agentName);
  if (!info) return { ok: false, error: `unknown agent "${agentName}"` };
  if (!hub || !hub.isUp(info.nodeName)) return { ok: false, error: `${agentName} is offline` };
  inboxLib.sendFile((msg) => {
    if (!hub.send(info.nodeName, msg)) throw new Error('connection dropped mid-transfer');
  }, { name: fileName, buffer, agentName });
  console.log(`[inbox] sent "${fileName}" (${inboxLib.humanSize(buffer.length)}) to ${agentName}`);
  return { ok: true };
}

// Names that arrived since Oscar's last reply, so they can be marked [NEW] exactly once.
const newInboxFiles = new Set();

// -- Provisioning a new agent ------------------------------------------------------------------
// Oscar drives the conversation (see the "new-agent" skill) and names the intent via a
// [PROVISION: {...}] marker; everything that actually touches keys, certificates or config
// happens HERE, in the hub process. Oscar gains no new tool permissions from any of this -- it
// still runs with PowerShell disallowed and write access limited to presented_content/.
const ENROLL_PORT = Number(process.env.AGENT_ENROLL_PORT) || (NET_PORT + 1);
let enrollment = null; // the currently open window, or null

// Piper reads "K7QF-2M9X-BTLR" as a word-like blob. Spelling it out with separators forces the pauses
// that make it transcribable by ear, which is the only channel the code travels over.
function speakableCode(code) {
  return code.split('').map((c) => (c === '-' ? 'dash' : c)).join('. ') + '.';
}

// Everything the new machine needs to run, assembled from what Oscar collected plus what only the
// hub knows (its own name, its LAN address, the ports).
function buildNodeConfig(name, wanted) {
  // Derived against everyone already on the network, not from the name alone: a per-name function
  // cannot see the other agents, so it cannot avoid them, and two of eight collided outright in
  // testing. Oscar is in the list even though he wears his own pinned red -- reserving a slot he
  // does not use costs one of seventeen hues and keeps the rule "every known agent is accounted
  // for" simple enough to stay true.
  const identity = pickIdentity(name, [AGENT.name.toLowerCase(), ...Array.from(remoteAgents.keys()).map((n) => n.toLowerCase())]);
  const cfg = {
    _comment: `Generated by ${AGENT.name} during enrollment on ${new Date().toISOString().slice(0, 10)}.`,
    self: name,
    role: 'node',
    hubName: netConfig.self,
    hubHost: getLanIp(),
    hubPort: NET_PORT,
    agentName: wanted.agentName || (name.charAt(0).toUpperCase() + name.slice(1)),
    piperVoice: wanted.piperVoice || identity.piperVoice,
    overlayPort: 8787,
    domain: wanted.domain || '',
    personality: wanted.personality || 'Direct and pragmatic, answering in 1-3 short, chat-style sentences.',
    // Every new agent gets a face of its own, drawn from a recipe instead of one of the two hand-written
    // shells (user's wish 2026-10-03: a new device should always turn up looking new). What the hub asked
    // for is kept where it is a known part, the rest is drawn at random -- an agent never writes the
    // face itself, only chooses from the parts (face-design.js). A deliberate "faceStyle" still wins,
    // so ava and kai can still be asked for by name.
    //
    // The seed is fresh for every pairing rather than derived from the name alone: "always new" has to
    // hold when the same machine is set up a second time too. The drawn recipe is then kept in the
    // config, so that agent's face stays the same from then on.
    faceStyle: wanted.faceStyle || 'own',
    faceRecipe: faceDesign.cleanRecipe(wanted.faceRecipe, `${name}-${Date.now()}-${require('crypto').randomBytes(8).toString('hex')}`),
    // A colour of its own, and a voice of its own. Before this, every new agent was handed the
    // same two defaults, so the third machine to join the network turned up wearing the second
    // one's face and speaking in its voice -- nothing was broken, they simply could not be told
    // apart. normalizeTint guards the deliberate value for the same reason it guards everything
    // else on this path: a tint ends up inside a stylesheet in the overlay's privileged document.
    faceTint: normalizeTint(wanted.faceTint) || identity.faceTint,
    // Merged, not replaced: a phone agent set up with a bare {"language":"en"} used to lose the
    // generated pitch and rate with it and ended up speaking in the phone's plain default voice --
    // which is how Steve came out sounding like every other phone (found 2026-10-03). What was
    // asked for wins per key, everything else stays the voice this agent was given.
    androidTts: Object.assign({}, identity.androidTts, wanted.androidTts || {}),
    mainDisplay: false
  };
  // Only carried over when explicitly asked for -- these widen what the new agent may do, so they
  // should never appear by accident.
  for (const k of ['effort', 'model', 'allowedTools', 'permissionMode', 'mcpConfig', 'chrome']) {
    if (wanted[k] !== undefined) cfg[k] = wanted[k];
  }
  return cfg;
}

// Persists the new peer into the hub's own net-config.json, so it survives a restart. The runtime
// side (hub.addPeer) is what makes it work WITHOUT one.
function persistPeer(name) {
  const raw = readJsonFile(NET_CONFIG_FILE);
  raw.peers = Array.isArray(raw.peers) ? raw.peers : [];
  if (!raw.peers.includes(name)) {
    raw.peers.push(name);
    fs.writeFileSync(NET_CONFIG_FILE, JSON.stringify(raw, null, 2) + '\n');
  }
  // Keep the in-memory copy in step, so a later provisioning in the same session sees it too.
  netConfig.peers = raw.peers;
}

// Returns { error } when nothing was started, or { code, name } once the window is open.
function startProvisioning(wanted) {
  if (!netConfig || netConfig.role !== 'hub') {
    return { error: 'This machine is not the hub, so it cannot enroll anyone.' };
  }
  if (wanted._malformed) {
    return { error: 'I garbled the setup details. Could you say that again?' };
  }
  const name = String(wanted.self || '').toLowerCase().trim();
  if (!enrollmentLib.isValidName(name)) {
    return { error: `I can't use "${wanted.self || ''}" as an agent name. It needs lowercase letters, digits, dashes or underscores.` };
  }
  if (enrollment && enrollment.isOpen()) {
    return { error: 'There is already an enrollment window open. Let that one finish or expire first.' };
  }
  if (fs.existsSync(path.join(__dirname, 'certs', `${name}-cert.pem`))) {
    return { error: `An agent called "${name}" already exists on this network. Pick a different name.` };
  }
  // The spoken name and the responsibility become the hub's record the moment the machine joins (see
  // onEnrolled), so they meet the same rules as /agent here -- before a code is read out, not after
  // the new machine is already paired.
  const spokenName = (wanted.agentName === undefined || wanted.agentName === '')
    ? name.charAt(0).toUpperCase() + name.slice(1)
    : agentRegistry.cleanName(wanted.agentName);
  if (!spokenName) {
    return { error: `I can't use "${wanted.agentName}" as its spoken name. It has to start with a letter and use only letters, digits, spaces or dashes.` };
  }
  if (nameHeldBy(spokenName, name)) {
    return { error: `The name ${spokenName} is already taken on this network. Pick a different one.` };
  }
  const domain = agentRegistry.cleanDomain(typeof wanted.domain === 'string' ? wanted.domain : '');
  if (domain === null) {
    return { error: 'That description of what it is for is too long. One sentence is enough.' };
  }
  const settled = Object.assign({}, wanted, { agentName: spokenName, domain });
  const code = enrollmentLib.generateCode();
  try {
    enrollment = enrollmentLib.startEnrollmentListener({
      selfName: netConfig.self,
      certDir: path.join(__dirname, 'certs'),
      port: ENROLL_PORT,
      code,
      expectedName: name,
      buildConfig: (n) => buildNodeConfig(n, settled),
      onEnrolled: (n) => {
        persistPeer(n);
        // Recorded here, with the peer, rather than at first contact: this is where the user's own
        // decision -- the name and purpose they gave, confirmed by typing the pairing code on the new
        // machine -- is final. Failing to write it is no reason to fail the pairing; the machine then
        // introduces itself and waits for /agent confirm, like one enrolled before records existed.
        try {
          agentRecords.set(n, { name: settled.agentName, domain: settled.domain });
        } catch (e) {
          console.error(`[enroll] could not record the name and responsibility of "${n}":`, e.message);
        }
        if (hub) hub.addPeer(n);
      },
      onClosed: () => { enrollment = null; },
      onFailed: (why) => tellUser(`The pairing window could not be opened: ${why}. Nothing is waiting for a new agent, so that code is void.`)
    });
  } catch (e) {
    console.error('[enroll] could not open the enrollment window:', e.message);
    return { error: 'I could not open the enrollment window. The console has the details.' };
  }
  // The console is the reliable channel -- speech recognition of a code is not something to rely
  // on, and this is printed where it can be read and retyped exactly.
  console.log('');
  console.log(`  Enrolling a new agent: "${name}"`);
  console.log(`  On the NEW machine run:   enroll.bat ${getLanIp()} ${code}`);
  console.log(`  Valid for ${enrollmentLib.ENROLL_TIMEOUT_MS / 60000} minutes, ${enrollmentLib.MAX_ATTEMPTS} attempts.`);
  console.log('');
  return { code, name };
}

// Sets the main display by hand -- this is the actual "low effort" way to reassign the role (no
// config edit, no restart). Permanently overrides an automatic hello assignment
// (mainDisplaySetManually), so a reconnecting node with "mainDisplay":true in its config doesn't
// accidentally undo this deliberate decision.
// "/maindisplay off": no main display at all, so every agent presents on its own screen again.
// Recorded as a manual decision, just like naming one -- otherwise the next node with
// "mainDisplay": true in its config would quietly take the role back on its next connect.
function clearMainDisplay() {
  const oldTarget = mainDisplayTarget;
  mainDisplayTarget = null;
  mainDisplaySetManually = true;
  if (oldTarget && oldTarget.nodeName !== null && hub && hub.isUp(oldTarget.nodeName)) {
    try { hub.send(oldTarget.nodeName, { type: 'clear-presentation' }); } catch (e) {}
  }
  currentPresentation = null;
  presentationOwnerRequestId = null;
  console.log('No main display any more -- every agent presents on its own screen.');
  broadcastPeerLists();
  refreshSkillData();
}

function setMainDisplay(rawName) {
  const resolved = resolveKnownName(rawName);
  if (!resolved) {
    console.log(`Unknown name: "${rawName}". /network shows the known agents.`);
    return;
  }
  if (!isReachable(resolved)) {
    console.log(`"${resolved}" is currently unreachable.`);
    return;
  }
  const oldTarget = mainDisplayTarget;
  const nodeName = resolved === AGENT.name ? null : remoteAgents.get(resolved).nodeName;
  mainDisplayTarget = { agentName: resolved, nodeName };
  mainDisplaySetManually = true;
  // Otherwise the OLD target node (if remote and different from the new one) is left with a
  // stale presentation the hub no longer considers current.
  if (oldTarget && oldTarget.nodeName !== null && oldTarget.nodeName !== nodeName && hub && hub.isUp(oldTarget.nodeName)) {
    try { hub.send(oldTarget.nodeName, { type: 'clear-presentation' }); } catch (e) {}
  }
  currentPresentation = null;
  presentationOwnerRequestId = null;
  console.log(`Main display is now "${resolved}".`);
  broadcastPeerLists();
  refreshSkillData();
}


// Oscar answers himself.
function askOscarDirectly(userText, myRequestId) {
  // Aborts Oscar's own still-running work, in case he's being addressed again right now
  // (barge-in, direct request). For a follow-up dispatch from advanceFollowUpQueue he's already
  // free thanks to the busyTargets check there anyway -- this then just kills an already-empty
  // child process (a no-op).
  interruptTarget(HUB_TARGET);
  rememberRouted(AGENT.name, null);
  activeRequestByTarget.set(HUB_TARGET, myRequestId);
  busyTargets.add(HUB_TARGET);
  setOverlayState({ status: 'thinking', text: '', agent: AGENT.name });

  refreshSkillData();

  // Only events go into the message: who joined or left since Oscar's last turn, and files that
  // just arrived. Standing facts live in his skills and their data files -- agent-skills/README.md.
  const rosterNow = Array.from(remoteAgents.keys());
  const rosterEvent = agentHome.describeRosterChange(rosterAtLastTurn, rosterNow);
  rosterAtLastTurn = rosterNow;
  const inboxEvent = inboxLib.buildInboxEvent(inboxLib.listInbox(__dirname), newInboxFiles);
  newInboxFiles.clear();
  const events = `${rosterEvent} ${inboxEvent}`.trim();

  // The message goes in on stdin (claude-cli.js): no length limit, and line breaks survive. On the command
  // line a long pasted text ended Nova's whole process, and a line break once truncated a message.
  const prompt = sessionId
    ? [userText, events].filter(Boolean).join('\n\n')
    : [`You are ${AGENT.name}, the central coordinator of a network of AI assistant colleagues. ${AGENT.personality}`, events, `Message: ${userText}`].filter(Boolean).join('\n\n');
  const args = ['-p'];
  if (sessionId) args.push('--resume', sessionId);
  // Only a pointer to the skills, through --append-system-prompt rather than the message -- see
  // buildSystemPointer for why. Identical on every turn, so it no longer breaks the prompt cache.
  args.push('--append-system-prompt', buildSystemPointer({ agentName: AGENT.name, canProvision: true }));
  args.push('--output-format', 'json');
  if (AGENT.effort) args.push('--effort', AGENT.effort);
  if (AGENT.model) args.push('--model', AGENT.model);
  // What Oscar may do comes only from his verified permissions (permissions.js), set and confirmed on
  // this machine's face page. The measured facts behind every switch -- Edit rules, Skill, the shell
  // being blocked by name -- are recorded next to claudePermissionArgs. Read access needs no grant
  // (verified live: a restricted agent describes a dropped image correctly).
  const turnPermissions = permissionStore.effective();
  args.push(...permissionsLib.claudePermissionArgs(turnPermissions, {
    contentDir: CONTENT_DIR_FOR_PROMPT, inboxDir: INBOX_DIR_FOR_PROMPT, workspaceDir: WORKSPACE_DIR,
    projectDir: null, extraTools: permissionsLib.extraToolsFrom(AGENT.allowedTools), mcpConfig: AGENT.mcpConfig
  }));

  // This checkout, for writing presentations and handling inbox files. An --add-dir does not load
  // its CLAUDE.md (measured), so the developer docs stay out of Oscar's context.
  args.push('--add-dir', __dirname);
  const child = startClaude(CLAUDE_EXE, args, prompt, { cwd: HOME });
  currentClaudeChild = child;

  let out = '';
  let errOut = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { errOut += d.toString(); });

  child.on('error', (err) => {
    if (currentClaudeChild === child) currentClaudeChild = null;
    targetFreed(HUB_TARGET);
    if (myRequestId !== activeRequestByTarget.get(HUB_TARGET)) return; // superseded by newer input, discard
    console.error('Could not start "claude":', err.message);
    say('I can\'t find the Claude CLI right now.', myRequestId, AGENT.name, false);
  });

  child.on('close', (code) => {
    if (currentClaudeChild === child) currentClaudeChild = null;
    targetFreed(HUB_TARGET);
    if (myRequestId !== activeRequestByTarget.get(HUB_TARGET)) return; // superseded by newer input (e.g. aborted), discard
    if (code !== 0) {
      console.error('claude CLI error:', errOut);
      say('Something just went wrong.', myRequestId, AGENT.name, false);
      return;
    }
    let text = '';
    try {
      const parsed = JSON.parse(out);
      text = parsed.result || '';
      if (parsed.session_id) {
        sessionId = parsed.session_id;
        saveSessionId(sessionId);
      }
      // Surface tokens for usage monitoring -- newly processed (full price) shown separately from
      // read-from-cache (much cheaper), so a cost spike is visible in the log instead of only
      // guessable from the usage-limit percentage (see the 2026-08-18 incident: 30%->71% from a
      // single call, with no way to tell from the log whether it was cache expiry).
      const u = parsed.usage;
      if (u) {
        console.log(`[${AGENT.name}] Tokens: ${u.cache_creation_input_tokens || 0} new, ${u.cache_read_input_tokens || 0} from cache, ${u.output_tokens || 0} reply.`);
      }
    } catch (e) {
      text = out.trim();
    }
    // The presentation marker is extracted FIRST (it's the outermost one, see followup-tag.js),
    // FORWARD only afterward on the rest -- so Oscar can combine both in a single reply.
    const { cleanText: afterPresentation, presentationUrl: rawPresentationUrl } = extractPresentationTag(text);
    // The file name of one of Oscar's own pages, or a website's address -- see ownPageName and isWebsite
    // in overlay-server.js. An old-style link from his conversation history still counts as a file name.
    const presentationUrl = rawPresentationUrl ? rawPresentationUrl.trim() : rawPresentationUrl;
    // Before FORWARD, for the same reason PRESENTATION is: FORWARD's regex is end-anchored, so a
    // marker sitting after it would make that extraction miss.
    const { cleanText: afterProvision, provision } = extractProvisionTag(afterPresentation);
    // Oscar's own name and responsibility are part of the hub, not a record, so there is nothing for
    // him to request -- the network skill says so. Cut out anyway, or it would be read aloud.
    const { cleanText: afterIdentity, identityRequest: ownIdentityRequest } = extractIdentityTag(afterProvision);
    if (ownIdentityRequest) console.log(`[${AGENT.name}] Ignored an [IDENTITY: ...] marker in Oscar's own reply -- his name and responsibility are set in the hub's code.`);
    const { cleanText, suggested: markedNext } = extractFollowUpTag(afterIdentity);
    // Involving others is one of Oscar's permissions: switched off, a FORWARD marker is still removed
    // from what is spoken, just not acted on.
    const suggested = turnPermissions.forward ? markedNext : [];
    if (markedNext.length && !turnPermissions.forward) console.log(`[${AGENT.name}] Not involving ${markedNext.join(', ')} -- switched off in his permissions.`);
    // Split unconditionally, not only when actually presenting: a [SLIDE] marker that survived
    // into the TTS would be read out loud ("bracket slide"). Rejoining the segments is what the
    // non-presenting paths below speak, so a stray marker simply disappears.
    const slideSegments = splitSlideSegments(cleanText);
    const spokenText = slideSegments.join(' ');
    // See the same line in node-agent.js: shows the RAW marker before any check, otherwise
    // "nothing attempted" can't be told apart from "attempted, but discarded".
    console.log(`[${AGENT.name}] Marker in raw text: ${markedNext.length ? markedNext.join(', ') : '(none)'}`);
    console.log(`[${AGENT.name}] Presentation marker: ${presentationUrl ? presentationLabel(presentationUrl) : '(none)'}${slideSegments.length > 1 ? `, ${slideSegments.length} slides` : ''}`);
    // Provisioning is handled before presenting: it changes what Oscar has to SAY (the pairing
    // code has to be read out, and only the hub knows it -- the model cannot have put it in its
    // own reply), so the spoken text is rewritten here before it reaches synthesis.
    if (provision && !turnPermissions.provision) console.log(`[${AGENT.name}] Ignored a [PROVISION: ...] marker -- setting up new agents is switched off in his permissions.`);
    if (provision && turnPermissions.provision) {
      const res = startProvisioning(provision);
      const extra = res.error
        ? ` ${res.error}`
        : ` Your pairing code is: ${speakableCode(res.code)} It is also printed on my console, and it is valid for ${enrollmentLib.ENROLL_TIMEOUT_MS / 60000} minutes. On the new machine, run enroll dot bat with my address and that code.`;
      say((spokenText + extra).trim(), myRequestId, AGENT.name, true, suggested);
      return;
    }
    if (presentationUrl && !turnPermissions.presentations) console.log(`[${AGENT.name}] Not presenting ${presentationLabel(presentationUrl)} -- switched off in his permissions.`);
    if (presentationUrl && turnPermissions.presentations) {
      // With a main display the deck goes there; without one Oscar shows it on his own screen.
      // presentFromOscar decides which (user's decision 2026-09-15: no main display means
      // everyone presents on their own).
      presentFromOscar(slideSegments, myRequestId, presentationUrl, suggested);
      return;
    }
    say(spokenText, myRequestId, AGENT.name, true, suggested);
  });
}

// Everything /agent and /network say goes to the console and to Oscar's chat page, since either is
// where the user may have typed it. Both are local-only -- the chat page refuses input from anywhere
// but this machine (see overlay-server.js) -- which is what makes a typed /agent the user's decision.
function tellUser(text, chatText = text) {
  console.log(text);
  overlay.pushChat({ agent: AGENT.name, from: 'system', text: chatText });
}

function announcePendingIdentity(nodeName, shownAs) {
  const introduced = pendingIdentity.get(nodeName);
  if (!introduced) return;
  const key = JSON.stringify([introduced.kind, introduced.name, introduced.domain, introduced.reason]);
  if (announcedIntroductions.get(nodeName) === key) return;
  announcedIntroductions.set(nodeName, key);
  if (introduced.kind === 'request') { announceRequest(nodeName, introduced); return; }
  const who = introduced.name ? `calls itself "${introduced.name}"` : 'gave no usable name';
  const what = introduced.domain ? `, responsible for: ${introduced.domain}` : '';
  const intro = agentHome.closeSentence(`It ${who}${what}`);
  tellUser([
    `[network] The hub has no record of "${nodeName}" yet. ${intro}`,
    `[network] Until you decide, it is listed as "${shownAs}" with no responsibility, so nothing is routed to it by topic.`,
    `[network]   /agent confirm ${nodeName}   accepts that`,
    `[network]   /agent name ${nodeName} <Name>  and  /agent domain ${nodeName} <text>   set it yourself`
  ].join('\n'), `"${nodeName}" is new to the hub. ${intro} Until you decide, it is listed as ${shownAs} with no responsibility. Type /agent confirm ${nodeName} or use the buttons at the top of this page to accept that, or set it yourself with /agent name ${nodeName} <Name> and /agent domain ${nodeName} <text>.`);
}

// A machine said hello: admit it under the name the hub decides (admitIdentity), then bring the
// overlay, every node and Oscar's own skill data up to date.
function admitNode(nodeName, hello) {
  const who = admitIdentity(nodeName, hello);
  if (!who) {
    tellUser(`[network] "${nodeName}" connected, but neither the name it gave nor "${nodeName}" is free. Give it one with /agent name ${nodeName} <Name>.`);
    return;
  }
  // A machine saying hello again -- a reconnect, or renamed while it was offline -- must not leave an
  // entry under its previous name behind, nor a main display that still points at that name.
  const previous = agentNameOfNode(nodeName);
  if (previous && previous !== who.name) remoteAgents.delete(previous);
  remoteAgents.set(who.name, { nodeName, domain: who.domain, screen: normalizeScreen(hello.screen) });
  if (mainDisplayTarget && mainDisplayTarget.nodeName === nodeName) mainDisplayTarget.agentName = who.name;
  console.log(`[network] Agent "${who.name}" on node "${nodeName}" is here.${who.domain ? ' Responsible for: ' + who.domain : ''}`);
  if (!who.recorded) announcePendingIdentity(nodeName, who.name);
  if (hello.mainDisplay === true && !mainDisplaySetManually) {
    mainDisplayTarget = { agentName: who.name, nodeName };
    console.log(`[maindisplay] "${who.name}" is now automatically the main display (configuration).`);
  }
  // If this (newly connecting/reconnecting) node is currently the main display, but the hub itself
  // isn't tracking any presentation (e.g. after a hub restart), the node might still be showing a
  // stale local presentation -- sync it to be safe.
  if (mainDisplayTarget && mainDisplayTarget.nodeName === nodeName && !currentPresentation) {
    try { hub.send(nodeName, { type: 'clear-presentation' }); } catch (e) {}
  }
  // Same here: immediately send out the expanded name list, so "Nova, ..." also works right away
  // even if the browser was already open BEFORE she connected.
  setOverlayState(overlay.getState());
  broadcastPeerLists(); // every node (including the new one) gets the current roster view
  refreshSkillData();
  const queued = queuedDeclines.get(nodeName);
  if (queued) {
    queuedDeclines.delete(nodeName);
    sendDecline(nodeName, queued);
  }
}

// A rename in the middle of work would strand that work under the old name: the running request, a
// held-back reaction, a queued or relayed presentation and the rest of a follow-up chain are all
// keyed by it. Waiting until the agent is quiet is simpler than moving all of them.
function agentIsBusy(name) {
  if (busyTargets.has(name) || pendingReactionByTarget.has(name)) return true;
  if (displayQueue.some((entry) => entry.targetKey === name)) return true;
  for (const relay of presentationRelays.values()) if (relay.agentName === name) return true;
  for (const names of followUpQueues.values()) if (Array.isArray(names) && names.includes(name)) return true;
  return false;
}

// Every change to pendingIdentity goes through these two, so the buttons on the hub's page always show
// exactly what is waiting.
function setPending(nodeName, entry) {
  pendingIdentity.set(nodeName, Object.assign({ id: require('crypto').randomBytes(9).toString('hex'), reason: '' }, entry));
  pushDecisions();
}

function clearPending(nodeName) {
  if (pendingIdentity.delete(nodeName)) pushDecisions();
}

function pendingDecisions() {
  return Array.from(pendingIdentity, ([nodeName, pending]) => {
    const record = agentRecords.get(nodeName);
    return {
      id: pending.id, machine: nodeName, kind: pending.kind,
      currentName: (record && record.name) || agentNameOfNode(nodeName) || nodeName,
      currentDomain: record ? record.domain : '',
      name: pending.name, domain: pending.domain, reason: pending.reason || ''
    };
  });
}

function pushDecisions() {
  overlay.pushDecisions(pendingDecisions());
}

// A recorded agent asks for its own name or responsibility to change. What can be refused mechanically
// is refused right away, with a code the node turns into a fixed sentence for the agent; everything else
// waits for the user, and none of it takes effect before the user accepts. The machine it applies to is
// the one whose certificate the request arrived with -- nothing in the message can name another.
function receiveIdentityRequest(nodeName, msg) {
  const record = agentRecords.get(nodeName);
  if (!record) return declineIdentityRequest(nodeName, 'unconfirmed');
  const name = typeof msg.name === 'string' && msg.name.trim() ? agentRegistry.cleanName(msg.name) : record.name;
  const domain = typeof msg.domain === 'string' ? agentRegistry.cleanDomain(msg.domain) : record.domain;
  const reason = agentRegistry.cleanText(msg.reason, agentRegistry.REASON_MAX);
  if (msg.malformed === true || !name || domain === null || !reason) return declineIdentityRequest(nodeName, 'invalid');
  if (name === record.name && domain === record.domain) return declineIdentityRequest(nodeName, 'unchanged');
  if (name !== record.name && nameHeldBy(name, nodeName)) return declineIdentityRequest(nodeName, 'name-taken');
  setPending(nodeName, { kind: 'request', name, domain, reason });
  announcePendingIdentity(nodeName, record.name);
}

function declineIdentityRequest(nodeName, code) {
  console.log(`[network] A request from "${nodeName}" to change its name or responsibility was not passed on (${code}).`);
  sendDecline(nodeName, code);
}

function sendDecline(nodeName, code) {
  if (hub && hub.isUp(nodeName)) {
    try { hub.send(nodeName, { type: 'identity-declined', reason: code }); return; } catch (e) { /* queued below */ }
  }
  queuedDeclines.set(nodeName, code);
}

// A recorded agent's own request as the user sees it: what would change, and the reason it gave.
function announceRequest(nodeName, pending) {
  const record = agentRecords.get(nodeName) || { name: pending.name, domain: '' };
  const changes = [];
  if (pending.name !== record.name) changes.push(`name "${record.name}" -> "${pending.name}"`);
  if (pending.domain !== record.domain) changes.push(`responsibility -> "${pending.domain}"`);
  const reason = agentHome.closeSentence(`Reason given: ${pending.reason}`);
  tellUser([
    `[network] ${record.name} (${nodeName}) asks for a change: ${changes.join('; ')}.`,
    `[network] ${reason}`,
    `[network]   /agent confirm ${nodeName}  or  /agent reject ${nodeName}  -- or the buttons on http://localhost:${PORT}/`
  ].join('\n'), `${record.name} asks for a change: ${changes.join('; ')}. ${reason} Use the buttons at the top of this page, or type /agent confirm ${nodeName} or /agent reject ${nodeName}.`);
}

// The user's answer to what is waiting for a machine: /agent confirm|reject, or a button (decideById).
function decideIdentity(nodeName, accept) {
  const pending = pendingIdentity.get(nodeName);
  if (!pending) return tellUser(`Nothing from "${nodeName}" is waiting for a decision.`);
  if (!accept) {
    clearPending(nodeName);
    if (pending.kind === 'request') {
      sendDecline(nodeName, 'user');
      return tellUser(`Declined: "${nodeName}" keeps its name and responsibility.`);
    }
    declinedIntroductions.set(nodeName, JSON.stringify({ name: pending.name, domain: pending.domain }));
    return tellUser(`Dismissed how "${nodeName}" introduced itself. It stays listed without a responsibility until you set one with /agent name or /agent domain.`);
  }
  const record = agentRecords.get(nodeName);
  const currentName = (record && record.name) || agentNameOfNode(nodeName) || nodeName.charAt(0).toUpperCase() + nodeName.slice(1);
  setIdentity(nodeName, { name: pending.name || currentName, domain: pending.domain });
  pushDecisions(); // if setIdentity refused (name taken, agent busy), the card stays and its buttons come back
}

// A decision as this PC's confirmation dialog states it -- from the hub's own record of the request, never
// from the card an agent may have reworded. The name is checked; a responsibility is an agent's own words,
// so it is quoted, shortened, and cleaned of anything invisible (device-confirm.js).
function quoteForDialog(text) {
  const clean = deviceConfirm.cleanText(text || 'nothing');
  return `"${clean.length > 120 ? `${clean.slice(0, 119)}…` : clean}"`;
}

function describeDecision(nodeName, pending, accept) {
  if (!accept) {
    return pending.kind === 'request'
      ? `AliveAgents: decline the change machine ${nodeName} asked for. Its name and responsibility stay as they are.`
      : `AliveAgents: dismiss how machine ${nodeName} introduced itself. Nothing is recorded.`;
  }
  const record = agentRecords.get(nodeName);
  if (pending.kind === 'request') {
    const changes = [];
    if (record && pending.name !== record.name) changes.push(`it will be called ${pending.name}`);
    if (!record || pending.domain !== record.domain) changes.push(`it will be responsible for ${quoteForDialog(pending.domain)}`);
    return `AliveAgents: accept for machine ${nodeName}: ${changes.join(', and ')}.`;
  }
  const name = pending.name || (record && record.name) || agentNameOfNode(nodeName) || nodeName.charAt(0).toUpperCase() + nodeName.slice(1);
  return `AliveAgents: record machine ${nodeName} as ${name}, responsible for ${quoteForDialog(pending.domain)}.`;
}

// A click on a decision card only asks. An agent that can control the browser can press the button or
// reword the card, so this PC's own dialog states the decision, and nothing is decided before the user says
// yes there. reply answers the page that clicked.
async function decideById(id, accept, reply = () => {}) {
  let found = null;
  for (const [nodeName, pending] of pendingIdentity) {
    if (pending.id === id) found = { nodeName, pending };
  }
  if (!found) {
    tellUser('That request is no longer waiting: it was already decided, or replaced by a newer one.');
    pushDecisions();
    return reply({ error: 'This request is no longer waiting.' });
  }
  const answer = await confirmer.ask(describeDecision(found.nodeName, found.pending, accept));
  if (!answer.ok) {
    console.log(`[network] Nothing decided about "${found.nodeName}": ${answer.reason}`);
    return reply({ error: `${answer.reason} Nothing changed.` });
  }
  // The dialog described the request as it was when it opened; a newer one may have replaced it since.
  if (pendingIdentity.get(found.nodeName) !== found.pending) {
    pushDecisions();
    return reply({ error: 'The request changed while the dialog was open, so nothing was decided. Look at it again.' });
  }
  decideIdentity(found.nodeName, accept);
  reply({ ok: true });
}

// The one place a name or responsibility changes. Written to disk first, then applied to the running
// network, so a change the file did not take never shows up anywhere.
function setIdentity(nodeName, wanted) {
  const name = agentRegistry.cleanName(wanted.name);
  if (!name) return tellUser(`"${wanted.name}" cannot be a name: 1 to 32 letters, digits, spaces, dashes or underscores, starting with a letter.`);
  const domain = agentRegistry.cleanDomain(wanted.domain);
  if (domain === null) return tellUser(`That responsibility is too long: ${agentRegistry.DOMAIN_MAX} characters at most. One sentence is enough.`);
  const held = nameHeldBy(name, nodeName);
  if (held) return tellUser(`"${name}" is taken: ${held}.`);
  const current = agentNameOfNode(nodeName);
  if (current && current !== name && agentIsBusy(current)) {
    return tellUser(`${current} is in the middle of something. Try the rename again once it is quiet, or after /reset.`);
  }
  try {
    agentRecords.set(nodeName, { name, domain });
  } catch (e) {
    return tellUser(`Could not save that to ${NET_CONFIG_FILE}: ${e.message}`);
  }
  clearPending(nodeName);
  announcedIntroductions.delete(nodeName);
  declinedIntroductions.delete(nodeName);
  if (mainDisplayTarget && mainDisplayTarget.nodeName === nodeName) mainDisplayTarget.agentName = name;
  if (lastRoutedTarget && lastRoutedTarget.nodeName === nodeName) lastRoutedTarget.agentName = name;
  if (current) {
    const info = remoteAgents.get(current);
    info.domain = domain;
    if (current !== name) {
      remoteAgents.delete(current);
      remoteAgents.set(name, info);
      if (activeRequestByTarget.has(current)) {
        activeRequestByTarget.set(name, activeRequestByTarget.get(current));
        activeRequestByTarget.delete(current);
      }
    }
    setOverlayState(overlay.getState());
    broadcastPeerLists();
    refreshSkillData();
  } else if (hub && hub.isUp(nodeName) && lastHello.has(nodeName)) {
    admitNode(nodeName, lastHello.get(nodeName));
  }
  tellUser(agentHome.closeSentence(`"${nodeName}" is now ${name}, responsible for: ${domain || `nothing yet (/agent domain ${nodeName} <text>)`}`));
}

// A machine by its certificate name or by the name it is spoken to by -- whichever the user typed.
// Only machines this hub has enrolled count.
function resolveMachine(word) {
  const enrolled = netConfig && Array.isArray(netConfig.peers) ? netConfig.peers : [];
  const lower = String(word || '').toLowerCase();
  if (enrolled.includes(lower)) return lower;
  for (const [name, info] of remoteAgents) {
    if (name.toLowerCase() === lower && enrolled.includes(info.nodeName)) return info.nodeName;
  }
  const recorded = agentRecords.nodeWithName(word);
  return recorded && enrolled.includes(recorded) ? recorded : null;
}

const AGENT_USAGE = [
  'Who each agent is -- changed only by you, never by an agent:',
  '  /agent confirm <machine>          accept what a machine introduced or an agent asked for',
  '  /agent reject <machine>           decline it',
  '  /agent name <machine> <Name>      the name it is spoken to by',
  '  /agent domain <machine> <text>    what it is responsible for',
  '<machine> is its certificate name (e.g. toby) or its current one-word name. /network lists them.',
  `Requests also appear with Accept and Decline buttons on http://localhost:${PORT}/.`
].join('\n');

const AGENT_COMMAND_RE = /^(confirm|reject|name|domain)\s+(\S+)\s*([\s\S]*)$/i;

// What a typed /agent would change, worded for the confirmation dialog -- or null when it changes nothing
// (usage, an unknown machine, nothing waiting, a name that is refused anyway). stillCurrent tells whether
// what the dialog described is still what the command would act on.
function describeAgentCommand(args) {
  const match = AGENT_COMMAND_RE.exec(args);
  if (!match) return null;
  const verb = match[1].toLowerCase();
  const value = match[3].trim();
  const nodeName = resolveMachine(match[2]);
  if (!nodeName) return null;
  const pending = pendingIdentity.get(nodeName);
  const recordThen = JSON.stringify(agentRecords.get(nodeName) || null);
  const stillCurrent = () => pendingIdentity.get(nodeName) === pending && JSON.stringify(agentRecords.get(nodeName) || null) === recordThen;
  if (verb === 'confirm' || verb === 'reject') {
    return pending ? { text: describeDecision(nodeName, pending, verb === 'confirm'), stillCurrent } : null;
  }
  if (verb === 'name') {
    const name = agentRegistry.cleanName(value);
    if (!name || nameHeldBy(name, nodeName)) return null;
    return { text: `AliveAgents: machine ${nodeName} will be called ${name}.`, stillCurrent };
  }
  const domain = agentRegistry.cleanDomain(value);
  if (!value || domain === null) return null;
  return { text: `AliveAgents: machine ${nodeName} will be responsible for ${quoteForDialog(domain)}.`, stillCurrent };
}

// /agent typed into the hub's page changes nothing until this PC's confirmation dialog has said what it
// will do: a browser an agent controls can type there too. What changes nothing is answered right away.
async function confirmTypedAgentCommand(args) {
  const plan = describeAgentCommand(args);
  if (!plan) return agentCommand(args);
  const answer = await confirmer.ask(plan.text);
  if (!answer.ok) return tellUser(`${answer.reason} Nothing changed. /agent also works in the console window.`);
  if (!plan.stillCurrent()) return tellUser('Something changed while the dialog was open, so nothing was done. Type it again.');
  agentCommand(args);
}

function agentCommand(args) {
  const match = AGENT_COMMAND_RE.exec(args);
  if (!match) return tellUser(AGENT_USAGE);
  const verb = match[1].toLowerCase();
  const value = match[3].trim();
  const nodeName = resolveMachine(match[2]);
  if (!nodeName) return tellUser(`No machine called "${match[2]}" is enrolled on this network. /network lists them.`);
  const record = agentRecords.get(nodeName);
  const pending = pendingIdentity.get(nodeName);
  const currentName = (record && record.name) || agentNameOfNode(nodeName) || (pending && pending.name)
    || nodeName.charAt(0).toUpperCase() + nodeName.slice(1);
  if (verb === 'confirm' || verb === 'reject') {
    if (pending) return decideIdentity(nodeName, verb === 'confirm');
    return tellUser(record
      ? `Nothing from "${nodeName}" is waiting for a decision. Its record: ${agentHome.closeSentence(`${record.name}, responsible for: ${record.domain || 'nothing yet'}`)} Change it with /agent name or /agent domain.`
      : `"${nodeName}" has not introduced itself since the hub started. It will once it connects.`);
  }
  if (!value) return tellUser(AGENT_USAGE);
  // Setting one half never adopts the other half of an unconfirmed introduction: a name alone keeps
  // the responsibility empty, and a responsibility alone keeps the name the machine is listed under.
  if (verb === 'name') return setIdentity(nodeName, { name: value, domain: record ? record.domain : '' });
  return setIdentity(nodeName, { name: currentName, domain: value });
}

// Every enrolled machine, connected or not, with who the hub says it is -- and, for one without a
// record, how it introduced itself.
function describeNetwork() {
  const enrolled = netConfig && Array.isArray(netConfig.peers) ? netConfig.peers : [];
  if (!enrolled.length) return 'No agents are enrolled on this network yet.';
  return enrolled.map((nodeName) => {
    const record = agentRecords.get(nodeName);
    const name = agentNameOfNode(nodeName);
    const shown = name || (record && record.name) || '(no name yet)';
    const state = name && hub && hub.isUp(nodeName) ? 'connected' : 'offline';
    const line = `${shown} (${nodeName}) - ${record ? (record.domain || 'no responsibility set') : 'no record yet'}: ${state}`;
    const introduced = pendingIdentity.get(nodeName);
    if (!introduced) return line;
    if (introduced.kind === 'request') {
      return `${line}\n    asks to become ${introduced.name}, responsible for: ${introduced.domain || 'nothing'} -- reason: ${introduced.reason} -- /agent confirm ${nodeName} or /agent reject ${nodeName}`;
    }
    return `${line}\n    introduced itself as ${introduced.name ? `"${introduced.name}"` : '(no usable name)'}${introduced.domain ? `, responsible for: ${introduced.domain}` : ''} -- /agent confirm ${nodeName}`;
  }).join('\n');
}

// source: 'console' (typed into this process), 'typed' (the chat box on the hub's own page) or 'voice'
// (the microphone). Only the first two may change who an agent is -- see /agent below.
function askAgent(userText, targetAgent = null, source = 'console') {
  // A pasted text beyond what an agent can take is turned away here, with a sentence in the chat it came
  // from, before anyone is interrupted or anything is sent on (claude-cli.js).
  if (userText.length > MESSAGE_MAX_CHARS) {
    const sentence = tooLongSentence(userText.length);
    console.log(`[input] ${sentence}`);
    overlay.pushChat({ agent: targetAgent || AGENT.name, from: 'system', text: sentence });
    return;
  }
  if (userText === '/reset') {
    sessionId = null;
    try { fs.unlinkSync(SESSION_FILE); } catch (e) {}
    lastRoutedTarget = null; // a deliberate restart should no longer "stick" to the last agent
    followUpQueues.clear(); originalQuestionByRequest.clear(); lastAnswerByRequest.clear(); chainLengthByRequest.clear();
    activeRequestByTarget.clear(); busyTargets.clear(); pendingReactionByTarget.clear(); displayQueue.length = 0;
    for (const timer of routeWatchdogs.values()) clearTimeout(timer);
    routeWatchdogs.clear();
    currentPresentation = null; presentationOwnerRequestId = null; presentationRelays.clear();
    if (hub) hub.broadcast({ type: 'reset' }); // reset remote agents too (including clear-presentation there, see node-agent.js)
    console.log('Conversation reset. The next message starts a new session.');
    return;
  }
  if (userText === '/network') {
    tellUser(describeNetwork());
    return;
  }
  // An agent's name and responsibility: the only way either changes (see agent-registry.js).
  if (userText === '/agent' || userText.startsWith('/agent ')) {
    // Never by voice: speech recognition turns whatever is said near the microphone into text, and
    // another agent's loudspeaker is exactly that. A change has to be typed or clicked.
    if (source === 'voice') {
      tellUser('Changing who an agent is has to be typed or clicked on this page, not spoken.');
      return;
    }
    // Typed on the page: a browser an agent controls can type there too, so this PC's confirmation
    // dialog has to say what the command does first. Typed into the console window it applies directly.
    if (source === 'typed') {
      confirmTypedAgentCommand(userText.slice('/agent'.length).trim());
      return;
    }
    agentCommand(userText.slice('/agent'.length).trim());
    return;
  }
  if (userText === '/maindisplay') {
    console.log(mainDisplayTarget ? `Main display is currently "${mainDisplayTarget.agentName}".` : 'No main display assigned.');
    return;
  }
  if (['/maindisplay off', '/maindisplay none'].includes(userText.toLowerCase())) {
    clearMainDisplay();
    return;
  }
  if (userText.startsWith('/maindisplay ')) {
    setMainDisplay(userText.slice('/maindisplay '.length).trim());
    return;
  }
  // The same operation Oscar triggers via [PROVISION: ...], reachable by hand -- useful when the
  // microphone is not the convenient way in, and as the fallback if a spoken setup goes sideways.
  if (userText.startsWith('/provision ')) {
    const res = startProvisioning({ self: userText.slice('/provision '.length).trim() });
    if (res.error) console.log(res.error);
    return;
  }
  if (userText === '/provision') {
    console.log('Usage: /provision <name>   (lowercase, e.g. "ada")');
    return;
  }

  const myRequestId = ++requestId;

  // Typed straight into one agent's chat box: no name matching, no classification, no follow-up
  // window -- the recipient was already chosen by clicking on them. Falls through to normal
  // routing if that agent is not reachable, so a stale panel cannot swallow the message.
  if (targetAgent) {
    overlay.pushChat({ agent: targetAgent, from: 'you', text: userText });
    if (targetAgent === AGENT.name) {
      clearDisplay();
      originalQuestionByRequest.set(myRequestId, userText);
      askOscarDirectly(userText, myRequestId);
      return;
    }
    const info = remoteAgents.get(targetAgent);
    if (info && hub && hub.isUp(info.nodeName)) {
      clearDisplay();
      originalQuestionByRequest.set(myRequestId, userText);
      routeToAgent({ agentName: targetAgent, nodeName: info.nodeName }, userText, myRequestId);
      return;
    }
    overlay.pushChat({ agent: targetAgent, from: 'system', text: `${targetAgent} is not reachable right now.` });
    return;
  }

  // Clears a running presentation -- applies to EVERY genuinely new user input, regardless of the
  // target. Actually interrupting the target's own in-flight work no longer happens here (that
  // would otherwise also abort an unrelated, independently working Oscar target, just because
  // the new request goes to someone else) -- instead scoped inside askOscarDirectly itself
  // (interruptTarget(HUB_TARGET) there), a remote node interrupts itself locally on task receipt anyway.
  clearDisplay();
  originalQuestionByRequest.set(myRequestId, userText); // for a possible follow-up chain

  // 1. Quick name match first (no extra Claude call needed, immediately clear). If MULTIPLE known
  // names are mentioned ("Nova and Thomas, work out..."), the first is addressed immediately, the
  // rest automatically comes up via the follow-up queue -- once the first has finished replying,
  // with no need for it to suggest the others itself via a marker.
  const mentioned = findMentionedNames(userText);
  if (mentioned.length > 0) {
    const [first, ...rest] = mentioned;
    const queueNames = rest.map((r) => r.agentName);
    // "to everyone"/"to the whole network" etc.: deterministically adds ALL reachable agents
    // (except the one addressed first) to the queue -- regardless of whether the first-addressed
    // agent itself remembers to do so via its own marker. Adds to, does not overwrite, whatever
    // already ends up in the queue via explicitly named names or later via an agent's own marker suggestions.
    if (isBroadcastRequest(userText)) {
      const everyone = [AGENT.name, ...remoteAgents.keys()].filter((n) => n !== first.agentName && isReachable(n));
      for (const name of everyone) if (!queueNames.includes(name)) queueNames.push(name);
    }
    if (queueNames.length > 0) {
      followUpQueues.set(myRequestId, queueNames);
      console.log(`[routing] ${isBroadcastRequest(userText) ? 'Broadcast to everyone detected' : 'Multiple named'}: ${first.agentName}, then ${queueNames.join(', ')}.`);
    }
    if (first.nodeName === null) {
      askOscarDirectly(userText, myRequestId);
    } else {
      routeToAgent({ agentName: first.agentName, nodeName: first.nodeName }, userText, myRequestId);
    }
    return;
  }

  // 2. No name mentioned, but whoever was addressed last just replied (< 30s): an obvious
  // continuation of the same conversation -- straight there, WITHOUT a fresh sense
  // classification. Only after a longer pause does full routing below kick back in.
  if (lastRoutedTarget && Date.now() - lastRoutedAt < LAST_AGENT_FALLBACK_MS) {
    if (lastRoutedTarget.nodeName === null) {
      askOscarDirectly(userText, myRequestId);
      return;
    }
    if (hub && hub.isUp(lastRoutedTarget.nodeName)) {
      routeToAgent({ agentName: lastRoutedTarget.agentName, nodeName: lastRoutedTarget.nodeName }, userText, myRequestId);
      return;
    }
    // Last target no longer reachable (e.g. node disconnected) -- keep checking normally below.
  }

  // 3. No name, no recent predecessor: if agents are connected, use sense understanding to
  // clarify whether one of them is actually responsible in substance (e.g. "booking broken" -> Nova).
  if (remoteAgents.size > 0) {
    setOverlayState({ status: 'thinking', text: '', agent: AGENT.name });
    classifyRoute(userText, (chosenName) => {
      if (myRequestId !== requestId) return; // superseded by newer input, discard
      if (chosenName && chosenName !== AGENT.name) {
        const info = remoteAgents.get(chosenName);
        if (info && hub.isUp(info.nodeName)) {
          routeToAgent({ agentName: chosenName, nodeName: info.nodeName }, userText, myRequestId);
          return;
        }
      }
      askOscarDirectly(userText, myRequestId);
    });
    return;
  }

  // 4. No remote agents connected -- straight to Oscar.
  askOscarDirectly(userText, myRequestId);
}

// -- Start the agent network (only if net-config.json designates this machine as the hub) ---
// netConfig/NET_CONFIG_FILE/NET_PORT are loaded near the top of this file now (provisioning needs
// them at module load) -- this block only decides whether to actually start listening.
if (netConfig) {
  try {
    if (netConfig.role === 'hub') {
      // Lets nodes find this machine again after the network changed, without anyone editing an
      // IP address by hand (see discovery.js). The fingerprint travels along so a node can tell
      // this hub apart from any other beacon on the network.
      try {
        startHubBeacon({
          hubName: netConfig.self,
          port: NET_PORT,
          fingerprint: fingerprintOfCertPem(loadPeerCert(netConfig.self))
        });
      } catch (e) {
        console.error('[discovery] beacon could not start:', e.message);
      }

      hub = startHub({
        selfName: netConfig.self,
        peers: netConfig.peers || [],
        port: NET_PORT,
        onPeerDown: (nodeName) => {
          // Whatever was asked of this machine will never be answered now, so its reservation goes
          // with it. Without this the agent stayed in busyTargets for good: a follow-up reaction
          // meant for it waited forever (advanceFollowUpQueue), and its name or responsibility could
          // not be changed any more (agentIsBusy). Found 2026-10-11 while looking into a phone agent
          // that had gone quiet.
          for (const [agentName, info] of remoteAgents) {
            if (info.nodeName !== nodeName) continue;
            if (busyTargets.has(agentName)) console.log(`[net] "${agentName}" went offline while still working on something -- that request is given up on.`);
            busyTargets.delete(agentName);
            activeRequestByTarget.delete(agentName);
            // A reaction held back for this agent cannot be delivered to it any more either.
            pendingReactionByTarget.delete(agentName);
          }
          for (const [agentName, info] of remoteAgents) if (info.nodeName === nodeName) remoteAgents.delete(agentName);
          lastHello.delete(nodeName);
          // A deck that went to this node will never be reported finished now.
          for (const [id, relay] of presentationRelays) if (relay.displayNode === nodeName) presentationRelays.delete(id);
          if (mainDisplayTarget && mainDisplayTarget.nodeName === nodeName) {
            // Target deliberately NOT set to null: isReachable() already recognizes "currently
            // not connected" on its own (see the present-request handler below), and if the same
            // node reconnects, it should automatically get the role back, without any other node
            // with "mainDisplay":true being able to sneak in the meantime (mainDisplaySetManually
            // continues to block hello assignments, see below).
            console.log(`[maindisplay] "${mainDisplayTarget.agentName}" (main display) is disconnected -- presentations will fail until it reconnects.`);
          }
          // Inform the browser overlay of the new (shorter) name list immediately, rather than
          // only at the next random state change.
          setOverlayState(overlay.getState());
          broadcastPeerLists(); // the remaining nodes should learn about the departure immediately, not only at the next /reset
          refreshSkillData();
        },
        onMessage: (nodeName, msg) => {
          // Who the machine is comes from the hub's record, not from this message -- see admitNode.
          if (msg.type === 'hello') {
            lastHello.set(nodeName, msg);
            admitNode(nodeName, msg);
          }
          // Attributed by certificate like everything else: a machine can only ever ask for itself.
          if (msg.type === 'identity-request') receiveIdentityRequest(nodeName, msg);
          // A node whose own permissions say "no files" turned a delivery away.
          if (msg.type === 'file-refused') {
            const who = agentNameOfNode(nodeName);
            if (who) tellUser(`${who} does not accept files right now -- switched off in its permissions on its own device.`);
          }
          // A node's face page opened or closed, so the class of its screen changed. Rare by design:
          // turning a phone changes nothing, the class has no orientation. It only matters to anyone
          // while that node is the main display.
          if (msg.type === 'screen') {
            for (const [, info] of remoteAgents) {
              if (info.nodeName === nodeName) info.screen = normalizeScreen(msg.screen);
            }
            if (mainDisplayTarget && mainDisplayTarget.nodeName === nodeName) {
              broadcastPeerLists();
              refreshSkillData();
            }
          }
          // Every other message a node sends about itself names its sender too, and that name used to
          // be believed like the hello's: one machine could answer, present or finish in another's
          // name. The certificate says which machine sent it; the name is looked up from that.
          if (msg.type === 'answer' || msg.type === 'speech-done' || msg.type === 'speak-request' || msg.type === 'present-request') {
            const own = agentNameOfNode(nodeName);
            if (!own) return; // not admitted (yet), so nothing it says can be attributed
            msg.agentName = own;
          }
          if (msg.type === 'answer' && typeof msg.text === 'string') {
            // The remote agent speaks the reply ITSELF on its own machine -- it only gets logged
            // here, NOT read aloud again by Oscar. "answer" already arrives once the TEXT is
            // final (well before speech ends) -- this is the right moment to mark the target as
            // free again and immediately deliver a possibly waiting follow-up reaction (see targetFreed).
            const targetKey = msg.agentName || nodeName;
            targetFreed(targetKey);
            if (msg.requestId !== activeRequestByTarget.get(targetKey)) return; // stale, ignore
            console.log(`[${msg.agentName || nodeName}] ${msg.text}`);
            setOverlayState({ status: 'idle', text: '', agent: AGENT.name });
          }
          if (msg.type === 'speech-done' && typeof msg.agentName === 'string') {
            // Only NOW (not already at "answer") has the agent really finished speaking -- only
            // from here on may a follow-up chain send off the next agent.
            const suggestedNext = Array.isArray(msg.suggestedNext) ? msg.suggestedNext : [];
            onSpeechFinished(msg.requestId, msg.agentName, typeof msg.text === 'string' ? msg.text : '', suggestedNext);
          }
          // A remote agent wants to present (marker in its own reply, see
          // node-agent.js/sayWithPresentation). requestId belongs to the original question that
          // dispatched this agent in the first place -- same staleness check as answer/speech-done
          // above, no new counter.
          if (msg.type === 'present-request' && typeof msg.url === 'string') {
            const wireSegments = normalizePresentSegments(msg);
            if (!wireSegments) return; // nothing usable -- neither playable audio nor text to speak
            if (msg.requestId !== activeRequestByTarget.get(msg.agentName)) return; // stale, ignore
            // The page comes along (see readOwnContent in overlay-server.js). A link to another
            // machine's page WITHOUT it could only be shown by fetching it across the WiFi, which
            // nothing does any more -- so it is handed back, and the presenter shows it on its own
            // screen, where it needs no network at all. Only an older node-agent.js sends one.
            const page = normalizePage(msg.page);
            if (!page && !isWebsite(msg.url)) {
              console.log(`[maindisplay] "${msg.agentName}" sent a presentation link without its page -- handing it back to show on its own screen.`);
              try { hub.send(nodeName, { type: 'present-declined', requestId: msg.requestId }); } catch (e) { cleanupFollowUp(msg.requestId); }
              return;
            }
            if (!mainDisplayTarget || !isReachable(mainDisplayTarget.agentName)) {
              // Nowhere to show it: hand it back, and the node presents on its own screen (user's
              // decision, 2026-09-15). The peers broadcast normally prevents this already; it covers
              // the moment between a display dropping off and the news reaching the presenter. The
              // follow-up chain is NOT cleaned up here: the node's own-screen presentation reports
              // 'answer' and 'speech-done' like any reply and carries the chain on from there.
              console.log(`[maindisplay] "${msg.agentName}" wanted to present, but no main display is reachable -- handing it back to show on its own screen.`);
              try { hub.send(nodeName, { type: 'present-declined', requestId: msg.requestId }); } catch (e) { cleanupFollowUp(msg.requestId); }
              return;
            }
            const suggestedNext = Array.isArray(msg.suggestedNext) ? msg.suggestedNext : [];
            const text = typeof msg.text === 'string' ? msg.text : '';
            if (mainDisplayTarget.nodeName === null) {
              // The hub is itself the main display -- no network hop needed, play locally right away.
              // Async: slides may have to be synthesized first (see prepareSegmentFiles).
              prepareSegmentFiles(wireSegments, (segments) => {
                if (!segments) { cleanupFollowUp(msg.requestId); return; }
                if (msg.requestId !== activeRequestByTarget.get(msg.agentName)) {
                  // Superseded while the slides were being prepared -- same rule as the check above.
                  for (const s of segments) fs.unlink(s.filePath, () => {});
                  return;
                }
                playPresentationLocally(segments, msg.agentName, msg.url, text, msg.requestId, suggestedNext, faceStyleFor(msg.agentName, msg.faceStyle, msg.faceRecipe), msg.faceTint, page);
              });
            } else {
              const deliver = () => {
                try {
                  pendingPresentationSuggested.set(msg.requestId, suggestedNext);
                  presentationRelays.set(msg.requestId, { agentName: msg.agentName, displayNode: mainDisplayTarget.nodeName });
                  presentationOwnerRequestId = msg.requestId;
                  currentPresentation = { agentName: msg.agentName, url: msg.url || (page ? page.name : ''), faceStyle: msg.faceStyle, faceTint: normalizeTint(msg.faceTint), slide: 0 };
                  // Relayed as normalized segments rather than passing msg straight through -- the
                  // sending node may be an older build that only set audioBase64, and the display
                  // node should get one consistent shape either way.
                  hub.send(mainDisplayTarget.nodeName, {
                    // faceRecipe relayed as it came: the display node needs the recipe itself, a name
                    // this machine made up for its own use would mean nothing there.
                    type: 'present', requestId: msg.requestId, agentName: msg.agentName, url: page ? '' : msg.url, page: page || undefined, text, faceStyle: msg.faceStyle, faceTint: msg.faceTint, faceRecipe: msg.faceRecipe,
                    segments: wireSegments,
                    audioBase64: wireSegments.length === 1 ? wireSegments[0].audioBase64 : undefined
                  });
                  console.log(`[maindisplay] "${msg.agentName}" is presenting on "${mainDisplayTarget.agentName}"${wireSegments.length > 1 ? ` (${wireSegments.length} slides)` : ''}: ${page ? page.name : msg.url}`);
                } catch (e) {
                  // e.g. MAX_MSG_BYTES exceeded (see agent-net.js) -- avoid crashing, cleanly abandon
                  // the operation instead of taking the whole process down with it.
                  console.error('[maindisplay] Could not forward presentation, handing it back to its presenter:', e.message);
                  pendingPresentationSuggested.delete(msg.requestId);
                  presentationRelays.delete(msg.requestId);
                  currentPresentation = null;
                  presentationOwnerRequestId = null;
                  try { hub.send(nodeName, { type: 'present-declined', requestId: msg.requestId }); } catch (err) { cleanupFollowUp(msg.requestId); }
                }
              };
              if (currentPresentation && msg.requestId !== presentationOwnerRequestId) {
                console.log(`[maindisplay] "${msg.agentName}" is waiting with its own presentation -- screen currently shows a different chain.`);
                displayQueue.push({ targetKey: msg.agentName, requestId: msg.requestId, resume: deliver });
              } else {
                deliver();
              }
            }
          }
          // A remote node that is ITSELF the main display wants to speak normally (no
          // [PRESENTATION:...] marker, just an ordinary reply) -- since it synthesizes locally and
          // has no way to know without the hub whether its own screen is currently occupied by
          // something else, it asks here before actually playing (see node-agent.js).
          if (msg.type === 'speak-request' && typeof msg.agentName === 'string') {
            const deliver = () => {
              if (currentPresentation && msg.requestId === presentationOwnerRequestId) {
                currentPresentation = Object.assign({}, currentPresentation, { agentName: msg.agentName, faceStyle: faceStyleFor(msg.agentName, msg.faceStyle, msg.faceRecipe), faceTint: normalizeTint(msg.faceTint) });
              }
              try {
                hub.send(nodeName, { type: 'display-go', requestId: msg.requestId, updatePresentationSpeaker: !!currentPresentation, agentName: msg.agentName, faceStyle: msg.faceStyle, faceTint: msg.faceTint, faceRecipe: msg.faceRecipe });
              } catch (e) {}
            };
            const isDisplayTarget = mainDisplayTarget && mainDisplayTarget.nodeName === nodeName;
            if (isDisplayTarget && currentPresentation && msg.requestId !== presentationOwnerRequestId) {
              console.log(`[maindisplay] "${msg.agentName}" is waiting with normal speech -- its own screen currently shows a different chain.`);
              displayQueue.push({ targetKey: msg.agentName, requestId: msg.requestId, resume: deliver });
            } else {
              deliver();
            }
          }
          if (msg.type === 'presentation-done') {
            // Comes back from the node that just SERVED AS THE MAIN DISPLAY, once playback is
            // done -- requestId belongs to the original presenter's chain (see node-agent.js).
            // Accepted only from the node the deck was actually sent to, and finished for the
            // presenter recorded when it was sent; the agentName inside is not believed.
            const relay = presentationRelays.get(msg.requestId);
            if (!relay || relay.displayNode !== nodeName) return;
            presentationRelays.delete(msg.requestId);
            const suggestedNext = pendingPresentationSuggested.get(msg.requestId) || [];
            pendingPresentationSuggested.delete(msg.requestId);
            onSpeechFinished(msg.requestId, relay.agentName, typeof msg.text === 'string' ? msg.text : '', suggestedNext);
          }
        }
      });
    }
  } catch (e) {
    console.error('net-config.json could not be read:', e.message);
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`Bridge is running on port ${PORT}.`);
console.log('Open http://localhost:' + PORT + '/ in a browser for the face, or type here and press Enter.');
console.log('Tip: "/reset" starts a new conversation, "/network" lists the agents and who they are, "/agent" changes an agent\'s name or responsibility, "/maindisplay <Name>" sets the main display, "/maindisplay off" lets every agent present on its own screen.');
rl.on('line', (line) => {
  if (line.trim()) askAgent(line.trim(), null, 'console');
});
