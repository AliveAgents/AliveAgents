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
const { startOverlayServer, getLanIp, normalizeScreen, readOwnContent, normalizePage, isWebsite, presentationLabel } = require('./overlay-server.js');
const { extractFollowUpTag, buildSystemPointer, extractPresentationTag, splitSlideSegments, extractIdentityTag } = require('./followup-tag.js');
const agentHome = require('./agent-home.js');
const inboxLib = require('./inbox.js');
const { normalizeTint } = require('./identity.js');
const { cleanName, cleanDomain } = require('./agent-registry.js');
const permissionsLib = require('./permissions.js');
const deviceConfirm = require('./device-confirm.js');
const { startClaude, MESSAGE_MAX_CHARS } = require('./claude-cli.js');
const updaterLib = require('./updater.js');

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

// Who this agent is on the network is the hub's decision (agent-registry.js), delivered with every
// roster update and cached in the agent's home. config.agentName and config.domain only introduce this
// machine to a hub that has no record of it yet. The cache is what the face shows before the hub is
// reachable, and what the next hello repeats -- the config from the day of enrollment would read, at
// the hub, like a machine claiming a name it no longer has.
const confirmedIdentity = (() => {
  const cached = agentHome.readIdentity(agentHome.agentHome(config.self));
  const name = cached && cleanName(cached.name);
  const domain = cached && cleanDomain(cached.domain);
  return name && domain !== null ? { name, domain } : null;
})();
let ownDomain = confirmedIdentity ? confirmedIdentity.domain : (config.domain || '');

const AGENT = {
  name: confirmedIdentity ? confirmedIdentity.name : (config.agentName || 'Node'),
  personality: config.personality
    || 'Direct and pragmatic, answering in 1-3 short, chat-style sentences. No preamble phrases like "As an AI, I would say".'
};
// Name and responsibility as of this agent's previous turn, so a change in between is told once, as
// an event (see describeIdentityChange). Starts at what this process started with, so a rename that
// arrives before the first turn is told too.
let identityAtLastTurn = { name: AGENT.name, domain: ownDomain };
// Why this agent's last request to change its own name or responsibility did not go through, told
// once on its next turn (see describeIdentityDecline). An accepted request needs no notice of its
// own: it arrives as a new "you" and is told through identityAtLastTurn.
let identityNotice = '';

// Own Piper voice model per agent (e.g. a female voice for Nova, instead of the hub's own male
// Oscar voice). Falls back to the Oscar voice if the config doesn't specify one of its own.
// piperExe/voiceModel are simply unused on an Android node -- speech.js takes the Android branch
// before it ever looks at them, because Piper has no build that runs under Termux. The optional
// "androidTts" block in net-config.json is what gives a phone agent its own voice instead:
// { "language": "en", "pitch": 1.15, "rate": 1.0 } -- pitch and rate are how two phone agents end
// up sounding different, since Android offers one engine rather than a folder full of voices.
const speaker = createSpeaker({
  piperExe: path.join(__dirname, 'tools', 'piper', 'piper.exe'),
  voiceModel: path.join(__dirname, 'tools', 'piper', 'voices', config.piperVoice || 'en_US-ryan-high.onnx'),
  audioDir: path.join(__dirname, 'audio_out'),
  androidTts: config.androidTts
});

// Talking to this agent directly, on its own device, while the hub is out of reach (user's wish,
// 2026-09-22: take the phone along, leave everything else at home). While the hub is reachable it stays
// the one microphone of the network and this device takes tasks only from it. The microphone appears
// only after the hub has been gone for OFFLINE_AFTER_MS, so a hub that is merely reconnecting does not
// make one flicker onto the page; it goes the moment the hub is back. See hubReachable below.
const OFFLINE_AFTER_MS = 10000;
let hubUp = false;
let localInput = false;
let offlineTimer = null;

// How long one turn may take before this agent gives up on it and says so (see the watchdog in
// runTask). "taskTimeoutMinutes" in net-config.json overrides it, 0 switches it off entirely --
// off means a stuck turn silences the agent for good, so switch it off only with a reason.
const TASK_TIMEOUT_MINUTES = Number.isFinite(Number(config.taskTimeoutMinutes)) ? Math.max(0, Number(config.taskTimeoutMinutes)) : 15;
const TASK_TIMEOUT_MS = TASK_TIMEOUT_MINUTES * 60000;

// Own overlay (face) on this machine. Its microphone and typed input reach handleLocalInput only while
// localInput is on -- overlay-server.js checks inputEnabled on every message, not just the button.
const OVERLAY_PORT = config.overlayPort || 8787;
// The class of the screen this agent's face page is shown on, or null (see normalizeScreen in
// overlay-server.js). It changes when a browser on this machine opens or closes the page -- not when
// the phone is turned, the class has no orientation for exactly that reason.
let myScreen = null;
const overlay = startOverlayServer({
  port: OVERLAY_PORT,
  onUserInput: (text, agent, source) => handleLocalInput(text, source),
  inputEnabled: () => localInput,
  // This agent's own face, drawn from the recipe it was given when it was set up (face-design.js).
  faceRecipe: config.faceRecipe || null,
  // This device's own permissions page. permissionStore is created further down; nothing can ask
  // before the module has finished loading.
  onPageMessage: (msg, reply) => (updaterLib.PAGE_MESSAGE_TYPES.includes(msg.type)
    ? updater.handlePageMessage(msg, reply)
    : permissionsLib.handlePageMessage(permissionStore, msg, reply, (obj) => overlay.pushPage(obj))),
  onScreenChange: (screen) => {
    myScreen = screen;
    refreshSkillData();
    try { link.send({ type: 'screen', screen }); } catch (e) { /* not connected yet -- the hello carries it */ }
  }
});

