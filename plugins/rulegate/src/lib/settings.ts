import { join } from 'node:path';
import { isDir, isRecord, ls, read } from './read.js';

/**
 * The settings pass, pure half (decision P4). Everything here computes what the pass would
 * change and never writes: the audit and the setup state need these answers before T109's
 * writer exists, and a writer built on a pure planner can be tested without a filesystem.
 *
 * Three things, at project scope, user scope, or both:
 *
 *   settings.json  permissions.deny  += the git write-protection rules
 *                  env.CLAUDE_CODE_ENABLE_TODO_TOOLS = "1"
 *   CLAUDE.md      the task-tracking rule
 *
 * Merges, never replaces: existing keys, allow and deny rules, and a value the user set for
 * the env flag all survive. **The Rulegate twist:** in a project with `.rulegate/`, the
 * project `CLAUDE.md` is generated, so the task rule is planned as a new rule under
 * `.rulegate/rules/` followed by `rulegate sync` — writing it into `CLAUDE.md` would be
 * the hand-edit the plugin's own PreToolUse guard exists to refuse.
 */

export const TODO_ENV = 'CLAUDE_CODE_ENABLE_TODO_TOOLS';

export const TASK_RULE = `- **Always track work with the task tool (TaskCreate / TaskUpdate).** Any request
  with more than one step gets a task list before work starts: one task per
  deliverable, marked \`in_progress\` when started and \`completed\` only when
  verified. Keep it current as scope changes, including work delegated to
  subagents, so I can see what is done, running and left at any moment.`;

/** The canonical rule the task rule becomes in a Rulegate project. */
export const TASK_RULE_FILE = '.rulegate/rules/working-agreement.md';

/**
 * Every git command that changes the repository. Read-only inspection (status, log, diff,
 * show, blame, …) stays available. The first five close the flag forms that would
 * otherwise walk past a per-subcommand rule — `references/git-permissions.md` explains
 * each judgment call.
 */
export const GIT_DENY: readonly string[] = Object.freeze([
  'Bash(git -C*)',
  'Bash(git -c*)',
  'Bash(git --git-dir*)',
  'Bash(git --work-tree*)',
  'Bash(git --exec-path*)',
  'Bash(git add *)',
  'Bash(git am *)',
  'Bash(git apply *)',
  'Bash(git bisect *)',
  'Bash(git branch *)',
  'Bash(git checkout *)',
  'Bash(git cherry-pick *)',
  'Bash(git clean *)',
  'Bash(git clone *)',
  'Bash(git commit *)',
  'Bash(git config *)',
  'Bash(git fast-import *)',
  'Bash(git filter-branch *)',
  'Bash(git gc *)',
  'Bash(git init *)',
  'Bash(git merge *)',
  'Bash(git mv *)',
  'Bash(git notes *)',
  'Bash(git prune *)',
  'Bash(git pull *)',
  'Bash(git push *)',
  'Bash(git rebase *)',
  'Bash(git reflog *)',
  'Bash(git remote *)',
  'Bash(git repack *)',
  'Bash(git replace *)',
  'Bash(git reset *)',
  'Bash(git restore *)',
  'Bash(git revert *)',
  'Bash(git rm *)',
  'Bash(git stash *)',
  'Bash(git submodule *)',
  'Bash(git switch *)',
  'Bash(git symbolic-ref *)',
  'Bash(git tag *)',
  'Bash(git update-ref *)',
  'Bash(git worktree *)',
]);

export type Scope = 'project' | 'user';

/** `Bash(git commit *)` and `Bash(git commit:*)` are the same rule to Claude Code. */
export const normRule = (r: string): string => r.replace(/:\*\)$/, ' *)').replace(/\s+/g, ' ');

/** `~/.claude`, or `CLAUDE_CONFIG_DIR` when set — resolved by the caller, never here. */
export function claudeHome(env: NodeJS.ProcessEnv, home: string): string {
  return env.CLAUDE_CONFIG_DIR ?? join(home, '.claude');
}

export function settingsPath(scope: Scope, root: string, claudeDir: string): string {
  return scope === 'user' ? join(claudeDir, 'settings.json') : join(root, '.claude/settings.json');
}

export const isRulegateProject = (root: string): boolean => isDir(join(root, '.rulegate'));

export type EnvState = 'added' | 'present' | 'conflict';

export interface SettingsPlan {
  readonly status: 'changed' | 'unchanged' | 'invalid';
  readonly denyAdded: readonly string[];
  readonly env: EnvState | undefined;
  readonly current: unknown;
  /** The merged file, when `status` is `changed`. T109 writes exactly this. */
  readonly next?: string;
}

/** Plan the merge into one settings.json, given its current text (`undefined`: absent). */
export function planSettings(text: string | undefined, { todo = true } = {}): SettingsPlan {
  let settings: Record<string, unknown> = {};
  if (text !== undefined) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed)) throw new Error('not an object');
      settings = parsed;
    } catch {
      return { status: 'invalid', denyAdded: [], env: undefined, current: undefined };
    }
  }
  const perms = isRecord(settings.permissions) ? settings.permissions : {};
  const deny = Array.isArray(perms.deny)
    ? perms.deny.filter((r): r is string => typeof r === 'string')
    : [];
  const have = new Set(deny.map(normRule));
  const denyAdded = GIT_DENY.filter((r) => !have.has(normRule(r)));

  const envBlock = isRecord(settings.env) ? settings.env : {};
  let env: EnvState | undefined;
  const current = envBlock[TODO_ENV];
  if (todo) {
    // "true" and "1" are both truthy to Claude Code; an existing value is the user's
    // choice and is left alone rather than normalised.
    if (current === undefined) env = 'added';
    else env = current === '1' || current === 'true' || current === true ? 'present' : 'conflict';
  }

  if (denyAdded.length === 0 && env !== 'added') {
    return { status: 'unchanged', denyAdded, env, current };
  }
  const next: Record<string, unknown> = { ...settings };
  if (denyAdded.length > 0) next.permissions = { ...perms, deny: [...deny, ...denyAdded] };
  if (env === 'added') next.env = { ...envBlock, [TODO_ENV]: '1' };
  return {
    status: 'changed',
    denyAdded,
    env,
    current,
    next: `${JSON.stringify(next, null, 2)}\n`,
  };
}

