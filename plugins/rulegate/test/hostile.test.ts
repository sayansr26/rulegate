import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAudit } from '../src/lib/audit.js';
import { planMemoryMigration } from '../src/lib/migrate.js';
import { planTaskRule } from '../src/lib/settings.js';
import { setupState } from '../src/lib/state.js';
import { applyMemoryMigration } from '../src/migrate/memory.js';
import { sandbox, type Sandbox } from './helpers.js';

/**
 * A repository controls every path these scripts read, and T107/T108's hooks run the same
 * libraries automatically. Each case here hung a script before the T106 audit's fixes; a
 * regression shows up as a Vitest timeout.
 */
let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  await sb.dispose();
});

const audit = (): Promise<string[]> =>
  runAudit({ root: sb.root, claudeDir: sb.claudeDir, today: '2026-09-26' });

describe('hostile repositories (T106 audit)', () => {
  it('does not follow symlink loops when sizing a store', async () => {
    await sb.put('memory-bank/note.md', 'x');
    for (const n of ['a', 'b', 'c']) await symlink('.', path.join(sb.root, 'memory-bank', n));
    expect((await audit()).join('\n')).toContain('FOUND memory-bank/');
  });

  it('does not follow symlink loops when counting source files', async () => {
    await sb.put('src/a.ts', '');
    for (let i = 0; i < 10; i++) await symlink('.', path.join(sb.root, `loop${String(i)}`));
    expect((await audit()).join('\n')).toMatch(/source files +1 /);
  });

  it.skipIf(process.platform === 'win32')(
    'never reads a device behind a symlinked CLAUDE.md',
    async () => {
      await symlink('/dev/zero', path.join(sb.root, 'CLAUDE.md'));
      expect(
        (await setupState(sb.root, sb.claudeDir)).items.find((i) => i.key === 'claude-md')?.ok,
      ).toBe(false);
      await audit();
    },
  );

  it('still follows a symlink to a regular file — CLAUDE.md -> AGENTS.md is a real setup', async () => {
    await sb.put('AGENTS.md', '# Agents\n\nUse TaskCreate.\n');
    await symlink('AGENTS.md', path.join(sb.root, 'CLAUDE.md'));
    expect(planTaskRule('project', sb.root, sb.claudeDir).status).toBe('present');
  });

  it('plans the task rule into a CLAUDE.md of padding in linear time', async () => {
    await sb.put('CLAUDE.md', `${' '.repeat(300_000)}x`);
    expect(planTaskRule('project', sb.root, sb.claudeDir).status).toBe('add');
  });
});

describe('dist/settings.js exit codes', () => {
  const bin = fileURLToPath(new URL('../dist/settings.js', import.meta.url));
  const run = (args: string[]): number => {
    try {
      execFileSync(process.execPath, [bin, ...args], {
        stdio: 'ignore',
        // HOME too: an --apply that ignored CLAUDE_CONFIG_DIR must still land in the sandbox.
        env: { ...process.env, HOME: sb.claudeDir, CLAUDE_CONFIG_DIR: sb.claudeDir },
      });
      return 0;
    } catch (e) {
      return (e as { status: number }).status;
    }
  };

  it('previews and applies with 0, and treats an unknown flag or a missing value as usage (2)', () => {
    expect(run(['--root', sb.root, '--scope', 'project'])).toBe(0);
    expect(run(['--root', sb.root, '--apply'])).toBe(0);
    expect(run(['--bogus'])).toBe(2);
    expect(run(['--scope'])).toBe(2);
    expect(run(['--scope', 'everywhere'])).toBe(2);
  });

  it('exits 1 when --apply refuses, and writes nothing through a planted symlink', async () => {
    await sb.putHome('target.json', '{}\n');
    await sb.put('.claude/.keep', '');
    await symlink(
      path.join(sb.claudeDir, 'target.json'),
      path.join(sb.root, '.claude/settings.json'),
    );
    expect(run(['--root', sb.root, '--scope', 'project', '--apply'])).toBe(1);
    expect(readFileSync(path.join(sb.claudeDir, 'target.json'), 'utf8')).toBe('{}\n');
  });
});

describe('the memory migrator against a hostile repository (T114)', () => {
  const MEM = '.claude/agent-memory';
  const plan = () => planMemoryMigration(sb.root, sb.claudeDir);

  it('does not follow a symlink loop inside a memory directory', async () => {
    await sb.put(`${MEM}/agent-os-reviewer/MEMORY.md`, '- x\n');
    for (const n of ['a', 'b', 'c'])
      await symlink('.', path.join(sb.root, MEM, 'agent-os-reviewer', n));
    const r = await applyMemoryMigration(sb.root, sb.claudeDir);
    expect(r.plan.agents[0]).toMatchObject({ kind: 'refused', reason: 'a is a symlink' });
    expect(readFileSync(path.join(sb.root, MEM, 'agent-os-reviewer/MEMORY.md'), 'utf8')).toBe(
      '- x\n',
    );
  });

  it('never copies a memory file that links outside the repository', async () => {
    await sb.putHome('secret.md', 'SECRET');
    await sb.put(`${MEM}/agent-os-reviewer/MEMORY.md`, '');
    await symlink(
      path.join(sb.claudeDir, 'secret.md'),
      path.join(sb.root, MEM, 'agent-os-reviewer/leak.md'),
    );
    await applyMemoryMigration(sb.root, sb.claudeDir);
    expect(existsSync(path.join(sb.root, MEM, 'rulegate-reviewer'))).toBe(false);
  });

  it('refuses a memory directory that is itself a symlink', async () => {
    await sb.putHome('elsewhere/MEMORY.md', '- x\n');
    await sb.put(`${MEM}/.keep`, '');
    await symlink(
      path.join(sb.claudeDir, 'elsewhere'),
      path.join(sb.root, MEM, 'agent-os-reviewer'),
    );
    expect((await plan()).agents[0]).toMatchObject({
      kind: 'refused',
      reason: '.claude/agent-memory/agent-os-reviewer is a symlink',
    });
  });

  it('refuses a name that is not a plain agent name', async () => {
    await sb.put(`${MEM}/agent-os-../MEMORY.md`, '');
    expect((await plan()).agents[0]).toMatchObject({
      from: 'agent-os-..',
      kind: 'refused',
      reason: 'not a plain agent name',
    });
  });

  it('refuses a symlinked agent-memory base, which would move the files somewhere else', async () => {
    await sb.putHome('mem/agent-os-reviewer/MEMORY.md', '- x\n');
    await sb.put('.claude/.keep', '');
    await symlink(path.join(sb.claudeDir, 'mem'), path.join(sb.root, MEM));
    const r = await applyMemoryMigration(sb.root, sb.claudeDir);
    expect(r.moved).toEqual([]);
    expect(r.plan.agents[0]?.reason).toBe('.claude/agent-memory is a symlink');
    expect(existsSync(path.join(sb.claudeDir, 'mem/agent-os-reviewer/MEMORY.md'))).toBe(true);
  });
});
