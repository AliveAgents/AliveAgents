// node-agent.js
// Runs on a DIFFERENT laptop than Oscar. Connects to the hub over an encrypted channel,
// receives tasks, has the Claude Code CLI answer them -- and speaks the answer ITSELF, on THIS
// machine, with its OWN voice, while its own browser overlay (the same face script as Oscar's,
// but with its own name/its own look) animates along. Oscar only gets a brief informational
// callback so he stays in the loop -- he does NOT read the answer aloud again.
//
// Start:  start-node.bat
// This machine additionally needs a browser with Tampermonkey pointed at
// http://localhost:<overlayPort>/ (default 8787), running the desired face script.

const spawn = require('cross-spawn');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { connectToHub, fingerprintOfCertPem, loadPeerCert } = require('./agent-net.js');
const { listenForHub } = require('./discovery.js');
const { createSpeaker } = require('./speech.js');
const { startOverlayServer, getLanIp, contentUrlPrefix, localizeContentUrl } = require('./overlay-server.js');
const { extractFollowUpTag, buildTagHint, buildPeersLine, extractPresentationTag, splitSlideSegments } = require('./followup-tag.js');
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

const CONFIG_FILE = process.env.AGENT_NET_CONFIG || path.join(__dirname, 'net-config.json');
if (!fs.existsSync(CONFIG_FILE)) {
  console.error(`${CONFIG_FILE} is missing. Rename net-config.example.json to net-config.json and adjust it.`);
  process.exit(1);
}
// readJsonFile instead of a bare JSON.parse: a UTF-8 byte order mark at the start of the file
// makes JSON.parse throw, and the agent then dies at startup with a stack trace that says nothing
// about the real cause. Windows produces such files easily -- Notepad, and PowerShell 5.1's
// "Set-Content -Encoding UTF8", both write a BOM (2026-09-02: exactly that killed this agent).
// The file is fine; only the invisible first character is not.
function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

const config = readJsonFile(CONFIG_FILE);

const AGENT = {
  name: config.agentName || 'Node',
  personality: config.personality
    || 'Direct and pragmatic, answering in 1-3 short, chat-style sentences. No preamble phrases like "As an AI, I would say".'
};

// Own Piper voice model per agent (e.g. a female voice for Nova, instead of the hub's own male
// Oscar voice). Falls back to the Oscar voice if the config doesn't specify one of its own.
const speaker = createSpeaker({
  piperExe: path.join(__dirname, 'tools', 'piper', 'piper.exe'),
  voiceModel: path.join(__dirname, 'tools', 'piper', 'voices', config.piperVoice || 'en_US-ryan-high.onnx'),
  audioDir: path.join(__dirname, 'audio_out')
});

// Own overlay (face) on this machine. NO onUserInput here -- only Oscar distributes tasks by
// microphone, this node only reacts to tasks coming from the hub.
const OVERLAY_PORT = config.overlayPort || 8787;
const overlay = startOverlayServer({ port: OVERLAY_PORT });
// This agent's own reachable base URL for self-generated presentation content
// (presented_content/, see the buildTagHint() calls below) -- computed once, never changes at runtime.
// Includes the per-process content key -- see the matching line in agent-bridge-server.js.
const CONTENT_URL_PREFIX = contentUrlPrefix(`http://${getLanIp()}:${OVERLAY_PORT}`);

// Presentation currently running on THIS screen (if this node is currently the main display) --
// { agentName, url } | null. A thin wrapper around overlay.setState is needed because that
// REPLACES the whole state instead of merging it (see overlay-server.js): without this, any
// incidental overlay.setState call would wipe a presentation currently running on this own
// screen. Same principle as Oscar's own setOverlayState wrapper in agent-bridge-server.js --
// replaces ALL direct overlay.setState calls in this file from here on.
let currentPresentation = null;
function setOverlayState(partial) {
  // config.faceStyle || '' instead of borrowing some concrete default value: a node with no
  // faceStyle set in its net-config.json should explicitly hit the overlay script's generic
  // fallback face, not accidentally take on the look of a DIFFERENT agent (as a hardcoded 'kai'
  // here would silently do).
  overlay.setState(Object.assign({}, partial, { presentation: currentPresentation, faceStyle: config.faceStyle || '' }));
}
setOverlayState({ status: 'idle', text: '', agent: AGENT.name });

// Own session file -> this agent has its own memory, separate from Oscar's.
const SESSION_FILE = path.join(__dirname, `.session-${config.self}.json`);

function loadSessionId() {
  try { return readJsonFile(SESSION_FILE).sessionId || null; }
  catch (e) { return null; }
}
function saveSessionId(id) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: id })); } catch (e) {}
}
let sessionId = loadSessionId();

// Communicated by the hub via {type:'peers'}: all other currently connected agents (name+domain),
// for the persona below.
let knownPeers = [];
// Unlike the marker hint (a behavioral instruction that has to be repeated on EVERY turn, or it
// gets lost on the model), the peer list is a plain fact -- once known, it stays true, so it
// doesn't need to be restated on every single reply. peersDirty starts at true (the very first
// turn should ALWAYS get it) and is only set again once the network has actually changed since
// (a new {type:'peers'} message) or on a /reset. This still fixes the race condition (if the
// first turn misses the peers message, the next turn with peersDirty=true automatically catches
// up), without dragging the same unchanged sentence along on every reply.
let peersDirty = true;

