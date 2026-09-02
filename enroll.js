// enroll.js
// Run on a BRAND-NEW machine to join the network. Everything secret is created here and stays
// here: this generates the machine's own key pair locally, and only its certificate (public) ever
// travels. Nothing has to be copied from the hub by hand.
//
// Usage:  enroll.bat <hub-ip> <code> <name>
//   e.g.  enroll.bat 192.168.178.90 K7QF-2M9X-BTLR ada
//
// The code comes from the hub -- ask Oscar to set up a new agent, or run "/provision <name>" on
// the hub console. It is valid for a few minutes and for a handful of attempts.

const path = require('path');
const fs = require('fs');
const { enroll } = require('./enrollment.js');

const [, , host, code, name] = process.argv;

if (!host || !code || !name) {
  console.log('');
  console.log('  Usage:  enroll.bat <hub-ip> <code> <name>');
  console.log('  Example: enroll.bat 192.168.178.90 K7QF-2M9X-BTLR ada');
  console.log('');
  console.log('  Get the code by asking Oscar to set up a new agent,');
  console.log('  or by running "/provision <name>" on the hub console.');
  console.log('');
  process.exit(1);
}

// Same port convention as the hub (net port + 1, see ENROLL_PORT there). Overridable for the same
// reason every other port in this project is: running a second instance for testing.
const PORT = Number(process.env.AGENT_ENROLL_PORT) || 8789;

console.log(`\nJoining the network as "${name}" via ${host}:${PORT} ...\n`);

enroll({
  host,
  port: PORT,
  code,
  name,
  certDir: path.join(__dirname, 'certs'),
  log: (m) => console.log('  ' + m)
}, (err, res) => {
  if (err) {
    console.error('\n  Enrollment failed: ' + err.message + '\n');
    // The two mistakes that actually happen, called out rather than left to be guessed at.
    if (/could not reach/i.test(err.message)) {
      console.error('  Is the hub running, and did someone open an enrollment window for this name?');
      console.error('  The window closes after a few minutes -- ask for a fresh code if in doubt.\n');
    }
    process.exit(1);
  }

  const cfg = res.config;
  console.log('\n  Done. This machine is now part of the network.\n');
  console.log(`    agent name    ${cfg.agentName}`);
  console.log(`    hub           ${cfg.hubName} at ${cfg.hubHost}:${cfg.hubPort}`);
  console.log(`    voice         ${cfg.piperVoice}`);
  console.log(`    face          ${cfg.faceStyle}`);
  console.log('');
  console.log('  Still to do on this machine:');
  console.log(`    1. Put the voice model ${cfg.piperVoice} into tools\\piper\\voices\\`);
  console.log('    2. Copy token.local.bat.example to token.local.bat and put your Claude token in it');
  console.log('    3. Run start-node.bat');
  console.log(`    4. Open http://localhost:${cfg.overlayPort}/agent-face-overlay.user.js in a browser`);
  console.log('       with Tampermonkey installed, and install the overlay from there');
  console.log('');
  // Named explicitly because it is the one file here that must never be shared, and someone
  // setting up a machine is exactly the person who might be tempted to copy the whole folder on.
  console.log(`  certs\\${name}-key.pem is this machine's private key. It never leaves this machine.`);
  console.log('');

  if (!fs.existsSync(path.join(__dirname, 'tools', 'piper', 'voices', cfg.piperVoice))) {
    console.log(`  Note: ${cfg.piperVoice} is not in tools\\piper\\voices\\ yet -- without it this agent stays silent.\n`);
  }
});
