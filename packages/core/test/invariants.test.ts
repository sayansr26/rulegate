import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import vitestConfig from '../../../vitest.config.js';
import { GIT_SUBCOMMANDS, StagedFileSystem } from '../src/git/index.js';
import {
  GIT_SAFETY_ARGS as PLUGIN_GIT_SAFETY_ARGS,
  GIT_SUBCOMMANDS as PLUGIN_GIT_SUBCOMMANDS,
} from '../../../plugins/rulegate/src/git/index.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Repo-relative and POSIX. Every allowlist and expected value in this file is written
 * with forward slashes, but `path.relative` emits `\` on Windows — which is how the write
 * allowlist and the picocolors pin came to report five correct files and one correct
 * import as violations on the Windows cells, and only there. The separator is exactly the
 * class of difference this matrix exists to find, so the tests that police it must not be
 * the ones that trip over it.
 */
function relPosix(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

/**
 * NFR1 says zero network calls "by default and forever". A README promise decays;
 * a test does not. These two suites are the mechanical form of that promise, and of
 * the thin-dependency claim the project's own pitch rests on.
 */

const ALLOWED_RUNTIME_DEPS = new Set(['yaml', 'commander', 'picocolors']);

async function adapterDirs(): Promise<string[]> {
  const entries = await readdir(path.join(repoRoot, 'packages/adapters'), { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => `packages/adapters/${e.name}`)
    .sort();
}

async function packageManifests(): Promise<{ name: string; dir: string; json: PackageJson }[]> {
  // Adapters are *discovered*, not listed. A hardcoded list would silently stop covering
  // the next adapter someone scaffolds (T028), and an invariant that quietly narrows its
  // own scope while staying green is worse than not having it.
  // `packages/interop` is listed explicitly (T054): it is not an adapter and does not live
  // under `packages/adapters/`, but it ships, so the dependency allowlist and the engines
  // pin must cover it. A package that escapes this list is a package where a third-party
  // dependency can arrive unnoticed. `plugins/rulegate` is listed for the same reason
  // (T104): its bundle ships inside the Claude Code plugin, and whatever it depends on
  // ships with it.
  const dirs = [
    'packages/core',
    'packages/cli',
    'packages/adapter-kit',
    'packages/interop',
    'action',
    'plugins/rulegate',
  ].concat(await adapterDirs());
  return Promise.all(
    dirs.map(async (dir) => {
      const json = JSON.parse(
        await readFile(path.join(repoRoot, dir, 'package.json'), 'utf8'),
      ) as PackageJson;
      return { name: json.name, dir, json };
    }),
  );
}

interface PackageJson {
  name: string;
  dependencies?: Record<string, string>;
  engines?: { node?: string };
  type?: string;
}

describe('dependency surface', () => {
  it('declares no third-party runtime dependency outside the allowlist', async () => {
    const offenders: string[] = [];
    for (const { name, json } of await packageManifests()) {
      for (const dep of Object.keys(json.dependencies ?? {})) {
        if (dep.startsWith('@rulegate/') || dep === 'rulegate') continue;
        if (!ALLOWED_RUNTIME_DEPS.has(dep)) offenders.push(`${name} -> ${dep}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('pins every package to ESM and Node >=20', async () => {
    for (const { name, json } of await packageManifests()) {
      expect(json.type, `${name} must be ESM`).toBe('module');
      expect(json.engines?.node, `${name} engines.node`).toBe('>=20');
    }
  });
});

/**
 * The only directories in shipped source that may spawn a process, each running only
 * read-only git: the CLI's `check --staged` (T052) and the Claude Code plugin's hooks
 * (T104). The test below pins the length. T115 (D3) will add `packages/cli/src/claude` for
 * the pinned `claude plugin …` subcommands, and must pin that list the same way.
 */
const SPAWN_ALLOWLIST = ['packages/core/src/git', 'plugins/rulegate/src/git'];

/**
 * The `node:` prefix is optional in every pattern. Third-party code imports `https`, not
 * `node:https`, and esbuild keeps the specifier as written — including as `__require(…)`
 * in a bundle — so a prefix-only pattern scanned the plugin's bundle and matched nothing a
 * dependency could bring in.
 */
