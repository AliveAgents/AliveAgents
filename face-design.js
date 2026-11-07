// face-design.js
// A face of its own for every new agent -- drawn here, from a recipe, never from code an agent wrote.
//
// Why a recipe and not a face file: everything in faces/ runs as real code inside the overlay's
// privileged document, the one with the WebSocket and the microphone (see overlay-server.js). Letting an
// agent write that would hand it the page it is drawn on. So an agent -- or the hub setting one up --
// chooses from the parts below, nothing else: a shell, eyes, a pattern, a crest, a mouth, and how the
// three states move. Everything it says is matched against these lists; anything unknown is replaced by
// a drawn-at-random choice, so a recipe can never carry text into the page.
//
// The parts combine to tens of thousands of looks, and whatever the recipe leaves open is drawn from a
// seed the caller passes -- the hub makes a fresh one per pairing (see buildNodeConfig), so a new machine
// turns up with a face nobody else has without anyone having to think about it, and the same machine set
// up twice does not turn up twice with the same one. The drawn recipe then lives in that agent's config,
// so its face stays the same from then on.
//
// Colours stay where they were: the agent's three state colours come from identity.js and are applied by
// the overlay as currentColor, so a generated face follows the same palette rules as a hand-written one.

const crypto = require('crypto');

const SHELLS = ['block', 'round', 'hex', 'tower'];
const EYES = ['pixel', 'visor', 'rings', 'matrix'];
const PATTERNS = ['grid', 'scanlines', 'dots', 'plain'];
const CRESTS = ['none', 'antenna', 'ears', 'bar'];
const MOUTHS = ['smile', 'flat', 'stern'];
const IDLE = ['bob', 'breathe', 'flicker'];
const THINKING = ['scan', 'pulse', 'orbit'];
const SPEAKING = ['glow', 'throb', 'ripple'];
const PARTS = { shell: SHELLS, eyes: EYES, pattern: PATTERNS, crest: CRESTS, mouth: MOUTHS, idle: IDLE, thinking: THINKING, speaking: SPEAKING };

// Everything is drawn into the overlay's 260x282 box, the same one the hand-written faces use.
const BOX = { w: 260, h: 282 };

function seededNumbers(seed) {
  const digest = crypto.createHash('sha256').update(String(seed)).digest();
  let i = 0;
  return () => {
    const value = digest[i % digest.length] + digest[(i + 7) % digest.length] * 256;
    i += 1;
    return value / 65536;
  };
}

// A complete recipe for this name: every part drawn from its list, plus a few numbers inside ranges that
// stay readable at a glance (a mouth wider than the shell, or a one-pixel outline, would not).
function randomRecipe(seed) {
  const next = seededNumbers(seed || String(Date.now()));
  const pick = (list) => list[Math.floor(next() * list.length) % list.length];
  const between = (lo, hi, step = 1) => lo + Math.round((next() * (hi - lo)) / step) * step;
  return {
    shell: pick(SHELLS), eyes: pick(EYES), pattern: pick(PATTERNS), crest: pick(CRESTS), mouth: pick(MOUTHS),
    idle: pick(IDLE), thinking: pick(THINKING), speaking: pick(SPEAKING),
    corner: between(0, 26, 2), stroke: between(2, 6), mouthWidth: between(56, 96, 4), mouthDepth: between(5, 14)
  };
}

// What survives of what an agent asked for: known parts only, numbers clamped into their range, the rest
// filled in at random. Returns a complete recipe, so a caller never has to check for gaps.
function cleanRecipe(raw, seed) {
  const base = randomRecipe(seed);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const out = Object.assign({}, base);
  for (const [key, list] of Object.entries(PARTS)) {
    if (typeof raw[key] === 'string' && list.includes(raw[key])) out[key] = raw[key];
  }
  const number = (key, lo, hi) => {
    const value = Number(raw[key]);
    if (Number.isFinite(value)) out[key] = Math.min(hi, Math.max(lo, Math.round(value)));
  };
  number('corner', 0, 26);
  number('stroke', 2, 6);
  number('mouthWidth', 56, 96);
  number('mouthDepth', 5, 14);
  return out;
}

