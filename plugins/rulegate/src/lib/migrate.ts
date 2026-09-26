import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_PREFIX, agentOsInstall } from './legacy.js';
import { ls, read } from './read.js';
import { blocked, inside } from './refusals.js';

/**
 * The memory migration's planner (T114) — pure, so the preview and the writer
 * (`src/migrate/`) share one answer, and the writer re-plans rather than trusting a
 * preview the tree may have moved on from.
 *
 * Each `agent-os-<agent>` directory under `.claude/agent-memory{,-local}/` goes to
 * `rulegate-<agent>`, the name Claude Code gives the same agent's memory under this plugin.
 * Every file is copied, then verified, and only then is the source removed: a map is the
 * one thing here that cannot be regenerated for free.
 *
 *   move    the target does not exist — every file is copied into a new directory
 *   merge   it does (the rulegate agent already ran): new files are copied, identical ones
 *           kept once, and the two `MEMORY.md` indexes are unioned — with agent-os's own
 *           `MEMORY.md` copied whole to `MEMORY.agent-os.md` beside it, because a union of
 *           lines cannot carry headings, repeats or fences, and the source is then removed
 *   refused nothing of this agent is touched; the reason says why
 *
 * Refused: a name that is not a plain agent name; a symlink or special file anywhere in
 * the source; a same-named file whose bytes differ (other than `MEMORY.md`); anything
 * `lib/refusals.ts` refuses for the settings writer too — a symlinked path component, a
 * path `state.json` records, a `state.json` that does not parse — and a project whose
 * `.claude/` is the user's Claude config dir. Only the two `MEMORY.md` files of a union are
 * decoded, so only they must be readable UTF-8: every other file moves as bytes, and a
 * binary note or a `.DS_Store` is copied like any other.
 */

export type AgentKind = 'move' | 'merge' | 'refused';

export interface FileMove {
  /** Relative to the agent directory, POSIX. */
  readonly rel: string;
  /** `same`: the target already holds these bytes. `union`: `MEMORY.md` indexes merged. */
  readonly action: 'copy' | 'same' | 'union';
  readonly src: string;
  readonly dst: string;
  readonly sha: string;
  /** `union` only: the target `MEMORY.md` with the new index lines appended, if any. */
  readonly next?: string;
  readonly added?: readonly string[];
  /**
   * `union` only: the target `MEMORY.md` the union was built from. The writer replaces the
   * file with `next`, so an entry written to it after planning would vanish unless the writer
   * refuses when the bytes it is about to replace are not these.
   */
  readonly dstSha?: string;
  /** Another entry shares this `src` — the whole `MEMORY.md` kept — so it is unlinked there. */
  readonly alias?: true;
}

export interface AgentMove {
  readonly base: string;
  readonly from: string;
  readonly to: string;
  readonly kind: AgentKind;
  readonly reason?: string;
  readonly srcDir: string;
  readonly dstDir: string;
  /** Subdirectories, parent first: the writer creates them in this order, removes in reverse. */
  readonly dirs: readonly { readonly rel: string; readonly src: string; readonly dst: string }[];
  readonly files: readonly FileMove[];
}

export interface MemoryPlan {
  readonly agents: readonly AgentMove[];
  /** `.gitignore` lines naming `agent-os-`: they stop matching once the directory moves. */
  readonly gitignore: readonly string[];
}

/** A plugin agent's name: what Claude Code puts after the plugin's prefix. */
const AGENT_NAME = /^agent-os-[a-z0-9][a-z0-9_-]*$/i;
/** Where a merged agent-os `MEMORY.md` is kept whole, next to the unioned index. */
export const KEPT_INDEX = 'MEMORY.agent-os.md';
/**
 * Later merges of the same agent — agent-os stays enabled until every agent has moved, and
 * a teammate's push can bring its directory back — keep their index under the next free
 * name. A fixed name would make the copy Rulegate kept last time refuse every re-run.
 */
const MAX_KEPT = 100;
export const keptName = (n: number): string =>
  n === 1 ? KEPT_INDEX : `MEMORY.agent-os.${String(n)}.md`;
