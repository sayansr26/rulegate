import { join, resolve } from 'node:path';
import { exists, isDir, isRecord, ls, read, readJson } from './read.js';

/**
 * The settings pass, pure half (decision P4). Everything here computes what the pass would
 * change and never writes: the audit and the setup state need the same answers, and the
 * writer (`src/settings-writer/`, T109) writes exactly the `next` planned here, so there is
 * one merge and a preview cannot promise something the apply does differently.
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

export const PLUGIN_ID = 'rulegate@rulegate';
export const MARKETPLACE_NAME = 'rulegate';
/** An agent-os install still enabled next to this one prints the session block twice (T114). */
export const LEGACY_PLUGIN_ID = 'agent-os@sayan-plugins';
export const LEGACY_MARKETPLACE = 'sayan-plugins';
/** What `claude plugin marketplace add sayansr26/rulegate --scope project` declares (D4). */
export const MARKETPLACE_ENTRY = {
  source: { source: 'github', repo: 'sayansr26/rulegate' },
} as const;

/** The settings file that decides `enabledPlugins[id]`: the most local one that sets it. */
export type PluginScope = 'local' | 'project' | 'user';

export function enabledAt(
  root: string,
  claudeDir: string,
  id: string,
): { readonly value: boolean; readonly scope: PluginScope } | undefined {
  for (const [scope, p] of [
    ['local', join(root, '.claude/settings.local.json')],
    ['project', join(root, '.claude/settings.json')],
    ['user', join(claudeDir, 'settings.json')],
  ] as const) {
    const value = enabledIn(p, id);
    if (value !== undefined) return { value, scope };
  }
  return undefined;
}

/** `enabledPlugins[id]` as one settings file sets it, whatever the other scopes say. */
export function enabledIn(file: string, id: string): boolean | undefined {
  const s = readJson(file);
  return isRecord(s) && isRecord(s.enabledPlugins) && typeof s.enabledPlugins[id] === 'boolean'
    ? s.enabledPlugins[id]
    : undefined;
}

/** `enabledPlugins[id]` from the first settings file that sets it, most local first. */
export function enabledFlag(root: string, claudeDir: string, id: string): boolean | undefined {
  return enabledAt(root, claudeDir, id)?.value;
}

/** `Bash(git commit *)` and `Bash(git commit:*)` are the same rule to Claude Code. */
export const normRule = (r: string): string => r.replace(/:\*\)$/, ' *)').replace(/\s+/g, ' ');

/**
 * `~/.claude`, or `CLAUDE_CONFIG_DIR` when set — the environment is the caller's to pass.
 * An empty value counts as unset (`||`, not `??`) and the result is always absolute: with
 * `CLAUDE_CONFIG_DIR=''` the user's settings resolved to a relative `settings.json`, which
 * an `--apply` would have written into whatever directory it ran from.
 */
export function claudeHome(env: NodeJS.ProcessEnv, home: string): string {
  return resolve(env.CLAUDE_CONFIG_DIR || join(home, '.claude'));
}

export function settingsPath(scope: Scope, root: string, claudeDir: string): string {
  return scope === 'user' ? join(claudeDir, 'settings.json') : join(root, '.claude/settings.json');
}

export const isRulegateProject = (root: string): boolean => isDir(join(root, '.rulegate'));

/**
 * Where the task rule goes: the user's `CLAUDE.md`, a new canonical rule in a Rulegate
 * project (its `CLAUDE.md` is generated), or the project's own `CLAUDE.md`. The writer writes
 * here and nowhere else, which `invariants.test.ts` pins.
 */
export function ruleTarget(scope: Scope, root: string, claudeDir: string): string {
  if (scope === 'user') return join(claudeDir, 'CLAUDE.md');
  return isRulegateProject(root) ? join(root, TASK_RULE_FILE) : join(root, 'CLAUDE.md');
}

export type EnvState = 'added' | 'present' | 'conflict';

/**
 * agent-os's marketplace in `extraKnownMarketplaces`: `retire` swaps it for Rulegate's,
 * `blocked` leaves it while agent-os is still enabled here, since removing the marketplace
 * of a plugin that is still loading is how a session ends up with neither (T114).
 */
