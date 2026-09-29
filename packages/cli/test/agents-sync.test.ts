import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFileSystem, applyPlan, computePlan, verifyPlan } from '@rulegate/core';
import { ADAPTERS } from '../src/registry.js';

/**
 * T054's golden: agents synced through the **real** adapter registry — the folders, formats and
 * keys each shipped adapter declares — compared byte for byte with a hand-written `expected/`.
 * See fixtures/agents-sync/README.md for why each file looks the way it does.
 */
const fixture = fileURLToPath(new URL('../../../fixtures/agents-sync/', import.meta.url));
const AGENT_DIRS = [
  '.agents/agents/',
  '.claude/agents/',
  '.codex/agents/',
  '.cursor/agents/',
  '.gemini/agents/',
  '.github/agents/',
  '.kilo/agents/',
  '.opencode/agents/',
];

async function filesUnder(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await filesUnder(dir, child)));
    else out.push(child);
  }
  return out.sort();
}

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('agents through the shipped adapters (T054)', () => {
  it('renders the golden byte for byte, never widens a restriction, and checks clean', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'rulegate-agents-golden-'));
    scratch.push(repo);
    await cp(path.join(fixture, 'input'), repo, { recursive: true });
    const fs = new NodeFileSystem(repo);

    const plan = await computePlan({ repoRoot: repo, fs, adapters: ADAPTERS });
    expect(plan.errors).toEqual([]);
    await applyPlan(plan, fs);

    const expected = path.join(fixture, 'expected');
    const want = await filesUnder(expected);
    const got = (await filesUnder(repo)).filter((f) => AGENT_DIRS.some((d) => f.startsWith(d)));
    expect(got).toEqual(want);
    for (const file of want) {
      expect(await readFile(path.join(repo, file), 'utf8'), file).toBe(
        await readFile(path.join(expected, file), 'utf8'),
      );
    }

    expect(
      plan.warnings
        .filter((w) => w.code.startsWith('W_AGENT'))
        .map((w) => `${w.code} ${w.message}`),
    ).toEqual([
      'W_AGENT_RESTRICTED `reviewer` restricts its tools, which codex cannot be told, so codex does not get it',
      'W_AGENT_RESTRICTED `reviewer` restricts its tools, which cursor cannot be told, so cursor does not get it',
      'W_AGENT_RESTRICTED `reviewer` restricts its tools, which gemini cannot be told, so gemini does not get it',
      'W_AGENT_RESTRICTED `reviewer` restricts its tools, which opencode cannot be told, so opencode does not get it',
      'W_AGENT_LOAD cursor reads .claude/agents, where `reviewer` loads without the tool restriction cursor cannot read',
      'W_AGENT_FIELD_DROPPED `temperature` in `planner` was left out of .claude/agents/: no tool that reads it understands the key',
      'W_AGENT_FIELD_DROPPED `color` in `planner` was left out of .codex/agents/: no tool that reads it understands the key',
      'W_AGENT_FIELD_DROPPED `temperature` in `planner` was left out of .codex/agents/: no tool that reads it understands the key',
      'W_AGENT_FIELD_DROPPED `color` in `planner` was left out of .gemini/agents/: no tool that reads it understands the key',
    ]);

    // The shared folder has one owner: its first reader in codepoint order.
    const owners = new Map(plan.state.artifacts.map((a) => [a.path, a.adapter]));
    expect(owners.get('.claude/agents/planner.md')).toBe('claude-code');
    expect(owners.get('.codex/agents/planner.toml')).toBe('codex');

    expect((await verifyPlan(plan, fs)).clean).toBe(true);
  });
});
