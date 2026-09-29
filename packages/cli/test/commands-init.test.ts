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
 * T053: `init` imports the commands a repository's tools already have (RFC-0001 §13.3), each
 * read in its tool's format with its argument spelling turned back into `$ARGUMENTS`, and the
 * first `check` after `init --yes` is clean.
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
/** Claude Code and Gemini CLI, detected from their instruction files. */
async function freshRepo(): Promise<void> {
  repo = await mkdtemp(path.join(tmpdir(), 'rulegate-commands-init-'));
  scratch.push(repo);
  await put('CLAUDE.md', '# Project\n\nUse small modules.\n');
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

describe('doctor reports commands (T053)', () => {
  it("lists each tool's commands by /name, and nothing for a tool without them", async () => {
    const { buildDoctorReport } = await import('@rulegate/core');
    await freshRepo();
    await put('.claude/commands/review.md', '---\ndescription: Review.\n---\n\nGo.\n');
    await put('.claude/commands/notes.txt', 'not a command');
    await put('.gemini/commands/ship.toml', 'prompt = "Ship."\n');
    const report = await buildDoctorReport({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });
    const tool = (name: string) => report.tools.find((t) => t.name === name)!;
    expect(tool('claude-code').commands).toEqual(['review']);
    expect(tool('gemini').commands).toEqual(['ship']);
    expect(tool('codex').commands).toBeUndefined();
  });
});

describe('init imports commands (T053)', () => {
  it("collapses one command found in Claude Code's Markdown and Gemini CLI's TOML, and checks clean", async () => {
    await freshRepo();
    await put(
      '.claude/commands/review.md',
      '---\ndescription: Review a pull request.\n---\n\nReview pull request $ARGUMENTS.\n',
    );
    await put(
      '.gemini/commands/review.toml',
      'description = "Review a pull request."\nprompt = """\nReview pull request {{args}}.\n"""\n',
    );
    const p = await plan();
    expect(p.errors).toEqual([]);
    expect(messages(p).filter((m) => m.includes('W_COMMAND'))).toEqual([]);
    expect(p.canonical.commands.map((c) => c.id)).toEqual(['review']);
    // Both tools with commands had it, so it needs no `tools:`.
    expect(p.canonical.commands[0]!.tools).toEqual({ kind: 'all' });

    expect(await init()).toBe(ExitCode.Ok);
    expect(await readFile(path.join(repo, '.rulegate/commands/review.md'), 'utf8')).toBe(
      '---\ndescription: Review a pull request.\n---\n\nReview pull request $ARGUMENTS.\n',
    );
    expect(await readFile(path.join(repo, '.gemini/commands/review.toml'), 'utf8')).toContain(
      'Review pull request {{args}}.',
    );
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  it('describes a command with no frontmatter by its first line, as Claude Code does', async () => {
    await freshRepo();
    await put('.claude/commands/fix.md', '# Fix the failing test\n\nRun the suite and fix it.\n');
    const p = await plan();
    const [command] = p.canonical.commands;
    expect(command!.description).toBe('Fix the failing test');
    expect(command!.tools).toEqual({ kind: 'include', tools: ['claude-code'] });
    expect(await init()).toBe(ExitCode.Ok);
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  it("reads Copilot's spelling back as $ARGUMENTS, and sets its own `tools:` key aside", async () => {
    await freshRepo();
    await put('.github/copilot-instructions.md', '# Project\n');
    await put(
      '.github/prompts/plan.prompt.md',
      "---\ndescription: Plan a change.\ntools: ['codebase']\n---\n\nPlan ${input:args} step by step.\n",
    );
    const p = await plan();
    expect(p.canonical.commands[0]!.body).toBe('Plan $ARGUMENTS step by step.\n');
    expect(messages(p)).toContain(
      "W_COMMAND_IMPORT `tools` in .github/prompts/plan.prompt.md is copilot's own key, not Rulegate's `tools`, and was left out",
    );
  });

  it('imports one of two differing copies, and names the other', async () => {
    await freshRepo();
    await put('.claude/commands/ship.md', '---\ndescription: Ship it.\n---\n\nShip with Claude.\n');
    await put(
      '.gemini/commands/ship.toml',
      'description = "Ship it."\nprompt = "Ship with Gemini."\n',
    );
    const p = await plan();
    expect(p.canonical.commands[0]!.body).toBe('Ship with Claude.\n');
    expect(messages(p)).toContain(
      'W_COMMAND_IMPORT .gemini/commands/ship.toml differs from .claude/commands/ship.md: imported .claude/commands/ship.md and left this one where it is',
    );
  });

  it('does not import what it cannot read, or a positional placeholder two tools read differently', async () => {
    await freshRepo();
    await put('.gemini/commands/broken.toml', 'prompt = [1, 2]\n');
    await put('.claude/commands/diff.md', '---\ndescription: Diff.\n---\n\nCompare $1.\n');
    await put('.gemini/commands/diff.toml', 'description = "Diff."\nprompt = "Compare $1."\n');
    const p = await plan();
    expect(p.canonical.commands).toEqual([]);
    expect(messages(p)).toEqual(
      expect.arrayContaining([
        'W_COMMAND_IMPORT .gemini/commands/broken.toml was not imported: `prompt` is not a string',
        'W_COMMAND_IMPORT .claude/commands/diff.md was not imported: `$1` means a different argument in claude-code and gemini',
      ]),
    );
  });
});
