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

// Explanation of the marker convention for the persona. Appended on EVERY call (not just the
// first turn of a session) -- unlike personality/domain, which only need to be stated once, this
// behavior has to be followed reliably on every single reply, otherwise either forwarding breaks
// (marker missing where one would be needed) or speaking breaks (marker accidentally spoken
// aloud). Deliberately ONE sentence with no line break -- see the rule elsewhere in this project:
// an embedded \n in a single CLI argument gets truncated on Windows.
// contentUrlPrefix: this agent's own reachable base URL (e.g. "http://192.168.178.90:8787"), for
// the case where it generates its own page under presented_content/ -- never pass "localhost",
// that would be unreachable from the main-display machine (an ENTIRELY DIFFERENT physical device)
// (see getLanIp() in overlay-server.js).
//
// Deliberately NO per-turn pattern match (isPresentationRequest/PRESENTATION_REQUEST_RE) anymore
// that additionally mixes in an "especially important right now" signal (existed until
// 2026-08-18) -- a user decision, after two live-found false triggers of the same underlying
// problem: no regex can grammatically distinguish "show me that" (a request AT the agent) from,
// say, "let me show you now what matters" (the USER describing what THEY are about to do) --
// only genuine language understanding can do that. The capability itself is instead described as
// a permanently available interface (see hasMainDisplay below), included JUST AS consistently on
// every single turn as the FORWARD explanation -- so the risk that originally led to introducing
// the regex (a behavioral instruction stated only ONCE gets lost on the model) does not apply to
// this wording, since it is never said only once anyway. Whether and when it gets used is now
// entirely up to the agent itself, with no special-casing for individual turns.
function buildTagHint(hasMainDisplay = false, contentUrlPrefix = null) {
  let hint = 'Answer briefly as usual. If someone else on the network should additionally react to or follow up on your answer, append, right at the END (not as a spoken sentence of its own), exactly once: [FORWARD: Name] -- comma-separated for multiple names, ONLY real names from the network. If the user says something like "to everyone" or "to the whole network," list out ALL the names you know on the network individually there, not just the word "everyone." If there is nothing to add or no one fits, leave it off entirely -- that is the normal case.';
  if (hasMainDisplay) {
    hint += ' You also have a standing interface available to show the user something visually instead of just reading it aloud -- an analysis, a dashboard, search results, a presentation as a web page, or whatever else fits. To do this, append at the very END of your answer (after any FORWARD marker) exactly: [PRESENTATION: <URL>] -- that shows the page on the main display while you talk about it. Whether and when it is worth it is entirely your own call, every single turn, on your own initiative, not only when asked -- no one will tell you when it fits. Once you use it, the usual terseness (1-3 sentences) does NOT apply -- feel free to present the results at proper length then, that is not a problem, since the content is running visually alongside anyway.';
    if (contentUrlPrefix) {
      hint += ` If you do not have a ready page for it yet, generate a small, self-contained HTML page with the content yourself at presented_content/<filename>.html (your write access covers exactly that, nowhere else) and reference it in the marker as ${contentUrlPrefix}/content/<filename>.html. If you already created a suitable page on the same topic earlier in this conversation, do NOT create a new file -- just reference the same URL again instead.`;
    }
  }
  return hint;
}

// peers: Array of { name, domain }. Only meant for the FIRST turn of a session (the persona
// line), so an agent even knows WHO else is on the network and what they do.
function buildPeersLine(peers) {
  if (!peers || peers.length === 0) return '';
  const parts = peers.map((p) => (p.domain ? `${p.name} (${p.domain})` : p.name));
  return `Also on the network: ${parts.join(', ')}.`;
}

module.exports = { extractFollowUpTag, buildTagHint, buildPeersLine, extractPresentationTag };
