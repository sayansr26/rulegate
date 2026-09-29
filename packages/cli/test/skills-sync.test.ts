import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFileSystem, applyPlan, computePlan, verifyPlan } from '@rulegate/core';
import { ADAPTERS } from '../src/registry.js';

/**
 * T052's golden: a skill synced through the **real** adapter registry — the directories and
 * keys each shipped adapter declares — compared byte for byte with a hand-written `expected/`.
 * See fixtures/skills-sync/README.md for why each file looks the way it does.
 */
const fixture = fileURLToPath(new URL('../../../fixtures/skills-sync/', import.meta.url));

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

describe('skills through the shipped adapters (T052)', () => {
  it('renders the golden byte for byte, reports the double loads, and checks clean', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'rulegate-skills-golden-'));
    scratch.push(repo);
    await cp(path.join(fixture, 'input'), repo, { recursive: true });
    const fs = new NodeFileSystem(repo);

    const plan = await computePlan({ repoRoot: repo, fs, adapters: ADAPTERS });
    expect(plan.errors).toEqual([]);
    await applyPlan(plan, fs);

    const expected = path.join(fixture, 'expected');
    const want = await filesUnder(expected);
    const skillFiles = (await filesUnder(repo)).filter(
      (f) => f.startsWith('.claude/skills/') || f.startsWith('.agents/skills/'),
    );
    expect(skillFiles).toEqual(want);
    for (const file of want) {
      const same = (await readFile(path.join(repo, file))).equals(
        await readFile(path.join(expected, file)),
      );
      expect(same, file).toBe(true);
    }

    const skillWarnings = plan.warnings
      .filter((w) => w.code.startsWith('W_SKILL'))
      .map((w) => `${w.code} ${w.message}`);
    expect(skillWarnings).toEqual([
      'W_SKILL_LOAD copilot reads .agents/skills and .claude/skills, so it loads `release-notes` twice',
      'W_SKILL_LOAD cursor reads .agents/skills and .claude/skills, so it loads `release-notes` twice',
      'W_SKILL_FIELD_DROPPED `when_to_use` in `release-notes` was left out of .agents/skills/: no tool that reads it understands the key',
    ]);

    // The shared directory has one owner in state.json: its first reader in codepoint order.
    const owners = new Map(plan.state.artifacts.map((a) => [a.path, a.adapter]));
    expect(owners.get('.agents/skills/release-notes/SKILL.md')).toBe('codex');
    expect(owners.get('.claude/skills/release-notes/SKILL.md')).toBe('claude-code');

    expect((await verifyPlan(plan, fs)).clean).toBe(true);
  });
});
