---
owner: platform
paths:
  - "src/api/**/*.{ts,tsx}"
  - 'openapi/*.yaml'
---

# API Rules

- Validate every request body at the boundary.
- Return the standard error envelope.
