// followup-tag.js
// Shared module for BOTH hub and node: every agent may append a quiet marker to the end of its
// reply to suggest who on the network should react next, e.g.
// "... I'll take care of that. [FORWARD: Nova, Thomas]". The marker is cut out HERE, BEFORE
// the text is spoken or logged -- it is pure machine-to-machine metadata that never reaches the
// user. If the marker is missing entirely, that is a deliberate signal ("nothing more to add
// from me") -- this is how agents stop on their own, without Oscar having to guess or classify.
//
// Oscar still remains the "final authority": he checks every suggested name against the
// currently known, currently reachable agents (see filterSuggested in agent-bridge-server.js)
// -- a made-up or no-longer-connected name is silently discarded.

// Allows optional punctuation after the closing bracket (models like to add a period), but the
// marker MUST sit at the very end of the reply -- this keeps parsing robust without having to
// search the whole text for a hidden marker.
const TAG_RE = /\s*\[FORWARD:\s*([^\]]*)\]\s*[.!]?\s*$/i;

function extractFollowUpTag(text) {
  const source = String(text || '');
  const match = TAG_RE.exec(source);
  if (!match) return { cleanText: source, suggested: [] };
  const cleanText = source.slice(0, match.index).trim();
  const suggested = match[1].split(',').map((s) => s.trim()).filter(Boolean);
  return { cleanText, suggested };
}

// Same idea as FORWARD, for the main-display feature: instead of (or in addition to) a forward,
// an agent appends a URL that should be shown on the currently assigned main display while it
// talks about it. Must sit at the very END -- callers extract this marker FIRST (it is the
// outermost one), only then FORWARD on the rest, so an agent can combine both
// ("... [FORWARD: Name] [PRESENTATION: url]").
// Non-end-anchored on purpose (no "$"): a model occasionally appends a friendly closing sentence
// AFTER the marker even though the prompt says "at the very END" -- unlikely for FORWARD (a short
// name list), but actually observed live for a full presentation with real content.
// exec() without "g" returns the FIRST occurrence; everything before AND after it is kept as
// cleanText.
const PRESENTATION_TAG_RE = /\s*\[PRESENTATION:\s*([^\]]*)\]\s*[.!]?/i;

function extractPresentationTag(text) {
  const source = String(text || '');
  const match = PRESENTATION_TAG_RE.exec(source);
  if (!match) return { cleanText: source, presentationUrl: null };
  const before = source.slice(0, match.index);
  const after = source.slice(match.index + match[0].length);
  const cleanText = (before + ' ' + after).replace(/\s+/g, ' ').trim();
  const url = match[1].trim();
  return { cleanText, presentationUrl: url || null };
}

// Multi-slide presentations: inside the SPOKEN text an agent may mark where one slide ends and
// the next begins, e.g. "Here is the overview. [SLIDE] Revenue grew by 20%." Segment i is spoken
// while slide i is on screen, and the machine playing the audio advances the deck between
// segments (see playPresentationLocally in agent-bridge-server.js / the 'present' handler in
// node-agent.js).
//
// Deliberately a marker inside the text rather than a second URL-style tag: the split has to line
// up with the SPEECH, and the only place that alignment can be expressed is the spoken text
// itself. Piper synthesizes each segment separately, so the gap between two slides is a real
// pause in the audio, not a cut inside one WAV.
//
// Global + non-anchored on purpose (unlike FORWARD/PRESENTATION, which are single end markers):
// this one legitimately occurs several times, anywhere in the middle of the reply.
//
// The surrounding [`*_] run is not decoration: observed on the very first live test (2026-08-25)
// that the model wrote the marker as `[SLIDE]` -- wrapped in markdown code backticks -- because
// the skill's own example happened to show it that way. The skill was fixed, but the tolerance
// stays: markers sit in prose a model formats freely, and a leftover backtick would be handed
// straight to Piper as if it were a word. Same reasoning as PRESENTATION_TAG_RE not being
// end-anchored -- match what models actually emit, not only the documented ideal.
const SLIDE_TAG_RE = /\s*[`*_]*\s*\[SLIDE\]\s*[`*_]*\s*/gi;

// Always applied to the spoken text, even when there is no presentation at all -- a stray [SLIDE]
// that reached the TTS would otherwise be read out loud as "bracket slide". Callers that cannot
// present anything just re-join the segments with a space.
// Always returns at least one segment (the unchanged text) so callers never special-case an empty
// array; a marker at the very start or end, or two in a row, collapses instead of producing empty
// slides.
function splitSlideSegments(text) {
  const source = String(text || '');
  const parts = source.split(SLIDE_TAG_RE).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [source.trim()];
}

// Provisioning a new agent. Same idea as the other markers -- the model names an intent, the hub
// performs it -- and that split is the whole point here: Oscar deliberately runs with
// --disallowedTools PowerShell and write access to presented_content/ only (a gap closed on
// purpose, see CLAUDE.md), so it can neither generate certificates nor edit net-config.json. A
// narrow marker keeps those permissions shut while still letting Oscar drive the setup.
//
// The payload is JSON, e.g. [PROVISION: {"self":"ada","agentName":"Ada","domain":"..."}].
// Arrays must not appear in it: the regex stops at the first "]", so a nested array would truncate
// the payload. Every field this accepts is a string or a boolean anyway.
//
// Taught only in the "new-agent" skill, which the hub alone has and loads when the user actually
// asks for a new agent. A once-in-a-while operation has no business in text that travels with
// every turn.
const PROVISION_TAG_RE = /\s*\[PROVISION:\s*(\{[^\]]*\})\s*\]\s*[.!]?/i;

