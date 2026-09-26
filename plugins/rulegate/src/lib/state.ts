import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { agentOsInstall, disableCommand } from './legacy.js';
import { planMemoryMigration } from './migrate.js';
import { isDir, isRecord, ls, read, readJson } from './read.js';
import { refusals } from './refusals.js';
import {
  GIT_DENY,
  LEGACY_MARKETPLACE,
  LEGACY_PLUGIN_ID,
  MARKETPLACE_NAME,
  PLUGIN_ID,
  enabledFlag,
  planScope,
  type MarketplaceState,
  type Scope,
} from './settings.js';

/**
 * Setup state — is this a fresh setup, a repair, or already healthy?
 *
 * `/rulegate:init` starts here so it never re-scaffolds a project that is set up, and names
 * exactly what a repair has to touch. Read-only: every check is a file read, and the
 * settings checks are the settings pass's own dry-run planner.
 *
 * The plugin check reads Claude Code's own records (`installed_plugins.json`,
 * `enabledPlugins`, the marketplace cache) instead of calling the `claude` CLI, so it works
 * from inside a session and spawns nothing.
 */

// The ids and the `enabledPlugins` walk live with the settings files they read, where the
// settings planner needs them too; re-exported so callers keep one import.
export { LEGACY_PLUGIN_ID, MARKETPLACE_NAME, PLUGIN_ID, enabledFlag };

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** -1, 0, 1 for dotted numeric versions; unknown sorts lowest. */
export function cmpVersion(a: string | undefined, b: string | undefined): number {
  const pa = (a ?? '0').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = (b ?? '0').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export interface PluginState {
  readonly installed: boolean;
  readonly scope: string | undefined;
  readonly version: string | undefined;
  readonly enabled: boolean;
  /** The marketplace cache's version — only as new as the last marketplace update. */
  readonly latest: string | undefined;
}

export function pluginState(root: string, claudeDir: string, id = PLUGIN_ID): PluginState {
  const rootReal = real(root);
  const file = readJson(join(claudeDir, 'plugins/installed_plugins.json'));
  const all = isRecord(file) && isRecord(file.plugins) ? file.plugins[id] : undefined;
  const records = (Array.isArray(all) ? all : []).filter(isRecord);
  // Project and local installs belong to one directory; user installs to all.
  const mine = records.filter(
    (r) =>
      r.scope === 'user' || (typeof r.projectPath === 'string' && real(r.projectPath) === rootReal),
  );
  const pick = mine.find((r) => r.scope === 'project' || r.scope === 'local') ?? mine[0];
  const [plugin, market] = id.split('@');
  const cached = readJson(
    join(
      claudeDir,
      'plugins/marketplaces',
      market ?? '',
      'plugins',
      plugin ?? '',
      '.claude-plugin/plugin.json',
    ),
  );
  return {
    installed: pick !== undefined,
    scope: typeof pick?.scope === 'string' ? pick.scope : undefined,
    version: typeof pick?.version === 'string' ? pick.version : undefined,
    enabled: pick !== undefined && enabledFlag(root, claudeDir, id) !== false,
    latest: isRecord(cached) && typeof cached.version === 'string' ? cached.version : undefined,
  };
}

export interface SetupItem {
  readonly key: string;
  readonly label: string;
  readonly ok: boolean;
  readonly fix: string;
}

export interface SetupState {
  readonly status: 'fresh' | 'repair' | 'healthy';
  readonly items: readonly SetupItem[];
  readonly missing: readonly SetupItem[];
  readonly plugin: PluginState;
}

/** Does CLAUDE.md tell Claude when to use the plugin's agents? */
export const AGENTS_SECTION = /rulegate:(feature-cartographer|builder|reviewer)/;

/**
 * Every check, then the verdict:
 *   fresh    nothing of the plugin's setup is here yet — run the whole pass
 *   repair   some of it is — fix only the items marked missing
 *   healthy  all of it is
 * `expect` is the minimum plugin version wanted, normally the one this script ships in.
 */
export async function setupState(
  root: string,
  claudeDir: string,
  { expect }: { expect?: string | undefined } = {},
): Promise<SetupState> {
  const items: SetupItem[] = [];
  const add = (key: string, label: string, ok: boolean, fix: string): void => {
    items.push({ key, label, ok, fix });
  };

  const hasSource = isDir(join(root, '.rulegate'));
  const claudeMd = read(join(root, 'CLAUDE.md'));

  add('source', '.rulegate/ canonical rules', hasSource, 'npx rulegate init');
  add(
    'claude-md',
    'CLAUDE.md',
    claudeMd !== undefined,
    hasSource ? 'rulegate sync' : '/init, then /rulegate:init',
  );

  const scopes: Scope[] = ['project', 'user'];
  let taskRuleOk = true;
  let taskRuleFile = '';
  let taskRuleFix = '/rulegate:init settings';
  let marketplace: { state: MarketplaceState; fix: string } | undefined;
  // An item the writer refuses is not the settings pass's to fix: sending it back there
  // would loop, refusing again on every run. It names the refusal instead, which says what
  // to do by hand — the writer's own reasons, from the same check.
  const byHand = (reason: string): string => `the settings pass refuses this — ${reason}`;
  for (const scope of scopes) {
    const p = planScope(scope, root, claudeDir);
    const refused = await refusals(p, root, claudeDir);
    const settingsRefused = refused.find((r) => r.item === 'settings');
    const ruleRefused = refused.find((r) => r.item === 'rule');
    const where = scope === 'user' ? '~/.claude/settings.json' : '.claude/settings.json';
    if (scope === 'project' && p.settings.marketplace !== undefined) {
      marketplace = {
        state: p.settings.marketplace,
        fix:
          settingsRefused === undefined
            ? '/rulegate:init settings'
            : byHand(settingsRefused.reason),
      };
    }
    if (scope === 'project') {
      taskRuleOk = p.rule.status === 'present';
      taskRuleFile = p.rule.file;
      if (p.rule.status === 'exists') {
        taskRuleFix = `add the rule to ${p.rule.file} by hand, then \`rulegate sync\``;
      } else if (ruleRefused !== undefined) {
        taskRuleFix = byHand(ruleRefused.reason);
      }
    }
    if (p.settings.status === 'invalid') {
      add(`${scope}-settings`, `${where} is valid JSON`, false, `fix ${where} by hand`);
      continue;
    }
    const fix =
      settingsRefused === undefined ? '/rulegate:init settings' : byHand(settingsRefused.reason);
    const have = GIT_DENY.length - p.settings.denyAdded.length;
    add(
      `${scope}-git`,
      `${where} git write protection (${String(have)}/${String(GIT_DENY.length)})`,
      p.settings.denyAdded.length === 0,
      fix,
    );
    add(`${scope}-todo`, `${where} task tools`, p.settings.env !== 'added', fix);
  }
  if (claudeMd !== undefined || hasSource) {
    add('task-rule', `task-tracking rule (${taskRuleFile})`, taskRuleOk, taskRuleFix);
    add(
      'agents-section',
      'CLAUDE.md says when to use each agent',
      AGENTS_SECTION.test(claudeMd ?? ''),
      '/rulegate:init (references/establishing.md, Step 4b)',
    );
  }

  const pl = pluginState(root, claudeDir);
  const want = [expect, pl.latest]
    .filter((v): v is string => v !== undefined)
    .sort((a, b) => cmpVersion(b, a))[0];
  add('plugin', 'Claude Code plugin installed', pl.installed, `/plugin install ${PLUGIN_ID}`);
  if (pl.installed) {
    add('plugin-enabled', 'plugin enabled', pl.enabled, `claude plugin enable ${PLUGIN_ID}`);
    const behind = want !== undefined && cmpVersion(pl.version, want) < 0;
    add(
      'plugin-version',
      `plugin version ${pl.version ?? 'unknown'}${behind ? ` (latest ${want})` : ''}`,
      !behind,
      `/plugin update ${PLUGIN_ID}, then /reload-plugins`,
    );
  }
  const legacy = agentOsInstall(root, claudeDir);
  if (legacy.plugin !== undefined || legacy.shared) {
    add(
      'legacy-plugin',
      'agent-os plugin disabled',
      false,
      disableCommand(legacy.plugin ?? 'project'),
    );
  }
  if (legacy.memory.length > 0) {
    // The same planner the migration runs: an agent it refuses is named with its reason,
    // since sending the user back to the migration would only refuse it again.
    const refused = (await planMemoryMigration(root, claudeDir)).agents.filter(
      (a) => a.kind === 'refused',
    );
    add(
      'legacy-memory',
      `agent-os memory moved to rulegate-* (${String(legacy.memory.length)} left)`,
      false,
      refused.length === 0
        ? '/rulegate:init (migrate-memory.js)'
        : `the migration refuses ${refused.map((a) => `${a.base}/${a.from} — ${a.reason ?? ''}`).join('; ')}`,
    );
  }
  if (marketplace !== undefined) {
    // Retired only once agent-os is off here, so while it is on the disable comes first.
    add(
      'legacy-marketplace',
      `.claude/settings.json declares ${MARKETPLACE_NAME}, not ${LEGACY_MARKETPLACE}`,
      false,
      marketplace.state === 'retire'
        ? marketplace.fix
        : `${disableCommand(legacy.plugin ?? 'project')}, then ${marketplace.fix}`,
    );
  }

  // What counts as "set up" is the plugin's own layer. Being installed does not count —
  // this runs from the installed plugin, so it always would — and neither does
  // `.rulegate/`: a project that uses the CLI and has never set up the plugin still wants
  // the full pass. Settings alone do not count either; deny rules may be the user's own.
  // An agent-os project counts as set up too: it has the plugin's layer under the old name,
  // and FRESH would re-scaffold over it instead of naming what to migrate.
  const setUp =
    legacy.found ||
    AGENTS_SECTION.test(claudeMd ?? '') ||
    ls(join(root, '.claude/agent-memory')).some((d) => d.startsWith('rulegate-')) ||
    read(join(root, '.claude/rulegate.json')) !== undefined;
  const missing = items.filter((i) => !i.ok);
  const status = !setUp ? 'fresh' : missing.length > 0 ? 'repair' : 'healthy';
  return { status, items, missing, plugin: pl };
}

export function describeState(st: SetupState): string[] {
  const lines = [
    `SETUP  ${st.status.toUpperCase()}${st.status === 'repair' ? `  — ${String(st.missing.length)} item(s) to fix` : ''}`,
  ];
  for (const i of st.items) {
    lines.push(`  ${i.ok ? 'ok     ' : 'MISSING'} ${i.label}${i.ok ? '' : `  → ${i.fix}`}`);
  }
  return lines;
}
