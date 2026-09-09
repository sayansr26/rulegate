import type { Adapter } from './adapter.js';
import type { PrecedenceEntry } from './docs.js';
import type { ToolId } from '../model/ids.js';

/** A managed artifact a tool will still read when it sits in a subdirectory. */
export interface NestedTarget {
  readonly tool: ToolId;
  /** The declared project-scope pattern, unprefixed — e.g. `CLAUDE.md`. */
  readonly pattern: string;
  readonly nesting: NonNullable<PrecedenceEntry['nesting']>;
}

/**
 * Which artifacts may be written at a nested level, read off `AdapterDocs` (T062).
 *
 * **Derived, never listed.** A managed entry carrying a `nesting` value is a tool saying,
 * with a source link and a verified-against version, that it reads that file from a
 * subdirectory too — `nearest-wins` for Claude Code, Codex and Cursor, `all-merged` for
 * Gemini, Roo Code and Windsurf. That is exactly the question "may Rulegate emit this at
 * `packages/a/`?", already answered by T025's data, so asking it again in a hand-kept list
 * would be a second copy that drifts.
 *
 * The absence of `nesting` is equally load-bearing and is why this returns targets rather
 * than a boolean per tool: Copilot's only `nesting` entry is on `AGENTS.md`, which it
 * **reads** and Codex writes (`managed: false`), so Copilot has no managed artifact of its
 * own that a subdirectory copy would reach. Aider, Cline and Zed declare none at all —
 * Zed because its resolution is `first-match`, so a nested file would not add context but
 * *shadow* the root one.
 */
export function nestedTargets(adapters: readonly Adapter[]): readonly NestedTarget[] {
  const out: NestedTarget[] = [];
  for (const adapter of adapters) {
    for (const entry of adapter.docs.files) {
      if (!entry.managed) continue;
      if (entry.nesting === undefined) continue;
      // A global-scope entry lives outside the repository; nesting cannot apply to it.
      if (entry.scope === 'global') continue;
      out.push({ tool: adapter.name, pattern: entry.pattern, nesting: entry.nesting });
    }
  }
  return out;
}

/**
 * Tools a nested level's rules cannot reach, with the reason.
 *
 * `sync` skips these at a nested level rather than folding the rules into the root
 * artifact: a rule scoped to one package, applied repository-wide, is a worse answer than
 * one that does not apply. Reporting is the other half — silence would let somebody
 * believe a package's rules were live in a tool that never reads them.
 */
export function toolsWithoutNesting(adapters: readonly Adapter[]): readonly ToolId[] {
  const reachable = new Set(nestedTargets(adapters).map((t) => t.tool));
  return adapters.map((a) => a.name).filter((name) => !reachable.has(name));
}

/**
 * Where a nested level's copy of `pattern` goes.
 *
 * Prefixing is the whole mechanism, and it is why `nestedTargets` has to gate it: an
 * artifact written at a path no `AdapterDocs` entry declares is one `buildManagedByIndex`
 * cannot attribute, so `doctor` would report Rulegate's own output as somebody else's and
 * the orphan scan would offer to delete it — T073, arriving through a new door.
 */
export function nestedPath(dir: string, pattern: string): string {
  return dir === '' ? pattern : `${dir}/${pattern}`;
}
