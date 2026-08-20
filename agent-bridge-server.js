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
const { startHub } = require('./agent-net.js');
const { createSpeaker } = require('./speech.js');
const { startOverlayServer, getLanIp } = require('./overlay-server.js');
const { extractFollowUpTag, buildTagHint, buildPeersLine, extractPresentationTag } = require('./followup-tag.js');

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
// This agent's own reachable base URL for self-generated presentation content
// (presented_content/, see the buildTagHint calls below) -- computed once, never changes at runtime.
const CONTENT_URL_PREFIX = `http://${getLanIp()}:${PORT}`;
const SESSION_FILE = process.env.AGENT_SESSION_FILE || path.join(__dirname, '.session.json');

const AGENT = {
  name: 'Oscar',
  personality: 'Direct and pragmatic, answering in 1-3 short, chat-style sentences. No preamble phrases like "As an AI, I would say".',
  // "low"|"medium"|"high"|"xhigh"|"max" or null for the CLI default -- same option as "effort" in
  // net-config.json for the nodes, set directly here because Oscar's identity (unlike the
  // nodes') doesn't come from net-config.json, it lives here in code.
  effort: null,
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
  faceStyle: 'kai'
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

// Aborts ONLY the own in-flight work (claude child process, running speech) of ONE target -- for
// a remote node that already happens locally on its own side (runTask()), so this is only
// relevant for Oscar here.
function interruptTarget(targetKey) {
  if (targetKey !== HUB_TARGET) return;
  speaker.stopSpeaking();
  if (currentClaudeChild) { try { currentClaudeChild.kill(); } catch (e) {} currentClaudeChild = null; }
}

// Called once a target has finished its claude call (the text is final) -- marks the target as
// free again and immediately delivers a possibly waiting follow-up reaction.
function targetFreed(targetKey) {
  busyTargets.delete(targetKey);
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
// remoteAgents: agent name (spoken) -> { nodeName, domain }, e.g. "Nova" -> { nodeName:
// "node2", domain: "Website, Cloudflare, ..." }. domain comes from the node itself when
// connecting (its own net-config.json) and is used for sense-based routing below.
const remoteAgents = new Map();
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
function peerListFor(excludeAgentName) {
  const all = [{ name: AGENT.name, domain: '' }, ...Array.from(remoteAgents.entries()).map(([name, info]) => ({ name, domain: info.domain }))];
  return all.filter((p) => p.name !== excludeAgentName);
}

function broadcastPeerLists() {
  const mainDisplay = mainDisplayTarget ? mainDisplayTarget.agentName : null;
  for (const [agentName, info] of remoteAgents) {
    if (hub && hub.isUp(info.nodeName)) {
      hub.send(info.nodeName, { type: 'peers', list: peerListFor(agentName), mainDisplay });
    }
  }
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
  // Deliberately separated with " | " instead of line breaks: the whole prompt ends up as ONE
  // command-line argument, and real \n inside it has once already truncated the message (Windows
  // splits arguments at such points) -- see the same rule for the other claude calls in this file.
  const candidates = Array.from(remoteAgents.entries())
    .filter(([, info]) => hub && hub.isUp(info.nodeName) && info.domain)
    .map(([name, info]) => `${name}: ${info.domain}`)
    .join(' | ');
  if (!candidates) { callback(null); return; }

  const prompt = `A user said: "${userText}". Available people in charge -- ${AGENT.name}: general assistant, for anything that doesn't clearly fall into another area. | ${candidates} -- Answer ONLY with the name of the best-matching person in charge, nothing else.`;
  const args = ['-p', prompt, '--model', 'claude-haiku-4-5-20251001', '--output-format', 'json'];
  const child = spawn(CLAUDE_EXE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
  // end of the chain. That is now handled entirely by the (invisible) marker in buildTagHint(),
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

function loadSessionId() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).sessionId || null; }
  catch (e) { return null; }
}
function saveSessionId(id) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: id })); } catch (e) {}
}
let sessionId = loadSessionId();

