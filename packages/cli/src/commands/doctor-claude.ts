import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  PLUGIN_ID,
  agentOsInstall,
  claudeHome,
  cmpVersion,
  enabledAt,
  enabledIn,
  moreLocal,
  pluginState,
  type PluginScope,
} from '@rulegate/claude';
import type { Colors } from '../ui/report.js';

/**
 * The Claude Code plugin line in `doctor` (T115). Everything here is a file read of Claude
 * Code's own records — `plugins/installed_plugins.json`, the marketplace clone under
 * `plugins/marketplaces/`, and `enabledPlugins` in each settings file — through the same
 * `@rulegate/claude` readers `/rulegate:init` uses, so the two cannot disagree about whether
 * the plugin is installed. Nothing is spawned: `claude plugin list` would be the easy answer
 * and it is the one `doctor` may not give, because a read-only command that runs another
 * program's CLI is only read-only as long as that CLI is.
 */

export interface ClaudePluginReport {
  readonly id: string;
  /**
   * Whether Claude Code's user-level directory was read. `false` under `--no-global`, and
   * then every field that lives there is `null` — not probed, which is not "absent".
   */
  readonly globalProbed: boolean;
  /**
   * Where the user-level records came from. Core's user-level probe reads `~/.claude`
   * whatever `CLAUDE_CONFIG_DIR` says, so when it names another directory one report
   * answers from two places — said here rather than left for the reader to discover.
   */
  readonly userDir: 'CLAUDE_CONFIG_DIR' | '~/.claude' | null;
  /** An install record for this repository (project or local) or for every one (user). */
  readonly installed: boolean | null;
  readonly scope: string | null;
  readonly version: string | null;
  /** The marketplace cache's version — only as new as the last marketplace update. */
  readonly latest: string | null;
  readonly outdated: boolean;
  /**
   * Whether Claude Code loads the install here, settings files merged: `false` when a flag
   * turns it off, and then its slash commands are not there to run. `null` when not probed.
   */
  readonly active: boolean | null;
  /**
   * The settings file whose flag decides `active` — the most local one that sets it — or
   * `null` where none does or nothing was probed. `claude plugin enable --scope <s>` writes
   * only scope `s`, so it turns the plugin on only when this is the install's own scope.
   */
  readonly decidedAt: PluginScope | null;
  /** `enabledPlugins[id]` as each settings file sets it; `null` where it is unset. */
  readonly enabled: {
    readonly local: boolean | null;
    readonly project: boolean | null;
    readonly user: boolean | null;
  };
  readonly legacy: {
    readonly found: boolean;
    /** The scope that enables agent-os here, or `null`. */
    readonly plugin: PluginScope | null;
    readonly shared: boolean;
    readonly bothEnabled: boolean;
    readonly memory: number;
    readonly source: boolean;
    readonly imported: boolean;
    readonly marketplace: boolean;
  };
}

export function inspectClaudePlugin(
  repoRoot: string,
  opts: { readonly noGlobal: boolean; readonly homeRoot?: string },
): ClaudePluginReport {
  const probed = !opts.noGlobal;
  // Under --no-global the user-level directory is the repository's own `.claude/`. The
  // readers below take a `claudeDir` and only ever read `settings.json` from it, after the
  // project's `.claude/settings.json` — so the "user" step re-reads a file that has already
  // answered, and nothing outside the repository is touched. The install record and the
  // marketplace cache live nowhere else, so they are skipped rather than redirected.
  const claudeDir = probed
    ? claudeHome(process.env, opts.homeRoot ?? homedir())
    : join(repoRoot, '.claude');

  const state = probed ? pluginState(repoRoot, claudeDir) : undefined;
  const legacy = agentOsInstall(repoRoot, claudeDir);
  // agentOsInstall runs inside the plugin, where installed goes without saying, so an unset
  // rulegate flag counts as enabled there. Here the plugin is opt-in and usually absent:
  // "both enabled" takes an install record, and under --no-global there is none to read.
  const bothEnabled = legacy.bothEnabled && state?.installed === true;
  const flag = (file: string): boolean | null => enabledIn(file, PLUGIN_ID) ?? null;

  return {
    id: PLUGIN_ID,
    globalProbed: probed,
    userDir: !probed
      ? null
      : (process.env.CLAUDE_CONFIG_DIR ?? '') === ''
        ? '~/.claude'
        : 'CLAUDE_CONFIG_DIR',
    installed: state?.installed ?? null,
    scope: state?.scope ?? null,
    version: state?.version ?? null,
    latest: state?.latest ?? null,
    outdated:
      state?.version !== undefined &&
      state.latest !== undefined &&
      cmpVersion(state.version, state.latest) < 0,
    active: state === undefined ? null : state.installed && state.enabled,
    decidedAt: probed ? (enabledAt(repoRoot, claudeDir, PLUGIN_ID)?.scope ?? null) : null,
    enabled: {
      local: flag(join(repoRoot, '.claude/settings.local.json')),
      project: flag(join(repoRoot, '.claude/settings.json')),
      user: probed ? flag(join(claudeDir, 'settings.json')) : null,
    },
    legacy: {
      found: legacy.found,
      plugin: legacy.plugin ?? null,
      shared: legacy.shared,
      bothEnabled,
      memory: legacy.memory.length,
      source: legacy.source,
      imported: legacy.imported,
      marketplace: legacy.marketplace,
    },
  };
}

export interface PluginLines {
  readonly header: string;
  readonly rows: readonly string[];
  /** Printed with doctor's other warnings, on stderr. */
  readonly warnings: readonly { readonly message: string; readonly hint: string }[];
}