// -- The parts, as SVG ------------------------------------------------------------------------------
// Every shell leaves the same inner area free for eyes and mouth, so the parts can be combined freely.
const FACE_AREA = { x: 62, y: 52, w: 136, h: 178 };

function shellSvg(recipe) {
  const { corner, stroke } = recipe;
  const a = FACE_AREA;
  if (recipe.shell === 'block') {
    return `
      <polygon class="shell-top" points="${a.x},${a.y} ${a.x + a.w},${a.y} ${a.x + a.w + 24},${a.y - 26} ${a.x + 24},${a.y - 26}"/>
      <polygon class="shell-side" points="${a.x + a.w},${a.y} ${a.x + a.w + 24},${a.y - 26} ${a.x + a.w + 24},${a.y + a.h - 26} ${a.x + a.w},${a.y + a.h}"/>
      <rect class="shell-front" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" rx="2" stroke-width="${stroke}"/>`;
  }
  if (recipe.shell === 'round') {
    return `
      <rect class="shell-front" x="${a.x - 10}" y="${a.y - 6}" width="${a.w + 20}" height="${a.h + 12}" rx="${Math.max(18, corner + 14)}" stroke-width="${stroke}"/>
      <rect class="shell-inset" x="${a.x}" y="${a.y + 4}" width="${a.w}" height="${a.h - 4}" rx="${Math.max(12, corner + 8)}"/>`;
  }
  if (recipe.shell === 'hex') {
    const cx = a.x + a.w / 2;
    const top = a.y - 18;
    const bottom = a.y + a.h + 18;
    return `
      <polygon class="shell-front" points="${cx},${top} ${a.x + a.w + 14},${a.y + 34} ${a.x + a.w + 14},${a.y + a.h - 34} ${cx},${bottom} ${a.x - 14},${a.y + a.h - 34} ${a.x - 14},${a.y + 34}" stroke-width="${stroke}"/>
      <polygon class="shell-inset" points="${cx},${top + 20} ${a.x + a.w},${a.y + 44} ${a.x + a.w},${a.y + a.h - 44} ${cx},${bottom - 20} ${a.x},${a.y + a.h - 44} ${a.x},${a.y + 44}"/>`;
  }
  return `
    <rect class="shell-front" x="${a.x + 6}" y="${a.y - 18}" width="${a.w - 12}" height="${a.h + 30}" rx="${corner}" stroke-width="${stroke}"/>
    <rect class="shell-inset" x="${a.x + 16}" y="${a.y - 6}" width="${a.w - 32}" height="${a.h + 8}" rx="${Math.max(2, corner - 6)}"/>
    <rect class="shell-foot" x="${a.x - 4}" y="${a.y + a.h + 14}" width="${a.w + 8}" height="10" rx="3"/>`;
}

function patternDefs(recipe) {
  if (recipe.pattern === 'grid') {
    return `<pattern id="agent-face-pattern" width="24" height="24" patternUnits="userSpaceOnUse">
      <path d="M24 0H0v24" fill="none" stroke="currentColor" stroke-width="1.2" opacity=".22"/></pattern>`;
  }
  if (recipe.pattern === 'scanlines') {
    return `<pattern id="agent-face-pattern" width="6" height="6" patternUnits="userSpaceOnUse">
      <rect width="6" height="2" fill="currentColor" opacity=".12"/></pattern>`;
  }
  if (recipe.pattern === 'dots') {
    return `<pattern id="agent-face-pattern" width="18" height="18" patternUnits="userSpaceOnUse">
      <circle cx="4" cy="4" r="1.6" fill="currentColor" opacity=".25"/></pattern>`;
  }
  return '';
}

function patternSvg(recipe) {
  if (recipe.pattern === 'plain') return '';
  const a = FACE_AREA;
  return `<rect class="shell-pattern" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" rx="2"/>`;
}

