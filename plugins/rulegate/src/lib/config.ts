import { isRecord, readInRepo } from './read.js';
import { hasControl } from './text.js';

/**
 * `.claude/rulegate.json` — the plugin's own settings (decision P1, 2026-09-26).
 *
 * Claude-only by design: it lives in Claude Code's directory, so it stays out of
 * RFC-0001's canonical format and out of `packages/core`, and the CLI never reads it.
 *
 *   {
 *     "features": ["src/features/*", "apps/*"],   // each direct subdirectory is a feature
 *     "cartographerReminder": true,              // T108's advisory note on first edit
 *     "handoff": ["HANDOFF.md"],                 // T107: the resume note, first found wins
 *     "activeTask": [".claude/active-task.md"]   // T107: the task in flight, title only
 *   }
 *
 * Every key is optional and a malformed file reads as `{}`: a typo in a settings file
 * must not take the hooks down with it. File paths must stay inside the repository — the
 * session hook reads them into Claude's context, and a cloned repository must not be able
 * to point that at `~/.ssh` — so an absolute path or one with a `..` segment is dropped.
 */
export interface PluginConfig {
  readonly features?: readonly string[];
  readonly cartographerReminder?: boolean;
  readonly handoff?: readonly string[];
  readonly activeTask?: readonly string[];
}

export const CONFIG_PATH = '.claude/rulegate.json';

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;

/**
 * Repo-relative and contained: no absolute path, no drive letter, no `..` segment, and no
 * control character. The hooks print these paths into Claude's context — `features` inside
 * the instruction-framed contract — so a newline in one must not be able to start a heading.
 */
export const inRepo = (p: string): boolean =>
  p !== '' && !hasControl(p) && !/^([/\\]|[A-Za-z]:)/.test(p) && !p.split(/[/\\]/).includes('..');

/** A bound on configured entries, so a config of thousands cannot outlast the hook timeout. */
const MAX_ENTRIES = 20;

const paths = (value: unknown): string[] | undefined =>
  strings(value)?.filter(inRepo).slice(0, MAX_ENTRIES);

/** The config file itself is read with the same containment as the files it names. */
function rawConfig(root: string): unknown {
  const text = readInRepo(root, CONFIG_PATH);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function pluginConfig(root: string): PluginConfig {
  const raw = rawConfig(root);
  if (!isRecord(raw)) return {};
  const features = paths(raw.features);
  const handoff = paths(raw.handoff);
  const activeTask = paths(raw.activeTask);
  return {
    ...(features ? { features } : {}),
    ...(typeof raw.cartographerReminder === 'boolean'
      ? { cartographerReminder: raw.cartographerReminder }
      : {}),
    ...(handoff ? { handoff } : {}),
    ...(activeTask ? { activeTask } : {}),
  };
}
