import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  KEPT_INDEX,
  describeMigration,
  keptPointer,
  indexEntries,
  planMemoryMigration,
  unionIndex,
} from '../src/lib/migrate.js';
import { applyMemoryMigration } from '../src/migrate/memory.js';
import type * as Migrate from '../src/lib/migrate.js';
import { sandbox, type Sandbox } from './helpers.js';

/**
 * The memory migration (T114): the planner, the writer, and the bundled entry. Every case
 * runs in a sandbox whose project root and Claude config dir are separate temp directories;
 * the spawned cases point HOME and CLAUDE_CONFIG_DIR into it as well.
 */
let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  hooks.afterPlan = undefined;
  await sb.dispose();
});

/**
 * The writer plans every agent before it moves any, so a write can land between the two —
 * a subagent's new entry, a pull. `afterPlan` stands in for it.
 */
const hooks = vi.hoisted(() => ({ afterPlan: undefined as (() => void) | undefined }));
vi.mock('../src/lib/migrate.js', async (importOriginal) => {
  const real = await importOriginal<typeof Migrate>();
  return {
    ...real,
    planMemoryMigration: async (...args: Parameters<typeof real.planMemoryMigration>) => {
      const p = await real.planMemoryMigration(...args);
      hooks.afterPlan?.();
      return p;
    },
  };
});

const MEM = '.claude/agent-memory';
const POINTER = keptPointer(KEPT_INDEX);
/** A Finder `.DS_Store`'s opening bytes: not UTF-8, and nothing an agent ever reads. */
const DS_STORE = Buffer.from([0, 0, 0, 1, 0x42, 0x75, 0x64, 0x31, 0xff, 0xfe, 0x80]);
const at = (rel: string): string => path.join(sb.root, rel);
const text = (rel: string): string => readFileSync(at(rel), 'utf8');
const plan = () => planMemoryMigration(sb.root, sb.claudeDir);
const apply = () => applyMemoryMigration(sb.root, sb.claudeDir);

