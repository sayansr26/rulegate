import { compareCodepoint } from '../render/order.js';
import { matchesGlob } from '../fs/glob.js';
import { BACKUP_DIR, MANIFEST_PATH, RULEGATE_DIR, RULES_GLOB } from '../model/paths.js';
import { parse } from './index.js';
import type { Canonical } from '../model/canonical.js';
import type { ParseResult } from './index.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';
import type { RuleDocument } from '../model/rule.js';

/** One `.rulegate/` found in the tree, parsed in place. */
export interface NestedSource {
  /** Repo-relative POSIX directory holding it. `''` is the repository root. */
  readonly dir: string;
  readonly result: ParseResult;
}

/** A level's rules after its ancestors have been folded in. */
export interface ResolvedLevel {
  readonly dir: string;
  /**
   * Ancestor rules plus this level's own, nearest-wins by rule id.
   *
   * The manifest, MCP servers and skills come from **this level** when it has a
   * manifest, and from the nearest ancestor that does otherwise. Rules merge; the
   * manifest does not — a package saying `tools: [cursor]` means cursor, not cursor
   * plus whatever the root enabled, and a merged tool list could silently re-enable an
   * adapter a package had deliberately turned off.
   */
  readonly canonical: Canonical;
  /** Rule ids this level defines itself, sorted. */
  readonly ownRuleIds: readonly string[];
  /** Rule ids this level redefines from an ancestor, sorted. */
  readonly overriddenRuleIds: readonly string[];
  /** Ancestor directories contributing rules, nearest last. `''` is the root. */
  readonly inheritedFrom: readonly string[];
}

/**
 * Every directory holding a canonical source, root first.
 *
 * Discovery walks **down** from the repository root, which is a different question from
 * `findRepoRoot`'s walk up: that one answers "which repository am I in", this one
 * answers "what does it contain". A `.rulegate/` under `.rulegate/backup/` is a saved
 * copy of somebody's old config, never a level.
 */
export async function discoverSources(
  fs: ReadOnlyFileSystem,
  knownTools?: readonly string[],
  ignore: readonly string[] = [],
): Promise<readonly NestedSource[]> {
  const dirs = new Set<string>();

  const add = (path: string, marker: string): void => {
    const idx = path.indexOf(marker);
    if (idx === -1) return;
    const dir = idx === 0 ? '' : path.slice(0, idx - 1);
    // `options.ignore` is the manifest saying "this subtree is not mine". It was
    // doctor-only while nothing walked the tree; discovery is the second thing that
    // needs it and needs it more, because a repository holding `.rulegate/` trees as
    // *test data* — every golden fixture in this one — would otherwise have `sync`
    // generating artifacts into them and `check` failing on a deliberately malformed
    // fixture. The ignored path is not a level, not an error, and not reported.
    if (ignore.some((pattern) => dir === pattern || matchesGlob(dir, pattern))) return;
    // A backup holds files Rulegate took ownership of; treating one as a source would
    // resurrect config the user replaced, and `restore` is the way back, not discovery.
    if (dir === BACKUP_DIR || dir.startsWith(`${BACKUP_DIR}/`) || dir.includes(`/${BACKUP_DIR}/`)) {
      return;
    }
    dirs.add(dir);
  };

  for (const p of await fs.glob(`**/${MANIFEST_PATH}`)) add(p, MANIFEST_PATH);
  // A level may be rules-only, exactly as the root may be. Globbing the manifest alone
  // would silently skip it, and `parse` already supports the mode.
  for (const p of await fs.glob(`**/${RULES_GLOB}`)) add(p, `${RULEGATE_DIR}/rules/`);

  const out: NestedSource[] = [];
  // Sequentially and in sorted order, never `Promise.all`: appending in settle order
  // makes the result depend on disk timing, which `detect/engine.ts` records as a
  // nondeterminism bug that only reproduces on somebody else's machine.
  for (const dir of [...dirs].sort(compareCodepoint)) {
    out.push({
      dir,
      result: await parse({
        fs,
        ...(knownTools === undefined ? {} : { knownTools }),
        ...(dir === '' ? {} : { dir }),
      }),
    });
  }
  return out;
}

/** Is `dir` at or below `ancestor`? `''` is an ancestor of everything. */
function isUnder(dir: string, ancestor: string): boolean {
  if (ancestor === '') return true;
  return dir === ancestor || dir.startsWith(`${ancestor}/`);
}

/**
 * Fold each level's ancestors into it, nearest-wins by rule id.
 *
 * **Inheritance, not replacement.** A package declaring one rule gets that rule plus
 * every repo-wide convention, which is how all ten target tools behave: each of them
 * walks up from the file it is working on and collects what it finds. Making a nested
 * source self-contained would force every package to restate the root's rules and would
 * still not match what the tool does at runtime.
 *
 * Conflicts resolve by **rule id**, because that is the identity the canonical model
 * already uses — `detectIdConflicts` refuses two files claiming one id within a level,
 * so an id is unambiguous inside its own level and a redefinition across levels is the
 * only remaining meaning.
 */
export function resolveNested(sources: readonly NestedSource[]): readonly ResolvedLevel[] {
  const ordered = [...sources].sort((a, b) => compareCodepoint(a.dir, b.dir));

  return ordered.map((level) => {
    // Ancestors, outermost first, so a nearer one overwrites a further one below.
    const ancestors = ordered.filter((s) => s.dir !== level.dir && isUnder(level.dir, s.dir));

    const byId = new Map<string, RuleDocument>();
    for (const a of ancestors) {
      for (const rule of a.result.canonical.rules) byId.set(rule.id, rule);
    }
    const inherited = new Set(byId.keys());

    const own: string[] = [];
    const overridden: string[] = [];
    for (const rule of level.result.canonical.rules) {
      own.push(rule.id);
      if (inherited.has(rule.id)) overridden.push(rule.id);
      byId.set(rule.id, rule);
    }

    // The nearest level that actually declared a manifest owns the non-rule config. A
    // rules-only package inherits the root's tool list rather than falling back to a
    // synthetic "every tool enabled", which would turn adapters on that the root had off.
    const config =
      level.result.mode === 'rulegate-dir'
        ? level.result
        : ([...ancestors].reverse().find((a) => a.result.mode === 'rulegate-dir')?.result ??
          level.result);

    return {
      dir: level.dir,
      canonical: {
        ...config.canonical,
        rules: [...byId.values()],
      },
      ownRuleIds: [...own].sort(compareCodepoint),
      overriddenRuleIds: [...overridden].sort(compareCodepoint),
      inheritedFrom: ancestors.map((a) => a.dir),
    };
  });
}
