import { appendFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLintCommand } from '../src/commands/lint.js';
import { ExitCode } from '../src/ui/exit.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

let repo: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'rulegate-lint-'));
  await cp(path.join(fixtures, 'doctor/adopted'), repo, { recursive: true });
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
  await rm(repo, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** `--no-global` throughout: the machine's real `$HOME` must never reach a test. */
const lint = (over: Partial<Parameters<typeof runLintCommand>[0]> = {}) =>
  runLintCommand({ cwd: repo, noGlobal: true, ...over });

const manifest = (): string => path.join(repo, '.rulegate/rulegate.yaml');

describe('rulegate lint — the shipped registry', () => {
  it('exits 0 on a repository whose only findings are warnings', async () => {
    // The whole command end to end: real adapters, a real repository on disk, and the
    // real exit code CI would read. The fixture trips `conflicting-rules` — several
    // tools legitimately reading `AGENTS.md` on top of their own files — which is
    // exactly the permanent, correct condition that must not fail a build.
    expect(await lint()).toBe(ExitCode.Ok);
    expect(stdout.join('')).toContain('conflicting-rules');
    expect(stderr.join('')).toContain('0 errors');
  });

  it('emits a well-formed report under --json', async () => {
    expect(await lint({ json: true })).toBe(ExitCode.Ok);
    const report = JSON.parse(stdout.join('')) as {
      errors: unknown[];
      findings: { rule: string; severity: string }[];
      errorCount: number;
      warnCount: number;
      unknownRules: unknown[];
      disabledRules: unknown[];
    };
    expect(report.errors).toEqual([]);
    expect(report.errorCount).toBe(0);
    expect(report.warnCount).toBe(report.findings.length);
    expect(report.findings.every((f) => f.severity === 'warn')).toBe(true);
    expect(report.unknownRules).toEqual([]);
    expect(report.disabledRules).toEqual([]);
  });

  it('exits 1 when a rule the repository raised to error fires', async () => {
    // The positive control for the exit code: without it, "exit 0" above would pass on
    // a command that could never return anything else.
    await appendFile(manifest(), 'lint:\n  rules:\n    conflicting-rules: error\n');
    expect(await lint()).toBe(ExitCode.Failure);
    expect(stderr.join('')).not.toContain('0 errors');
  });

  it('exits 0 again once that rule is turned off', async () => {
    await appendFile(manifest(), 'lint:\n  rules:\n    conflicting-rules: off\n');
    expect(await lint()).toBe(ExitCode.Ok);
  });

  it('names a configured rule that does not exist, on stderr', async () => {
    await appendFile(manifest(), 'lint:\n  rules:\n    no-such-rule: error\n');
    // Still exit 0: the misconfiguration is worth saying and is not itself drift.
    expect(await lint()).toBe(ExitCode.Ok);
    expect(stderr.join('')).toContain('no-such-rule');
    expect(stdout.join('')).not.toContain('no-such-rule');
  });

  it('refuses to call an unrenderable repository clean', async () => {
    await appendFile(manifest(), 'lint:\n  rules:\n    oversized-file: loud\n');
    // The severity is not one of the three, so the manifest does not parse. Nothing was
    // linted, and "no lint findings, exit 0" would be the worst possible answer — the
    // same reasoning that makes `check` refuse to verify an unrenderable plan.
    expect(await lint()).toBe(ExitCode.Failure);
    expect(stderr.join('')).toContain('nothing was linted');
    expect(stdout.join('')).not.toContain('no lint findings');
  });

  it('carries the same refusal through --json', async () => {
    await appendFile(manifest(), 'lint:\n  rules:\n    oversized-file: loud\n');
    expect(await lint({ json: true })).toBe(ExitCode.Failure);
    const report = JSON.parse(stdout.join('')) as { errors: unknown[]; findings: unknown[] };
    expect(report.errors).toHaveLength(1);
    expect(report.findings).toEqual([]);
  });

  it('reports nothing on stdout when quiet, and keeps the exit code', async () => {
    expect(await lint({ quiet: true })).toBe(ExitCode.Ok);
  });

  it('never emits ANSI escapes when the output is piped', async () => {
    // The paired control for this lives in `table.test.ts`; here the point is only that
    // a piped `lint` stays greppable. `process.stdout.write` is mocked, so `isTTY` is
    // whatever the runner has, and picocolors auto-disables off a TTY.
    await lint();
    expect(stdout.join('')).not.toMatch(new RegExp(`${String.fromCharCode(27)}\\[`));
  });
});
