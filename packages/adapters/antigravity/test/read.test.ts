import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  expectContentCovered,
  expectImportMatch,
  fixturesRoot,
  importContextFor,
  importFixture,
} from '@rulegate/adapter-kit/testing';
import { antigravity } from '../src/index.js';

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Read a throwaway repository holding these `.agents/rules/` files, as `init` would. */
async function readRules(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'rulegate-antigravity-read-'));
  scratch.push(dir);
  await mkdir(path.join(dir, '.agents/rules'), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(path.join(dir, '.agents/rules', name), contents, 'utf8');
  }
  return antigravity.read(importContextFor(path.relative(fixturesRoot, dir)));
}

describe('antigravity read()', () => {
  it('imports the fixture repo into the expected canonical rules', async () => {
    await expectImportMatch('antigravity', antigravity);
  });

  it('loses no user content', async () => {
    // The assertion that matters on a first run: `init` must not drop a line of
    // somebody's existing config on the way into .rulegate/.
    await expectContentCovered('antigravity', antigravity, [
      '.agents/rules/style.md',
      '.agents/rules/protos.md',
      '.agents/rules/migrations.md',
      '.agent/rules/legacy.md',
    ]);
  });

  it('warns about what it cannot carry over, rather than dropping it quietly', async () => {
    const result = await antigravity.read(importContextFor(importFixture('antigravity').input));
    const warnings = result.warnings ?? [];

    // `model_decision` has no canonical equivalent, and the rule is imported anyway.
    expect(warnings.some((w) => w.startsWith('.agents/rules/migrations.md:'))).toBe(true);
    // A nested file is inert in Antigravity; importing it would switch it on.
    expect(warnings.some((w) => w.startsWith('.agents/rules/nested/ignored.md:'))).toBe(true);
    expect(result.rules?.map((r) => r.source.file)).not.toContain(
      '.agents/rules/nested/ignored.md',
    );
  });

  it('leaves root AGENTS.md to the codex adapter', async () => {
    const result = await antigravity.read(importContextFor(importFixture('antigravity').input));
    expect(result.rules?.map((r) => r.source.file)).not.toContain('AGENTS.md');
  });

  it('skips a glob-triggered rule with no globs, rather than switching it on everywhere', async () => {
    const result = await readRules({ 'x.md': '---\ntrigger: glob\n---\n\nOnly for protos.\n' });
    expect(result.rules ?? []).toEqual([]);
    expect(result.warnings?.some((w) => w.startsWith('.agents/rules/x.md:'))).toBe(true);
    // It sits at a path `write()` renders, so the warning says `init` may replace it.
    expect(result.warnings?.find((w) => w.startsWith('.agents/rules/x.md:'))).toContain(
      'named `x`',
    );
  });

  it('warns when a bare `*` glob makes the frontmatter invalid YAML, rather than importing it silently', async () => {
    for (const block of ['globs: *.ts', 'glob: **/*.ts', 'globs: [*.ts]', 'globs:\n  - *.ts']) {
      const result = await readRules({ 'x.md': `---\ntrigger: glob\n${block}\n---\n\nTS only.\n` });
      expect(result.rules).toHaveLength(1);
      expect(
        result.warnings?.filter((w) => w.startsWith('.agents/rules/x.md:')),
        block,
      ).toEqual([expect.stringContaining('YAML indicator')]);
    }
    const quoted = await readRules({
      'x.md': '---\ntrigger: glob\nglobs: "*.ts, src/**/*.ts"\n---\n\nTS only.\n',
    });
    expect(quoted.warnings ?? []).toEqual([]);
  });

  it('imports an always_on rule with leftover globs unscoped, rather than narrowing it', async () => {
    const result = await readRules({
      'x.md': '---\ntrigger: always_on\nglobs: "*.ts"\n---\n\nApply everywhere.\n',
    });
    expect(result.rules?.map((r) => r.frontmatter.globs ?? [])).toEqual([[]]);
    expect(result.warnings?.some((w) => w.startsWith('.agents/rules/x.md:'))).toBe(true);
  });

  it('reads globs written as a YAML block list or flow list', async () => {
    const result = await readRules({
      'block.md': '---\ntrigger: glob\nglobs:\n  - "*.proto"\n  - \'**/*.pb.go\'\n---\n\nBlock.\n',
      'flow.md': '---\ntrigger: glob\nglobs: ["*.ts", "*.tsx"]\n---\n\nFlow.\n',
    });
    const globs = Object.fromEntries(
      (result.rules ?? []).map((r) => [r.source.file, r.frontmatter.globs]),
    );
    expect(globs).toEqual({
      '.agents/rules/block.md': ['*.proto', '**/*.pb.go'],
      '.agents/rules/flow.md': ['*.ts', '*.tsx'],
    });
  });
});
