import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../src/commands/init.js';
import { runLintCommand } from '../src/commands/lint.js';
import { ExitCode } from '../src/ui/exit.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

let repo: string;
let sandbox: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'rulegate-caps-'));
  await cp(path.join(fixtures, 'agent-os-import-oversized/input'), repo, { recursive: true });
  // Hermetic against Claude Code, as in `init.test.ts`: an empty config dir and a PATH with
  // no `claude` on it, so nothing here reaches the real `~/.claude` or the real binary.
  sandbox = await mkdtemp(path.join(tmpdir(), 'rulegate-caps-home-'));
  await mkdir(path.join(sandbox, 'bin'));
  vi.stubEnv('HOME', sandbox);
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(sandbox, '.claude'));
  vi.stubEnv('PATH', path.join(sandbox, 'bin'));
  stdout = [];
  stderr = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(repo, { recursive: true, force: true });
  await rm(sandbox, { recursive: true, force: true });
});

const lint = () => runLintCommand({ cwd: repo, noGlobal: true });

describe('T143 — a migrated agent-os project on day one', () => {
  it("names AGENTS.md's growth past Windsurf's cap in the plan, before writing", async () => {
    expect(await runInit({ cwd: repo, plugin: false })).toBe(ExitCode.Ok);
    const printed = stderr.join('');
    expect(printed).toContain('W_SIZE_CAP_CROSSED');
    expect(printed).toMatch(/AGENTS\.md grows from 590 to \d+ bytes/);
    expect(printed).toContain('the 12000-byte per-file limit Windsurf documents');
    expect(printed).toContain('Windsurf is not enabled here');
    // The caps it stays under are not named: Antigravity's 24,000 and Codex's 32 KiB.
    expect(printed).not.toContain('Antigravity documents');
    expect(printed).not.toContain('Codex documents');
  });

  it('lints clean after init --yes: tools nobody uses are info, not a failure', async () => {
    expect(await runInit({ cwd: repo, yes: true, plugin: false, quiet: true })).toBe(ExitCode.Ok);
    stdout.length = 0;
    stderr.length = 0;

    expect(await lint()).toBe(ExitCode.Ok);
    const rows = stdout.join('');
    expect(rows).toMatch(/^info +oversized-file +AGENTS\.md/m);
    expect(rows).toMatch(/^info +conflicting-rules/m);
    expect(stderr.join('')).toContain('0 errors');
    expect(stderr.join('')).not.toContain('hint: oversized-file');
  });

  it('still fails once the repository enables the tool the file is too big for', async () => {
    // The positive control: an `info` that no configuration could turn back into an error
    // would make the test above pass on a linter that had stopped checking caps at all.
    expect(await runInit({ cwd: repo, yes: true, plugin: false, quiet: true })).toBe(ExitCode.Ok);
    const manifest = path.join(repo, '.rulegate/rulegate.yaml');
    const text = await readFile(manifest, 'utf8');
    await writeFile(manifest, text.replace('tools:\n', 'tools:\n  - windsurf\n'));

    expect(await lint()).toBe(ExitCode.Failure);
    expect(stdout.join('')).toMatch(/^error +oversized-file +AGENTS\.md/m);
  });
});
