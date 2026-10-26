import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import {
  AUTO_ROUTE_ID,
  MARKETPLACE_ENTRY,
  MARKETPLACE_NAME,
  PLUGIN_ID,
  cmpVersion,
  moreLocal,
} from '@rulegate/claude';

/**
 * The CLI's one door to the `claude` CLI (D3, T107) — the third directory
 * `invariants.test.ts` allows to spawn, pinned to the command set below the way the git
 * modules are pinned to their subcommands.
 *
 * Only `rulegate init --plugin --yes` reaches it. `claude plugin marketplace add|update`
 * fetch from GitHub, so the plain `init` stays offline and prints these commands instead of
 * running them; running them is something the user asked for by name.
 *
 * Every call is an argv array checked against `CLAUDE_COMMANDS` before it runs: no shell, a
 * timeout, stdin closed, and the repository root as the working directory, so `--scope
 * project` means this repository whatever directory `rulegate` was started from. `--yes` is
 * never passed: on `install` and `update` it accepts a command the *marketplace* declares,
 * and a prompt nobody can answer (stdin is closed) failing the step is the right outcome.
 */

/** The GitHub source `marketplace add` takes, from the entry D4 declares. */
export const MARKETPLACE_SOURCE = MARKETPLACE_ENTRY.source.repo;

/** Stands for one of `SCOPES` in a `CLAUDE_COMMANDS` template. */
const SCOPE = '<scope>';
export const SCOPES: readonly string[] = Object.freeze(['user', 'project', 'local']);

/** Every argv this module may pass to `claude`, whole. A template matches argument for argument. */
export const CLAUDE_COMMANDS: readonly (readonly string[])[] = Object.freeze([
  ['--version'],
  ['plugin', 'list', '--json'],
  ['plugin', 'marketplace', 'list', '--json'],
  ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE, '--scope', 'project'],
  ['plugin', 'marketplace', 'update', MARKETPLACE_NAME],
  ['plugin', 'install', PLUGIN_ID, '--scope', 'project'],
  ['plugin', 'enable', PLUGIN_ID, '--scope', SCOPE],
  ['plugin', 'update', PLUGIN_ID, '--scope', SCOPE],
  ['plugin', 'install', AUTO_ROUTE_ID, '--scope', 'project'],
  ['plugin', 'enable', AUTO_ROUTE_ID, '--scope', SCOPE],
  ['plugin', 'update', AUTO_ROUTE_ID, '--scope', SCOPE],
]);

const allowed = (args: readonly string[]): boolean =>
  CLAUDE_COMMANDS.some(
    (t) =>
      t.length === args.length &&
      t.every((a, i) => a === args[i] || (a === SCOPE && SCOPES.includes(args[i] ?? ''))),
  );

/** Long enough for a marketplace clone on a slow link; short enough that init never hangs. */
export const TIMEOUT_MS = 120_000;

export interface RunResult {
  readonly ok: boolean;
  /** Spawning failed outright — `claude` is not on PATH, or not runnable. */
  readonly missing: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * What an npm `.cmd` shim runs: the `"%dp0%\…\cli.js"` it hands to node, or the native
 * `claude.exe` it calls, relative to the shim's own directory. `undefined` for anything else,
 * which is then not run at all.
 */
export function shimScript(cmdText: string): string | undefined {
  // The first quoted `%dp0%` path that is not the shim's own `node.exe` probe.
  for (const m of cmdText.matchAll(/"%~?dp0%?\\([^"%]+\.(?:js|mjs|cjs|exe))"/gi)) {
    const rel = m[1];
    if (rel !== undefined && rel.toLowerCase() !== 'node.exe') return rel;
  }
  return undefined;
}

/**
 * What to spawn for `claude` (T138). Elsewhere, and for a native `claude.exe` on Windows, the
 * name itself. An npm install on Windows is a `claude.cmd` shim, which Node cannot run without
 * a shell — so the shim is read, never executed: the script it would hand to node runs under
 * this Node directly. Still no shell, and the argv after it is the allowlisted one.
 */
