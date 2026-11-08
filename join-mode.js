// join-mode.js
// What a machine shows BEFORE it belongs to a network: its own page at http://localhost:8787/, with a
// form for the hub's address, a name and the pairing code. Until this existed, a new agent had to be
// enrolled from the command line (node enroll.js <ip> <code> <name>) and only then had a face at all --
// which meant typing a twelve-character code into a phone terminal, by hand, inside five minutes.
// User's wish, 2026-11-07: "ich will eigentlich so wenig wie möglich in der Kommandozeile unterwegs sein".
//
// Deliberately a mode of its own rather than a half-started agent: with no configuration there is no
// identity, no permissions, no voice and nothing to say, and pretending otherwise would mean guarding
// every single feature in node-agent.js against "but not yet". So this starts the face server, serves the
// join form, and the moment pairing succeeds the process restarts as a fully configured agent.
//
// What it does NOT do, on purpose:
//   * It never asks the hub for a code. The code comes from the user, who got it at the hub -- that is
//     the whole point of the pairing code (see enrollment.js), and a machine that could request one
//     could enrol itself.
//   * The address a hub beacon suggests is only ever filled into the form, never used on its own.
//     Anybody on the network can send a beacon; only the code decides.

const fs = require('fs');
const path = require('path');
const { startOverlayServer } = require('./overlay-server.js');
const enrollment = require('./enrollment.js');
const discovery = require('./discovery.js');

const PAGE_MESSAGE_TYPES = ['join-get', 'join-submit'];
const RESTART_CODE = 75; // same as the updater: the start scripts loop on it
const NAME_MAX = 40;

// The hub's own default. A machine that has never been paired has no reason to know any other.
const DEFAULT_HUB_PORT = 8788;

function start({
  configFile = path.join(__dirname, 'net-config.json'),
  certDir = path.join(__dirname, 'certs'),
  overlayPort = Number(process.env.AGENT_OVERLAY_PORT) || 8787,
  log = console.log,
  restart = null
} = {}) {
  let state = { status: 'waiting', message: '', hub: null };
  let busy = false;

  const publicState = () => ({
    status: state.status,
    message: state.message,
    hub: state.hub,
    defaultPort: DEFAULT_HUB_PORT,
    restartable: process.env.ALIVEAGENTS_RESTARTABLE === '1'
  });

  const push = () => { try { overlay.pushPage({ type: 'join', join: publicState() }); } catch (e) { /* no page open */ } };
  const set = (next) => { state = Object.assign({}, state, next); push(); };

  const overlay = startOverlayServer({
    port: overlayPort,
    // No microphone and no chat: there is nobody to talk to yet, and nothing that could answer.
    onPageMessage: (msg, reply) => handlePageMessage(msg, reply),
    log
  });
  overlay.setState({ status: 'idle', text: '', agent: 'Not set up yet', faceStyle: '' });

  // Only a suggestion for the form. Keeps listening while the page is open, so a hub started after
  // the phone still turns up without anyone reloading anything.
  const finder = discovery.listenForAnyHub({
    log,
    onFound: ({ hubName, host, port }) => {
      if (state.hub && state.hub.host === host && state.hub.hubName === hubName) return;
      log(`[join] a hub called "${hubName}" is at ${host}`);
      set({ hub: { hubName, host, port: port || DEFAULT_HUB_PORT } });
    }
  });

  function handlePageMessage(msg, reply) {
    if (msg.type === 'join-get') { reply({ join: publicState() }); return; }
    if (msg.type !== 'join-submit') return;
    if (busy) { reply({ error: 'A pairing attempt is already running.' }); return; }

    const host = String(msg.host || '').trim();
    const name = String(msg.name || '').trim().toLowerCase();
    const code = String(msg.code || '').trim();
    const port = Number(msg.port) || DEFAULT_HUB_PORT;
    // Checked here rather than left to the enrolment: a mistyped field should come back as a sentence
    // in the form, not as a failed handshake that burns one of the three attempts on the code.
    if (!host) { reply({ error: 'The hub\'s address is missing.' }); return; }
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(host)) { reply({ error: 'That does not look like an address. Use the hub\'s IP, for example 192.168.178.90.' }); return; }
    if (!name) { reply({ error: 'A name is missing -- the same one the hub was given.' }); return; }
    if (name.length > NAME_MAX || !/^[a-z0-9_-]+$/.test(name)) { reply({ error: 'The name may only hold lowercase letters, digits, - and _.' }); return; }
    if (code.replace(/[^0-9a-zA-Z]/g, '').length < 8) { reply({ error: 'That code looks too short. It has twelve characters, in three groups.' }); return; }
    if (fs.existsSync(configFile)) { reply({ error: 'This machine already belongs to a network.' }); return; }

    busy = true;
    set({ status: 'joining', message: `Pairing with ${host}…` });
    log(`[join] pairing with ${host}:${port} as "${name}"`);
    enrollment.enroll({ host, port, code, name, certDir, configPath: configFile, overwrite: false, log }, (err, res) => {
      busy = false;
      if (err) {
        set({ status: 'waiting', message: err.message });
        log(`[join] pairing failed: ${err.message}`);
        reply({ error: err.message });
        return;
      }
      const hubName = (res && res.config && res.config.hubName) || 'the hub';
      set({ status: 'joined', hub: { hubName, host, port }, message: `Paired with "${hubName}".` });
      log(`[join] paired with "${hubName}". Starting as a full agent.`);
      reply({ ok: true, join: publicState() });
      // Everything this process holds -- the overlay server on this port included -- belongs to the
      // half-configured state. Starting over is both simpler and more honest than trying to grow into
      // a configured agent at runtime. 1.5 s so the page gets its answer first (see updater.js).
      setTimeout(() => {
        try { finder.stop(); } catch (e) {}
        if (restart) { restart(); return; }
        if (process.env.ALIVEAGENTS_RESTARTABLE === '1') process.exit(RESTART_CODE);
        log('[join] Start this agent again to bring it up with its new configuration.');
      }, 1500);
    });
  }

  log('');
  log(`  This machine is not part of a network yet. Open http://localhost:${overlayPort}/ here and enter`);
  log('  the pairing code from the hub. (The old way still works: node enroll.js <hub-ip> <code> <name>.)');
  log('');

  return { publicState, stop: () => { try { finder.stop(); } catch (e) {} } };
}

module.exports = { start, PAGE_MESSAGE_TYPES, RESTART_CODE };
