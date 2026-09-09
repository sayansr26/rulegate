import { describe, expect, it } from 'vitest';
import { computePlan, MemoryFileSystem } from '@rulegate/core';
import { ADAPTERS } from '../src/registry.js';

/**
 * In `packages/cli/` for the reason `nesting-targets.test.ts` gives: `computePlan` takes
 * its adapter roster as a parameter, so the only place the **real** roster exists is
 * here. A monorepo planned against invented adapters would prove nothing about which
 * tools actually receive a nested level's rules.
 */

const rule = (body: string, order = 10): string => `---\norder: ${String(order)}\n---\n\n${body}\n`;

const manifest = (...tools: readonly string[]): string =>
  `schemaVersion: 1\ntools:\n${tools.map((t) => `  - ${t}\n`).join('')}`;

const plan = async (fs: MemoryFileSystem, recursive?: boolean) =>
  computePlan({
    repoRoot: '/repo',
    fs,
    adapters: ADAPTERS,
    ...(recursive === undefined ? {} : { recursive }),
  });

const paths = (p: Awaited<ReturnType<typeof plan>>): readonly string[] =>
  p.artifacts.map((a) => a.path);

/**
 * Root plus two packages, one of them rules-only, exactly the shape T061 resolved and
 * T062 has to emit for.
 */
const monorepo = (): MemoryFileSystem =>
  new MemoryFileSystem([
    ['.rulegate/rulegate.yaml', manifest('claude-code', 'cursor', 'aider')],
    ['.rulegate/rules/10-style.md', rule('Root style: use tabs.')],

    ['packages/a/.rulegate/rulegate.yaml', manifest('claude-code', 'cursor', 'aider')],
    ['packages/a/.rulegate/rules/30-a.md', rule('Package a: prefer server components.', 30)],

    ['packages/b/.rulegate/rules/40-b.md', rule('Package b: no default exports.', 40)],
  ]);

