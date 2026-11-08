// agent-net.js
// Encrypted transport between the agent nodes on the local network.
//
// Security model:
//   * TLS 1.3 (nothing below that is accepted). The actual encryption is thus AES-256-GCM or
//     ChaCha20-Poly1305 from the OpenSSL compiled into Node, which uses the CPU's AES-NI hardware
//     instructions on x86-64 (constant time -> no cache-timing side channels). We do NOT
//     implement any cryptography ourselves.
//   * Mutual authentication: both sides present a certificate, both sides verify.
//   * There is deliberately no shared CA. Every node is its own root, and each side only accepts
//     the exactly pinned SHA-256 fingerprint of the other side. So even a real, globally trusted
//     CA cannot issue a valid certificate for this network.
//   * Forward secrecy comes from TLS 1.3's ECDHE handshake: whoever steals the private keys
//     later still cannot decrypt traffic captured earlier.
//   * Replay protection, sequence numbers, and integrity are all provided by TLS 1.3 itself.
//
// The only hand-rolled part of the protocol is the message framing below (length prefix + JSON),
// because TLS delivers a byte stream and no delimited messages.

const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CERT_DIR = path.join(__dirname, 'certs');
// Upper bound per message, so the other side can't fill up our memory.
// 8 MB instead of the earlier 1 MB, since presentation audio (main-display feature) now travels
// as base64 inside the same JSON message: Piper "medium" produces ~43 KB/s of raw WAV, base64
// adds ~33% on top (~57 KB/s encoded) -- 8 MB thus covers >140s of speech, plenty of headroom for
// the normal case. Safe to raise, because the other side is always the user's own,
// certificate-pinned device, never an untrusted source.
// IMPORTANT: every machine (hub + all nodes) needs this update BEFORE a presentation is
// attempted -- an outdated copy does not cleanly reject an oversized frame, it immediately drops
// the connection in attachFraming() instead (socket.destroy()).
// Overridable via env, same as MAX_FOLLOWUP_HOPS in agent-bridge-server.js -- handy for
// deliberately triggering the "message too large" path while testing, without touching the
// constant itself.
const MAX_MSG_BYTES = Number(process.env.AGENT_MAX_MSG_BYTES) || 8 * 1024 * 1024;

// How long a connection may sit idle before the OS starts probing whether the other side is still
// there. Without this, a peer that disappeared WITHOUT closing the connection -- the hub being
// restarted is the everyday case -- is never detected: TCP says nothing while no data flows, so
// the node keeps a dead socket it believes is fine, and the reconnect loop below (which only fires
// on 'close'/'error') never runs. Found live 2026-08-31: the node showed an ESTABLISHED connection
// to a hub that had no connection at all, and the agent had been silently unreachable for hours.
// 20s is well under the idle time of a quiet conversation, so a break is noticed within roughly
// half a minute rather than never.
const KEEPALIVE_MS = 20000;

function certPath(name, kind) {
  return path.join(CERT_DIR, `${name}-${kind}.pem`);
}

function loadIdentity(name) {
  return {
    key: fs.readFileSync(certPath(name, 'key')),
    cert: fs.readFileSync(certPath(name, 'cert'))
  };
}

function loadPeerCert(name) {
  return fs.readFileSync(certPath(name, 'cert'));
}

// Normalizes fingerprints to uppercase without colons, so the comparison is independent of
// whichever spelling convention the respective Node API happens to use.
function normalizeFp(fp) {
  return String(fp || '').replace(/:/g, '').toUpperCase();
}

function fingerprintOfCertPem(pem) {
  return normalizeFp(new crypto.X509Certificate(pem).fingerprint256);
}

// -- Message framing: 4-byte length (big endian) + UTF-8 JSON ------------------------------

function sendMessage(socket, obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  if (payload.length > MAX_MSG_BYTES) throw new Error('Message too large');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
}

function attachFraming(socket, onMessage) {
  let buffered = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.length < 4) return;
      const len = buffered.readUInt32BE(0);
      if (len > MAX_MSG_BYTES) { socket.destroy(); return; }
      if (buffered.length < 4 + len) return;
      const payload = buffered.subarray(4, 4 + len);
      buffered = buffered.subarray(4 + len);
      let msg;
      try {
        msg = JSON.parse(payload.toString('utf8'));
      } catch (e) {
        socket.destroy(); // unparseable frame -> connection is not trustworthy
        return;
      }
      onMessage(msg);
    }
  });
}