describe('planMemoryMigration', () => {
  it('plans a new directory when the rulegate one is absent', async () => {
    await sb.put(`${MEM}/agent-os-feature-cartographer/MEMORY.md`, '- [auth](auth.md)\n');
    await sb.put(`${MEM}/agent-os-feature-cartographer/auth.md`, 'mapped: 2026-09-01\n');
    const p = await plan();
    expect(p.agents).toHaveLength(1);
    expect(p.agents[0]).toMatchObject({
      from: 'agent-os-feature-cartographer',
      to: 'rulegate-feature-cartographer',
      kind: 'move',
    });
    expect(p.agents[0]?.files.map((f) => [f.rel, f.action])).toEqual([
      ['MEMORY.md', 'copy'],
      ['auth.md', 'copy'],
    ]);
  });

  it('moves a binary or large file as bytes rather than refusing it as non-text', async () => {
    // Only the MEMORY.md union decodes anything; the text gates are the settings writer's.
    const from = `${MEM}/agent-os-builder`;
    await sb.put(`${from}/MEMORY.md`, '- [a](a.md)\n');
    await sb.put(`${from}/big.md`, 'x'.repeat(5 * 1024 * 1024));
    writeFileSync(at(`${from}/.DS_Store`), DS_STORE);
    const p = await plan();
    expect(p.agents[0]?.kind).toBe('move');
    const r = await apply();
    expect(r.failed).toEqual([]);
    expect(readFileSync(at(`${MEM}/rulegate-builder/.DS_Store`)).equals(DS_STORE)).toBe(true);
    expect(statSync(at(`${MEM}/rulegate-builder/big.md`)).size).toBe(5 * 1024 * 1024);
    expect(existsSync(at(from))).toBe(false);
  });

  it('merges past an identical binary file, and still refuses a non-UTF-8 index union', async () => {
    await sb.put(`${MEM}/agent-os-builder/MEMORY.md`, '- [a](a.md)\n');
    await sb.put(`${MEM}/rulegate-builder/MEMORY.md`, '- [b](b.md)\n');
    writeFileSync(at(`${MEM}/agent-os-builder/.DS_Store`), DS_STORE);
    writeFileSync(at(`${MEM}/rulegate-builder/.DS_Store`), DS_STORE);
    expect((await plan()).agents[0]?.kind).toBe('merge');
    writeFileSync(at(`${MEM}/rulegate-builder/MEMORY.md`), DS_STORE);
    const refused = (await plan()).agents[0];
    expect(refused?.kind).toBe('refused');
    expect(refused?.reason).toContain('rulegate-builder/MEMORY.md: not UTF-8 text');
  });

  it('writes nothing while planning or previewing', async () => {
    await sb.put(`${MEM}/agent-os-reviewer/MEMORY.md`, '- x\n');
    describeMigration(await plan(), { dry: true });
    expect(existsSync(at(`${MEM}/rulegate-reviewer`))).toBe(false);
    expect(text(`${MEM}/agent-os-reviewer/MEMORY.md`)).toBe('- x\n');
  });

  it('refuses a same-named file whose bytes differ, and names it', async () => {
    await sb.put(`${MEM}/agent-os-reviewer/patterns.md`, 'old\n');
    await sb.put(`${MEM}/rulegate-reviewer/patterns.md`, 'new\n');
    const [a] = (await plan()).agents;
    expect(a?.kind).toBe('refused');
    expect(a?.reason).toMatch(/patterns\.md differs from rulegate-reviewer\//);
  });

  it('refuses a symlink anywhere in the source', async () => {
    await sb.put(`${MEM}/agent-os-reviewer/MEMORY.md`, '');
    await sb.put('elsewhere.md', 'x');
    await symlink(at('elsewhere.md'), at(`${MEM}/agent-os-reviewer/linked.md`));
    const [a] = (await plan()).agents;
    expect(a).toMatchObject({ kind: 'refused', reason: 'linked.md is a symlink' });
  });

  it.skipIf(process.platform === 'win32')('refuses a special file', async () => {
    await sb.put(`${MEM}/agent-os-reviewer/MEMORY.md`, '');
    execFileSync('mkfifo', [at(`${MEM}/agent-os-reviewer/pipe`)]);
    expect((await plan()).agents[0]).toMatchObject({
      kind: 'refused',
      reason: 'pipe is not a regular file',
    });
  });

  it('fails closed on a state.json that does not parse', async () => {
    await sb.put(`${MEM}/agent-os-reviewer/MEMORY.md`, '- x\n');
    await sb.put('.rulegate/state.json', '{ nope');
    expect((await plan()).agents[0]?.reason).toMatch(/state\.json does not parse/);
  });

  it('refuses a path state.json records as generated', async () => {
    await sb.put(`${MEM}/agent-os-reviewer/MEMORY.md`, '- x\n');
    await sb.put('.rulegate/state.json', {
      schemaVersion: 1,
      artifacts: [
        { path: `${MEM}/rulegate-reviewer/MEMORY.md`, hash: 'h', adapter: 'x', kind: 'rules' },
      ],
    });
    expect((await plan()).agents[0]?.reason).toMatch(/generated by Rulegate/);
  });

  it('reports a .gitignore line that stops matching once the directory moves', async () => {
    await sb.put(`${MEM}/agent-os-reviewer/MEMORY.md`, '');
    await sb.put('.gitignore', 'node_modules/\n.claude/agent-memory/agent-os-reviewer/\n');
    expect((await plan()).gitignore).toEqual([
      '.gitignore:2  .claude/agent-memory/agent-os-reviewer/',
    ]);
  });
});

describe('unionIndex', () => {
  it('appends the missing entries and nothing else, leaving the target bytes alone', () => {
    const r = unionIndex('# Memory\n\n- [a](a.md)  ', '# Old\n- [a](a.md)\n- [b](b.md)\n\n');
    expect(r.added).toEqual(['- [b](b.md)']);
    expect(r.next).toBe('# Memory\n\n- [a](a.md)  \n- [b](b.md)\n');
  });

  it('puts the kept-index pointer before the first entry, inside the lines that load', () => {
    const target = `# Memory\n\n${Array.from({ length: 250 }, (_, i) => `- [n${String(i)}](n.md)`).join('\n')}\n`;
    const r = unionIndex(target, '- [z](z.md)\n', ['- [kept](k.md)']);
    expect(r.added).toEqual(['- [kept](k.md)', '- [z](z.md)']);
    const lines = (r.next ?? '').split('\n');
    expect(lines.slice(0, 4)).toEqual(['# Memory', '', '- [kept](k.md)', '- [n0](n.md)']);
    expect(lines.at(-2)).toBe('- [z](z.md)');
    // With no entry to lead, it simply leads the appended ones.
    expect(unionIndex('# Memory\n', '- a\n', ['- p']).next).toBe('# Memory\n- p\n- a\n');
    expect(unionIndex('- a\r\n', '- b\n', ['- p']).next).toBe('- p\r\n- a\r\n- b\r\n');
  });

  it('keeps a CRLF index CRLF, and has nothing to add when the target has it all', () => {
    expect(unionIndex('- a\r\n', '- b\n').next).toBe('- a\r\n- b\r\n');
    expect(unionIndex('- a\n- b\n', '- b\n').next).toBeUndefined();
  });

  it('reads past a BOM, so the first entry of a BOM-prefixed index is not appended twice', () => {
    const r = unionIndex(
      '# Reviewer\n- [a](a.md) — x\n',
      '\uFEFF- [a](a.md) — x\n- [b](b.md) — y\n',
    );
    expect(r.added).toEqual(['- [b](b.md) — y']);
    expect(r.next).toBe('# Reviewer\n- [a](a.md) — x\n- [b](b.md) — y\n');
    expect(indexEntries('\uFEFF- [a](a.md)\n')).toEqual(['- [a](a.md)']);
  });
});

describe('applyMemoryMigration', () => {
  it('moves every file byte for byte, subdirectories and modes included, then removes the source', async () => {
    const from = `${MEM}/agent-os-feature-cartographer`;
    await sb.put(`${from}/MEMORY.md`, '- [auth](auth.md)\n');
    await sb.put(`${from}/auth.md`, 'mapped: 2026-09-01\n');
    await sb.put(`${from}/old/notes.md`, 'nested\n');
    chmodSync(at(`${from}/auth.md`), 0o600);
    const r = await apply();
    expect(r.failed).toEqual([]);
    expect(r.moved).toEqual([from]);
    const to = `${MEM}/rulegate-feature-cartographer`;
    expect(text(`${to}/MEMORY.md`)).toBe('- [auth](auth.md)\n');
    expect(text(`${to}/auth.md`)).toBe('mapped: 2026-09-01\n');
    expect(text(`${to}/old/notes.md`)).toBe('nested\n');
    if (process.platform !== 'win32')
      expect(statSync(at(`${to}/auth.md`)).mode & 0o777).toBe(0o600);
    expect(existsSync(at(from))).toBe(false);
  });

  it('merges into an existing rulegate directory: new files copied, identical ones kept once, indexes unioned', async () => {
    await sb.put(
      `${MEM}/agent-os-reviewer/MEMORY.md`,
      '# Old\n- [patterns](patterns.md)\n- [c](c.md)\n',
    );
    await sb.put(`${MEM}/agent-os-reviewer/patterns.md`, 'p\n');
    await sb.put(`${MEM}/agent-os-reviewer/c.md`, 'c\n');
    await sb.put(`${MEM}/rulegate-reviewer/MEMORY.md`, '# Reviewer\n\n- [c](c.md)\n');
    await sb.put(`${MEM}/rulegate-reviewer/c.md`, 'c\n');
    const r = await apply();
    expect(r.failed).toEqual([]);
    expect(text(`${MEM}/rulegate-reviewer/MEMORY.md`)).toBe(
      `# Reviewer\n\n${POINTER}\n- [c](c.md)\n- [patterns](patterns.md)\n`,
    );
    expect(text(`${MEM}/rulegate-reviewer/${KEPT_INDEX}`)).toBe(
      '# Old\n- [patterns](patterns.md)\n- [c](c.md)\n',
    );
    // The first original is kept, as the settings writer keeps its first backup.
    expect(text(`${MEM}/rulegate-reviewer/MEMORY.md.rulegate.bak`)).toBe(
      '# Reviewer\n\n- [c](c.md)\n',
    );
    expect(text(`${MEM}/rulegate-reviewer/patterns.md`)).toBe('p\n');
    expect(existsSync(at(`${MEM}/agent-os-reviewer`))).toBe(false);
  });

  it('keeps a merged agent-os index whole: headings, repeats and fences survive the union', async () => {
    // A union carries index lines as a set; MEMORY.md is free-form notes as often as links.
    const source =
      '# Memory\n## Payments\n- never retry refunds\n```\nretry=0\n```\n## Billing\n- never retry refunds\n```\nlimit=5\n```\n';
    await sb.put(`${MEM}/agent-os-reviewer/MEMORY.md`, source);
    await sb.put(`${MEM}/rulegate-reviewer/MEMORY.md`, '# Memory\n- [auth](auth.md)\n');
    const r = await apply();
    expect(r.failed).toEqual([]);
    expect(text(`${MEM}/rulegate-reviewer/${KEPT_INDEX}`)).toBe(source);
    expect(text(`${MEM}/rulegate-reviewer/MEMORY.md`)).toContain(POINTER);
    expect(existsSync(at(`${MEM}/agent-os-reviewer`))).toBe(false);
    expect(describeMigration(r.plan, { dry: false, moved: r.moved }).join('\n')).toContain(
      `agent-os's MEMORY.md kept whole as ${KEPT_INDEX}`,
    );
  });

  it('keeps a merged index under the next free name when an earlier one holds other bytes', async () => {
    await sb.put(`${MEM}/agent-os-reviewer/MEMORY.md`, '- a\n');
    await sb.put(`${MEM}/rulegate-reviewer/MEMORY.md`, '- b\n');
    await sb.put(`${MEM}/rulegate-reviewer/${KEPT_INDEX}`, 'other\n');
    const r = await apply();
    expect(r.failed).toEqual([]);
    expect(text(`${MEM}/rulegate-reviewer/${KEPT_INDEX}`)).toBe('other\n');
    expect(text(`${MEM}/rulegate-reviewer/MEMORY.agent-os.2.md`)).toBe('- a\n');
    expect(text(`${MEM}/rulegate-reviewer/MEMORY.md`)).toBe(
      `${keptPointer('MEMORY.agent-os.2.md')}\n- b\n- a\n`,
    );
  });

  it('merges the same agent again after agent-os writes its memory back', async () => {
    // agent-os stays enabled until every agent has moved, and a teammate's push can bring
    // its directory back: the index Rulegate kept last time must not block this merge.
    await sb.put(`${MEM}/agent-os-builder/MEMORY.md`, '- [a](a.md)\n');
    await sb.put(`${MEM}/agent-os-builder/a.md`, 'a\n');
    await sb.put(`${MEM}/rulegate-builder/MEMORY.md`, '- [b](b.md)\n');
    expect((await apply()).failed).toEqual([]);
    await sb.put(`${MEM}/agent-os-builder/MEMORY.md`, '- [a](a.md)\n- [c](c.md)\n');
    await sb.put(`${MEM}/agent-os-builder/a.md`, 'a\n');
    await sb.put(`${MEM}/agent-os-builder/c.md`, 'c\n');
    const r = await apply();
    expect(r.plan.agents[0]?.kind).toBe('merge');
    expect(r.failed).toEqual([]);
    expect(text(`${MEM}/rulegate-builder/${KEPT_INDEX}`)).toBe('- [a](a.md)\n');
    expect(text(`${MEM}/rulegate-builder/MEMORY.agent-os.2.md`)).toBe('- [a](a.md)\n- [c](c.md)\n');
    const index = text(`${MEM}/rulegate-builder/MEMORY.md`);
    expect(index).toContain(POINTER);
    expect(index).toContain(keptPointer('MEMORY.agent-os.2.md'));
    expect(index).toContain('- [c](c.md)');
    expect(existsSync(at(`${MEM}/agent-os-builder`))).toBe(false);
    // A third run finds nothing to do.
    expect((await apply()).plan.agents).toEqual([]);
  });

  it('refuses to replace a target index that changed after planning, and loses nothing', async () => {
    await sb.put(`${MEM}/agent-os-builder/MEMORY.md`, '- [a](a.md)\n');
    await sb.put(`${MEM}/agent-os-builder/a.md`, 'a\n');
    await sb.put(`${MEM}/rulegate-builder/MEMORY.md`, '- [b](b.md)\n');
    hooks.afterPlan = () => {
      writeFileSync(at(`${MEM}/rulegate-builder/MEMORY.md`), '- [b](b.md)\n- [late](late.md)\n');
    };
    const r = await apply();
    expect(r.moved).toEqual([]);
    expect(r.failed).toEqual([
      { agent: `${MEM}/agent-os-builder`, reason: 'MEMORY.md changed during the move' },
    ]);
    expect(text(`${MEM}/rulegate-builder/MEMORY.md`)).toBe('- [b](b.md)\n- [late](late.md)\n');
    expect(text(`${MEM}/agent-os-builder/MEMORY.md`)).toBe('- [a](a.md)\n');
    // A re-run plans from the file as it now is and keeps the late entry.
    hooks.afterPlan = undefined;
    expect((await apply()).failed).toEqual([]);
    expect(text(`${MEM}/rulegate-builder/MEMORY.md`)).toBe(
      `${POINTER}\n- [b](b.md)\n- [late](late.md)\n- [a](a.md)\n`,
    );
  });

  it("backs up each merge's own pre-image, not only the first", async () => {
    await sb.put(`${MEM}/agent-os-builder/MEMORY.md`, '- [a](a.md)\n');
    await sb.put(`${MEM}/rulegate-builder/MEMORY.md`, '- [b](b.md)\n');
    expect((await apply()).failed).toEqual([]);
    const first = text(`${MEM}/rulegate-builder/MEMORY.md`);
    await sb.put(`${MEM}/agent-os-builder/MEMORY.md`, '- [c](c.md)\n');
    expect((await apply()).failed).toEqual([]);
    expect(text(`${MEM}/rulegate-builder/MEMORY.md.rulegate.bak`)).toBe('- [b](b.md)\n');
    expect(text(`${MEM}/rulegate-builder/MEMORY.md.rulegate.2.bak`)).toBe(first);
  });

  it('reuses a kept index that already holds these bytes, as a retried merge finds it', async () => {
    await sb.put(`${MEM}/agent-os-reviewer/MEMORY.md`, '- a\n');
    await sb.put(`${MEM}/rulegate-reviewer/MEMORY.md`, `${POINTER}\n- b\n- a\n`);
    await sb.put(`${MEM}/rulegate-reviewer/${KEPT_INDEX}`, '- a\n');
    const a = (await plan()).agents[0];
    expect(a?.files.map((f) => [f.rel, f.action])).toEqual([
      [KEPT_INDEX, 'same'],
      ['MEMORY.md', 'union'],
    ]);
    expect(a?.files.find((f) => f.action === 'union')?.added).toEqual([]);
  });

  it('warns when the merged index runs past the 200 lines Claude Code loads', async () => {
    const many = (p: string): string =>
      `${Array.from({ length: 120 }, (_, i) => `- [${p}${String(i)}](${p}.md)`).join('\n')}\n`;
    await sb.put(`${MEM}/agent-os-reviewer/MEMORY.md`, many('a'));
    await sb.put(`${MEM}/rulegate-reviewer/MEMORY.md`, many('b'));
    const out = describeMigration(await plan(), { dry: true }).join('\n');
    expect(out).toContain(
      'MEMORY.md will be 241 lines — Claude Code loads the first 200; trim it with /rulegate:memory',
    );
  });

  it('leaves a refused agent exactly as it was, and still moves the others', async () => {
    await sb.put(`${MEM}/agent-os-reviewer/patterns.md`, 'old\n');
    await sb.put(`${MEM}/rulegate-reviewer/patterns.md`, 'new\n');
    await sb.put('.claude/agent-memory-local/agent-os-builder/MEMORY.md', '- b\n');
    const r = await apply();
    expect(r.moved).toEqual(['.claude/agent-memory-local/agent-os-builder']);
    expect(text(`${MEM}/agent-os-reviewer/patterns.md`)).toBe('old\n');
    expect(text(`${MEM}/rulegate-reviewer/patterns.md`)).toBe('new\n');
    expect(text('.claude/agent-memory-local/rulegate-builder/MEMORY.md')).toBe('- b\n');
  });

  it('is a no-op the second time', async () => {
    await sb.put(`${MEM}/agent-os-reviewer/MEMORY.md`, '- x\n');
    await apply();
    const again = await apply();
    expect(again.plan.agents).toEqual([]);
    expect(describeMigration(again.plan, { dry: false })).toContain(
      '  nothing to migrate — no agent-os memory in this project',
    );
  });

  it('finishes a migration an earlier run left half-copied', async () => {
    // An interrupted run leaves verified copies at the target and the source whole; the
    // next run sees them as identical and carries on.
    await sb.put(`${MEM}/agent-os-reviewer/MEMORY.md`, '- [a](a.md)\n');
    await sb.put(`${MEM}/agent-os-reviewer/a.md`, 'a\n');
    await sb.put(`${MEM}/rulegate-reviewer/a.md`, 'a\n');
    const r = await apply();
    expect(r.failed).toEqual([]);
    expect(text(`${MEM}/rulegate-reviewer/MEMORY.md`)).toBe('- [a](a.md)\n');
    expect(existsSync(at(`${MEM}/agent-os-reviewer`))).toBe(false);
  });
});

describe('dist/migrate-memory.js', () => {
  const bin = fileURLToPath(new URL('../dist/migrate-memory.js', import.meta.url));
  const run = (args: string[]): { code: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, [bin, ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: sb.claudeDir, CLAUDE_CONFIG_DIR: sb.claudeDir },
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { code: err.status, out: err.stdout };
    }
  };

  it('previews with 0 and writes nothing, then applies with --apply', async () => {
    await sb.put(`${MEM}/agent-os-reviewer/MEMORY.md`, '- x\n');
    const preview = run(['--root', sb.root]);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain('preview — nothing written');
    expect(existsSync(at(`${MEM}/rulegate-reviewer`))).toBe(false);
    const applied = run(['--root', sb.root, '--apply']);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('verified; agent-os-reviewer removed');
    expect(text(`${MEM}/rulegate-reviewer/MEMORY.md`)).toBe('- x\n');
  });

  it('exits 1 when an agent is refused, and 2 on a usage error', async () => {
    await sb.put(`${MEM}/agent-os-reviewer/a.md`, 'old\n');
    await sb.put(`${MEM}/rulegate-reviewer/a.md`, 'new\n');
    expect(run(['--root', sb.root]).code).toBe(1);
    expect(run(['--root', sb.root, '--apply']).code).toBe(1);
    expect(text(`${MEM}/agent-os-reviewer/a.md`)).toBe('old\n');
    expect(run(['--bogus']).code).toBe(2);
    expect(run(['--root']).code).toBe(2);
    expect(run(['--root', '']).code).toBe(2);
    expect(run(['--root', at('missing')]).code).toBe(2);
  });
});