function crestSvg(recipe) {
  const a = FACE_AREA;
  const cx = a.x + a.w / 2;
  if (recipe.crest === 'antenna') {
    return `<g class="crest"><rect x="${cx - 2}" y="${a.y - 48}" width="4" height="30"/><circle class="crest-tip" cx="${cx}" cy="${a.y - 52}" r="7"/></g>`;
  }
  if (recipe.crest === 'ears') {
    return `<g class="crest"><rect x="${a.x - 16}" y="${a.y + 46}" width="12" height="46" rx="3"/><rect x="${a.x + a.w + 4}" y="${a.y + 46}" width="12" height="46" rx="3"/></g>`;
  }
  if (recipe.crest === 'bar') {
    return `<g class="crest"><rect x="${a.x + 12}" y="${a.y - 20}" width="${a.w - 24}" height="9" rx="2"/></g>`;
  }
  return '';
}

function eyesSvg(recipe) {
  const a = FACE_AREA;
  const cx = a.x + a.w / 2;
  const eyeY = a.y + 48;
  if (recipe.eyes === 'pixel') {
    return `<g class="eyes">
      <rect class="eye" x="${cx - 46}" y="${eyeY}" width="30" height="30" rx="1"/>
      <rect class="eye" x="${cx + 16}" y="${eyeY}" width="30" height="30" rx="1"/>
      <rect class="glint" x="${cx - 38}" y="${eyeY + 8}" width="9" height="9"/>
      <rect class="glint" x="${cx + 24}" y="${eyeY + 8}" width="9" height="9"/>
    </g>`;
  }
  if (recipe.eyes === 'visor') {
    return `<g class="eyes">
      <rect class="visor-track" x="${a.x + 14}" y="${eyeY + 4}" width="${a.w - 28}" height="22" rx="2"/>
      <rect class="eye visor-glow" x="${a.x + 14}" y="${eyeY + 4}" width="${a.w - 28}" height="22" rx="2"/>
      <rect class="visor-scanner" x="${a.x + 14}" y="${eyeY + 4}" width="26" height="22" rx="2"/>
    </g>`;
  }
  if (recipe.eyes === 'rings') {
    return `<g class="eyes">
      <circle class="eye-ring" cx="${cx - 32}" cy="${eyeY + 15}" r="19"/>
      <circle class="eye-ring" cx="${cx + 32}" cy="${eyeY + 15}" r="19"/>
      <circle class="eye" cx="${cx - 32}" cy="${eyeY + 15}" r="8"/>
      <circle class="eye" cx="${cx + 32}" cy="${eyeY + 15}" r="8"/>
    </g>`;
  }
  const dots = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      dots.push(`<rect class="eye matrix-dot" x="${cx - 48 + col * 13}" y="${eyeY + row * 13}" width="9" height="9"/>`);
      dots.push(`<rect class="eye matrix-dot" x="${cx + 22 + col * 13}" y="${eyeY + row * 13}" width="9" height="9"/>`);
    }
  }
  return `<g class="eyes">${dots.join('')}</g>`;
}