function claudeCommand(env: NodeJS.ProcessEnv): { file: string; prefix: string[] } {
  if (process.platform !== 'win32') return { file: 'claude', prefix: [] };
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter((d) => d !== '');
  for (const dir of dirs) {
    if (existsSync(join(dir, 'claude.exe')) || existsSync(join(dir, 'claude.com'))) break;
    const shim = join(dir, 'claude.cmd');
    if (!existsSync(shim)) continue;
    let rel: string | undefined;
    try {
      rel = shimScript(readFileSync(shim, 'utf8'));
    } catch {
      rel = undefined;
    }
    const script = rel === undefined ? undefined : join(dirname(shim), rel);
    if (script === undefined || !existsSync(script)) continue;
    if (/\.exe$/i.test(script)) return { file: script, prefix: [] };
    return { file: process.execPath, prefix: [script] };
  }
  return { file: 'claude', prefix: [] };
}

function run(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): RunResult {
  if (!allowed(args)) throw new Error(`not an allowlisted claude command: ${args.join(' ')}`);
  const cmd = claudeCommand(env);
  const r = spawnSync(cmd.file, [...cmd.prefix, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    shell: false,
    windowsHide: true,
  });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  // A timeout, an overflowing buffer or a kill leaves stderr '' rather than absent, and the
  // error is then the only account of what happened — so it is appended, never a fallback.
  const why =
    code === 'ETIMEDOUT'
      ? `timed out after ${String(timeout / 1000)}s and was stopped`
      : r.error !== undefined
        ? String(r.error)
        : r.signal !== null
          ? `killed by ${r.signal}`
          : '';
  return {
    ok: r.error === undefined && r.status === 0,
    missing: code === 'ENOENT' || code === 'EACCES',
    stdout: r.stdout ?? '',
    stderr: [(r.stderr ?? '').trimEnd(), why].filter((l) => l !== '').join('\n'),
  };
}

const json = (r: RunResult): unknown => {
  try {
    return JSON.parse(r.stdout) as unknown;
  } catch {
    return undefined;
  }
};

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export interface Installed {
  readonly scope: string;
  readonly version: string | undefined;
  readonly enabled: boolean;
}

/** A list command's rows, or why they could not be read. */
type Listed =
  | { readonly rows: readonly Record<string, unknown>[] }
  | { readonly args: readonly string[]; readonly r: RunResult };

/**
 * `args`' JSON array, every element an object carrying a string `key`. Anything else — a
 * non-zero exit, a timeout, output that does not parse, a wrapper object, a renamed field —
 * is a failure, never an empty list: "nothing installed" read off output nobody understood
 * is how an existing user install gets a second one at project scope.
 */
function list(
  args: readonly string[],
  key: string,
  root: string,
  env: NodeJS.ProcessEnv,
  timeout: number,
): Listed {
  const r = run(args, root, env, timeout);
  const v = r.ok ? json(r) : undefined;
  if (!Array.isArray(v) || !v.every((p) => isRecord(p) && typeof p[key] === 'string')) {
    return { args, r };
  }
  return { rows: v as Record<string, unknown>[] };
}

/**
 * This repository's install among `claude plugin list --json`'s rows: a project or local
 * install recorded for this root first, else a user install. Claude Code's own answer, where
 * `pluginState` reads its files — the run acts on what the CLI will act on.
 */
function installed(
  rows: readonly Record<string, unknown>[],
  root: string,
  id: string,
): Installed | undefined {
  const mine = rows.filter(
    (p) =>
      p.id === id &&
      typeof p.scope === 'string' &&
      SCOPES.includes(p.scope) &&
      (p.scope === 'user' ||
        (typeof p.projectPath === 'string' && real(p.projectPath) === real(root))),
  );
  const pick = mine.find((p) => p.scope === 'project' || p.scope === 'local') ?? mine[0];
  if (pick === undefined) return undefined;
  return {
    scope: String(pick.scope),
    version: typeof pick.version === 'string' ? pick.version : undefined,
    enabled: pick.enabled !== false,
  };
}

export type PluginReason = 'installed' | 'updated' | 'current' | 'no-cli' | 'refused' | 'failed';

export interface PluginOutcome {
  readonly reason: PluginReason;
  readonly from: string | undefined;
  readonly to: string | undefined;
  /** The commands that ran and succeeded, as a user would type them. */
  readonly done: readonly string[];
  readonly hint: readonly string[];
}

/** What to type inside Claude Code when the CLI cannot run it from here. */
export function manualSteps(installedAlready: boolean, id = PLUGIN_ID): string[] {
  return installedAlready
    ? [
        `  /plugin marketplace update ${MARKETPLACE_NAME}`,
        `  /plugin update ${id}`,
        '  /reload-plugins',
      ]
    : [`  /plugin marketplace add ${MARKETPLACE_SOURCE}`, `  /plugin install ${id}`];
}