/**
 * `adopted` is whether `.rulegate/` exists, and it decides which hints may name
 * `rulegate init --plugin --yes`. With `.rulegate/` there, init writes nothing to the
 * repository and `--plugin --yes` only runs the `claude plugin` steps. Without it, the same
 * command imports the repository and takes ownership of its tool files before the plugin
 * step, skipping the dry run init exists to show. A plugin hint must not do that, so those
 * repositories get the steps to type inside Claude Code, or init's dry run.
 */
export function describeClaudePlugin(
  p: ClaudePluginReport,
  c: Colors,
  adopted: boolean,
): PluginLines {
  const rows: string[] = [];
  const warnings: { message: string; hint: string }[] = [];

  let summary: string;
  if (p.installed === null) summary = `${p.id} — install record not probed`;
  else if (!p.installed) summary = `${p.id} not installed`;
  else summary = `${p.id} ${p.version ?? '(unknown version)'}, ${p.scope ?? 'unknown'} scope`;

  if (p.installed === true) {
    rows.push(`latest    ${p.latest ?? 'not in the marketplace cache'}`);
  } else if (p.installed === false) {
    // Opt-in (D3), so absence is a fact to state, not a warning to raise.
    rows.push(c.dim('optional; `rulegate init --plugin` installs it'));
  }

  const show = (v: boolean | null, probedHere: boolean): string =>
    !probedHere ? 'not probed' : v === null ? 'unset' : v ? 'on' : 'off';
  rows.push(
    `enabled   local ${show(p.enabled.local, true)}, project ${show(p.enabled.project, true)}, ` +
      `user ${show(p.enabled.user, p.globalProbed)}`,
  );
  rows.push(`agent-os  ${legacySummary(p.legacy)}`);
  if (!p.globalProbed) rows.push(c.dim('user-level plugin records were not probed.'));
  else if (p.userDir === 'CLAUDE_CONFIG_DIR') {
    rows.push(c.dim('plugin records read from $CLAUDE_CONFIG_DIR, not ~/.claude'));
  }

  if (p.outdated) {
    warnings.push({
      message: `${p.id} ${p.version ?? ''} is behind the marketplace's ${p.latest ?? ''}.`,
      // Through the one command allowed to run `claude plugin` (D3), which updates at the
      // scope the install record names — where that command writes nothing else.
      hint: adopted
        ? '`rulegate init --plugin --yes` updates it'
        : `/plugin marketplace update ${p.id.split('@')[1] ?? ''}, then /plugin update ${p.id}`,
    });
  }
  const l = p.legacy;
  // /rulegate:init is the plugin's own command: without the plugin, or with it turned off,
  // there is nothing to run.
  const then = 'then /rulegate:init in Claude Code';
  // Both enable routes write the install's own scope. A false in a more local file outranks
  // that write, so the file itself is named instead — or the hint sends the user round a
  // loop that ends where it began. A less local false is outranked by it, and needs no edit.
  const offElsewhere =
    p.active === false &&
    p.decidedAt !== null &&
    p.scope !== null &&
    moreLocal(p.decidedAt, p.scope)
      ? settingsFile(p.decidedAt, p.userDir)
      : null;
  const migrate =
    p.installed === null
      ? '/rulegate:init in Claude Code, once the rulegate plugin is installed'
      : p.installed && p.active === true
        ? 'run /rulegate:init in Claude Code to migrate off agent-os'
        : p.installed && offElsewhere !== null
          ? `turn rulegate on in ${offElsewhere}, then /rulegate:init`
          : p.installed
            ? adopted
              ? `\`rulegate init --plugin --yes\` enables it, ${then}`
              : `/plugin enable ${p.id}, ${then}`
            : adopted
              ? `\`rulegate init --plugin --yes\`, ${then}`
              : `\`rulegate init --plugin\` (a dry run), ${then}`;
  if (l.bothEnabled) {
    warnings.push({
      message: 'agent-os and rulegate are both enabled: two session blocks, two guards.',
      hint: migrate,
    });
  } else if (l.plugin !== null || l.shared || l.memory > 0 || l.marketplace) {
    warnings.push({ message: 'agent-os is still set up here.', hint: migrate });
  }
  if (l.source && !l.imported) {
    warnings.push({
      message: '.agent-os/ holds rules Rulegate has not imported.',
      hint: 'rulegate init imports them into .rulegate/',
    });
  }

  return { header: summary, rows, warnings };
}

function settingsFile(scope: PluginScope, userDir: ClaudePluginReport['userDir']): string {
  if (scope === 'local') return '.claude/settings.local.json';
  if (scope === 'project') return '.claude/settings.json';
  return userDir === 'CLAUDE_CONFIG_DIR'
    ? '$CLAUDE_CONFIG_DIR/settings.json'
    : '~/.claude/settings.json';
}

function legacySummary(l: ClaudePluginReport['legacy']): string {
  if (!l.found) return 'none found';
  const parts: string[] = [];
  if (l.plugin !== null) parts.push(`enabled (${l.plugin})`);
  // Off on this machine, still on for every teammate who pulls the committed settings.
  else if (l.shared) parts.push('enabled in committed settings');
  if (l.memory > 0) parts.push(`${l.memory} memory dir${l.memory === 1 ? '' : 's'}`);
  if (l.source) parts.push(l.imported ? '.agent-os/ imported' : '.agent-os/ not imported');
  if (l.marketplace) parts.push('marketplace declared');
  return parts.join(', ');
}