// -- The parts, as style ----------------------------------------------------------------------------
const MOVES = {
  idle: {
    bob: `#agent-face-overlay.state-idle .face-body{ animation:face-bob 5.4s ease-in-out infinite; }
      @keyframes face-bob{ 0%,100%{ transform:translateY(0); } 50%{ transform:translateY(5px); } }`,
    breathe: `#agent-face-overlay.state-idle .face-body{ animation:face-breathe 6s ease-in-out infinite; }
      @keyframes face-breathe{ 0%,100%{ transform:scale(1); } 50%{ transform:scale(1.015); } }`,
    flicker: `#agent-face-overlay.state-idle .eye{ animation:face-flicker 5.2s steps(1,end) infinite; }
      @keyframes face-flicker{ 0%,90%,100%{ opacity:1; } 92%,95%{ opacity:.25; } }`
  },
  thinking: {
    scan: `#agent-face-overlay.state-thinking .shell-scan{ opacity:.28; animation:face-scan 1.7s linear infinite; }
      @keyframes face-scan{ from{ transform:translateY(0); } to{ transform:translateY(${FACE_AREA.h - 16}px); } }`,
    pulse: `#agent-face-overlay.state-thinking .eye{ animation:face-eye-pulse 1.2s ease-in-out infinite alternate; }
      @keyframes face-eye-pulse{ from{ opacity:.45; } to{ opacity:1; } }`,
    orbit: `#agent-face-overlay.state-thinking .orbiter{ opacity:1; animation:face-orbit 2.4s linear infinite; }
      @keyframes face-orbit{ from{ transform:rotate(0deg); } to{ transform:rotate(360deg); } }`
  },
  speaking: {
    glow: `#agent-face-overlay.state-speaking .shell-front{ animation:face-glow .6s ease-in-out infinite alternate; }
      @keyframes face-glow{ from{ filter:none; } to{ filter:drop-shadow(0 0 12px currentColor); } }`,
    throb: `#agent-face-overlay.state-speaking .eye{ animation:face-throb .3s ease-in-out infinite alternate; }
      @keyframes face-throb{ from{ opacity:.7; } to{ opacity:1; } }`,
    ripple: `#agent-face-overlay.state-speaking .shell-pattern{ animation:face-ripple 1.1s linear infinite; }
      @keyframes face-ripple{ from{ opacity:.2; } 50%{ opacity:.5; } to{ opacity:.2; } }`
  }
};

const MOUTH_CURVES = {
  smile: '(baseY, depth, t) => baseY - depth * Math.sin(t * Math.PI)',
  flat: '(baseY, depth, t) => baseY - depth * 0.25 * Math.sin(t * Math.PI)',
  stern: '(baseY, depth, t) => baseY + depth * 0.55 * Math.sin(t * Math.PI)'
};

function faceCss(recipe) {
  const a = FACE_AREA;
  return `
      #agent-face-overlay .agent-header{ display:flex; align-items:center; gap:10px; letter-spacing:.2em; text-transform:uppercase; font-size:13px; font-weight:700; }
      #agent-face-overlay .agent-dot{ width:9px; height:9px; border-radius:${recipe.shell === 'round' ? '50%' : '1px'}; background:currentColor; box-shadow:0 0 12px currentColor; }
      #agent-face-overlay .agent-status{ opacity:.7; font-weight:400; letter-spacing:.1em; }
      #agent-face-overlay .face-body{ transform-box:fill-box; transform-origin:center; }
      #agent-face-overlay .shell-front{ fill:#08090c; stroke:currentColor; }
      #agent-face-overlay .shell-inset{ fill:currentColor; opacity:.07; }
      #agent-face-overlay .shell-top{ fill:currentColor; opacity:.4; }
      #agent-face-overlay .shell-side{ fill:currentColor; opacity:.2; }
      #agent-face-overlay .shell-foot{ fill:currentColor; opacity:.35; }
      #agent-face-overlay .shell-pattern{ fill:${recipe.pattern === 'plain' ? 'none' : 'url(#agent-face-pattern)'}; pointer-events:none; }
      #agent-face-overlay .shell-scan{ fill:currentColor; opacity:0; }
      #agent-face-overlay .crest rect, #agent-face-overlay .crest circle{ fill:currentColor; opacity:.8; }
      #agent-face-overlay .crest-tip{ opacity:1; }
      #agent-face-overlay .eye{ fill:currentColor; transform-box:fill-box; transform-origin:center; }
      #agent-face-overlay .eye-ring{ fill:none; stroke:currentColor; stroke-width:3; opacity:.5; }
      #agent-face-overlay .matrix-dot{ opacity:.85; }
      #agent-face-overlay .glint{ fill:#fff; opacity:.7; }
      #agent-face-overlay .visor-track{ fill:#0c0d11; stroke:currentColor; stroke-width:1; opacity:.6; }
      #agent-face-overlay .visor-glow{ opacity:.8; }
      #agent-face-overlay .visor-scanner{ fill:#fff; opacity:0; }
      #agent-face-overlay.state-thinking .visor-scanner{ opacity:.9; animation:face-visor-scan 1.3s ease-in-out infinite alternate; }
      @keyframes face-visor-scan{ from{ transform:translateX(0); } to{ transform:translateX(${a.w - 54}px); } }
      #agent-face-overlay .orbiter{ fill:currentColor; opacity:0; transform-box:fill-box; transform-origin:${a.x + a.w / 2}px ${a.y + a.h / 2}px; }
      #agent-face-overlay .thinking-dots rect{ fill:currentColor; transform-box:fill-box; transform-origin:center; }
      #agent-face-overlay.state-thinking .thinking-dots rect{ animation:dot-bounce 1.1s ease-in-out infinite; }
      #agent-face-overlay.state-thinking .thinking-dots rect:nth-child(2){ animation-delay:.15s; }
      #agent-face-overlay.state-thinking .thinking-dots rect:nth-child(3){ animation-delay:.3s; }
      #agent-face-overlay .agent-bubble{
        max-width:min(70vw, 620px); font-size:16px; line-height:1.5; padding:10px 20px;
        border-radius:${recipe.shell === 'round' ? '14px' : '4px'};
        background:rgba(8,9,12,.62); backdrop-filter:blur(2px); color:#eef2f5;
        opacity:0; transform:translateY(6px); border:1px solid currentColor;
        transition:opacity .25s ease, transform .25s ease;
      }
      #agent-face-overlay.state-idle{ opacity:.62; }
      #agent-face-overlay.state-thinking{ opacity:.94; }
      #agent-face-overlay.state-speaking{ opacity:1; }
      ${MOVES.idle[recipe.idle]}
      ${MOVES.thinking[recipe.thinking]}
      ${MOVES.speaking[recipe.speaking]}`;
}

