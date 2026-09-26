---
name: map
description: Build or refresh the architecture map so changes run off known structure instead of rediscovering the codebase. Use for "map this codebase", "build the architecture map", "how is this project structured", "map the login flow", "refresh the map", or before changing a feature you have not touched before.
---

# Map the codebase

A map written once is an answer given free for the rest of the project's life.
This is what makes a request like _"change the login flow from email to OTP"_
start from known structure instead of a cold grep.

You do not do the exploring. `feature-cartographer` does, in its own context
window, and returns a summary. That is the whole point — the file reads never
enter this conversation.

## `$ARGUMENTS`

| Argument                   | Do                                                          |
| -------------------------- | ----------------------------------------------------------- |
| _(none)_ or `architecture` | Build or refresh `_architecture.md`, the system-level map   |
| `<feature or area>`        | Map that feature — "map the login flow", "map checkout"     |
| `refresh`                  | Re-map whatever `/rulegate:memory stale` flagged as drifted |

## The architecture map

Dispatch `feature-cartographer` with a system-level brief, not a feature
question:

> Map this codebase at the system level. Produce `_architecture.md`: stack and
> versions, the layers and what each owns, where a request enters and how it
> reaches data, state management, the network edge, the auth and permission
> model, build and run commands, and the three or four files a newcomer must read
> first. Name real files. State what you could not determine.

Everything in it must be observed in this repository. Versions come from a
manifest, not from what the model knows about the framework.

Build this once per project. Refresh it when the architecture actually changes —
a new service, a swapped data layer, a routing migration — not on a schedule.

## Mapping one feature

Dispatch the cartographer with the feature name. It reads `_architecture.md`
first, so it explores a fraction of what it would cold, and returns entry point,
the files that matter, state, network edge, what gates it, and the blast radius.

Then it writes the map to disk and indexes it, so the next question about that
area is near free.

## After the map exists

Point the user at the change workflow — the map only pays off if changes actually
use it: `references/changing-a-feature.md` in the `init` skill. In short:
cartographer answers _how is it built_, the path-scoped rules load themselves,
`builder` works from the map and the nearest precedent rather than the one-line
request, `reviewer` checks against written rules, and the cartographer updates
the map in the same turn.

That last step is the one people skip. A map that was right last week and is
wrong today is worse than no map, because it gets trusted.

## Verify before trusting it

Ask the cartographer something about the codebase you already know the answer to,
and check it. Do this the first time a map is built. A confidently wrong map is
the failure mode worth catching early, and this is the cheapest moment to catch
it.
