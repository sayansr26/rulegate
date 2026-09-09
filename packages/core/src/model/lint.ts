/**
 * How loud a lint finding is, and whether it is heard at all.
 *
 * `off` is a severity rather than an absence so that turning a rule off is a statement
 * in the manifest a reader can see, not the silence of never having mentioned it.
 */
export type LintSeverity = 'error' | 'warn' | 'off';

export const LINT_SEVERITIES: readonly LintSeverity[] = ['error', 'warn', 'off'];

export function isLintSeverity(value: string): value is LintSeverity {
  return (LINT_SEVERITIES as readonly string[]).includes(value);
}

/**
 * The `lint:` block of the manifest.
 *
 * Read by `rulegate lint` and by nothing else — no adapter sees it and no renderer
 * consumes it, so adding keys here changes no generated artifact. That is deliberate:
 * a repository can adopt, tune or silence the linter without a single byte of its
 * tool configs moving, and therefore without a `check` failure.
 */
export interface LintConfig {
  /**
   * Rule id -> severity, overriding each rule's own default.
   *
   * Keys are not validated here. The parser does not know which rules exist — the
   * registry lives in `lint/` and the roster is a parameter, the same split
   * `detectTools` and `computePlan` use — so an unknown id is reported by the engine,
   * where the answer is actually known.
   */
  readonly rules: Readonly<Record<string, LintSeverity>>;
  /**
   * Repo-relative POSIX globs no finding may be reported against.
   *
   * Separate from `options.ignore`, which scopes `doctor`'s orphan scan. They will
   * often hold the same fixture directories, but one suppresses a *file* from being
   * considered an instruction file at all and this one suppresses *findings* about
   * files that genuinely are. Collapsing them would mean a repository could not
   * silence a noisy rule without also hiding the files from `doctor`.
   */
  readonly ignore: readonly string[];
  /**
   * Tool id -> the estimated-token budget that tool's loaded context must stay under.
   *
   * Configured, never derived. `AdapterDocs.limits` is in **bytes** — Codex's
   * `project_doc_max_bytes` is a byte cap — and T024's estimator must not leak into a
   * check it cannot answer, so there is no default to fall back on. A tool absent from
   * this map has no budget and the rule stays silent for it.
   */
  readonly tokenBudget: Readonly<Record<string, number>>;
}

export const DEFAULT_LINT_CONFIG: LintConfig = {
  rules: {},
  ignore: [],
  tokenBudget: {},
};
