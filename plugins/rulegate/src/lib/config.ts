import { join } from 'node:path';
import { isRecord, readJson } from './read.js';

/**
 * `.claude/rulegate.json` — the plugin's own settings (decision P1, 2026-09-26).
 *
 * Claude-only by design: it lives in Claude Code's directory, so it stays out of
 * RFC-0001's canonical format and out of `packages/core`, and the CLI never reads it.
 *
 *   {
 *     "features": ["src/features/*", "apps/*"],   // each direct subdirectory is a feature
 *     "cartographerReminder": true,              // T108's advisory note on first edit
 *     "handoff": ["HANDOFF.md"]                  // T107's session-resume note, first found wins
 *   }
 *
 * Every key is optional and a malformed file reads as `{}`: a typo in a settings file
 * must not take the hooks down with it.
 */
export interface PluginConfig {
  readonly features?: readonly string[];
  readonly cartographerReminder?: boolean;
  readonly handoff?: readonly string[];
}

export const CONFIG_PATH = '.claude/rulegate.json';

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;

export function pluginConfig(root: string): PluginConfig {
  const raw = readJson(join(root, CONFIG_PATH));
  if (!isRecord(raw)) return {};
  const features = strings(raw.features);
  const handoff = strings(raw.handoff);
  return {
    ...(features ? { features } : {}),
    ...(typeof raw.cartographerReminder === 'boolean'
      ? { cartographerReminder: raw.cartographerReminder }
      : {}),
    ...(handoff ? { handoff } : {}),
  };
}