// Communicated by the hub via {type:'peers'}: name of the agent currently serving as main
// display, or null. Read fresh on every turn (no dirty flag needed like for knownPeers -- a
// cheap bool read, not a list). Determines whether buildTagHint() even includes the presentation
// hint at all, and whether a reply with a presentation marker is even attempted
// (sayWithPresentation) instead of speaking normally right away.
let knownMainDisplay = null;

// Optional per agent in net-config.json: "workDir": "D:/Projects/Website" -- the folder this
// agent's Claude session actually runs in, so it can work on a real project instead of on the
// AliveAgents checkout.
//
// This is worth understanding before changing it, because three things hang off the working
// directory (all verified live, 2026-08-25):
//   * The project's own CLAUDE.md is read automatically. That is the point: it is how an agent
//     "knows" a project without anyone wiring anything up.
//   * Claude Code scopes its own memory per project path, so each workDir gets its own.
//   * File access is CONFINED to the working directory. An absolute path in --allowedTools does
//     NOT grant access outside it on its own -- the agent politely refuses. Only --add-dir opens
//     a second root, which is why AliveAgents has to be added explicitly below, or presentations
//     and the inbox would silently stop working.
// Resumed sessions survive the switch, so changing this does not wipe an agent's memory.
const WORK_DIR = (() => {
  if (!config.workDir) return __dirname;
  const resolved = path.resolve(config.workDir);
  if (!fs.existsSync(resolved)) {
    console.error(`[agent] workDir "${resolved}" does not exist -- staying in ${__dirname}`);
    return __dirname;
  }
  return resolved;
})();
if (WORK_DIR !== __dirname) console.log(`[agent] working in ${WORK_DIR}`);

// How the two agent-owned folders are NAMED to the model. Relative reads better and is what the
// agent sees in its own working directory -- but only while that IS this folder. Everything the
// agent is told about a path has to survive workDir, or it quietly writes to the wrong place.
const asPromptPath = (sub) => (WORK_DIR === __dirname ? sub : path.join(__dirname, sub).replace(/\\/g, '/'));
const CONTENT_DIR_FOR_PROMPT = asPromptPath('presented_content');
const INBOX_DIR_FOR_PROMPT = asPromptPath('inbox');

// Files that arrived since this agent's last reply, so they can be marked [NEW] exactly once.
const newInboxFiles = new Set();
const inboxReceiver = inboxLib.createReceiver({
  root: __dirname,
  log: console.log,
  onComplete: (name) => { newInboxFiles.add(name); }
});

let requestId = 0;
let currentClaudeChild = null;
// SEPARATE, independent counter only for incoming 'present' display messages (see onMessage
// below) -- deliberately NOT the same counter as requestId (which tracks this node's own task
// processing/its own claude call). Now that this node can simultaneously work on its own task AND
// show someone else's presentation (real concurrency), the two would otherwise be wrongly
// coupled: an incoming presentation would advance requestId and thereby wrongly discard the
// node's own, still-running task as "stale" once it later finished (a real bug, found live via
// testing -- Nova's own presentation task vanished without a trace the moment Thomas's foreign
// presentation arrived for her).
let presentationSeq = 0;
// hubRequestId -> { filePath, resume } -- waiting for 'display-go' from the hub, in case this
// node is itself the main display and wants to speak normally (not presenting) (see
// playAndReport). Only THIS node can know whether its own screen is currently occupied by
// something else -- the hub decides centrally, this node only asks before it actually plays.
const pendingDisplayGo = new Map();

function interruptCurrent() {
  speaker.stopSpeaking();
  // currentPresentation is deliberately NOT cleared here anymore (that was the original bug:
  // every new task -- even a plain follow-up forward -- immediately cleared a running
  // presentation, before there was even an answer yet). That is now handled exclusively by the
  // new 'clear-presentation' branch below, which the hub sends ONLY on a genuinely new user
  // input (see clearDisplay() in agent-bridge-server.js).
  if (currentClaudeChild) { try { currentClaudeChild.kill(); } catch (e) {} currentClaudeChild = null; }
  // Discards a still-open speak-request/display-go wait for a now-superseded previous task --
  // otherwise a late-arriving display-go could play stale, outdated audio.
  for (const pending of pendingDisplayGo.values()) { for (const s of pending.segments || []) fs.unlink(s.filePath, () => {}); }
  pendingDisplayGo.clear();
}

// Stops ONLY a currently running playback (for an incoming foreign presentation, see 'present'
// below) -- deliberately WITHOUT killing this node's own claude child process: an incoming
// presentation only needs the speaker/screen for itself, not this node's own compute process.
// This node's own, still-running task is allowed to keep going undisturbed (see presentationSeq
// above) -- once it finishes later, the new speak-request/display-go gate logic already ensures
// its speech doesn't talk over the running presentation.
function stopPlaybackOnly() {
  speaker.stopSpeaking();
  for (const pending of pendingDisplayGo.values()) { for (const s of pending.segments || []) fs.unlink(s.filePath, () => {}); }
  pendingDisplayGo.clear();
}