export type MarketplaceState = 'retire' | 'blocked';

export interface SettingsPlan {
  readonly status: 'changed' | 'unchanged' | 'invalid';
  readonly denyAdded: readonly string[];
  readonly env: EnvState | undefined;
  readonly current: unknown;
  readonly marketplace?: MarketplaceState;
  /** The merged file, when `status` is `changed`. The writer writes exactly this. */
  readonly next?: string;
}

export interface SettingsOptions {
  readonly todo?: boolean;
  /**
   * `true` retires a declared `sayan-plugins` marketplace in favour of `rulegate`, `false`
   * reports it as `blocked`; `undefined` does not look. Only the project file is ever asked:
   * a user-scope declaration serves every agent-os project on the machine, and the ones not
   * yet migrated still need it.
   */
  readonly retireMarketplace?: boolean | undefined;
}

/**
 * `extraKnownMarketplaces` without agent-os's entry, and with Rulegate's — the user's own
 * entry for `rulegate` wins if there is one. Every other key keeps its place and value.
 */
function swapMarketplace(markets: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(markets)) if (k !== LEGACY_MARKETPLACE) out[k] = v;
  if (!(MARKETPLACE_NAME in out)) out[MARKETPLACE_NAME] = MARKETPLACE_ENTRY;
  return out;
}

/** Plan the merge into one settings.json, given its current text (`undefined`: absent). */
export function planSettings(
  text: string | undefined,
  { todo = true, retireMarketplace }: SettingsOptions = {},
): SettingsPlan {
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
  const markets = isRecord(settings.extraKnownMarketplaces)
    ? settings.extraKnownMarketplaces
    : undefined;
  const marketplace: MarketplaceState | undefined =
    retireMarketplace === undefined || markets === undefined || !(LEGACY_MARKETPLACE in markets)
      ? undefined
      : retireMarketplace
        ? 'retire'
        : 'blocked';
  const withMarket = marketplace === undefined ? {} : { marketplace };
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

  if (denyAdded.length === 0 && env !== 'added' && marketplace !== 'retire') {
    return { status: 'unchanged', denyAdded, env, current, ...withMarket };
  }
  const next: Record<string, unknown> = { ...settings };
  if (denyAdded.length > 0) next.permissions = { ...perms, deny: [...deny, ...denyAdded] };
  if (env === 'added') next.env = { ...envBlock, [TODO_ENV]: '1' };
  if (marketplace === 'retire' && markets !== undefined) {
    next.extraKnownMarketplaces = swapMarketplace(markets);
  }
  return {
    status: 'changed',
    denyAdded,
    env,
    current,
    ...withMarket,
    next: `${JSON.stringify(next, null, 2)}\n`,
  };
}