export const keptPointer = (name: string): string =>
  `- [agent-os index](${name}) — agent-os's MEMORY.md, kept whole when the two were merged`;
/** Claude Code loads this many lines of an agent's `MEMORY.md`; the rest never reaches it. */
export const INDEX_LOADED_LINES = 200;
/** Far more than any agent's memory; a bound so a hostile tree cannot stall the preview. */
export const MAX_ENTRIES = 5_000;

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** `lstat`, or `undefined` when nothing is there. */
function stat(p: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(p);
  } catch {
    return undefined;
  }
}

/** Why the source tree cannot be walked, or its directories and files. */
function walk(dir: string): { reason: string } | { dirs: string[]; files: string[] } {
  const dirs: string[] = [];
  const files: string[] = [];
  let left = MAX_ENTRIES;
  const visit = (rel: string): string | undefined => {
    for (const name of ls(rel === '' ? dir : join(dir, rel))) {
      if (--left < 0) return `more than ${String(MAX_ENTRIES)} entries`;
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = stat(join(dir, r));
      if (st === undefined) return `${r} vanished while being read`;
      if (st.isSymbolicLink()) return `${r} is a symlink`;
      if (st.isDirectory()) {
        dirs.push(r);
        const why = visit(r);
        if (why !== undefined) return why;
      } else if (st.isFile()) files.push(r);
      else return `${r} is not a regular file`;
    }
    return undefined;
  };
  const why = visit('');
  return why === undefined ? { dirs, files } : { reason: why };
}

// A BOM is encoding, not content: left on, the first line of a BOM-prefixed index never
// matches the same entry in the other file and is appended a second time.
const norm = (line: string): string =>
  line
    .replace(/^\uFEFF/, '')
    .replace(/\r$/, '')
    .trimEnd();

/**
 * The target index plus every source line it lacks — a pure insert, so the user's lines
 * stay byte for byte and a CRLF file stays CRLF. Headings are the index's own structure,
 * not entries, and a second `# Memory` under the first says nothing. Source lines are
 * appended; `first` lines (the pointer to the kept index) go before the target's first
 * entry instead, because only the first 200 lines load and the pointer is what leads to
 * everything a long merge pushes past them.
 */
export function unionIndex(
  target: string,
  source: string,
  first: readonly string[] = [],
): { next?: string; added: string[] } {
  const have = new Set(target.split('\n').map(norm));
  const take = (lines: readonly string[]): string[] => {
    const out: string[] = [];
    for (const raw of lines) {
      const line = norm(raw);
      if (line.trim() === '' || line.trimStart().startsWith('#') || have.has(line)) continue;
      have.add(line);
      out.push(line);
    }
    return out;
  };
  const top = take(first);
  const tail = take(source.split('\n'));
  const added = [...top, ...tail];
  if (added.length === 0) return { added };
  const crlf = target.includes('\r\n') && !/(^|[^\r])\n/.test(target);
  const eol = crlf ? '\r\n' : '\n';
  let head = '';
  let rest = target;
  if (top.length > 0) {
    // The offset of the first entry line; with none, the pointer simply leads the tail.
    let at = 0;
    for (const line of target.split('\n')) {
      const l = norm(line);
      if (l.trim() !== '' && !l.trimStart().startsWith('#')) break;
      at += line.length + 1;
    }
    if (at < target.length) {
      head = `${target.slice(0, at)}${top.join(eol)}${eol}`;
      rest = target.slice(at);
    } else tail.unshift(...top);
  }
  const body = `${head}${rest}`;
  if (tail.length === 0) return { added, next: body };
  const lead = body === '' || body.endsWith('\n') ? '' : eol;
  return { added, next: `${body}${lead}${tail.join(eol)}${eol}` };
}

/** Lines of an index as Claude Code counts them for its 200-line cut. */
export const indexLines = (text: string): number =>
  text === '' ? 0 : text.replace(/\r?\n$/, '').split('\n').length;

/** Every source line a union must carry: what the writer verifies before removing it. */
export const indexEntries = (source: string): string[] =>
  source
    .split('\n')
    .map(norm)
    .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));