describe('computePlan across nested levels (T062)', () => {
  it('writes a nested level to a prefixed path, and the root to an unprefixed one', async () => {
    const result = await plan(monorepo());

    expect(paths(result)).toContain('CLAUDE.md');
    expect(paths(result)).toContain('packages/a/CLAUDE.md');
    expect(paths(result)).toContain('packages/b/CLAUDE.md');
  });

  it('gives a nested level its ancestors rules as well as its own', async () => {
    const result = await plan(monorepo());
    const nested = result.artifacts.find((a) => a.path === 'packages/a/CLAUDE.md');

    // Inheritance, not replacement: every target tool walks up and collects, so a package
    // declaring one rule still gets the repository's conventions (RFC-0001 §4.3).
    expect(nested?.contents).toContain('Root style: use tabs.');
    expect(nested?.contents).toContain('Package a: prefer server components.');
  });

  it('skips a tool that declares no nested artifact, and reports it', async () => {
    const result = await plan(monorepo());

    // Aider's CONVENTIONS.md has no nested mechanism at all. Folding package-scoped rules
    // into the root copy would apply them repository-wide, which is worse than not
    // applying them — so the level is skipped there and said out loud.
    expect(paths(result)).toContain('CONVENTIONS.md');
    expect(paths(result)).not.toContain('packages/a/CONVENTIONS.md');

    const a = result.levels.find((l) => l.dir === 'packages/a');
    expect(a?.skippedTools).toContain('aider');
    expect(result.levels.find((l) => l.dir === '')?.skippedTools).toEqual([]);
  });

  it('records one state entry per artifact, across every level', async () => {
    const result = await plan(monorepo());

    // One root state.json spanning the tree. Per-level state would mean deleting
    // packages/a/.rulegate/ leaves its artifacts with no record — Rulegate forgetting it
    // owns a file, which is the one thing state.json exists to prevent.
    expect(result.state.artifacts.map((a) => a.path)).toEqual(paths(result));
    expect(result.state.artifacts.some((a) => a.path.startsWith('packages/b/'))).toBe(true);
  });

  it('plans the root alone under recursive: false', async () => {
    const result = await plan(monorepo(), false);

    expect(paths(result).every((p) => !p.startsWith('packages/'))).toBe(true);
    expect(result.levels).toHaveLength(1);
    expect(result.levels[0]?.dir).toBe('');
  });

  it('is a single level, with no nested discovery, in an ordinary repository', async () => {
    const fs = new MemoryFileSystem([
      ['.rulegate/rulegate.yaml', manifest('claude-code')],
      ['.rulegate/rules/10-style.md', rule('Use tabs.')],
    ]);

    const result = await plan(fs);
    expect(result.levels).toHaveLength(1);
    expect(result.levels[0]?.dir).toBe('');
    expect(paths(result)).toEqual(['CLAUDE.md']);
  });

  it('renders the same bytes with and without recursion when there is one level', async () => {
    const one = (): MemoryFileSystem =>
      new MemoryFileSystem([
        ['.rulegate/rulegate.yaml', manifest('claude-code', 'cursor')],
        ['.rulegate/rules/10-style.md', rule('Use tabs.')],
      ]);

    // The regression guard for every repository that is not a monorepo: nesting must be
    // invisible to it, byte for byte.
    const withDiscovery = await plan(one());
    const withoutDiscovery = await plan(one(), false);
    expect(withDiscovery.artifacts).toEqual(withoutDiscovery.artifacts);
  });

  it('warns when a nested override reaches a tool that merges instead of overriding', async () => {
    const fs = new MemoryFileSystem([
      ['.rulegate/rulegate.yaml', manifest('gemini', 'claude-code')],
      ['.rulegate/rules/10-style.md', rule('Root style: use tabs.')],
      ['packages/a/.rulegate/rulegate.yaml', manifest('gemini', 'claude-code')],
      ['packages/a/.rulegate/rules/10-style.md', rule('Package a style: use spaces.')],
    ]);

    const result = await plan(fs);
    const warning = result.warnings.find((w) => w.code === 'W_NESTED_MERGE_CONFLICT');

    // Gemini is `all-merged`: it loads the root file *and* the nested one, so the package
    // gets both texts rather than an override, and no byte comparison can see it.
    expect(warning?.message).toContain('packages/a');
    expect(warning?.message).toContain('10-style');
    expect(warning?.message).toContain('gemini');

    // Claude Code is `nearest-wins`, so the same override is an override there and silent.
    expect(result.warnings.filter((w) => w.message.includes('claude-code'))).toEqual([]);

    // Warned, still emitted: refusing would leave the package with no rules at all.
    expect(result.artifacts.map((a) => a.path)).toContain('packages/a/GEMINI.md');
    expect(result.errors).toEqual([]);
  });

  it('does not fail a repository whose rules live only in its packages', async () => {
    const fs = new MemoryFileSystem([
      ['packages/a/.rulegate/rulegate.yaml', manifest('claude-code')],
      ['packages/a/.rulegate/rules/10-style.md', rule('Use tabs.')],
    ]);

    const result = await plan(fs);

    // The root is still a level — it is every other level's ancestor — but having no
    // canonical source of its own is not `E_NO_CANONICAL_SOURCE` when a package has one:
    // that code means a repository nobody can render, and this one renders.
    expect(result.errors).toEqual([]);
    expect(paths(result)).toEqual(['packages/a/CLAUDE.md']);
  });

  it('does not treat an ignored subtree as a level', async () => {
    const fs = new MemoryFileSystem([
      [
        '.rulegate/rulegate.yaml',
        `${manifest('claude-code')}\noptions:\n  ignore:\n    - fixtures/**\n`,
      ],
      ['.rulegate/rules/10-style.md', rule('Root style: use tabs.')],

      // A repository whose test data *is* canonical sources. Rulegate's own is one, and
      // one of its fixtures is deliberately malformed — discovery treating these as
      // levels meant `sync` generating artifacts into its own fixtures and `check`
      // exiting 1 on a broken one, on this repository, the first time it was run.
      ['fixtures/aider/input/.rulegate/rulegate.yaml', manifest('aider')],
      ['fixtures/aider/input/.rulegate/rules/10-style.md', rule('Fixture rule.')],
    ]);

    const result = await plan(fs);

    expect(result.levels.map((l) => l.dir)).toEqual(['']);
    expect(paths(result).some((p) => p.startsWith('fixtures/'))).toBe(false);
  });

  it('still reports a repository with no canonical source anywhere', async () => {
    const result = await plan(new MemoryFileSystem([['README.md', '# hi\n']]));
    expect(result.errors.map((e) => e.code)).toContain('E_NO_CANONICAL_SOURCE');
  });
});
