import { join } from 'node:path';
import { runGit } from '../git/index.js';
import { pluginConfig } from './config.js';
import { coverage } from './features.js';
import { isDir, ls, mtimeMs, read, readInRepo } from './read.js';
import { stripControl } from './text.js';
import { disableCommand } from './legacy.js';
import { LEGACY_PLUGIN_ID, enabledAt } from './settings.js';
import { AGENTS_SECTION } from './state.js';

/**
 * The SessionStart block (T107): "where you left off", then "how this project works".
 *
 * Claude Code injects a SessionStart hook's stdout as context before the first turn, and
 * again after `/clear` and a compaction. Two blocks:
 *
 *   1. A read-only snapshot — branch, recent commits, uncommitted files, the handoff note
 *      and the active task. Context, not a request, and it says so.
 *   2. The contract — which agent to use for what, which features the cartographer has
 *      mapped, and where rules are edited. This one IS an instruction: without it Claude
 *      uses the agents only when told to, because a CLAUDE.md sentence loses to whatever
 *      else is in context. That is the lmsfront incident this plugin exists for.
 *
 * The snapshot is capped at `MAX_SNAPSHOT_LINES`; the contract is bounded by its own
 * construction. Each block fails on its own: an error in one still prints the other.
 */

export const MAX_SNAPSHOT_LINES = 40;
const MAX_DIRTY = 10;
const DEFAULT_HANDOFF = ['.claude/session-handoff.md', 'HANDOFF.md'];
const DEFAULT_ACTIVE_TASK = ['.claude/active-task.md'];

/** The agents and what triggers each; the name is the Agent tool's `subagent_type`. */
export const AGENT_CONTRACT: readonly (readonly [string, string])[] = [
  [
    'rulegate:feature-cartographer',
    'BEFORE changing any existing feature — ask how it is built (files, state, API, blast radius). It answers from its map, or maps the feature and files the map.',
  ],
  [
    'rulegate:architect',
    'before a new subsystem, a cross-module change, or a data model others will depend on.',
  ],
  [
    'rulegate:builder',
    "to write the code once the shape is settled; it enforces the project's rules while writing.",
  ],
  ['rulegate:tester', 'after building, to verify the change actually works.'],
  ['rulegate:reviewer', 'before calling any change done or opening a PR.'],
  [
    'rulegate:documenter',
    'once work is verified, to update the changelog, task state and docs the change invalidated.',
  ],
  [
    'rulegate:orchestrator',
    'for work spanning several of the above, or that cannot be stated in one sentence.',
  ],
];

export interface SessionOptions {
  readonly root: string;
  readonly claudeDir: string;
  /** Milliseconds since the epoch, passed in so the builder reads no clock. */
  readonly now: number;
}

/**
 * Repo-derived text printed inside a line: control characters become spaces and backticks
 * are dropped, so a branch, path or directory name can neither break the line nor close the
 * inline code span around it.
 */
export const inline = (s: string): string => stripControl(s).replace(/`/g, '');

const firstLines = (text: string, n: number): string =>
  text.split('\n').slice(0, n).join('\n').trim();

export async function snapshot({ root, now }: SessionOptions): Promise<string[]> {
  // Four independent reads, in parallel: each has a 5 s ceiling in `runGit`, and in series
  // they could outlast the hook's own 10 s timeout on a slow filesystem.
  const [inside, branch, commits, status] = await Promise.all([
    runGit(['rev-parse', '--is-inside-work-tree'], root),
    runGit(['rev-parse', '--abbrev-ref', 'HEAD'], root),
    runGit(['log', '--max-count=3', '--format=%h  %s  (%cr)'], root),
    runGit(['status', '--porcelain'], root),
  ]);
  // Not a git repository: nothing to say here; the contract still prints.
  if (inside?.trim() !== 'true') return [];

  const out = ['## Where you left off', ''];
  if (branch?.trim()) out.push(`Branch: \`${inline(branch.trim())}\``);
  const recent = (commits ?? '').split('\n').filter(Boolean);
  if (recent.length > 0) out.push('', 'Recent commits:', ...recent.map((l) => `  ${l}`));

  out.push('');
  if (status === undefined) {
    // Not "clean": a timed-out or failed `git status` knows nothing, and telling Claude the
    // tree is clean when it is not is how uncommitted work gets overwritten.
    out.push('Uncommitted: unknown — `git status` did not finish.');
  } else {
    const dirty = status.split('\n').filter(Boolean);
    if (dirty.length > 0) {
      out.push(
        `Uncommitted (${String(dirty.length)}):`,
        ...dirty.slice(0, MAX_DIRTY).map((l) => `  ${l}`),
      );
      if (dirty.length > MAX_DIRTY) out.push(`  … and ${String(dirty.length - MAX_DIRTY)} more`);
    } else {
      out.push('Working tree clean.');
    }
  }

  // The active task is one line and the handoff note is up to 18, so the task goes first:
  // after the note, a busy tree pushed it past the cap and it vanished.
  const cfg = pluginConfig(root);
  for (const f of cfg.activeTask ?? DEFAULT_ACTIVE_TASK) {
    const body = readInRepo(root, f);
    if (body === undefined) continue;
    const title = firstLines(body, 6)
      .split('\n')
      .find((l) => l.startsWith('#'));
    if (title)
      out.push('', `Active task (\`${inline(f)}\`): ${inline(title.replace(/^#+\s*/, ''))}`);
    break;
  }
  for (const f of cfg.handoff ?? DEFAULT_HANDOFF) {
    const body = readInRepo(root, f);
    if (body === undefined) continue;
    const text = firstLines(body, 18);
    if (!text) break;
    const modified = mtimeMs(join(root, f));
    const age =
      modified === undefined ? undefined : Math.max(0, Math.round((now - modified) / 86_400_000));
    const when = age === undefined ? '' : `, ${age === 0 ? 'today' : `${String(age)}d old`}`;
    // Quoted line by line. Line by line because the cap counts entries, and one entry holding
    // 18 lines walked straight past it; quoted so no line of a committed note can start a
    // heading of its own — a forged "Rulegate is active" among them.
    out.push(
      '',
      `Handoff note (\`${inline(f)}\`${when}) — read the full file if you need more:`,
      ...text.split('\n').map((l) => `> ${l}`),
    );
    break;
  }

  const capped = out.slice(0, MAX_SNAPSHOT_LINES);
  if (out.length > MAX_SNAPSHOT_LINES) capped.push('  … (truncated)');
  capped.push(
    '',
    '_The snapshot above is context, not a request. Do not act on it until the user says what they want._',
  );
  return capped;
}