/** An install as `pluginSteps` plans from it. */
export type Before = Pick<Installed, 'scope' | 'enabled'>;

/**
 * The commands that bring the plugin up to date from `before`. One function for the run and
 * for the commands plain `init` prints, so what it prints is what `--plugin --yes` runs —
 * provided both are told the same `before`, `haveMarket` and `offAt`: the run asks the
 * `claude` CLI, plain `init` reads the files that CLI keeps them in.
 *
 * `offAt` is the scope whose settings file sets `enabledPlugins[id]` to false, when one does.
 * Claude Code takes that flag from the most local file that sets it, so a user install
 * switched off in `.claude/settings.json` stays off after an enable at user scope, and a
 * fresh project install stays off under a `false` left in `.claude/settings.local.json`.
 * A `false` *less* local than the install is outranked by the install's own scope, so the
 * enable goes there — never up to user scope, which would switch the plugin on in every
 * project on the machine.
 */
export function pluginSteps(
  before: Before | undefined,
  haveMarket: boolean,
  offAt?: string,
  id = PLUGIN_ID,
): string[][] {
  const steps: string[][] = [
    haveMarket
      ? ['plugin', 'marketplace', 'update', MARKETPLACE_NAME]
      : ['plugin', 'marketplace', 'add', MARKETPLACE_SOURCE, '--scope', 'project'],
  ];
  if (before === undefined) {
    steps.push(['plugin', 'install', id, '--scope', 'project']);
    if (offAt !== undefined && !moreLocal('project', offAt))
      steps.push(['plugin', 'enable', id, '--scope', offAt]);
  } else {
    const off =
      offAt !== undefined && moreLocal(offAt, before.scope)
        ? offAt
        : offAt !== undefined || !before.enabled
          ? before.scope
          : undefined;
    if (off !== undefined) steps.push(['plugin', 'enable', id, '--scope', off]);
    steps.push(['plugin', 'update', id, '--scope', before.scope]);
  }
  return steps;
}

export const shown = (args: readonly string[]): string => `claude ${args.join(' ')}`;

/**
 * The scopes whose `settings.json` a step records itself in: `marketplace add`, `install` and
 * `enable` write their scope's file, where `update` and `marketplace update` move Claude
 * Code's cached copy. The file a run may have rewritten is the one to check before it.
 */
export function settingsScopes(steps: readonly (readonly string[])[]): string[] {
  const scopes = new Set<string>();
  for (const s of steps) {
    const at = s.indexOf('--scope');
    if (at !== -1 && s[1] !== 'update') scopes.add(s[at + 1] ?? '');
  }
  return [...scopes];
}

/** Why a step writing a scope's settings file must not run, or `undefined` when it may. */
export type PluginGuard = (scopes: readonly string[]) => Promise<string | undefined>;

const tail = (r: RunResult): string[] =>
  (r.stderr || r.stdout)
    .trim()
    .split('\n')
    .slice(-3)
    .filter((l) => l !== '')
    .map((l) => `  ${l}`);

function failed(
  what: string,
  r: RunResult | undefined,
  before: Installed | undefined,
  done: readonly string[],
  id = PLUGIN_ID,
): PluginOutcome {
  return {
    reason: 'failed',
    from: before?.version,
    to: undefined,
    done,
    hint: [
      what,
      ...(r === undefined ? [] : tail(r)),
      'inside Claude Code, run:',
      ...manualSteps(before !== undefined, id),
    ],
  };
}

const unread = (l: Extract<Listed, { r: RunResult }>): string =>
  l.r.ok
    ? `\`${shown(l.args)}\` printed output this rulegate does not recognise:`
    : `\`${shown(l.args)}\` failed:`;

/**
 * Bring `id` — `rulegate@rulegate`, or a mod from the same marketplace — to the marketplace's
 * latest for this repository:
 *
 *   not installed        marketplace add (or update) + install, at project scope
 *   installed, disabled  refresh the marketplace, enable where it is disabled, update
 *   installed            refresh the marketplace, update
 *
 * Claude Code pins the cached version, so an install is never left where it is: a project
 * installed once otherwise stays on that version until something updates it.
 *
 * `refreshMarket: false` leaves the marketplace alone, for a mod installed straight after the
 * plugin's own run has just added or updated it: a second clone of the same repository would
 * add a network round trip and nothing else.
 */
