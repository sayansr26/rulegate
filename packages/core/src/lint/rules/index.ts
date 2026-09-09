import { conflictingRules, oversizedFile } from './from-doctor.js';
import { stalePath } from './stale-path.js';
import { tokenBudget } from './token-budget.js';
import type { LintRule } from '../types.js';

/**
 * The shipped rule set, in the order findings are computed.
 *
 * Report order does not depend on it — `sortFindings` keys on the rule id — so this
 * list is free to grow anywhere. The two rules that project a `doctor` warning come
 * first because they cost nothing beyond a filter.
 */
export const RULES: readonly LintRule[] = [oversizedFile, conflictingRules, stalePath, tokenBudget];
