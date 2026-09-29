import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFileSystem } from '../src/io/node.js';
import { parseSkills } from '../src/parse/skills.js';
import { planSkills } from '../src/render/skills.js';
import { ADAPTER_API_VERSION, NOT_DETECTED, type Adapter } from '../src/adapter/adapter.js';
import type { Skill } from '../src/model/skill.js';

/**
 * T052: which directories a skill is rendered into, what its copy there says, and what the
 * user is told about loads that cannot be avoided. The readers below mirror the directories
 * and extensions the real tools document (RFC-0001 §12.5); the adapters' own data is
 * covered by their golden fixtures.
 */

const SOURCE = { url: 'https://example.test', title: 't', retrieved: '2026-09-29' };
function reader(name: string, dirs: string[], extensions: string[] = []): Adapter {
  return {
    name,
    apiVersion: ADAPTER_API_VERSION,
    detect: () => Promise.resolve(NOT_DETECTED),
    read: () => Promise.resolve({}),
    write: () => Promise.resolve([]),
    docs: {
      toolName: name,
      homepage: SOURCE.url,
      verifiedAgainst: { version: 'test', date: '2026-09-29' },
      files: [],
      skills: { dirs, extensions, source: SOURCE },
    },
  };
}
const CLAUDE = reader(
  'claude-code',
  ['.claude/skills'],
  ['when_to_use', 'disable-model-invocation', 'paths'],
);
const CODEX = reader('codex', ['.agents/skills']);
const CURSOR = reader(
  'cursor',
  ['.agents/skills', '.cursor/skills', '.claude/skills'],
  ['paths', 'disable-model-invocation', 'icon', 'color'],
);
const COPILOT = reader('copilot', ['.github/skills', '.claude/skills', '.agents/skills']);

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
async function skillFrom(fixture: string): Promise<Skill> {
  const parsed = await parseSkills(new NodeFileSystem(path.join(fixtures, fixture, 'input')), '');
  return parsed.skills[0]!;
}
const withTools = (skill: Skill, tools: Skill['tools']): Skill => ({ ...skill, tools });
const dirsOf = (plan: ReturnType<typeof planSkills>): string[] =>
  [...new Set(plan.artifacts.map((a) => a.path.split('/').slice(0, 2).join('/')))].sort();
const messages = (plan: ReturnType<typeof planSkills>): string[] =>
  plan.warnings.map((w) => `${w.code} ${w.message}`);

describe('skill placement (T052)', () => {
  it('gives tools that share a directory one copy between them', async () => {
    const skill = withTools(await skillFrom('skills-roundtrip-agents'), { kind: 'all' });
    const plan = planSkills([skill], [CODEX, CURSOR], true);
    expect(dirsOf(plan)).toEqual(['.agents/skills']);
    // The first reader in codepoint order owns it, whichever tool the skill came from.
    expect(new Set(plan.artifacts.map((a) => a.adapter))).toEqual(new Set(['codex']));
    expect(plan.warnings).toEqual([]);
  });

  it('adds a directory only for a tool the shared one does not reach', async () => {
    const skill = withTools(await skillFrom('skills-roundtrip-agents'), { kind: 'all' });
    const plan = planSkills([skill], [CLAUDE, CODEX], true);
    expect(dirsOf(plan)).toEqual(['.agents/skills', '.claude/skills']);
    expect(plan.warnings).toEqual([]);
  });

  it('says so when a tool reads two of the chosen directories', async () => {
    const skill = withTools(await skillFrom('skills-roundtrip-agents'), { kind: 'all' });
    const plan = planSkills([skill], [CLAUDE, CODEX, COPILOT], true);
    expect(dirsOf(plan)).toEqual(['.agents/skills', '.claude/skills']);
    expect(messages(plan)).toEqual([
      'W_SKILL_LOAD copilot reads .agents/skills and .claude/skills, so it loads `pdf-forms` twice',
    ]);
  });

  it('says so when `tools:` leaves out a tool that still reads the directory', async () => {
    const skill = await skillFrom('skills-roundtrip-claude'); // tools: [claude-code]
    const plan = planSkills([skill], [CLAUDE, CURSOR], true);
    expect(dirsOf(plan)).toEqual(['.claude/skills']);
    expect(messages(plan)).toEqual([
      'W_SKILL_LOAD `release-notes` leave cursor out with `tools:`, but cursor also reads .claude/skills, where another tool gets them',
    ]);
  });

  it('renders nothing for a skill no enabled tool selects, and nothing without skill readers', async () => {
    const skill = await skillFrom('skills-roundtrip-claude'); // tools: [claude-code]
    expect(planSkills([skill], [CODEX], true).artifacts).toEqual([]);
    expect(planSkills([skill], [], true).artifacts).toEqual([]);
  });

  it('is independent of adapter order', async () => {
    const skill = withTools(await skillFrom('skills-roundtrip-agents'), { kind: 'all' });
    const a = planSkills([skill], [CLAUDE, CODEX, COPILOT, CURSOR], true);
    const b = planSkills([skill], [CURSOR, COPILOT, CODEX, CLAUDE], true);
    expect(b).toEqual(a);
  });
});

