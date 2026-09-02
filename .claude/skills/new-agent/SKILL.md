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
| Face | optional | `ava` or `kai` |
| Personality | optional | how it should speak |

If the user only says "set up a new agent called Ada for the calendar", that is already enough —
ask about voice and face only if they seem to care, and otherwise say which defaults you used.

## Then trigger it

Append at the very end of your reply, exactly once:

```
[PROVISION: {"self":"ada","agentName":"Ada","domain":"Calendar, appointments and scheduling.","piperVoice":"en_US-ljspeech-high.onnx","faceStyle":"ava"}]
```

- `self` is required and must be lowercase letters, digits, `-` or `_`.
- Everything else is optional — leave a field out rather than guessing a value.
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
`start-node.bat`, and install the browser overlay from
`http://localhost:8787/agent-face-overlay.user.js`. Mention these only if asked — `enroll.bat`
prints the list when it finishes.

## When something goes wrong

The hub replies through you, so just pass on what it says. The common cases:

- **Name already taken** — that agent exists; suggest a different name.
- **A window is already open** — one enrollment at a time; wait for it to finish or expire.
- **The code expired** — windows last a few minutes. Offer to start a new one.

After three wrong codes the window closes on purpose. That is not a fault to work around; start a
fresh one if the user asks.
