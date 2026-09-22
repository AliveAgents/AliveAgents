// speech.js
// Shared Piper speech synthesis + local playback. Used by both the hub (Oscar) and every node
// (e.g. Nova), so each agent speaks on ITS OWN machine with ITS OWN voice through ITS OWN
// speakers, instead of routing everything through the hub.

const spawn = require('cross-spawn');
const fs = require('fs');
const path = require('path');

// piperExe/voiceModel/audioDir are configurable per caller, in case different voices are wanted
// per agent (e.g. a different Piper model for Nova than for Oscar).
// What the voice actually says. A reply is shown as text as well, where a link is useful, but read aloud a
// web address is noise: the voice spelled out "h t t p s colon slash slash" (reported 2026-09-15). The web
// search tool itself asks the model to end with a "Sources:" list of links; the sources skill tells the
// agent to name sources in its sentences instead, and this catches whatever slips through, at the one
// place every spoken text passes -- so the chat and the face's bubble still show the reply as written.
const ADDRESS_TEST = /(?:https?:\/\/|www\.)\S/i;

// "de.wikipedia.org" -> "wikipedia", "www.bbc.co.uk" -> "bbc".
function siteName(host) {
  const labels = String(host || '').toLowerCase().replace(/^www\d*\./, '').split('.').filter(Boolean);
  if (labels.length < 2) return labels[0] || '';
  const last = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  // co.uk, com.au, gv.at: the name sits one label further left
  if (labels.length >= 3 && last.length === 2 && second.length <= 3) return labels[labels.length - 3];
  return second;
}

