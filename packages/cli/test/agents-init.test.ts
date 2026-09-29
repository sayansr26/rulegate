import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
 * T054: `init` imports the agents a repository's tools already have (RFC-0001 §14.3), each
 * read in its folder's format, and the first `check` after `init --yes` is clean.
 */

let repo: string;
const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function put(rel: string, contents: string): Promise<void> {
  await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
  await writeFile(path.join(repo, rel), contents);
}
/** Claude Code, Codex and Gemini CLI, detected from their instruction files. */
async function freshRepo(): Promise<void> {
  repo = await mkdtemp(path.join(tmpdir(), 'rulegate-agents-init-'));
  scratch.push(repo);
  await put('CLAUDE.md', '# Project\n\nUse small modules.\n');
  await put('AGENTS.md', '# Project\n\nUse small modules.\n');
  await put('GEMINI.md', '# Project\n\nUse small modules.\n');
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

const REVIEWER =
  '---\nname: reviewer\ndescription: Reviews a diff for risks.\ntools: Read, Grep\n---\n\nList every risk.\n';

describe('doctor reports agents (T054)', () => {
  it("lists each tool's agents and flags one a tool finds in two of its folders", async () => {
    const { buildDoctorReport } = await import('@rulegate/core');
    await freshRepo();
    await put('.github/copilot-instructions.md', '# Project\n');
    await put('.claude/agents/reviewer.md', REVIEWER);
    await put('.github/agents/reviewer.agent.md', REVIEWER);
    await put('.codex/agents/planner.toml', 'name = "planner"\n');
    const report = await buildDoctorReport({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });
    const tool = (name: string) => report.tools.find((t) => t.name === name)!;
    expect(tool('claude-code').agents).toEqual([{ id: 'reviewer', dirs: ['.claude/agents'] }]);
    expect(tool('codex').agents).toEqual([{ id: 'planner', dirs: ['.codex/agents'] }]);
    expect(tool('copilot').agents).toEqual([
      { id: 'reviewer', dirs: ['.github/agents', '.claude/agents'] },
    ]);
    const dup = report.warnings.filter(
      (w) => w.code === 'W_DUPLICATE_LOAD' && w.message.includes('agent'),
    );
    expect(dup.map((w) => `${w.tool}: ${w.message}`)).toEqual([
      'copilot: finds the agent `reviewer` in both .github/agents and .claude/agents',
    ]);
    expect(dup[0]!.paths).toEqual([
      '.claude/agents/reviewer.md',
      '.github/agents/reviewer.agent.md',
    ]);
    expect(tool('aider').agents).toBeUndefined();
  });
});

describe('init imports agents (T054)', () => {
  it("keeps a Claude agent's `tools` as its allowlist, names it by `name`, and checks clean", async () => {
    await freshRepo();
    await put('.claude/agents/code-reviewer.md', REVIEWER);
    const p = await plan();
    expect(p.errors).toEqual([]);
    expect(p.canonical.agents.map((a) => a.id)).toEqual(['reviewer']);
    expect(p.canonical.agents[0]!.adapters).toEqual({ kind: 'include', tools: ['claude-code'] });
    // The file was called something else, so the generated copy lands beside it.
    expect(messages(p)).toContain(
      'W_IMPORT_LEFT_BEHIND .claude/agents/code-reviewer.md was imported and stays on disk: claude-code will load it beside the generated copy',
    );

    expect(await init()).toBe(ExitCode.Ok);
    expect(await readFile(path.join(repo, '.rulegate/agents/reviewer.md'), 'utf8')).toBe(
      '---\nname: reviewer\ndescription: Reviews a diff for risks.\ntools: Read, Grep\nadapters:\n  - claude-code\n---\n\nList every risk.\n',
    );
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  it("collapses one agent in Codex's TOML and Gemini CLI's Markdown", async () => {
    await freshRepo();
    await put(
      '.codex/agents/planner.toml',
      'name = "planner"\ndescription = "Plans a change."\nmodel = "gpt-5"\ndeveloper_instructions = """\nBreak it into steps.\n"""\n',
    );
    await put(
      '.gemini/agents/planner.md',
      '---\nname: planner\ndescription: Plans a change.\ntemperature: 0.2\n---\n\nBreak it into steps.\n',
    );
    const p = await plan();
    expect(p.errors).toEqual([]);
    // Merged from both copies, so each tool's copy leaves out the key the other one had.
    expect(messages(p).filter((m) => m.includes('W_AGENT'))).toEqual([
      'W_AGENT_FIELD_DROPPED `temperature` in `planner` was left out of .codex/agents/: no tool that reads it understands the key',
    ]);
    const [agent] = p.canonical.agents;
    expect(agent!.adapters).toEqual({ kind: 'include', tools: ['codex', 'gemini'] });
    expect(agent!.frontmatter.map(([k]) => k)).toEqual([
      'name',
      'description',
      'model',
      'temperature',
      'adapters',
    ]);
    expect(await init()).toBe(ExitCode.Ok);
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  it('treats copies with different restrictions as different agents', async () => {
    await freshRepo();
    await put('.claude/agents/reviewer.md', REVIEWER);
    await put(
      '.gemini/agents/reviewer.md',
      '---\nname: reviewer\ndescription: Reviews a diff for risks.\n---\n\nList every risk.\n',
    );
    const p = await plan();
    expect(p.canonical.agents[0]!.adapters).toEqual({ kind: 'include', tools: ['claude-code'] });
    expect(messages(p)).toContain(
      'W_AGENT_IMPORT .gemini/agents/reviewer.md differs from .claude/agents/reviewer.md: imported .claude/agents/reviewer.md and left this one where it is',
    );
  });

  it('does not import what it cannot read, and says why', async () => {
    await freshRepo();
    await put(
      '.codex/agents/db.toml',
      'name = "db"\ndescription = "D."\ndeveloper_instructions = "x"\n[mcp_servers.pg]\ncommand = "pg"\n',
    );
    await put('.gemini/agents/bad.md', '---\nname: Bad Name\ndescription: D.\n---\n\nX.\n');
    const p = await plan();
    expect(p.canonical.agents).toEqual([]);
    expect(messages(p)).toEqual(
      expect.arrayContaining([
        'W_AGENT_IMPORT .codex/agents/db.toml was not imported: it has a table, and only top-level string keys are read',
        'W_AGENT_IMPORT .gemini/agents/bad.md was not imported: agent name `Bad Name` is not valid',
      ]),
    );
  });
});
