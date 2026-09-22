#!/usr/bin/env bash
# setup-termux.sh
# Prepares an Android phone running Termux to host an agent. Run it once, inside a clone of this
# repository, before enrolling the phone into a network:
#
#   pkg install git && git clone <this repo> && cd AliveAgents && bash setup-termux.sh
#
# Idempotent: everything is checked before it is done, so running it again on a prepared phone
# changes nothing and simply confirms the state. No root required at any point.

set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
GLIBC="${PREFIX:-/data/data/com.termux/files/usr}/glibc"
NATIVE="$HOME/claude-native/claude"
WRAPPER="${PREFIX:-/data/data/com.termux/files/usr}/bin/claude"

step() { printf '\n== %s\n' "$1"; }
ok()   { printf '   ok    %s\n' "$1"; }
info() { printf '   ..    %s\n' "$1"; }
die()  { printf '\n   FAILED: %s\n\n' "$1" >&2; exit 1; }

[ -n "${PREFIX:-}" ] || die "PREFIX is not set -- this script is for Termux on Android, nothing else."
[ "$(uname -m)" = "aarch64" ] || die "This phone reports $(uname -m); only aarch64 is supported."

step "Keeping the phone awake"
# Android suspends background processes once the screen goes off, which silently kills an agent a
# few minutes after you put the phone down. Also switch off battery optimisation for Termux in
# Android's settings -- the wake lock alone does not survive every vendor's power manager.
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock && ok "wake lock held" || info "termux-wake-lock not there yet, installed below"

step "Base packages"
# Deliberately NOT ffmpeg. It pulls a large graphics stack that, on a phone whose package set has
# drifted, fails to link and leaves dpkg half-configured -- which then blocks every later install.
# Nothing here needs it: on Android speech goes through the phone's own TTS, not through Piper.
for p in nodejs openssl-tool termux-api; do
  if dpkg -s "$p" >/dev/null 2>&1; then
    ok "$p already installed"
  else
    info "installing $p"
    pkg install -y "$p" >/dev/null 2>&1 || die "could not install $p (try: pkg upgrade, then run this again)"
    ok "$p installed"
  fi
done
command -v node >/dev/null 2>&1 || die "node is still not on PATH"
ok "node $(node -v), npm $(npm -v), $(openssl version)"

step "Audio player for presentations"
# Optional. When this phone is the main display, other agents’ presentations arrive as their own
# recorded voice, and termux-tts-speak can only speak text, not play a file. play-audio can, and it
# waits until the file has finished -- which is what keeps the slides in step with the narration.
# Without it the phone still shows those presentations, narrated in its own TTS voice instead.
if command -v play-audio >/dev/null 2>&1; then
  ok "play-audio already installed"
elif pkg install -y play-audio >/dev/null 2>&1; then
  ok "play-audio installed"
else
  info "play-audio could not be installed -- presentations from other agents will use the phone TTS voice"
fi

step "glibc runtime"
# Anthropic publishes no Android build of Claude Code: the installer maps platform "android" to
# @anthropic-ai/claude-code-linux-arm64-android, which does not exist on npm. The musl build is no
# use either -- it wants /lib/ld-musl-aarch64.so.1, and /lib cannot be written without root. What
# works is the ordinary glibc arm64 build plus Termux's glibc runtime, which is what this pulls in.
if [ -f "$GLIBC/lib/ld-linux-aarch64.so.1" ]; then
  ok "glibc runtime already present"
else
  dpkg -s glibc-repo >/dev/null 2>&1 || { info "adding glibc repository"; pkg install -y glibc-repo >/dev/null 2>&1 || die "could not add glibc-repo"; }
  info "updating package lists"
  apt-get update >/dev/null 2>&1
  info "installing glibc-runner (a few hundred MB, be patient)"
  pkg install -y glibc-runner >/dev/null 2>&1 || die "could not install glibc-runner"
  [ -f "$GLIBC/lib/ld-linux-aarch64.so.1" ] || die "glibc installed but the loader is missing at $GLIBC/lib"
  ok "glibc runtime installed"
fi

