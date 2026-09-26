---
description: API handlers
globs:
  - src/api/**/*.ts
  - src/server/**/*.ts
order: 20
---

Validate every request body with zod before touching it.
Return errors as `{ error: { code, message } }`.