// Speaks locally on THIS machine (own voice, own face) and afterward only informs Oscar of
// the text -- the hub does NOT read it aloud again.
// myRequestId is this node's OWN, local counter (for abort/superseded detection here);
// hubRequestId (if present) is only the ID reported back to Oscar, so he can match the reply
// to the right request. Both counters are deliberately kept separate, so a hub restart (its own
// counter starting back at 0) doesn't scramble the local counter here.
// suggestedNext: names extracted from the marker at the end of the reply (see followup-tag.js) --
// NOT spoken, only goes to the hub as its own field, which (after checking against the real
// roster) continues the follow-up chain from there.
// Pulled out of say() (presentation feature): the part AFTER successful synthesis, regardless of
// whether the audio file was just freshly synthesized or (in the sayWithPresentation fallback)
// was already synthesized earlier for a failed presentation attempt -- so a fallback doesn't need
// to synthesize via Piper a second time.
// isMainDisplay: true if THIS node is itself currently the main display (sent along by the hub at
// dispatch time, see the 'task' handler below) -- only then does normal (non-presenting) speech
// have to ask the hub first whether its own screen is currently free (speak-request/display-go),
// because this node itself cannot know whether, say, a foreign presentation is currently running
// (that would arrive via a completely different message, 'present').
// Reads the audio out of a 'present' message. Accepts BOTH the current shape (segments[]) and the
// older single-blob audioBase64 -- deliberately, so a hub still running an outdated copy of the
// project degrades to a working single-slide presentation instead of having its message silently
// ignored by the guard. Mirrored in agent-bridge-server.js (parallel logic on both sides, kept
// duplicated on purpose -- see CLAUDE.md).
// Returns null if there is no usable audio at all.
function normalizePresentSegments(msg) {
  if (Array.isArray(msg.segments) && msg.segments.length) {
    const usable = msg.segments.filter((s) => s && typeof s.audioBase64 === 'string');
    if (usable.length) return usable.map((s) => ({ audioBase64: s.audioBase64, text: typeof s.text === 'string' ? s.text : '' }));
  }
  if (typeof msg.audioBase64 === 'string') {
    return [{ audioBase64: msg.audioBase64, text: typeof msg.text === 'string' ? msg.text : '' }];
  }
  return null;
}

// Writes each segment's audio to its own file under audio_out/. Returns null (having cleaned up
// whatever was already written) if any of them fails, so callers get an all-or-nothing result.
function writeSegmentFiles(wireSegments) {
  const written = [];
  try {
    wireSegments.forEach((s, i) => {
      const filePath = path.join(__dirname, 'audio_out', `present-${Date.now()}-${i}.wav`);
      fs.writeFileSync(filePath, Buffer.from(s.audioBase64, 'base64'));
      written.push({ filePath, text: s.text });
    });
    return written;
  } catch (e) {
    console.error('[maindisplay] Could not write audio data:', e.message);
    for (const s of written) fs.unlink(s.filePath, () => {});
    return null;
  }
}

// segments: [{ filePath, text }] | null -- one entry per slide for a presentation that fell back
// to plain speech, and simply a single entry for an ordinary reply. Taking an array even here
// means a failed presentation can still be spoken in full (with its slide pauses intact) instead
// of having to throw away everything but the first segment.
function playAndReport(segments, text, myRequestId, hubRequestId, suggestedNext = [], isMainDisplay = false) {
  // "answer" goes out immediately (the text is final) -- purely informational, Oscar doesn't read it aloud.
  if (hubRequestId !== undefined) {
    link.send({ type: 'answer', requestId: hubRequestId, agentName: AGENT.name, text, suggestedNext });
  }
  if (segments && segments.length) {
    const playNow = () => {
      speaker.playSequence(segments.map((s) => s.filePath), (index) => {
        setOverlayState({ status: 'speaking', text: segments[index].text, agent: AGENT.name });
      }, () => {
        if (myRequestId === requestId) setOverlayState({ status: 'idle', text: '', agent: AGENT.name });
        // "speech-done" only goes out ONCE actually done speaking (not already once the text is
        // final) -- Oscar needs this to only send the next agent in a follow-up chain AFTER
        // this reply, not overlapping it.
        if (hubRequestId !== undefined) {
          link.send({ type: 'speech-done', requestId: hubRequestId, agentName: AGENT.name, text, suggestedNext });
        }
      });
    };
    if (isMainDisplay && hubRequestId !== undefined) {
      pendingDisplayGo.set(hubRequestId, { segments, resume: playNow });
      link.send({ type: 'speak-request', requestId: hubRequestId, agentName: AGENT.name, faceStyle: config.faceStyle || '' });
    } else {
      playNow();
    }
  } else {
    setOverlayState({ status: 'speaking', text, agent: AGENT.name, needsBrowserSpeech: true });
    // Without Piper (browser-speech fallback) there is no reliable "done speaking" point on the
    // node side -- any follow-up chain simply stops in this case, instead of guessing when the
    // browser is done.
  }
}

