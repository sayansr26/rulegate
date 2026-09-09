import type { DoctorWarning, DoctorWarningCode } from '../../doctor/types.js';
import type { LintContext, LintFindingInit, LintRule } from '../types.js';

/**
 * Project a `doctor` warning onto lint findings.
 *
 * The condition is *not* recomputed here. Both commands answer from the one
 * `DoctorReport` the engine built, so a user who runs `doctor` and `lint` may see the
 * same condition twice — they asked two questions — but the two can never disagree
 * about whether it holds. Recomputing would reintroduce exactly the divergence T079
 * found between `doctor` and `check`.
 */
function fromDoctor(
  code: DoctorWarningCode,
  hint: string,
  toFinding: (w: DoctorWarning) => LintFindingInit = (w) => ({
    paths: w.paths,
    message: w.message,
    hint,
    ...(w.tool === undefined ? {} : { tool: w.tool }),
    ...(w.source === undefined ? {} : { source: w.source }),
  }),
): (ctx: LintContext) => readonly LintFindingInit[] {
  return (ctx) => ctx.report.warnings.filter((w) => w.code === code).map(toFinding);
}

/**
 * An instruction file over a cap the tool's own documentation states.
 *
 * `error` by default, and this is the one rule that earns it: the cap is a published
 * number from `AdapterDocs.limits`, exceeding it means content is silently dropped, and
 * no correct repository is permanently over a limit its own tool declares. Measured in
 * **bytes** on normalized text — `limits` is a byte cap (Codex's
 * `project_doc_max_bytes`), and the token estimator must not leak into a check it
 * cannot answer.
 */
export const oversizedFile: LintRule = {
  id: 'oversized-file',
  defaultSeverity: 'error',
  description: 'an instruction file exceeds a limit the tool documents',
  check: fromDoctor(
    'W_OVER_LIMIT',
    'split the rule across files, or narrow its `tools:` selector so fewer tools load it',
  ),
};

/**
 * One tool receiving the same canonical rules through more than one mechanism.
 *
 * `warn`, never `error`, and the reason is the standing example the whole severity
 * policy was written around: enabling `copilot`, `codex` and `claude-code` together
 * sends Copilot the same rules three times, and that is a **correct** configuration
 * somebody may want. A gate that fails on it is a gate people mute, and a muted linter
 * reports nothing at all (T027, T047, T072).
 */
export const conflictingRules: LintRule = {
  id: 'conflicting-rules',
  defaultSeverity: 'warn',
  description: 'one tool loads the same canonical rules through several mechanisms',
  check: fromDoctor(
    'W_DUPLICATE_LOAD',
    'disable one of the overlapping adapters, or narrow the rule’s `tools:` selector',
  ),
};
