---
description: API handlers
paths:
  - "src/api/**/*.ts"
  - "src/server/**/*.ts"
---

Validate every request body with zod before touching it.
Return errors as `{ error: { code, message } }`.
