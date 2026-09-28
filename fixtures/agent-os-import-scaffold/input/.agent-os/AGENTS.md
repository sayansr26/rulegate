# Project instructions

Replace this with what is true in **every** session: how to build, how to run,
how to verify, and the conventions that are not obvious from the code.

Keep it short. Anything that only matters for part of the tree belongs in
`.agent-os/rules/` instead, where it can be scoped to the files it applies to.

## Path-scoped rules

These apply only to matching files. Tools with conditional rule loading
receive them as real scoped rules; read the relevant one before editing.

- `src/api/**` — Conventions for the API layer