async function planAgent(
  root: string,
  claudeDir: string,
  base: string,
  from: string,
  to: string,
): Promise<AgentMove> {
  const srcDir = join(root, base, from);
  const dstDir = join(root, base, to);
  const shell = { base, from, to, srcDir, dstDir, dirs: [], files: [] };
  const refuse = (reason: string): AgentMove => ({ ...shell, kind: 'refused', reason });

  if (!AGENT_NAME.test(from)) return refuse('not a plain agent name');
  // `.claude`, the base, and the agent directory must each be a real directory: a link at
  // any of them turns "move this project's memory" into moving files somewhere else.
  const parts = [...base.split('/'), from];
  for (let i = 1; i <= parts.length; i++) {
    const rel = parts.slice(0, i).join('/');
    if (stat(join(root, rel))?.isSymbolicLink() === true) return refuse(`${rel} is a symlink`);
  }
  if (inside(claudeDir, srcDir)) {
    return refuse('this is the user-level Claude config, not a project — run from the project');
  }
  const target = stat(dstDir);
  if (target !== undefined && (target.isSymbolicLink() || !target.isDirectory())) {
    return refuse(`${to} exists and is not a directory`);
  }
  const tree = walk(srcDir);
  if ('reason' in tree) return refuse(tree.reason);

  for (const d of tree.dirs) {
    const st = stat(join(dstDir, d));
    if (st !== undefined && (st.isSymbolicLink() || !st.isDirectory())) {
      return refuse(`${to}/${d} exists and is not a directory`);
    }
  }
  const files: FileMove[] = [];
  const conflicts: string[] = [];
  for (const rel of tree.files) {
    const src = join(srcDir, rel);
    const dst = join(dstDir, rel);
    for (const p of [src, dst]) {
      const why = await blocked('project', root, claudeDir, p, { bytes: true });
      if (why !== undefined) return refuse(`${p === src ? from : to}/${rel}: ${why}`);
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(src);
    } catch {
      return refuse(`${from}/${rel} could not be read`);
    }
    const sha = sha256(bytes);
    const there = stat(dst);
    if (there === undefined) {
      files.push({ rel, action: 'copy', src, dst, sha });
      continue;
    }
    let theirs: Buffer;
    try {
      theirs = readFileSync(dst);
    } catch {
      return refuse(`${to}/${rel} could not be read`);
    }
    if (theirs.equals(bytes)) files.push({ rel, action: 'same', src, dst, sha });
    else if (rel === 'MEMORY.md') {
      // The union decodes both indexes, so here — and only here — they must be text.
      for (const p of [src, dst]) {
        const why = await blocked('project', root, claudeDir, p);
        if (why !== undefined) return refuse(`${p === src ? from : to}/${rel}: ${why}`);
      }
      // The union carries index lines only, so the source is kept whole before it goes:
      // copied like any other file, verified, and linked from the merged index. A kept
      // copy already holding these bytes is reused; one holding others — an earlier merge's
      // — stays, and this one takes the next free name.
      let name: string | undefined;
      let keptBytes: Buffer | undefined;
      for (let n = 1; n <= MAX_KEPT && name === undefined; n++) {
        const candidate = keptName(n);
        if (tree.files.includes(candidate)) continue;
        const kept = join(dstDir, candidate);
        const why = await blocked('project', root, claudeDir, kept, { bytes: true });
        if (why !== undefined) return refuse(`${to}/${candidate}: ${why}`);
        if (stat(kept) === undefined) {
          name = candidate;
          keptBytes = undefined;
          break;
        }
        try {
          keptBytes = readFileSync(kept);
        } catch {
          return refuse(`${to}/${candidate} could not be read`);
        }
        if (keptBytes.equals(bytes)) name = candidate;
      }
      if (name === undefined) {
        return refuse(`${String(MAX_KEPT)} kept agent-os indexes already — merge them by hand`);
      }
      files.push({
        rel: name,
        action: keptBytes === undefined ? 'copy' : 'same',
        src,
        dst: join(dstDir, name),
        sha,
        alias: true,
      });
      const { next, added } = unionIndex(theirs.toString('utf8'), read(src) ?? '', [
        keptPointer(name),
      ]);
      files.push({
        rel,
        action: 'union',
        src,
        dst,
        sha,
        added,
        dstSha: sha256(theirs),
        ...(next === undefined ? {} : { next }),
      });
    } else conflicts.push(rel);
  }
  if (conflicts.length > 0) {
    return refuse(
      `${conflicts.join(', ')} differ${conflicts.length === 1 ? 's' : ''} from ${to}/ — merge by hand (/rulegate:memory), then re-run`,
    );
  }
  const dirs = tree.dirs.map((rel) => ({ rel, src: join(srcDir, rel), dst: join(dstDir, rel) }));
  return { ...shell, kind: target === undefined ? 'move' : 'merge', dirs, files };
}