export interface TaskRulePlan {
  /**
   * `exists`: a Rulegate project already has a `working-agreement.md` without the rule. It
   * is a canonical rule the user wrote, so nothing is planned over it — the rule is theirs
   * to add by hand.
   */
  readonly status: 'present' | 'add' | 'no-file' | 'exists';
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
export function insertTaskRule(input: string): { next: string; section: string } {
  // A CRLF file gets CRLF: the insert is built in LF and converted back, so the result has
  // one line ending throughout. Only a file that is CRLF everywhere is converted — for a
  // mixed one, rewriting its existing lines would be a change nobody planned.
  const crlf = input.includes('\r\n') && !/(^|[^\r])\n/.test(input);
  const text = crlf ? input.replace(/\r\n/g, '\n') : input;
  const heading = /^##\s+Operator preferences\s*$/m.exec(text);
  let next: string;
  // The user's bytes are spliced around, never trimmed or collapsed: a trailing "  " is a
  // Markdown hard break and a blank run may sit inside a fence, and the preview promised an
  // insert. Only the inserted text adapts, padding up to one blank line before it.
  const pad = (before: string): string =>
    before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  if (heading) {
    const start = heading.index + heading[0].length;
    const rest = text.slice(start);
    const nextHeading = rest.search(/^##\s+/m);
    const end = nextHeading === -1 ? text.length : start + nextHeading;
    const before = text.slice(0, end);
    const after = text.slice(end);
    next = `${before}${pad(before)}${TASK_RULE}\n${after === '' ? '' : '\n'}${after}`;
  } else {
    next = `${text}${pad(text)}## Working agreement\n\n${TASK_RULE}\n`;
  }
  return {
    next: crlf ? next.replace(/\n/g, '\r\n') : next,
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
    if (exists(join(root, TASK_RULE_FILE))) return { status: 'exists', file: TASK_RULE_FILE };
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
  // Retired only once agent-os is off in this project — after `claude plugin disable`, which
  // the migration runs first — so this pass never pulls the marketplace from under a
  // plugin that is still loading. The file being rewritten is read on its own as well: a
  // developer's local `false` hides the committed `true` from the effective flag, and
  // retiring then ships every teammate an enabled agent-os with no marketplace.
  const retireMarketplace =
    scope === 'project'
      ? enabledFlag(root, claudeDir, LEGACY_PLUGIN_ID) !== true &&
        enabledIn(settingsFile, LEGACY_PLUGIN_ID) !== true
      : undefined;
  return {
    scope,
    settingsFile,
    settings: planSettings(read(settingsFile), { retireMarketplace }),
    rule: planTaskRule(scope, root, claudeDir),
  };
}

/** What the writer did not do, per item, and why — `describeScope` reports it in place. */
export interface Refusal {
  readonly item: 'settings' | 'rule';
  readonly file: string;
  readonly reason: string;
}

export interface Outcome {
  readonly dry: boolean;
  readonly refused?: readonly Refusal[];
  readonly backups?: readonly string[];
}

export function describeScope(
  p: ScopePlan,
  { dry, refused = [], backups = [] }: Outcome,
): string[] {
  const verb = dry ? 'would add' : 'added';
  const s = p.settings;
  const lines = [`${p.scope === 'user' ? 'USER' : 'PROJECT'}  ${p.settingsFile}`];
  const refusedSettings = refused.find((r) => r.item === 'settings');
  const refusedRule = refused.find((r) => r.item === 'rule');
  // A preview names a refusal as one to come, so the user never confirms a change the
  // writer will then decline.
  const refusal = (reason: string): string =>
    dry ? `will be refused — ${reason}` : `refused — ${reason}; nothing written`;
  if (refusedSettings !== undefined && s.status !== 'invalid') {
    lines.push(`  ${refusal(refusedSettings.reason)}`);
  } else if (s.status === 'invalid') {
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
    if (s.marketplace === 'retire') {
      lines.push(
        `  extraKnownMarketplaces  ${dry ? 'would replace' : 'replaced'} ${LEGACY_MARKETPLACE} (agent-os) with ${MARKETPLACE_NAME}`,
      );
    } else if (s.marketplace === 'blocked') {
      lines.push(
        `  extraKnownMarketplaces  ${LEGACY_MARKETPLACE} (agent-os) kept while ${LEGACY_PLUGIN_ID} is enabled here or in this file — disable it first`,
      );
    }
  }
  const r = p.rule;
  if (refusedRule !== undefined && r.status === 'add') {
    lines.push(`  ${r.file}  ${refusal(refusedRule.reason)}`);
  } else if (r.status === 'add') {
    lines.push(`  ${r.file}  ${verb} the task-tracking rule (${r.how ?? ''})`);
    // The generated CLAUDE.md carries the new rule only after a sync, and the plugin cannot
    // run one: its only spawn is read-only git. The skill runs it.
    if (!dry && r.file === TASK_RULE_FILE) lines.push('  now run `rulegate sync`');
  } else if (r.status === 'present') lines.push(`  ${r.file}  task-tracking rule already there`);
  else if (r.status === 'exists') {
    lines.push(
      `  ${r.file}  exists without the task-tracking rule — left alone; add the rule by hand, then run \`rulegate sync\``,
    );
  } else lines.push(`  ${r.file}  absent — /rulegate:init builds it`);
  for (const b of backups) lines.push(`  backup  ${b}`);
  return lines;
}
