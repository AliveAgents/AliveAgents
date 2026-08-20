# AliveAgents

**A network of AI agents with real voices and real faces, living on your own machines.**

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](./LICENSE)
[![Built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-D97757)](https://claude.com/claude-code)

AliveAgents turns [Claude Code](https://claude.com/claude-code) into a small team of persistent, embodied assistants — Oscar and Nova by default — that you talk to out loud. Each agent runs on its own machine, has its own voice (via local text-to-speech), and animates its own face on screen. They hand conversations off to each other automatically when it makes sense, and they can put things up on a shared display — a dashboard, search results, a slide — while they talk you through it.

Nothing leaves your own network. There is no cloud service in the middle: agents talk to each other over a directly encrypted connection between the machines you own.

---

## What it actually does

- **You talk, they talk back.** Press-to-toggle microphone input, real speech recognition, real synthesized voices per agent — no typing required.
- **Every agent has a face.** A small animated avatar (idle / thinking / speaking) rendered in the browser, so you always have a visual sense of who's doing what.
- **Agents hand off to each other.** Ask a general question and the right agent picks it up automatically, based on what each one is actually responsible for — not keyword matching, genuine language understanding. Say a name directly to address someone specifically. Say "everyone" to broadcast to the whole network.
- **A shared display.** Any agent can show you something instead of just describing it — a chart, a table, a webpage it built on the spot — while it keeps talking. The display waits its turn instead of agents talking over each other.
- **It's just Claude Code underneath.** Every agent's "brain" is a real, independent Claude Code CLI session — including tool use, file access scoped per agent, and its own persistent memory across conversations.
- **Private by construction.** Every machine on the network has its own self-signed certificate; every connection is mutual TLS 1.3. There's no shared certificate authority, so nothing outside your own set of devices can ever join or eavesdrop.

## How it's built

```mermaid
flowchart TB
    subgraph HubMachine["Oscar's machine (hub)"]
        HubCLI["Claude Code CLI<br/>(Oscar)"]
        HubVoice["Local voice<br/>(Piper TTS)"]
        HubOverlay["Browser overlay<br/>face + mic"]
        HubCLI --> HubVoice
        HubCLI --> HubOverlay
    end

    subgraph NodeMachine["Nova's machine (node)"]
        NodeCLI["Claude Code CLI<br/>(Nova)"]
        NodeVoice["Local voice<br/>(Piper TTS)"]
        NodeOverlay["Browser overlay<br/>face + mic"]
        NodeCLI --> NodeVoice
        NodeCLI --> NodeOverlay
    end

    You(("You")) -- "speaks" --> HubOverlay
    HubOverlay -- "mic audio" --> HubCLI
    HubCLI == "mutual TLS 1.3<br/>(self-signed, pinned certs)" ==> NodeCLI

    HubVoice -. "speaker" .-> You
    NodeVoice -. "speaker" .-> You
```

Every machine runs two small local Node.js processes: one that bridges your microphone/browser to a Claude Code CLI session, and one that turns Claude's text reply into speech and an animated face. The hub additionally routes conversations between agents and coordinates the shared display. No agent's process ever talks to the internet on your behalf except through the tools you explicitly allow it.

### How a conversation actually gets routed

```mermaid
flowchart LR
    Input["You speak"] --> Named{"Named someone<br/>directly?"}
    Named -- yes --> Dispatch["Dispatch to<br/>that agent"]
    Named -- no --> Recent{"Same agent replied<br/>in the last 30s?"}
    Recent -- yes --> Dispatch
    Recent -- no --> Classify["Ask a fast model:<br/>who's actually responsible<br/>for this topic?"]
    Classify --> Dispatch
    Dispatch --> Reply["Agent replies,<br/>speaks, maybe presents"]
    Reply --> Marker{"Agent appended a<br/>forward marker?"}
    Marker -- yes --> Dispatch
    Marker -- no --> Done(("Conversation settles"))
```

Agents decide for themselves, every single turn, whether someone else on the network should react next — by quietly appending a machine-only marker to the end of their reply, which is stripped out before anything is spoken or shown. There's no fixed script and no forced back-and-forth: if nothing needs adding, the conversation just ends naturally.

## Setup

You'll need two things installed system-wide first: **[Node.js](https://nodejs.org/)** and the **[Claude Code CLI](https://claude.com/claude-code)**, logged in with `claude setup-token`. Then, per machine:

```bash
git clone git@github.com:AliveAgents/AliveAgents.git
cd AliveAgents
npm install
```

1. **Generate your own certificates.** `sh make-certs.sh` on the hub machine creates its identity; run `sh make-certs.sh <name>` for every additional node. Copy each node's `<name>-cert.pem` and the hub's `-cert.pem` to the other machine — never the `-key.pem` files, those stay put.
2. **Configure.** Copy `net-config.example.json` to `net-config.json` on each node and fill in the hub's LAN IP, the agent's name, and its voice. The hub's own `net-config.json` just needs `role: "hub"` and the list of node names it should accept.
3. **Add a voice.** Drop a [Piper](https://github.com/OHF-Voice/piper1-gpl) voice model into `tools/piper/voices/` per agent — any language, any voice.
4. **Your own secrets stay local.** Copy `token.local.bat.example` → `token.local.bat` with your own Claude Code token. Never commit the real file — `.gitignore` already excludes anything matching `*.local.*`.
5. **Start it.** `start.bat` on the hub, `start-node.bat` on every node. Open the printed `localhost` URL in a browser with a userscript manager (e.g. Tampermonkey) installed, and paste in `agent-face-overlay.user.js`.

Talk to the hub's microphone button and the network takes it from there.

## Roadmap

AliveAgents works today as a real-time, multi-agent voice network. The direction it's heading:

- **Deeper agent-to-agent collaboration** — richer handoffs, agents that can delegate sub-tasks to each other and merge the results, not just forward a single conversation turn.
- **A shared, permissioned memory.** A central store agents can read from — but only the specific data you've explicitly granted them access to by voice, nothing broader by default. Drop a file in by drag-and-drop as a human, and it's securely managed from there without any manual wiring.
- **Network-wide security and an action authenticator.** As the main agent takes on more responsibility, its more consequential actions should need an explicit, out-of-band confirmation step — something closer to an authenticator app than a blanket permission grant.
- **The main agent as network manager.** Fully onboarding a brand-new agent — provisioning it, briefing it on its role, handing it access to shared memory, the main display, and the files it needs — automatically, the way a DHCP server hands a new device its network configuration the moment it joins, instead of manual per-agent setup.

## For AI coding agents

If you're an AI agent working in this repository, read [`CLAUDE.md`](./CLAUDE.md) first — it has the setup steps, file map, and conventions this project expects.

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE) — free to use, modify, and share for any noncommercial purpose. Interested in commercial use? Open an issue or get in touch.
