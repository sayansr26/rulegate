import { basenamePosix, escapesRoot, normalizeRelative } from '../../fs/paths.js';
import type { LintFindingInit, LintRule } from '../types.js';

/**
 * Inline code spans. Nothing outside backticks is ever considered.
 *
 * Prose mentioning `src/index.ts` without backticks is not a reference this rule can
 * tell apart from a sentence, and guessing is how a linter earns its reputation for
 * noise. A rule people mute reports nothing, so the bar for reporting is high on
 * purpose — every extra restriction below costs a true positive and buys silence on a
 * repository that is fine.
 */
const CODE_SPAN = /`([^`\n]+)`/g;

/** Characters that mean the token is not one concrete path. */
const NOT_A_PATH = /[\s*?[\]{}<>|"'()!$,;=]/;

/**
 * Is this code span a repo-relative path worth checking?
 *
 * Every restriction here was bought with a false positive on a *correct* repository,
 * and each costs true positives to buy silence. That trade is the right way round: this
 * rule reads prose and guesses, and the first time it cries wolf on a clean tree
 * somebody turns the whole linter off.
 */
function isCandidate(token: string): boolean {
  // A glob, a brace expansion, or anything containing whitespace or shell punctuation:
  // not one concrete path, and the only test here that no later check subsumes.
  if (NOT_A_PATH.test(token)) return false;
  // **Must name a file, not a directory.** A directory in prose is very often one
  // created on demand: `.rulegate/backup/` does not exist until something is backed up,
  // and calling it stale is wrong on every repository that has never needed one.
  if (!basenamePosix(token).includes('.')) return false;
  // The three below are a **cheap pre-filter, not the correctness guard** — and saying
  // so is the point. Mutation testing showed the anchor check in `check` subsumes every
  // one of them: a bare `state.json`, an `@scope/pkg`, a `https://…` URL and an
  // absolute path all fail it too, because their first segment is not a directory of
  // this repository. They stay because they bound the candidate set before any
  // filesystem probe, and are documented as redundant rather than left to look
  // load-bearing. Two others (`token.includes(':')`, `token.startsWith('@')`) were
  // deleted outright: they bought nothing the anchor check does not already give.
  if (!token.includes('/')) return false;
  if (token.startsWith('/') || token.startsWith('~')) return false;
  if (token.startsWith('..')) return false;
  return true;
}

/**
 * A canonical rule that cites a file the repository does not have.
 *
 * `warn` by default. This is the noisiest rule in the set by construction — it reads
 * prose and guesses — and a false positive here is the one most likely to make somebody
 * turn the linter off entirely.
 */
export const stalePath: LintRule = {
  id: 'stale-path',
  defaultSeverity: 'warn',
  description: 'a rule references a file that no longer exists',
  check: async (ctx) => {
    // Candidate -> the rule files citing it, so one missing path cited by three rules is
    // one finding rather than three. Insertion order is canonical rule order, which the
    // engine sorts afterwards anyway.
    const cited = new Map<string, Set<string>>();
    const roots = new Set<string>();

    for (const rule of ctx.canonical.rules) {
      for (const [, token] of rule.body.matchAll(CODE_SPAN)) {
        if (token === undefined) continue;
        const trimmed = token.endsWith('/') ? token.slice(0, -1) : token;
        if (!isCandidate(trimmed)) continue;
        const rel = normalizeRelative(trimmed);
        if (rel === '' || escapesRoot(rel)) continue;
        // **The first segment must exist.** `src/docs.ts` in a rule about scaffolding an
        // adapter is relative to the generated adapter directory, not to the repository
        // — and this repository has no root `src/` at all. Prose cannot say what a path
        // is anchored to, but an unrecognised first segment is good evidence it is not
        // anchored here, and treating that as "not our path" is the safe direction.
        roots.add(rel.split('/')[0] ?? '');
        (cited.get(rel) ?? cited.set(rel, new Set()).get(rel)!).add(rule.path);
      }
    }

    // One probe per distinct first segment, rather than one per candidate.
    const anchored = new Set<string>();
    for (const root of roots) {
      if (root !== '' && (await ctx.fs.exists(root))) anchored.add(root);
    }

    const out: LintFindingInit[] = [];
    for (const [rel, sources] of cited) {
      if (!anchored.has(rel.split('/')[0] ?? '')) continue;
      if (await ctx.fs.exists(rel)) continue;
      const where = [...sources].sort();
      out.push({
        // The rule file is the path a reader has to open to fix this, so it is the path
        // reported — `lint.ignore` then suppresses by the rule being linted rather than
        // by the missing file, which is the one of the two that exists to be globbed.
        paths: where,
        message: `references \`${rel}\`, which does not exist`,
        hint: 'update the path in the rule, or remove the reference',
      });
    }
    return out;
  },
};