// Presentation currently running on THIS screen (if this node is currently the main display) --
// { agentName, url } | null. A thin wrapper around overlay.setState is needed because that
// REPLACES the whole state instead of merging it (see overlay-server.js): without this, any
// incidental overlay.setState call would wipe a presentation currently running on this own
// screen. Same principle as Oscar's own setOverlayState wrapper in agent-bridge-server.js --
// replaces ALL direct overlay.setState calls in this file from here on.
let currentPresentation = null;
// Validated once at startup rather than on every state push: an invalid tint is a
// configuration mistake, not a runtime condition, and normalizeTint returns null for anything it
// does not fully trust -- at which point the face simply keeps its own built-in colours.
const FACE_TINT = normalizeTint(config.faceTint);
// Sent along whenever this agent's face is to appear on ANOTHER machine's screen: a generated face
// lives only as a recipe in this machine's own config, so the screen showing it has no way to look it
// up. undefined for an agent wearing one of the hand-written faces -- those exist everywhere.
const OWN_FACE_RECIPE = config.faceStyle === 'own' && config.faceRecipe ? config.faceRecipe : undefined;

// The style name under which another agent's face can be shown HERE. A generated face ('own') only
// means something on the machine it belongs to, so the recipe that came with the message is
// registered with this machine's overlay server, which then serves it under a name of its own.
function faceStyleFor(agentName, faceStyle, faceRecipe) {
  if (faceStyle !== 'own' || !faceRecipe) return faceStyle;
  return overlay.setGuestFace(agentName, faceRecipe) || faceStyle;
}

function setOverlayState(partial) {
  // config.faceStyle || '' instead of borrowing some concrete default value: a node with no
  // faceStyle set in its net-config.json should explicitly hit the overlay script's generic
  // fallback face, not accidentally take on the look of a DIFFERENT agent (as a hardcoded 'kai'
  // here would silently do).
  overlay.setState(Object.assign({}, partial, { presentation: currentPresentation, faceStyle: config.faceStyle || '', faceTint: FACE_TINT }));
}
setOverlayState({ status: 'idle', text: '', agent: AGENT.name });

// Own session file -> this agent has its own memory, separate from Oscar's.
const SESSION_FILE = path.join(__dirname, `.session-${config.self}.json`);

// The session file also records WHICH working directory the session belongs to, because Claude
// Code files a session under the directory it ran in. When that directory changes -- the move from
// this checkout into the agent's own home, or someone editing workDir -- resuming the old id fails
// on every turn until something clears it. Files written before this field existed are attributed
// to where the agent used to run: its workDir if it had one (so Nova keeps her memory), otherwise
// this checkout (so a node that ran here starts a fresh conversation in its home).
function loadSessionId() {
  try {
    const saved = readJsonFile(SESSION_FILE);
    const legacyCwd = config.workDir ? path.resolve(config.workDir) : __dirname;
    const savedCwd = saved.cwd || legacyCwd;
    if (path.resolve(savedCwd) !== path.resolve(WORK_DIR)) {
      console.log(`[${AGENT.name}] Starting a new conversation: the saved one belongs to ${savedCwd}, this agent now works in ${WORK_DIR}.`);
      return null;
    }
    return saved.sessionId || null;
  } catch (e) { return null; }
}
function saveSessionId(id) {
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessionId: id, cwd: WORK_DIR })); } catch (e) {}
}
// sessionId itself is loaded further down, once WORK_DIR exists.

// Communicated by the hub via {type:'peers'}: every other connected agent (name + domain), and who
// the main display is. Neither goes into a prompt any more. Both are written into this agent's
// skill data files (agents.md, display.md) the moment they change, and the agent reads them when it
// needs them. knownMainDisplay is still consulted here, to decide whether a presentation marker in
// a reply can actually be shown.
let knownPeers = [];
let knownMainDisplay = null;
// The main display's screen class, and the name of a main display that is set but offline -- both
// from the hub's peers message, both only ever turned into fixed phrases in display.md.
let knownMainDisplayScreen = null;
let knownMainDisplayOffline = null;
// The presentation most recently handed to the hub, kept until the hub shows it or hands it back
// (present-declined) -- in which case it appears on this agent's own screen instead.
let pendingOwnPresentation = null;
// The other agents' names as of this agent's previous turn, so it can be told once, as an event,
// who joined or left in between. null until this process has handled its first turn.
let rosterAtLastTurn = null;

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
// The agent's own home, outside this checkout -- see agent-home.js for why that matters. Without a
// workDir the agent now works IN its home rather than in this checkout, which is what keeps the
// repository's developer CLAUDE.md out of every single turn.
const HOME = agentHome.agentHome(config.self);

const WORK_DIR = (() => {
  if (!config.workDir) return HOME;
  const resolved = path.resolve(config.workDir);
  if (!fs.existsSync(resolved)) {
    console.error(`[agent] workDir "${resolved}" does not exist -- working in ${HOME} instead`);
    return HOME;
  }
  return resolved;
})();

