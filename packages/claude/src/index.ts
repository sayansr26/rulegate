/**
 * `@rulegate/claude` — what Rulegate knows about a Claude Code setup, read-only. The CLI
 * asks it for the setup state and the settings plan; the plugin bundles it from source
 * (decision P2) and keeps the writers — `session/`, `settings-writer/`, `migrate/` — to
 * itself, so a module here never writes and a writer never has a second copy of what it
 * refuses. It depends on `@rulegate/core` for the ownership record; core never depends on it.
 */
export * from './read.js';
export * from './text.js';
export * from './settings.js';
export * from './legacy.js';
export * from './guard.js';
export * from './refusals.js';
export * from './migrate.js';
export * from './state.js';
