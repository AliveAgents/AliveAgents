// publish-release.js
// Signs the current state of this checkout as a release the agents can install (updater.js). Run it only on
// the PC that holds the release key -- the user's own:
//
//   node publish-release.js --init-key   once: creates the key pair. The private half goes to
//                                        ~/.aliveagents-release/ and never into the repository; the public
//                                        half becomes release-key.pub here and ships with the program.
//   node publish-release.js              lists every file git would publish, hashes them, has this PC's
//                                        confirmation dialog (Windows Hello) name the version and the number
//                                        of files, signs, and writes release.json.
//
// Committing and pushing are the next, separate steps: nothing leaves this PC without the user doing that.
// Keep a copy of the private key somewhere safe. Without it no further release can be signed, and every
// agent would need its release-key.pub replaced by hand.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const updater = require('./updater.js');
const deviceConfirm = require('./device-confirm.js');

const ROOT = __dirname;
const KEY_DIR = process.env.ALIVEAGENTS_RELEASE_KEY_DIR || path.join(os.homedir(), '.aliveagents-release');
const PRIVATE_KEY = path.join(KEY_DIR, 'release-key.pem');
const PUBLIC_KEY = path.join(ROOT, updater.KEY_FILE);

function initKey() {
  if (fs.existsSync(PRIVATE_KEY)) {
    console.log(`A release key already exists (${PRIVATE_KEY}). Nothing changed.`);
    return;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(KEY_DIR, { recursive: true });
  fs.writeFileSync(PRIVATE_KEY, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(PUBLIC_KEY, publicKey.export({ type: 'spki', format: 'pem' }));
  console.log(`Release key created. Private: ${PRIVATE_KEY} (keep a safe copy, never publish it). Public: ${updater.KEY_FILE} (ships with the program).`);
}

// Every file git would publish -- tracked, or new and not ignored -- except release.json itself. Secrets
// are kept out twice: by .gitignore, and by updater.isProtected, which no update may ever write anyway.
function releaseFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' });
  const all = [...new Set(out.split('\0').filter(Boolean).map((f) => f.replace(/\\/g, '/')))].sort();
  const files = [];
  const skipped = [];
  for (const rel of all) {
    if (rel === updater.MANIFEST_FILE || !fs.existsSync(path.join(ROOT, rel))) continue;
    if (updater.isSafePath(rel) && !updater.isProtected(rel)) files.push(rel); else skipped.push(rel);
  }
  if (skipped.length) console.log(`Not part of the release (names an update may not write): ${skipped.join(', ')}`);
  return files;
}

function nextVersion() {
  const d = new Date();
  const today = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  let previous = null;
  try { previous = JSON.parse(fs.readFileSync(path.join(ROOT, updater.MANIFEST_FILE), 'utf8')).version; } catch (e) { previous = null; }
  const n = previous && previous.startsWith(`${today}-`) ? Number(previous.split('-')[1]) + 1 : 1;
  return `${today}-${n}`;
}

async function publish() {
  if (!fs.existsSync(PRIVATE_KEY)) throw new Error('There is no release key on this PC. Create it once with: node publish-release.js --init-key');
  const privateKey = crypto.createPrivateKey(fs.readFileSync(PRIVATE_KEY, 'utf8'));
  const shipped = crypto.createPublicKey(fs.readFileSync(PUBLIC_KEY, 'utf8'));
  const ownPublic = crypto.createPublicKey(privateKey);
  if (!ownPublic.export({ type: 'spki', format: 'der' }).equals(shipped.export({ type: 'spki', format: 'der' }))) {
    throw new Error(`${updater.KEY_FILE} does not belong to the private key in ${KEY_DIR}. Nothing was signed.`);
  }
  const files = releaseFiles();
  for (const needed of [updater.KEY_FILE, 'updater.js']) {
    if (!files.includes(needed)) throw new Error(`${needed} would not be part of the release. Nothing was signed.`);
  }
  const hashes = {};
  for (const rel of files) hashes[rel] = updater.fileHash(path.join(ROOT, rel));
  const version = nextVersion();

  const confirmer = deviceConfirm.createConfirmer({ log: () => {} });
  const answer = await confirmer.ask(`AliveAgents: publish version ${version} of the agents' program -- ${files.length} files, signed with this PC's release key.`);
  if (!answer.ok) throw new Error(`${answer.reason} Nothing was signed.`);

  const manifest = updater.signManifest({ format: 1, name: 'AliveAgents', version, published: new Date().toISOString(), files: hashes }, privateKey);
  if (!updater.verifyManifest(manifest, shipped)) throw new Error('The signed release does not verify. Nothing was written.');
  fs.writeFileSync(path.join(ROOT, updater.MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Version ${version} signed: ${files.length} files, written to ${updater.MANIFEST_FILE}.`);
  console.log('To publish it, commit everything including release.json and push. Agents then offer the update on their face page.');
}

if (require.main === module) {
  (process.argv.includes('--init-key') ? Promise.resolve(initKey()) : publish()).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { releaseFiles, nextVersion };