// Always absolute now. The agent never runs inside this checkout any more, so a relative
// "presented_content" or "inbox" would resolve against its home or its project -- it would write
// decks and look for files somewhere the overlay server never serves.
const CONTENT_DIR_FOR_PROMPT = agentHome.slash(path.join(__dirname, 'presented_content'));
const INBOX_DIR_FOR_PROMPT = agentHome.slash(path.join(__dirname, 'inbox'));
// The agent's own folder for files it creates. In its home, so it survives restarts and never
// mixes with this checkout -- see prepareHome in agent-home.js, which also creates it.
const WORKSPACE_DIR = agentHome.slash(agentHome.workspaceDir(HOME));

// Skills are generated fresh on every start; new-agent is deliberately absent, only the hub can act
// on it. Creating the skills also creates the home, which has to exist before it can be a cwd.
agentHome.prepareHome({
  name: config.self,
  skills: ['network', 'presentation', 'inbox', 'workspace', 'sources'],
  vars: { INBOX_DIR: INBOX_DIR_FOR_PROMPT, WORKSPACE_DIR }
});
console.log(`[agent] working in ${WORK_DIR}`);

// Keeps the two skill data files current. Called on every roster update from the hub and once
// before each turn; both writes are no-ops when nothing changed.
function refreshSkillData() {
  agentHome.writeRoster(HOME, AGENT.name, knownPeers, ownDomain);
  const onOwnScreen = !knownMainDisplay || knownMainDisplay === AGENT.name;
  agentHome.writeDisplay(HOME, {
    selfName: AGENT.name,
    mainDisplay: knownMainDisplay,
    offlineMainDisplay: knownMainDisplayOffline,
    screen: onOwnScreen ? myScreen : knownMainDisplayScreen,
    contentDir: CONTENT_DIR_FOR_PROMPT
  });
}
refreshSkillData();

let sessionId = loadSessionId();

// Files that arrived since this agent's last reply, so they can be marked [NEW] exactly once.
// This device's own confirmation dialog (device-confirm.js): Windows Hello, or the fingerprint prompt on a
// phone. The only thing that lets a change to this agent's permissions through -- it names the change.
const confirmer = deviceConfirm.createConfirmer();
// What this agent may do: set on this device's own face page only, and confirmed with the dialog above
// (permissions.js). The allowedTools/chrome/mcpConfig/permissionMode fields in net-config.json are just
// what it starts with.
const permissionStore = permissionsLib.createPermissionStore({
  id: config.self, role: 'node', agentName: () => AGENT.name,
  seed: permissionsLib.seedFromConfig({ role: 'node', allowedTools: config.allowedTools, chrome: config.chrome, mcpConfig: config.mcpConfig, permissionMode: config.permissionMode }),
  available: { mcp: !!config.mcpConfig, workDir: path.resolve(WORK_DIR) !== path.resolve(HOME) },
  confirmer
});
confirmer.ready.then(() => overlay.pushPage({ type: 'permissions', status: permissionStore.status() }));

// This agent's own program, kept up to date by itself (updater.js) -- not through the hub, which must be
// able to work with agents that run entirely different code. Idle: no turn and no presentation running.
const updater = updaterLib.createUpdater({
  root: __dirname, agentName: () => AGENT.name, confirmer,
  isIdle: () => !currentClaudeChild && !currentPresentation && overlay.getState().status === 'idle',
  onChange: (update) => overlay.pushPage({ type: 'update', update })
});
updater.start();

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
// Reads the slides out of a 'present' message. Two kinds of segment can arrive:
//   { audioBase64, text }   the presenter's own recorded voice -- what a Windows or Linux agent sends
//   { text, speakText }     text only -- what a phone sends, because its TTS engine cannot record to
//                           a file; the display speaks it in its own voice (added 2026-09-14)
// All segments must be usable, or narration and slides would drift apart, so one bad segment
// rejects the list. The older single-blob audioBase64 is still accepted, so a machine running an
// outdated copy degrades to a one-slide presentation instead of being ignored. Returns null if
// nothing usable arrived. Mirrored in agent-bridge-server.js.
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
// gets all or nothing. Audio is written as it came, unless this machine cannot play audio files
// (a phone without play-audio): then the slide text is spoken by the local engine instead, which
// keeps the presentation narrated and in step, just not in the presenter's own voice.
// Mirrored in agent-bridge-server.js.
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
      link.send({ type: 'speak-request', requestId: hubRequestId, agentName: AGENT.name, faceStyle: config.faceStyle || '', faceTint: FACE_TINT, faceRecipe: OWN_FACE_RECIPE });
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
// No main display is set, so the presentation runs on this agent's own screen (user's decision,
// 2026-09-15: without a main display, everyone presents on their own). Shaped like playAndReport
// -- 'answer' first, 'speech-done' at the end -- so the hub's follow-up chain treats it exactly like
// a spoken reply, just with the slides turning in the pauses between segments. presentationSeq
// guards it the same way it guards an incoming presentation: whatever starts later wins the screen.
function presentOnOwnScreen(slideTexts, myRequestId, hubRequestId, url, suggestedNext) {
  const text = slideTexts.join(' ');
  // This agent's own page is shown from memory under a fresh local link (see showPage in
  // overlay-server.js), exactly like a page that arrived from someone else.
  const page = readOwnContent(url);
  if (!page && !isWebsite(url)) {
    console.error(`[maindisplay] Nothing to show for "${presentationLabel(url)}" -- no such page, too big, or not a website address. Speaking without it.`);
    playAndReport(null, text, myRequestId, hubRequestId, suggestedNext, false);
    return;
  }
  speaker.synthesizeAll(slideTexts, (filePaths) => {
    if (myRequestId !== requestId) { if (filePaths) for (const f of filePaths) fs.unlink(f, () => {}); return; }
    if (!filePaths) { playAndReport(null, text, myRequestId, hubRequestId, suggestedNext, false); return; }
    const segments = filePaths.map((filePath, i) => ({ filePath, text: slideTexts[i] }));
    if (hubRequestId !== undefined) {
      link.send({ type: 'answer', requestId: hubRequestId, agentName: AGENT.name, text, suggestedNext });
    }
    const mySeq = ++presentationSeq;
    currentPresentation = { agentName: AGENT.name, url: (page && overlay.showPage(page)) || url, faceStyle: config.faceStyle || '', faceTint: FACE_TINT, slide: 0 };
    setOverlayState({ status: 'speaking', text: segments[0].text, agent: AGENT.name });
    speaker.playSequence(segments.map((s) => s.filePath), (index) => {
      if (index === 0 || mySeq !== presentationSeq || !currentPresentation) return;
      currentPresentation = Object.assign({}, currentPresentation, { slide: index });
      setOverlayState({ status: 'speaking', text: segments[index].text, agent: AGENT.name });
    }, () => {
      // The deck stays up on its last slide until the next input, as on the main display.
      if (mySeq === presentationSeq) setOverlayState({ status: 'idle', text: '', agent: AGENT.name });
      if (hubRequestId !== undefined) {
        link.send({ type: 'speech-done', requestId: hubRequestId, agentName: AGENT.name, text, suggestedNext });
      }
    });
  });
}