function say(text, myRequestId, hubRequestId, suggestedNext = [], isMainDisplay = false) {
  speaker.synthesizeSpeech(text, (filePath) => {
    if (myRequestId !== requestId) { if (filePath) fs.unlink(filePath, () => {}); return; }
    playAndReport(filePath ? [{ filePath, text }] : null, text, myRequestId, hubRequestId, suggestedNext, isMainDisplay);
  });
}

// Presents instead of speaking: synthesizes via Piper as usual, but instead of playing locally
// the finished audio is sent as base64 to the main display (hub acts as relay, see
// agent-bridge-server.js). Own overlay jumps straight to idle instead of "speaking" -- the reply
// is running on the other screen after all. Falls back to normal speech on any error (no Piper,
// send failure, e.g. because MAX_MSG_BYTES was exceeded) via playAndReport, without wasting the
// already-finished audio file, instead of letting the reply silently vanish.
// slideTexts: one spoken segment per slide (see splitSlideSegments) -- a single-slide
// presentation is the one-element case, no separate path.
function sayWithPresentation(slideTexts, myRequestId, hubRequestId, url, suggestedNext, isMainDisplay) {
  if (/localhost|127\.0\.0\.1/i.test(url)) {
    console.log(`[maindisplay] Warning: "${url}" looks like a local address -- might not be reachable from the main-display machine.`);
  }
  const text = slideTexts.join(' ');
  speaker.synthesizeAll(slideTexts, (filePaths) => {
    if (myRequestId !== requestId) { if (filePaths) for (const f of filePaths) fs.unlink(f, () => {}); return; }
    if (!filePaths) {
      // No Piper -- no reliable "done" point for a presentation, speak normally.
      playAndReport(null, text, myRequestId, hubRequestId, suggestedNext, isMainDisplay);
      return;
    }
    const segments = filePaths.map((filePath, i) => ({ filePath, text: slideTexts[i] }));
    let wireSegments;
    try {
      wireSegments = segments.map((s) => ({ audioBase64: fs.readFileSync(s.filePath).toString('base64'), text: s.text }));
    } catch (e) {
      console.error('[maindisplay] Audio file unreadable, speaking normally instead:', e.message);
      playAndReport(segments, text, myRequestId, hubRequestId, suggestedNext, isMainDisplay);
      return;
    }
    try {
      // audioBase64 only for the single-slide case -- see the same spot in agent-bridge-server.js
      // (costs nothing there, keeps an older hub working, and would only bloat a multi-slide deck).
      const sent = link.send({
        type: 'present-request', requestId: hubRequestId, agentName: AGENT.name, url, text, suggestedNext, faceStyle: config.faceStyle || '',
        segments: wireSegments,
        audioBase64: wireSegments.length === 1 ? wireSegments[0].audioBase64 : undefined
      });
      if (!sent) throw new Error('not connected to the hub');
      for (const s of segments) fs.unlink(s.filePath, () => {});
      // ownDisplayHidden: hide own overlay completely (not just idle) while the reply is running
      // on the FOREIGN main-display screen -- otherwise an idle face would sit here while the
      // actual reply is seen/heard elsewhere.
      setOverlayState({ status: 'idle', text: '', agent: AGENT.name, ownDisplayHidden: true });
    } catch (e) {
      // e.g. MAX_MSG_BYTES exceeded, which a long multi-slide deck can genuinely hit -- the whole
      // reply is still spoken locally rather than vanishing, just without the deck.
      console.error('[maindisplay] Could not send presentation, speaking normally instead:', e.message);
      playAndReport(segments, text, myRequestId, hubRequestId, suggestedNext, isMainDisplay);
    }
  });
}

