import { join } from 'node:path';
import { isDir, isRealDir, isRecord, ls, read, readJson } from './read.js';
import {
  LEGACY_MARKETPLACE,
  LEGACY_PLUGIN_ID,
  PLUGIN_ID,
  enabledAt,
  enabledFlag,
  enabledIn,
  type PluginScope,
} from './settings.js';

/**
 * What an agent-os install left in this project (T114) — one detector, so the audit, the
 * setup state and the session hook cannot disagree about whether there is anything to
 * migrate. Read-only.
 */

/** Where Claude Code keeps a plugin agent's memory: project-shared, then machine-local. */
export const MEMORY_BASES = ['.claude/agent-memory', '.claude/agent-memory-local'] as const;
export const LEGACY_PREFIX = 'agent-os-';
export const MEMORY_PREFIX = 'rulegate-';

export interface LegacyMemory {
  /** One of `MEMORY_BASES`. */
  readonly base: string;
  /** `agent-os-<agent>` */
  readonly name: string;
  /** `rulegate-<agent>` — the directory the same agent reads under this plugin. */
  readonly target: string;
  /** Both exist: the agent reads only `target`, so what is in `name` is invisible. */
  readonly split: boolean;
}

export interface AgentOsInstall {
  /** The settings scope that enables agent-os here; `undefined` when it is not enabled. */
  readonly plugin: PluginScope | undefined;
  /**
   * The committed `.claude/settings.json` enables agent-os while a more local file turns it
   * off: off on this machine, still on for every teammate who pulls.
   */
  readonly shared: boolean;
  /** agent-os and this plugin both enabled — two session blocks, two guards. */
  readonly bothEnabled: boolean;
  readonly memory: readonly LegacyMemory[];
  /** `.agent-os/` exists. */
  readonly source: boolean;
  /** …and `.rulegate/` does too: `rulegate init` has imported it, so it is safe to delete. */
  readonly imported: boolean;
  /** The project's `.claude/settings.json` still declares agent-os's marketplace. */
  readonly marketplace: boolean;
  /** Any of the above. */
  readonly found: boolean;
}

export function agentOsInstall(root: string, claudeDir: string): AgentOsInstall {
  const at = enabledAt(root, claudeDir, LEGACY_PLUGIN_ID);
  const plugin = at?.value === true ? at.scope : undefined;
  const shared =
    plugin === undefined &&
    enabledIn(join(root, '.claude/settings.json'), LEGACY_PLUGIN_ID) === true;
  const memory: LegacyMemory[] = [];
  for (const base of MEMORY_BASES) {
    const names = ls(join(root, base));
    for (const name of names) {
      if (!name.startsWith(LEGACY_PREFIX) || !isDir(join(root, base, name))) continue;
      const target = `${MEMORY_PREFIX}${name.slice(LEGACY_PREFIX.length)}`;
      memory.push({ base, name, target, split: names.includes(target) });
    }
  }
  const source = isDir(join(root, '.agent-os'));
  const project = readJson(join(root, '.claude/settings.json'));
  const marketplace =
    isRecord(project) &&
    isRecord(project.extraKnownMarketplaces) &&
    LEGACY_MARKETPLACE in project.extraKnownMarketplaces;
  return {
    plugin,
    shared,
    // Installed goes without saying — this runs from the installed plugin — so enabled is
    // anything short of an explicit `false`.
    bothEnabled: plugin !== undefined && enabledFlag(root, claudeDir, PLUGIN_ID) !== false,
    memory,
    source,
    imported: source && isDir(join(root, '.rulegate')),
    marketplace,
    found: plugin !== undefined || shared || memory.length > 0 || source || marketplace,
  };
}

/**
 * The disable Claude runs, with the user's yes, from its Bash tool — the plugin itself never
 * spawns `claude` (D3). The scope is always explicit: a bare `disable` acts on the most
 * specific scope that already lists the plugin, which for a user-scope install is every
 * project on the machine, including the ones not yet migrated. `--scope local` writes
 * `false` to this project's `.claude/settings.local.json`, which overrides the user file
 * for this project alone; a project-scope install is turned off where it was turned on.
 */
export function disableCommand(scope: PluginScope): string {
  return `claude plugin disable ${LEGACY_PLUGIN_ID} --scope ${scope === 'project' ? 'project' : 'local'}`;
}

/**
 * What names agent-os as the place to edit rules: its source directory and its package.
 * `rulegate init` copies a hand-written CLAUDE.md into a canonical rule as it is, so a line
 * telling the agent to edit `.agent-os/rules/` and run agent-os's `sync` survives the
 * migration and sends it to a directory nothing reads any more (T153). The importer's
 * twin of this pattern is `AGENT_OS_MENTION` in `@rulegate/interop`.
 */
export const AGENT_OS_MENTION = /\.agent-os\/|@sayansr26\/agent-os\b/;

export interface AgentOsMention {
  /** Relative to the project root: `.rulegate/rules/<file>.md`. */
  readonly file: string;
  /** 1-based, ascending. */
  readonly lines: readonly number[];
}

/**
 * Canonical rules that still name agent-os's source or package, walked as `RULES_GLOB`
 * (`.rulegate/rules/**\/*.md`) reads them; symlinked directories are not followed.
 */
export function agentOsMentions(root: string): AgentOsMention[] {
  const out: AgentOsMention[] = [];
  const walk = (rel: string): void => {
    for (const name of ls(join(root, rel))) {
      const file = `${rel}/${name}`;
      if (isRealDir(join(root, file))) {
        walk(file);
        continue;
      }
      if (!name.endsWith('.md')) continue;
      const lines = (read(join(root, file)) ?? '')
        .split(/\r?\n/)
        .flatMap((l, i) => (AGENT_OS_MENTION.test(l) ? [i + 1] : []));
      if (lines.length > 0) out.push({ file, lines });
    }
  };
  walk('.rulegate/rules');
  return out;
}
