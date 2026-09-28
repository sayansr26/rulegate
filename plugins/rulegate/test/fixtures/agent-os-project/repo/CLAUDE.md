Run the dev server with `pnpm dev`; it reads `.env.local`, which is never committed.

`.claude/rules/` is generated from `.agent-os/rules/` — edit the source there
(then `npx @sayansr26/agent-os sync`), or the next sync reverts the change.

## Agents in this project (agent-os)

- Before changing an existing feature: ask `agent-os:feature-cartographer` how
  it is built.
- Writing the change: `agent-os:builder`, given the map and the files to change.
- Done means: `agent-os:reviewer` found no rule violations.