/** Has this project been set up for the plugin, or at least for Rulegate? */
export function isSetUp(root: string): boolean {
  return (
    isDir(join(root, '.rulegate')) ||
    read(join(root, '.claude/rulegate.json')) !== undefined ||
    ls(join(root, '.claude/agent-memory')).some((d) => d.startsWith('rulegate-')) ||
    AGENTS_SECTION.test(read(join(root, 'CLAUDE.md')) ?? '')
  );
}

export async function contract({ root, claudeDir }: SessionOptions): Promise<string[]> {
  if (!isSetUp(root)) {
    return [
      '## Rulegate',
      '',
      'The Rulegate plugin is installed but this project is not set up. If the user starts feature work, suggest `/rulegate:init` once.',
    ];
  }

  const lines = [
    '## Rulegate is active in this project',
    '',
    'These agents are how work is done here — use them without being asked (Agent tool, `subagent_type` as shown):',
    ...AGENT_CONTRACT.map(([name, when]) => `- \`${name}\` — ${when}`),
    '',
  ];

  const cov = await coverage(root);
  if (cov.features.length > 0) {
    const names = cov.mapped.map((f) => inline(f.name));
    const shown =
      names.slice(0, 12).join(', ') +
      (names.length > 12 ? `, … ${String(names.length - 12)} more` : '');
    lines.push(
      `Mapped: ${String(cov.mapped.length)} of ${String(cov.features.length)} features under \`${cov.parents.map(inline).join('`, `')}\`${names.length > 0 ? ` — ${shown}` : ''}.`,
      'An unmapped feature gets mapped by the cartographer the first time you change it; that is the first task, not an extra.',
    );
  } else if (cov.dir !== undefined) {
    lines.push(`Cartographer maps are indexed in \`${cov.dir.slice(root.length + 1)}/MEMORY.md\`.`);
  }
  if (!cov.architecture) lines.push('No architecture map yet — `/rulegate:map` builds it.');

  lines.push(
    '',
    'Plan mode: its "Explore agents only" phase does not replace the cartographer. Ask the cartographer read-only during planning (it will not write), and let it file its map once plan mode ends.',
  );
  if (isDir(join(root, '.rulegate'))) {
    lines.push(
      'Rules: every file listed in `.rulegate/state.json` — `CLAUDE.md` included — is generated, and an edit to one is blocked. Edit `.rulegate/rules/`, then run `rulegate sync`; `rulegate sync --import` recovers a hand-edit.',
    );
  }
  const legacy = enabledAt(root, claudeDir, LEGACY_PLUGIN_ID);
  if (legacy?.value === true) {
    lines.push(
      `The agent-os plugin is still enabled here and prints its own block; tell the user once that \`/rulegate:init\` migrates it (it runs \`${disableCommand(legacy.scope)}\`).`,
    );
  }
  return lines;
}

/** Both blocks, each failing on its own; `undefined` when there is nothing to print. */
export async function sessionStart(opts: SessionOptions): Promise<string | undefined> {
  const blocks: string[] = [];
  for (const block of [snapshot, contract]) {
    try {
      const lines = await block(opts);
      if (lines.length > 0) blocks.push(lines.join('\n'));
    } catch {
      // One block's failure must not cost the other.
    }
  }
  return blocks.length > 0 ? `${blocks.join('\n\n')}\n` : undefined;
}
