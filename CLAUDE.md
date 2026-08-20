# CLAUDE.md

Context for any AI coding agent working in this repository. Read this before making changes.

## What this is

A small network of Claude Code CLI instances, each running headlessly on its own machine, each with its own voice (Piper TTS) and an animated face (a browser userscript overlay). One machine is the **hub** (currently the agent "Oscar"), any number of others are **nodes** (currently "Nova") connected to the hub over mutual-TLS. The hub takes microphone input, decides which agent should answer, and coordinates a shared "main display" agents can show visual content on.

## Repo map

| File | Role |
|---|---|
| `agent-bridge-server.js` | The hub process. Routing, follow-up chains, the display queue, everything Oscar-specific. Never synced to a node. |
| `node-agent.js` | Runs on every node. Connects to the hub, runs its own Claude Code sessions, speaks locally. |
| `agent-net.js` | The mutual-TLS transport shared by hub and nodes (length-prefixed JSON framing over TLS 1.3). |
| `followup-tag.js` | Shared: the `[FORWARD: Name]` / `[PRESENTATION: url]` marker regexes and the standing prompt text (`buildTagHint`) that teaches agents the convention. |
| `speech.js` | Piper synthesis + local playback. Fully language-agnostic — the spoken language is entirely determined by which voice model is loaded. |
| `overlay-server.js` | Local HTTP+WebSocket server each machine runs for its own browser overlay; also serves `faces/*.js` and `presented_content/*.html`. |
| `agent-face-overlay.user.js` | The Tampermonkey userscript: mic input, speech recognition, face rendering, presentation iframe. One file for every agent. |
| `faces/*.js` | Per-agent face definitions (SVG + CSS + mouth animation params). Never exposed to an agent's own write access — see the comment in `overlay-server.js`. |
| `net-config.example.json` | Template for a node's config. The hub's own `net-config.json` only needs `role`, `self`, and `peers`. |
| `make-certs.sh` | Generates a self-signed identity per machine. No shared CA — every side pins the other's exact certificate fingerprint. |

## Setting up a dev environment

1. Node.js and the Claude Code CLI (`claude setup-token`) installed and on `PATH`.
2. `npm install`.
3. `sh make-certs.sh` (hub) / `sh make-certs.sh <name>` (each additional node), then exchange the `*-cert.pem` files between machines — never the `*-key.pem` files.
4. Copy `net-config.example.json` → `net-config.json` per node and fill it in; the hub's own `net-config.json` is much smaller (see table above).
5. Copy `token.local.bat.example` → `token.local.bat` with a real token. Anything matching `*.local.*` is gitignored — never remove that from `.gitignore`, never commit a real one.
6. A Piper voice model per agent in `tools/piper/voices/`.
7. `start.bat` (hub) / `start-node.bat` (node).

## Conventions this project expects

- **English only, everywhere** — code, comments, console output, prompt text. This was a deliberate full-project migration; don't reintroduce another language into new code.
- **Comments explain *why*, not *what*.** This codebase has a lot of comments documenting non-obvious reasoning and hard-won bugs (dates included where relevant) — match that style, don't add comments that just restate the code.
- **No speculative abstraction.** Small, direct functions; duplication between `agent-bridge-server.js` and `node-agent.js` where their logic is genuinely parallel is intentional, not something to force into a shared module.
- **Deterministic triggers over model judgment, when a cheap reliable signal exists** — e.g. name-matching for routing. Model judgment is preferred specifically where no reliable pattern exists (see the extensive comment in `followup-tag.js` about why there's no regex trigger for "should I present something").

## Things that will bite you if you don't know them

- **On Windows, never `spawn('claude', ...)` directly.** `claude` resolves to a `.cmd` shim, and spawning a `.cmd` file forces the whole command line through `cmd.exe`, which re-parses every argument with its own metacharacter rules — a reply containing both a `"` and an `&` will silently corrupt the call. Both `agent-bridge-server.js` and `node-agent.js` define a `CLAUDE_EXE` constant that resolves the bundled `claude.exe` directly; reuse it, don't spawn `'claude'` as a bare string.
- **A node's identity (certs, `self`/`hubName` in `net-config.json`) is separate from its spoken agent name.** Renaming an agent (e.g. Oscar/Nova) never requires new certificates — those are lowercase, machine-level identifiers (`thorsten`, `node2`) kept deliberately independent of the capitalized display name.
- **`PRESENTATION_TAG_RE` is intentionally not end-anchored.** Models occasionally add a trailing remark after the marker; the regex tolerates text on both sides and stitches it back into the spoken reply.
- **Routing/display state is tracked per target, not globally** (`activeRequestByTarget`, `busyTargets`, `displayQueue` in `agent-bridge-server.js`). A new request to one agent must never invalidate another agent's independent, still-running work — that was a real, previously-shipped bug.

## Verifying a change

There's no test suite — verification in this project means real, live behavior:
- `node --check <file>` after every edit, on every machine the file gets deployed to.
- For anything touching the marker regexes or routing logic, a throwaway Node script that connects fake nodes via `agent-net.js`'s `connectToHub()` and hand-crafts protocol messages is the fastest way to test hub logic with zero real API cost. Delete it when you're done.
- For anything touching what an agent actually says or decides, a short real `claude -p` call is worth the tokens — simulating both sides has hidden real bugs in this project before.
