// faces/kai.js -- face definition "Kai": angular shell, hazard-stripe bezel, red visor bar.
// NOT a Node module (no require/module.exports) -- fetched by the browser overlay script as raw
// text (GET /faces/kai.js from its own local overlay-server.js) and executed via
// new Function(...). Registers itself on window.__agentFaces.
//
// IMPORTANT (see overlay-server.js): this folder is NEVER exposed to any agent for writing, only
// ever distributed via project-folder sync (scp) -- code here runs directly inside the overlay
// script's privileged context (WS access, mic control), unlike presented_content/ (inside an iframe).
(function () {
  'use strict';
  window.__agentFaces = window.__agentFaces || {};
  window.__agentFaces['kai'] = {
    svgInner: `
      <defs>
        <pattern id="agent-scanlines" width="5" height="5" patternUnits="userSpaceOnUse">
          <rect width="5" height="2" fill="currentColor" opacity="0.08"/>
        </pattern>
        <pattern id="agent-hazard" width="16" height="16" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="8" height="16" fill="currentColor" opacity="0.5"/>
        </pattern>
      </defs>
      <g class="bezel-deco">
        <rect class="hazard-strip" x="40" y="0" width="180" height="8"/>
        <rect x="56" y="10" width="22" height="9"/>
        <rect x="182" y="10" width="22" height="9"/>
      </g>
      <rect class="face-shell" x="14" y="22" width="232" height="228" rx="3"/>
      <rect class="face-inset" x="26" y="34" width="208" height="204" rx="1"/>
      <rect class="scanline-overlay" x="26" y="34" width="208" height="204" rx="1"/>
      <g class="visor">
        <rect class="visor-track" x="58" y="118" width="144" height="18" rx="2"/>
        <rect class="visor-glow" x="58" y="118" width="144" height="18" rx="2"/>
        <rect class="visor-scanner" x="58" y="118" width="26" height="18" rx="2"/>
      </g>
      <g class="mouth-pixels"></g>
      <g class="thinking-dots">
        <circle cx="103" cy="198" r="6"/>
        <circle cx="130" cy="198" r="6"/>
        <circle cx="157" cy="198" r="6"/>
      </g>
    `,
    css: `
      #agent-face-overlay .agent-header{
        display:flex; align-items:center; gap:10px;
        letter-spacing:.18em; text-transform:uppercase; font-size:14px; font-weight:700;
      }
      #agent-face-overlay .agent-dot{
        width:9px; height:9px; border-radius:1px; background:currentColor;
        box-shadow:0 0 12px currentColor;
      }
      #agent-face-overlay .agent-status{ opacity:.75; font-weight:400; }
      #agent-face-overlay .hazard-strip{ fill:url(#agent-hazard); }
      #agent-face-overlay .bezel-deco rect:not(.hazard-strip){ fill:currentColor; opacity:.6; }
      #agent-face-overlay .face-shell{ fill:#0a0a0c; stroke:currentColor; stroke-width:5; }
      #agent-face-overlay .face-inset{ fill:#120608; stroke:currentColor; stroke-width:1.5; opacity:.55; }
      #agent-face-overlay .scanline-overlay{ fill:url(#agent-scanlines); pointer-events:none; }
      #agent-face-overlay .visor-track{ fill:#1a0a0a; stroke:currentColor; stroke-width:1; opacity:.6; }
      #agent-face-overlay .visor-glow{ fill:currentColor; }
      #agent-face-overlay .visor-scanner{ fill:#fff; opacity:0; }
      #agent-face-overlay.state-idle .visor-glow{ opacity:.35; animation:visor-flicker 4.6s ease-in-out infinite; }
      @keyframes visor-flicker{ 0%,91%,96%,100%{ opacity:.35; } 93%,94%{ opacity:.05; } }
      #agent-face-overlay.state-thinking .visor-glow{ opacity:.3; }
      #agent-face-overlay.state-thinking .visor-scanner{ opacity:1; animation:scan 1.1s ease-in-out infinite alternate; }
      @keyframes scan{ 0%{ transform:translateX(0); } 100%{ transform:translateX(118px); } }
      #agent-face-overlay.state-speaking .visor-glow{ animation:visor-pulse .22s ease-in-out infinite alternate; }
      @keyframes visor-pulse{ from{ opacity:.75; } to{ opacity:1; } }
      #agent-face-overlay .agent-bubble{
        max-width:min(70vw, 620px); font-size:16px; line-height:1.5;
        padding:10px 20px; border-radius:4px;
        background:rgba(10,4,4,.6); backdrop-filter:blur(2px);
        color:#ffe8e8; opacity:0; transform:translateY(6px);
        border:1px solid currentColor;
        transition:opacity .25s ease, transform .25s ease;
      }
      #agent-face-overlay.state-idle{ color:#8a4a4a; opacity:.62; }
      #agent-face-overlay.state-thinking{ color:#ff6a3d; opacity:.94; }
      #agent-face-overlay.state-speaking{ color:#ff2b3d; opacity:1; }
    `,
    mouthParams: {
      centerX: 130, baseY: 190, depth: 9, spread: 84, rx: 1,
      // Mouth corners slightly down instead of up = stern/grim (original comment from the old buildMouth)
      curve: (baseY, depth, t) => baseY - depth * Math.sin(t * Math.PI)
    }
    // init(box) deliberately omitted -- Kai needs nothing dynamically built besides the (now
    // shared) mouth, the visor is purely CSS-animated on static markup.
  };
})();
