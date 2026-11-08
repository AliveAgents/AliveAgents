// discovery.js
// Finding the hub again after the network changed, without anyone editing an IP address.
//
// The problem this solves: net-config.json pins hubHost to a literal address. Move both machines
// to a different network -- a different flat, a hotspot, a router handing out a new subnet -- and
// every node dials an address that no longer exists, silently, forever (2026-08-31: exactly that).
//
// How: the hub shouts its address into the local network every few seconds over UDP broadcast, and
// nodes listen. A node that hears its own hub at a new address reconnects there. A node starting up
// also sends one probe so it does not have to wait for the next beacon.
//
// Why this is safe even though UDP broadcast is trivially forgeable:
//   * The beacon carries the hub's certificate FINGERPRINT, and a node ignores any beacon whose
//     fingerprint does not match the hub certificate it already pinned. A stranger cannot make a
//     node even consider them.
//   * Even if that check were bypassed, the actual connection is still mutual TLS against the
//     pinned certificate (see agent-net.js). The worst a forged beacon achieves is a connection
//     attempt that fails -- a nuisance, never a compromise.
//   * The fingerprint is not a secret. It is sent in the clear during every TLS handshake anyway.
//
// Deliberately hand-rolled over dgram rather than pulling in an mDNS/Bonjour library: this is
// roughly sixty lines, it needs no service registry, and the project keeps its two dependencies.

const dgram = require('dgram');

// One port above the enrollment port (8788 agent, 8789 enrollment, 8790 discovery).
const DISCOVERY_PORT = Number(process.env.AGENT_DISCOVERY_PORT) || 8790;
const BEACON_MS = 5000;
const MAGIC = 'aliveagents-hub-v1';

// -- Hub side ---------------------------------------------------------------------------------
// Announces "<hubName> is at <this address>:<port>" periodically, and answers a node's probe
// immediately so a starting node does not sit idle for up to a full beacon interval.
function startHubBeacon({ hubName, port, fingerprint, log = console.log }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let stopped = false;

  const payload = () => Buffer.from(JSON.stringify({
    magic: MAGIC, hubName, port, fingerprint
  }));

  // The address is deliberately NOT put in the payload: the receiver reads it off the packet
  // itself (rinfo.address), which is the address that actually worked to reach it -- more reliable
  // than whatever this machine believes its own IP to be when several adapters exist (a real
  // problem here: this machine has WSL and Hyper-V adapters alongside the LAN one).
  function beacon() {
    if (stopped) return;
    try {
      socket.send(payload(), DISCOVERY_PORT, '255.255.255.255');
    } catch (e) {
      // A network that refuses broadcast is a reason to stay quiet, not to crash.
    }
  }

  socket.on('error', (err) => {
    log('[discovery] beacon socket error: ' + err.message);
    try { socket.close(); } catch (e) {}
  });

  socket.on('message', (msg, rinfo) => {
    let m;
    try { m = JSON.parse(msg.toString('utf8')); } catch (e) { return; }
    if (!m || m.magic !== MAGIC || m.probe !== true) return;
    // Answer the asker directly rather than broadcasting again.
    try { socket.send(payload(), rinfo.port, rinfo.address); } catch (e) {}
  });

  socket.bind(DISCOVERY_PORT, () => {
    try { socket.setBroadcast(true); } catch (e) {}
    log(`[discovery] announcing "${hubName}" on udp/${DISCOVERY_PORT}`);
    beacon();
  });

  const timer = setInterval(beacon, BEACON_MS);
  return { stop: () => { stopped = true; clearInterval(timer); try { socket.close(); } catch (e) {} } };
}

// -- Node side --------------------------------------------------------------------------------
// onFound(address, port) fires only when a beacon names THIS node's hub, its fingerprint matches
// the pinned certificate, and the address differs from the one currently in use.
function listenForHub({ hubName, expectedFp, currentHost, onFound, log = console.log }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let host = currentHost;
  let stopped = false;

  socket.on('error', (err) => {
    log('[discovery] listener socket error: ' + err.message);
    try { socket.close(); } catch (e) {}
  });

  socket.on('message', (msg, rinfo) => {
    let m;
    try { m = JSON.parse(msg.toString('utf8')); } catch (e) { return; }
    if (!m || m.magic !== MAGIC || m.probe) return;
    if (m.hubName !== hubName) return;
    // The check that matters: only a hub holding the certificate this node already trusts is worth
    // listening to. Anything else is someone else's network, or someone playing games.
    if (expectedFp && String(m.fingerprint || '').toUpperCase() !== String(expectedFp).toUpperCase()) {
      log(`[discovery] ignoring a beacon for "${hubName}" from ${rinfo.address} -- wrong certificate`);
      return;
    }
    if (rinfo.address === host) return;
    log(`[discovery] hub "${hubName}" is now at ${rinfo.address} (was ${host})`);
    host = rinfo.address;
    onFound(rinfo.address, m.port);
  });

  socket.bind(DISCOVERY_PORT, () => {
    try { socket.setBroadcast(true); } catch (e) {}
    log(`[discovery] listening for "${hubName}" on udp/${DISCOVERY_PORT}`);
    probe();
  });

  // Asks straight away instead of waiting for the next beacon -- matters on startup, and after a
  // network change where the node may have been dialling nothing for a while.
  function probe() {
    if (stopped) return;
    const msg = Buffer.from(JSON.stringify({ magic: MAGIC, probe: true }));
    try { socket.send(msg, DISCOVERY_PORT, '255.255.255.255'); } catch (e) {}
  }

  // Keeps probing while nothing has been found, so a node started before the hub still finds it.
  const timer = setInterval(probe, BEACON_MS);

  return {
    stop: () => { stopped = true; clearInterval(timer); try { socket.close(); } catch (e) {} },
    // Lets the caller keep this in step when it changes the host for its own reasons.
    setHost: (h) => { host = h; }
  };
}

// -- Before a machine belongs anywhere ----------------------------------------------------------
// A machine that has not been paired yet knows no hub name and holds no certificate, so it cannot
// use listenForHub above: it has nothing to compare against. It listens for ANY hub instead, purely
// to offer the address as a suggestion on its join page (join-mode.js) -- the user still sees it,
// and the pairing code is what decides whether the two machines end up trusting each other. A
// forged beacon can therefore only propose the wrong address, which fails the code check moments
// later; it cannot talk its way into a network.
function listenForAnyHub({ onFound, log = console.log }) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let stopped = false;

  socket.on('error', () => { try { socket.close(); } catch (e) {} });
  socket.on('message', (msg, rinfo) => {
    let m;
    try { m = JSON.parse(msg.toString('utf8')); } catch (e) { return; }
    if (!m || m.magic !== MAGIC || m.probe) return;
    if (typeof m.hubName !== 'string' || !m.hubName) return;
    onFound({ hubName: m.hubName, host: rinfo.address, port: Number(m.port) || undefined });
  });

  socket.bind(DISCOVERY_PORT, () => {
    try { socket.setBroadcast(true); } catch (e) {}
    log(`[discovery] listening for any hub on udp/${DISCOVERY_PORT}`);
    probe();
  });

  function probe() {
    if (stopped) return;
    try { socket.send(Buffer.from(JSON.stringify({ magic: MAGIC, probe: true })), DISCOVERY_PORT, '255.255.255.255'); } catch (e) {}
  }
  const timer = setInterval(probe, BEACON_MS);

  return { stop: () => { stopped = true; clearInterval(timer); try { socket.close(); } catch (e) {} } };
}

module.exports = { startHubBeacon, listenForHub, listenForAnyHub, DISCOVERY_PORT, BEACON_MS };
