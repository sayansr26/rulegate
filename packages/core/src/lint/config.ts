import { matchesGlob } from '../fs/glob.js';
import type { LintConfig, LintSeverity } from '../model/lint.js';
import type { LintFinding, LintFindingInit, LintRule, LintRuleId } from './types.js';

/**
 * The severity a rule runs at, given the manifest.
 *
 * The manifest wins over the rule's own default, always — including when it makes a
 * rule louder. A rule author picks a default that is safe everywhere; a repository
 * knows its own situation and is allowed to say so.
 */
export function severityFor(rule: LintRule, config: LintConfig): LintSeverity {
  return config.rules[rule.id] ?? rule.defaultSeverity;
}

/**
 * Is this finding silenced by `lint.ignore`?
 *
 * A finding with no paths is never suppressed by a path glob: it is about the
 * repository, and `ignore` is a statement about files. Silencing it here would make
 * "unknown rule id in your manifest" disappear behind an unrelated fixture glob.
 *
 * A finding with several paths is suppressed only when **every** path is ignored. The
 * other way round, one ignored path in a duplicate-load finding that spans four files
 * would hide the other three.
 */
export function isSuppressed(finding: LintFindingInit, config: LintConfig): boolean {
  if (finding.paths.length === 0) return false;
  if (config.ignore.length === 0) return false;
  return finding.paths.every((p) => config.ignore.some((glob) => matchesGlob(p, glob)));
}

/**
 * Deterministic order: rule id, then first path, then message.
 *
 * By codepoint via `<`, never `localeCompare` — locale collation is banned repo-wide
 * (`docs/determinism.md` rule 2) because it reorders output between machines.
 */
export function sortFindings(findings: readonly LintFinding[]): LintFinding[] {
  return [...findings].sort((a, b) => {
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    const pa = a.paths[0] ?? '';
    const pb = b.paths[0] ?? '';
    if (pa !== pb) return pa < pb ? -1 : 1;
    if (a.message !== b.message) return a.message < b.message ? -1 : 1;
    return 0;
  });
}

/** Rule ids the manifest names that no registered rule answers to. Sorted. */
export function unknownRuleIds(
  config: LintConfig,
  registry: readonly LintRule[],
): readonly string[] {
  const known = new Set<LintRuleId>(registry.map((r) => r.id));
  return Object.keys(config.rules)
    .filter((id) => !known.has(id as LintRuleId))
    .sort();
}
