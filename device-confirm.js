// device-confirm.js
// A confirmation dialog of this device's operating system that states, in its own words, what is about to
// be allowed -- the one thing on screen an agent can neither reword nor answer.
//
// Why not the face page (user's requirement, 2026-09-15: agents may change nothing on the interface but
// their own face, so nobody is tricked into granting the wrong thing): an agent allowed to control the
// browser can run script on the page and swap two labels, and the user ticks "Search the web" while
// granting the command line. A passkey dialog would still pop up, but it shows no text, so it cannot catch
// that. So the page only says what the user wants, the agent's own process words what that changes
// (permissions.js, agent-bridge-server.js), and the dialog here shows exactly that text:
//
//   Windows  Windows Hello (face, fingerprint or PIN) through UserConsentVerifier, the text inside the
//            dialog. Parented to the window in front -- the browser the user just clicked in -- so it
//            comes up over it rather than behind; the plain call is the fallback.
//   Android  termux-fingerprint from Termux:API (already needed for the voice), the text as the prompt's
//            description.
//
// A device with neither has no confirmation, and whatever needs one is refused there.
//
// ALIVEAGENTS_CONFIRM_COMMAND swaps the dialog for a script, for the sandbox tests. It is read once at start
// and announced in the console. Only whoever starts this process can set it -- and an agent that could is
// already running commands on this device, which no protection in here can stop anyway.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TIMEOUT_MS = 150 * 1000;
const TERMUX_TIMEOUT_MS = 60 * 1000;
const COOLDOWN_MS = 8 * 1000; // after a no: a page cannot pester the user into a reflex yes
const TEXT_MAX = 600;

// By full path, so nothing earlier on PATH can stand in for it.
const WINDOWS_POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const TERMUX_FINGERPRINT = path.join(process.env.PREFIX || '/data/data/com.termux/files/usr', 'bin', 'termux-fingerprint');

// Windows PowerShell 5.1 is on every Windows, so there is nothing to build or ship. The C# part only exists
// for the parented dialog: IUserConsentVerifierInterop is a COM interface PowerShell cannot call itself.
// FD596FFD-... is the interface id of IAsyncOperation<UserConsentVerificationResult>, derived the WinRT way
// from its signature (checked 2026-09-15). The text travels in an environment variable, never on the
// command line, so nothing in it is ever parsed as code.
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$source = @'
using System;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Threading.Tasks;

public static class AliveAgentsHello {
  [DllImport("user32.dll")]
  static extern IntPtr GetForegroundWindow();

