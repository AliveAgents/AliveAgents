// enrollment.js
// Pairing-code enrollment: how a brand-new machine joins the network without anyone copying a
// private key around.
//
// The problem it solves: normal traffic runs over mutual TLS where each side only accepts the
// exactly pinned certificate of the other (see agent-net.js). A machine that has never been seen
// before is therefore unreachable by definition -- neither side knows the other's certificate yet.
// Enrollment is a separate, deliberately unpinned channel that exists only while a short window
// is open, and a one-time code is what turns "encrypted to somebody" into "encrypted to the
// machine my human is standing at".
//
// What the code is NOT: it does not create, sign or protect any key. The new machine generates
// its own key pair locally BEFORE enrollment starts, and the private half never leaves that
// machine -- not over the network, not on a USB stick. Only certificates (public by nature) are
// exchanged. The code's single job is authenticating that exchange.
//
// Why the fingerprints go into the proof: a bare HMAC(code, "hello") could simply be relayed by a
// man in the middle, who would then sit between both sides as a trusted peer. By covering BOTH
// certificate fingerprints, a proof only verifies if the sender saw the receiver's real
// certificate -- an attacker presenting its own breaks the match. The code binds two specific
// keys together, it does not merely prove "somebody knew a password".
//
// Why the direction label: without it, the node's proof and the hub's proof would be the same
// bytes over the same inputs, and an attacker could reflect one back as the other. The labels and
// the reversed fingerprint order make the two structurally different.
//
// Why scrypt instead of using the code directly as the HMAC key: whoever records the exchange can
// try codes offline. With a raw HMAC each guess costs microseconds; scrypt at N=2^15 costs ~100ms,
// which is what makes a short, speakable code safe. A 40-bit code at 100ms per guess averages
// >1700 years. HMAC itself is not vulnerable to length extension (it is a nested construction, see
// RFC 2104) -- that concern applies to naive H(secret || message), which this deliberately is not.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const spawn = require('cross-spawn');

// Crockford-style base32 without I, L, O and U: the code gets spoken aloud by an agent and typed
// by a human, so characters that sound or look alike are removed rather than explained.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
// 56 bits, i.e. 12 characters. The first cut at this was 40 bits (8 characters), justified with
// arithmetic that turned out to be wrong by a factor of 1000: at the measured 75ms scrypt cost,
// 40 bits is ~1300 core-years to exhaust, which is plenty for one machine but only ~1.6 months
// for an attacker with 10k cores. 56 bits puts that back at ~8500 years even at 10k cores.
//
// This only matters against an attacker who RECORDED an enrollment and grinds the code offline
// afterwards; online guessing is capped at MAX_ATTEMPTS regardless. Raising it further is free
// on the security side and costs only patience -- an agent has to read the code out loud, and 12
// characters is already a long thing to say.
const CODE_BYTES = 7;
const CODE_GROUP = 4;          // "K7QF-2M9X-BTLR" reads back more reliably than one long run

// scrypt parameters. N*r*128 = 32 MB, which is exactly Node's default maxmem, so maxmem is raised
// explicitly rather than left to trip over its own limit on some machines and not others.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

const ENROLL_TIMEOUT_MS = 5 * 60 * 1000;
// Three tries rather than one: a mistyped code is far more likely than an attack, and the scrypt
// cost plus the five-minute window already make guessing hopeless. After that the code is burned
// -- a fresh one has to be issued, which is a deliberate human step.
const MAX_ATTEMPTS = 3;

function generateCode() {
  const bytes = crypto.randomBytes(CODE_BYTES);
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    out += CODE_ALPHABET[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  }
  return out.match(new RegExp(`.{1,${CODE_GROUP}}`, 'g')).join('-');
}

// Accepts the code however the human typed it: lower case, missing dashes, and the characters
// that were excluded from the alphabet precisely because they get confused (O->0, I/L->1).
function normalizeCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

// The hub's fingerprint doubles as the scrypt salt: both sides know it as soon as the TLS
// handshake is done, it differs per hub, and it ties the derived key to this specific peer.
function deriveKey(code, fpHub) {
  return crypto.scryptSync(normalizeCode(code), fpHub, 32, SCRYPT);
}

