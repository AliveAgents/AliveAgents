// identity.js
// Gives every agent a look and a voice of its own.
//
// The problem this solves showed up the moment a third agent joined: buildNodeConfig handed out
// the same defaults to everybody, so Toby arrived on the network wearing Nova's face and speaking
// in Nova's voice. Nothing was broken -- they were simply never told apart.
//
// Two rules shape what follows.
//
// 1. An identity is DATA, never code. A face definition in faces/*.js runs inside the overlay
//    script's privileged context, with WebSocket and microphone access, which is exactly why that
//    folder is closed to agents (see the header of faces/ava.js). So an agent does not get to
//    write a face; it gets to pick a shell and a set of colours, and those colours are validated
//    as plain hex before they reach a stylesheet.
//
// 2. Nobody has to choose. Enrollment already asks enough questions. Everything here can be
//    derived from the agent's own name -- deterministically, so the same name always produces the
//    same agent, and spread out, so two agents on one network do not collide by accident. A
//    deliberate choice always wins over the derivation.

// The two shells that exist as real face definitions in faces/. Adding a third file here is all
// it takes for derived identities to start using it.
const FACE_STYLES = ['ava', 'kai'];

// Voices that ship with the project, split by the one property a listener notices immediately.
// Only consulted for agents that speak through Piper -- an Android node ignores it entirely and
// uses the phone's own engine (see speech.js).
const PIPER_VOICES = {
  male: ['en_US-ryan-high.onnx'],
  female: ['en_US-ljspeech-high.onnx']
};