export interface TaskRulePlan {
  readonly status: 'present' | 'add' | 'no-file';
  /** Repo-relative for project scope, absolute for user scope. */
  readonly file: string;
  readonly how?: string;
  readonly next?: string;
}

/**
 * Put the task rule into an existing CLAUDE.md: under an "Operator preferences" heading when
 * there is one, so it lands with the other instructions about how to work, else in a new
 * "Working agreement" section at the end.
 */
export function insertTaskRule(text: string): { next: string; section: string } {
  const heading = /^##\s+Operator preferences\s*$/m.exec(text);
  let next: string;
  if (heading) {
    const start = heading.index + heading[0].length;
    const rest = text.slice(start);
    const nextHeading = rest.search(/^##\s+/m);
    const end = nextHeading === -1 ? text.length : start + nextHeading;
    next = `${text.slice(0, end).trimEnd()}\n\n${TASK_RULE}\n\n${text.slice(end)}`;
  } else {
    // `trimEnd`, not `replace(/\s*$/)`: the regex retries from every whitespace run and is
    // quadratic, so a CLAUDE.md of padding hung the setup state.
    next = `${text.trimEnd()}\n\n## Working agreement\n\n${TASK_RULE}\n`;
  }
  return {
    next: next.replace(/\n{4,}/g, '\n\n\n'),
    section: heading ? 'Operator preferences' : 'Working agreement',
  };
}

export function planTaskRule(scope: Scope, root: string, claudeDir: string): TaskRulePlan {
  if (scope === 'user') {
    const file = join(claudeDir, 'CLAUDE.md');
    const text = read(file);
    if (text === undefined) {
      return {
        status: 'add',
        file,
        how: 'new file',
        next: `# Personal working agreement\n\n${TASK_RULE}\n`,
      };
    }
    if (/TaskCreate/.test(text)) return { status: 'present', file };
    const { next, section } = insertTaskRule(text);
    return { status: 'add', file, how: section, next };
  }

  if (isRulegateProject(root)) {
    // The generated CLAUDE.md carries every rule, so it answers "present" for a rule in
    // `.rulegate/rules/` once synced; the rules are read too, for one added but not synced.
    const inRules = ls(join(root, '.rulegate/rules')).some((f) =>
      /TaskCreate/.test(read(join(root, '.rulegate/rules', f)) ?? ''),
    );
    if (inRules || /TaskCreate/.test(read(join(root, 'CLAUDE.md')) ?? '')) {
      return { status: 'present', file: TASK_RULE_FILE };
    }
    return {
      status: 'add',
      file: TASK_RULE_FILE,
      how: 'new rule, then `rulegate sync`',
      next: `---\ndescription: Working agreement\ntools: [claude-code]\n---\n\n${TASK_RULE}\n`,
    };
  }

  // A project CLAUDE.md is never created: it is the project's own always-loaded context,
  // and a script inventing one leaves a stub nobody owns.
  const text = read(join(root, 'CLAUDE.md'));
  if (text === undefined) return { status: 'no-file', file: 'CLAUDE.md' };
  if (/TaskCreate/.test(text)) return { status: 'present', file: 'CLAUDE.md' };
  const { next, section } = insertTaskRule(text);
  return { status: 'add', file: 'CLAUDE.md', how: section, next };
}

export interface ScopePlan {
  readonly scope: Scope;
  readonly settingsFile: string;
  readonly settings: SettingsPlan;
  readonly rule: TaskRulePlan;
}

export function planScope(scope: Scope, root: string, claudeDir: string): ScopePlan {
  const settingsFile = settingsPath(scope, root, claudeDir);
  return {
    scope,
    settingsFile,
    settings: planSettings(read(settingsFile)),
    rule: planTaskRule(scope, root, claudeDir),
  };
}

export function describeScope(p: ScopePlan, { dry }: { dry: boolean }): string[] {
  const verb = dry ? 'would add' : 'added';
  const s = p.settings;
  const lines = [`${p.scope === 'user' ? 'USER' : 'PROJECT'}  ${p.settingsFile}`];
  if (s.status === 'invalid') {
    lines.push('  not valid JSON — left alone; fix it and re-run');
  } else {
    const have = GIT_DENY.length - s.denyAdded.length;
    lines.push(
      s.denyAdded.length > 0
        ? `  permissions.deny   ${verb} ${String(s.denyAdded.length)} git write rule(s)${have > 0 ? ` (${String(have)} already there)` : ''}`
        : '  permissions.deny   git write protection already complete',
    );
    if (s.env === 'added') lines.push(`  env.${TODO_ENV}  ${verb} "1"`);
    else if (s.env === 'present') lines.push(`  env.${TODO_ENV}  already on`);
    else if (s.env === 'conflict')
      lines.push(`  env.${TODO_ENV}  is "${String(s.current)}" — left as set`);
  }
  const r = p.rule;
  if (r.status === 'add')
    lines.push(`  ${r.file}  ${verb} the task-tracking rule (${r.how ?? ''})`);
  else if (r.status === 'present') lines.push(`  ${r.file}  task-tracking rule already there`);
  else lines.push(`  ${r.file}  absent — /rulegate:init builds it`);
  return lines;
}