function runTask(userText, myRequestId, hubRequestId, isMainDisplay = false) {
  interruptCurrent();
  setOverlayState({ status: 'thinking', text: '', agent: AGENT.name });

  // Only include it when it's new (see the reasoning at peersDirty above) -- TAG_HINT, in
  // contrast, is included on EVERY turn, because that's a behavioral instruction, not a fact.
  const peersLine = peersDirty ? buildPeersLine(knownPeers) : '';
  peersDirty = false;
  const hasMainDisplay = knownMainDisplay !== null;
  // The folder is named absolutely once the agent works elsewhere -- otherwise it would helpfully
  // create presented_content/ inside the project and write decks there, which the overlay server
  // (serving from THIS folder) would never find.
  const tagHint = buildTagHint(hasMainDisplay, CONTENT_URL_PREFIX, CONTENT_DIR_FOR_PROMPT);

  // Rebuilt from the folder every turn (see the same spot in agent-bridge-server.js): files this
  // agent moved or deleted last turn stop being mentioned by themselves.
  const inboxFiles = inboxLib.listInbox(__dirname);
  const inboxLine = inboxLib.buildInboxLine(inboxFiles, newInboxFiles, INBOX_DIR_FOR_PROMPT);
  newInboxFiles.clear();

  const args = ['-p'];
  if (sessionId) {
    args.push(`${userText} ${peersLine} ${inboxLine}`.replace(/\s+/g, ' ').trim(), '--resume', sessionId);
  } else {
    const persona = `You are ${AGENT.name}, part of a network of AI assistants coordinated by Oscar. ${peersLine} ${AGENT.personality} ${inboxLine} Message: ${userText}`
      .replace(/\s+/g, ' ').trim();
    args.push(persona);
  }
  // tagHint goes via --append-system-prompt, no longer embedded in the message: observed live
  // (2026-08-17) that a forceful action instruction ("IMPORTANT, do this NOW...") sitting inside
  // the "user" message got flagged by the model as a possible prompt-injection attempt and was
  // deliberately ignored -- rightly so, the same caution Claude generally applies to instructions
  // embedded inside messages. The real, operator-intended system channel exists for exactly this.
  // Still included on EVERY turn regardless (a behavioral instruction, not a one-time fact).
  args.push('--append-system-prompt', tagHint);
  args.push('--output-format', 'json');
  // Optional per agent in net-config.json: "effort": "low|medium|high|xhigh|max" -- controls how
  // much thinking effort the CLI invests before answering. Omitted = CLI default, unchanged.
  // Applies per call (like --output-format), not just on the first turn -- so it's appended here
  // centrally, regardless of whether this is a fresh or resumed session.
  if (config.effort) args.push('--effort', config.effort);
  // Optional per agent in net-config.json: "allowedTools": "WebSearch,WebFetch" -- without this
  // these tools are forbidden by default in headless mode (-p, no terminal for a follow-up
  // question) and get silently rejected (empirically verified: the CLI attempts WebSearch, gets
  // an empty permission_denials rejection, tells the user "I don't have that permission yet").
  // Deliberately NOT --dangerously-skip-permissions -- that would also unlock Bash/Write/Edit,
  // here only internet access specifically should be allowed.
  // Same principle as in agent-bridge-server.js: every agent automatically gets write access to
  // EXACTLY its own presented_content/ folder, via Edit(...) (the CLI does accept Write(...) path
  // rules, but never actually enforces them -- empirically confirmed). ALWAYS appended, in
  // addition to config.allowedTools, not instead of it.
  // "Skill" is in the same always-appended group -- see the matching spot in
  // agent-bridge-server.js: without it the project's own skills (.claude/skills/, e.g. the
  // multi-slide "presentation" one) are discovered but cannot be invoked once --allowedTools
  // narrows the set.
  // Edit(inbox/**) so this agent can act on files it was handed, not merely read them -- see the
  // matching spot in agent-bridge-server.js.
  // Relative while the agent runs in the AliveAgents folder; absolute once it works elsewhere,
  // because these two folders always live HERE, not in the project. Paired with the --add-dir
  // below -- an absolute rule without it grants nothing.
  const own = (sub) => (WORK_DIR === __dirname ? `${sub}/**` : `${path.join(__dirname, sub).replace(/\\/g, '/')}/**`);
  const baseTools = `Edit(${own('presented_content')}),Edit(${own('inbox')}),Skill`;
  const allowedTools = config.allowedTools ? `${config.allowedTools},${baseTools}` : baseTools;
  args.push('--allowedTools', allowedTools);
  // Optional per agent in net-config.json: "permissionMode": one of the levels the CLI itself
  // supports -- "manual" (every change asks for confirmation, CLI default), "acceptEdits"
  // (Write/Edit without confirmation, Bash still locked), "dontAsk"/"auto", or "bypassPermissions"
  // (everything without confirmation, verified: identical to --dangerously-skip-permissions). A
  // single field with the real CLI names instead of several custom yes/no switches -- freely
  // choosable per agent. "bypassPermissions" is the riskiest level (see the CLI's own warning:
  // "Recommended only for sandboxes with no internet access") -- only set deliberately per agent,
  // no one silently gets a higher level than needed here.
  if (config.permissionMode) args.push('--permission-mode', config.permissionMode);
  // Security gap empirically found and closed 2026-08-17 (see the same spot in
  // agent-bridge-server.js for the full derivation): without any flag at all, the CLI in headless
  // mode lets the "PowerShell" tool (the only shell tool on Windows) through without asking.
  // Only relevant for a node WITHOUT its own permissionMode -- Nova's deliberately broader
  // bypassPermissions is unaffected by this.
  if (!config.permissionMode) args.push('--disallowedTools', 'PowerShell');
  // Optional per agent in net-config.json: "mcpConfig": "<path to an MCP server JSON>" or an
  // inline JSON string -- for additional connectors (e.g. Cloudflare, a booking system, ...).
  // Not a security bypass like dangerouslySkipPermissions, so also available for Oscar (see
  // agent-bridge-server.js) -- a single tool addition, not a blanket grant. The concrete
  // connector (which service, which credentials) has to be set up separately as its own MCP
  // server config, this here is just the socket for it.
  // Resolved against THIS folder, not the working directory: an mcpConfig like
  // "cloudflare-mcp.local.json" lives next to net-config.json, and once workDir points at a real
  // project the CLI would otherwise look for it there and fail with "config file not found"
  // (reported live 2026-08-25). An inline JSON string is passed through untouched.
  if (config.mcpConfig) {
    const raw = String(config.mcpConfig).trim();
    const resolved = raw.startsWith('{') || path.isAbsolute(raw) ? raw : path.join(__dirname, raw);
    args.push('--mcp-config', resolved);
  }
  // Optional per agent in net-config.json: "chrome": true -- enables the Claude-in-Chrome
  // integration (mcp__claude-in-chrome__* tools). ADDITIONALLY needs a real, running Chrome with
  // the Claude-in-Chrome extension AND a one-time manual approval directly in the extension
  // (empirically verified: the first real tool call is rejected with "needs your approval in the
  // extension"). This one step is a trust mechanism belonging to the extension itself, not a
  // Claude Code permission check -- so it CANNOT be bypassed via permissionMode/
  // dangerously-skip-permissions, it has to be confirmed by hand once on the respective machine.
  if (config.chrome) args.push('--chrome');

  // Opens the AliveAgents folder as a second root when the agent works elsewhere, so
  // presented_content/ and inbox/ stay reachable. Omitted when they are the same folder -- adding
  // the working directory to itself is noise.
  if (WORK_DIR !== __dirname) args.push('--add-dir', __dirname);

  const child = spawn(CLAUDE_EXE, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: WORK_DIR });
  currentClaudeChild = child;

  let out = '';
  let errOut = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { errOut += d.toString(); });

  child.on('error', (err) => {
    if (currentClaudeChild === child) currentClaudeChild = null;
    if (myRequestId !== requestId) return;
    console.error('Could not start "claude":', err.message);
    say('I can\'t find the Claude CLI on my machine right now.', myRequestId, hubRequestId, [], isMainDisplay);
  });

  child.on('close', (code) => {
    if (currentClaudeChild === child) currentClaudeChild = null;
    if (myRequestId !== requestId) return;
    if (code !== 0) {
      console.error('claude CLI error:', errOut);
      say('Something went wrong on my end.', myRequestId, hubRequestId, [], isMainDisplay);
      return;
    }
    let text = '';
    try {
      const parsed = JSON.parse(out);
      text = parsed.result || '';
      if (parsed.session_id) { sessionId = parsed.session_id; saveSessionId(sessionId); }
      // Surface tokens for usage monitoring -- newly processed (full price) shown separately from
      // read-from-cache (much cheaper), so a cost spike is visible in the log instead of only
      // guessable from the usage-limit percentage (see the same spot in agent-bridge-server.js).
      const u = parsed.usage;
      if (u) {
        console.log(`[${AGENT.name}] Tokens: ${u.cache_creation_input_tokens || 0} new, ${u.cache_read_input_tokens || 0} from cache, ${u.output_tokens || 0} reply.`);
      }
    } catch (e) {
      text = out.trim();
    }
    // The presentation marker is extracted FIRST (it's the outermost one, see followup-tag.js),
    // FORWARD only afterward on the rest -- so both can be combined in a single reply.
    const { cleanText: afterPresentation, presentationUrl: rawPresentationUrl } = extractPresentationTag(text);
    // See the same spot in agent-bridge-server.js: a URL for one of our own files is rebuilt from
    // the current base, because the model reproduces older base URLs out of its session history.
    const presentationUrl = rawPresentationUrl ? localizeContentUrl(rawPresentationUrl, `http://${getLanIp()}:${OVERLAY_PORT}`) : rawPresentationUrl;
    if (rawPresentationUrl && presentationUrl !== rawPresentationUrl) {
      console.log(`[maindisplay] corrected a stale content URL: ${rawPresentationUrl}`);
    }
    const { cleanText, suggested } = extractFollowUpTag(afterPresentation);
    // Split unconditionally, not only when actually presenting: a [SLIDE] marker that survived
    // into the TTS would be read out loud ("bracket slide"). Rejoining the segments is what the
    // non-presenting paths below speak, so a stray marker simply disappears.
    const slideSegments = splitSlideSegments(cleanText);
    const spokenText = slideSegments.join(' ');
    // Shows HERE (before any hub-side check) whether there was a marker in the raw text at all --
    // without this there is no way to tell from the outside between "no marker attempted" and
    // "marker attempted, but discarded by the hub" (the logged spoken text is ALWAYS already
    // cleaned). Important for debugging marker reliability.
    console.log(`[${AGENT.name}] Marker in raw text: ${suggested.length ? suggested.join(', ') : '(none)'}`);
    console.log(`[${AGENT.name}] Presentation marker: ${presentationUrl || '(none)'}${slideSegments.length > 1 ? `, ${slideSegments.length} slides` : ''}`);
    if (presentationUrl && knownMainDisplay) {
      sayWithPresentation(slideSegments, myRequestId, hubRequestId, presentationUrl, suggested, isMainDisplay);
      return;
    }
    if (presentationUrl && !knownMainDisplay) {
      console.log('[maindisplay] Presentation requested, but no main display known -- speaking normally.');
    }
    say(spokenText, myRequestId, hubRequestId, suggested, isMainDisplay);
  });
}

