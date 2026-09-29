import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/io/memory.js';
import { NodeFileSystem } from '../src/io/node.js';
import { parse } from '../src/parse/index.js';
import { parseSkills } from '../src/parse/skills.js';
import { serializeSkill } from '../src/model/serialize.js';
import { ALL_TOOLS } from '../src/model/selector.js';

/**
 * T051: canonical skills (RFC-0001 §12) round-trip without loss.
 *
 * The three fixtures are the shapes a skill arrives in — a Claude Code skill with
 * Claude-only frontmatter, a plain Agent Skills skill, and a Codex skill carrying its
 * `agents/openai.yaml` sidecar — each with a PNG and a CRLF script, which are the two
 * assets any text path in Rulegate would corrupt.
 */

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const CASES = [
  { fixture: 'skills-roundtrip-claude', id: 'release-notes' },
  { fixture: 'skills-roundtrip-agents', id: 'pdf-forms' },
  { fixture: 'skills-roundtrip-codex', id: 'db-migrate' },
] as const;

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function filesUnder(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await filesUnder(dir, child)));
    else out.push(child);
  }
  return out.sort();
}

describe('canonical skills round-trip (T051)', () => {
  it.each(CASES)('$fixture: every file comes back byte-identical', async ({ fixture, id }) => {
    const root = path.join(fixtures, fixture, 'input');
    const parsed = await parseSkills(new NodeFileSystem(root), '');
    expect(parsed.errors).toEqual([]);
    expect(parsed.skills.map((s) => s.id)).toEqual([id]);

    const skill = parsed.skills[0]!;
    const serialized = serializeSkill(skill);
    const dir = `.rulegate/skills/${id}`;
    const onDisk = (await filesUnder(path.join(root, dir))).map((f) => `${dir}/${f}`);
    expect([...serialized.keys()].sort()).toEqual(onDisk);

    for (const [file, contents] of serialized) {
      const disk = await readFile(path.join(root, file));
      const bytes = typeof contents === 'string' ? Buffer.from(contents, 'utf8') : contents;
      expect(Buffer.from(bytes).equals(disk), file).toBe(true);
    }
  });

  it.each(CASES)(
    '$fixture: the serialized skill parses back to the same model',
    async ({ fixture }) => {
      const root = path.join(fixtures, fixture, 'input');
      const [skill] = (await parseSkills(new NodeFileSystem(root), '')).skills;
      const copy = await mkdtemp(path.join(tmpdir(), 'rulegate-skill-'));
      scratch.push(copy);
      for (const [file, contents] of serializeSkill(skill!)) {
        await mkdir(path.dirname(path.join(copy, file)), { recursive: true });
        await writeFile(path.join(copy, file), contents);
      }
      const again = await parseSkills(new NodeFileSystem(copy), '');
      expect(again.errors).toEqual([]);
      expect(again.skills).toEqual([skill]);
    },
  );

  it('keeps asset bytes raw: a PNG signature and CRLF line endings survive', async () => {
    const root = path.join(fixtures, 'skills-roundtrip-claude', 'input');
    const [skill] = (await parseSkills(new NodeFileSystem(root), '')).skills;
    const png = skill!.assets.find((a) => a.path === 'assets/logo.png')!;
    expect([...png.bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const ps1 = skill!.assets.find((a) => a.path === 'scripts/collect.ps1')!;
    expect(Buffer.from(ps1.bytes).toString('utf8')).toContain('\r\n');
    expect(skill!.assets.map((a) => a.path)).toEqual([
      'assets/logo.png',
      'scripts/collect.ps1',
      'templates/notes.md',
    ]);
  });

  it('reads `tools` in all three forms and keeps every key in authored order', async () => {
    const read = async (fixture: string) =>
      (await parseSkills(new NodeFileSystem(path.join(fixtures, fixture, 'input')), '')).skills[0]!;
    const claude = await read('skills-roundtrip-claude');
    expect(claude.tools).toEqual({ kind: 'include', tools: ['claude-code'] });
    expect(claude.frontmatter.map(([k]) => k)).toEqual([
      'name',
      'description',
      'when_to_use',
      'disable-model-invocation',
      'allowed-tools',
      'paths',
      'tools',
    ]);
    expect((await read('skills-roundtrip-agents')).tools).toEqual(ALL_TOOLS);
    expect((await read('skills-roundtrip-codex')).tools).toEqual({
      kind: 'exclude',
      tools: ['cursor'],
    });
  });

  it('is part of parse(), beside the rules', async () => {
    const root = path.join(fixtures, 'skills-roundtrip-codex', 'input');
    const result = await parse({ fs: new NodeFileSystem(root) });
    expect(result.errors).toEqual([]);
    expect(result.canonical.skills.map((s) => s.id)).toEqual(['db-migrate']);
    expect(result.sourceFiles).toContain('.rulegate/skills/db-migrate/assets/schema.png');
  });
});

describe('invalid skills are refused, never guessed (T051)', () => {
  const skill = (fm: string, body = 'Do the thing.\n') => `---\n${fm}\n---\n\n${body}`;
  const errorsFor = async (files: Record<string, string>) => {
    const fs = new MemoryFileSystem(Object.entries(files));
    const { errors, skills } = await parseSkills(fs, '');
    return { messages: errors.map((e) => `${e.code} ${e.message}`), skills };
  };

  it('requires `name` to equal the directory name', async () => {
    const { messages, skills } = await errorsFor({
      '.rulegate/skills/deploy/SKILL.md': skill('name: ship\ndescription: Deploy.'),
    });
    expect(skills).toEqual([]);
    expect(messages.join('\n')).toMatch(
      /E_SKILL_INVALID `name` is `ship` but the directory is `deploy`/,
    );
  });

  it.each([['Deploy'], ['-deploy'], ['de--ploy'], ['a'.repeat(65)]])(
    'refuses the directory name %s',
    async (id) => {
      const { messages } = await errorsFor({
        [`.rulegate/skills/${id}/SKILL.md`]: skill(`name: ${id}\ndescription: Deploy.`),
      });
      expect(messages.join('\n')).toMatch(/not a valid Agent Skills name/);
    },
  );

  it('requires SKILL.md, and refuses nested skill trees', async () => {
    const missing = await errorsFor({ '.rulegate/skills/deploy/notes.md': 'x\n' });
    expect(missing.messages.join('\n')).toMatch(/has no SKILL\.md/);
    const nested = await errorsFor({
      '.rulegate/skills/team/deploy/SKILL.md': skill('name: deploy\ndescription: Deploy.'),
    });
    expect(nested.messages.join('\n')).toMatch(/skills cannot be nested/);
  });

  it('refuses a file loose in skills/', async () => {
    const { messages } = await errorsFor({ '.rulegate/skills/deploy.md': 'x\n' });
    expect(messages.join('\n')).toMatch(/is not a skill/);
  });

  it('enforces the Agent Skills field rules', async () => {
    const cases: [string, RegExp][] = [
      ['name: x', /`description` is required/],
      [`name: x\ndescription: ${'d'.repeat(1025)}`, /the limit is 1024/],
      ['name: x\ndescription: D.\ncompatibility: ""', /`compatibility` must be 1-500/],
      [
        'name: x\ndescription: D.\nmetadata:\n  version: 1.0',
        /`metadata.version` must be a string/,
      ],
      ['name: x\ndescription: D.\nmetadata: [a]', /`metadata` must be a mapping/],
      ['name: x\ndescription: D.\nallowed-tools:\n  Read: true', /`allowed-tools` must be/],
      [
        'name: x\ndescription: D.\ntools: { cursor: true }',
        /`tools` mapping must have an `exclude` key/,
      ],
    ];
    for (const [fm, pattern] of cases) {
      const { messages, skills } = await errorsFor({ '.rulegate/skills/x/SKILL.md': skill(fm) });
      expect(skills, fm).toEqual([]);
      expect(messages.join('\n'), fm).toMatch(pattern);
    }
  });

  it('refuses a SKILL.md without frontmatter', async () => {
    const { messages } = await errorsFor({ '.rulegate/skills/x/SKILL.md': '# Just a body\n' });
    expect(messages.join('\n')).toMatch(/has no frontmatter/);
  });

  it('accepts allowed-tools as a list, as Claude Code does', async () => {
    const { messages, skills } = await errorsFor({
      '.rulegate/skills/x/SKILL.md': skill(
        'name: x\ndescription: D.\nallowed-tools:\n  - Read\n  - Grep',
      ),
    });
    expect(messages).toEqual([]);
    expect(skills[0]!.frontmatter).toContainEqual(['allowed-tools', ['Read', 'Grep']]);
  });

  it('is not read in bare AGENTS.md mode', async () => {
    const fs = new MemoryFileSystem([
      ['AGENTS.md', '# Rules\n'],
      ['.rulegate/skills/x/SKILL.md', skill('name: x\ndescription: D.')],
    ]);
    // `.rulegate/skills/` alone is not a `.rulegate/` with rules or a manifest, so the
    // repository is still in bare mode and skills have nowhere to render from.
    const result = await parse({ fs });
    expect(result.mode).toBe('bare-agents-md');
    expect(result.canonical.skills).toEqual([]);
  });
});

describe('symlinks inside a skill (T051)', () => {
  it('are refused rather than followed or copied', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'rulegate-skill-link-'));
    scratch.push(repo);
    const dir = path.join(repo, '.rulegate/skills/x');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: x\ndescription: D.\n---\n\nBody.\n');
    await writeFile(path.join(repo, 'outside.txt'), 'secret\n');
    try {
      await symlink(path.join(repo, 'outside.txt'), path.join(dir, 'leak.txt'));
    } catch (e) {
      if (process.env['RULEGATE_REQUIRE_SYMLINKS'] === '1') throw e;
      return; // Windows without developer mode cannot create one; see symlinks.test.ts.
    }
    const { errors, skills } = await parseSkills(new NodeFileSystem(repo), '');
    expect(skills).toEqual([]);
    expect(errors.map((e) => e.message).join('\n')).toMatch(/may not contain a symlink/);
  });
});