function sayWithPresentation(slideTexts, myRequestId, hubRequestId, url, suggestedNext, isMainDisplay) {
  const text = slideTexts.join(' ');
  // The page travels with the request, never the key-carrying link (see readOwnContent in
  // overlay-server.js); only a real website still goes as a URL.
  const page = readOwnContent(url);
  if (!page && !isWebsite(url)) {
    console.error(`[maindisplay] Nothing to show for "${presentationLabel(url)}" -- no such page, too big, or not a website address. Speaking without it.`);
    say(text, myRequestId, hubRequestId, suggestedNext, isMainDisplay);
    return;
  }
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
      // A phone has no recording to send -- its synthesis only parks text for its own TTS engine --
      // so it sends the slide texts, and the display speaks them (see normalizePresentSegments).
      wireSegments = speaker.producesAudioFiles()
        ? segments.map((s) => ({ audioBase64: fs.readFileSync(s.filePath).toString('base64'), text: s.text }))
        : segments.map((s) => ({ text: s.text, speakText: true }));
    } catch (e) {
      console.error('[maindisplay] Audio file unreadable, speaking normally instead:', e.message);
      playAndReport(segments, text, myRequestId, hubRequestId, suggestedNext, isMainDisplay);
      return;
    }
    try {
      // audioBase64 only for the single-slide case -- see the same spot in agent-bridge-server.js
      // (costs nothing there, keeps an older hub working, and would only bloat a multi-slide deck).
      const sent = link.send({
        type: 'present-request', requestId: hubRequestId, agentName: AGENT.name, url: page ? '' : url, page: page || undefined, text, suggestedNext, faceStyle: config.faceStyle || '', faceTint: FACE_TINT, faceRecipe: OWN_FACE_RECIPE,
        segments: wireSegments,
        audioBase64: wireSegments.length === 1 ? wireSegments[0].audioBase64 : undefined
      });
      if (!sent) throw new Error('not connected to the hub');
      pendingOwnPresentation = { hubRequestId, myRequestId, slideTexts, url, suggestedNext };
      for (const s of segments) fs.unlink(s.filePath, () => {});
      // ownDisplayHidden: hide own overlay completely (not just idle) while the reply is running
      // on the FOREIGN main-display screen -- otherwise an idle face would sit here while the
      // actual reply is seen/heard elsewhere.
      setOverlayState({ status: 'idle', text: '', agent: AGENT.name, ownDisplayHidden: true });
    } catch (e) {
      // e.g. MAX_MSG_BYTES exceeded, which a long multi-slide deck can genuinely hit -- the whole
      // reply is still spoken locally rather than vanishing, just without the deck.
      console.error('[maindisplay] Could not send presentation, showing it on this screen instead:', e.message);
      for (const s of segments) fs.unlink(s.filePath, () => {});
      presentOnOwnScreen(slideTexts, myRequestId, hubRequestId, url, suggestedNext);
    }
  });
}

// What this agent says when the CLI exits with an error. "Something went wrong on my end" was all it
// ever said, which is true and useless: the three failures that actually happen have very different
// answers, and the user hears this sentence instead of reading a log. Matched against the CLI's own
// wording, never echoed: its output is not something to read aloud unseen.
function describeCliFailure(errOut, out) {
  const text = `${errOut || ''} ${out || ''}`.toLowerCase();
  if (text.includes('usage limit') || text.includes('rate limit') || text.includes('too many requests')) {
    return 'I have hit the usage limit on my account, so I cannot answer until it resets.';
  }
  if (text.includes('not logged in') || text.includes('/login') || text.includes('authentication')) {
    return 'I am not logged in on this machine any more, so I cannot answer until that is sorted out.';
  }
  if (text.includes('model') && (text.includes('not found') || text.includes('not available') || text.includes('does not exist'))) {
    return 'The model I am set to use is not available to me right now.';
  }
  return 'Something went wrong on my end.';
}

