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
import { opencode } from '../src/index.js';

const imported = () => opencode.read(importContextFor(importFixture('opencode').input));

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** A throwaway repository, read the way `init` reads one. */
async function repo(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rulegate-opencode-read-'));
  scratch.push(dir);
  for (const [rel, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), contents, 'utf8');
  }
  return dir;
}
const readRepo = (dir: string) => opencode.read(importContextFor(path.relative(fixturesRoot, dir)));

describe('opencode read()', () => {
  it('imports the fixture repo into the expected canonical rules', async () => {
    await expectImportMatch('opencode', opencode);
  });

  it('loses no user content', async () => {
    await expectContentCovered('opencode', opencode, [
      'docs/guidelines.md',
      'docs/rules/errors.md',
      'docs/rules/naming.md',
      '.opencode/rules/10-review.md',
    ]);
  });

  it("never follows instructions into another importer's source tree", async () => {
    // `.agent-os/` and `.ruler/` are packages/interop's; importing them here as well hands
    // init the same rules twice under two provenances.
    const files = (await imported()).rules?.map((r) => r.source.file) ?? [];
    expect(files.filter((f) => f.startsWith('.agent-os/') || f.startsWith('.ruler/'))).toEqual([]);
    expect(files).not.toContain('AGENTS.md');
  });

  it('skips remote, home-directory, absolute and escaping entries, each with a warning', async () => {
    const warnings = (await imported()).warnings ?? [];
    for (const entry of [
      'https://raw.githubusercontent.com/example/shared-rules/main/style.md',
      '~/.config/opencode/personal.md',
      '/etc/opencode/team.md',
      '../outside.md',
      'AGENTS.md',
      '.agent-os/AGENTS.md',
      '.ruler/AGENTS.md',
    ]) {
      expect(
        warnings.some((w) => w.includes(`\`${entry}\``)),
        entry,
      ).toBe(true);
    }
  });

  it('lists each file once, in the order the configs name it', async () => {
    const files = (await imported()).rules?.map((r) => r.source.file);
    expect(files).toEqual([
      'docs/guidelines.md',
      'docs/rules/errors.md',
      'docs/rules/naming.md',
      '.opencode/rules/10-review.md',
    ]);
  });

  it('warns about settings in .opencode/opencode.json that init would stop applying', async () => {
    const dir = await repo({
      '.opencode/opencode.json': JSON.stringify({
        $schema: 'https://opencode.ai/config.json',
        model: 'x',
        permission: { bash: 'ask' },
        mcp: {},
        instructions: [],
      }),
    });
    const warnings = (await readRepo(dir)).warnings ?? [];
    expect(warnings.some((w) => w.includes('(mcp, model, permission)'))).toBe(true);

    // The fixture's copy holds only what Rulegate writes, so it has nothing to lose.
    expect(((await imported()).warnings ?? []).some((w) => w.includes('setting(s)'))).toBe(false);
  });

  it('says which imported files stay loaded beside their generated copy', async () => {
    const warnings = (await imported()).warnings ?? [];
    for (const file of ['docs/guidelines.md', 'docs/rules/errors.md', 'docs/rules/naming.md']) {
      expect(
        warnings.some((w) => w.startsWith(`${file}: opencode.jsonc lists it`)),
        file,
      ).toBe(true);
    }
    // Listed only by the config Rulegate takes over, and already at the rendered path.
    expect(warnings.some((w) => w.startsWith('.opencode/rules/10-review.md:'))).toBe(false);
  });

  it('skips an entry naming a directory instead of aborting the import (EISDIR)', async () => {
    const dir = await repo({
      'opencode.json': JSON.stringify({ instructions: ['docs', 'docs/a.md'] }),
      'docs/a.md': 'A rule.\n',
    });
    const result = await readRepo(dir);
    expect(result.rules?.map((r) => r.source.file)).toEqual(['docs/a.md']);
    expect(result.warnings?.some((w) => w.includes('`docs` was not imported'))).toBe(true);
  });

  it("never follows instructions into another adapter's artifacts, whatever the case", async () => {
    const dir = await repo({
      'opencode.json': JSON.stringify({
        instructions: [
          '.cursor/rules/*.mdc',
          '.GitHub/copilot-instructions.md',
          '**/*.md',
          '.opencode/rules/*.md',
        ],
      }),
      '.cursor/rules/style.mdc':
        '---\ndescription: Style\nglobs: src/**/*.ts\nalwaysApply: false\n---\n\nUse tabs.\n',
      '.github/copilot-instructions.md': 'copilot\n',
      '.windsurf/rules/w.md': 'windsurf\n',
      '.opencode/rules/own.md': 'own\n',
    });
    const result = await readRepo(dir);
    // `**/*.md` reaches .windsurf/ and .github/ too; only this adapter's own file is imported.
    expect(result.rules?.map((r) => r.source.file)).toEqual(['.opencode/rules/own.md']);
    expect(result.rules?.some((r) => r.body.includes('alwaysApply'))).toBe(false);
    for (const entry of ['.cursor/rules/*.mdc', '.GitHub/copilot-instructions.md']) {
      expect(
        result.warnings?.some((w) => w.includes(`\`${entry}\` was not imported`)),
        entry,
      ).toBe(true);
    }
  });

  it("imports a file under another tool's directory that its adapter never imports", async () => {
    const dir = await repo({
      'opencode.json': JSON.stringify({
        instructions: ['.claude/docs/architecture.md', '.cursor/notes.md', '.claude/rules/x.md'],
      }),
      '.claude/docs/architecture.md': 'architecture\n',
      '.cursor/notes.md': 'notes\n',
      '.claude/rules/x.md': 'claude rule\n',
    });
    const result = await readRepo(dir);
    // claude-code imports only `.claude/rules/**`, cursor only `.cursor/rules/**/*.mdc`: the
    // first two would otherwise be in no canonical source, with a warning saying otherwise.
    expect(result.rules?.map((r) => r.source.file)).toEqual([
      '.claude/docs/architecture.md',
      '.cursor/notes.md',
    ]);
    expect(result.warnings).toEqual([
      expect.stringContaining('`.claude/rules/x.md` was not imported'),
      expect.stringContaining('.claude/docs/architecture.md: opencode.json lists it'),
      expect.stringContaining('.cursor/notes.md: opencode.json lists it'),
    ]);
  });

  it('warns about an unlisted file where the render goes, which init would replace', async () => {
    const dir = await repo({
      'opencode.json': JSON.stringify({ instructions: ['docs/style.md'] }),
      'docs/style.md': 'Use tabs.\n',
      '.opencode/rules/style.md': '# My draft\n',
    });
    const result = await readRepo(dir);
    expect(result.rules?.map((r) => r.source.file)).toEqual(['docs/style.md']);
    const warning = result.warnings?.find((w) => w.startsWith('.opencode/rules/style.md:'));
    expect(warning).toContain('not imported');
    expect(warning).toContain('`init --yes` replaces it');
  });

  it("matches another owner's files regardless of letter case", async () => {
    const dir = await repo({
      'opencode.json': JSON.stringify({
        instructions: ['agents.md', 'Claude.MD', '.Rulegate/rules/x.md', 'docs/ok.md'],
      }),
      'AGENTS.md': 'root\n',
      'CLAUDE.md': 'claude\n',
      '.rulegate/rules/x.md': 'canonical\n',
      'docs/ok.md': 'ok\n',
    });
    const result = await readRepo(dir);
    expect(result.rules?.map((r) => r.source.file)).toEqual(['docs/ok.md']);
    for (const entry of ['agents.md', 'Claude.MD', '.Rulegate/rules/x.md']) {
      expect(
        result.warnings?.some((w) => w.includes(`\`${entry}\``)),
        entry,
      ).toBe(true);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'never follows a literal entry through a symlink out of the repository',
    async () => {
      const outside = await repo({ 'team.md': 'secret outside\n' });
      const dir = await repo({
        'opencode.json': JSON.stringify({ instructions: ['docs/team.md'] }),
      });
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
