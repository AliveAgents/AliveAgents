// claude-login.js
// Signing an agent's Claude Code back in from its own face page, instead of from a terminal.
//
// Why this exists: an expired login makes an agent fail every single turn while looking perfectly
// healthy from outside -- Steve spent an afternoon in exactly that state (2026-11-07). Fixing it meant
// an SSH session into a phone and a login flow typed into Termux, which is the opposite of what this
// project is for. The page can do it: the CLI prints a sign-in address and then waits for the code
// that the browser hands back, so the page shows the address, takes the code, and passes it on.
//
// The one mechanical obstacle: "claude setup-token" wants a terminal. Without one it prints nothing and
// exits (measured on a phone, 2026-11-07). "script" -- part of Termux's and every Linux's util-linux --
// gives it one, which is why the flow runs through it. Windows has no equivalent, so there the page says
// what to type in the agent's own window rather than pretending.
//
// Why this needs no confirmation dialog, unlike permissions: logging in grants the agent nothing it did
// not have yesterday, and it cannot be completed here anyway -- whoever finishes it does so in a browser,
// signed into the Claude account. An agent cannot sign itself in; it can at most make a sign-in page
// appear on a screen its user is standing at.

const fs = require('fs');
const path = require('path');
// cross-spawn, like everywhere else in this project: Node's own spawn refuses a .cmd outright on
// Windows (EINVAL), which is what the test stand-in is.
const spawn = require('cross-spawn');

const PAGE_MESSAGE_TYPES = ['login-get', 'login-start', 'login-code'];
// Long enough to find the phone, open the page, sign in and copy the code back; short enough that a
// forgotten attempt does not sit around forever.
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;
// How long "Checking the code…" may stand before the page is told that nothing is coming back.
const STALL_MS = 25 * 1000;
// A sign-in cannot be completed by anything on this machine -- it ends in a browser, in the user's
// own Claude account. What a page CAN do is start one over and over, so it is rate-limited: an agent
// that drives the browser must not be able to paper the screen with sign-in bars.
const START_COOLDOWN_MS = 20 * 1000;
// The pause between the pasted code and the Enter that submits it -- see submitCode.
const ENTER_DELAY_MS = 400;
// A real token is around 110 characters; anything much shorter has been cut off (see onOutput).
const TOKEN_MIN_CHARS = 80;
const URL_MAX = 2000;
// Only the real sign-in pages. The address comes out of a program on this machine, not off the network,
// but it ends up on a page the user is asked to trust -- so it is checked rather than relayed blindly.
const URL_ALLOWED = /^https:\/\/(claude\.com|claude\.ai|console\.anthropic\.com|platform\.claude\.com)\//;

// Terminal escape sequences, including the OSC-8 hyperlinks the CLI wraps its URL in. Without this the
// address arrives decorated with cursor jumps and is neither readable nor clickable.
// Each sequence becomes a SPACE, not nothing: the CLI lays its text out with cursor-positioning codes
// instead of spaces, so dropping them glues the words together -- and an address that runs straight
// into "Pastecodehereifprompted" is no longer an address (caught by the test, not by reading).
function stripAnsi(text) {
  return String(text)
    .replace(/\u001b\]8;[^\u0007\u001b]*(\u0007|\u001b\\)/g, ' ')
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, ' ')
    .replace(/\u001b[@-Z\\-_]/g, ' ')
    .replace(/\u0007/g, ' ');
}

// The address is printed as a terminal hyperlink, and that is the only place it survives whole: the
// TARGET of the hyperlink carries the full URL, while the visible text next to it is chopped into
// line-width pieces. Read the visible text and you get the first piece -- a URL that looks perfectly
// fine and is missing half its parameters. On a real phone that produced "invalid OAuth request,
// missing redirect_uri" (2026-11-07), after a test with a hand-made sample had happily passed.
// So: hyperlink targets first, visible text only as a fallback, longest candidate wins.
function hyperlinkTargets(text) {
  return [...String(text).matchAll(/\u001b\]8;[^;\u0007\u001b]*;([^\u0007\u001b]+)(?:\u0007|\u001b\\)/g)].map((m) => m[1]);
}

