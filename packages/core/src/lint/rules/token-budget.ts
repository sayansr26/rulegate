import type { LintFindingInit, LintRule } from '../types.js';

/**
 * A tool's loaded context over the budget the repository set for it.
 *
 * **Silent unless a budget is configured**, and there is no default to fall back on.
 * `AdapterDocs.limits` cannot supply one: it is in bytes, and T024's estimator must not
 * leak into a check it cannot answer. So `lint.tokenBudget` in the manifest is the
 * opt-in, and a tool absent from it is never reported. That is why the default severity
 * is `warn` rather than `off` — configuring a budget is already the deliberate act, and
 * requiring a second one would mean a budget that does nothing until you also remember
 * to turn the rule on.
 *
 * Counts what `doctor` counts, which is `role: 'instructions'` only: settings and
 * permissions files are configuration, not context, and a budget that charges for them
 * is a falsehood.
 */
export const tokenBudget: LintRule = {
  id: 'token-budget',
  defaultSeverity: 'warn',
  description: 'a tool loads more context than the manifest budgets for it',
  check: (ctx) => {
    const out: LintFindingInit[] = [];
    // In report order, which `buildDoctorReport` sorts by tool id — never over the
    // budget map's insertion order, which is the manifest's authoring order.
    for (const tool of ctx.report.tools) {
      const budget = ctx.tokenBudget[tool.name];
      if (budget === undefined) continue;
      if (tool.loadedTokens <= budget) continue;
      out.push({
        paths: tool.files.filter((f) => f.loaded).flatMap((f) => f.paths),
        tool: tool.name,
        // `~` because every displayed estimate carries one: exactness is explicitly not
        // the goal, and a bare number invites a precision the estimator never claimed.
        message: `${tool.toolName} loads ~${String(tool.loadedTokens)} tokens, over its budget of ${String(budget)}.`,
        hint: 'shorten the rules this tool loads, or raise `lint.tokenBudget` for it',
      });
    }
    return out;
  },
};
