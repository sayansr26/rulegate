import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMemory } from '../src/lib/memory.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  await sb.dispose();
});

describe('runMemory (T106)', () => {
  it('reports no memory on a fresh project', async () => {
    const text = (await runMemory({ root: sb.root, claudeDir: sb.claudeDir })).join('\n');
    expect(text).toContain('no agent memory yet');
    expect(text).toContain('HEALTH  no issues.');
  });

  it('finds unindexed and near-duplicate topic files', async () => {
    const dir = '.claude/agent-memory/rulegate-reviewer';
    await sb.put(`${dir}/MEMORY.md`, '- defect-patterns — x\n');
    await sb.put(`${dir}/defect-patterns.md`, 'a');
    await sb.put(`${dir}/defect_patterns.md`, 'b');
    const text = (await runMemory({ root: sb.root, claudeDir: sb.claudeDir })).join('\n');
    expect(text).toContain('"defect-patterns.md" and "defect_patterns.md" are the same subject');
  });

  it('marks a map stale when its entry changed after it was mapped', async () => {
    await sb.put('src/auth/login.ts', 'x');
    await sb.put(
      '.claude/agent-memory/rulegate-feature-cartographer/auth.md',
      '---\nmapped: 2026-01-01\nentry: src/auth/login.ts\n---\n',
    );
    await sb.put('.claude/agent-memory/rulegate-feature-cartographer/MEMORY.md', '- auth\n');
    sb.commit('2026-03-01');
    const text = (await runMemory({ root: sb.root, claudeDir: sb.claudeDir, stale: true })).join(
      '\n',
    );
    expect(text).toContain('STALE (mapped 2026-01-01, code changed 2026-03-01)');
  });

  it('counts the canonical rules as a store of their own', async () => {
    await sb.put('.rulegate/rules/a.md', '---\ndescription: a\n---\nx\n');
    expect((await runMemory({ root: sb.root, claudeDir: sb.claudeDir })).join('\n')).toContain(
      'canonical rules  .rulegate/rules/  — 1 file(s)',
    );
  });
});
