import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computePlan, NodeFileSystem, STATE_PATH } from '@rulegate/core';
import { ADAPTERS } from '../src/registry.js';
import { runSync } from '../src/commands/sync.js';
import { ExitCode } from '../src/ui/exit.js';

// OpenCode's `.opencode/opencode.json` carries no marker (its schema rejects unknown keys),
// so `state.json` is the only thing that says Rulegate owns it. This pins that a
// marker-less JSON config somebody else wrote is refused like any other unowned file,
// rather than adopted because nothing in it says it is theirs.

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const USER_CONFIG = `{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
  "permission": { "bash": "ask" }
}
`;

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'rulegate-opencode-'));
  await cp(path.join(fixtures, 'opencode/input'), repo, { recursive: true });
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('opencode config ownership', () => {
  it('refuses a .opencode/opencode.json it never wrote and leaves its bytes alone', async () => {
    await mkdir(path.join(repo, '.opencode'), { recursive: true });
    await writeFile(path.join(repo, '.opencode/opencode.json'), USER_CONFIG, 'utf8');

    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Failure);

    expect(await readFile(path.join(repo, '.opencode/opencode.json'), 'utf8')).toBe(USER_CONFIG);
    const state = JSON.parse(await readFile(path.join(repo, STATE_PATH), 'utf8')) as {
      artifacts: { path: string }[];
    };
    expect(state.artifacts.map((a) => a.path)).not.toContain('.opencode/opencode.json');
  });

  it('never plans the root opencode.json, which holds the user’s own settings', async () => {
    await writeFile(path.join(repo, 'opencode.json'), USER_CONFIG, 'utf8');
    const plan = await computePlan({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });
    const paths = plan.artifacts.filter((a) => a.adapter === 'opencode').map((a) => a.path);
    expect(paths).toContain('.opencode/opencode.json');
    expect(paths.every((p) => p.startsWith('.opencode/'))).toBe(true);

    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    expect(await readFile(path.join(repo, 'opencode.json'), 'utf8')).toBe(USER_CONFIG);
  });
});
