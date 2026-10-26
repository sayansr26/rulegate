import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import {
  AUTO_ROUTE_ID,
  blocked,
  claudeHome,
  cmpVersion,
  describeScope,
  enabledAt,
  isRecord,
  MARKETPLACE_NAME,
  planScope,
  PLUGIN_ID,
  pluginState,
  readJson,
  refusals,
  setupState,
  type PluginState,
  type Scope,
} from '@rulegate/claude';
import { ensurePlugin, pluginSteps, SCOPES, shown, type PluginOutcome } from '../claude/index.js';
import { applyScope } from '../claude/settings-writer.js';
import { createOutput, type Output } from '../ui/report.js';
import { ExitCode, type ExitCodeValue } from '../ui/exit.js';

/**
 * Where the CLI meets Claude Code (T107): the setup-state section `init` prints, the plugin
 * install `init --plugin --yes` runs, and `rulegate claude settings` (D2). What any of them
 * knows about a Claude Code setup comes from `@rulegate/claude`, the same read-only modules
 * the plugin runs, so the CLI and `/rulegate:init` cannot disagree about what is missing.
 */

/** `~/.claude`, or `CLAUDE_CONFIG_DIR` — resolved here so tests can point both at a sandbox. */
export const claudeDirFromEnv = (env: NodeJS.ProcessEnv = process.env): string =>
  claudeHome(env, homedir());

export interface ClaudeSectionOptions {
  readonly root: string;
  readonly claudeDir: string;
  /** `true` asks for the plugin step; with `run` it spawns `claude`. */
  readonly plugin: boolean;
  readonly run: boolean;
  /** The version this CLI ships; the plugin's moves with it. */
  readonly want: string;
  /** `false` (`--no-auto-route`) leaves the auto-route mod out of the plugin step (T162). */
  readonly autoRoute?: boolean;
}

const SETTINGS_ITEMS = /^(project|user)-(settings|git|todo)$/;

/** The scope whose settings file switches the plugin off, which is where an enable must go. */
export function offAt(root: string, claudeDir: string, id = PLUGIN_ID): string | undefined {
  const at = enabledAt(root, claudeDir, id);
  return at?.value === false ? at.scope : undefined;
}

/**
 * Whether Claude Code knows the `rulegate` marketplace, from the files `claude plugin
 * marketplace list` reads — its registry, or the clone that registry points at — so the
 * commands plain `init` prints start with the `update` the run would, not an `add`.
 */
export function marketKnown(claudeDir: string, cached: boolean): boolean {
  const known = readJson(join(claudeDir, 'plugins/known_marketplaces.json'));
  return cached || (isRecord(known) && MARKETPLACE_NAME in known);
}

/** The settings file a plugin command at `scope` records itself in. */
const pluginSettings = (scope: string, root: string, claudeDir: string): string =>
  scope === 'user'
    ? join(claudeDir, 'settings.json')
    : join(root, scope === 'local' ? '.claude/settings.local.json' : '.claude/settings.json');

/**
 * The "Claude Code" block of `init`. Read-only unless `plugin && run`: the setup state is
 * file reads, and the plugin commands are printed, not run — `marketplace add` clones from
 * GitHub, and plain `init` makes no network call.
 */
