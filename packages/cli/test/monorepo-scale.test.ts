import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computePlan, NodeFileSystem } from '@rulegate/core';
import type { ReadOnlyFileSystem } from '@rulegate/core';
import { ADAPTERS } from '../src/registry.js';
import { runCheck } from '../src/commands/check.js';
import { runSync } from '../src/commands/sync.js';
import { ExitCode } from '../src/ui/exit.js';

const PACKAGES = 50;

const rule = (body: string, order = 10): string => `---\norder: ${String(order)}\n---\n\n${body}\n`;

const MANIFEST = 'schemaVersion: 1\ntools:\n  - claude-code\n  - cursor\n';

/** The 50-package tree, as a flat list of files both filesystems can be built from. */
function files(packages: number = PACKAGES): [string, string][] {
  const out: [string, string][] = [
    ['.rulegate/rulegate.yaml', MANIFEST],
    ['.rulegate/rules/10-style.md', rule('Root style: use tabs.')],
  ];
  for (let i = 0; i < packages; i++) {
    const pkg = `packages/p${String(i).padStart(2, '0')}`;
    out.push([`${pkg}/.rulegate/rulegate.yaml`, MANIFEST]);
    out.push([`${pkg}/.rulegate/rules/30-local.md`, rule(`Package ${String(i)} rule.`, 30)]);
  }
  return out;
}

describe(`rulegate on a ${String(PACKAGES)}-package monorepo (T062, NFR6)`, () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'rulegate-scale-'));
    await mkdir(path.join(repo, '.git'), { recursive: true });
    for (const [rel, contents] of files()) {
      const full = path.join(repo, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, contents, 'utf8');
    }
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('plans every level', async () => {
    const plan = await computePlan({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });

    expect(plan.levels).toHaveLength(PACKAGES + 1);
    expect(plan.errors).toEqual([]);
    // Two artifacts per level: CLAUDE.md and one .cursor rule file.
    expect(plan.artifacts.length).toBeGreaterThanOrEqual(PACKAGES * 2);
  });

  it('checks a synced tree in under 2 seconds', async () => {
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);

    const started = performance.now();
    const code = await runCheck({ cwd: repo, quiet: true });
    const elapsed = performance.now() - started;

    expect(code).toBe(ExitCode.Ok);
    expect(elapsed).toBeLessThan(2000);
  });

  /**
   * The budget assertion above is wall-clock and therefore only as trustworthy as the
   * machine running it — a loaded CI box can fail it without a regression, and a fast one
   * can pass it *with* one. This is the half that cannot be flaky.
   *
   * It counts **directory visits**, which is the quantity that actually went wrong: every
   * level's `parse` issues a scoped glob, and a `glob` that walks the whole repository
   * regardless of the pattern turns one traversal per level into one traversal of
   * everything per level. That is quadratic, and at fifty packages it still passed the
   * stopwatch (1331ms of a 2000ms budget) while being hopeless at two hundred. A count
   * has no such blind spot: doubling the packages must not roughly quadruple the work.
   */
  it('visits directories a number of times that grows linearly with the levels', async () => {
    const visitsFor = async (packages: number): Promise<number> => {
      const tree = await mkdtemp(path.join(tmpdir(), 'rulegate-visits-'));
      try {
        for (const [rel, contents] of files(packages)) {
          const full = path.join(tree, rel);
          await mkdir(path.dirname(full), { recursive: true });
          await writeFile(full, contents, 'utf8');
        }

        let visits = 0;
        const fs = new NodeFileSystem(tree);
        const counting = new Proxy(fs, {
          get(target, prop, receiver) {
            const value: unknown = Reflect.get(target, prop, receiver);
            if (prop !== 'listDir' || typeof value !== 'function') return value;
            return async (dir: string) => {
              visits++;
              return await (value as (d: string) => Promise<unknown>).call(target, dir);
            };
          },
        }) as ReadOnlyFileSystem;

        await computePlan({ repoRoot: tree, fs: counting, adapters: ADAPTERS });
        return visits;
      } finally {
        await rm(tree, { recursive: true, force: true });
      }
    };

    const small = await visitsFor(PACKAGES / 2);
    const large = await visitsFor(PACKAGES);

    // Linear is 2x. Quadratic is 4x. The threshold sits between them, well clear of both,
    // so ordinary constant-factor changes do not make this flaky.
    expect(large).toBeLessThan(small * 2.5);
  });
});
