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
| `followup-tag.js` | Shared: the `[FORWARD: Name]` / `[PRESENTATION: url]` / `[SLIDE]` marker regexes and the standing prompt text (`buildTagHint`) that teaches agents the convention. |
| `deck-runtime.js` / `.css` | The slide engine for multi-slide presentations, served by every overlay server at `/deck.js` and `/deck.css`. Runs inside the presentation iframe (sandboxed), not in the overlay's privileged context. |
| `.claude/skills/presentation/` | The skill an agent pulls in on its own when it decides an answer warrants a deck rather than a single page. |
| `speech.js` | Piper synthesis + local playback. Fully language-agnostic — the spoken language is entirely determined by which voice model is loaded. |
| `overlay-server.js` | Local HTTP+WebSocket server each machine runs for its own browser overlay; also serves `faces/*.js` and `presented_content/*.html`. |
| `agent-face-overlay.user.js` | The Tampermonkey userscript: mic input, speech recognition, face rendering, presentation iframe. One file for every agent. |
| `faces/*.js` | Per-agent face definitions (SVG + CSS + mouth animation params). Never exposed to an agent's own write access — see the comment in `overlay-server.js`. |
| `net-config.example.json` | Template for a node's config. The hub's own `net-config.json` only needs `role`, `self`, and `peers`. |
| `make-certs.sh` | Generates a self-signed identity per machine. No shared CA — every side pins the other's exact certificate fingerprint. Still used for the hub's own identity; new nodes generate theirs during enrollment instead. |
| `enrollment.js` | Pairing-code enrollment: code generation, the scrypt+HMAC proof, and both ends of the short-lived enrollment channel. Read its header before touching the proof. |
| `inbox.js` | Files handed to one agent: chunked transfer over the mTLS link, and the `inbox/` listing each agent gets in its prompt. |
| `files-page.html` | The drop UI at `http://localhost:8787/files`, hub machine only. |
| `enroll.js` / `enroll.bat` | Run on a NEW machine to join the network. Generates that machine's key pair locally — no private key ever travels. |
| `.claude/skills/new-agent/` | The skill Oscar loads when asked to set up a new agent: what to ask, and the `[PROVISION: {...}]` marker. |

## Setting up a dev environment

1. Node.js and the Claude Code CLI (`claude setup-token`) installed and on `PATH`.
2. `npm install`.
3. `sh make-certs.sh` for the hub's own identity. Additional nodes no longer need this, nor any manual certificate copying: ask Oscar to set up a new agent (or run `/provision <name>` on the hub console) and run `enroll.bat <hub-ip> <code> <name>` on the new machine.
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
- **Marker regexes tolerate the markdown a model wraps around them.** `SLIDE_TAG_RE` eats optional backticks/asterisks/underscores on both sides — found live on the first real test, where the model copied the code-formatted `` `[SLIDE]` `` from the skill's own example and left stray backticks in the text handed to Piper. Anything leftover next to a marker gets spoken out loud, so match what models actually emit, not just the documented ideal.
- **A multi-slide presentation is one WAV per slide, not one per reply.** `splitSlideSegments` cuts the spoken text on `[SLIDE]`, `speaker.synthesizeAll` renders each segment separately, and `speaker.playSequence` advances the deck in the pause between them. The single-slide case is simply the one-element array — there is deliberately no separate code path for it, in either `agent-bridge-server.js` or `node-agent.js`.
- **`speaker.stopSpeaking()` bumps a generation counter, not just a kill.** Killing the player fires the same `close` event as a segment ending normally, so without that counter an interrupted presentation would carry on to the next slide. Anything added to `playSequence` has to keep respecting it.
- **`present`/`present-request` messages carry `segments[]`, with `audioBase64` kept only for the single-slide case.** That is on purpose: it costs nothing there and lets a machine running an older copy of the project still show a working single-slide presentation. Both sides normalize via their own copy of `normalizePresentSegments`.
- **`workDir` changes where an agent's Claude session runs, and three things follow from it** (all verified live 2026-08-25): the project's own `CLAUDE.md` is read automatically, Claude Code scopes its memory per project path, and **file access is confined to that directory**. An absolute path in `--allowedTools` grants nothing on its own outside the working directory — only `--add-dir` opens a second root, which is why the AliveAgents folder is added explicitly whenever `workDir` differs. Resumed sessions survive the switch.
- **`inbox/` is deliberately NOT under `presented_content/`.** That folder is served over plain HTTP to every machine on the LAN (`serveContent`), which is right for a slide deck and wrong for a photo handed to one agent. `inbox/` is never served; the agent gets `Edit(inbox/**)` so it can still move or tidy what it was given.
- **Uploads are refused from anywhere but localhost.** The HTTP server listens on all interfaces because other machines fetch `/content/` from it, so without `isLocalRequest` anyone on the WiFi could write files into any agent's inbox.
- **The inbox line is rebuilt from the folder on every turn, not tracked as a pending list.** If the agent moved or deleted a file last turn, a stale list would have it reasoning about something that is no longer there.
- **Provisioning deliberately gives Oscar no new permissions.** Oscar names an intent via `[PROVISION: {...}]`; the hub performs it. Do not "simplify" this by granting Oscar shell or write access -- that would reopen the gap closed on 2026-08-17, on the one agent that listens to the microphone.
- **The enrollment channel is intentionally unauthenticated at the TLS layer** (`rejectUnauthorized: false`, `requestCert: false`). That is not an oversight: neither side has anything to validate against yet. Authentication comes entirely from the code-derived proof, which covers BOTH certificate fingerprints -- remove either fingerprint from the proof and a man in the middle can simply relay it.
- **The pairing code is bound to one name** (`expectedName`). Without that, a valid code could enroll any name, including one that overwrites an existing peer's certificate.
- **`hub.addPeer()` updates two things that must stay in step**: the TLS secure context's `ca` list and the fingerprint `expected` map. Updating only one silently rejects the new node at the other layer.
- **`Skill` has to stay in the always-appended `--allowedTools` group.** Skills are discovered fine in headless `-p` mode (verified live), but once `--allowedTools` narrows the set, an undeclared `Skill` tool means the agent can see the skill and not invoke it.
- **Routing/display state is tracked per target, not globally** (`activeRequestByTarget`, `busyTargets`, `displayQueue` in `agent-bridge-server.js`). A new request to one agent must never invalidate another agent's independent, still-running work — that was a real, previously-shipped bug.

## Verifying a change

There's no test suite — verification in this project means real, live behavior:
- `node --check <file>` after every edit, on every machine the file gets deployed to.
- For anything touching the marker regexes or routing logic, a throwaway Node script that connects fake nodes via `agent-net.js`'s `connectToHub()` and hand-crafts protocol messages is the fastest way to test hub logic with zero real API cost. Delete it when you're done.
- For anything touching what an agent actually says or decides, a short real `claude -p` call is worth the tokens — simulating both sides has hidden real bugs in this project before.