function faceSvg(recipe) {
  const a = FACE_AREA;
  const defs = patternDefs(recipe);
  const orbiter = recipe.thinking === 'orbit'
    ? `<rect class="orbiter" x="${a.x + a.w / 2 - 5}" y="${a.y - 14}" width="10" height="10"/>`
    : '';
  return `
      ${defs ? `<defs>${defs}</defs>` : ''}
      <g class="face-body">
        ${crestSvg(recipe)}
        ${shellSvg(recipe)}
        ${patternSvg(recipe)}
        <rect class="shell-scan" x="${a.x}" y="${a.y}" width="${a.w}" height="16"/>
        ${eyesSvg(recipe)}
        ${orbiter}
        <g class="mouth-pixels"></g>
      </g>
      <g class="thinking-dots">
        <rect x="${a.x + a.w / 2 - 34}" y="${a.y + a.h + 26}" width="13" height="13"/>
        <rect x="${a.x + a.w / 2 - 6}" y="${a.y + a.h + 26}" width="13" height="13"/>
        <rect x="${a.x + a.w / 2 + 22}" y="${a.y + a.h + 26}" width="13" height="13"/>
      </g>`;
}

// The file an overlay asks for: the same shape faces/*.js has, built from the recipe. Only numbers and
// words from the lists above ever reach it -- see the header.
function renderFaceFile(styleName, recipe) {
  const clean = cleanRecipe(recipe, styleName);
  const name = String(styleName).replace(/[^a-zA-Z0-9_-]/g, '') || 'own';
  const a = FACE_AREA;
  return `// Generated from this agent's face recipe (face-design.js) -- ${JSON.stringify(clean)}
(function () {
  'use strict';
  window.__agentFaces = window.__agentFaces || {};
  window.__agentFaces[${JSON.stringify(name)}] = {
    svgInner: ${JSON.stringify(faceSvg(clean))},
    css: ${JSON.stringify(faceCss(clean))},
    mouthParams: {
      centerX: ${a.x + a.w / 2}, baseY: ${a.y + a.h - 34}, depth: ${clean.mouthDepth},
      spread: ${clean.mouthWidth}, rx: ${clean.shell === 'round' ? 3 : 1},
      curve: ${MOUTH_CURVES[clean.mouth]}
    }
  };
})();
`;
}

module.exports = { randomRecipe, cleanRecipe, renderFaceFile, PARTS, BOX, FACE_AREA };
