import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runGit } from '../src/git/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('runGit (T104)', () => {
  it('runs an allowlisted read in a git working tree', async () => {
    // The positive control: every refusal below would pass against a runGit that
    // returned undefined unconditionally.
    const top = await runGit(['rev-parse', '--show-toplevel'], repoRoot);
    expect(top?.trim()).toBe(path.resolve(repoRoot));
  });

  it('refuses a subcommand outside the four', async () => {
    expect(await runGit(['fetch'], repoRoot)).toBeUndefined();
    expect(await runGit(['--version'], repoRoot)).toBeUndefined();
  });

  it('refuses an option that writes a file, and writes nothing', async () => {
    // `log --output=<path>` is a read-only subcommand writing anywhere on disk — the
    // reason an allowlisted subcommand is not enough.
    const dir = await mkdtemp(path.join(tmpdir(), 'rulegate-rungit-'));
    try {
      const out = path.join(dir, 'leak.txt');
      expect(await runGit(['log', `--output=${out}`, '--max-count=1'], repoRoot)).toBeUndefined();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses the options that run textconv or fetch blobs', async () => {
    for (const opt of ['-p', '--patch', '--stat', '--ext-diff', '--textconv']) {
      expect(await runGit(['log', opt, '--max-count=1'], repoRoot), opt).toBeUndefined();
    }
  });

  it('takes anything after -- as a path, where git cannot read it as an option', async () => {
    const out = await runGit(['ls-files', '-z', '--', '--output=x'], repoRoot);
    expect(out).toBe('');
  });

  it('resolves undefined outside a git working tree instead of throwing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'rulegate-rungit-'));
    try {
      expect(await runGit(['rev-parse', '--show-toplevel'], dir)).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