// -- Hub (runs on Oscar's laptop) --------------------------------------------------------

// peers: array of node names whose certificates live in certs/ and are accepted.
// onMessage(peerName, msg), onPeerUp(peerName), onPeerDown(peerName)
function startHub({ selfName, peers, port, host = '0.0.0.0', onMessage, onPeerUp, onPeerDown, log = console.log }) {
  const me = loadIdentity(selfName);
  const peerCerts = peers.map(loadPeerCert);
  const expected = new Map(peers.map((n) => [fingerprintOfCertPem(loadPeerCert(n)), n]));
  const connected = new Map(); // peerName -> socket

  const server = tls.createServer({
    key: me.key,
    cert: me.cert,
    ca: peerCerts,             // only these self-signed certificates count as roots
    requestCert: true,         // client MUST present a certificate
    rejectUnauthorized: true,  // invalid chain -> connection is never even passed through
    minVersion: 'TLSv1.3'
  }, (socket) => {
    const peerCert = socket.getPeerCertificate();
    const peerName = expected.get(normalizeFp(peerCert && peerCert.fingerprint256));

    // Second, independent check on top of OpenSSL's own chain validation:
    // the fingerprint must exactly match one of the pinned certificates.
    if (!peerName) {
      log('[net] Connection rejected: unknown certificate fingerprint');
      socket.destroy();
      return;
    }

    // See the matching call on the node side for the full reasoning: without keepalive a peer that
    // vanished silently is never noticed, and the socket lingers as a zombie.
    socket.setKeepAlive(true, KEEPALIVE_MS);

    log(`[net] "${peerName}" connected (${socket.getProtocol()}, ${socket.getCipher().name})`);
    connected.set(peerName, socket);
    if (onPeerUp) onPeerUp(peerName);

    attachFraming(socket, (msg) => onMessage && onMessage(peerName, msg));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      // A socket that is no longer this peer's current one is a LEFTOVER: the peer already
      // reconnected on a new socket, and said hello on it, before this one's close was noticed.
      // That is the normal course when a connection dies without a FIN -- the dead socket only
      // closes once keepalive gives up, long after the node's 3s retry has already succeeded.
      // Reporting the peer as down then UNDOES the live connection's registration: the socket
      // survives (the delete below is guarded), but onPeerDown drops the agent from the hub's
      // roster, so it is connected and unroutable at the same time -- and it never notices,
      // because its own link is fine. Found 2026-11-08, after Steve had been invisible to the
      // hub for hours while his own log said he was connected.
      const current = connected.get(peerName) === socket;
      if (current) connected.delete(peerName);
      log(`[net] "${peerName}" disconnected${current ? '' : ' (leftover connection -- already back on a new one)'}`);
      if (current && onPeerDown) onPeerDown(peerName);
    });
  });

  server.on('tlsClientError', (err) => {
    // Most common case: someone on the WiFi connects without a valid certificate.
    // That is exactly the case this setup is meant to defend against -- just log it.
    log('[net] Handshake rejected: ' + err.message);
  });

  server.listen(port, host, () => log(`[net] Hub listening on ${host}:${port} (TLS 1.3 only, mutual certificate required)`));

  return {
    server,
    // Accepts a newly enrolled node WITHOUT restarting the hub. Both places that decide whether a
    // connection is allowed have to learn about it: OpenSSL's own chain validation (the `ca` list,
    // which lives inside the TLS secure context and is therefore replaced wholesale via
    // setSecureContext) and the fingerprint pinning below it (`expected`). Missing either one
    // means the new node is rejected -- by the handshake or by the explicit check -- so they are
    // updated together here rather than by any caller.
    // requestCert/rejectUnauthorized are server options, not part of the secure context, so
    // replacing the context leaves the mutual-certificate requirement untouched.
    addPeer: (name) => {
      const certPem = loadPeerCert(name);
      const fp = fingerprintOfCertPem(certPem);
      if (expected.has(fp)) return false; // already known -- re-adding would duplicate the ca entry
      peerCerts.push(certPem);
      expected.set(fp, name);
      server.setSecureContext({ key: me.key, cert: me.cert, ca: peerCerts, minVersion: 'TLSv1.3' });
      log(`[net] "${name}" accepted as a peer (no restart needed)`);
      return true;
    },
    knownPeers: () => Array.from(expected.values()),
    peers: () => Array.from(connected.keys()),
    isUp: (name) => connected.has(name),
    send: (name, msg) => {
      const socket = connected.get(name);
      if (!socket) return false;
      sendMessage(socket, msg);
      return true;
    },
    broadcast: (msg) => {
      for (const socket of connected.values()) sendMessage(socket, msg);
    }
  };
}