function speakableText(raw) {
  const lines = String(raw == null ? '' : raw).split(/\r?\n/);
  // A "Sources:" heading with nothing but links after it, to the end: dropped entirely.
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:[-*#>]\s*)*(?:\*\*|__)?(?:sources?|quellen?|references?)(?:\*\*|__)?\s*:?\s*(?:\*\*|__)?\s*(.*)$/i.exec(lines[i]);
    if (!m) continue;
    const rest = [m[1], ...lines.slice(i + 1)].filter((l) => l.trim());
    if (rest.length && rest.every((l) => ADDRESS_TEST.test(l))) {
      lines.length = i;
      break;
    }
  }
  return lines.join('\n')
    // [title](address) -> title
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|www\.)[^)\s]*\)/gi, '$1')
    // any other address -> the name of its site, keeping the punctuation that ended the sentence
    .replace(/<?\b((?:https?:\/\/|www\.)[^\s<>()"'\]]+)>?/gi, (whole, address) => {
      const trail = /[.,;:!?]+$/.exec(address);
      const bare = trail ? address.slice(0, -trail[0].length) : address;
      let host = '';
      try { host = new URL(/^www\./i.test(bare) ? `http://${bare}` : bare).hostname; } catch (e) { host = ''; }
      return (siteName(host) || 'a website') + (trail ? trail[0] : '');
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function createSpeaker({ piperExe, voiceModel, audioDir, androidTts }) {
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

  // Android (a Termux node) has no Piper: Piper ships glibc Linux builds, Termux is bionic, and
  // the binary will not load. Android's own TTS engine is right there though, via
  // termux-tts-speak (pkg install termux-api, plus the Termux:API app) -- and crucially it does
  // synthesis AND playback in one call that BLOCKS until the sentence has been spoken, which is
  // exactly the shape playSequence needs.
  //
  // So on Android the two halves shift meaning without changing their contract: "synthesis"
  // parks the text in a .txt file, "playback" feeds that file to termux-tts-speak on stdin.
  // Everything built on top keeps working untouched -- synthesizeAll's all-or-nothing rule,
  // playSequence's onSegment callback firing right before each segment, stopSpeaking killing the
  // running process, the per-segment file cleanup -- because the only thing those parts ever
  // assumed is "a path that playLocally knows what to do with".
  //
  // One honest limitation, measured on a real phone: stopSpeaking() aborts the SEQUENCE (the
  // remaining segments are never spoken, done(true) fires) but does NOT cut off the sentence
  // already in flight. The speaking happens inside Android's system TTS service, not inside the
  // termux-tts-speak process, so killing that process does not reach the audio -- a run
  // interrupted at 2.5 s still ran to the segment's natural 7.8 s end. Interrupting via a second
  // flushing call was tried and hangs the termux-api socket, so it is deliberately not done.
  // Practical effect: "be quiet" on a phone node takes effect at the end of the current
  // sentence rather than mid-word. On Windows it still cuts immediately.
  const ANDROID_TTS = process.platform === 'android';
  // -s MUSIC matters: termux-tts-speak defaults to the NOTIFICATION stream, which on a phone is
  // a different (and usually much quieter) volume slider than the one a user reaches for when
  // they think "make it louder". Measured on a real device before setting this.
  const TTS = Object.assign({ language: 'en', stream: 'MUSIC' }, androidTts || {});

  function ttsArgs() {
    const a = [];
    if (TTS.engine) a.push('-e', TTS.engine);
    if (TTS.language) a.push('-l', TTS.language);
    if (TTS.region) a.push('-n', TTS.region);
    if (TTS.variant) a.push('-v', TTS.variant);
    if (TTS.pitch != null) a.push('-p', String(TTS.pitch));
    if (TTS.rate != null) a.push('-r', String(TTS.rate));
    if (TTS.stream) a.push('-s', TTS.stream);
    return a;
  }

  // How this machine actually gets a WAV out of its speakers. Windows has PowerShell's
  // SoundPlayer built in; Linux/Android (a Termux node) and macOS need an external player, and
  // which one exists varies per install -- so the first one actually present on PATH wins,
  // looked up once and remembered.
  //
  // The hard requirement is that the player BLOCKS until the file has finished. Everything in
  // playSequence hangs off the process exit: onSegment(i) fires right before segment i starts,
  // which is exactly what makes a presentation's slides flip in the pauses between spoken
  // segments. A fire-and-forget player -- notably Termux's own "termux-media-player play", which
  // returns the instant playback STARTS -- would make every slide flip at once and the agent
  // look like it is talking over its own deck. That is why ffplay (with -autoexit) is preferred
  // on Android over the more obvious termux-media-player.
  let resolvedPlayer; // undefined = not looked up yet, null = looked up, nothing usable found

  function onPath(exe) {
    const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const dir of dirs) {
      for (const ext of exts) {
        try { if (fs.existsSync(path.join(dir, exe + ext))) return true; } catch (_) { /* unreadable PATH entry */ }
      }
    }
    return false;
  }

  function resolvePlayer() {
    if (resolvedPlayer !== undefined) return resolvedPlayer;
    if (ANDROID_TTS) {
      // stdinFile, not an argv path: the text goes in on stdin (termux-tts-speak reads stdin when
      // given no text arguments), which keeps quoting, apostrophes and length limits out of it.
      resolvedPlayer = { cmd: 'termux-tts-speak', args: () => ttsArgs(), stdinFile: true };
      return resolvedPlayer;
    }
    if (process.platform === 'win32') {
      resolvedPlayer = { cmd: 'powershell', args: f => ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${f}').PlaySync()`] };
      return resolvedPlayer;
    }
    const candidates = process.platform === 'darwin'
      ? [['afplay', f => [f]]]
      : [
          // Termux: pkg install ffmpeg -- also the most common one on a desktop Linux node.
          ['ffplay', f => ['-nodisp', '-autoexit', '-loglevel', 'quiet', f]],
          // Termux: pkg install termux-api (plus the Termux:API app). Blocks, unlike
          // termux-media-player.
          ['play-audio', f => [f]],
          // Ordinary Linux fallbacks; not normally present on Android.
          ['aplay', f => ['-q', f]],
          ['paplay', f => [f]],
        ];
    for (const [cmd, args] of candidates) {
      if (onPath(cmd)) { resolvedPlayer = { cmd, args }; return resolvedPlayer; }
    }
    resolvedPlayer = null;
    return resolvedPlayer;
  }

  // Android can also be handed REAL audio. When this phone is the main display, another agent's
  // presentation arrives as that agent's own recorded voice (WAV), and termux-tts-speak cannot
  // play a file -- it would read the bytes out as text. So audio needs an actual player, and one
  // that BLOCKS until the file has finished, for the same slide-timing reason as everywhere else.
  // play-audio (pkg install play-audio) does; termux-media-player returns the moment playback
  // starts and is therefore deliberately not on this list. When none is present,
  // canPlayAudioFiles() says so and the display speaks the segment text in this phone's own voice.
  let resolvedAndroidAudio; // undefined = not looked up yet, null = nothing usable found

  function resolveAndroidAudioPlayer() {
    if (resolvedAndroidAudio !== undefined) return resolvedAndroidAudio;
    const candidates = [
      ['play-audio', (f) => [f]],
      ['ffplay', (f) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', f]],
      ['mpv', (f) => ['--no-video', '--really-quiet', f]]
    ];
    resolvedAndroidAudio = null;
    for (const [cmd, args] of candidates) {
      if (onPath(cmd)) { resolvedAndroidAudio = { cmd, args }; break; }
    }
    return resolvedAndroidAudio;
  }

  // On Android the file type decides: parked text goes to the TTS engine, anything else is audio.
  function playerFor(filePath) {
    if (ANDROID_TTS && !String(filePath).endsWith('.txt')) return resolveAndroidAudioPlayer();
    return resolvePlayer();
  }

  // Returns a running child process, or null if this machine has no way to play audio. Null is
  // deliberately not fatal: the agent keeps thinking, answering and driving its face, it just
  // stays silent -- far better than an unstartable node, and the one log line says exactly which
  // package is missing.
  function spawnPlayer(filePath) {
    const p = playerFor(filePath);
    if (!p) {
      if (!spawnPlayer.warned) {
        spawnPlayer.warned = true;
        // Not ffmpeg on a phone: that package failed to link on a real Termux install and left dpkg
        // half-configured, blocking every later install (2026-09-14). play-audio is small and enough.
        console.log(ANDROID_TTS
          ? '[speech] No player for received audio -- install one with "pkg install play-audio". Until then, received slides are spoken in this phone’s own voice.'
          : '[speech] No audio player found -- staying silent. Install one, e.g. "apt install ffmpeg".');
      }
      return null;
    }
    if (p.stdinFile) {
      let fd;
      try { fd = fs.openSync(filePath, 'r'); } catch (e) { return null; }
      const child = spawn(p.cmd, p.args(filePath), { stdio: [fd, 'ignore', 'pipe'] });
      let closed = false;
      const shut = () => { if (closed) return; closed = true; try { fs.closeSync(fd); } catch (e) {} };
      child.on('close', shut);
      child.on('error', shut);
      return child;
    }
    return spawn(p.cmd, p.args(filePath), { stdio: ['ignore', 'ignore', 'pipe'] });
  }

  // Generates a WAV file from text via Piper. Calls callback(filePath|null).
  function synthesizeSpeech(rawText, callback) {
    const text = speakableText(rawText);
    if (ANDROID_TTS) {
      // No audio is produced here -- the phone's TTS engine does that at playback time. The file
      // exists purely so the rest of the pipeline has a path to pass around and delete.
      const textPath = path.join(audioDir, `speech-${Date.now()}-${++fileSeq}.txt`);
      try { fs.writeFileSync(textPath, text, 'utf8'); } catch (e) { callback(null); return; }
      callback(textPath);
      return;
    }
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
    const player = spawnPlayer(filePath);
    if (!player) { callback(); return; }
    currentPlayer = player;
    // Fires exactly once. A player that cannot be exec'd at all emits BOTH 'error' and 'close',
    // and an unguarded callback then ran twice -- harmless for a single line of speech, but in
    // playSequence it calls step(i + 1) twice and the presentation silently skips a slide. Found
    // while exercising the non-Windows branch with a player binary present but not runnable,
    // which is exactly the state a Termux node lands in after a wrong-architecture install.
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      if (currentPlayer === player) currentPlayer = null;
      callback();
    };
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

  // What this speaker can do, asked by presentation-audio.js:
  //   producesAudioFiles  synthesizeSpeech yields real audio another machine could play. False on
  //                       Android, where synthesis only parks text for the phone's own TTS engine --
  //                       a presenter like that has to send its slides as text instead.
  //   canPlayAudioFiles   audio received from another machine can be played here.
  function producesAudioFiles() { return !ANDROID_TTS; }
  function canPlayAudioFiles() { return ANDROID_TTS ? resolveAndroidAudioPlayer() !== null : resolvePlayer() !== null; }

  return { synthesizeSpeech, synthesizeAll, playLocally, playSequence, stopSpeaking, producesAudioFiles, canPlayAudioFiles };
}

module.exports = { createSpeaker, speakableText, siteName };
