import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFileSystem, applyPlan, computePlan, verifyPlan } from '@rulegate/core';
import { ADAPTERS } from '../src/registry.js';

/**
 * T053's golden: commands synced through the **real** adapter registry — the folders, formats
 * and argument spellings each shipped adapter declares — compared byte for byte with a
 * hand-written `expected/`. See fixtures/commands-sync/README.md for why each file looks the
 * way it does.
 */
const fixture = fileURLToPath(new URL('../../../fixtures/commands-sync/', import.meta.url));
const COMMAND_DIRS = [
  '.claude/commands/',
  '.gemini/commands/',
  '.github/prompts/',
  '.kilo/commands/',
  '.opencode/commands/',
  '.roo/commands/',
  '.windsurf/workflows/',
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

describe('commands through the shipped adapters (T053)', () => {
  it('renders the golden byte for byte, names what it could not carry, and checks clean', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'rulegate-commands-golden-'));
    scratch.push(repo);
    await cp(path.join(fixture, 'input'), repo, { recursive: true });
    const fs = new NodeFileSystem(repo);

    const plan = await computePlan({ repoRoot: repo, fs, adapters: ADAPTERS });
    expect(plan.errors).toEqual([]);
    await applyPlan(plan, fs);

    const expected = path.join(fixture, 'expected');
    const want = await filesUnder(expected);
    const got = (await filesUnder(repo)).filter((f) => COMMAND_DIRS.some((d) => f.startsWith(d)));
    expect(got).toEqual(want);
    for (const file of want) {
      expect(await readFile(path.join(repo, file), 'utf8'), file).toBe(
        await readFile(path.join(expected, file), 'utf8'),
      );
    }

    expect(
      plan.warnings
        .filter((w) => w.code.startsWith('W_COMMAND'))
        .map((w) => `${w.code} ${w.message}`),
    ).toEqual([
      'W_COMMAND_ARGUMENTS `review` uses $ARGUMENTS, which kilo has no syntax for, so kilo does not get it',
      'W_COMMAND_ARGUMENTS `review` uses $ARGUMENTS, which roo-code has no syntax for, so roo-code does not get it',
      'W_COMMAND_ARGUMENTS `review` uses $ARGUMENTS, which windsurf has no syntax for, so windsurf does not get it',
      'W_COMMAND_FIELD_DROPPED `mode` in `changelog` was left out for claude-code, copilot, gemini, kilo, opencode, windsurf, which do not read it',
      'W_COMMAND_FIELD_DROPPED `argument-hint` in `review` was left out for gemini, opencode, which do not read it',
      'W_COMMAND_FIELD_DROPPED `model` in `review` was left out for gemini, which does not read it',
    ]);

    // Each copy is owned by the tool that reads it.
    const owners = new Map(plan.state.artifacts.map((a) => [a.path, a.adapter]));
    expect(owners.get('.gemini/commands/review.toml')).toBe('gemini');
    expect(owners.get('.github/prompts/review.prompt.md')).toBe('copilot');

    expect((await verifyPlan(plan, fs)).clean).toBe(true);
  });
});