  [ComImport, Guid("39E050C3-4E74-441A-8DC0-B81104DF949C"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
  public interface IUserConsentVerifierInterop {
    [return: MarshalAs(UnmanagedType.IInspectable)]
    object RequestVerificationForWindowAsync(IntPtr appWindow, [MarshalAs(UnmanagedType.HString)] string message, [In] ref Guid riid);
  }

  static Type Ui(string name) {
    return Type.GetType("Windows.Security.Credentials.UI." + name + ", Windows.Security.Credentials.UI, ContentType=WindowsRuntime", true);
  }

  static string Await(Type extensions, object operation, Type resultType) {
    foreach (MethodInfo m in extensions.GetMethods()) {
      ParameterInfo[] p = m.GetParameters();
      if (m.Name != "AsTask" || !m.IsGenericMethodDefinition || m.GetGenericArguments().Length != 1 || p.Length != 1) continue;
      if (!p[0].ParameterType.Name.StartsWith("IAsyncOperation")) continue;
      Task task = (Task)m.MakeGenericMethod(resultType).Invoke(null, new object[] { operation });
      task.Wait();
      return task.GetType().GetProperty("Result").GetValue(task, null).ToString();
    }
    throw new InvalidOperationException("no AsTask for IAsyncOperation");
  }

  public static string Check(Type extensions) {
    object op = Ui("UserConsentVerifier").GetMethod("CheckAvailabilityAsync").Invoke(null, null);
    bool parented = WindowsRuntimeMarshal.GetActivationFactory(Ui("UserConsentVerifier")) is IUserConsentVerifierInterop;
    return Await(extensions, op, Ui("UserConsentVerifierAvailability")) + (parented ? " parented" : " unparented");
  }

  public static string Ask(Type extensions, string message) {
    object op = null;
    try {
      IUserConsentVerifierInterop interop = (IUserConsentVerifierInterop)WindowsRuntimeMarshal.GetActivationFactory(Ui("UserConsentVerifier"));
      Guid iid = new Guid("FD596FFD-2318-558F-9DBE-D21DF43764A5");
      op = interop.RequestVerificationForWindowAsync(GetForegroundWindow(), message, ref iid);
    } catch (Exception) {
      op = Ui("UserConsentVerifier").GetMethod("RequestVerificationAsync").Invoke(null, new object[] { message });
    }
    return Await(extensions, op, Ui("UserConsentVerificationResult"));
  }
}
'@
Add-Type -TypeDefinition $source
$extensions = [System.WindowsRuntimeSystemExtensions]
if ($env:ALIVEAGENTS_CONFIRM_MODE -eq 'check') {
  Write-Output ('availability:' + [AliveAgentsHello]::Check($extensions))
} else {
  Write-Output ('result:' + [AliveAgentsHello]::Ask($extensions, [string]$env:ALIVEAGENTS_CONFIRM_TEXT))
}
} catch {
  Write-Output ('error:' + $_.Exception.Message)
  exit 1
}
`;

const WINDOWS_PROBLEMS = {
  DeviceNotPresent: 'No Windows Hello device was found on this PC.',
  NotConfiguredForUser: 'Windows Hello is not set up for this Windows user (Settings > Accounts > Sign-in options).',
  DisabledByPolicy: 'Windows Hello is turned off by a policy on this PC.'
};
const WINDOWS_REFUSALS = {
  Canceled: 'Not confirmed.',
  RetriesExhausted: 'Windows Hello gave up after too many attempts.',
  DeviceBusy: 'Windows Hello is busy right now.',
  DeviceNotPresent: WINDOWS_PROBLEMS.DeviceNotPresent,
  NotConfiguredForUser: WINDOWS_PROBLEMS.NotConfiguredForUser,
  DisabledByPolicy: WINDOWS_PROBLEMS.DisabledByPolicy
};

// One line of plain text. Control characters, line breaks, and the invisible characters that reorder or
// hide text (bidirectional overrides, zero-width ones) go -- a responsibility an agent wrote is part of
// some dialogs, and it must not be able to make the dialog read differently than it is.
function cleanText(raw) {
  let out = '';
  for (const ch of String(raw == null ? '' : raw)) {
    const c = ch.codePointAt(0);
    const invisible = c < 32 || c === 127 || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e)
      || (c >= 0x2066 && c <= 0x2069) || c === 0xfeff;
    out += invisible ? ' ' : ch;
  }
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > TEXT_MAX ? `${out.slice(0, TEXT_MAX - 1)}…` : out;
}

function collect(child, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let finished = false;
    const finish = (extra) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(Object.assign({ out }, extra));
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) { /* already gone */ }
      finish({ timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) => finish({ error: e.message }));
    child.on('close', (code) => finish({ code }));
  });
}

function runWindows(mode, text, timeoutMs) {
  const child = spawn(WINDOWS_POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')], {
    env: Object.assign({}, process.env, { ALIVEAGENTS_CONFIRM_MODE: mode, ALIVEAGENTS_CONFIRM_TEXT: text }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  return collect(child, timeoutMs);
}

function firstLine(run) {
  return String(run.error || run.out || (run.timedOut ? 'timed out' : '')).trim().split(/\r?\n/).slice(-1)[0].slice(0, 200);
}

// log: where the console lines go. platform/env: for the tests.
function createConfirmer({ log = console.log, platform = process.platform, env = process.env } = {}) {
  const state = { kind: null, label: null, available: false, checked: false, problem: null };
  const testCommand = env.ALIVEAGENTS_CONFIRM_COMMAND || '';
  let busy = false;
  let quietUntil = 0;

  const ready = (async () => {
    if (testCommand) {
      Object.assign(state, { kind: 'test', label: 'the test confirmation', available: true });
      log(`[confirm] WARNING: confirmations are answered by ${testCommand}, not by this device's own dialog (ALIVEAGENTS_CONFIRM_COMMAND -- for tests only).`);
    } else if (platform === 'win32') {
      Object.assign(state, { kind: 'windows', label: 'Windows Hello' });
      const run = await runWindows('check', '', 60000);
      const m = /availability:(\w+)/.exec(run.out || '');
      if (!m) {
        state.problem = 'Windows Hello could not be reached from this program.';
        log(`[confirm] Checking Windows Hello failed: ${firstLine(run)}`);
      } else {
        state.problem = WINDOWS_PROBLEMS[m[1]] || null;
        state.available = !state.problem;
      }
    } else if (env.TERMUX_VERSION || platform === 'android') {
      Object.assign(state, { kind: 'termux', label: 'your fingerprint' });
      if (fs.existsSync(TERMUX_FINGERPRINT)) state.available = true;
      else state.problem = 'The fingerprint prompt is missing: install the Termux:API app, then "pkg install termux-api".';
    } else {
      state.problem = 'This device has no confirmation dialog this program can use.';
    }
    state.checked = true;
    log(state.available
      ? `[confirm] Changes from the face page are confirmed with ${state.label}.`
      : `[confirm] ${state.problem} Nothing that needs a confirmation can be done from the face page on this device.`);
  })();

  async function run(text) {
    if (state.kind === 'test') {
      const script = /\.js$/i.test(testCommand);
      const child = spawn(script ? process.execPath : testCommand, script ? [testCommand] : [], {
        env: Object.assign({}, process.env, { ALIVEAGENTS_CONFIRM_TEXT: text }), stdio: ['ignore', 'pipe', 'pipe']
      });
      const r = await collect(child, TIMEOUT_MS);
      return /^\s*yes\s*$/m.test(r.out) ? { ok: true } : { ok: false, reason: 'Not confirmed.' };
    }
    if (state.kind === 'windows') {
      const r = await runWindows('ask', text, TIMEOUT_MS);
      if (r.timedOut) return { ok: false, reason: 'The Windows Hello dialog was not answered in time.' };
      const m = /result:(\w+)/.exec(r.out || '');
      if (!m) {
        log(`[confirm] Windows Hello could not be asked: ${firstLine(r)}`);
        return { ok: false, reason: 'Windows Hello could not be asked.' };
      }
      if (m[1] === 'Verified') return { ok: true };
      return { ok: false, reason: WINDOWS_REFUSALS[m[1]] || `Windows Hello answered ${m[1]}.` };
    }
    if (state.kind === 'termux') {
      // Shorter than on Windows: a fingerprint takes seconds, and when the prompt cannot come up at all
      // the page should not sit waiting for minutes.
      const child = spawn(TERMUX_FINGERPRINT, ['-t', 'AliveAgents', '-d', text, '-c', 'Cancel'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const r = await collect(child, TERMUX_TIMEOUT_MS);
      let answer = null;
      try { answer = JSON.parse(r.out); } catch (e) { answer = null; }
      if (answer && answer.auth_result === 'AUTH_RESULT_SUCCESS') return { ok: true };
      if (answer && answer.auth_result) return { ok: false, reason: 'Not confirmed.' };
      // Seen on Android 14 (2026-09-15): the prompt hangs without ever appearing. Termux:API runs in the
      // background while the browser is in front, and Android lets a background app open a window over
      // another only with "display over other apps" granted.
      log(`[confirm] The fingerprint prompt did not come up or was not answered${r.timedOut ? ' in time' : ''}: ${firstLine(r) || 'no output'}. If it never appeared, allow Termux:API to display over other apps in Android's settings.`);
      return { ok: false, reason: 'The fingerprint prompt did not come up. In Android\'s settings, allow Termux:API to display over other apps, then try again.' };
    }
    return { ok: false, reason: state.problem || 'This device has no confirmation dialog.' };
  }

  // One dialog at a time; resolves { ok } or { ok: false, reason } -- a sentence the page can show.
  async function ask(rawText) {
    await ready;
    if (!state.available) return { ok: false, reason: state.problem || 'This device has no confirmation dialog.' };
    if (busy) return { ok: false, reason: 'Another confirmation is already open on this device.' };
    if (Date.now() < quietUntil) return { ok: false, reason: 'A confirmation was just turned down. Wait a few seconds before asking again.' };
    const text = cleanText(rawText);
    busy = true;
    try {
      const answer = await run(text);
      if (!answer.ok) quietUntil = Date.now() + COOLDOWN_MS;
      return answer;
    } catch (e) {
      quietUntil = Date.now() + COOLDOWN_MS;
      return { ok: false, reason: `The confirmation could not be shown: ${e.message}` };
    } finally {
      busy = false;
    }
  }

  return {
    ready,
    ask,
    state: () => ({ label: state.label, available: state.available, checked: state.checked, problem: state.problem })
  };
}

module.exports = { createConfirmer, cleanText, TIMEOUT_MS, COOLDOWN_MS };
