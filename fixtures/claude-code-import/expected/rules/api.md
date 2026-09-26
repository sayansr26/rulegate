---
globs:
  - src/api/**/*.{ts,tsx}
  - openapi/*.yaml
owner: platform
---

# API Rules

- Validate every request body at the boundary.
- Return the standard error envelope.
