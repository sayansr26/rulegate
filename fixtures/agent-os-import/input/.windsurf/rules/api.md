---
trigger: glob
globs: src/api/**/*.ts,src/server/**/*.ts
description: API handlers
---

<!-- agent-os: generated from .agent-os/ — edit the source, then run `npx @sayansr26/agent-os sync` -->

Validate every request body with zod before touching it.
Return errors as `{ error: { code, message } }`.