describe("a skill's generated copy (T052)", () => {
  it('drops `tools`, keeps the Agent Skills fields, and adds the marker after the frontmatter', async () => {
    const skill = await skillFrom('skills-roundtrip-claude');
    const plan = planSkills([skill], [CLAUDE], true);
    const md = plan.artifacts.find((a) => a.path === '.claude/skills/release-notes/SKILL.md')!;
    expect(md.contents).not.toMatch(/^tools:/m);
    expect(md.contents).toMatch(/^name: release-notes$/m);
    expect(md.contents).toMatch(/^when_to_use: /m);
    expect(md.contents).toMatch(
      /^---\n[\s\S]*\n---\n<!-- generated by rulegate; edit \.rulegate\/ instead -->\n\n# Release notes/,
    );
  });

  it('passes an extension only where a reader understands it, and names what it dropped', async () => {
    const skill = withTools(await skillFrom('skills-roundtrip-claude'), { kind: 'all' });
    const plan = planSkills([skill], [CODEX], true);
    const md = plan.artifacts.find((a) => a.path.endsWith('SKILL.md'))!;
    expect(md.contents).not.toMatch(/^(when_to_use|disable-model-invocation|paths):/m);
    expect(md.contents).toMatch(/^allowed-tools: /m);
    expect(messages(plan)).toEqual([
      'W_SKILL_FIELD_DROPPED `disable-model-invocation` in `release-notes` was left out of .agents/skills/: no tool that reads it understands the key',
      'W_SKILL_FIELD_DROPPED `paths` in `release-notes` was left out of .agents/skills/: no tool that reads it understands the key',
      'W_SKILL_FIELD_DROPPED `when_to_use` in `release-notes` was left out of .agents/skills/: no tool that reads it understands the key',
    ]);
    // With Cursor also reading `.agents/skills/`, the keys Cursor understands come back.
    const both = planSkills([skill], [CODEX, CURSOR], true);
    const shared = both.artifacts.find((a) => a.path.endsWith('SKILL.md'))!;
    expect(shared.contents).toMatch(/^paths:/m);
    expect(shared.contents).toMatch(/^disable-model-invocation: true$/m);
    expect(shared.contents).not.toMatch(/^when_to_use:/m);
  });

  it('carries every asset as its bytes, owned like the SKILL.md beside it', async () => {
    const skill = await skillFrom('skills-roundtrip-claude');
    const plan = planSkills([skill], [CLAUDE], false);
    const png = plan.artifacts.find((a) => a.path.endsWith('assets/logo.png'))!;
    expect(png.bytes).toEqual(skill.assets.find((a) => a.path === 'assets/logo.png')!.bytes);
    expect(png.contents).toBe('');
    expect(new Set(plan.artifacts.map((a) => a.adapter))).toEqual(new Set(['claude-code']));
    expect(plan.artifacts.map((a) => a.path)).toEqual([
      '.claude/skills/release-notes/SKILL.md',
      '.claude/skills/release-notes/assets/logo.png',
      '.claude/skills/release-notes/scripts/collect.ps1',
      '.claude/skills/release-notes/templates/notes.md',
    ]);
  });
});