function findUrl(text) {
  const plain = stripAnsi(text).match(/https:\/\/[^\s"'<>\u0007]+/g) || [];
  let best = '';
  for (const candidate of hyperlinkTargets(text).concat(plain)) {
    if (!URL_ALLOWED.test(candidate) || candidate.length > URL_MAX) continue;
    if (candidate.length > best.length) best = candidate;
  }
  return best;
}

function createLogin({ log = console.log, platform = process.platform, env = process.env, onChange = () => {} } = {}) {
  const scriptExe = path.join(env.PREFIX || '/data/data/com.termux/files/usr', 'bin', 'script');
  const available = platform !== 'win32' && (fs.existsSync(scriptExe) || fs.existsSync('/usr/bin/script'));
  const scriptPath = fs.existsSync(scriptExe) ? scriptExe : '/usr/bin/script';
  // The test hook mirrors ALIVEAGENTS_CONFIRM_COMMAND in device-confirm.js: only whoever starts this
  // process can set it, and that is already the machine's owner.
  const command = env.ALIVEAGENTS_LOGIN_COMMAND || '';

  let state = { needed: false, status: 'idle', url: '', message: '' };
  let child = null;
  let timer = null;
  let watcher = null;
  let submittedAt = 0;
  let quietUntil = 0;
  let tokenTaken = false;
  let buffer = '';

  // Where the CLI keeps the token it just obtained. Watching this file is how success is recognised
  // without relying on a particular sentence: the command may well stay open after it has written it.
  // Missing or unreadable simply means this signal is unavailable, never that something failed.
  const credentialsFile = path.join(env.HOME || require('os').homedir(), '.claude', '.credentials.json');
  const credentialsStamp = () => {
    try { return fs.statSync(credentialsFile).mtimeMs; } catch (e) { return 0; }
  };
  let stampBefore = 0;

  const publicState = () => ({
    needed: state.needed, status: state.status, url: state.url, message: state.message,
    available: available || !!command
  });
  const set = (next) => { state = Object.assign({}, state, next); try { onChange(publicState()); } catch (e) {} };

  // Called by the agent when a turn failed on authentication, and again when one succeeds.
  function setNeeded(needed) {
    if (state.needed === needed) return;
    set({ needed, status: needed ? state.status : 'idle', url: needed ? state.url : '', message: '' });
  }

  function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (watcher) { clearInterval(watcher); watcher = null; }
    if (child) { try { child.kill(); } catch (e) {} child = null; }
  }

  // The same place the start scripts already look for local secrets (token.local.sh / .bat, both
  // kept out of git). Only the token line is replaced, so anything else in there survives.
  function storeToken(token) {
    const file = path.join(__dirname, platform === 'win32' ? 'token.local.bat' : 'token.local.sh');
    let keep = '';
    try { keep = fs.readFileSync(file, 'utf8'); } catch (e) { /* the first one */ }
    const line = platform === 'win32'
      ? `set "CLAUDE_CODE_OAUTH_TOKEN=${token}"`
      : `export CLAUDE_CODE_OAUTH_TOKEN="${token}"`;
    const without = keep.split(/\r?\n/).filter((l) => !/CLAUDE_CODE_OAUTH_TOKEN/.test(l)).join('\n').trim();
    fs.writeFileSync(file, `${without ? without + '\n' : ''}${line}\n`, { mode: 0o600 });
  }

  function succeeded() {
    stop();
    set({ status: 'done', needed: false, url: '', message: 'Signed in. The next question should work again.' });
  }

  // What the sign-in last had to say, for when it neither succeeds nor complains in a way this
  // module recognises. Written next to the program rather than only logged, so it can be read
  // afterwards from anywhere. The pasted code is NOT in here: the prompt masks it as asterisks.
  // Anything that looks like a key never reaches a file, a log or the page. "setup-token" PRINTS the
  // token it creates, so the raw output is a secret -- on 2026-11-07 a successful sign-in put a
  // year-long token into the diagnostic file in clear text, which is how this rule came to exist.
  function redact(text) {
    return String(text).replace(/sk-ant-[A-Za-z0-9_\-]{10,}/g, 'sk-ant-[removed]');
  }

  function keepTranscript() {
    try {
      const text = redact(stripAnsi(buffer))
        // Query strings go: the sign-in address carries the one-time state and challenge, and a
        // diagnostic file is no place for them even though they expire.
        .replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, '$1?…')
        .replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
      fs.writeFileSync(path.join(__dirname, '.login-last.log'), `${new Date().toISOString()}\n${text.slice(-2000)}\n`, { mode: 0o600 });
    } catch (e) { /* nothing to be done about it here */ }
  }

  // Neither finished nor failed after this long: say what it is waiting on instead of showing
  // "Checking the code…" indefinitely, which is what a stuck attempt looked like from the page.
  function checkStalled() {
    if (state.status !== 'submitted' || !submittedAt) return;
    if (Date.now() - submittedAt < STALL_MS) return;
    keepTranscript();
    const tail = stripAnsi(buffer).split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
    log(`[login] no answer ${Math.round(STALL_MS / 1000)}s after the code went in. Last line: ${tail.slice(0, 200)}`);
    set({ status: 'waiting', message: `The sign-in has not answered since the code went in${tail ? ` -- it last said: "${tail.slice(0, 120)}"` : ''}. Try the code again, or start over.` });
    submittedAt = 0;
  }

  function start() {
    if (!available && !command) {
      return { error: platform === 'win32'
        ? 'This machine has no way to run the sign-in from here. Type "claude" in its own window and sign in there.'
        : 'This machine is missing the "script" command, which the sign-in needs. Install it (pkg install util-linux) and try again.' };
    }
    // A flow that is already running gets replaced, not reused. Handing back the old one looks
    // helpful and is the opposite: its address belongs to an exchange the user has already walked
    // away from, and pressing "Sign in" after something went wrong is exactly the moment they want
    // to start over (2026-11-07: a stuck attempt could not be got rid of).
    if (Date.now() < quietUntil) return { error: 'A sign-in was just started. Give it a moment before starting another.' };
    if (child) { log('[login] starting over -- the previous attempt is dropped'); stop(); }
    quietUntil = Date.now() + START_COOLDOWN_MS;
    buffer = '';
    tokenTaken = false;
    stampBefore = credentialsStamp();
    set({ status: 'starting', url: '', message: '' });
    try {
      child = command
        ? spawn(command, [], { env })
        // A wide terminal, because the token is what has to come out of here in one piece. At the
        // default 80 columns the sign-in wraps it across lines, and a token read from the first line
        // is 79 characters of a 108-character key: it stores, it looks right, and the API answers
        // "OAuth access token is invalid" (2026-11-07). Measured: at 400 columns a 346-character
        // string arrives unbroken.
        : spawn(scriptPath, ['-qec', 'stty cols 400; claude setup-token', '/dev/null'], { env });
    } catch (e) {
      child = null;
      set({ status: 'failed', message: `The sign-in could not be started: ${e.message}` });
      return { error: state.message };
    }
    child.stdout.on('data', onOutput);
    if (child.stderr) child.stderr.on('data', onOutput);
    child.on('error', (e) => {
      child = null;
      set({ status: 'failed', message: `The sign-in could not be started: ${e.message}` });
    });
    child.on('close', () => {
      child = null;
      if (timer) { clearTimeout(timer); timer = null; }
      if (state.status === 'submitted') {
        // Success has to be PROVEN, never assumed from a quiet ending. Assuming it once reported
        // "Signed in" for a sign-in that had simply been killed (2026-11-07) -- the worst kind of
        // wrong answer, because it sends the user away satisfied while nothing works.
        if (credentialsStamp() && credentialsStamp() !== stampBefore) { succeeded(); return; }
        if (/login successful|successfully (logged|signed) in|token (saved|stored)/i.test(stripAnsi(buffer))) { succeeded(); return; }
        keepTranscript();
        set({ status: 'failed', message: 'The sign-in ended without signing in. Start it again and use a fresh code.' });
        return;
      }
      if (state.status === 'waiting' || state.status === 'starting') {
        set({ status: 'idle', url: '', message: 'The sign-in stopped before a code arrived.' });
      }
    });
    timer = setTimeout(() => {
      log('[login] the sign-in attempt timed out');
      stop();
      set({ status: 'idle', url: '', message: 'The sign-in took too long and was stopped. You can start it again.' });
    }, FLOW_TIMEOUT_MS);
    // The token file is the proof, not a sentence in the output: the command may keep running after
    // it has written one, and then nothing would ever tell the page that it worked.
    watcher = setInterval(() => {
      if (state.status !== 'submitted') return;
      const now = credentialsStamp();
      if (now && now !== stampBefore) { log('[login] signed in'); succeeded(); return; }
      checkStalled();
    }, 2000);
    return { ok: true, login: publicState() };
  }

  function onOutput(chunk) {
    buffer += chunk.toString();
    if (buffer.length > 60000) buffer = buffer.slice(-20000);

    // What "setup-token" actually does: it does NOT store anything. It prints a token and expects it
    // in the environment ("export CLAUDE_CODE_OAUTH_TOKEN=..."), which is why a successful sign-in
    // left the agent exactly as signed out as before (2026-11-07). So the token is taken from here,
    // put into this process -- the next turn is authenticated immediately -- and written to the file
    // the start scripts already read, so a restart keeps it.
    if (!tokenTaken) {
      const found = stripAnsi(buffer).match(/sk-ant-[A-Za-z0-9_\-]{20,}/);
      if (found) {
        tokenTaken = true;
        const token = found[0];
        buffer = redact(buffer);
        // A token that arrives short is a token that was cut in half somewhere. Storing it is worse
        // than failing: everything reports success and every turn afterwards fails on a 401.
        if (token.length < TOKEN_MIN_CHARS) {
          log(`[login] the token came through incomplete (${token.length} characters) -- not stored`);
          stop();
          set({ status: 'failed', needed: true, url: '', message: 'The sign-in worked, but its token did not come through in one piece, so it was not kept. Start the sign-in again.' });
          return;
        }
        try {
          env.CLAUDE_CODE_OAUTH_TOKEN = token;
          if (env !== process.env) process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
          storeToken(token);
          log('[login] a new token is in place (kept in token.local.sh on this machine only)');
          succeeded();
        } catch (e) {
          log(`[login] the new token could not be stored: ${e.message}`);
          set({ status: 'failed', message: `Signed in, but the token could not be stored here: ${e.message}` });
        }
        return;
      }
    }

    // A rejected code is answered in the terminal interface and nowhere else: "OAuth error: Invalid
    // code ... Press Enter to retry." The command stays open, so waiting for it to exit would be
    // waiting forever. Enter is pressed here, which puts the same prompt back up with the same
    // address still valid, and the page is told to let the user try again.
    if (state.status === 'submitted' && /oauth error|invalid code|expired code/i.test(stripAnsi(buffer).slice(-800))) {
      // The sign-in's own words go through to the page. Replacing them with a friendly sentence of
      // my own hid the one piece of information worth having (2026-11-07: a code was rejected over
      // and over and the page never said why).
      const said = (stripAnsi(buffer).match(/(OAuth error[^\n]{0,160})/i) || [])[1] || '';
      keepTranscript();
      buffer = '';
      try { if (child) child.stdin.write('\r'); } catch (e) { /* it may have gone */ }
      set({
        status: 'waiting',
        // A code is good for one attempt: a second try needs the address opened again.
        message: `${said ? said.trim() + ' ' : ''}Open the address again -- each code works only once -- and paste the new one.`
      });
      return;
    }
    if (state.status !== 'starting' && state.status !== 'waiting') return;
    const url = findUrl(buffer);
    if (url && url !== state.url) {
      // The message is deliberately NOT cleared here. A rejected code makes the sign-in draw a
      // FRESH address, and clearing the message at that moment wiped the explanation a second after
      // it appeared -- leaving the page showing the instructions and a link again, with no hint
      // that anything had gone wrong (which is exactly how it looked to the user, 2026-11-07).
      set({ status: 'waiting', url, message: state.message ? `${state.message} (The address below is a new one.)` : '' });
    }
  }

  // The code the user copied out of the browser. Never logged: it is a one-time credential.
  //
  // It ends with a CARRIAGE RETURN, not a newline. The prompt waiting for it is a terminal interface,
  // and a terminal's Enter key is \r -- send \n and the characters arrive (they even appear as
  // asterisks) while nothing ever submits them. That is what left the page at "Checking the code…"
  // for good on a phone, 2026-11-07; with \r the same prompt answered within a second.
  function submitCode(raw) {
    const code = String(raw || '').trim();
    if (!child) return { error: 'The sign-in is not running. Start it again.' };
    if (!code) return { error: 'No code arrived.' };
    if (code.length > 400 || /[\r\n]/.test(code)) return { error: 'That does not look like the code from the browser.' };
    // The address and the code sit next to each other on that page, and the address is the easier
    // thing to copy by accident.
    if (/^https?:\/\//i.test(code)) return { error: 'That is the address, not the code. Open it, sign in, and copy the code it shows you afterwards.' };
    // The Enter goes in SEPARATELY, a moment after the code. The prompt treats a large chunk of
    // characters as pasted text, and a carriage return inside a paste counts as a character, not as
    // Enter -- so a long code typed in one go sits in the field for ever and nothing happens.
    // Measured on a phone, 2026-11-07: 92 characters plus \r in one write got no answer at all,
    // the same 92 characters with the \r 400 ms later were answered within a second.
    try {
      child.stdin.write(code);
      const pending = child;
      setTimeout(() => { try { if (pending === child && child) child.stdin.write('\r'); } catch (e) { /* gone meanwhile */ } }, ENTER_DELAY_MS);
    } catch (e) {
      return { error: `The code could not be handed over: ${e.message}` };
    }
    submittedAt = Date.now() + ENTER_DELAY_MS;
    set({ status: 'submitted', message: 'Checking the code…' });
    return { ok: true, login: publicState() };
  }

  function handlePageMessage(msg, reply) {
    if (msg.type === 'login-get') { reply({ login: publicState() }); return; }
    if (msg.type === 'login-start') { reply(start()); return; }
    if (msg.type === 'login-code') { reply(submitCode(msg.code)); return; }
  }

  return { publicState, setNeeded, start, submitCode, handlePageMessage, stop, PAGE_MESSAGE_TYPES };
}

module.exports = { createLogin, PAGE_MESSAGE_TYPES, findUrl, stripAnsi, hyperlinkTargets, FLOW_TIMEOUT_MS };
