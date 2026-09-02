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
  // Bumped by stopSpeaking() and by every new playSequence(). Only playSequence needs it: killing
  // the player mid-sequence fires the SAME 'close' event as a segment finishing normally, so
  // without a generation check an interrupted multi-slide presentation would cheerfully march on
  // to the next slide instead of stopping (playLocally has no such problem -- there is nothing
  // after it to advance to).
  let playGeneration = 0;
  // Piper regularly finishes a short segment inside the same millisecond as the previous one --
  // harmless while only one file existed at a time, but a real collision now that a multi-slide
  // presentation synthesizes several in a row: two segments would land on the same path and the
  // second would overwrite the first. The counter makes the name unique regardless of clock
  // resolution.
  let fileSeq = 0;

  // Generates a WAV file from text via Piper. Calls callback(filePath|null).
  function synthesizeSpeech(text, callback) {
    if (!fs.existsSync(piperExe) || !fs.existsSync(voiceModel)) { callback(null); return; }
    const outPath = path.join(audioDir, `speech-${Date.now()}-${++fileSeq}.wav`);
    const piper = spawn(piperExe, ['--model', voiceModel, '--output_file', outPath]);
    piper.on('error', () => callback(null));
    piper.on('close', (code) => {
      callback(code === 0 && fs.existsSync(outPath) ? outPath : null);
    });
    piper.stdin.write(text);
    piper.stdin.end();
  }

  // Synthesizes several texts in order (one WAV per slide of a multi-slide presentation).
  // Calls callback(filePaths|null) -- null if ANY segment failed, with the already-written files
  // cleaned up, so a caller only ever gets an all-or-nothing result and can fall back to plain
  // speech without having to reason about a half-synthesized deck.
  // Deliberately sequential rather than parallel: Piper is CPU-bound here, and running several
  // instances at once on a laptop that is simultaneously running a Claude session mostly just
  // makes every segment slower.
  function synthesizeAll(texts, callback) {
    const files = [];
    const step = (i) => {
      if (i >= texts.length) { callback(files); return; }
      synthesizeSpeech(texts[i], (filePath) => {
        if (!filePath) {
          for (const f of files) fs.unlink(f, () => {});
          callback(null);
          return;
        }
        files.push(filePath);
        step(i + 1);
      });
    };
    step(0);
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

  // Plays several WAVs back to back, calling onSegment(index) right BEFORE each one starts --
  // that callback is where the caller flips the deck to the matching slide, which is what makes
  // the slide change land in the pause between two spoken segments instead of mid-sentence.
  // Every file is deleted once it has been played (or once the sequence is abandoned), so a
  // stopped presentation leaves nothing behind in audio_out/.
  // done(aborted) always runs, exactly once -- callers rely on it for their idle/cleanup handling
  // just as they do with playLocally, and guard staleness with their own request counters.
  function playSequence(filePaths, onSegment, done) {
    const mySeq = ++playGeneration;
    const step = (i) => {
      if (mySeq !== playGeneration) {
        for (const f of filePaths.slice(i)) fs.unlink(f, () => {});
        done(true);
        return;
      }
      if (i >= filePaths.length) { done(false); return; }
      try { onSegment(i); } catch (e) {}
      playLocally(filePaths[i], () => {
        fs.unlink(filePaths[i], () => {});
        step(i + 1);
      });
    };
    step(0);
  }

  function stopSpeaking() {
    playGeneration++;
    if (currentPlayer) { try { currentPlayer.kill(); } catch (e) {} currentPlayer = null; }
  }

  return { synthesizeSpeech, synthesizeAll, playLocally, playSequence, stopSpeaking };
}

module.exports = { createSpeaker };
