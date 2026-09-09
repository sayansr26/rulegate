import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findRepoRoot, STATE_PATH } from '@rulegate/core';
import { runSync } from '../src/commands/sync.js';
import { runCheck } from '../src/commands/check.js';
import { ExitCode } from '../src/ui/exit.js';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'rulegate-mono-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const write = async (rel: string, contents: string): Promise<void> => {
  const full = path.join(repo, rel);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, contents, 'utf8');
};

const read = (rel: string): Promise<string> => readFile(path.join(repo, rel), 'utf8');

const rule = (body: string, order = 10): string => `---\norder: ${String(order)}\n---\n\n${body}\n`;

/** Root plus two packages, one rules-only — T062's validation fixture. */
const buildMonorepo = async (): Promise<void> => {
  await mkdir(path.join(repo, '.git'), { recursive: true });
  await write('.rulegate/rulegate.yaml', 'schemaVersion: 1\ntools:\n  - claude-code\n  - cursor\n');
  await write('.rulegate/rules/10-style.md', rule('Root style: use tabs.'));
  await write(
    'packages/a/.rulegate/rulegate.yaml',
    'schemaVersion: 1\ntools:\n  - claude-code\n  - cursor\n',
  );
  await write('packages/a/.rulegate/rules/30-a.md', rule('Package a: server components.', 30));
  await write('packages/b/.rulegate/rules/40-b.md', rule('Package b: no default exports.', 40));
};

describe('rulegate on a monorepo (T062)', () => {
  beforeEach(buildMonorepo);

  it('syncs every level and then checks clean', async () => {
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);

    expect(await read('packages/a/CLAUDE.md')).toContain('Package a: server components.');
    expect(await read('packages/b/CLAUDE.md')).toContain('Package b: no default exports.');
  });

  it('records every level in one root state.json', async () => {
    await runSync({ cwd: repo, quiet: true });
    const state = JSON.parse(await read(STATE_PATH)) as { artifacts: { path: string }[] };
    const paths = state.artifacts.map((a) => a.path);

    // One record, not one per level. A per-level state would leave `packages/a`'s
    // artifacts unrecorded the moment its `.rulegate/` is deleted, which is Rulegate
    // forgetting it owns a file.
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('packages/a/CLAUDE.md');
    expect(paths).toContain('packages/b/CLAUDE.md');
    await expect(readFile(path.join(repo, 'packages/a/.rulegate/state.json'))).rejects.toThrow();
  });

  it('writes the same bytes whether it is run from the root or from a subpackage', async () => {
    await runSync({ cwd: repo, quiet: true });
    const fromRoot = await read('packages/a/CLAUDE.md');

    // What `findRepoRoot` walking to the outermost canonical root buys: standing in the
    // package resolves the same root, so the package still inherits the repository's
    // rules. Stopping at the nearer `.rulegate/` would render this file without them.
    const resolved = findRepoRoot(path.join(repo, 'packages/a'));
    expect(resolved).toBe(repo);

    await rm(path.join(repo, 'packages/a/CLAUDE.md'));
    expect(await runSync({ cwd: resolved, quiet: true })).toBe(ExitCode.Ok);
    expect(await read('packages/a/CLAUDE.md')).toBe(fromRoot);
  });

  it('is idempotent: a second sync writes nothing', async () => {
    await runSync({ cwd: repo, quiet: true });
    const before = await read('packages/a/CLAUDE.md');
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    expect(await read('packages/a/CLAUDE.md')).toBe(before);
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  it('removes a nested level artifact when that level stops producing it', async () => {
    await runSync({ cwd: repo, quiet: true });
    await rm(path.join(repo, 'packages/b'), { recursive: true });

    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    await expect(readFile(path.join(repo, 'packages/b/CLAUDE.md'))).rejects.toThrow();
    // The orphan is deletable only because one root state.json recorded it.
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  it('--no-recursive plans the root alone, and says so rather than hinting at sync', async () => {
    await runSync({ cwd: repo, quiet: true });

    // Exits 1 because state records nested artifacts this run did not plan. That is the
    // documented cost of the escape hatch, and the reason the tree is the default.
    expect(await runCheck({ cwd: repo, quiet: true, recursive: false })).toBe(ExitCode.Failure);
  });
});