// options.direct: the user spoke to this device itself, the hub being out of reach (handleLocalInput).
function runTask(userText, myRequestId, hubRequestId, isMainDisplay = false, options = {}) {
  // The hub turns such a text away already (askAgent); this covers a hub from before that check.
  if (String(userText).length > MESSAGE_MAX_CHARS) {
    say('That message is too long for me. Please send it as a file instead.', myRequestId, hubRequestId, [], isMainDisplay);
    return;
  }
  interruptCurrent();
  setOverlayState({ status: 'thinking', text: '', agent: AGENT.name });

  refreshSkillData();

  // Only events go into the message: a change to this agent's own name or responsibility, who joined
  // or left since the last turn, and files that just arrived. Standing facts -- who is online, where
  // the inbox is, how markers work -- are in the agent's skills and their data files, read when needed
  // instead of restated here.
  const identityNow = { name: AGENT.name, domain: ownDomain };
  const identityEvent = agentHome.describeIdentityChange(identityAtLastTurn, identityNow);
  identityAtLastTurn = identityNow;
  const rosterNow = knownPeers.map((p) => p.name);
  const rosterEvent = agentHome.describeRosterChange(rosterAtLastTurn, rosterNow);
  rosterAtLastTurn = rosterNow;
  const inboxEvent = inboxLib.buildInboxEvent(inboxLib.listInbox(__dirname), newInboxFiles);
  newInboxFiles.clear();
  // Without it the agent would promise to pass things on to agents it cannot reach.
  const directEvent = options.direct
    ? 'The hub is out of reach right now, so the user is talking to you directly on this device. No other agent can be reached: answer yourself, and do not offer to pass anything on.'
    : '';
  const events = `${identityEvent} ${identityNotice} ${rosterEvent} ${inboxEvent} ${directEvent}`.trim();
  identityNotice = '';

  // The message goes in on stdin (claude-cli.js), so it may be as long as it likes and keeps its line
  // breaks -- a pasted text on the command line once ended this whole process (ENAMETOOLONG).
  const prompt = sessionId
    ? [userText, events].filter(Boolean).join('\n\n')
    : [`You are ${AGENT.name}, part of a network of AI assistants coordinated by Oscar. ${AGENT.personality}`, events, `Message: ${userText}`].filter(Boolean).join('\n\n');
  const args = ['-p'];
  if (sessionId) args.push('--resume', sessionId);
  // Only a pointer to the skills. It still goes through --append-system-prompt rather than the
  // message -- see buildSystemPointer for why -- and it is identical on every turn.
  args.push('--append-system-prompt', buildSystemPointer({ agentName: AGENT.name }));
  args.push('--output-format', 'json');
  // Optional per agent in net-config.json: "effort": "low|medium|high|xhigh|max" -- controls how
  // much thinking effort the CLI invests before answering. Omitted = CLI default, unchanged.
  // Applies per call (like --output-format), not just on the first turn -- so it's appended here
  // centrally, regardless of whether this is a fresh or resumed session.
  if (config.effort) args.push('--effort', config.effort);
  // Optional per agent in net-config.json: "model": "opus" | "sonnet" | a full name like
  // "claude-opus-5-5". Omitted = whatever the CLI on this machine is set to. Per agent rather than
  // per network on purpose: a phone agent minding a game server and a laptop agent writing code do
  // not need the same model, and the phone is the one paying for every token in battery.
  if (config.model) args.push('--model', config.model);
  // What this agent may do comes only from its verified permissions (permissions.js), set and confirmed
  // on this device's face page. The measured facts behind every switch are recorded there.
  // An mcpConfig file name is resolved against THIS folder, not the working directory: it lives next to
  // net-config.json, and once workDir points at a real project the CLI would otherwise look for it there
  // and fail with "config file not found" (reported live 2026-08-25). Inline JSON passes untouched.
  // Controlling Chrome additionally needs the Claude extension approved once by hand on this machine --
  // a trust step of the extension itself that no flag here can skip (verified).
  const turnPermissions = permissionStore.effective();
  const rawMcp = config.mcpConfig ? String(config.mcpConfig).trim() : '';
  const mcpConfig = rawMcp ? (rawMcp.startsWith('{') || path.isAbsolute(rawMcp) ? rawMcp : path.join(__dirname, rawMcp)) : null;
  args.push(...permissionsLib.claudePermissionArgs(turnPermissions, {
    contentDir: path.join(__dirname, 'presented_content'), inboxDir: path.join(__dirname, 'inbox'),
    workspaceDir: WORKSPACE_DIR, projectDir: path.resolve(WORK_DIR) !== path.resolve(HOME) ? WORK_DIR : null,
    extraTools: permissionsLib.extraToolsFrom(config.allowedTools), mcpConfig
  }));

  // Opens the AliveAgents folder as a second root when the agent works elsewhere, so
  // presented_content/ and inbox/ stay reachable. Omitted when they are the same folder -- adding
  // the working directory to itself is noise.
  // This checkout, for writing presentations and handling inbox files. Measured: an --add-dir does
  // not load that directory's CLAUDE.md, so the developer docs here stay out of the agent's context.
  args.push('--add-dir', __dirname);
  // The home, for the skills and their data files. Only needed when the agent works in a project:
  // working in its home, the skills are already that directory's own project skills.
  if (path.resolve(WORK_DIR) !== path.resolve(HOME)) args.push('--add-dir', HOME);

  const child = startClaude(CLAUDE_EXE, args, prompt, { cwd: WORK_DIR });
  currentClaudeChild = child;

  let out = '';
  let errOut = '';
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { errOut += d.toString(); });

  // A turn that never ends leaves this agent silent AND, at the hub, reserved forever: a routed
  // agent stays in busyTargets until its answer arrives (agent-bridge-server.js), so every later
  // question to it is held back as well. One stuck turn therefore looks exactly like a dead agent --
  // which is how this was found on 2026-10-11, with the phone online, connected, and mute.
  // The cap is deliberately generous, because real work (shell, several tool rounds, a high effort
  // level) does take minutes; it only has to be shorter than a person's patience.
  let timedOut = false;
  const watchdog = TASK_TIMEOUT_MS > 0 ? setTimeout(() => {
    timedOut = true;
    if (currentClaudeChild === child) currentClaudeChild = null;
    console.error(`[${AGENT.name}] No reply after ${TASK_TIMEOUT_MINUTES} minutes -- stopping this turn. Last error output: ${errOut.trim().slice(-400) || '(none)'}`);
    try { child.kill(); } catch (e) { /* already gone */ }
    if (myRequestId !== requestId) return;
    // Spoken rather than only logged: this sentence is also what frees the agent again at the hub.
    say(`I got stuck on that one and stopped after ${TASK_TIMEOUT_MINUTES} minutes. Ask me again, and if it keeps happening something on my machine needs a look.`, myRequestId, hubRequestId, [], isMainDisplay);
  }, TASK_TIMEOUT_MS) : null;

  child.on('error', (err) => {
    if (watchdog) clearTimeout(watchdog);
    if (currentClaudeChild === child) currentClaudeChild = null;
    if (myRequestId !== requestId) return;
    console.error('Could not start "claude":', err.message);
    say('I can\'t find the Claude CLI on my machine right now.', myRequestId, hubRequestId, [], isMainDisplay);
  });

  child.on('close', (code) => {
    if (watchdog) clearTimeout(watchdog);
    if (currentClaudeChild === child) currentClaudeChild = null;
    if (timedOut) return; // the watchdog killed it and has already spoken
    if (myRequestId !== requestId) return;
    if (code !== 0) {
      console.error('claude CLI error:', errOut);
      say(describeCliFailure(errOut, out), myRequestId, hubRequestId, [], isMainDisplay);
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
    // The file name of one of this agent's own pages, or a website's address -- see the same spot in
    // agent-bridge-server.js.
    const presentationUrl = rawPresentationUrl ? rawPresentationUrl.trim() : rawPresentationUrl;
    // Before FORWARD, like PRESENTATION: FORWARD's regex is end-anchored.
    const { cleanText: afterIdentity, identityRequest } = extractIdentityTag(afterPresentation);
    // Asking for a new name or responsibility, and involving others, are permissions of their own.
    // Switched off, the marker is still removed from what is spoken, just not acted on.
    if (identityRequest && turnPermissions.identityRequests) requestIdentityChange(identityRequest);
    else if (identityRequest) console.log(`[${AGENT.name}] Not asking for a name or responsibility change -- switched off in this agent's permissions.`);
    const { cleanText, suggested: markedNext } = extractFollowUpTag(afterIdentity);
    const suggested = turnPermissions.forward ? markedNext : [];
    if (markedNext.length && !turnPermissions.forward) console.log(`[${AGENT.name}] Not involving ${markedNext.join(', ')} -- switched off in this agent's permissions.`);
    // Split unconditionally, not only when actually presenting: a [SLIDE] marker that survived
    // into the TTS would be read out loud ("bracket slide"). Rejoining the segments is what the
    // non-presenting paths below speak, so a stray marker simply disappears.
    const slideSegments = splitSlideSegments(cleanText);
    const spokenText = slideSegments.join(' ');
    // Shows HERE (before any hub-side check) whether there was a marker in the raw text at all --
    // without this there is no way to tell from the outside between "no marker attempted" and
    // "marker attempted, but discarded by the hub" (the logged spoken text is ALWAYS already
    // cleaned). Important for debugging marker reliability.
    console.log(`[${AGENT.name}] Marker in raw text: ${markedNext.length ? markedNext.join(', ') : '(none)'}`);
    console.log(`[${AGENT.name}] Presentation marker: ${presentationUrl ? presentationLabel(presentationUrl) : '(none)'}${slideSegments.length > 1 ? `, ${slideSegments.length} slides` : ''}`);
    if (presentationUrl && !turnPermissions.presentations) console.log(`[${AGENT.name}] Not presenting ${presentationLabel(presentationUrl)} -- switched off in this agent's permissions.`);
    const presenting = presentationUrl && turnPermissions.presentations;
    // A main display is only reachable through the hub; without it, the agent's own screen.
    if (presenting && knownMainDisplay && hubUp) {
      sayWithPresentation(slideSegments, myRequestId, hubRequestId, presentationUrl, suggested, isMainDisplay);
      return;
    }
    if (presenting) {
      // No main display is set: show it on this agent's own screen rather than dropping the slides.
      presentOnOwnScreen(slideSegments, myRequestId, hubRequestId, presentationUrl, suggested);
      return;
    }
    say(spokenText, myRequestId, hubRequestId, suggested, isMainDisplay);
  });
}

