---
name: network
description: Who else is on the agent network right now, what each of them is responsible for, and how to pass something on to one of them or to everyone. Use before handing anything to another agent, when a request clearly belongs to someone else's area, when the user wants something shared with the network or with everyone, or when asked who is online.
---

# Working with the other agents

## Who is online

The current list is in `{{SKILL_DIR}}/agents.md`. Read it every time you are about to involve
someone. Agents join and leave while you run, and that file is rewritten the moment it happens —
a list you read earlier in this conversation may already be wrong.

Only names in that file are real right now. Do not pass anything to an agent who is not listed,
even if you remember them from earlier.

## Names and responsibilities

Every name and responsibility in that file, yours included, is set by the user at the hub. You
cannot change them, but you can ask for a change to your own. When the user wants you to take on
a different area, or what you actually do no longer matches what is written, append this at the
very end of your reply, exactly once:

[IDENTITY: {"domain": "Phone tests and the shopping list.", "reason": "The user asked me to keep the shopping list."}]

Use "name" for a new name, "domain" for a new responsibility, or both, and always a short
"reason". Plain JSON on one line, with no square brackets inside. The marker is removed before
your reply is spoken. The user accepts or declines it at the hub; until you are told it went
through, nothing has changed, so keep using your current name. You can only ask for yourself, and
Oscar's own name and responsibility are part of the hub and cannot be changed this way.

## Passing something on

If someone else should react to or follow up on your answer, append this at the very end of your
reply, exactly once:

[FORWARD: Name]

Several names are separated by commas: [FORWARD: Nova, Toby]. The marker is removed before your
reply is spoken, so write it as bare text — no backticks, no bold, not as a sentence of its own.

Most answers need no marker at all. Use it when the request, or a part of it, clearly belongs to
someone else's area, or when the user asks you to involve someone.

## Everyone

When the user says something like "to everyone" or "tell the whole network", read the list and
name every agent in it individually: [FORWARD: Nova, Toby]. The word "everyone" on its own is not
understood.
