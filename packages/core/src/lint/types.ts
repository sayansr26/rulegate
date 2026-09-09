import type { Adapter } from '../adapter/adapter.js';
import type { Canonical } from '../model/canonical.js';
import type { LintSeverity } from '../model/lint.js';
import type { DoctorReport } from '../doctor/types.js';
import type { Plan } from '../pipeline/plan.js';
import type { RulegateError } from '../model/errors.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';
import type { SourceLink } from '../adapter/docs.js';
import type { ToolId } from '../model/ids.js';

/**
 * Everything a rule is allowed to see.
 *
 * A rule gets facts, never a filesystem it can walk or an adapter it can run. The
 * `DoctorReport` here is the same one `rulegate doctor` prints, built once by the
 * engine — which is what makes it structurally impossible for the two commands to
 * describe the same repository differently.
 *
 * `fs` is present and read-only because one rule genuinely needs it: `stale-path` has
 * to ask whether a referenced file exists, and no report carries "every path in the
 * repository". It is a `ReadOnlyFileSystem`, so the worst a rule can do is read.
 */
export interface LintContext {
  readonly report: DoctorReport;
  readonly plan: Plan;
  readonly canonical: Canonical;
  readonly adapters: readonly Adapter[];
  readonly fs: ReadOnlyFileSystem;
  /** Per-tool token budgets from the manifest. Empty means no rule may assume one. */
  readonly tokenBudget: Readonly<Record<string, number>>;
}

/**
 * One thing a rule found.
 *
 * `severity` is absent: a rule states what it found, and the engine decides how loud
 * that is. A rule that set its own severity could not be reconfigured from the
 * manifest, which is the entire point of having severities.
 */
export interface LintFindingInit {
  /**
   * Repo-relative POSIX, or `~/`-prefixed for a global-scope file. Empty when the
   * finding is about the repository rather than any one file — an unknown rule id in
   * the manifest, for instance.
   */
  readonly paths: readonly string[];
  readonly message: string;
  readonly tool?: ToolId;
  /** What to do about it. Every rule supplies one; a finding with no action is noise. */
  readonly hint: string;
  /** Carried from `AdapterDocs` where the claim came from one, so it stays checkable. */
  readonly source?: SourceLink;
}

export interface LintFinding extends LintFindingInit {
  readonly rule: LintRuleId;
  readonly severity: Exclude<LintSeverity, 'off'>;
}

/**
 * Rule ids, as a closed union.
 *
 * A union rather than `string` so that a typo in the registry, in a default, or in a
 * test is a compile error. The manifest still accepts unknown ids as plain strings —
 * it has no registry to check against — and the engine reports them, which is the one
 * place both halves of the question are answerable.
 */
export type LintRuleId = 'oversized-file' | 'stale-path' | 'conflicting-rules' | 'token-budget';

export interface LintRule {
  readonly id: LintRuleId;
  /**
   * The severity this rule has when the manifest says nothing.
   *
   * Never `error` for a rule whose true positives include a permanent, correct state.
   * `doctor` exits 0 on its warnings for this reason (T027) and Copilot's three
   * additive instruction mechanisms are the standing example: a gate that fails on a
   * correct repository is a gate people mute, and a muted linter reports nothing at all.
   */
  readonly defaultSeverity: LintSeverity;
  /** One line, printed with the finding's rule id. */
  readonly description: string;
  /** Pure. No I/O beyond `ctx.fs`, no writes, no adapter calls. */
  check(ctx: LintContext): readonly LintFindingInit[] | Promise<readonly LintFindingInit[]>;
}

export interface LintReport {
  /**
   * Problems that stopped the repository being rendered at all.
   *
   * A canonical source that does not parse is not a repository with no lint findings —
   * it is a repository nothing could be computed about, and reporting it as clean is
   * the failure `check` avoids by refusing to verify an unrenderable plan. Non-empty
   * means every other field below is uninformative rather than reassuring.
   */
  readonly errors: readonly RulegateError[];
  /** Sorted by rule id, then first path — never by discovery order. */
  readonly findings: readonly LintFinding[];
  readonly errorCount: number;
  readonly warnCount: number;
  /** Rule ids the manifest configured that no rule in the registry answers to. */
  readonly unknownRules: readonly string[];
  /** Rule ids the manifest turned off, so a silent report can say why it is silent. */
  readonly disabledRules: readonly LintRuleId[];
}