// -- Node (runs on the second laptop) --------------------------------------------------------

function connectToHub({ selfName, hubName, host, port, onMessage, onOpen, onClose, log = console.log, retryMs = 3000 }) {
  const me = loadIdentity(selfName);
  const hubCert = loadPeerCert(hubName);
  const expectedFp = fingerprintOfCertPem(hubCert);
  let socket = null;
  let stopped = false;
  // Mutable so discovery can move this node to the hub's new address without a restart (see
  // discovery.js). Read fresh on every connect attempt rather than captured once.
  let currentHost = host;

  function connect() {
    if (stopped) return;
    socket = tls.connect({
      host: currentHost,
      port,
      key: me.key,
      cert: me.cert,
      ca: [hubCert],
      minVersion: 'TLSv1.3',
      // We connect via an IP address, but the certificate is issued for a name.
      // Instead of hostname verification we pin the exact fingerprint -- that is stricter
      // than the default check, not laxer.
      checkServerIdentity: (hostname, cert) => {
        if (normalizeFp(cert.fingerprint256) !== expectedFp) {
          return new Error('Hub fingerprint does not match the pinned certificate');
        }
        return undefined;
      }
    }, () => {
      if (!socket.authorized) { // should never happen given these options, but belt and suspenders
        log('[net] Hub not authorized: ' + socket.authorizationError);
        socket.destroy();
        return;
      }
      // The important half: this side is the one that has to notice a hub that went away, because
      // it is the one that reconnects. Keepalive turns a silently dead peer into a real 'error'/
      // 'close' event, which is what drives the retry below.
      socket.setKeepAlive(true, KEEPALIVE_MS);

      log(`[net] connected to hub "${hubName}" (${socket.getProtocol()}, ${socket.getCipher().name})`);
      if (onOpen) onOpen();
    });

    attachFraming(socket, (msg) => onMessage && onMessage(msg));

    socket.on('error', (err) => log('[net] Connection error: ' + err.message));
    socket.on('close', () => {
      if (onClose) onClose();
      if (!stopped) {
        log(`[net] Connection lost, retrying in ${retryMs / 1000}s`);
        setTimeout(connect, retryMs);
      }
    });
  }
  connect();

  return {
    send: (msg) => {
      if (socket && !socket.destroyed && socket.authorized) { sendMessage(socket, msg); return true; }
      return false;
    },
    // Points this link at a different address and reconnects immediately. Dropping the old socket
    // is the point: without it the node would keep waiting on a connection to an address that no
    // longer exists, which is exactly the state a network change leaves it in.
    setHost: (newHost) => {
      if (!newHost || newHost === currentHost) return false;
      currentHost = newHost;
      if (socket) { try { socket.destroy(); } catch (e) {} }
      return true;
    },
    getHost: () => currentHost,
    isUp: () => !!(socket && !socket.destroyed && socket.authorized),
    stop: () => { stopped = true; if (socket) socket.destroy(); }
  };
}

// sendMessage/attachFraming/normalizeFp are exported for enrollment.js, which speaks the same
// length-prefixed JSON framing over its own short-lived TLS listener. Deliberately reused rather
// than reimplemented: a second, subtly different framing would be a second thing to get wrong.
module.exports = { startHub, connectToHub, fingerprintOfCertPem, loadPeerCert, sendMessage, attachFraming, normalizeFp };
