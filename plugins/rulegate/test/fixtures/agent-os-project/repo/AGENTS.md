<!-- agent-os: generated from .agent-os/ — edit the source, then run `npx @sayansr26/agent-os sync` -->

# Shopfront

A storefront: auth, billing and search, each a feature under `src/features/`.

- `pnpm test` before calling anything done.

## 10-project

Every feature exports its public surface from `index.ts` and nothing else.

## Path-scoped rules

These apply only to matching files. Tools with conditional rule loading
receive them as real scoped rules; read the relevant one before editing.

- `src/api/**` — API handlers
