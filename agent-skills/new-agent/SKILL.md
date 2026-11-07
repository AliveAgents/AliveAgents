---
name: new-agent
description: Set up a brand-new agent on another machine — walk the user through naming it and deciding what it is for, then open a pairing window so the new machine can join the network by itself. Use when the user asks to add, set up, provision, enroll or onboard a new agent, node, or device.
---

# Setting up a new agent

You collect the decisions by voice, then hand off to the hub, which does everything involving keys
and configuration. You never touch certificates or config files yourself — you cannot, and that is
deliberate.

## What to ask

Ask for these conversationally, a couple at a time, not as a form. Most of them have a sensible
default, so only the first two really need answering.

| | | |
|---|---|---|
| **Machine name** | required | lowercase, e.g. `ada` — becomes the certificate and config name, and cannot be changed later |
| **What it's for** | required | one sentence; this is what routing uses to decide when it should answer |
| Spoken name | optional | e.g. "Ada" — defaults to the machine name, capitalized |
| Voice | optional | `en_US-ljspeech-high.onnx` (female), `en_US-ryan-high.onnx` (male), `de_DE-kerstin-low.onnx`, `de_DE-thorsten-medium.onnx` |
| Face | optional | designed automatically — only name one if the user asks for something specific |
| Personality | optional | how it should speak |

**Leave voice and face out unless the user cares.** The hub generates both, along with a colour
the new agent wears — picked so it does not clash with anyone already on the network, which is
something you cannot do by guessing, because you do not know what the others look like. Before
this existed every new agent got the same two defaults, so the third machine to join turned up
wearing the second one's face and speaking in its voice.

A new agent is **always** given a newly designed face, never one that already exists on the
network. You do not draw it and you cannot write one — a face runs as code on the page that holds
the microphone, so nobody's text goes in there. What you may do is pick parts, and only from these
lists; anything else is replaced by a drawn one:

| part | choices |
| --- | --- |
| `shell` | `block`, `round`, `hex`, `tower` |
| `eyes` | `pixel`, `visor`, `rings`, `matrix` |
| `pattern` | `grid`, `scanlines`, `dots`, `plain` |
| `crest` | `none`, `antenna`, `ears`, `bar` |
| `mouth` | `smile`, `flat`, `stern` |
| `idle` | `bob`, `breathe`, `flicker` |
| `thinking` | `scan`, `pulse`, `orbit` |
| `speaking` | `glow`, `throb`, `ripple` |

Numbers, if the user is that specific: `corner` 0–26, `stroke` 2–6, `mouthWidth` 56–96,
`mouthDepth` 5–14. Each one you leave out is drawn for you.

If the user does have a wish ("make him sound deeper", "something green"), pass it: `piperVoice`
for a machine that speaks through Piper, `androidTts` for a phone, `faceTint` for the colour.
A phone has a single TTS engine, so `pitch` deepens the one voice rather than swapping in another
— say so rather than promising a different speaker.

If the user only says "set up a new agent called Ada for the calendar", that is already enough —
ask about voice and face only if they seem to care, and otherwise say which defaults you used.

The spoken name and what it is for are not final forever: the user can change both later at the
hub, and an agent can ask for a change to its own. Only the user decides, so do not offer to rename
an agent yourself.

## Then trigger it

Append at the very end of your reply, exactly once:

```
[PROVISION: {"self":"ada","agentName":"Ada","domain":"Calendar, appointments and scheduling.","piperVoice":"en_US-ljspeech-high.onnx","faceRecipe":{"shell":"round","eyes":"rings"}}]
```

- `self` is required and must be lowercase letters, digits, `-` or `_`.
- Everything else is optional — leave a field out rather than guessing a value. A field you omit
  is generated; a field you invent is used as-is, so omitting is the better failure.
- `faceRecipe` takes the parts from the table above, as many or as few as the user asked for.
  `faceStyle` is the other way round: `"ava"` or `"kai"` puts one of the two hand-written faces on
  the new agent instead of a new design. Only pass it if the user asked for that face by name.
- `faceTint` takes exactly `idle`, `thinking` and `speaking`, each a plain `#rrggbb`.
  Anything else is rejected whole and the generated colour is used instead. Keep `thinking`
  amber — it means the same thing on every agent's face, and an agent whose own colour is amber
  cannot be told apart from one that is busy.
- `androidTts` takes `pitch` (0.75–1.25) and `rate` (0.95–1.05) for a phone. Outside that range
  it stops sounding like a voice.
- **Plain JSON with no arrays.** The marker ends at the first `]`, so an array would cut the
  payload in half.
- Do not invent a pairing code, and do not mention one in your own words. You do not know it — the
  hub generates it and appends it to what you say. Just say the setup is starting.

## What happens next

The hub opens a pairing window for a few minutes, prints the instructions on its console, and adds
the code to your spoken reply. The user then runs one command on the new machine:

```
enroll.bat <hub-ip> <code> ada
```

That machine generates its own key pair locally — **the private key never travels**, which is why
nothing has to be copied by hand. Only its certificate is exchanged, and the code is what proves
the exchange is with the right machine rather than someone else on the network.

Afterwards, on that machine: drop in the voice model, set up the Claude token, run
`start-node.bat`, and open `http://localhost:8787/` in a browser — the face is served there, no
browser extension needed. Mention these only if asked — the enroll script prints the list when it
finishes.

## If the new machine is a phone

An Android phone can host an agent too, through Termux and without root. It needs one preparation
step first, run on the phone inside a clone of the repository:

```
bash setup-termux.sh
```

It then joins with `node enroll.js <hub-ip> <code> <name>` instead of `enroll.bat`, and starts with
`bash start-node.sh`. A phone speaks through its own text-to-speech engine, so a Piper voice does not
apply to it: leave `piperVoice` out, and set `androidTts` only if the user wants a particular sound.

## When something goes wrong

The hub replies through you, so just pass on what it says. The common cases:

- **Name already taken** — that agent exists; suggest a different name.
- **Spoken name already taken** — another agent already answers to it; suggest a different one.
- **A window is already open** — one enrollment at a time; wait for it to finish or expire.
- **The code expired** — windows last a few minutes. Offer to start a new one.

After three wrong codes the window closes on purpose. That is not a fault to work around; start a
fresh one if the user asks.