export async function claudeSection(
  out: Output,
  { root, claudeDir, plugin, run, want, autoRoute = true }: ClaudeSectionOptions,
): Promise<ExitCodeValue> {
  const st = await setupState(root, claudeDir, { expect: want });
  out.log('');
  out.log('Claude Code');
  out.log(
    `  SETUP  ${st.status.toUpperCase()}` +
      (st.status === 'repair' ? `  — ${String(st.missing.length)} item(s) to fix` : ''),
  );
  // FRESH is the whole pass, so its missing items are everything and name nothing useful;
  // REPAIR names exactly what to fix, and what `rulegate claude settings` can fix from here.
  if (st.status === 'fresh') {
    out.log('    install the plugin, then run /rulegate:init inside Claude Code');
  } else {
    for (const i of st.missing) out.log(`    MISSING  ${i.label}  → ${i.fix}`);
    if (st.missing.some((i) => SETTINGS_ITEMS.test(i.key))) {
      out.log('    settings: `rulegate claude settings` previews the fix; --apply writes it');
    }
  }

  const pl = st.plugin;
  const current = upToDate(pl, want);
  out.log(pluginLine(PLUGIN_ID, pl, current));
  // The mod moves with the marketplace, not with this CLI, so only the cache says how new
  // it can be.
  const mod = autoRoute ? pluginState(root, claudeDir, AUTO_ROUTE_ID) : undefined;
  const modCurrent = mod === undefined || upToDate(mod, undefined);
  if (mod !== undefined) out.log(pluginLine(AUTO_ROUTE_ID, mod, modCurrent));

  if (!(plugin && run)) {
    if (current && modCurrent && !plugin) return ExitCode.Ok;
    const market = marketKnown(claudeDir, pl.latest !== undefined);
    const steps: string[][] = [];
    if (!current || plugin) steps.push(...pluginSteps(before(pl), market, offAt(root, claudeDir)));
    if (mod !== undefined && (!modCurrent || plugin)) {
      const modSteps = pluginSteps(
        before(mod),
        market,
        offAt(root, claudeDir, AUTO_ROUTE_ID),
        AUTO_ROUTE_ID,
      );
      // One marketplace step serves both.
      steps.push(...(steps.length > 0 ? modSteps.slice(1) : modSteps));
    }
    out.log(
      `  to ${pl.installed ? 'update' : 'install'} ${mod === undefined ? 'it' : 'them'}, run in ${root}:`,
    );
    for (const args of steps) out.log(`    ${shown(args)}`);
    out.log(
      plugin
        ? '  nothing was run. re-run with --yes to run them (they fetch from GitHub).'
        : '  or: rulegate init --plugin --yes  (runs them; they fetch from GitHub)',
    );
    if (mod !== undefined) out.log('  --no-auto-route leaves auto-route out.');
    return ExitCode.Ok;
  }

  // An install, an enable or a marketplace add records itself in the settings file of its
  // scope. The CLI does not write a file Rulegate generated or one it cannot safely rewrite,
  // and it does not ask Claude Code to — so the file checked is the one the steps will write,
  // which only Claude Code's answer about the existing install can name.
  const guard = async (scopes: readonly string[]): Promise<string | undefined> => {
    for (const s of scopes) {
      const file = pluginSettings(s, root, claudeDir);
      const why = await blocked(s === 'user' ? 'user' : 'project', root, claudeDir, file);
      if (why !== undefined) return `${s === 'user' ? file : relative(root, file)} — ${why}`;
    }
    return undefined;
  };

  const r = await ensurePlugin({ root, want, guard, offAt: () => offAt(root, claudeDir) });
  const code = report(out, 'plugin', r);
  // The mod is installed from the marketplace the plugin's run has just refreshed, and only
  // when that run left the plugin installed: a mod beside a plugin that failed to install is
  // half a setup.
  if (code !== ExitCode.Ok || !autoRoute || r.reason === 'no-cli') return code;
  const m = await ensurePlugin({
    root,
    guard,
    id: AUTO_ROUTE_ID,
    refreshMarket: false,
    offAt: () => offAt(root, claudeDir, AUTO_ROUTE_ID),
  });
  return report(out, 'auto-route', m);
}

/** Installed, enabled, and at least as new as both `want` and the marketplace cache. */
function upToDate(pl: PluginState, want: string | undefined): boolean {
  const target = [want, pl.latest]
    .filter((v): v is string => v !== undefined)
    .sort((a, b) => cmpVersion(b, a))[0];
  return pl.installed && pl.enabled && cmpVersion(pl.version, target) >= 0;
}

function pluginLine(id: string, pl: PluginState, current: boolean): string {
  return (
    `  plugin  ${id}  ` +
    (pl.installed
      ? `${pl.version ?? 'unknown version'} (${pl.scope ?? 'unknown scope'})` +
        (pl.enabled ? '' : ', disabled') +
        (current ? ', up to date' : '')
      : 'not installed')
  );
}

/**
 * Claude Code's own files say where it is installed; a scope it reports that the command set
 * does not take is shown as the project's, which is what the run uses.
 */