// The agent asked, with [IDENTITY: ...] in its reply, for its own name or responsibility to change.
// Passed on as it is: the hub checks it and the user decides. The answer comes back as a new "you" in
// a peers message, or as identity-declined.
function requestIdentityChange(request) {
  console.log(`[${AGENT.name}] Asking the hub for a change to this agent's name or responsibility.`);
  let sent = false;
  try {
    sent = link.send({
      type: 'identity-request',
      malformed: !!request._malformed,
      name: typeof request.name === 'string' ? request.name : undefined,
      domain: typeof request.domain === 'string' ? request.domain : undefined,
      reason: typeof request.reason === 'string' ? request.reason : undefined
    }) !== false;
  } catch (e) {
    sent = false;
  }
  if (!sent) identityNotice = agentHome.describeIdentityDecline('unreachable');
}

// The hub telling this agent who it is. Sent only once the hub has a record (see broadcastPeerLists in
// agent-bridge-server.js), so all of it is the user's decision. Cached for the next start -- see
// confirmedIdentity at the top -- and the agent itself hears about a change on its next turn.
function adoptIdentity(you) {
  const name = cleanName(you && you.name);
  const domain = cleanDomain(you && you.domain);
  if (!name || domain === null) return;
  const cached = agentHome.readIdentity(HOME);
  if (!cached || cached.name !== name || cached.domain !== domain) {
    try { agentHome.writeIdentity(HOME, { name, domain }); } catch (e) { console.error(`[${AGENT.name}] could not cache the identity from the hub:`, e.message); }
  }
  if (name === AGENT.name && domain === ownDomain) return;
  console.log(`[${AGENT.name}] ${agentHome.closeSentence(`The hub says this agent is ${name}, responsible for: ${domain || 'nothing in particular'}`)}`);
  AGENT.name = name;
  ownDomain = domain;
  const prev = overlay.getState();
  setOverlayState({ status: prev.status, text: prev.text, agent: AGENT.name });
}