describe('skills through computePlan, sync and check (T052)', () => {
  const scratch: string[] = [];
  afterEach(async () => {
    await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('syncs a skill with a PNG and a CRLF script byte for byte, then checks clean', async () => {
    const { cp } = await import('node:fs/promises');
    const { computePlan } = await import('../src/pipeline/plan.js');
    const { applyPlan } = await import('../src/pipeline/apply.js');
    const { verifyPlan } = await import('../src/pipeline/verify.js');
    const repo = await mkdtemp(path.join(tmpdir(), 'rulegate-skills-sync-'));
    scratch.push(repo);
    await cp(path.join(fixtures, 'skills-roundtrip-claude', 'input'), repo, { recursive: true });
    const fs = new NodeFileSystem(repo);

    const plan = await computePlan({ repoRoot: repo, fs, adapters: [CLAUDE, CODEX, CURSOR] });
    expect(plan.errors).toEqual([]);
    await applyPlan(plan, fs);

    const src = path.join(repo, '.rulegate/skills/release-notes');
    const out = path.join(repo, '.claude/skills/release-notes');
    for (const f of ['assets/logo.png', 'scripts/collect.ps1', 'templates/notes.md']) {
      expect((await readFile(path.join(out, f))).equals(await readFile(path.join(src, f))), f).toBe(
        true,
      );
    }
    expect((await verifyPlan(plan, fs)).clean).toBe(true);
  });
});

describe('a shared directory changing owner (T052)', () => {
  it('stays clean, deletes nothing and needs no --force when one of its readers is disabled', async () => {
    const { MemoryFileSystem } = await import('../src/io/memory.js');
    const { computePlan } = await import('../src/pipeline/plan.js');
    const { applyPlan } = await import('../src/pipeline/apply.js');
    const { verifyPlan } = await import('../src/pipeline/verify.js');
    const manifest = (tools: string[]) =>
      `schemaVersion: 1\ntools:\n${tools.map((t) => `  - ${t}\n`).join('')}`;
    const fs = new MemoryFileSystem([
      ['.rulegate/rulegate.yaml', manifest(['codex', 'cursor'])],
      [
        '.rulegate/skills/deploy/SKILL.md',
        '---\nname: deploy\ndescription: Deploy.\n---\n\nShip it.\n',
      ],
    ]);
    const adapters = [CLAUDE, CODEX, CURSOR];
    const first = await computePlan({ repoRoot: '/repo', fs, adapters });
    expect(first.errors).toEqual([]);
    await applyPlan(first, fs);
    const owner = (plan: typeof first) =>
      plan.state.artifacts.find((a) => a.path === '.agents/skills/deploy/SKILL.md')?.adapter;
    expect(owner(first)).toBe('codex');

    await fs.writeFile('.rulegate/rulegate.yaml', manifest(['cursor']));
    const second = await computePlan({ repoRoot: '/repo', fs, adapters });
    expect(second.errors).toEqual([]);
    expect(owner(second)).toBe('cursor');
    const verify = await verifyPlan(second, fs);
    expect(verify.entries.filter((e) => e.status !== 'clean')).toEqual([]);
    const applied = await applyPlan(second, fs);
    expect(applied.deleted).toEqual([]);
    expect(await fs.tryReadFile('.agents/skills/deploy/SKILL.md')).not.toBeNull();
  });
});

describe('skills in a nested .rulegate/ (T052)', () => {
  it('are not rendered, and say so', async () => {
    const { MemoryFileSystem } = await import('../src/io/memory.js');
    const { computePlan } = await import('../src/pipeline/plan.js');
    const skillMd = '---\nname: deploy\ndescription: Deploy.\n---\n\nShip it.\n';
    const fs = new MemoryFileSystem([
      ['.rulegate/rulegate.yaml', 'schemaVersion: 1\ntools:\n  - claude-code\n'],
      ['packages/api/.rulegate/rulegate.yaml', 'schemaVersion: 1\ntools:\n  - claude-code\n'],
      ['packages/api/.rulegate/skills/deploy/SKILL.md', skillMd],
    ]);
    const plan = await computePlan({ repoRoot: '/repo', fs, adapters: [CLAUDE] });
    expect(plan.artifacts.filter((a) => a.kind === 'skill')).toEqual([]);
    expect(plan.warnings.map((w) => `${w.code} ${w.message}`)).toContain(
      'W_SKILL_NESTED skills in packages/api/.rulegate/skills/ are not rendered yet: `deploy`',
    );
  });
});