function before(pl: PluginState): { scope: string; enabled: boolean } | undefined {
  if (!pl.installed) return undefined;
  return {
    scope: SCOPES.includes(pl.scope ?? '') ? (pl.scope ?? 'project') : 'project',
    enabled: pl.enabled,
  };
}

function report(out: Output, label: string, r: PluginOutcome): ExitCodeValue {
  for (const line of r.done) out.log(`  ran  ${line}`);
  if (r.reason === 'no-cli') {
    // Not a failure: the rules are the part that must not depend on Claude Code's CLI.
    for (const line of r.hint) out.log(`  ${line}`);
    return ExitCode.Ok;
  }
  if (r.reason === 'refused') {
    for (const line of r.hint) out.error(`  ${label}  nothing run: ${line}`);
    return ExitCode.Failure;
  }
  if (r.reason === 'failed') {
    for (const line of r.hint) out.error(`  ${line}`);
    return ExitCode.Failure;
  }
  const v = (s: string | undefined): string => s ?? 'unknown';
  out.log(
    r.reason === 'installed'
      ? `  ${label}  installed ${v(r.to)} at project scope`
      : r.reason === 'updated'
        ? `  ${label}  updated ${v(r.from)} → ${v(r.to)}`
        : `  ${label}  ${v(r.to)}, already the latest the marketplace serves`,
  );
  for (const line of r.hint) out.log(`  ${line}`);
  return ExitCode.Ok;
}

export interface ClaudeSettingsOptions {
  readonly cwd: string;
  /** Required with `apply`: a write to `~/.claude` is something the user names. */
  readonly scope?: string;
  readonly apply?: boolean;
  readonly claudeDir?: string;
  readonly announceRoot?: boolean;
  readonly quiet?: boolean;
  readonly color?: boolean;
}

/**
 * `rulegate claude settings [--scope project|user|both] [--apply]` — D2's settings pass from
 * the CLI: git write protection, the task tools and the task-tracking rule. Previews by
 * default; `--apply` merges and backs up each replaced file to `<file>.rulegate.bak` first.
 * Never part of `sync` or `init`, which do not write outside the repository.
 *
 * Exit codes: 0 ok (a preview always, refusals included — it reports them), 1 when
 * `--apply` refused or failed any item, 2 usage.
 */
export async function runClaudeSettings(options: ClaudeSettingsOptions): Promise<ExitCodeValue> {
  const out = createOutput({
    ...(options.quiet === undefined ? {} : { quiet: options.quiet }),
    ...(options.color === undefined ? {} : { color: options.color }),
  });
  const apply = options.apply === true;
  const scope = options.scope ?? (apply ? undefined : 'both');
  if (scope === undefined) {
    out.error('--apply needs --scope project, user or both: a write to ~/.claude is yours to name');
    return ExitCode.Usage;
  }
  if (scope !== 'both' && scope !== 'project' && scope !== 'user') {
    out.error(`--scope must be project, user or both (got "${scope}")`);
    return ExitCode.Usage;
  }
  const scopes: Scope[] = scope === 'both' ? ['project', 'user'] : [scope];
  const root = options.cwd;
  const claudeDir = options.claudeDir ?? claudeDirFromEnv();

  if (options.announceRoot === true) out.log(`repo  ${root}`);
  out.log(
    `RULEGATE SETTINGS  ${apply ? 'applied' : 'preview — nothing written; re-run with --apply'}`,
  );
  out.log('');
  let refused = false;
  for (const s of scopes) {
    if (apply) {
      const r = await applyScope(s, root, claudeDir);
      refused ||= r.refused.length > 0;
      for (const line of describeScope(r.plan, {
        dry: false,
        refused: r.refused,
        backups: r.backups,
      })) {
        out.log(line);
      }
    } else {
      // The preview names what `--apply` will refuse, from the check the writer runs.
      const plan = planScope(s, root, claudeDir);
      const why = await refusals(plan, root, claudeDir);
      for (const line of describeScope(plan, { dry: true, refused: why })) out.log(line);
    }
    out.log('');
  }
  if (scopes.includes('user')) out.log(`${claudeDir} applies to every project on this machine.`);
  return refused ? ExitCode.Failure : ExitCode.Ok;
}
