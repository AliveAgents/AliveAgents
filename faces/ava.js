// faces/ava.js -- face definition "Ava": rounded shell, eye pixels, cyan/green tone.
// NOT a Node module (no require/module.exports) -- fetched by the browser overlay script as raw
// text (GET /faces/ava.js from its own local overlay-server.js) and executed via
// new Function(...). Registers itself on window.__agentFaces.
//
// IMPORTANT (see overlay-server.js): this folder is NEVER exposed to any agent for writing, only
// ever distributed via project-folder sync (scp) -- code here runs directly inside the overlay
// script's privileged context (WS access, mic control), unlike presented_content/ (inside an iframe).
(function () {
  'use strict';
  window.__agentFaces = window.__agentFaces || {};
  window.__agentFaces['ava'] = {
    svgInner: `
      <defs>
        <pattern id="agent-scanlines" width="5" height="5" patternUnits="userSpaceOnUse">
          <rect width="5" height="2" fill="currentColor" opacity="0.07"/>
        </pattern>
      </defs>
      <g class="bezel-deco">
        <rect x="58" y="2" width="18" height="11" rx="2"/>
        <rect x="92" y="2" width="10" height="11" rx="2"/>
        <rect x="158" y="2" width="10" height="11" rx="2"/>
        <rect x="184" y="2" width="18" height="11" rx="2"/>
        <line x1="76" y1="7" x2="92" y2="7"/>
        <line x1="168" y1="7" x2="184" y2="7"/>
      </g>
      <rect class="face-shell" x="18" y="20" width="224" height="224" rx="20"/>
      <rect class="face-inset" x="30" y="32" width="200" height="200" rx="12"/>
      <rect class="scanline-overlay" x="30" y="32" width="200" height="200" rx="12"/>
      <g class="eyes">
        <g class="eye-col eye-col-left"></g>
        <g class="eye-col eye-col-right"></g>
      </g>
      <g class="mouth-pixels"></g>
      <g class="thinking-dots">
        <circle cx="103" cy="182" r="6"/>
        <circle cx="130" cy="182" r="6"/>
        <circle cx="157" cy="182" r="6"/>
      </g>
    `,
    css: `
      #agent-face-overlay .agent-header{
        display:flex; align-items:center; gap:10px;
        letter-spacing:.15em; text-transform:uppercase; font-size:13px; font-weight:600;
      }
      #agent-face-overlay .agent-dot{
        width:8px; height:8px; border-radius:50%; background:currentColor;
        box-shadow:0 0 10px currentColor;
      }
      #agent-face-overlay .agent-status{ opacity:.7; font-weight:400; }
      #agent-face-overlay .bezel-deco rect{ fill:currentColor; opacity:.5; }
      #agent-face-overlay .bezel-deco line{ stroke:currentColor; stroke-width:2; opacity:.35; }
      #agent-face-overlay .face-shell{ fill:#0d0f16; stroke:currentColor; stroke-width:4; }
      #agent-face-overlay .face-inset{ fill:#05141a; stroke:currentColor; stroke-width:1.5; opacity:.5; }
      #agent-face-overlay .scanline-overlay{ fill:url(#agent-scanlines); pointer-events:none; }
      #agent-face-overlay .eye-pixel{ fill:currentColor; }
      #agent-face-overlay.state-idle .eyes{ animation:blink 4.6s ease-in-out infinite; }
      @keyframes blink{ 0%,91%,96%,100%{ opacity:1; } 93%,94%{ opacity:.08; } }
      #agent-face-overlay.state-thinking .eyes{ animation:look-around 1.6s ease-in-out infinite; }
      @keyframes look-around{ 0%,100%{ transform:translateX(0); } 50%{ transform:translateX(7px); } }
      #agent-face-overlay .agent-bubble{
        max-width:min(70vw, 620px); font-size:15px; line-height:1.5;
        padding:10px 18px; border-radius:14px;
        background:rgba(10,12,20,.55); backdrop-filter:blur(2px);
        color:#f2f2f7; opacity:0; transform:translateY(6px);
        transition:opacity .25s ease, transform .25s ease;
      }
      #agent-face-overlay.state-idle{ color:#8b93a8; opacity:.68; }
      #agent-face-overlay.state-thinking{ color:#f5a524; opacity:.92; }
      #agent-face-overlay.state-speaking{ color:#2fd8f6; opacity:1; }
    `,
    mouthParams: {
      centerX: 130, baseY: 190, depth: 16, spread: 80, rx: 2,
      curve: (baseY, depth, t) => baseY - depth * (1 - Math.sin(t * Math.PI))
    },
    // -- Eyes: 4 stacked pixels per eye each (identical to the old buildEyes(), takes box as a
    // parameter instead of a closed-over module const, since this file is now separate from the shell script).
    init(box) {
      const SVG_NS = 'http://www.w3.org/2000/svg';
      const cols = { left: 80, right: 171 };
      for (const side of ['left', 'right']) {
        const g = box.querySelector('.eye-col-' + side);
        const x = cols[side];
        for (let row = 0; row < 4; row++) {
          const rect = document.createElementNS(SVG_NS, 'rect');
          rect.setAttribute('class', 'eye-pixel');
          rect.setAttribute('x', x);
          rect.setAttribute('y', 100 + row * 13);
          rect.setAttribute('width', 10);
          rect.setAttribute('height', 10);
          rect.setAttribute('rx', 2);
          g.appendChild(rect);
        }
      }
    }
  };
})();
