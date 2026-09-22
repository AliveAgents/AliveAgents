# agent-skills

The skills the agents on the network use, kept here as source. Nothing is loaded from this folder
directly: at startup every agent copies the skills it should have into its own home,
`~/.aliveagents/<name>/.claude/skills/`, fills in placeholders such as `{{INBOX_DIR}}` and
`{{SKILL_DIR}}`, and writes the data files those skills point to (`network/agents.md`,
`presentation/display.md`). See `agent-home.js`.

| Skill | Who gets it | Data file written at runtime |
|---|---|---|
| `network` | every agent | `agents.md` — who is online and what for |
| `presentation` | every agent | `display.md` — is a display connected, where pages go, how to name them |
| `inbox` | every agent | — (the path is filled in at startup) |
| `workspace` | every agent | — (the path is filled in at startup) |
| `sources` | every agent | — |
| `new-agent` | the hub only | — |

## The rest of a home

Next to `.claude/skills/`, every home has two folders that belong to the agent and are never
wiped on restart:

- `workspace/` — the agent's own files. It has write access to exactly this folder, and the
  `workspace` skill tells it so.
- `memory/` — reserved for later. Nothing uses it yet: the agent has no write access and is not
  told about it. It exists so the layout is settled before anything depends on it.

## Why the rules live here instead of in every prompt

Until 2026-09-14 the marker rules and the list of online agents went into the system prompt of every
single turn (~767 tokens), and the inbox listing was restated in every message. That was paid on
every turn whether or not the turn involved anyone else. Worse, while the roster still lived in the
message it went stale: a conversation cannot retract a fact it was once told, so an agent kept
believing a departed agent was reachable.

Now the system prompt carries one short pointer to these skills. Claude Code always sends a skill's
one-line description; the body is loaded only when the agent decides it needs it. Anything that
changes lives in a file the agent reads at the moment it matters. Messages carry only events —
"Toby joined", "a new file arrived" — which, unlike state, never go stale.

## Why not in `.claude/skills`

Measured: skills in a directory passed with `--add-dir` are loaded. Every agent gets this repository
as an `--add-dir` (for `presented_content/` and `inbox/`), so skills in its `.claude/skills` would be
loaded a second time, and `new-agent` would reach nodes that cannot use it. Keeping the source out of
`.claude/` also keeps these agent-facing skills out of the skill list of a coding assistant working
on the repository.

## History worth keeping

- The marker rules first moved into the system prompt on 2026-08-17 because an imperative
  instruction inside the user message was flagged by the model as a possible prompt injection and
  ignored. Skills are loaded through Claude Code's own skill mechanism, which does not have that
  problem.
- Re-showing an existing deck does not re-narrate it slide by slide. Three progressively more
  forceful phrasings were tried live on 2026-08-25 and all failed the same way; accepted.
