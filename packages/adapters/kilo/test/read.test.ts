import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
import { kilo } from '../src/index.js';

const imported = () => kilo.read(importContextFor(importFixture('kilo').input));

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A throwaway repository, read the way `init` reads one. */
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rulegate-kilo-read-'));
  scratch.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), contents, 'utf8');
  }
  return dir;
}
const readRepo = (dir: string) => kilo.read(importContextFor(path.relative(fixturesRoot, dir)));

describe('kilo read()', () => {
  it('imports the fixture repo into the expected canonical rules', async () => {
    await expectImportMatch('kilo', kilo);
  });

  it('loses no user content', async () => {
    await expectContentCovered('kilo', kilo, [
      '.kilocode/rules/001-10-style.md',
      '.kilocode/rules/logging.md',
      '.kilocoderules',
      '.kilocoderules-code',
      '.kilocode/rules-architect/design.md',
      '.kilo/rules/formatting.md',
    ]);
  });

  it('imports each file once, even when kilo.jsonc also lists a legacy one', async () => {
    const files = (await imported()).rules?.map((r) => r.source.file) ?? [];
    expect(files.filter((f) => f === '.kilocode/rules/logging.md')).toHaveLength(1);
  });

  it('imports mode-specific rules as ordinary rules, and says so', async () => {
    const result = await imported();
    const warnings = result.warnings ?? [];
    expect(warnings.some((w) => w.startsWith('.kilocoderules-code:'))).toBe(true);
    expect(warnings.some((w) => w.startsWith('.kilocode/rules-architect/design.md:'))).toBe(true);
    // Not one of Kilo's modes, so Kilo never loads it.
    expect(result.rules?.map((r) => r.source.file)).not.toContain(
      '.kilocode/rules-custom/ignored.md',
    );
  });

  it('skips remote and home-directory instructions and leaves AGENTS.md to codex', async () => {
    const result = await imported();
    const warnings = result.warnings ?? [];
    for (const entry of [
      'https://example.com/team-rules.md',
      '~/.config/kilo/personal.md',
      'AGENTS.md',
    ]) {
      expect(
        warnings.some((w) => w.includes(`\`${entry}\``)),
        entry,
      ).toBe(true);
    }
    expect(result.rules?.map((r) => r.source.file)).not.toContain('AGENTS.md');
  });

  it('says which imported files Kilo keeps loading beside their generated copy', async () => {
    const warnings = (await imported()).warnings ?? [];
    for (const file of [
      '.kilocode/rules/logging.md',
      '.kilocoderules',
      '.kilocoderules-code',
      '.kilocode/rules-architect/design.md',
      '.kilo/rules/formatting.md',
    ]) {
      expect(
        warnings.some((w) => w.startsWith(`${file}:`) && w.includes('twice')),
        file,
      ).toBe(true);
    }
    // An indexed name is an earlier render, which init takes over in place.
    expect(warnings.some((w) => w.startsWith('.kilocode/rules/001-10-style.md:'))).toBe(false);
  });

  it('skips an instructions entry naming a directory instead of aborting (EISDIR)', async () => {
    const dir = await repo({
      'kilo.jsonc': JSON.stringify({ instructions: ['docs', 'docs/a.md'] }),
      'docs/a.md': 'A rule.\n',
    });
    const result = await readRepo(dir);
    expect(result.rules?.map((r) => r.source.file)).toEqual(['docs/a.md']);
    expect(result.warnings?.some((w) => w.includes('`docs` was not imported'))).toBe(true);
  });

  it("never follows instructions into another adapter's artifacts, whatever the case", async () => {
    const dir = await repo({
      'kilo.jsonc': JSON.stringify({
        instructions: [
          '.cursor/rules/*.mdc',
          '.GitHub/copilot-instructions.md',
          '**/*.md',
          '.kilocode/rules-custom/*.md',
        ],
      }),
      '.cursor/rules/style.mdc':
        '---\ndescription: Style\nglobs: src/**/*.ts\nalwaysApply: false\n---\n\nUse tabs.\n',
      '.github/copilot-instructions.md': 'copilot\n',
      '.windsurf/rules/w.md': 'windsurf\n',
      '.kilocode/rules-custom/own.md': 'own\n',
    });
    const result = await readRepo(dir);
    // `**/*.md` reaches .windsurf/ and .github/ too; only this adapter's own file is imported.
    expect(result.rules?.map((r) => r.source.file)).toEqual(['.kilocode/rules-custom/own.md']);
    expect(result.rules?.some((r) => r.body.includes('alwaysApply'))).toBe(false);
    for (const entry of ['.cursor/rules/*.mdc', '.GitHub/copilot-instructions.md']) {
      expect(
        result.warnings?.some((w) => w.includes(`\`${entry}\` was not imported`)),
        entry,
      ).toBe(true);
    }
  });

  it("imports an OpenCode rule file only the Kilo config lists, but never OpenCode's config", async () => {
    const dir = await repo({
      'kilo.jsonc': JSON.stringify({
        instructions: ['.opencode/rules/review.md', '.opencode/opencode.json', '.claude/docs/a.md'],
      }),
      '.opencode/rules/review.md': 'Review carefully.\n',
      '.opencode/opencode.json': '{}\n',
      '.claude/docs/a.md': 'architecture\n',
    });
    const result = await readRepo(dir);
    expect(result.rules?.map((r) => r.source.file)).toEqual([
      '.opencode/rules/review.md',
      '.claude/docs/a.md',
    ]);
    expect(
      result.warnings?.some((w) =>
        w.includes('`.opencode/opencode.json` was not imported: it is a location the opencode'),
      ),
    ).toBe(true);
  });

  it("matches another owner's files regardless of letter case", async () => {
    const dir = await repo({
      'kilo.jsonc': JSON.stringify({ instructions: ['agents.md', '.Ruler/AGENTS.md'] }),
      'AGENTS.md': 'root\n',
      '.ruler/AGENTS.md': 'ruler\n',
    });
    const result = await readRepo(dir);
    expect(result.rules ?? []).toEqual([]);
    expect(result.warnings?.length).toBe(2);
  });

  it.skipIf(process.platform === 'win32')(
    'never follows a literal entry through a symlink out of the repository',
    async () => {
      const outside = await repo({ 'team.md': 'secret outside\n' });
      const dir = await repo({ 'kilo.jsonc': JSON.stringify({ instructions: ['docs/team.md'] }) });
      await mkdir(path.join(dir, 'docs'));
      await symlink(path.join(outside, 'team.md'), path.join(dir, 'docs/team.md'));

      const result = await readRepo(dir);
      expect(result.rules ?? []).toEqual([]);
      expect(result.warnings?.some((w) => w.includes('`docs/team.md` was not imported'))).toBe(
        true,
      );
    },
  );
});
