import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeFileSystem, computeInitPlan, computePlan } from '@rulegate/core';
import { ADAPTERS } from '../src/registry.js';
import { runInit } from '../src/commands/init.js';
import { runCheck } from '../src/commands/check.js';
import { runSync } from '../src/commands/sync.js';
import { ExitCode } from '../src/ui/exit.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'rulegate-init-'));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** Every file in the repo, repo-relative and sorted — the shape a filesystem spy compares. */
async function tree(dir = repo, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await tree(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

const read = (rel: string) => readFile(path.join(repo, rel), 'utf8');

const plan = () =>
  computeInitPlan({ repoRoot: repo, fs: new NodeFileSystem(repo), adapters: ADAPTERS });

/** A repository as it looks before anyone has heard of Rulegate. */
async function seedNativeConfigs(): Promise<void> {
  // Three shapes on purpose: a marker-bearing `CLAUDE.md` that imports structurally and
  // re-renders to the same bytes, a hand-written CRLF `AGENTS.md` that does not, and
  // Cursor's per-file `.mdc` plus a legacy `.cursorrules`.
  await cp(path.join(fixtures, 'claude-code-import/input'), repo, { recursive: true });
  await cp(path.join(fixtures, 'codex-import/input'), repo, { recursive: true });
  await cp(path.join(fixtures, 'cursor-import/input'), repo, { recursive: true });
}

/**
 * A flat config that has been pointed past JavaScript, which is what makes ESLint a threat
 * to a generated Markdown file at all. `@eslint/markdown` is the first-party plugin; any of
 * `ESLINT_NON_JS_SIGNALS` would do.
 */
const MARKDOWN_AWARE_FLAT_CONFIG = `import markdown from '@eslint/markdown';\nexport default [...markdown.configs.recommended];\n`;

describe('rulegate init', () => {
  it('writes nothing at all without --yes', async () => {
    await seedNativeConfigs();
    const before = await tree();

    // The filesystem spy T019's validation asks for. `writeFile` is what `applyPlan` and
    // `applyCanonicalFiles` both call, so a run that touched anything trips it — and the
    // tree comparison catches a write that went around it.
    const spy = vi.spyOn(NodeFileSystem.prototype, 'writeFile');
    try {
      expect(await runInit({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await tree()).toEqual(before);
  });

  it('applies exactly the plan it printed', async () => {
    await seedNativeConfigs();
    const planned = await computeInitPlan({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });

    expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);

    for (const file of planned.canonicalFiles) {
      expect(await read(file.path)).toBe(file.contents);
    }
    for (const artifact of planned.plan.artifacts) {
      expect(await read(artifact.path)).toBe(artifact.contents);
    }
  });

  it('leaves the repository in a state where sync is already up to date', async () => {
    // The actual promise of `init`: after it, the loop works. If the first `sync` after
    // `init` rewrote files or refused them, `init` would have handed the user a repo in a
    // state its own tool disagrees with.
    await seedNativeConfigs();
    expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);

    const after = await computePlan({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });
    for (const artifact of after.artifacts) {
      expect(await read(artifact.path)).toBe(artifact.contents);
    }
  });

  it('backs every pre-existing file up before taking ownership of it', async () => {
    await seedNativeConfigs();
    const original = await read('AGENTS.md');

    expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);

    // Taking ownership is what the user asked for; taking their work is not. The original
    // bytes are recoverable, byte for byte, from inside the repository — CRLF and BOM
    // included, which is why the backup is a `copyFile` and not a read-then-write.
    expect(await read('.rulegate/backup/AGENTS.md')).toBe(original);
    expect(await read('AGENTS.md')).not.toBe(original);

    // The other half, and the more interesting one: a file whose re-render is
    // byte-identical is adopted rather than rewritten, so it is not backed up and not
    // touched. This scoped rule file carries our marker, so import and render round-trip
    // it. (`CLAUDE.md` used to be the example; since T110 its scoped `Frontend` section
    // moves to `.claude/rules/`, so it is rewritten and backed up like AGENTS.md.)
    const scoped = '.claude/rules/30-components.md';
    expect(await read(scoped)).toBe(
      await readFile(path.join(fixtures, 'claude-code-import/input', scoped), 'utf8'),
    );
    await expect(read(`.rulegate/backup/${scoped}`)).rejects.toThrow();
  });

  // Taking ownership is what retires an original. A file imported and then left alone is
  // still loaded beside the generated copy of its rules, and nothing after `init` can see
  // it: `check` compares only what Rulegate owns (T110).
  it('warns about every imported file that no generated file replaces', async () => {
    await cp(path.join(fixtures, 'claude-code-import/input'), repo, { recursive: true });
    await cp(path.join(fixtures, 'cursor-import/input'), repo, { recursive: true });
    await mkdir(path.join(repo, '.claude/rules'), { recursive: true });
    await writeFile(path.join(repo, '.claude/rules/Auth.md'), '---\npaths: auth/**\n---\nx\n');

    const warnings = (await plan()).warnings.filter((w) => w.code === 'W_IMPORT_LEFT_BEHIND');
    expect(warnings.map((w) => w.source?.file)).toEqual([
      '.claude/rules/Auth.md',
      '.claude/rules/backend/db.md',
      '.claude/rules/security.md',
      '.cursorrules',
    ]);
    // Case-only: on APFS and NTFS the "left-behind" file *is* the output, so deleting it
    // would delete the rule. Never "rename" either: after `--yes` on a case-sensitive
    // filesystem that moves the original over the generated file Rulegate now owns.
    expect(warnings[0]?.hint).toBe(
      'once init has run, list the directory: if it shows both .claude/rules/Auth.md and .claude/rules/auth.md, delete .claude/rules/Auth.md; if it shows one, the filesystem ignores case, they are one file and nothing is left behind',
    );
    expect(warnings[0]?.hint).not.toMatch(/\brename\b/);
    expect(warnings[1]?.hint).toContain('delete .claude/rules/backend/db.md');
  });

  it('loses nothing from the file it takes over', async () => {
    await seedNativeConfigs();
    expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);

    const canonical = (await readdir(path.join(repo, '.rulegate/rules'))).sort();
    const contents = (await Promise.all(canonical.map((f) => read(`.rulegate/rules/${f}`)))).join(
      '\n',
    );

    for (const line of (await read('.rulegate/backup/AGENTS.md')).split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.includes('generated by rulegate')) continue;
      expect(contents, `line lost on import: ${trimmed}`).toContain(trimmed);
    }
  });

  it('says so and does nothing when the repository is already adopted', async () => {
    await cp(path.join(fixtures, 'cursor/input'), repo, { recursive: true });
    await seedNativeConfigs();
    const before = await tree();
    const manifest = await read('.rulegate/rulegate.yaml');

    const planned = await computeInitPlan({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });
    // The assertion that actually reaches the branch. Comparing the file tree alone is
    // not enough: with the guard removed, init re-imports the native files and rewrites
    // `.rulegate/rulegate.yaml` in place, which adds no paths and changes everything.
    expect(planned.adopted).toBe(true);
    expect(planned.canonicalFiles).toEqual([]);

    expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);
    expect(await tree()).toEqual(before);
    expect(await read('.rulegate/rulegate.yaml')).toBe(manifest);
  });

  it('leaves a canonical rule that already says what init would write it', async () => {
    // Reachable through `.rulegate/rules/` with no manifest — the parser's `rules-only`
    // mode. Without a leave-alone classification init reports every such file as a
    // create and rewrites it, which is a lie in the plan before it is a write on disk.
    await seedNativeConfigs();
    const first = await computeInitPlan({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });
    const rule = first.canonicalFiles.find((f) => f.path.startsWith('.rulegate/rules/'));
    expect(rule).toBeDefined();

    await mkdir(path.join(repo, '.rulegate/rules'), { recursive: true });
    await writeFile(path.join(repo, rule!.path), rule!.contents);

    const second = await computeInitPlan({
      repoRoot: repo,
      fs: new NodeFileSystem(repo),
      adapters: ADAPTERS,
    });
    expect(second.canonicalFiles.find((f) => f.path === rule!.path)?.kind).toBe('leave-alone');
  });

  it('reports a repository with no AI tool configuration rather than failing on it', async () => {
    await writeFile(path.join(repo, 'README.md'), '# nothing to see\n');
    expect(await runInit({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    expect(await tree()).toEqual(['README.md']);
  });

  it('warns that a formatter and a generator cannot both own the generated files', async () => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, '.prettierrc'), '{}\n');

    const planned = await plan();
    expect(planned.warnings.map((w) => w.code)).toContain('E_FORMATTER_CONFLICT');

    // The paired control: no formatter config, no warning. Without it the assertion above
    // passes against a warning that fires unconditionally.
    await rm(path.join(repo, '.prettierrc'));
    const quiet = await plan();
    expect(quiet.warnings.map((w) => w.code)).not.toContain('E_FORMATTER_CONFLICT');
  });

  // T072: Prettier was the only formatter the warning knew about, so a repository
  // formatted by anything else walked into the same deadlock with nothing said.
  it.each([
    ['Biome', 'biome.json', 'files.includes'],
    ['dprint', 'dprint.json', 'excludes'],
  ])('warns about %s too, naming where its exclusions live', async (name, config, where) => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, config), '{}\n');

    const warning = (await plan()).warnings.find((w) => w.message.includes(name));
    expect(warning?.code).toBe('E_FORMATTER_CONFLICT');
    // The hint has to name that formatter's own mechanism. Biome and dprint have no
    // ignore file at all, so "add these lines to .prettierignore" is wrong advice, which
    // is the same failure as no advice.
    expect(warning?.hint).toContain(where);
  });

  /**
   * T092, and the shape of the repository it was found on: a Next.js app with a flat ESLint
   * config and no Markdown plugin. ESLint lints JavaScript until a plugin says otherwise,
   * and Rulegate never generates a `.js` file, so the old warning fired on the first run
   * about files ESLint would never open.
   */
  it('stays quiet about ESLint when nothing points it past JavaScript', async () => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, 'eslint.config.mjs'), 'export default [];\n');

    const warnings = (await plan()).warnings;
    expect(warnings.filter((w) => w.message.includes('ESLint'))).toEqual([]);

    // The paired control, and the reason this is a gate rather than a deletion: Prettier
    // does reformat Markdown by default, so it still warns about the identical artifacts.
    await writeFile(path.join(repo, '.prettierrc'), '{}\n');
    const withPrettier = (await plan()).warnings;
    expect(withPrettier.map((w) => w.code)).toContain('E_FORMATTER_CONFLICT');
    expect(withPrettier.filter((w) => w.message.includes('ESLint'))).toEqual([]);
  });

  // The other half: opt in and the warning comes back, because now it is true.
  it.each([
    ['the flat config imports a Markdown plugin', MARKDOWN_AWARE_FLAT_CONFIG, undefined],
    ['package.json depends on one', 'export default [];\n', '@eslint/markdown'],
  ])('warns about ESLint once %s', async (_label, config, dep) => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, 'eslint.config.mjs'), config);
    if (dep !== undefined) {
      await writeFile(
        path.join(repo, 'package.json'),
        JSON.stringify({ name: 'x', devDependencies: { [dep]: '^6.0.0' } }, null, 2),
      );
    }

    const warning = (await plan()).warnings.find((w) => w.message.includes('ESLint'));
    expect(warning?.code).toBe('E_FORMATTER_CONFLICT');
    expect(warning?.hint).toContain('ignores');
  });

  // Found on a Next.js 16 repository during the T032 first-run rehearsal: every ESLint
  // config shape was pointed at `.eslintignore`, which ESLint 9 does not read under flat
  // config and *errors* on when it exists. The hint told the user to break their lint run.
  it('sends a flat config to `ignores` and never to .eslintignore', async () => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, 'eslint.config.mjs'), MARKDOWN_AWARE_FLAT_CONFIG);

    const warning = (await plan()).warnings.find((w) => w.message.includes('ESLint'));
    expect(warning?.code).toBe('E_FORMATTER_CONFLICT');
    expect(warning?.hint).not.toContain('.eslintignore');
    // And it names the config that exists, not the first spelling in the table.
    expect(warning?.hint).toContain('eslint.config.mjs');
  });

  // Flat config is the one ESLint loads when both shapes are present, so it is the one
  // answer to give. Two warnings would contradict each other, and the eslintrc one would
  // be the advice that breaks ESLint 9.
  it('gives the flat answer once when a repository carries both ESLint config shapes', async () => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, 'eslint.config.mjs'), MARKDOWN_AWARE_FLAT_CONFIG);
    await writeFile(path.join(repo, '.eslintrc.json'), '{}\n');

    const eslint = (await plan()).warnings.filter((w) => w.message.includes('ESLint'));
    expect(eslint).toHaveLength(1);
    expect(eslint[0]?.hint).toContain('ignores');
  });

  // A dependency with no config file at all is an ESLint 9 repository, so the bare-
  // dependency fallback must reach the flat entry and not the eslintrc one.
  it('treats a bare eslint dependency as flat config', async () => {
    await seedNativeConfigs();
    await writeFile(
      path.join(repo, 'package.json'),
      JSON.stringify(
        { name: 'x', devDependencies: { eslint: '^9.0.0', '@eslint/markdown': '^6.0.0' } },
        null,
        2,
      ),
    );

    const warning = (await plan()).warnings.find((w) => w.message.includes('ESLint'));
    expect(warning?.hint).toContain('ignores');
    expect(warning?.hint).not.toContain('.eslintignore');
  });

  it('detects Prettier from package.json when there is no config file', async () => {
    await seedNativeConfigs();
    await writeFile(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'x', devDependencies: { prettier: '^3.0.0' } }, null, 2),
    );

    expect((await plan()).warnings.map((w) => w.code)).toContain('E_FORMATTER_CONFLICT');
  });

  // The false positive, and the reason exact-line matching had to go: this repository's
  // own `.prettierignore` lists `.cursor/rules/` and `.github/instructions/`, which cover
  // their contents without naming one of them. A warning that fires on a correctly
  // configured repository is one people learn to ignore.
  it('stays quiet when the ignore file covers the generated paths by directory or glob', async () => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, '.prettierrc'), '{}\n');

    const planned = await plan();
    const generated = planned.plan.artifacts.map((a) => a.path);
    expect(generated.length).toBeGreaterThan(0);
    // Deliberately not the literal paths: directory entries and one `**` glob, which is
    // what a real ignore file looks like and what the old matcher could not read.
    await writeFile(
      path.join(repo, '.prettierignore'),
      ['# generated', '.cursor/', '.github/', '**/*.md', ''].join('\n'),
    );

    expect((await plan()).warnings.map((w) => w.code)).not.toContain('E_FORMATTER_CONFLICT');
  });

  // The other half of the same rule: a negation un-ignores, and the last matching line
  // wins. Without it a user who deliberately re-included one generated file is told
  // nothing about the only file that will actually be reformatted.
  it('warns about exactly the path a negation re-includes', async () => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, '.prettierrc'), '{}\n');
    await writeFile(
      path.join(repo, '.prettierignore'),
      ['.cursor/', '.github/', '**/*.md', '!CLAUDE.md', ''].join('\n'),
    );

    const warning = (await plan()).warnings.find((w) => w.code === 'E_FORMATTER_CONFLICT');
    expect(warning?.hint).toContain('CLAUDE.md');
    expect(warning?.message).toContain('1 generated file(s)');
  });

  /**
   * T095. Taking ownership copies the original to `.rulegate/backup/` verbatim, which is what
   * makes `restore` faithful — and for an `.mcp.json` holding a token, that faithful copy is a
   * plaintext credential inside the directory users are told to commit. Found in the T032
   * rehearsal on a repository whose `.gitignore` held `.mcp.json` precisely to keep the token
   * out of git.
   */
  const MCP_WITH_LITERAL = JSON.stringify(
    {
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_notARealTokenJustLongEnough1234567' },
        },
      },
    },
    null,
    2,
  );

  it('warns that taking ownership copies a credential into the directory you commit', async () => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, '.mcp.json'), `${MCP_WITH_LITERAL}\n`);

    const warning = (await plan()).warnings.find((w) => w.code === 'W_BACKUP_SECRET');
    expect(warning?.message).toContain('.mcp.json');
    expect(warning?.message).toContain('.rulegate/backup/.mcp.json');
    // The scanner's whole bargain: key paths, never values. A warning that quoted the
    // credential would print it into CI logs — the failure it exists to prevent, moved.
    expect(warning?.message).not.toContain('ghp_');
    expect(warning?.hint).not.toContain('ghp_');
  });

  it('stays quiet when .gitignore already covers the backup', async () => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, '.mcp.json'), `${MCP_WITH_LITERAL}\n`);
    // A bare name matches at every depth under gitignore's rules, so this one line covers
    // `.rulegate/backup/.mcp.json` too. Warning here would be a warning on a repository that
    // is already correct, which is the T072 lesson.
    await writeFile(path.join(repo, '.gitignore'), '.mcp.json\n');

    expect((await plan()).warnings.map((w) => w.code)).not.toContain('W_BACKUP_SECRET');
  });

  it('stays quiet when the file being taken over holds no credential', async () => {
    await seedNativeConfigs();
    await writeFile(
      path.join(repo, '.mcp.json'),
      `${JSON.stringify({ mcpServers: { docs: { url: 'https://mcp.example.com' } } }, null, 2)}\n`,
    );

    expect((await plan()).warnings.map((w) => w.code)).not.toContain('W_BACKUP_SECRET');
  });

  // T019's decision, made mechanical: `init` warns about the user's ignore file and never
  // edits it. A tool whose pitch is that it never touches what it did not generate should
  // not open its first conversation by editing something it did not generate.
  it('never writes an ignore file, even under --yes', async () => {
    await seedNativeConfigs();
    await writeFile(path.join(repo, '.prettierrc'), '{}\n');
    await writeFile(path.join(repo, '.prettierignore'), '# mine\n');

    expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);

    expect(await read('.prettierignore')).toBe('# mine\n');
    expect(await tree()).not.toContain('.eslintignore');
  });
});

