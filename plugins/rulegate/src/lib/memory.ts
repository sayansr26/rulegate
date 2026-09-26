import { basename, join } from 'node:path';
import { runGit } from '../git/index.js';
import { isDir, ls, read } from './read.js';

/**
 * Every memory store this project has, and each one's health — the deterministic half of
 * `/rulegate:memory`. Read-only.
 *
 * `stale` also compares each map's `mapped:` date with git's last commit touching its
 * `entry:`, one git call per map.
 */

export interface MemoryOptions {
  readonly root: string;
  readonly claudeDir: string;
  readonly stale?: boolean;
}

export async function runMemory({
  root,
  claudeDir,
  stale = false,
}: MemoryOptions): Promise<string[]> {
  const out: string[] = [];
  const issues: string[] = [];
  const say = (s = ''): void => {
    out.push(s);
  };

  say(`MEMORY STORES   ${root}`);
  say();

  // ---- agent memory ----
  let anyAgent = false;
  for (const [scope, base] of [
    ['project', '.claude/agent-memory'],
    ['local', '.claude/agent-memory-local'],
  ] as const) {
    for (const agent of ls(join(root, base))) {
      const adir = join(root, base, agent);
      if (!isDir(adir)) continue;
      anyAgent = true;
      const topics = ls(adir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
      const idxRaw = read(join(adir, 'MEMORY.md'));
      const idx = idxRaw ? idxRaw.split('\n').filter((l) => l.trim().startsWith('-')) : [];

      say(`${agent}  (${scope})`);
      say(
        `  index: ${String(idx.length)} entr${idx.length === 1 ? 'y' : 'ies'}   topics: ${String(topics.length)} file(s)`,
      );

      // Topic files the index never names are invisible to the agent next session.
      const orphans = topics.filter((f) => !idxRaw?.includes(basename(f, '.md')));
      // Hyphen/underscore collisions: the same subject written twice.
      const key = (f: string): string => basename(f, '.md').replace(/[-_]/g, '').toLowerCase();
      const seen = new Map<string, string>();
      const dupes: [string, string][] = [];
      for (const f of topics) {
        const first = seen.get(key(f));
        if (first !== undefined) dupes.push([first, f]);
        else seen.set(key(f), f);
      }

      for (const f of topics) {
        const t = read(join(adir, f)) ?? '';
        const mapped = /^mapped:\s*(\S+)/m.exec(t)?.[1];
        const entry = /^entry:\s*(\S+)/m.exec(t)?.[1];
        let note = '';
        if (orphans.includes(f)) note += '  NOT IN INDEX';
        if (stale && mapped !== undefined && entry !== undefined) {
          // The entry is data from a memory file, so it goes after `--`, where git reads
          // it as a path and never as an option.
          const last = (
            await runGit(['log', '--max-count=1', '--format=%cs', '--', entry], root)
          )?.trim();
          if (last && last > mapped) note += `  STALE (mapped ${mapped}, code changed ${last})`;
        }
        say(
          `    ${f.padEnd(34)} ${String(t.split('\n').length).padStart(4)} lines${mapped ? `  mapped ${mapped}` : ''}${note}`,
        );
      }
      if (orphans.length > 0) {
        issues.push(
          `${agent}: ${String(orphans.length)} topic file(s) not in MEMORY.md — invisible next session: ${orphans.join(', ')}`,
        );
      }
      for (const [a, b] of dupes)
        issues.push(`${agent}: "${a}" and "${b}" are the same subject — merge them`);
      if (idxRaw && idxRaw.split('\n').length > 200) {
        issues.push(
          `${agent}: MEMORY.md over 200 lines — everything past that is dropped at startup`,
        );
      }
      say();
    }
  }
  if (!anyAgent) {
    say('no agent memory yet — agents have not run in this project');
    say();
  }

  // ---- Claude Code auto memory ----
  const repo = (await runGit(['rev-parse', '--show-toplevel'], root))?.trim() || root;
  const autoDir = join(claudeDir, 'projects', repo.replace(/[/\\:]/g, '-'), 'memory');
  say("auto memory (Claude Code's own)");
  if (!isDir(autoDir)) say(`  none yet at ${autoDir}`);
  else {
    const idx = read(join(autoDir, 'MEMORY.md'));
    const topics = ls(autoDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    say(`  ${autoDir}`);
    say(
      `  MEMORY.md: ${idx ? `${String(idx.split('\n').length)} lines` : 'absent'}   topics: ${String(topics.length)}`,
    );
    for (const f of topics) say(`    ${f}`);
    if (idx && idx.split('\n').length > 200) {
      issues.push('auto memory MEMORY.md over 200 lines — content past that is dropped at startup');
    }
  }

  // ---- rules, the other durable store ----
  const canonical = ls(join(root, '.rulegate/rules')).filter((f) => f.endsWith('.md'));
  if (canonical.length > 0) {
    say();
    say(
      `canonical rules  .rulegate/rules/  — ${String(canonical.length)} file(s); every tool's copy is generated from these`,
    );
  }
  const rules = ls(join(root, '.claude/rules')).filter((f) => f.endsWith('.md'));
  say();
  say(`project rules  .claude/rules/  — ${String(rules.length)} file(s)`);
  for (const f of rules) {
    const t = read(join(root, '.claude/rules', f)) ?? '';
    const scoped = /^paths:/m.test(t.split('---')[1] ?? '');
    say(`  ${scoped ? 'scoped  ' : 'UNSCOPED'} ${f}`);
    if (!scoped) issues.push(`.claude/rules/${f} has no paths: — it loads every session`);
  }

  say();
  if (issues.length === 0) say('HEALTH  no issues.');
  else {
    say(`HEALTH  ${String(issues.length)} issue(s):`);
    for (const i of issues) say(`  - ${i}`);
  }
  return out;
}
