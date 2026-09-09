import { buildDoctorReport } from '../doctor/report.js';
import { computePlan } from '../pipeline/plan.js';
import { isSuppressed, severityFor, sortFindings, unknownRuleIds } from './config.js';
import { RULES } from './rules/index.js';
import type { Adapter } from '../adapter/adapter.js';
import type { LintConfig } from '../model/lint.js';
import type { LintFinding, LintReport, LintRule, LintRuleId } from './types.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export interface LintInput {
  readonly repoRoot: string;
  /** Rooted at the repository. */
  readonly fs: ReadOnlyFileSystem;
  readonly adapters: readonly Adapter[];
  /** Rooted at the user's home directory, when the caller chooses to supply one. */
  readonly globalFs?: ReadOnlyFileSystem;
  /**
   * Run these rules instead of the shipped registry.
   *
   * For tests, which need a rule that fires on demand to exercise severity and
   * suppression without depending on what the real rules happen to find. Production
   * callers leave it unset.
   */
  readonly rules?: readonly LintRule[];
}

/**
 * Lint a repository's canonical rules and the context they generate.
 *
 * Reads only. It holds a `ReadOnlyFileSystem`, never renders, never writes, and lives
 * outside `pipeline/` — which `invariants.test.ts` pins to exactly `apply.ts`,
 * `plan.ts` and `verify.ts` — for the same reason `doctor/` does.
 *
 * The plan is computed once here and handed to `buildDoctorReport`, so the tree is
 * walked one time and both halves of the answer describe the same repository. See
 * `DoctorInput.plan`.
 */
export async function runLint(input: LintInput): Promise<LintReport> {
  const { repoRoot, fs, adapters, globalFs } = input;
  const registry = input.rules ?? RULES;

  const plan = await computePlan({ repoRoot, fs, adapters });
  const report = await buildDoctorReport({
    repoRoot,
    fs,
    adapters,
    plan,
    ...(globalFs === undefined ? {} : { globalFs }),
  });

  // A plan that would not render is reported and nothing is linted against it. Rules
  // read `plan.canonical`, which on a parse failure is a fallback rather than what the
  // author wrote — so every finding would be about a repository that does not exist,
  // and their absence would read as "clean".
  if (plan.errors.length > 0) {
    return {
      findings: [],
      errorCount: 0,
      warnCount: 0,
      unknownRules: [],
      disabledRules: [],
      errors: plan.errors,
    };
  }

  const config: LintConfig = plan.canonical.manifest.lint;
  const ctx = {
    report,
    plan,
    canonical: plan.canonical,
    adapters,
    fs,
    tokenBudget: config.tokenBudget,
  };

  const findings: LintFinding[] = [];
  const disabledRules: LintRuleId[] = [];

  // Sequentially and in registry order, never `Promise.all`. The reason is the one
  // `detect/engine.ts` records: a loop that appends in settle order produces a
  // different report on a slow disk, and that is a bug nobody reproduces locally.
  for (const rule of registry) {
    const severity = severityFor(rule, config);
    if (severity === 'off') {
      disabledRules.push(rule.id);
      continue;
    }
    for (const found of await rule.check(ctx)) {
      if (isSuppressed(found, config)) continue;
      findings.push({ ...found, rule: rule.id, severity });
    }
  }

  const sorted = sortFindings(findings);
  return {
    findings: sorted,
    errorCount: sorted.filter((f) => f.severity === 'error').length,
    warnCount: sorted.filter((f) => f.severity === 'warn').length,
    unknownRules: unknownRuleIds(config, registry),
    disabledRules,
    errors: [],
  };
}