step "Claude Code binary"
if [ -x "$NATIVE" ]; then
  ok "already at $NATIVE"
else
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/claude-fetch.XXXXXX")" || die "could not create a temp directory"
  info "downloading the glibc arm64 build (~220 MB)"
  ( cd "$WORK" && npm pack @anthropic-ai/claude-code-linux-arm64 >/dev/null 2>&1 ) || { rm -rf "$WORK"; die "npm pack failed -- is the phone online?"; }
  ( cd "$WORK" && tar xzf ./*.tgz ) || { rm -rf "$WORK"; die "could not unpack the download"; }
  [ -f "$WORK/package/claude" ] || { rm -rf "$WORK"; die "the package did not contain a claude binary"; }
  mkdir -p "$(dirname "$NATIVE")"
  cp "$WORK/package/claude" "$NATIVE" || { rm -rf "$WORK"; die "could not copy the binary to $NATIVE"; }
  chmod +x "$NATIVE"
  rm -rf "$WORK"
  ok "installed to $NATIVE"
fi

step "claude launcher"
# Termux ships glibc-runner's own "grun" for exactly this job, and it cannot be used here:
# glibc-runner 2.0 runs  source .../glibc-runner.sh $@  with an UNQUOTED $@, so every argument is
# re-split on whitespace. An agent hands the model one long -p argument, which then arrives as its
# first word alone -- measured: "What is 17 plus 25?" came back as "your message got cut off"
# through grun and as "42" through this launcher. So the two things grun does that actually matter
# are done directly below.
#
# LD_PRELOAD is passed per command via env and deliberately NOT exported: exported, it leaks into
# every bionic child process in the same shell and breaks them, down to a plain "tail" dying with
# 'library "libc.so.6" not found'.
cat > "$WRAPPER" <<'WRAPEOF'
#!/data/data/com.termux/files/usr/bin/bash
# Generated by setup-termux.sh -- see the comments there for why this does not call grun.
GLIBC="${PREFIX:-/data/data/com.termux/files/usr}/glibc"
exec env LD_PRELOAD="$GLIBC/lib/libtermux-exec.so" \
  "$GLIBC/lib/ld-linux-aarch64.so.1" --library-path "$GLIBC/lib" \
  "$HOME/claude-native/claude" "$@"
WRAPEOF
chmod +x "$WRAPPER" || die "could not write $WRAPPER"
ok "written to $WRAPPER"

step "Verifying the launcher passes arguments intact"
# The one failure this whole file exists to prevent, checked rather than assumed: a launcher that
# starts fine but drops everything after the first space looks perfectly healthy to --version.
VER="$("$WRAPPER" --version < /dev/null 2>&1 | tail -1)" || true
case "$VER" in
  *"Claude Code"*) ok "claude reports: $VER" ;;
  *) die "claude did not start: $VER" ;;
esac
PROBE="$("$WRAPPER" -p 'Reply with exactly the word ARGUMENTS-INTACT and nothing else.' < /dev/null 2>&1 | tail -1)" || true
case "$PROBE" in
  *ARGUMENTS-INTACT*) ok "multi-word prompts arrive whole" ;;
  *"not logged in"*|*"Not logged in"*|*"/login"*)
    info "not logged in yet, so the argument check could not run"
    info "run 'claude' once, log in, then run this script again to confirm" ;;
  *) die "the prompt did not arrive intact -- got: $PROBE" ;;
esac

step "Project dependencies"
( cd "$ROOT" && npm install >/dev/null 2>&1 ) || die "npm install failed in $ROOT"
ok "installed"

step "Done"
cat <<'NEXTEOF'
   This phone can now host an agent. What is left:

     1. If you have not already:  claude        (then log in)
     2. On the hub, open a pairing window:      /provision <name>
     3. Here, join the network:                 node enroll.js <hub-ip> <code> <name>
     4. Start the agent:                        bash start-node.sh
     5. Its face:                               http://localhost:8787/ in the phone browser

   Speech uses the phone's own TTS engine, so no voice model is needed. It does need the
   Termux:API app installed alongside the termux-api package -- from F-Droid, same source as
   Termux itself.

NEXTEOF
