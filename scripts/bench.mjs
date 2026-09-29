#!/usr/bin/env node
// Performance benchmark and regression gate (T062, NFR6).
//
//   node scripts/bench.mjs            run, print a table, exit 1 if a budget is exceeded
//   node scripts/bench.mjs --json     the same, as JSON
//
// Runs the **built** CLI (`pnpm build` first) as a user would, process start included, against
// repositories generated here byte for byte the same on every run:
//
//   standard      one `.rulegate/` with every adapter enabled, rules, MCP, skills, commands and
//                 agents, and 500 source files beside them — a typical repository
//   monorepo-50   the same root plus fifty packages, each with its own nested `.rulegate/`
//   monorepo-100  twice that, to measure how the cost grows
//
// Budgets are the task's: `check` under 1s on the standard repository and under 2s on fifty
// packages; a `sync` with nothing to write has the same budgets, since it reads as much as
// `check` does. The growth budget is what catches the regression a faster machine hides: a
// quadratic walk costs four times as much at twice the size, while O(files) stays under two
// and a half with process start in the mix. Each figure is the median of five runs after one
// warm-up. Writes only under the OS temp directory, and reaches no network.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { dirname, join } from 'node:path';

const json = process.argv.includes('--json');
const root = new URL('..', import.meta.url).pathname;
const cli = join(root, 'packages/cli/dist/bin.js');
if (!existsSync(cli)) {
  process.stderr.write('packages/cli/dist/bin.js is missing: run `pnpm build` first\n');
  process.exit(2);
}

const BUDGET_MS = { standard: 1000, 'monorepo-50': 2000 };
const MAX_GROWTH = 2.5;
const RUNS = 5;

const TOOLS = [
  'aider',
  'antigravity',
  'claude-code',
  'cline',
  'codex',
  'copilot',
  'cursor',
  'gemini',
  'kilo',
  'opencode',
  'roo-code',
  'windsurf',
  'zed',
];
const MANIFEST = `schemaVersion: 1\ntools:\n${TOOLS.map((t) => `  - ${t}\n`).join('')}`;

/** A repository: the standard root, and `packages` nested levels under `packages/`. */
function generate(dir, packages) {
  const put = (path, contents) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), contents);
  };
  put('.rulegate/rulegate.yaml', MANIFEST);
  for (let r = 0; r < 10; r++) {
    const scoped = r % 3 === 0 ? "globs: ['src/**/*.ts']\n" : '';
    put(
      `.rulegate/rules/${String(r).padStart(2, '0')}-rule.md`,
      `---\ndescription: Rule ${r}\n${scoped}---\n\n# Rule ${r}\n\n${'Keep modules small and names clear. '.repeat(20)}\n`,
    );
  }
  put(
    '.rulegate/mcp/servers.yaml',
    'servers:\n  github:\n    command: npx\n    args: [-y, "@modelcontextprotocol/server-github"]\n    env:\n      GITHUB_TOKEN: env:GITHUB_TOKEN\n  docs:\n    url: https://example.com/mcp\n',
  );
  for (let s = 0; s < 5; s++) {
    put(
      `.rulegate/skills/skill-${s}/SKILL.md`,
      `---\nname: skill-${s}\ndescription: Skill ${s}.\n---\n\nDo ${s}.\n`,
    );
    put(`.rulegate/skills/skill-${s}/scripts/run.sh`, `#!/bin/sh\necho ${s}\n`);
  }
  for (let c = 0; c < 5; c++) {
    put(
      `.rulegate/commands/cmd-${c}.md`,
      `---\ndescription: Command ${c}.\n---\n\nRun ${c} on $ARGUMENTS.\n`,
    );
  }
  for (let a = 0; a < 5; a++) {
    put(
      `.rulegate/agents/agent-${a}.md`,
      `---\nname: agent-${a}\ndescription: Agent ${a}.\n---\n\nBe agent ${a}.\n`,
    );
  }
  for (let f = 0; f < 500; f++)
    put(`src/mod-${Math.floor(f / 50)}/file-${f}.ts`, `export const x${f} = ${f};\n`);
  for (let p = 0; p < packages; p++) {
    const pkg = `packages/pkg-${String(p).padStart(3, '0')}`;
    put(`${pkg}/.rulegate/rulegate.yaml`, MANIFEST);
    for (let r = 0; r < 3; r++) {
      put(
        `${pkg}/.rulegate/rules/${r}-local.md`,
        `---\ndescription: Local ${p}/${r}\n---\n\n# Local ${r}\n\n${'Package-specific guidance. '.repeat(10)}\n`,
      );
    }
    for (let f = 0; f < 20; f++) put(`${pkg}/src/file-${f}.ts`, `export const x${f} = ${f};\n`);
    put(`${pkg}/package.json`, `{"name":"pkg-${p}"}\n`);
  }
}

function run(cwd, args) {
  const start = performance.now();
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, stdio: 'ignore' });
  return { ms: performance.now() - start, status: r.status };
}

function median(cwd, args) {
  run(cwd, args);
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const r = run(cwd, args);
    if (r.status !== 0) throw new Error(`rulegate ${args.join(' ')} exited ${r.status} in ${cwd}`);
    times.push(r.ms);
  }
  return times.sort((a, b) => a - b)[Math.floor(RUNS / 2)];
}

const work = mkdtempSync(join(tmpdir(), 'rulegate-bench-'));
const results = {};
try {
  for (const [name, packages] of [
    ['standard', 0],
    ['monorepo-50', 50],
    ['monorepo-100', 100],
  ]) {
    const dir = join(work, name);
    generate(dir, packages);
    const fresh = run(dir, ['sync']);
    if (fresh.status !== 0) throw new Error(`rulegate sync exited ${fresh.status} in ${name}`);
    results[name] = {
      syncFresh: Math.round(fresh.ms),
      syncAgain: Math.round(median(dir, ['sync'])),
      check: Math.round(median(dir, ['check'])),
    };
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const failures = [];
for (const [name, budget] of Object.entries(BUDGET_MS)) {
  for (const key of ['check', 'syncAgain']) {
    if (results[name][key] > budget) {
      failures.push(`${name} ${key} took ${results[name][key]}ms; the budget is ${budget}ms`);
    }
  }
}
const growth = results['monorepo-100'].check / results['monorepo-50'].check;
if (growth > MAX_GROWTH) {
  failures.push(
    `check grew ${growth.toFixed(2)}x from 50 to 100 packages; O(files) stays under ${MAX_GROWTH}x`,
  );
}

if (json) {
  process.stdout.write(
    `${JSON.stringify({ results, growth: Number(growth.toFixed(2)), failures }, null, 2)}\n`,
  );
} else {
  process.stdout.write('repository     sync (fresh)  sync (again)  check\n');
  for (const [name, r] of Object.entries(results)) {
    process.stdout.write(
      `${name.padEnd(14)} ${`${r.syncFresh}ms`.padStart(12)}  ${`${r.syncAgain}ms`.padStart(12)}  ${`${r.check}ms`.padStart(6)}\n`,
    );
  }
  process.stdout.write(`check growth 50 -> 100 packages: ${growth.toFixed(2)}x\n`);
  for (const f of failures) process.stderr.write(`over budget: ${f}\n`);
}
process.exit(failures.length > 0 ? 1 : 0);