const link = connectToHub({
  selfName: config.self,
  hubName: config.hubName,
  host: config.hubHost,
  port: config.hubPort,
  // "mainDisplay":true in net-config.json (optional) advertises this node to the hub as the
  // default main display -- only the starting value, see /maindisplay in agent-bridge-server.js
  // for the actual, low-effort way to reassign the role while running.
  onOpen: () => link.send({ type: 'hello', agentName: AGENT.name, domain: config.domain || '', mainDisplay: !!config.mainDisplay }),
  onMessage: (msg) => {
    if (msg.type === 'task' && typeof msg.text === 'string') {
      const myRequestId = ++requestId; // own, local counter -- independent of the hub
      console.log(`[${AGENT.name}] Task: ${msg.text}`);
      runTask(msg.text, myRequestId, msg.requestId, !!msg.isMainDisplay);
    }
    if (msg.type === 'reset') {
      sessionId = null;
      try { fs.unlinkSync(SESSION_FILE); } catch (e) {}
      peersDirty = true; // a fresh session should definitely get the peer list again
      currentPresentation = null;
      for (const pending of pendingDisplayGo.values()) { for (const s of pending.segments || []) fs.unlink(s.filePath, () => {}); }
      pendingDisplayGo.clear();
      console.log(`[${AGENT.name}] Conversation reset.`);
    }
    // Comes from the hub ONLY on a genuinely new user input (see clearDisplay() in
    // agent-bridge-server.js) -- a plain follow-up forward no longer triggers this (that was the
    // original bug: the presentation vanished on the mere dispatch alone).
    // Files a human dropped onto this agent on the hub machine, arriving chunked over the mTLS
    // link (see inbox.js). Nothing is announced to the model here -- the next turn simply lists
    // what is in inbox/, which keeps a delivery mid-conversation from interrupting anything.
    if (msg.type === 'file-begin') { inboxReceiver.begin(msg); }
    if (msg.type === 'file-chunk') { inboxReceiver.chunk(msg); }
    if (msg.type === 'file-end') { inboxReceiver.end(msg); }
    if (msg.type === 'clear-presentation') {
      currentPresentation = null;
      // The push is REQUIRED, and the history here is worth knowing before touching it again.
      // The hub sends this on a genuinely new user input, which is exactly when the deck should
      // come off the screen. Clearing the variable alone never reaches the browser: overlay state
      // only travels via setOverlayState. On a machine that is purely a DISPLAY -- it gets no task
      // of its own, so nothing else pushes a state -- the old deck then stayed up indefinitely.
      //
      // It LOOKED correct for a while only by accident: a since-fixed bug rebuilt a bogus
      // presentation object with no url while the previous audio finished, and the overlay reads
      // "no url" as "nothing presented" and tore the iframe down. Fixing that bug removed the
      // accidental clearing and exposed this missing push (reported 2026-08-25: "jetzt geht die
      // Präsentation nicht mehr weg beim nächsten Befehl").
      // Status/text/agent are carried over unchanged, so this drops the presentation and nothing
      // else -- the face keeps whatever it was doing.
      const prev = overlay.getState();
      setOverlayState({ status: prev.status, text: prev.text, agent: prev.agent });
    }
    // Reply to a question posed via speak-request (see playAndReport): the screen is now free,
    // actually play. updatePresentationSpeaker updates the small corner display to this agent, if
    // the reply belongs to the SAME chain as the running presentation (the URL stays unchanged,
    // see presentationOwnerRequestId in the hub).
    if (msg.type === 'display-go' && msg.requestId !== undefined) {
      const pending = pendingDisplayGo.get(msg.requestId);
      if (!pending) return; // not (or no longer) what's being waited on
      pendingDisplayGo.delete(msg.requestId);
      if (msg.updatePresentationSpeaker && currentPresentation) {
        currentPresentation = Object.assign({}, currentPresentation, { agentName: msg.agentName, faceStyle: msg.faceStyle });
      }
      pending.resume();
    }
    if (msg.type === 'peers' && Array.isArray(msg.list)) {
      knownPeers = msg.list;
      peersDirty = true; // network has changed -- the next turn should pick that up
      knownMainDisplay = typeof msg.mainDisplay === 'string' ? msg.mainDisplay : null;
      console.log(`[${AGENT.name}] Network updated: ${knownPeers.map((p) => p.name).join(', ') || '(no one else)'}${knownMainDisplay ? `, main display: ${knownMainDisplay}` : ''}`);
    }
    // This node is currently serving as the main display -- another agent (msg.agentName) has
    // something to show. Only stops a currently running playback (stopPlaybackOnly, its own
    // presentationSeq counter) -- no longer the full interruptCurrent(): an incoming foreign
    // presentation must not abort this node's own, independently running task (a real bug, found
    // live via testing -- see the presentationSeq comment above). The own task only needs the
    // screen/speaker once IT is done, and by then it correctly gets queued behind this
    // presentation via speak-request/display-go anyway.
    if (msg.type === 'present' && typeof msg.url === 'string') {
      const wireSegments = normalizePresentSegments(msg);
      if (!wireSegments) return; // no usable audio -- not a presentation this node can show
      const myPresentationSeq = ++presentationSeq;
      stopPlaybackOnly();
      console.log(`[${AGENT.name}] showing presentation from "${msg.agentName}"${wireSegments.length > 1 ? ` (${wireSegments.length} slides)` : ''}: ${msg.url}`);
      const segments = writeSegmentFiles(wireSegments);
      if (!segments) return;
      currentPresentation = { agentName: msg.agentName, url: msg.url, faceStyle: msg.faceStyle, slide: 0 };
      setOverlayState({ status: 'speaking', text: segments[0].text || msg.text || '', agent: AGENT.name });
      speaker.playSequence(segments.map((s) => s.filePath), (index) => {
        // Runs in the pause BEFORE each segment (see playSequence in speech.js) -- slide 0 is
        // already on screen from the line above. Guarded by presentationSeq for the same reason
        // the idle reset below is: a newer presentation arriving mid-deck must not have this one
        // keep flipping slides underneath it.
        // currentPresentation===null is the case that actually bit (observed live 2026-08-25): a
        // new user input clears the display via 'clear-presentation', but THIS playback keeps
        // running to the end of its audio. Object.assign({}, null, {slide}) then produced a
        // presentation object carrying only a slide number -- no url, no agentName -- and the
        // overlay reads "no url" as "nothing is being presented" and tears the iframe down
        // mid-sentence. presentationSeq does not catch it: no NEW presentation started, the old
        // one was merely cleared.
        if (index === 0 || myPresentationSeq !== presentationSeq || !currentPresentation) return;
        currentPresentation = Object.assign({}, currentPresentation, { slide: index });
        setOverlayState({ status: 'speaking', text: segments[index].text || msg.text || '', agent: AGENT.name });
      }, () => {
        // currentPresentation is DELIBERATELY left in place here (user's wish: the presentation
        // should stay up until a genuinely new user input arrives) -- only the own
        // 'clear-presentation' branch above still cleans that up, no longer interruptCurrent().
        // Only status/text jump back to idle, so the face doesn't "speak" forever while no more
        // sound is actually coming; setOverlayState() still keeps attaching currentPresentation
        // regardless. The deck also stays on its LAST slide, which is what makes clicking back
        // through it by hand afterwards work. Deliberately checked against presentationSeq (not
        // requestId) -- an own task that happens to finish in the meantime should not trigger/
        // block the idle reset here, that's a fully separate process (see presentationSeq above).
        if (myPresentationSeq === presentationSeq) {
          setOverlayState({ status: 'idle', text: '', agent: AGENT.name });
        }
        // requestId/agentName belong to the ORIGINAL presenter (msg.*), not this node itself --
        // otherwise the hub would attribute the follow-up chain to the wrong agent.
        link.send({ type: 'presentation-done', requestId: msg.requestId, agentName: msg.agentName, text: msg.text || '' });
      });
    }
  }
});

