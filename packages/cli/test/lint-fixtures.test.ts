import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createReadOnlyFileSystem, runLint } from '@rulegate/core';
import { ADAPTERS } from '../src/registry.js';
import type { LintFinding } from '@rulegate/core';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

/**
 * Fixture trees that are *supposed* to be wrong.
 *
 * `malformed/` exists to make the parser fail, so linting it asserts nothing about
 * false positives. Everything else is a repository someone could really have.
 */
const DELIBERATELY_BROKEN = new Set(['malformed']);

async function inputRoots(): Promise<string[]> {
  const out: string[] = [];
  for (const name of (await readdir(fixtures)).sort()) {
    if (DELIBERATELY_BROKEN.has(name)) continue;
    const dir = path.join(fixtures, name);
    if (!(await stat(dir)).isDirectory()) continue;
    // `input/` is the repository as an adopter would have it; `expected/` is what
    // Rulegate generates into it. Both are linted: a rule that fires on generated
    // output is a rule that fires on every synced repository in the world.
    for (const sub of ['input', 'expected']) {
      const candidate = path.join(dir, sub);
      try {
        if ((await stat(candidate)).isDirectory()) out.push(candidate);
      } catch {
        // Detect and import fixtures use other layouts; they are covered by the
        // whole-tree pass below.
      }
    }
  }
  return out;
}

const describeFindings = (findings: readonly LintFinding[]): string =>
  findings.map((f) => `${f.rule} ${f.paths.join(',')} — ${f.message}`).join('\n');

describe('T064 — zero false positives on repositories that are fine', () => {
  it('finds fixture roots to lint at all', async () => {
    // The control that makes every assertion below mean something. A glob that matched
    // nothing would give a suite of vacuously passing cases, which is the exact shape
    // of inert guard this project has now shipped twenty-seven times.
    const roots = await inputRoots();
    expect(roots.length).toBeGreaterThan(10);
  });

  it('reports nothing on any golden fixture tree', async () => {
    const offenders: string[] = [];
    for (const root of await inputRoots()) {
      const report = await runLint({
        repoRoot: root,
        fs: createReadOnlyFileSystem(root),
        adapters: ADAPTERS,
      });
      // `errors` is not asserted: a fixture with no `.rulegate/` is not adopted, which
      // is an ordinary state and not a lint finding.
      if (report.findings.length > 0) {
        offenders.push(`${path.relative(fixtures, root)}:\n${describeFindings(report.findings)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('still reports on a tree that genuinely has a problem', async () => {
    // The positive control for the sweep above. Without it, a `runLint` that returned an
    // empty report unconditionally — or a rule set that never fired — would pass the
    // whole file. `doctor/adopted` enables several tools that additively read
    // `AGENTS.md`, which is `conflicting-rules`' true positive.
    const root = path.join(fixtures, 'doctor/adopted');
    const report = await runLint({
      repoRoot: root,
      fs: createReadOnlyFileSystem(root),
      adapters: ADAPTERS,
    });
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.every((f) => f.severity === 'warn')).toBe(true);
  });
});