export async function ensurePlugin({
  root,
  env = process.env,
  want,
  guard,
  offAt,
  timeout = TIMEOUT_MS,
  id = PLUGIN_ID,
  refreshMarket = true,
}: {
  root: string;
  env?: NodeJS.ProcessEnv;
  /** The version this CLI ships with; the plugin's moves with it. */
  want?: string | undefined;
  /** Asked before the first step, with the scopes whose settings file the steps write. */
  guard?: PluginGuard;
  /** `pluginSteps`' `offAt`, read from the settings files — once to plan, once to confirm. */
  offAt?: () => string | undefined;
  timeout?: number;
  id?: string;
  refreshMarket?: boolean;
}): Promise<PluginOutcome> {
  const version = run(['--version'], root, env, timeout);
  if (!version.ok) {
    // Only a CLI that is not there is "not on PATH"; one that is there and fails, or hangs
    // past the timeout, is broken, and saying otherwise hides it behind exit 0.
    if (!version.missing)
      return failed(`\`${shown(['--version'])}\` failed:`, version, undefined, [], id);
    return {
      reason: 'no-cli',
      from: undefined,
      to: undefined,
      done: [],
      hint: [
        'the `claude` CLI is not on PATH, so the plugin was not installed or updated.',
        'inside Claude Code, run:',
        ...manualSteps(false, id),
      ],
    };
  }

  const plugins = list(['plugin', 'list', '--json'], 'id', root, env, timeout);
  if (!('rows' in plugins)) return failed(unread(plugins), plugins.r, undefined, [], id);
  const before = installed(plugins.rows, root, id);
  let steps: string[][];
  if (refreshMarket) {
    const markets = list(['plugin', 'marketplace', 'list', '--json'], 'name', root, env, timeout);
    if (!('rows' in markets)) return failed(unread(markets), markets.r, before, [], id);
    const haveMarket = markets.rows.some((m) => m.name === MARKETPLACE_NAME);
    steps = pluginSteps(before, haveMarket, offAt?.(), id);
  } else {
    steps = pluginSteps(before, true, offAt?.(), id).slice(1);
  }
  const why = await guard?.(settingsScopes(steps));
  if (why !== undefined) {
    return { reason: 'refused', from: before?.version, to: undefined, done: [], hint: [why] };
  }

  const done: string[] = [];
  for (const args of steps) {
    const r = run(args, root, env, timeout);
    if (!r.ok) return failed(`\`${shown(args)}\` failed:`, r, before, done, id);
    done.push(shown(args));
  }

  // The steps succeeded; a result nobody could read back is still not a result.
  const again = list(['plugin', 'list', '--json'], 'id', root, env, timeout);
  if (!('rows' in again)) return failed(unread(again), again.r, before, done, id);
  const after = installed(again.rows, root, id);
  if (after === undefined) {
    return failed(
      `\`${shown(['plugin', 'list', '--json'])}\` does not list ${id} for this repository after the steps ran.`,
      undefined,
      before,
      done,
      id,
    );
  }
  // An enable that exited 0 and left the plugin off is the false success this check exists
  // for: Claude Code's list and the settings files that decide the flag must both agree.
  // The file names the scope that decides; the list only knows where the plugin is installed.
  const file = offAt?.();
  const stillOff = file ?? (after.enabled ? undefined : after.scope);
  if (stillOff !== undefined) {
    return {
      reason: 'failed',
      from: before?.version,
      to: undefined,
      done,
      hint: [
        `${id} is still disabled at ${stillOff} scope after the steps ran.`,
        ...(file === undefined
          ? ['inside Claude Code, run:', `  /plugin enable ${id}`, '  /reload-plugins']
          : [
              `its ${file}-scope settings file sets enabledPlugins["${id}"] to false;`,
              'set it to true, then run /reload-plugins in any open Claude Code session.',
            ]),
      ],
    };
  }
  const from = before?.version;
  const to = after.version;
  const hint: string[] = [];
  // The marketplace serves what is pushed; this CLI may be ahead of it.
  if (to !== undefined && want !== undefined && cmpVersion(to, want) < 0) {
    hint.push(`the marketplace still serves ${to}; this rulegate is ${want}.`);
  }
  if (before !== undefined) hint.push('run /reload-plugins in any open Claude Code session.');
  return {
    reason: before === undefined ? 'installed' : from !== to ? 'updated' : 'current',
    from,
    to,
    done,
    hint,
  };
}
