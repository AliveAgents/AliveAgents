// claude-cli.js
// Starting the Claude Code CLI for one turn, the same way on the hub and on every node.
//
// The message goes in on stdin, never on the command line. Windows allows a command line of at most
// 32,767 characters; a long pasted text made spawn throw ENAMETOOLONG, and because spawn throws that
// synchronously, nothing caught it and Nova's whole process ended (2026-09-22). stdin has no such limit,
// and a line break in it is simply a line break -- on the command line one once cut a message short, which
// is why messages used to be flattened into a single line.
//
// A spawn that throws anyway is handed back as an 'error' on the next tick, the way every other start
// failure already arrives, so each caller keeps its one error path and the process keeps running.

const { EventEmitter } = require('events');
const spawn = require('cross-spawn');

// Returns the child process (or a stand-in that only emits 'error'). stdout and stderr are piped as before.
function startClaude(exe, args, prompt, options = {}) {
  let child;
  try {
    child = spawn(exe, args, Object.assign({}, options, { stdio: ['pipe', 'pipe', 'pipe'] }));
  } catch (err) {
    const failed = new EventEmitter();
    failed.stdout = new EventEmitter();
    failed.stderr = new EventEmitter();
    failed.kill = () => {};
    process.nextTick(() => failed.emit('error', err));
    return failed;
  }
  // The CLI may exit before it has read everything -- not logged in, a bad flag. Writing to a pipe nobody
  // reads any more is then an error on stdin, and an unhandled one would end this process too.
  child.stdin.on('error', () => {});
  child.stdin.end(String(prompt == null ? '' : prompt));
  return child;
}

// The longest message passed on to an agent: about 40,000 tokens, which leaves the session room for its
// history. A longer pasted text is turned away with a sentence (user's wish, 2026-09-22) instead of failing
// somewhere further on -- in the model's context, or in a frame between two machines (agent-net.js caps
// those at 8 MB). A file has no such problem: the agent reads it with its own tools.
const MESSAGE_MAX_CHARS = 150000;

function tooLongSentence(length) {
  return `That message is too long: ${length.toLocaleString('en-US')} characters, and an agent takes ${MESSAGE_MAX_CHARS.toLocaleString('en-US')} at most. Send it as a file instead -- drop it on the agent's card -- and it can read it from there.`;
}

module.exports = { startClaude, MESSAGE_MAX_CHARS, tooLongSentence };