// Fixed field order and explicit separators: with variable-length fields an ambiguous
// concatenation ("AB"+"C" vs "A"+"BC") would be forgeable. Fingerprints are fixed-length hex, but
// the separators keep that property from depending on it.
function proofFor(direction, key, fpFrom, fpTo) {
  return crypto.createHmac('sha256', key).update(`${direction}|${fpFrom}|${fpTo}`).digest();
}

function nodeProof(key, fpHub, fpNode) { return proofFor('node->hub', key, fpHub, fpNode); }
function hubProof(key, fpNode, fpHub) { return proofFor('hub->node', key, fpNode, fpHub); }

// Constant time on purpose: a byte-wise early-exit comparison leaks, through timing, how much of
// the expected value was matched, which is enough to reconstruct it byte by byte.
// timingSafeEqual throws on differing lengths, so that is checked first.
function proofMatches(expected, receivedHex) {
  let received;
  try { received = Buffer.from(String(receivedHex || ''), 'hex'); } catch (e) { return false; }
  if (received.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

// -- Certificate generation ------------------------------------------------------------------
// Runs on whichever machine the identity belongs to, so a private key is created where it will
// live and nowhere else.
//
// openssl comes from Git, which this project already requires for cloning. It is frequently NOT
// on PATH though (confirmed on a real node machine, 2026-08-25: Git installed under
// %LOCALAPPDATA%\Programs\Git, openssl only inside it), so PATH is merely the first candidate
// rather than the assumption.
function resolveOpenssl() {
  const candidates = [];
  const local = process.env.LOCALAPPDATA;
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  for (const base of [local && path.join(local, 'Programs', 'Git'), pf && path.join(pf, 'Git'), pf86 && path.join(pf86, 'Git')]) {
    if (!base) continue;
    candidates.push(path.join(base, 'usr', 'bin', 'openssl.exe'));
    candidates.push(path.join(base, 'mingw64', 'bin', 'openssl.exe'));
  }
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'openssl'; // last resort: let PATH resolve it (works in Git Bash, and on non-Windows)
}

// Mirrors make-certs.sh exactly -- same curve, same lifetime, same extensions -- so an identity
// created here is indistinguishable from one created by the existing script. Deliberately does
// not overwrite: silently replacing a key would cut an already-enrolled machine off the network.
function ensureIdentity(certDir, name) {
  const keyPath = path.join(certDir, `${name}-key.pem`);
  const certPath = path.join(certDir, `${name}-cert.pem`);
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { keyPath, certPath, created: false };
  }
  fs.mkdirSync(certDir, { recursive: true });
  const exe = resolveOpenssl();
  const args = [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-keyout', keyPath, '-out', certPath,
    '-days', '3650', '-nodes', '-subj', `/CN=${name}`,
    '-addext', `subjectAltName=DNS:${name}`,
    '-addext', 'keyUsage=critical,digitalSignature',
    '-addext', 'extendedKeyUsage=serverAuth,clientAuth'
  ];
  const res = spawn.sync(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (res.error) throw new Error(`could not run openssl (${exe}): ${res.error.message}`);
  if (res.status !== 0) throw new Error(`openssl failed: ${String(res.stderr || '').trim()}`);
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) throw new Error('openssl reported success but wrote no files');
  return { keyPath, certPath, created: true };
}

// -- The enrollment channel --------------------------------------------------------------------

const tls = require('tls');
const { sendMessage, attachFraming, normalizeFp, fingerprintOfCertPem } = require('./agent-net.js');

// A name becomes a FILE NAME (certs/<name>-cert.pem) and a config key, so it is validated
// strictly rather than sanitized -- anything outside this set is refused instead of quietly
// rewritten, which keeps "the name I typed" and "the name on disk" the same thing.
const NAME_RE = /^[a-z][a-z0-9_-]{1,31}$/;

function isValidName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

function derToPem(der) {
  const b64 = Buffer.from(der).toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

// Hub side. Opens a listener that exists ONLY for this one enrollment: it closes on success, on
// too many bad attempts, and on timeout. Everything about it is deliberately short-lived -- an
// always-on enrollment port would be a permanent way in, guarded by nothing but a password.
//
// buildConfig(name) returns the net-config the new machine should be given.
// onEnrolled(name, certPem) is where the hub pins the peer and persists it; throwing from it
// aborts the enrollment and reports the failure to the joining machine.
// expectedName pins WHICH agent this window may enroll. Without it a valid code would let the
// joining machine pick any name it liked -- including one that overwrites an existing peer's
// certificate. The name is decided when the window is opened (by the human, through Oscar), so
// there is no reason to let the other end choose it.
function startEnrollmentListener({ selfName, certDir, port, host = '0.0.0.0', code, expectedName, buildConfig, onEnrolled, onClosed, log = console.log }) {
  const fs2 = require('fs');
  const myKey = fs2.readFileSync(path.join(certDir, `${selfName}-key.pem`));
  const myCert = fs2.readFileSync(path.join(certDir, `${selfName}-cert.pem`));
  const fpHub = fingerprintOfCertPem(myCert);
  const key = deriveKey(code, fpHub);

  let attempts = 0;
  let finished = false;

  const server = tls.createServer({
    key: myKey,
    cert: myCert,
    // No client certificate is requested: the joining machine's certificate travels inside the
    // enrollment message instead, because at this point there is nothing to validate it against.
    // Authentication comes entirely from the code-derived proof below.
    requestCert: false,
    minVersion: 'TLSv1.3'
  }, (socket) => {
    socket.on('error', () => socket.destroy());
    attachFraming(socket, (msg) => {
      if (finished || !msg || msg.type !== 'enroll-hello') { socket.destroy(); return; }

      const fail = (reason, burn) => {
        log(`[enroll] rejected: ${reason}`);
        try { sendMessage(socket, { type: 'enroll-error', reason }); } catch (e) {}
        setTimeout(() => socket.destroy(), 50);
        if (burn && ++attempts >= MAX_ATTEMPTS) {
          log(`[enroll] ${MAX_ATTEMPTS} failed attempts -- code burned, window closed.`);
          close();
        }
      };

      if (!isValidName(msg.name)) { fail('invalid agent name', false); return; }
      if (expectedName && msg.name !== expectedName) {
        // Deliberately not counted as a bad code attempt: it is a mismatch, not a guess, and
        // saying so plainly is more useful than burning the window on a typo'd name.
        fail(`this code was issued for "${expectedName}", not "${msg.name}"`, false);
        return;
      }
      let fpNode;
      try {
        fpNode = fingerprintOfCertPem(msg.certPem);
      } catch (e) { fail('unreadable certificate', false); return; }

      // The proof covers BOTH fingerprints, so this simultaneously checks "knows the code" and
      // "saw my real certificate" -- the second half is what a man in the middle cannot fake.
      if (!proofMatches(nodeProof(key, fpHub, fpNode), msg.proof)) { fail('wrong code', true); return; }

      finished = true;
      let config;
      try {
        fs2.writeFileSync(path.join(certDir, `${msg.name}-cert.pem`), msg.certPem);
        config = buildConfig(msg.name);
        onEnrolled(msg.name, msg.certPem);
      } catch (e) {
        log('[enroll] failed while registering: ' + e.message);
        try { sendMessage(socket, { type: 'enroll-error', reason: 'hub could not register the agent: ' + e.message }); } catch (e2) {}
        setTimeout(() => { socket.destroy(); close(); }, 50);
        return;
      }

      sendMessage(socket, {
        type: 'enroll-ok',
        proof: hubProof(key, fpNode, fpHub).toString('hex'),
        config
      });
      log(`[enroll] "${msg.name}" enrolled successfully.`);
      setTimeout(() => { socket.destroy(); close(); }, 250);
    });
  });

  server.on('tlsClientError', (err) => log('[enroll] handshake failed: ' + err.message));

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    try { server.close(); } catch (e) {}
    if (onClosed) onClosed();
  }

  const timer = setTimeout(() => {
    if (!finished) log('[enroll] window expired without an enrollment.');
    close();
  }, ENROLL_TIMEOUT_MS);

  server.listen(port, host, () => log(`[enroll] waiting for a new agent on port ${port} (${ENROLL_TIMEOUT_MS / 60000} minutes)`));

  return { close, isOpen: () => !closed };
}

// Node side. Generates this machine's own identity if it has none, proves knowledge of the code,
// and writes what comes back. Calls back with (err, result).
// configPath is a parameter rather than a hardcoded path so a test can enroll without destroying
// the machine's real configuration -- and so re-enrolling can be pointed somewhere safe.
// overwrite must be set explicitly: silently replacing an existing net-config.json would wipe a
// working agent's identity and settings, and enrollment is exactly the operation someone might
// re-run "just to be sure".
function enroll({ host, port, code, name, certDir, configPath = path.join(__dirname, 'net-config.json'), overwrite = false, log = console.log }, callback) {
  if (!isValidName(name)) { callback(new Error(`invalid agent name "${name}" -- use lowercase letters, digits, - and _`)); return; }
  const fs2 = require('fs');
  if (!overwrite && fs2.existsSync(configPath)) {
    callback(new Error(`${configPath} already exists -- this machine is already set up. Move it aside first if you really want to re-enroll.`));
    return;
  }
  let identity;
  try {
    identity = ensureIdentity(certDir, name);
  } catch (e) { callback(e); return; }
  log(identity.created ? `[enroll] generated a new identity for "${name}"` : `[enroll] reusing the existing identity for "${name}"`);
  const myCertPem = fs2.readFileSync(identity.certPath, 'utf8');
  const fpNode = fingerprintOfCertPem(myCertPem);

  let done = false;
  const finish = (err, res) => { if (!done) { done = true; callback(err, res); } };

  // rejectUnauthorized:false is the entire point of this channel and not an oversight: there is
  // nothing to validate the hub against yet. The connection is encrypted but unauthenticated, and
  // the exchange below is what turns it into an authenticated one -- after which normal traffic
  // uses strict pinning like everything else.
  const socket = tls.connect({ host, port, rejectUnauthorized: false, minVersion: 'TLSv1.3' }, () => {
    const peer = socket.getPeerCertificate();
    if (!peer || !peer.raw) { finish(new Error('hub presented no certificate')); socket.destroy(); return; }
    const fpHub = normalizeFp(peer.fingerprint256);
    // Taken from what TLS actually presented, never from anything the hub tells us later -- so
    // there is no way for the two to disagree.
    const hubCertPem = derToPem(peer.raw);
    const key = deriveKey(code, fpHub);

    attachFraming(socket, (msg) => {
      if (!msg) return;
      if (msg.type === 'enroll-error') { finish(new Error(msg.reason || 'rejected by the hub')); socket.destroy(); return; }
      if (msg.type !== 'enroll-ok') return;
      if (!proofMatches(hubProof(key, fpNode, fpHub), msg.proof)) {
        // Either the code is wrong, or something is impersonating the hub. Nothing gets written.
        finish(new Error('the hub could not prove it knows the code -- aborting, nothing was saved'));
        socket.destroy();
        return;
      }
      const cfg = msg.config || {};
      try {
        fs2.writeFileSync(path.join(certDir, `${cfg.hubName}-cert.pem`), hubCertPem);
        fs2.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
      } catch (e) { finish(e); socket.destroy(); return; }
      finish(null, { config: cfg, fpHub, fpNode });
      socket.destroy();
    });

    sendMessage(socket, {
      type: 'enroll-hello',
      name,
      certPem: myCertPem,
      proof: nodeProof(key, fpHub, fpNode).toString('hex')
    });
  });

  socket.on('error', (err) => finish(new Error('could not reach the hub: ' + err.message)));
  socket.on('close', () => finish(new Error('the hub closed the connection without completing enrollment')));
}

module.exports = {
  generateCode, normalizeCode, deriveKey, nodeProof, hubProof, proofMatches,
  ensureIdentity, resolveOpenssl, isValidName, derToPem,
  startEnrollmentListener, enroll,
  ENROLL_TIMEOUT_MS, MAX_ATTEMPTS
};