// Follows the hub when the network hands out different addresses -- a different flat, a hotspot,
// a router change. Without this, hubHost in net-config.json is a literal address that quietly
// stops existing and the agent dials into nothing forever (2026-08-31, exactly that).
// A beacon is only acted on if it names THIS hub and carries the fingerprint of the certificate
// this node already pinned; and even then the connection itself is still verified the usual way,
// so the worst a forged beacon can do is cause a failed attempt.
try {
  listenForHub({
    hubName: config.hubName,
    expectedFp: fingerprintOfCertPem(loadPeerCert(config.hubName)),
    currentHost: config.hubHost,
    onFound: (address) => {
      // Only while actually disconnected. A hub with several network adapters (Hyper-V, WSL, VPN)
      // broadcasts from all of them, so beacons arrive from addresses that may not even be
      // reachable from here -- observed live in testing, where the node hopped between a virtual
      // and the real address, tearing down a perfectly good connection each time.
      // Discovery is for finding a hub that is lost, not for second-guessing one that answers.
      // An address that turns out to be unreachable simply fails to connect, which leaves the
      // node open to the next beacon, so a wrong guess self-corrects.
      if (link.isUp()) return;
      if (link.setHost(address)) {
        console.log(`[discovery] reconnecting to ${config.hubName} at ${address}`);
      }
    }
  });
} catch (e) {
  console.error('[discovery] could not start listening:', e.message);
}

// Terminal input here is optional, but handy for testing locally right on this machine, without
// having to go through Oscar.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on('line', (line) => {
  if (line.trim()) { const id = ++requestId; runTask(line.trim(), id); }
});

console.log(`Node "${config.self}" started, agent name "${AGENT.name}".`);
console.log(`Own face/own voice at http://localhost:${OVERLAY_PORT}/`);
console.log(`Connecting to hub ${config.hubHost}:${config.hubPort} ...`);
