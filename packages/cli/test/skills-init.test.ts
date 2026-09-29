import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFileSystem, computeInitPlan } from '@rulegate/core';
import { INTEROP } from '@rulegate/interop';
import { runInit } from '../src/commands/init.js';
import { runCheck } from '../src/commands/check.js';
import { ExitCode } from '../src/ui/exit.js';
import { ADAPTERS } from '../src/registry.js';

/**
 * T052: `init` imports the skills a repository's tools already have (RFC-0001 §12.4), and
 * the first `check` after `init --yes` is clean — including for a PNG, which only survives if
 * every step from import to render carries bytes.
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x0d, 0x0a]);
const skillMd = (name: string, description = 'Ship a release. Use when asked to deploy.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nRun the release script.\n`;

let repo: string;
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function put(rel: string, contents: string | Buffer): Promise<void> {
  await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
  await writeFile(path.join(repo, rel), contents);
}
async function freshRepo(): Promise<void> {
  repo = await mkdtemp(path.join(tmpdir(), 'rulegate-skills-init-'));
  scratch.push(repo);
  // Claude Code and Codex, detected from their instruction files.
  await put('CLAUDE.md', '# Project\n\nUse small modules.\n');
  await put('AGENTS.md', '# Project\n\nUse small modules.\n');
}
const plan = () =>
  computeInitPlan({
    repoRoot: repo,
    fs: new NodeFileSystem(repo),
    adapters: ADAPTERS,
    interop: INTEROP,
  });
const init = () => runInit({ cwd: repo, yes: true, quiet: true, plugin: false });
const messages = (p: Awaited<ReturnType<typeof plan>>) =>
  [...p.warnings, ...p.errors].map((w) => `${w.code} ${w.message}`);

describe('init imports skills (T052)', () => {
  it("collapses one skill found in two tools' directories, keeps the PNG, and checks clean", async () => {
    await freshRepo();
    for (const dir of ['.claude/skills', '.agents/skills']) {
      await put(`${dir}/deploy/SKILL.md`, skillMd('deploy'));
      await put(`${dir}/deploy/assets/flow.png`, PNG);
    }
    const p = await plan();
    expect(p.errors).toEqual([]);
    expect(p.canonical.skills.map((s) => s.id)).toEqual(['deploy']);
    // Both tools were already reading it, which is every tool with skills here: no `tools:`.
    expect(p.canonical.skills[0]!.tools).toEqual({ kind: 'all' });
    expect(messages(p).filter((m) => m.includes('W_SKILL'))).toEqual([]);

    expect(await init()).toBe(ExitCode.Ok);
    const canonical = path.join(repo, '.rulegate/skills/deploy');
    expect(await readFile(path.join(canonical, 'SKILL.md'), 'utf8')).toBe(skillMd('deploy'));
    expect((await readFile(path.join(canonical, 'assets/flow.png'))).equals(PNG)).toBe(true);
    expect(
      (await readFile(path.join(repo, '.claude/skills/deploy/assets/flow.png'))).equals(PNG),
    ).toBe(true);
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  it('scopes a skill to the tools that were reading its directory', async () => {
    await freshRepo();
    await put('.claude/skills/review/SKILL.md', skillMd('review', 'Review a pull request.'));
    const p = await plan();
    expect(p.canonical.skills[0]!.tools).toEqual({ kind: 'include', tools: ['claude-code'] });
    expect(await init()).toBe(ExitCode.Ok);
    expect(await readFile(path.join(repo, '.rulegate/skills/review/SKILL.md'), 'utf8')).toMatch(
      /^tools:\n {2}- claude-code$/m,
    );
    // Codex does not read `.claude/skills/`, so nothing new appears in `.agents/skills/`.
    await expect(readdir(path.join(repo, '.agents/skills'))).rejects.toThrow();
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  it('imports one of two differing copies, and names the other', async () => {
    await freshRepo();
    await put('.claude/skills/deploy/SKILL.md', skillMd('deploy', 'Deploy with Claude.'));
    await put('.agents/skills/deploy/SKILL.md', skillMd('deploy', 'Deploy with Codex.'));
    const p = await plan();
    expect(p.canonical.skills[0]!.description).toBe('Deploy with Codex.');
    expect(messages(p)).toContain(
      'W_SKILL_IMPORT .claude/skills/deploy/ differs from .agents/skills/deploy/: imported the copy in .agents/skills/ and left this one where it is',
    );
  });

  it('does not import an invalid skill, and says why', async () => {
    await freshRepo();
    await put('.claude/skills/broken/SKILL.md', '---\nname: broken\n---\n\nNo description.\n');
    const p = await plan();
    expect(p.canonical.skills).toEqual([]);
    expect(messages(p)).toContain(
      'W_SKILL_IMPORT .claude/skills/broken/ was not imported: `description` is required',
    );
  });

  it('refuses rather than overwrite a hand-written .rulegate/skills/ with no manifest', async () => {
    await freshRepo();
    await put('.claude/skills/deploy/SKILL.md', skillMd('deploy'));
    await put('.rulegate/skills/deploy/SKILL.md', skillMd('deploy', 'My own version.'));
    const p = await plan();
    expect(messages(p)).toContain(
      'E_INIT_CANONICAL_EXISTS .rulegate/skills/deploy/SKILL.md already exists with other contents, and init would overwrite it',
    );
    expect(await init()).toBe(ExitCode.Failure);
    expect(await readFile(path.join(repo, '.rulegate/skills/deploy/SKILL.md'), 'utf8')).toBe(
      skillMd('deploy', 'My own version.'),
    );
  });
});

describe('doctor reports skills (T052)', () => {
  it("lists each tool's skills and flags one a tool loads from two directories", async () => {
    const { buildDoctorReport } = await import('@rulegate/core');
    await freshRepo();
    await put('.github/copilot-instructions.md', '# Project\n');
    for (const dir of ['.claude/skills', '.agents/skills']) {
      await put(`${dir}/deploy/SKILL.md`, skillMd('deploy'));
    }
    const report = await buildDoctorReport({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });
    const tool = (name: string) => report.tools.find((t) => t.name === name)!;
    expect(tool('claude-code').skills).toEqual([{ id: 'deploy', dirs: ['.claude/skills'] }]);
    expect(tool('codex').skills).toEqual([{ id: 'deploy', dirs: ['.agents/skills'] }]);
    expect(tool('copilot').skills).toEqual([
      { id: 'deploy', dirs: ['.claude/skills', '.agents/skills'] },
    ]);
    const dup = report.warnings.filter(
      (w) => w.code === 'W_DUPLICATE_LOAD' && w.message.includes('skill'),
    );
    expect(dup.map((w) => `${w.tool}: ${w.message}`)).toEqual([
      'copilot: loads the skill `deploy` twice, from .claude/skills and .agents/skills',
    ]);
    // Only tools in use are flagged: Cursor, Kilo and OpenCode read both directories too,
    // but none is detected here, and without .rulegate/ nothing enables them.
    expect(dup.map((w) => w.tool)).not.toContain('cursor');
    // A tool with no skills carries no field, rather than an empty list that says "none found".
    expect(tool('aider').skills).toBeUndefined();
  });
});