const overlay = startOverlayServer({
  port: PORT,
  onUserInput: (text) => askAgent(text) // ONLY Oscar's overlay passes microphone input through
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
  const ownScreenPresentation = (mainDisplayTarget && mainDisplayTarget.nodeName === null) ? currentPresentation : null;
  overlay.setState(Object.assign({}, partial, { agentNames: [AGENT.name, ...remoteAgents.keys()], presentation: ownScreenPresentation, faceStyle: AGENT.faceStyle }));
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
      gateForDisplay(HUB_TARGET, myRequestId, { agentName: AGENT.name, faceStyle: AGENT.faceStyle }, deliver);
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
}

// Plays a presentation on Oscar's OWN screen when he is currently the main display -- whether
// he himself is the presenter (presentFromOscar, no network hop needed) or a remote agent
// sends him something to display (the present-request handler further below). Mirrors the
// 'present' handler in node-agent.js, just without the detour through hub.send/link.send.
function playPresentationLocally(filePath, agentName, url, text, presoRequestId, suggestedNext, faceStyle) {
  const deliver = () => {
    currentPresentation = { agentName, url, faceStyle };
    presentationOwnerRequestId = presoRequestId;
    setOverlayState({ status: 'speaking', text, agent: AGENT.name });
    speaker.playLocally(filePath, () => {
      fs.unlink(filePath, () => {});
      // currentPresentation is DELIBERATELY left in place here (user's wish: the presentation
      // stays up until the next genuinely new user input) -- only clearDisplay() still cleans
      // that up. Only status/text go back to idle, setOverlayState() still keeps carrying
      // currentPresentation along regardless.
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
function presentFromOscar(text, myRequestId, url, suggestedNext) {
  speaker.synthesizeSpeech(text, (filePath) => {
    if (myRequestId !== activeRequestByTarget.get(HUB_TARGET)) {
      if (filePath) fs.unlink(filePath, () => {});
      cleanupFollowUp(myRequestId);
      return;
    }
    if (!filePath) {
      // Piper unavailable -- no reliable "done" point for a presentation, falls back to normal
      // (browser) speech instead of attempting a broken presentation.
      say(text, myRequestId, AGENT.name, true, suggestedNext);
      return;
    }
    if (mainDisplayTarget.nodeName === null) {
      playPresentationLocally(filePath, AGENT.name, url, text, myRequestId, suggestedNext, AGENT.faceStyle);
      return;
    }
    // ownDisplayHidden: Oscar's own overlay hides completely (not just idle) while the reply
    // is running on the FOREIGN main-display screen -- otherwise you'd see an idle face standing
    // around here while the actual reply happens elsewhere.
    setOverlayState({ status: 'idle', text: '', agent: AGENT.name, ownDisplayHidden: true });
    let audioBase64;
    try {
      audioBase64 = fs.readFileSync(filePath).toString('base64');
    } catch (e) {
      console.error('[maindisplay] Audio file unreadable, speaking normally instead:', e.message);
      say(text, myRequestId, AGENT.name, true, suggestedNext);
      return;
    }
    fs.unlink(filePath, () => {});
    const deliver = () => {
      try {
        pendingPresentationSuggested.set(myRequestId, suggestedNext);
        presentationOwnerRequestId = myRequestId;
        currentPresentation = { agentName: AGENT.name, url, faceStyle: AGENT.faceStyle };
        hub.send(mainDisplayTarget.nodeName, { type: 'present', requestId: myRequestId, agentName: AGENT.name, url, audioBase64, text, faceStyle: AGENT.faceStyle });
        console.log(`[maindisplay] Oscar is presenting on "${mainDisplayTarget.agentName}": ${url}`);
      } catch (e) {
        // e.g. MAX_MSG_BYTES exceeded or the connection just dropped -- avoid crashing (see
        // agent-net.js), fall back to speaking normally instead of letting the reply silently vanish.
        console.error('[maindisplay] Could not send own presentation, speaking normally instead:', e.message);
        pendingPresentationSuggested.delete(myRequestId);
        say(text, myRequestId, AGENT.name, true, suggestedNext);
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

// Sets the main display by hand -- this is the actual "low effort" way to reassign the role (no
// config edit, no restart). Permanently overrides an automatic hello assignment
// (mainDisplaySetManually), so a reconnecting node with "mainDisplay":true in its config doesn't
// accidentally undo this deliberate decision.
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
}

function currentPeersLine() {
  return buildPeersLine(Array.from(remoteAgents.entries()).map(([name, info]) => ({ name, domain: info.domain })));
}

// Unlike the marker hint (a behavioral instruction that has to be repeated every turn), the peer
// list is a plain fact -- only append it again when the network has actually changed since the
// last turn (see onPeerDown/hello below) or on /reset, not blindly repeated on every single
// reply. Starts at true, so the very first turn is guaranteed to get it. Same principle as
// peersDirty in node-agent.js, but without the race-condition risk here -- Oscar knows
// remoteAgents synchronously/locally, no network message needed.
let oscarPeersDirty = true;

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

  const peersLine = oscarPeersDirty ? currentPeersLine() : '';
  oscarPeersDirty = false;
  // Read fresh on every turn (no dirty flag needed like for peersLine -- this is just a cheap
  // bool read, Oscar knows mainDisplayTarget synchronously/locally).
  const hasMainDisplay = mainDisplayTarget !== null;
  const tagHint = buildTagHint(hasMainDisplay, CONTENT_URL_PREFIX);

  const args = ['-p'];
  if (sessionId) {
    args.push(`${userText} ${peersLine}`.replace(/\s+/g, ' ').trim(), '--resume', sessionId);
  } else {
    // No embedded \n here: Windows splits command-line arguments at real line breaks, which
    // previously truncated the message and broke the JSON output.
    const persona = `You are ${AGENT.name}, the central coordinator of a network of AI assistant colleagues. ${peersLine} ${AGENT.personality} Message: ${userText}`
      .replace(/\s+/g, ' ').trim();
    args.push(persona);
  }
  // tagHint goes via --append-system-prompt, no longer embedded in the message: observed live
  // (2026-08-17, see node-agent.js for the full derivation) that a forceful action instruction
  // sitting inside the "user" message got flagged by the model as a possible prompt-injection
  // attempt and was deliberately ignored. Still included on EVERY turn regardless (a behavioral
  // instruction, not a one-time fact).
  args.push('--append-system-prompt', tagHint);
  args.push('--output-format', 'json');
  if (AGENT.effort) args.push('--effort', AGENT.effort);
  // Every agent automatically gets write access to EXACTLY its own presented_content/ folder
  // (main-display feature, user's wish 2026-08-17: "every agent should at least have a folder it
  // can work in") -- via Edit(...), not Write(...): empirically confirmed that the CLI accepts
  // Write(path) rules but never actually enforces them (only Edit(path) is really checked, which
  // covers Write too). ALWAYS appended, independent of AGENT.allowedTools, not instead of it --
  // this also applies to Oscar, who deliberately has no write access otherwise, but scoped
  // narrowly enough (verified: writing outside the folder remains refused).
  const allowedTools = AGENT.allowedTools ? `${AGENT.allowedTools},Edit(presented_content/**)` : 'Edit(presented_content/**)';
  args.push('--allowedTools', allowedTools);
  if (AGENT.mcpConfig) args.push('--mcp-config', AGENT.mcpConfig);
  if (AGENT.permissionMode) args.push('--permission-mode', AGENT.permissionMode);
  // Security gap empirically found and closed 2026-08-17: without ANY flag at all, the CLI in
  // headless mode (-p) lets the "PowerShell" tool (on Windows the only shell execution tool --
  // there is no separate "Bash" here at all) through WITHOUT asking, while Write/Edit correctly
  // stay blocked -- verified with real marker text and the full tool-call log, not a
  // misunderstanding. --allowedTools with other values changes NOTHING about this (also
  // verified) -- only an explicit --disallowedTools closes the gap. Only applies when NO
  // permissionMode is set -- a deliberately broader level (like Nova's bypassPermissions)
  // should not be restricted by this.
  if (!AGENT.permissionMode) args.push('--disallowedTools', 'PowerShell');
  if (AGENT.chrome) args.push('--chrome');

  const child = spawn(CLAUDE_EXE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const { cleanText: afterPresentation, presentationUrl } = extractPresentationTag(text);
    const { cleanText, suggested } = extractFollowUpTag(afterPresentation);
    // See the same line in node-agent.js: shows the RAW marker before any check, otherwise
    // "nothing attempted" can't be told apart from "attempted, but discarded".
    console.log(`[${AGENT.name}] Marker in raw text: ${suggested.length ? suggested.join(', ') : '(none)'}`);
    console.log(`[${AGENT.name}] Presentation marker: ${presentationUrl || '(none)'}`);
    if (presentationUrl) {
      if (mainDisplayTarget) {
        presentFromOscar(cleanText, myRequestId, presentationUrl, suggested);
        return;
      }
      console.log('[maindisplay] Presentation requested, but no main display assigned -- speaking normally.');
    }
    say(cleanText, myRequestId, AGENT.name, true, suggested);
  });
}

function askAgent(userText) {
  if (userText === '/reset') {
    sessionId = null;
    try { fs.unlinkSync(SESSION_FILE); } catch (e) {}
    lastRoutedTarget = null; // a deliberate restart should no longer "stick" to the last agent
    oscarPeersDirty = true; // a fresh session should definitely get the peer list again
    followUpQueues.clear(); originalQuestionByRequest.clear(); lastAnswerByRequest.clear(); chainLengthByRequest.clear();
    activeRequestByTarget.clear(); busyTargets.clear(); pendingReactionByTarget.clear(); displayQueue.length = 0;
    currentPresentation = null; presentationOwnerRequestId = null;
    if (hub) hub.broadcast({ type: 'reset' }); // reset remote agents too (including clear-presentation there, see node-agent.js)
    console.log('Conversation reset. The next message starts a new session.');
    return;
  }
  if (userText === '/network') {
    const list = Array.from(remoteAgents.entries())
      .map(([agentName, info]) => `${agentName} (${info.nodeName})${info.domain ? ' - ' + info.domain : ''}: ${hub && hub.isUp(info.nodeName) ? 'connected' : 'offline'}`);
    console.log(list.length ? list.join('\n') : 'No remote agents connected.');
    return;
  }
  if (userText === '/maindisplay') {
    console.log(mainDisplayTarget ? `Main display is currently "${mainDisplayTarget.agentName}".` : 'No main display assigned.');
    return;
  }
  if (userText.startsWith('/maindisplay ')) {
    setMainDisplay(userText.slice('/maindisplay '.length).trim());
    return;
  }

  const myRequestId = ++requestId;
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
const NET_CONFIG_FILE = process.env.AGENT_NET_CONFIG || path.join(__dirname, 'net-config.json');
if (fs.existsSync(NET_CONFIG_FILE)) {
  try {
    const netConfig = JSON.parse(fs.readFileSync(NET_CONFIG_FILE, 'utf8'));
    if (netConfig.role === 'hub') {
      hub = startHub({
        selfName: netConfig.self,
        peers: netConfig.peers || [],
        port: netConfig.port || 8788,
        onPeerDown: (nodeName) => {
          for (const [agentName, info] of remoteAgents) if (info.nodeName === nodeName) remoteAgents.delete(agentName);
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
          oscarPeersDirty = true; // the network has changed -- Oscar's next turn should learn about it
        },
        onMessage: (nodeName, msg) => {
          if (msg.type === 'hello' && typeof msg.agentName === 'string') {
            remoteAgents.set(msg.agentName, { nodeName, domain: typeof msg.domain === 'string' ? msg.domain : '' });
            console.log(`[network] Agent "${msg.agentName}" on node "${nodeName}" is here.${msg.domain ? ' Responsible for: ' + msg.domain : ''}`);
            if (msg.mainDisplay === true && !mainDisplaySetManually) {
              mainDisplayTarget = { agentName: msg.agentName, nodeName };
              console.log(`[maindisplay] "${msg.agentName}" is now automatically the main display (configuration).`);
            }
            // If this (newly connecting/reconnecting) node is currently the main display, but the
            // hub itself isn't tracking any presentation (e.g. after a hub restart), the node
            // might still be showing a stale local presentation -- sync it to be safe.
            if (mainDisplayTarget && mainDisplayTarget.nodeName === nodeName && !currentPresentation) {
              try { hub.send(nodeName, { type: 'clear-presentation' }); } catch (e) {}
            }
            // Same here: immediately send out the expanded name list, so "Nova, ..." also works
            // right away even if the browser was already open BEFORE she connected.
            setOverlayState(overlay.getState());
            broadcastPeerLists(); // every node (including the new one) gets the current roster view
            oscarPeersDirty = true; // the network has changed -- Oscar's next turn should learn about it
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
          if (msg.type === 'present-request' && typeof msg.url === 'string' && typeof msg.audioBase64 === 'string') {
            if (msg.requestId !== activeRequestByTarget.get(msg.agentName)) return; // stale, ignore
            if (!mainDisplayTarget || !isReachable(mainDisplayTarget.agentName)) {
              console.log(`[maindisplay] "${msg.agentName}" wanted to present, but no main display is assigned or reachable.`);
              cleanupFollowUp(msg.requestId); // otherwise followUpQueues/etc. for this requestId stay stuck
              return;
            }
            const suggestedNext = Array.isArray(msg.suggestedNext) ? msg.suggestedNext : [];
            const text = typeof msg.text === 'string' ? msg.text : '';
            if (mainDisplayTarget.nodeName === null) {
              // The hub is itself the main display -- no network hop needed, play locally right away.
              const filePath = path.join(__dirname, 'audio_out', `present-${Date.now()}.wav`);
              try {
                fs.writeFileSync(filePath, Buffer.from(msg.audioBase64, 'base64'));
              } catch (e) {
                console.error('[maindisplay] Could not write audio data:', e.message);
                cleanupFollowUp(msg.requestId);
                return;
              }
              playPresentationLocally(filePath, msg.agentName, msg.url, text, msg.requestId, suggestedNext, msg.faceStyle);
            } else {
              const deliver = () => {
                try {
                  pendingPresentationSuggested.set(msg.requestId, suggestedNext);
                  presentationOwnerRequestId = msg.requestId;
                  currentPresentation = { agentName: msg.agentName, url: msg.url, faceStyle: msg.faceStyle };
                  hub.send(mainDisplayTarget.nodeName, { type: 'present', requestId: msg.requestId, agentName: msg.agentName, url: msg.url, audioBase64: msg.audioBase64, text, faceStyle: msg.faceStyle });
                  console.log(`[maindisplay] "${msg.agentName}" is presenting on "${mainDisplayTarget.agentName}": ${msg.url}`);
                } catch (e) {
                  // e.g. MAX_MSG_BYTES exceeded (see agent-net.js) -- avoid crashing, cleanly abandon
                  // the operation instead of taking the whole process down with it.
                  console.error('[maindisplay] Could not forward presentation:', e.message);
                  cleanupFollowUp(msg.requestId);
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
                currentPresentation = Object.assign({}, currentPresentation, { agentName: msg.agentName, faceStyle: msg.faceStyle });
              }
              try {
                hub.send(nodeName, { type: 'display-go', requestId: msg.requestId, updatePresentationSpeaker: !!currentPresentation, agentName: msg.agentName, faceStyle: msg.faceStyle });
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
          if (msg.type === 'presentation-done' && typeof msg.agentName === 'string') {
            // Comes back from the node that just SERVED AS THE MAIN DISPLAY, once playback is
            // done -- requestId/agentName belong to the original presenter (see node-agent.js),
            // not the displaying node itself.
            const suggestedNext = pendingPresentationSuggested.get(msg.requestId) || [];
            pendingPresentationSuggested.delete(msg.requestId);
            onSpeechFinished(msg.requestId, msg.agentName, typeof msg.text === 'string' ? msg.text : '', suggestedNext);
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
console.log('Open any webpage with the Tampermonkey overlay, then type here and press Enter.');
console.log('Tip: "/reset" starts a new conversation, "/network" shows the connected agents, "/maindisplay <Name>" sets the main display.');
rl.on('line', (line) => {
  if (line.trim()) askAgent(line.trim());
});
