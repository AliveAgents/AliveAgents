// speech.js
// Shared Piper speech synthesis + local playback. Used by both the hub (Oscar) and every node
// (e.g. Nova), so each agent speaks on ITS OWN machine with ITS OWN voice through ITS OWN
// speakers, instead of routing everything through the hub.

const spawn = require('cross-spawn');
const fs = require('fs');
const path = require('path');

// piperExe/voiceModel/audioDir are configurable per caller, in case different voices are wanted
// per agent (e.g. a different Piper model for Nova than for Oscar).
function createSpeaker({ piperExe, voiceModel, audioDir }) {
  fs.mkdirSync(audioDir, { recursive: true });
  let currentPlayer = null;

  // Generates a WAV file from text via Piper. Calls callback(filePath|null).
  function synthesizeSpeech(text, callback) {
    if (!fs.existsSync(piperExe) || !fs.existsSync(voiceModel)) { callback(null); return; }
    const outPath = path.join(audioDir, `speech-${Date.now()}.wav`);
    const piper = spawn(piperExe, ['--model', voiceModel, '--output_file', outPath]);
    piper.on('error', () => callback(null));
    piper.on('close', (code) => {
      callback(code === 0 && fs.existsSync(outPath) ? outPath : null);
    });
    piper.stdin.write(text);
    piper.stdin.end();
  }

  // Plays a WAV file locally on THIS machine. Calls callback() on completion or abort.
  function playLocally(filePath, callback) {
    const psCommand = `(New-Object Media.SoundPlayer '${filePath}').PlaySync()`;
    const player = spawn('powershell', ['-NoProfile', '-Command', psCommand], { stdio: ['ignore', 'ignore', 'pipe'] });
    currentPlayer = player;
    const done = () => { if (currentPlayer === player) currentPlayer = null; callback(); };
    player.on('error', done);
    player.on('close', done);
  }

  function stopSpeaking() {
    if (currentPlayer) { try { currentPlayer.kill(); } catch (e) {} currentPlayer = null; }
  }

  return { synthesizeSpeech, playLocally, stopSpeaking };
}

module.exports = { createSpeaker };