const NETWORK_PRIMITIVES = [
  /(?:\bfrom|\bimport|\brequire\(|__require\()\s*['"](?:node:)?(?:https?|http2|net|dgram|dns|tls|undici)['"]/,
  /\bfetch\s*\(/,
  /\bglobalThis\.fetch\b/,
  /\bXMLHttpRequest\b/,
];

describe('zero network calls', () => {
  it('has no network primitive anywhere in shipped source', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8');
      for (const pattern of NETWORK_PRIMITIVES) {
        if (pattern.test(text)) {
          offenders.push(`${relPosix(file)} matches ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('spawns no process outside the allowlisted directories', async () => {
    // T023 banned `child_process` outright and said the ban would be narrowed when
    // `check --staged` arrived, because reading the git index means a subprocess. T052 is
    // that narrowing, and T104 the second: the plugin's hooks need `git log` and
    // `ls-files`. The assertion below pins the length, so every entry is a decision
    // recorded here rather than an accretion: a ban that grows an entry per feature is not
    // a ban, and `curl` is one `execFile` away from "zero network calls" being false.
    expect(SPAWN_ALLOWLIST).toHaveLength(2);

    const FORBIDDEN_SPAWN = [
      /from\s+['"](node:)?child_process['"]/,
      /require\(\s*['"](node:)?child_process['"]\s*\)/,
    ];
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const rel = relPosix(file);
      // Directory boundary, not string prefix: `src/git` must not also exempt
      // `src/github.ts` or a hook named `src/git-context.ts`.
      if (SPAWN_ALLOWLIST.some((dir) => rel.startsWith(`${dir}/`))) continue;
      const text = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN_SPAWN) {
        if (pattern.test(text)) offenders.push(`${rel} matches ${String(pattern)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('runs only read-only git subcommands, and only from the allowlisted directory', async () => {
    // The allowlist is a hole, so the hole gets its own guard. `execFile('git', [...])`
    // reaches `git fetch` and a submodule update as easily as `ls-files`, and either one
    // makes "zero network calls" false while every file scan above stays green.
    expect([...GIT_SUBCOMMANDS].sort()).toEqual(['cat-file', 'ls-files', 'rev-parse']);

    const text = await readFile(path.join(repoRoot, SPAWN_ALLOWLIST[0]!, 'index.ts'), 'utf8');
    // `exec` runs a shell; `execFile` does not. The difference is whether a filename
    // containing `$(…)` is an argument or a command.
    expect(text).not.toMatch(/\bexec\s*\(/);
    expect(text).toMatch(/\bexecFile\s*\(/);
    // Every literal subcommand in the file must be one the contract declares.
    for (const [, sub] of text.matchAll(/run\(\s*\[\s*'([a-z-]+)'/g)) {
      expect(GIT_SUBCOMMANDS).toContain(sub);
    }
  });

  it("confines the plugin's git to four read-only subcommands", async () => {
    // The second hole gets the same guard as the first, and more, because hooks fire on
    // their own at session start. A read-only subcommand is not a read-only call: `status`
    // takes `index.lock`, `core.fsmonitor` runs a configured program, `log.showSignature`
    // runs gpg, and a partial clone fetches blobs from its remote. Each switch is asserted
    // here rather than trusted to survive an edit; the option allowlist that keeps
    // `--output=` and `-p` out is exercised in `plugins/rulegate/test/git.test.ts`.
    expect([...PLUGIN_GIT_SUBCOMMANDS].sort()).toEqual(['log', 'ls-files', 'rev-parse', 'status']);
    expect(PLUGIN_GIT_SAFETY_ARGS).toEqual([
      '--no-lazy-fetch',
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'log.showSignature=false',
    ]);

    const text = await readFile(path.join(repoRoot, SPAWN_ALLOWLIST[1]!, 'index.ts'), 'utf8');
    expect(text).not.toMatch(/\bexec\s*\(/);
    expect(text).toMatch(/\bexecFile\s*\(/);
    expect(text).toMatch(/\[\.\.\.GIT_SAFETY_ARGS, \.\.\.args\]/);
    expect(text).toContain("GIT_NO_LAZY_FETCH: '1'");

    // Callers live outside the git directory (the hooks), so the literal-subcommand scan
    // covers every plugin source file rather than the module alone.
    for (const file of await sourceFiles()) {
      if (!relPosix(file).startsWith('plugins/')) continue;
      const src = await readFile(file, 'utf8');
      for (const [, sub] of src.matchAll(/runGit\(\s*\[\s*['"`]([a-z-]+)['"`]/g)) {
        expect(PLUGIN_GIT_SUBCOMMANDS, relPosix(file)).toContain(sub);
      }
    }
  });

  it("has no network primitive in the plugin's committed bundle", async () => {
    // The bundle, not just its source: esbuild inlines whatever the hooks import, so a
    // dependency that reaches for `fetch` arrives in `dist/` without appearing in
    // `plugins/rulegate/src` at all. `child_process` is not scanned for here — the git
    // module legitimately bundles it; the source scans above police who may call it.
    const offenders: string[] = [];
    for (const file of await bundleFiles()) {
      const text = await readFile(file, 'utf8');
      for (const pattern of NETWORK_PRIMITIVES) {
        if (pattern.test(text)) offenders.push(`${relPosix(file)} matches ${String(pattern)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has no nondeterministic primitive in shipped source', async () => {
    // See docs/determinism.md. os.EOL, locale-sensitive comparison, and clock or
    // randomness reads all make output depend on where it was produced.
    const FORBIDDEN_NONDETERMINISM = [/\bos\.EOL\b/, /\.localeCompare\(/, /Math\.random\(/];
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8');
      for (const pattern of FORBIDDEN_NONDETERMINISM) {
        if (pattern.test(text)) {
          offenders.push(`${relPosix(file)} matches ${String(pattern)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

async function sourceFiles(): Promise<string[]> {
  const roots = [
    path.join(repoRoot, 'packages'),
    path.join(repoRoot, 'action', 'src'),
    path.join(repoRoot, 'plugins', 'rulegate', 'src'),
  ];
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'test') {
          continue;
        }
        await walk(child);
        continue;
      }
      if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(child);
    }
  };
  await Promise.all(roots.map(walk));
  return out.sort();
}

/** Every `.js` under the plugin's committed `dist/`; empty until the first hook lands. */
async function bundleFiles(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith('.js')) out.push(child);
    }
  };
  await walk(path.join(repoRoot, 'plugins', 'rulegate', 'dist'));
  return out.sort();
}

describe('the shared rendering path', () => {
  /**
   * `check` and `sync` must consume one rendering pass. The mechanism is that only
   * `pipeline/apply.ts` writes and only adapters render — so if writing or rendering
   * leaks into the CLI, the two commands can drift apart and `check` starts lying.
   * These are structural assertions, not style rules.
   */
  /**
   * Async and sync forms alike. The first version matched only `writeFile(`, `copyFile(`,
   * `unlink(`, `rmSync(` and `deleteFile(`, so `writeFileSync`, `mkdirSync` or `renameSync`
   * — the forms the plugin's scripts naturally reach for — passed unseen (T106 audit).
   * `cp` and `link` count only as `cpSync`/`linkSync`: bare, they are ordinary helper names
   * (Zed's `docs.ts` has a `link()`).
   */
  /**
   * The plugin's writers (P3, amended for T109–T117). Each is its own directory, imported by
   * one entry, and each is shape-pinned below:
   *   - `session/` — once-per-session markers under `os.tmpdir()` (T108);
   *   - `settings-writer/` — the settings pass's `--apply` (T109, D2): the two
   *     `settings.json` files, the user's `CLAUDE.md` with a `.rulegate.bak` first, and a
   *     new canonical task rule.
   * T114's `migrate/` is the planned third; it extends this list, its length pin, and the
   * per-bundle map below.
   */
  const PLUGIN_MARKER = 'plugins/rulegate/src/session/marker.ts';
  const PLUGIN_SETTINGS_WRITER = 'plugins/rulegate/src/settings-writer/apply.ts';
  const PLUGIN_WRITERS: readonly string[] = Object.freeze([PLUGIN_MARKER, PLUGIN_SETTINGS_WRITER]);

  const WRITE_PRIMITIVE =
    /\b(?:writeFile|appendFile|copyFile|unlink|rm|rmdir|mkdir|rename|symlink|truncate|chmod|utimes)(?:Sync)?\(|\b(?:cp|link)Sync\(|\bcreateWriteStream\(|\bdeleteFile\(/;

  it('keeps every filesystem write inside the core io and apply layers', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const rel = relPosix(file);
      if (!WRITE_PRIMITIVE.test(await readFile(file, 'utf8'))) {
        continue;
      }
      const allowed =
        rel.startsWith('packages/core/src/io/') ||
        rel === 'packages/core/src/pipeline/apply.ts' ||
        rel === 'packages/core/src/fs/types.ts' ||
        PLUGIN_WRITERS.includes(rel);
      if (!allowed) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    expect(PLUGIN_WRITERS).toHaveLength(2);
  });

  /**
   * Every write call each bundle may carry, by bundle. A bundle absent here may carry none.
   * The audit and state scripts run on every `/rulegate:init` and the hooks on every
   * session, so a writer reaching one of them through a shared import is the failure this
   * map exists to catch — the source scan above cannot, since the call still sits in an
   * allowlisted file. T114 adds `migrate-memory.js`.
   */
  const BUNDLE_WRITES: Readonly<Record<string, readonly string[]>> = Object.freeze({
    'pre-edit.js': ['mkdirSync(', 'writeFileSync('],
    'settings.js': [
      'copyFileSync(',
      'mkdirSync(',
      'mkdirSync(',
      'renameSync(',
      'rmSync(',
      'writeFileSync(',
      'writeFileSync(',
    ],
  });

  it("keeps every write in the plugin's bundles to the writer each one ships", async () => {
    // The source scan above cannot see this: core is bundled from source (P2), so what
    // keeps `NodeFileSystem` and `applyPlan` out of `dist/` is esbuild dropping unused code.
    // A hook that one day imports a core symbol dragging a writer along stays green in every
    // source scan — `core/src/io/` is allowlisted — and ships the writer. The bundle says.
    const bundles = await bundleFiles();
    expect(bundles.length).toBeGreaterThan(0);
    for (const file of bundles) {
      const text = await readFile(file, 'utf8');
      const calls = [...text.matchAll(new RegExp(WRITE_PRIMITIVE.source, 'g'))].map((m) => m[0]);
      const name = path.basename(file);
      expect({ bundle: name, calls: calls.sort() }).toEqual({
        bundle: name,
        calls: [...(BUNDLE_WRITES[name] ?? [])],
      });
    }
  });

  it("confines the plugin's one writer to empty marker files in the OS temp directory", async () => {
    // Decision P3: the PreToolUse reminder's once-per-session memory. It is allowed above
    // only because of what this pins — a temp-directory base, exclusive creation that
    // neither overwrites nor follows a planted link, and nothing written but ''.
    const text = await readFile(path.join(repoRoot, PLUGIN_MARKER), 'utf8');
    expect(text).toMatch(/join\(tmpdir\(\), MARKER_DIR\)/);
    expect(text).toMatch(/writeFileSync\(join\(base, [^\n]*\), '', \{ flag: 'wx' \}\)/);
    expect(text.match(/writeFileSync\(/g)).toHaveLength(1);
  });

  it('confines the settings writer to its planned targets, backups first, never overwriting a rule', async () => {
    // T109 (D2). It is allowed above only because of what this pins. Every target comes
    // from the planner's paths or a fixed join under the root or the Claude dir it is given
    // — never `homedir()` or the environment, which is the entry's job and what the tests
    // point into a sandbox. The user-scope backup is the literal `.rulegate.bak`, copied
    // exclusively so the first original is the one kept. Both creations are `wx`: the
    // canonical rule, so a rule file the user wrote is never replaced, and the temp
    // sibling, so a planted link is never followed.
    const text = await readFile(path.join(repoRoot, PLUGIN_SETTINGS_WRITER), 'utf8');
    expect(text).toMatch(/export const BACKUP_SUFFIX = '\.rulegate\.bak';/);
    expect(text).toMatch(
      /copyFileSync\(file, `\$\{file\}\$\{BACKUP_SUFFIX\}`, constants\.COPYFILE_EXCL\)/,
    );
    expect(text.match(/copyFileSync\(/g)).toHaveLength(1);
    expect(text.match(/writeFileSync\(/g)).toHaveLength(2);
    expect(text).toMatch(/writeFileSync\(tmp, next, \{ flag: 'wx', mode \}\)/);
    // The replaced file keeps its mode: a rename carries the sibling's, and a 0600
    // `settings.json` holding a token must not come out world-readable.
    expect(text).toMatch(/const mode = exists\(file\) \? lstatSync\(file\)\.mode & 0o777 : 0o666;/);
    expect(text).toMatch(/writeFileSync\(ruleFile, r\.next, \{ flag: 'wx' \}\)/);
    expect(text.match(/renameSync\(/g)).toHaveLength(1);
    expect(text).toMatch(/renameSync\(tmp, file\)/);
    // The temp sibling is removed only when this call created it: a `wx` that failed on
    // something already at the name must not delete what it found.
    expect(text).toMatch(/if \(created\) rmSync\(tmp, \{ force: true \}\);/);
    expect(text.match(/rmSync\(/g)).toHaveLength(1);
    expect(text).toMatch(/const settingsFile = settingsPath\(scope, root, claudeDir\);/);
    expect(text).toMatch(/const ruleFile = ruleTarget\(scope, root, claudeDir\);/);
    // No path of its own: every target is the planner's.
    expect(text).not.toMatch(/\bjoin\(/);
    // The rule's three possible homes, and nothing else.
    const planner = await readFile(
      path.join(repoRoot, 'plugins/rulegate/src/lib/settings.ts'),
      'utf8',
    );
    const target = /export function ruleTarget\([^]*?\n\}/.exec(planner)?.[0] ?? '';
    expect(
      [...target.matchAll(/join\((root|claudeDir), ([^)]*)\)/g)].map((m) => m[0]).sort(),
    ).toEqual(
      [
        "join(claudeDir, 'CLAUDE.md')",
        'join(root, TASK_RULE_FILE)',
        "join(root, 'CLAUDE.md')",
      ].sort(),
    );
    expect(text).not.toMatch(/homedir|process\.env|tmpdir/);
  });

  /**
   * `check` and `lint` are read-only by construction: each holds a filesystem with no
   * write methods and never calls the one function that writes. The runtime test for
   * that is inert on a clean repository — `applyPlan` writes nothing there either — so
   * this pins the absence of the call site itself.
   *
   * A list rather than one path, because the next read-only command would otherwise
   * ship unpinned and nothing would say so. `doctor` is deliberately absent: it
   * constructs a `NodeFileSystem` (T027), which is a real gap rather than an oversight
   * and is left stated here instead of silently widening the rule to fit it.
   */
  const READ_ONLY_COMMANDS = ['check.ts', 'lint.ts'];

  it.each(READ_ONLY_COMMANDS)(
    'keeps applyPlan and any writable filesystem out of %s',
    async (file) => {
      const text = await readFile(path.join(repoRoot, 'packages/cli/src/commands', file), 'utf8');
      expect(text).not.toMatch(/applyPlan/);
      // `createReadOnlyFileSystem` returns an object with no writers on it; a
      // `NodeFileSystem` typed as read-only is one cast away from a write.
      expect(text).not.toMatch(/new NodeFileSystem\(/);
      expect(text).toMatch(/createReadOnlyFileSystem\(/);
    },
  );

  /**
   * `--staged` gave `check` a second filesystem, so the guarantee above needs a second
   * proof. A textual scan cannot make it: `StagedFileSystem` is a class `check` legitimately
   * constructs, and the risk is not the call site but the class quietly gaining a writer.
   * Asked of the object itself instead — there is nothing to cast to if the methods are not
   * there, which is the same argument that shaped `createReadOnlyFileSystem` at T016.
   */
  it('gives the staged filesystem no write method to reach', () => {
    const fs: object = new StagedFileSystem(repoRoot);
    for (const method of ['writeFile', 'copyFile', 'deleteFile', 'mkdir', 'rm']) {
      expect(method in fs, `StagedFileSystem must not expose ${method}`).toBe(false);
    }
    // The paired control: a method it *does* have, so the loop is not passing on a typo.
    expect('readFile' in fs).toBe(true);
  });

  /**
   * picocolors' module default force-enables colour under `CI` and on win32, so the only
   * colours anything may use are the ones `createOutput` derives from the real TTY state.
   * A second import site is a second chance to write escapes into a CI log.
   */
  it('imports picocolors in exactly one place', async () => {
    const importers: string[] = [];
    for (const file of await sourceFiles()) {
      if (/from\s+['"]picocolors['"]/.test(await readFile(file, 'utf8'))) {
        importers.push(relPosix(file));
      }
    }
    expect(importers).toEqual(['packages/cli/src/ui/report.ts']);
  });

  it('keeps rendering out of the CLI', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const rel = relPosix(file);
      if (!rel.startsWith('packages/cli/src/')) continue;
      const text = await readFile(file, 'utf8');
      // The one file that names the renderers without calling them: `adapter new`
      // *emits* an adapter's source (T028), so they appear inside template literals.
      // The guarantee is kept by a stronger check — it cannot call what it never
      // imports, and its only import from core is a type.
      if (rel === 'packages/cli/src/commands/adapter/templates.ts') {
        const coreImports = [
          ...text.matchAll(/^import (type )?\{[^}]*\} from '@rulegate\/core'/gm),
        ];
        expect(coreImports.length, rel).toBeGreaterThan(0);
        for (const match of coreImports) expect(match[1], rel).toBe('type ');
        continue;
      }
      // The CLI parses flags, calls the pipeline, and prints. It never builds output.
      if (/renderConcatenated|renderRuleSection|finalizeArtifact|withHtmlMarker/.test(text)) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  /**
   * The detection engine reaches the user's home directory, which is the one place in
   * this codebase where "reads only" stops being enforced by `ReadOnlyFileSystem` alone
   * and starts depending on *which root* the filesystem was built with. The engine takes
   * both filesystems as parameters and constructs neither, so the choice of root is the
   * caller's and the engine stays testable against `MemoryFileSystem`.
   *
   * If it ever imports `io/` or `node:os` directly, that seam is gone and the guarantee
   * becomes a convention. Lint enforces the `node:fs` half; this covers the rest.
   */
  it('keeps the detection engine off the io layer and the host OS', async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const rel = relPosix(file);
      if (!rel.startsWith('packages/core/src/detect/')) continue;
      const text = await readFile(file, 'utf8');
      if (/from\s+['"]\.\.\/io\/|from\s+['"]node:(os|fs)/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("exposes verifyPlan alongside applyPlan, so `check` shares sync's plan", async () => {
    const pipeline = path.join(repoRoot, 'packages/core/src/pipeline');
    const files = (await readdir(pipeline)).sort();
    expect(files).toEqual(['apply.ts', 'plan.ts', 'verify.ts']);
  });
});

describe('the adapter contract boundary', () => {
  /**
   * T011 froze `@rulegate/adapter-kit` as the contract external contributors write
   * against, and the proof that the contract is sufficient is that our own two adapters
   * need nothing else. `eslint.config.js` bans the core import too; this exists because
   * an inline `eslint-disable` defeats a lint rule and nothing defeats a file scan.
   */
  it('keeps adapters off @rulegate/core entirely', async () => {
    const offenders: string[] = [];
    for (const file of await adapterFiles()) {
      const rel = relPosix(file);
      if (/from\s+['"]@rulegate\/core/.test(await readFile(file, 'utf8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('declares only the kit as an adapter dependency', async () => {
    for (const dir of await adapterDirs()) {
      const json = JSON.parse(
        await readFile(path.join(repoRoot, dir, 'package.json'), 'utf8'),
      ) as PackageJson;
      expect(Object.keys(json.dependencies ?? {}).sort(), dir).toEqual(['@rulegate/adapter-kit']);
    }
  });

  it('leaves no type escape behind in the migrated adapters', async () => {
    // T011's stated validation is that the adapters compile against the extracted types
    // "with no local type escapes" — asserted rather than eyeballed.
    const offenders: string[] = [];
    for (const file of await adapterFiles()) {
      const text = await readFile(file, 'utf8');
      if (/\bas any\b|as unknown as|@ts-expect-error|@ts-ignore/.test(text)) {
        offenders.push(relPosix(file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

async function adapterFiles(): Promise<string[]> {
  const dirs = await adapterDirs();
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        await walk(child);
        continue;
      }
      if (entry.name.endsWith('.ts')) out.push(child);
    }
  };
  // Adapter tests are included on purpose: a test is where the next author copies their
  // import block from, so the boundary has to hold there too.
  await Promise.all(dirs.map((d) => walk(path.join(repoRoot, d))));
  return out.sort();
}

/**
 * Two hand-maintained copies of one package -> source map: `tsconfig.workspace.json` for the
 * linter and `vitest.config.ts` for the runner. Both exist because `pnpm verify` runs
 * `lint` and `test` *before* `build`, so neither may resolve a workspace package through
 * its `exports` map into a `dist/` that a clean clone does not have.
 *
 * They drifted. The CLI is the one package whose name is unscoped — `rulegate`, not
 * `@rulegate/cli` — and it was registered in the runner and missed in the linter, so
 * `action/`'s imports fell back to an absent `dist/index.d.ts` and every symbol behind
 * them, down to `Hunk.oldStart`, linted as `any`. Green on a machine with a built `dist/`,
 * fifty-four errors on CI. Two copies of a list stay equal because something checks, so
 * this pins both to the workspace itself rather than to each other alone.
 */
describe('workspace source maps', () => {
  // `action` is private and nothing imports it, so it needs no entry in either map.
  // The same holds for the plugin: Claude Code runs its bundle, nothing imports it.
  const UNIMPORTED = new Set(['@rulegate/action', '@rulegate/claude-code-plugin']);

  /** `@rulegate/adapter-kit/testing` is a subpath of `@rulegate/adapter-kit`. */
  function basePackage(key: string): string {
    const segments = key.split('/');
    return key.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? key);
  }

  async function workspacePaths(): Promise<Record<string, string[]>> {
    const text = await readFile(path.join(repoRoot, 'tsconfig.workspace.json'), 'utf8');
    // The file is JSONC. Its comments are all whole-line, which is the only form this
    // strips; a trailing one would make `JSON.parse` throw here rather than pass quietly.
    const parsed = JSON.parse(text.replace(/^\s*\/\/.*$/gm, '')) as {
      compilerOptions?: { paths?: Record<string, string[]> };
    };
    const paths = parsed.compilerOptions?.paths;
    if (paths === undefined)
      throw new Error('tsconfig.workspace.json has no compilerOptions.paths');
    return paths;
  }

  async function expectedNames(): Promise<string[]> {
    return (await packageManifests())
      .map(({ name }) => name)
      .filter((name) => !UNIMPORTED.has(name))
      .sort();
  }

  it('covers every workspace package in the workspace path map', async () => {
    const mapped = [...new Set(Object.keys(await workspacePaths()).map(basePackage))].sort();
    expect(mapped).toEqual(await expectedNames());
  });

  it("covers every workspace package in vitest's alias map", async () => {
    const alias = vitestConfig.resolve?.alias;
    if (alias === undefined || Array.isArray(alias)) {
      throw new Error('vitest.config.ts resolve.alias must be a record of package names');
    }
    const mapped = [...new Set(Object.keys(alias).map(basePackage))].sort();
    expect(mapped).toEqual(await expectedNames());
  });

  it('points every workspace path entry at a file that exists', async () => {
    const missing: string[] = [];
    for (const [key, targets] of Object.entries(await workspacePaths())) {
      for (const target of targets) {
        // A map entry left behind by a rename resolves to nothing, which reads exactly
        // like the bug above: the linter silently falls back to the `exports` map.
        const exists = await stat(path.join(repoRoot, target)).then(
          () => true,
          () => false,
        );
        if (!exists) missing.push(`${key} -> ${target}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