// Whether the hub is reachable, from the link's own open and close events. Going offline is acted on only
// after OFFLINE_AFTER_MS without a connection -- the link retries every few seconds and reports every
// failed attempt, so the count starts at the first one and is not restarted. Coming back counts at once.
function hubReachable(up) {
  if (up) {
    hubUp = true;
    clearTimeout(offlineTimer);
    offlineTimer = null;
    setLocalInput(false);
    return;
  }
  hubUp = false;
  if (localInput || offlineTimer) return;
  offlineTimer = setTimeout(() => {
    offlineTimer = null;
    if (!hubUp) setLocalInput(true);
  }, OFFLINE_AFTER_MS);
}

function setLocalInput(on) {
  if (localInput === on) return;
  localInput = on;
  if (on) {
    // Nobody is reachable now, and the skills' data files say so instead of listing the agents and the
    // main display from before. The hub's next peers message puts them back.
    knownPeers = [];
    // A main display is only reachable through the hub: it counts as offline, and presentations go to
    // this device's own screen (display.md says so, and runTask sends none to the hub).
    knownMainDisplayOffline = knownMainDisplay || knownMainDisplayOffline;
    knownMainDisplay = null;
    refreshSkillData();
  }
  console.log(on
    ? `[${AGENT.name}] The hub is out of reach -- this device's own microphone is on (face page).`
    : `[${AGENT.name}] The hub is reachable again -- input goes through it, this device's microphone is off.`);
  // Re-sent unchanged, so the face page learns about the microphone at once (micEnabled, overlay-server.js).
  const prev = overlay.getState();
  setOverlayState({ status: prev.status, text: prev.text, agent: prev.agent || AGENT.name });
}

// Speech from this device's own face page -- only ever while the hub is out of reach (overlay-server.js
// asks inputEnabled first, and this checks again). From here on it is a task like one from the hub, minus
// the hub: nothing is reported, nothing handed on, and the agent is told so (runTask, options.direct).
function handleLocalInput(text, source) {
  if (!localInput) return;
  const myRequestId = ++requestId;
  console.log(`[${AGENT.name}] Heard directly on this device (${source}): ${text}`);
  // A new request takes the previous deck off the screen, as a new input at the hub does.
  currentPresentation = null;
  runTask(text, myRequestId, undefined, false, { direct: true });
}

// Counting starts now: a device that never finds its hub -- a phone taken along -- offers its own
// microphone after OFFLINE_AFTER_MS.
hubReachable(false);