// A trusted agent asking for its own name or responsibility to change, e.g.
// [IDENTITY: {"domain":"...","reason":"..."}]. Only ever a request: the node hands it to the hub, the
// hub shows it to the user, and nothing changes unless the user accepts it on the hub's own page or
// console (see receiveIdentityRequest in agent-bridge-server.js). Same JSON rules as PROVISION, and
// the same tolerance for markdown around it as SLIDE -- whatever is left next to a marker is spoken.
// Taught in the network skill.
const IDENTITY_TAG_RE = /\s*[`*_]*\s*\[IDENTITY:\s*(\{[^\]]*\})\s*\][`*_]*\s*[.!]?/i;

// Cuts one JSON marker out of a reply. Malformed JSON is reported as { _malformed } rather than
// silently dropped: for PROVISION the caller tells the user out loud instead of leaving them waiting
// for a code that never comes, for IDENTITY the agent hears that its request did not go through.
function extractJsonMarker(text, re) {
  const source = String(text || '');
  const match = re.exec(source);
  if (!match) return { cleanText: source, payload: null };
  const before = source.slice(0, match.index);
  const after = source.slice(match.index + match[0].length);
  const cleanText = (before + ' ' + after).replace(/\s+/g, ' ').trim();
  let payload;
  try {
    const parsed = JSON.parse(match[1]);
    payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { _malformed: match[1] };
  } catch (e) {
    payload = { _malformed: match[1] };
  }
  return { cleanText, payload };
}

function extractProvisionTag(text) {
  const { cleanText, payload } = extractJsonMarker(text, PROVISION_TAG_RE);
  return { cleanText, provision: payload };
}

function extractIdentityTag(text) {
  const { cleanText, payload } = extractJsonMarker(text, IDENTITY_TAG_RE);
  return { cleanText, identityRequest: payload };
}

// The whole standing text an agent carries on every turn -- and deliberately almost nothing.
//
// Until 2026-09-14 this slot held the complete marker rules plus the list of online agents, about
// 767 tokens paid on every turn whether or not the turn involved anyone else. The rules now live in
// skills (agent-skills/), which Claude Code loads only when the agent decides it needs one, and what
// changes -- who is online, whether a display is connected -- lives in files those skills point to.
// agent-skills/README.md has the reasoning and the history, including why the rules originally
// moved out of the message (an imperative there was once flagged as a possible prompt injection).
//
// What stays is only what an agent cannot find out on its own: that there IS a network, and which
// skills describe it. The last sentence carries the one lesson that cost real bugs -- a roster read
// earlier in a conversation is a stale roster. The text is identical on every turn, so unlike the
// roster it replaces, it never invalidates the prompt cache.
//
// One line, no embedded newline: Windows splits command-line arguments at real line breaks, which
// once truncated a prompt and broke the JSON output.
function buildSystemPointer({ agentName, personality = '', canProvision = false }) {
  const skills = [
    '`network` (who is online right now, what each agent is responsible for, and how to pass something on to one of them or to everyone)',
    '`presentation` (showing something on a screen while you talk)',
    '`inbox` (files people give you)',
    '`workspace` (your own folder for files you create)',
    '`sources` (saying where something you looked up comes from)'
  ];
  if (canProvision) skills.push('`new-agent` (setting up a new agent on another machine)');
  // The clause about addresses is here and not only in the skill: the web search tool's own instructions
  // ask for a list of links at the end of every answer that used it, and the voice read them out.
  // The personality from net-config.json belongs HERE rather than in the first message of a
  // conversation. A resumed turn sends no first message, so anything stated only there is stated
  // once and then never again -- and nothing afterwards says how this agent is meant to answer.
  // Measured 2026-11-08 on a phone agent that had been replying in German for weeks although it was
  // written to in English: no turn told it which language to use, so the drift of its own earlier
  // replies decided. Whitespace is collapsed because this string is one command-line argument and
  // Windows splits those at real line breaks (which once truncated a prompt and broke the output).
  const style = String(personality || '').replace(/\s+/g, ' ').trim();
  return `You are ${agentName}, one of several AI agents on a small local network, each on its own machine with its own voice.${style ? ' ' + style : ''} Your replies are spoken aloud, so keep them to a few natural sentences unless you are presenting, and never put a web address, link or file path in them -- name the source instead. Everything that involves the rest of the network is described in your skills: ${skills.join(', ')}. Who is online changes while you run, so load \`network\` again whenever you are about to involve someone else, rather than relying on what you saw earlier.`;
}

module.exports = { extractFollowUpTag, buildSystemPointer, extractPresentationTag, splitSlideSegments, extractProvisionTag, extractIdentityTag };