/**
 * T113's validation: an agent-os project migrates in one `init`. The dry run prints a plan
 * that takes over agent-os's outputs and writes nothing; `--yes` backs every one of them up
 * before overwriting it, leaves the files it only warned about alone, and hands over a
 * repository `check` calls clean.
 */
describe('rulegate init — from agent-os (T113)', () => {
  /** agent-os's bannered outputs plus the hand-written files; every one is taken over. */
  const TAKEN_OVER = [
    '.agents/rules/api.md',
    '.agents/rules/style.md',
    '.agents/rules/tests.md',
    '.claude/rules/api.md',
    '.claude/rules/tests.md',
    '.clinerules/api.md',
    '.clinerules/tests.md',
    '.cursor/rules/api.mdc',
    '.cursor/rules/style.mdc',
    '.cursor/rules/team.mdc',
    '.cursor/rules/tests.mdc',
    '.windsurf/rules/api.md',
    '.windsurf/rules/style.md',
    '.windsurf/rules/tests.md',
    'AGENTS.md',
    'CLAUDE.md',
  ];
  /** Reported, never written: merged configs, skill copies, and agent-os's own sources. */
  const LEFT_ALONE = [
    '.agent-os/AGENTS.md',
    '.agent-os/config.json',
    '.agent-os/rules/api.md',
    '.agents/skills/review/SKILL.md',
    '.claude/skills/review/SKILL.md',
    '.gemini/settings.json',
    'kilo.json',
    'opencode.json',
  ];

  const seedAgentOs = () =>
    cp(path.join(fixtures, 'agent-os-import/input'), repo, { recursive: true });

  it('prints the takeover and writes nothing without --yes', async () => {
    await seedAgentOs();
    const before = await tree();
    const spy = vi.spyOn(NodeFileSystem.prototype, 'writeFile');
    const log = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await runInit({ cwd: repo })).toBe(ExitCode.Ok);
      expect(spy).not.toHaveBeenCalled();
      const printed = log.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(printed).toContain('migrating from  agent-os');
      for (const file of TAKEN_OVER) expect(printed).toContain(`  ${file}\n`);
    } finally {
      spy.mockRestore();
      log.mockRestore();
    }
    expect(await tree()).toEqual(before);
  });

  it('backs up every file it takes over, leaves the rest, and check is clean after', async () => {
    await seedAgentOs();
    const original = new Map<string, string>();
    for (const file of [...TAKEN_OVER, ...LEFT_ALONE]) original.set(file, await read(file));

    expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);

    for (const file of TAKEN_OVER) {
      expect(await read(`.rulegate/backup/${file}`), file).toBe(original.get(file));
    }
    const state = JSON.parse(await read('.rulegate/state.json')) as {
      artifacts: { path: string }[];
    };
    const owned = new Set(state.artifacts.map((a) => a.path));
    for (const file of LEFT_ALONE) {
      expect(await read(file), file).toBe(original.get(file));
      expect(owned, file).not.toContain(file);
    }
    // The plugin's settings file is printed, never written: its existence is how the
    // plugin tells a project that has run /rulegate:init from one that has not.
    await expect(read('.claude/rulegate.json')).rejects.toThrow();

    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  it('refuses a .agent-os/ built from Rulegate output, and writes nothing (T120)', async () => {
    await cp(path.join(fixtures, 'agent-os-import-adopted/input'), repo, { recursive: true });
    const before = await tree();
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await runInit({ cwd: repo, yes: true })).toBe(ExitCode.Failure);
      const printed = err.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(printed).toContain('restore .rulegate/ from git history');
    } finally {
      err.mockRestore();
    }
    expect(await tree()).toEqual(before);
  });
});
