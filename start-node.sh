#!/usr/bin/env bash
# start-node.sh
#
# Start it as  bash start-node.sh  rather than ./start-node.sh. The first line below relies on
# /usr/bin/env, which does not exist on Android. Termux usually redirects it on the fly, but a start
# through nohup from an SSH session failed with 'No such file or directory' although the file was
# there (measured 2026-09-14). Going through bash explicitly does not depend on any of that.
# Starts the agent node on a machine that is not Windows -- a Linux box, or a phone running
# Termux. The Windows equivalent is start-node.bat; this is deliberately a separate file rather
# than a clever cross-platform launcher, because the two have almost nothing in common.

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT" || exit 1

# Same convention as token.local.bat on Windows: local secrets, never in git, sourced if present.
[ -f "$ROOT/token.local.sh" ] && . "$ROOT/token.local.sh"

# Android suspends background processes hard once the screen goes off -- without this the agent
# simply stops answering a few minutes after you put the phone down. A harmless no-op anywhere
# else, since the command only exists under Termux.
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock

# No firewall step, unlike the .bat: Android has no per-app host firewall to open, and on a Linux
# node the firewall belongs to the distribution's tooling rather than to this script.

# Uses whatever node is on PATH. There is no bundled tools/node here -- that directory holds
# Windows binaries, and on Termux node comes from "pkg install nodejs".
# Exit code 75: the agent installed an update of itself and wants to be started again (updater.js).
export ALIVEAGENTS_RESTARTABLE=1
while true; do
  node node-agent.js
  code=$?
  [ "$code" -eq 75 ] || exit "$code"
done