export async function planMemoryMigration(root: string, claudeDir: string): Promise<MemoryPlan> {
  const agents: AgentMove[] = [];
  for (const m of agentOsInstall(root, claudeDir).memory) {
    agents.push(await planAgent(root, claudeDir, m.base, m.name, m.target));
  }
  const gitignore: string[] = [];
  for (const f of ['.gitignore', '.claude/.gitignore']) {
    (read(join(root, f)) ?? '').split('\n').forEach((line, i) => {
      if (line.includes(LEGACY_PREFIX)) gitignore.push(`${f}:${String(i + 1)}  ${norm(line)}`);
    });
  }
  return { agents, gitignore };
}

export interface MigrationOutcome {
  /** Agents whose source is gone, every file verified at the target. */
  readonly moved?: readonly string[];
  /** Agents the writer started and stopped, source intact, and why. */
  readonly failed?: readonly { readonly agent: string; readonly reason: string }[];
}

const where = (a: AgentMove): string => `${a.base}/${a.from}`;

export function describeMigration(
  plan: MemoryPlan,
  { dry, moved = [], failed = [] }: { dry: boolean } & MigrationOutcome,
): string[] {
  const lines = [
    `RULEGATE MIGRATE-MEMORY  ${dry ? 'preview — nothing written; re-run with --apply' : 'applied'}`,
    '',
  ];
  if (plan.agents.length === 0)
    lines.push('  nothing to migrate — no agent-os memory in this project');
  for (const a of plan.agents) {
    lines.push(`  ${where(a)} → ${a.to}`);
    if (a.kind === 'refused') {
      lines.push(`    ${dry ? 'will be refused' : 'refused'} — ${a.reason ?? ''}; nothing touched`);
      continue;
    }
    const count = (action: FileMove['action']): number =>
      a.files.filter((f) => f.action === action).length;
    const union = a.files.find((f) => f.action === 'union');
    const kept = a.files.find((f) => f.alias === true);
    const parts = [
      `${dry ? 'copy' : 'copied'} ${String(count('copy'))} file(s)`,
      ...(count('same') > 0 ? [`${String(count('same'))} already there`] : []),
      ...(union !== undefined
        ? [
            `MEMORY.md ${dry ? 'gains' : 'gained'} ${String(union.added?.length ?? 0)} index line(s)`,
          ]
        : []),
      ...(kept !== undefined ? [`agent-os's MEMORY.md kept whole as ${kept.rel}`] : []),
    ];
    lines.push(`    ${a.kind === 'move' ? 'new directory' : 'merge'}: ${parts.join(', ')}`);
    const size = union?.next === undefined ? 0 : indexLines(union.next);
    if (size > INDEX_LOADED_LINES) {
      lines.push(
        `    MEMORY.md ${dry ? 'will be' : 'is'} ${String(size)} lines — Claude Code loads the first ${String(INDEX_LOADED_LINES)}; trim it with /rulegate:memory`,
      );
    }
    const fail = failed.find((f) => f.agent === where(a));
    if (fail !== undefined) lines.push(`    stopped — ${fail.reason}; ${a.from} left in place`);
    else if (moved.includes(where(a))) lines.push(`    verified; ${a.from} removed`);
    else if (dry) lines.push(`    then ${a.from} is removed, once every file is verified`);
  }
  for (const g of plan.gitignore) {
    lines.push(
      '',
      `  ${g}`,
      '    names agent-os memory — it stops matching once the directory moves; update it by hand',
    );
  }
  return lines;
}
