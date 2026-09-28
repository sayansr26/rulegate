---
tools:
  - claude-code
order: 40
---

Run the dev server with `pnpm dev`; it reads `.env.local`, which is never committed.

`.claude/rules/` is generated from `.agent-os/rules/` — edit the source there
(then `npx @sayansr26/agent-os sync`), or the next sync reverts the change.

## Agents in this project

- Before changing an existing feature: ask `rulegate:feature-cartographer` how
  it is built.
- Writing the change: `rulegate:builder`, given the map and the files to change.
- Done means: `rulegate:reviewer` found no rule violations.
