<!-- agent-os: generated from .agent-os/ — edit the source, then run `npx @sayansr26/agent-os sync` -->

<!-- Intended activation: Glob — src/api/**/*.ts, src/server/**/*.ts Set this in Customizations → Rules; Antigravity has no documented file syntax for it. -->

# API handlers

Validate every request body with zod before touching it.
Return errors as `{ error: { code, message } }`.