const link = connectToHub({
  selfName: config.self,
  hubName: config.hubName,
  host: config.hubHost,
  port: config.hubPort,
  // "mainDisplay":true in net-config.json (optional) advertises this node to the hub as the
  // default main display -- only the starting value, see /maindisplay in agent-bridge-server.js
  // for the actual, low-effort way to reassign the role while running.
  // agentName and domain are only this machine's introduction: the hub decides who it is (admitNode in
  // agent-bridge-server.js) and says so in its peers message, as "you".
  onOpen: () => {
    hubReachable(true);
    link.send({ type: 'hello', agentName: AGENT.name, domain: ownDomain, mainDisplay: !!config.mainDisplay, screen: myScreen });
  },
  // Also after every failed attempt while the hub is away -- hubReachable counts from the first one.
  onClose: () => hubReachable(false),
  onMessage: (msg) => {
    if (msg.type === 'task' && typeof msg.text === 'string') {
      const myRequestId = ++requestId; // own, local counter -- independent of the hub
      console.log(`[${AGENT.name}] Task: ${msg.text}`);
      runTask(msg.text, myRequestId, msg.requestId, !!msg.isMainDisplay);
    }
    if (msg.type === 'reset') {
      sessionId = null;
      try { fs.unlinkSync(SESSION_FILE); } catch (e) {}
      rosterAtLastTurn = null;
      identityAtLastTurn = { name: AGENT.name, domain: ownDomain }; // a new session starts with the current name anyway
      identityNotice = '';
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
    if (msg.type === 'file-begin') {
      // Receiving files is one of this agent's permissions. Refused, the chunks that follow find no
      // open transfer and are dropped by the receiver; the hub is told so the user hears why.
      if (permissionStore.effective().files) {
        inboxReceiver.begin(msg);
      } else {
        console.log(`[inbox] refused "${inboxLib.safeName(msg.name)}" -- receiving files is switched off in this agent's permissions.`);
        try { link.send({ type: 'file-refused' }); } catch (e) { /* not connected -- nothing to tell */ }
      }
    }
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
        currentPresentation = Object.assign({}, currentPresentation, { agentName: msg.agentName, faceStyle: faceStyleFor(msg.agentName, msg.faceStyle, msg.faceRecipe), faceTint: normalizeTint(msg.faceTint) });
      }
      pending.resume();
    }
    // The hub had nowhere to show this agent's presentation -- the main display is offline, or
    // sending to it failed -- and handed it back: show it here instead (user's decision, 2026-09-15).
    // Only for the presentation that is still current; a newer task has already moved on.
    if (msg.type === 'present-declined' && pendingOwnPresentation && msg.requestId === pendingOwnPresentation.hubRequestId) {
      const p = pendingOwnPresentation;
      pendingOwnPresentation = null;
      if (p.myRequestId === requestId) {
        console.log('[maindisplay] The hub could not show the presentation -- showing it on this screen instead.');
        presentOnOwnScreen(p.slideTexts, p.myRequestId, p.hubRequestId, p.url, p.suggestedNext);
      }
    }
    // The hub, or the user, turned down this agent's request to change its name or responsibility. Only
    // a code travels; the sentence the agent reads comes from a fixed table in agent-home.js.
    if (msg.type === 'identity-declined') {
      identityNotice = agentHome.describeIdentityDecline(msg.reason);
      console.log(`[${AGENT.name}] The request to change this agent's name or responsibility was not accepted.`);
    }
    if (msg.type === 'peers' && Array.isArray(msg.list)) {
      if (msg.you) adoptIdentity(msg.you);
      knownPeers = msg.list;
      knownMainDisplay = typeof msg.mainDisplay === 'string' ? msg.mainDisplay : null;
      knownMainDisplayScreen = normalizeScreen(msg.mainDisplayScreen);
      knownMainDisplayOffline = typeof msg.mainDisplayOffline === 'string' ? msg.mainDisplayOffline : null;
      refreshSkillData();
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
      if (!wireSegments) return; // nothing usable -- neither playable audio nor text to speak
      // A link to another machine's page without the page itself could only be shown by fetching it
      // across the WiFi, which nothing does any more (see readOwnContent in overlay-server.js). The hub
      // hands such a link back to its presenter; this only guards against an older hub.
      const page = normalizePage(msg.page);
      if (!page && !isWebsite(msg.url)) {
        console.log(`[${AGENT.name}] Ignored a presentation link that came without its page.`);
        link.send({ type: 'presentation-done', requestId: msg.requestId, agentName: msg.agentName, text: msg.text || '' });
        return;
      }
      const myPresentationSeq = ++presentationSeq;
      stopPlaybackOnly();
      console.log(`[${AGENT.name}] showing presentation from "${msg.agentName}"${wireSegments.length > 1 ? ` (${wireSegments.length} slides)` : ''}: ${page ? page.name : msg.url}`);
      // Async, because slides can arrive as text (from a phone) or as audio this machine cannot
      // play, and both have to be synthesized here first. Everything below runs once every slide
      // is playable.
      prepareSegmentFiles(wireSegments, (segments) => {
        if (!segments) {
          // Report back anyway -- otherwise the presenter's follow-up chain would wait forever.
          link.send({ type: 'presentation-done', requestId: msg.requestId, agentName: msg.agentName, text: msg.text || '' });
          return;
        }
        if (myPresentationSeq !== presentationSeq) {
          // A newer presentation arrived while these slides were being prepared.
          for (const s of segments) fs.unlink(s.filePath, () => {});
          return;
        }
        currentPresentation = { agentName: msg.agentName, url: (page && overlay.showPage(page)) || msg.url, faceStyle: faceStyleFor(msg.agentName, msg.faceStyle, msg.faceRecipe), faceTint: normalizeTint(msg.faceTint), slide: 0 };
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