// FNV-1a. Any stable hash would do; this one is four lines and has no dependencies. What matters
// is only that it is deterministic across machines and Node versions -- an agent's appearance must
// not change because the hub restarted.
function hashName(name) {
  let h = 0x811c9dc5;
  const s = String(name || '').toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function hsl(h, s, l) {
  // Plain HSL -> hex. Written out rather than pulled in, so identity.js stays dependency-free and
  // can be required by the hub, by a node, and by a test with equal ease.
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const hex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

// A palette, not three unrelated colours. The three states have to stay readable at a glance from
// across a room, so they are built from one hue with fixed roles rather than picked freely:
//   idle      barely saturated and dim -- present, but not asking for attention
//   thinking  always warm, wherever the agent's hue sits, because "working on it" reads as warm
//   speaking  the agent's own hue at full strength -- this is the colour you learn to recognise
// The thinking hue is nudged by the agent's own hue so two agents mid-thought still differ, but
// never far enough to stop looking like amber.
// The second argument is a tone, and it exists because hue alone runs out. Measured: with the
// reserved bands removed the ring holds sixteen usable hues in two arcs, and greedy placement of
// eight agents came down to a 15-degree minimum -- two agents that close are the same colour to
// anyone not holding a colour picker. Alternating a bright and a deep tone doubles the palette
// without touching hue, so even neighbours on the ring read as different agents.
//
// "thinking" deliberately does NOT take the tone. It is the one colour that means the same thing
// on every face, and it stays comparable across the network precisely by not being personalised.
function tintForHue(hue, shade) {
  const deep = shade === 1;
  return {
    idle: hsl(hue, 0.16, deep ? 0.50 : 0.62),
    thinking: hsl((28 + (hue % 24)) % 360, 0.88, 0.56),
    speaking: hsl(hue, deep ? 0.92 : 0.78, deep ? 0.44 : 0.60)
  };
}

// Hues sit on a coarse ring -- 15-degree steps, because a 5-degree difference is not an identity.
// Three stretches of that ring are cut out, each for a concrete reason:
//
//   amber      "thinking" is amber for EVERY agent, so an agent whose own colour were amber could
//              not be told apart from any agent mid-thought. Spotted in the very first generated
//              palette, where one speaking colour came out #ec943c against a thinking #f29c2c.
//   ava cyan   an agent with no tint of its own keeps the colours built into its face definition,
//   kai red    and those two are still in use -- Oscar wears kai's red deliberately. Assigning a
//              derived identity next to them would produce exactly the confusion this file exists
//              to prevent, just between a tinted agent and an untinted one.
//
// Seventeen buckets survive, which is far more than a home network will ever need.
const RESERVED_BANDS = [
  [15, 60],   // thinking amber, shared by all agents
  [180, 195], // faces/ava.js speaking colour (#2fd8f6)
  [345, 360], // faces/kai.js speaking colour (#ff2b3d) -- Oscar
  [0, 0]      // ... and its wrap-around neighbour
];

function inReservedBand(h) {
  return RESERVED_BANDS.some(([lo, hi]) => h >= lo && h <= hi);
}

const HUE_RING = (() => {
  const out = [];
  for (let h = 0; h < 360; h += 15) if (!inReservedBand(h)) out.push(h);
  return out;
})();

function hueForName(name) {
  return HUE_RING[hashName(name + ':hue') % HUE_RING.length];
}

// Pitch and rate for an Android node. Quantised to a small set of steps for the same reason the
// hues are: a pitch difference of 0.02 is not an identity, it is noise. The range stays inside
// what Android's engine renders without sounding processed -- a pitch of 0.5 does not give you a
// bass voice, it gives you a broken one.
//
// Worth being plain about what this can and cannot do: a phone has ONE engine, and pitch shifts
// that single voice rather than swapping it. A low pitch reads as a deeper version of the same
// speaker, not as a different person. Android's real lever for that is the voice variant, which
// termux-tts-speak exposes as -v and speech.js passes straight through -- set "variant" in an
// agent's androidTts block once you know which variants the phone's engine actually offers
// (termux-tts-engines lists the engines; the variants come from the engine's own voice data).
// Nothing is derived for it here, because guessing a variant name that does not exist would
// silently fall back to the default and look like the setting had no effect.
function androidVoiceForName(name) {
  const pitches = [0.75, 0.85, 0.95, 1.05, 1.15, 1.25];
  const rates = [0.95, 1.0, 1.05];
  return {
    language: 'en',
    stream: 'MUSIC',
    pitch: pitches[hashName(name + ':pitch') % pitches.length],
    rate: rates[hashName(name + ':rate') % rates.length]
  };
}

// Only ever used when nothing was chosen deliberately.
function deriveIdentity(name) {
  const hue = hueForName(name);
  const wantsMale = (hashName(name + ':voice') & 1) === 0;
  const pool = wantsMale ? PIPER_VOICES.male : PIPER_VOICES.female;
  return {
    faceStyle: FACE_STYLES[hashName(name + ':face') % FACE_STYLES.length],
    faceTint: tintForHue(hue),
    piperVoice: pool[hashName(name + ':piper') % pool.length],
    androidTts: androidVoiceForName(name)
  };
}

// The security boundary, and the only reason this function exists.
//
// A tint ends up inside a <style> element in the overlay's own privileged document. Accepting a
// free-form string there would mean accepting arbitrary CSS from whatever wrote the config --
// which is a long way from "let an agent pick its colour". So exactly three keys are read, each
// must be a plain #rrggbb literal, and anything else is dropped rather than corrected. Returning
// null (instead of a repaired object) makes the caller fall back to the face's own colours, which
// is always a safe, complete look.
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function normalizeTint(tint) {
  if (!tint || typeof tint !== 'object') return null;
  const out = {};
  for (const key of ['idle', 'thinking', 'speaking']) {
    const v = tint[key];
    if (typeof v !== 'string' || !HEX_RE.test(v.trim())) return null;
    out[key] = v.trim().toLowerCase();
  }
  return out;
}


// Assigning identities one name at a time produces collisions, and not rarely: 24 hues and
// eight agents already gave two of them the same colour and the same shell in testing. That is
// the birthday problem, not a weak hash -- no per-name function fixes it, because a function that
// cannot see the other agents cannot avoid them.
//
// So identities are assigned to the WHOLE set at once. Names are sorted first, which makes the
// result depend only on who is on the network and not on the order they happened to join, and
// each name then takes its name-derived hue unless someone nearer than MIN_HUE_GAP already holds
// it -- in which case it walks the colour ring until it finds room. Adding an agent can therefore
// shift an existing one's colour, which is the deliberate trade: a network where everyone is
// clearly distinguishable is worth more than one where nobody's colour ever moves.
// Kept as the readable statement of intent -- what counts as "clearly a different agent". The
// assignment maximises separation rather than merely clearing this, so it is exceeded whenever
// the ring has room and undercut, evenly, only once a network grows past what the ring can hold.
const MIN_HUE_GAP = 40; // eslint-disable-line no-unused-vars

function hueDistance(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function assignIdentities(names) {
  const sorted = Array.from(new Set((names || []).map((n) => String(n || '').toLowerCase()).filter(Boolean))).sort();
  const out = {};
  const used = []; // { hue, shade } of everyone placed so far
  sorted.forEach((name, index) => {
    const start = hueForName(name);
    // Take the roomiest hue on the ring, not the first one that merely clears MIN_HUE_GAP.
    // Accepting the first good-enough spot packs agents against each other and then strands the
    // later ones: three agents came out at 345, 30 and 105 degrees that way, when the ring had
    // room to place them a third of the circle apart. Ties go to the hue closest to the name's own
    // preference, so the choice still feels derived from the name rather than arbitrary.
    let best = start;
    let bestGap = -1;
    let bestRotation = Infinity;
    for (const hue of HUE_RING) {
      const gap = used.length ? Math.min(...used.map((u) => hueDistance(hue, u.hue))) : 360;
      const rotation = hueDistance(hue, start);
      if (gap > bestGap || (gap === bestGap && rotation < bestRotation)) {
        best = hue; bestGap = gap; bestRotation = rotation;
      }
    }

    const base = deriveIdentity(name);

    // Voices are spread by POSITION as well as by name, for the same reason the hues are. Left to
    // the hash alone, five agents came out four-to-one female and the lowest-pitched slot went
    // unused -- a coin flip per name is not a distribution when there are only five names. Parity
    // on the sorted index makes the male/female split exact, and the pitch offset walks the range
    // instead of clustering.
    const wantsMale = index % 2 === 0;
    const pool = wantsMale ? PIPER_VOICES.male : PIPER_VOICES.female;
    // Pitch is grouped to match: a voice meant to read as male starts from the lower half of the
    // range rather than being handed 1.25 by chance, which is what happened to Toby.
    //
    // The offset counts within the gender rather than across all agents. Male agents sit on even
    // indices, so stepping by the raw index moved two of them by two slots of a three-slot list
    // and handed the first and third the same pitch -- three agents, two voices. Halving the
    // index makes consecutive agents of the same gender walk the list one step at a time.
    const voiceIndex = Math.floor(index / 2);
    const pitches = wantsMale ? [0.75, 0.85, 0.95] : [1.0, 1.1, 1.2];
    const rates = [0.95, 1.0, 1.05];
    // Tone alternates by position while the ring still has room. Once it does not -- once the
    // closest neighbour is within 30 degrees -- the tone is instead set to the OPPOSITE of that
    // neighbour's, which is the whole reason the tone exists. Without this step twelve agents
    // produced a pair that was both nearly the same hue and the same tone, i.e. the one outcome
    // the second dimension was added to prevent.
    const nearest = used.length
      ? used.reduce((a, b) => (hueDistance(best, a.hue) <= hueDistance(best, b.hue) ? a : b))
      : null;
    const shade = (nearest && hueDistance(best, nearest.hue) < 30) ? (nearest.shade ^ 1) : (index % 2);
    used.push({ hue: best, shade });
    out[name] = Object.assign({}, base, {
      faceHue: best,
      faceShade: shade,
      faceTint: tintForHue(best, shade),
      piperVoice: pool[hashName(name + ':piper') % pool.length],
      androidTts: Object.assign({}, base.androidTts, {
        // Pitch and rate are taken as a PAIR from a counter, with no hash involved. Mixing the
        // name's hash in felt more like the agent's own voice, but it collides: two names one
        // apart in the hash land on the same slot, and eight agents came out sharing a voice.
        // Counting through the nine combinations instead cannot repeat until all nine are used,
        // which is eighteen agents across both voices -- far past anything this will see. Name
        // derivation is not lost, it simply lives in the colour, where a collision is harmless.
        pitch: pitches[(voiceIndex % 9) % pitches.length],
        rate: rates[Math.floor((voiceIndex % 9) / pitches.length) % rates.length]
      })
    });
  });
  return out;
}

// What the hub calls when provisioning: "give <name> an identity that does not clash with these".
function pickIdentity(name, otherNames) {
  const key = String(name || '').toLowerCase();
  return assignIdentities([...(otherNames || []), key])[key];
}

module.exports = { deriveIdentity, assignIdentities, pickIdentity, normalizeTint, tintForHue, hueForName, FACE_STYLES, PIPER_VOICES };
