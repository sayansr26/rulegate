import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GIT_DENY, TODO_ENV } from '@rulegate/claude';
import { runInit } from '../src/commands/init.js';
import { runClaudeSettings } from '../src/commands/claude.js';
import { ensurePlugin } from '../src/claude/index.js';
import { ExitCode } from '../src/ui/exit.js';
import { readVersion } from '../src/version.js';
import { buildProgram } from '../src/program.js';

/**
 * T107: `init`'s Claude Code section and `rulegate claude settings`. Hermetic by
 * construction — `HOME` and `CLAUDE_CONFIG_DIR` point into a sandbox, and `PATH` holds only
 * the sandbox's `bin/`, where a stub `claude` (a Node script keeping its state in a JSON
 * file) may or may not be placed. The real binary and the real `~/.claude` are unreachable.
 */

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const VERSION = readVersion();

let repo: string;
let sandbox: string;
let claudeDir: string;
let bin: string;
let output: string[];

beforeEach(async () => {
  repo = await realpath(await mkdtemp(path.join(tmpdir(), 'rulegate-claude-')));
  sandbox = await realpath(await mkdtemp(path.join(tmpdir(), 'rulegate-claude-home-')));
  claudeDir = path.join(sandbox, '.claude');
  bin = path.join(sandbox, 'bin');
  await mkdir(bin);
  vi.stubEnv('HOME', sandbox);
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir);
  vi.stubEnv('PATH', bin);
  output = [];
  const capture = (chunk: string | Uint8Array): boolean => {
    output.push(String(chunk));
    return true;
  };
  vi.spyOn(process.stdout, 'write').mockImplementation(capture);
  vi.spyOn(process.stderr, 'write').mockImplementation(capture);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(repo, { recursive: true, force: true });
  await rm(sandbox, { recursive: true, force: true });
});

const printed = (): string => output.join('');

async function tree(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await tree(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

interface StubState {
  installed: { scope: string; version: string; enabled: boolean } | null;
  markets: string[];
  /** What `install` / `update` bring the plugin to. */
  serves: string;
  /** A subcommand word sequence that exits 1; `''` fails every command, `--version` too. */
  fail?: string;
  /** `plugin list --json` prints this instead of its array. */
  listOutput?: string;
  /**
   * Model Claude Code's `enabledPlugins` precedence: `enable --scope X` writes X's settings
   * file, and `plugin list` reports the most local file's value over the install's own.
   */
  precedence?: boolean;
  /** `plugin enable` exits 0 and changes nothing. */
  enableNoop?: boolean;
  /** A subcommand word sequence that hangs instead of answering. */
  hang?: string;
}

/**
 * A `claude` that answers the allowlisted commands from `state.json` and logs every argv,
 * with its cwd, to `calls.jsonl`. The shebang is this Node's absolute path: `PATH` holds
 * nothing else, so `/usr/bin/env node` would not resolve.
 */
async function stubClaude(state: StubState): Promise<void> {
  const dir = path.join(sandbox, 'stub');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'state.json'), JSON.stringify(state));
  const script = `#!${process.execPath}
const fs = require('node:fs');
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const st = JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8'));
const save = () => fs.writeFileSync(dir + '/state.json', JSON.stringify(st));
const cmd = args.filter((a) => !a.startsWith('-')).join(' ');
if (typeof st.fail === 'string' && cmd.startsWith(st.fail)) { process.stderr.write('boom: ' + cmd + '\\n'); process.exit(1); }
if (typeof st.hang === 'string' && cmd.startsWith(st.hang)) { setTimeout(() => {}, 60000); return; }
if (args[0] === '--version') { console.log('2.1.300 (Claude Code)'); process.exit(0); }
const settingsFile = (scope) => scope === 'user'
  ? process.env.CLAUDE_CONFIG_DIR + '/settings.json'
  : process.cwd() + (scope === 'local' ? '/.claude/settings.local.json' : '/.claude/settings.json');
const readSettings = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const enableIn = (scope) => {
  const f = settingsFile(scope);
  const s = readSettings(f);
  s.enabledPlugins = { ...s.enabledPlugins, 'rulegate@rulegate': true };
  fs.mkdirSync(require('node:path').dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\\n');
};
const effective = (i) => {
  if (!st.precedence) return i.enabled;
  for (const scope of ['local', 'project', 'user']) {
    const v = (readSettings(settingsFile(scope)).enabledPlugins || {})['rulegate@rulegate'];
    if (typeof v === 'boolean') return v;
  }
  return i.enabled;
};
if (cmd === 'plugin list' && st.listOutput !== undefined) console.log(st.listOutput);
else if (cmd === 'plugin list') {
  const i = st.installed;
  console.log(JSON.stringify(i ? [{ id: 'rulegate@rulegate', scope: i.scope, version: i.version, enabled: effective(i), projectPath: process.cwd() }] : []));
} else if (cmd === 'plugin marketplace list') {
  console.log(JSON.stringify(st.markets.map((name) => ({ name, source: 'github' }))));
} else if (cmd.startsWith('plugin marketplace add')) { st.markets.push('rulegate'); save(); }
else if (cmd.startsWith('plugin marketplace update')) {}
else if (cmd.startsWith('plugin install')) {
  st.installed = { scope: 'project', version: st.serves, enabled: true }; save();
  if (st.precedence) enableIn('project');
}
else if (cmd.startsWith('plugin enable') && st.enableNoop) {}
else if (cmd.startsWith('plugin enable') && st.precedence) enableIn(args[args.indexOf('--scope') + 1]);
else if (cmd.startsWith('plugin enable')) { st.installed.enabled = true; save(); }
else if (cmd.startsWith('plugin update')) { st.installed.version = st.serves; save(); }
else { process.stderr.write('unknown ' + cmd + '\\n'); process.exit(3); }
`;
  const file = path.join(bin, 'claude');
  // CommonJS: the stub has no extension, and no package.json above it says otherwise.
  await writeFile(file, script);
  await chmod(file, 0o755);
}

async function calls(): Promise<{ args: string[]; cwd: string }[]> {
  const file = path.join(sandbox, 'stub', 'calls.jsonl');
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { args: string[]; cwd: string });
}

const argv = async (): Promise<string[]> => (await calls()).map((c) => c.args.join(' '));

/** A repository Claude Code is configured in, which `init` detects as claude-code. */
const seedClaude = () =>
  cp(path.join(fixtures, 'claude-code-import/input'), repo, { recursive: true });

/** The read-only commands every run starts with, before any step. */
const PROBES = ['--version', 'plugin list --json', 'plugin marketplace list --json'];

// The stub is a shebang script; Windows runs neither it nor, without a shell, `claude.cmd`.
const posix = it.skipIf(process.platform === 'win32');

describe('rulegate init — Claude Code section (T107)', () => {
  posix('prints the setup state and the plugin commands, and runs nothing', async () => {
    await seedClaude();
    await stubClaude({ installed: null, markets: [], serves: VERSION });
    expect(await runInit({ cwd: repo })).toBe(ExitCode.Ok);
    const text = printed();
    expect(text).toContain('Claude Code\n  SETUP  FRESH');
    expect(text).toContain('plugin  rulegate@rulegate  not installed');
    expect(text).toContain(
      '    claude plugin marketplace add sayansr26/rulegate --scope project\n',
    );
    expect(text).toContain('    claude plugin install rulegate@rulegate --scope project\n');
    expect(text).toContain('rulegate init --plugin --yes');
    // Plain init is offline: the stub was never invoked, even with it on PATH.
    expect(await calls()).toEqual([]);
  });

  posix('`--yes` alone applies the rules and still only prints the plugin commands', async () => {
    await seedClaude();
    await stubClaude({ installed: null, markets: [], serves: VERSION });
    expect(await runInit({ cwd: repo, yes: true })).toBe(ExitCode.Ok);
    expect(existsSync(path.join(repo, '.rulegate'))).toBe(true);
    expect(printed()).toContain('claude plugin install rulegate@rulegate --scope project');
    expect(await calls()).toEqual([]);
  });

  it('REPAIR names each item to fix, and points settings items at `rulegate claude settings`', async () => {
    await seedClaude();
    // The plugin's own config marks the project as set up, so what is missing is a repair.
    await writeFile(path.join(repo, '.claude/rulegate.json'), '{}\n');
    expect(await runInit({ cwd: repo })).toBe(ExitCode.Ok);
    const text = printed();
    expect(text).toMatch(/SETUP {2}REPAIR {2}— \d+ item\(s\) to fix/);
    expect(text).toContain(
      '    MISSING  .claude/settings.json task tools  → /rulegate:init settings',
    );
    expect(text).toContain(
      '    MISSING  Claude Code plugin installed  → /plugin install rulegate@rulegate',
    );
    expect(text).toContain('`rulegate claude settings` previews the fix');
  });

  it('`--no-plugin` hides the section', async () => {
    await seedClaude();
    expect(await runInit({ cwd: repo, plugin: false })).toBe(ExitCode.Ok);
    expect(printed()).not.toContain('Claude Code');
  });

  it('is not shown when claude-code is not among the tools', async () => {
    await cp(path.join(fixtures, 'cursor-import/input'), repo, { recursive: true });
    expect(await runInit({ cwd: repo })).toBe(ExitCode.Ok);
    expect(printed()).not.toContain('Claude Code');
  });

  posix('`--plugin` without `--yes` prints the commands and runs nothing', async () => {
    await seedClaude();
    await stubClaude({ installed: null, markets: [], serves: VERSION });
    expect(await runInit({ cwd: repo, plugin: true })).toBe(ExitCode.Ok);
    expect(printed()).toContain('nothing was run. re-run with --yes');
    expect(await calls()).toEqual([]);
  });

  posix(
    'not installed → adds the marketplace and installs, at project scope, in the repo',
    async () => {
      await seedClaude();
      await stubClaude({ installed: null, markets: [], serves: VERSION });
      expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Ok);
      expect(await argv()).toEqual([
        '--version',
        'plugin list --json',
        'plugin marketplace list --json',
        'plugin marketplace add sayansr26/rulegate --scope project',
        'plugin install rulegate@rulegate --scope project',
        'plugin list --json',
      ]);
      // Every command ran with the repository as its cwd, so project scope is this repo.
      for (const c of await calls()) expect(c.cwd).toBe(repo);
      expect(printed()).toContain(`plugin  installed ${VERSION} at project scope`);
    },
  );

  posix('disabled → refreshes the marketplace, enables and updates at its scope', async () => {
    await seedClaude();
    await stubClaude({
      installed: { scope: 'local', version: '0.2.0', enabled: false },
      markets: ['rulegate'],
      serves: VERSION,
    });
    expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Ok);
    expect(await argv()).toEqual([
      '--version',
      'plugin list --json',
      'plugin marketplace list --json',
      'plugin marketplace update rulegate',
      'plugin enable rulegate@rulegate --scope local',
      'plugin update rulegate@rulegate --scope local',
      'plugin list --json',
    ]);
    expect(printed()).toContain(`plugin  updated 0.2.0 → ${VERSION}`);
  });

  posix('old → refreshes the marketplace and updates, reporting from → to', async () => {
    await seedClaude();
    await stubClaude({
      installed: { scope: 'project', version: '0.1.0', enabled: true },
      markets: ['rulegate'],
      serves: VERSION,
    });
    expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Ok);
    expect(await argv()).toContain('plugin update rulegate@rulegate --scope project');
    expect(await argv()).not.toContain('plugin install rulegate@rulegate --scope project');
    expect(printed()).toContain(`plugin  updated 0.1.0 → ${VERSION}`);
  });

  posix('says when the marketplace serves an older plugin than this CLI', async () => {
    await seedClaude();
    await stubClaude({
      installed: { scope: 'project', version: '0.0.1', enabled: true },
      markets: ['rulegate'],
      serves: '0.0.2',
    });
    expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Ok);
    expect(printed()).toContain(`the marketplace still serves 0.0.2; this rulegate is ${VERSION}.`);
  });

  it('missing CLI → prints what to run inside Claude Code, exit 0', async () => {
    await seedClaude();
    expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Ok);
    const text = printed();
    expect(text).toContain('the `claude` CLI is not on PATH');
    expect(text).toContain('/plugin marketplace add sayansr26/rulegate');
    expect(text).toContain('/plugin install rulegate@rulegate');
    // The rules were still applied: they must not depend on Claude Code's CLI.
    expect(existsSync(path.join(repo, '.rulegate/rulegate.yaml'))).toBe(true);
  });

  posix('a failing command exits 1 and names it, after the rules were written', async () => {
    await seedClaude();
    await stubClaude({ installed: null, markets: [], serves: VERSION, fail: 'plugin install' });
    expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Failure);
    const text = printed();
    expect(text).toContain('`claude plugin install rulegate@rulegate --scope project` failed:');
    expect(text).toContain('boom: plugin install');
    expect(existsSync(path.join(repo, '.rulegate/rulegate.yaml'))).toBe(true);
  });

  posix(
    'on an adopted repository it writes nothing, and runs the plugin only when asked',
    async () => {
      await seedClaude();
      expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);
      await stubClaude({ installed: null, markets: [], serves: VERSION });
      const before = await tree(repo);

      output = [];
      expect(await runInit({ cwd: repo, yes: true })).toBe(ExitCode.Ok);
      expect(printed()).toContain('.rulegate/ already exists; nothing to import.');
      expect(printed()).toContain('Claude Code\n');
      expect(await calls()).toEqual([]);
      expect(await tree(repo)).toEqual(before);

      expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Ok);
      expect(await argv()).toContain('plugin install rulegate@rulegate --scope project');
      // The stub writes nothing into the repository; init itself wrote nothing either.
      expect(await tree(repo)).toEqual(before);
    },
  );

  posix(
    'refuses the plugin step when .claude/settings.json is not safe to have rewritten',
    async () => {
      await seedClaude();
      await mkdir(path.join(repo, '.claude'), { recursive: true });
      await writeFile(path.join(repo, '.claude/settings.json'), Buffer.from([0xff, 0xfe, 0x7b]));
      await stubClaude({ installed: null, markets: [], serves: VERSION });
      expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Failure);
      expect(printed()).toContain('plugin  nothing run: .claude/settings.json — not UTF-8');
      // Only the read-only probes ran: which file the steps write depends on their answer.
      expect(await argv()).toEqual(PROBES);
    },
  );

  posix(
    'checks the settings file of the scope the steps write, not always the project',
    async () => {
      await seedClaude();
      // A dotfiles-managed user settings file, and a disabled user-scope install: `enable
      // --scope user` would have Claude Code rewrite the file the settings writer refuses.
      await mkdir(claudeDir, { recursive: true });
      await writeFile(path.join(sandbox, 'dotfiles.json'), '{}\n');
      await symlink(path.join(sandbox, 'dotfiles.json'), path.join(claudeDir, 'settings.json'));
      await stubClaude({
        installed: { scope: 'user', version: '0.1.0', enabled: false },
        markets: ['rulegate'],
        serves: VERSION,
      });
      expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Failure);
      expect(printed()).toContain(`${path.join(claudeDir, 'settings.json')} — a symlink`);
      expect(await argv()).toEqual(PROBES);
    },
  );

  posix('an unrelated project settings file does not block a user-scope update', async () => {
    await seedClaude();
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    await writeFile(path.join(sandbox, 'elsewhere.json'), '{}\n');
    await symlink(path.join(sandbox, 'elsewhere.json'), path.join(repo, '.claude/settings.json'));
    await stubClaude({
      installed: { scope: 'user', version: '0.1.0', enabled: true },
      markets: ['rulegate'],
      serves: VERSION,
    });
    expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Ok);
    expect(await argv()).toContain('plugin update rulegate@rulegate --scope user');
  });

  posix('a known marketplace prints the `update` the run would, not an `add`', async () => {
    await seedClaude();
    await mkdir(path.join(claudeDir, 'plugins'), { recursive: true });
    await writeFile(
      path.join(claudeDir, 'plugins/known_marketplaces.json'),
      JSON.stringify({ rulegate: { source: { source: 'github', repo: 'sayansr26/rulegate' } } }),
    );
    await stubClaude({ installed: null, markets: ['rulegate'], serves: VERSION });
    expect(await runInit({ cwd: repo, plugin: true })).toBe(ExitCode.Ok);
    const shownSteps = printed()
      .split('\n')
      .filter((l) => l.startsWith('    claude plugin '))
      .map((l) => l.trim().replace(/^claude /, ''));
    expect(await calls()).toEqual([]);

    output = [];
    expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Ok);
    const ran = (await argv()).filter((a) => !PROBES.includes(a));
    expect(shownSteps).toEqual(ran);
    expect(ran[0]).toBe('plugin marketplace update rulegate');
  });

  posix('`--plugin --yes` on a repository with no tool config still runs the plugin', async () => {
    await stubClaude({ installed: null, markets: [], serves: VERSION });
    expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Ok);
    expect(printed()).toContain('no AI tool configuration found');
    expect(await argv()).toContain('plugin install rulegate@rulegate --scope project');
    // Plain init there shows nothing and reads nothing of Claude Code's.
    output = [];
    await rm(path.join(sandbox, 'stub/calls.jsonl'));
    expect(await runInit({ cwd: repo })).toBe(ExitCode.Ok);
    expect(printed()).not.toContain('Claude Code');
    expect(await calls()).toEqual([]);
  });

  posix(
    'a `claude` that is present but fails `--version` is a failure, not "not on PATH"',
    async () => {
      await seedClaude();
      await stubClaude({ installed: null, markets: [], serves: VERSION, fail: '' });
      expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Failure);
      const text = printed();
      expect(text).toContain('`claude --version` failed:');
      expect(text).toContain('boom:');
      expect(text).not.toContain('not on PATH');
      expect(await argv()).toEqual(['--version']);
    },
  );

  posix(
    'a user install switched off in the project settings is enabled there, where it is off',
    async () => {
      await seedClaude();
      await mkdir(path.join(repo, '.claude'), { recursive: true });
      const project = path.join(repo, '.claude/settings.json');
      await writeFile(project, JSON.stringify({ enabledPlugins: { 'rulegate@rulegate': false } }));
      await stubClaude({
        installed: { scope: 'user', version: '0.1.0', enabled: true },
        markets: ['rulegate'],
        serves: VERSION,
        precedence: true,
      });
      // Claude Code's own record of the user install, which plain init reads.
      await mkdir(path.join(claudeDir, 'plugins'), { recursive: true });
      await writeFile(
        path.join(claudeDir, 'plugins/installed_plugins.json'),
        JSON.stringify({ plugins: { 'rulegate@rulegate': [{ scope: 'user', version: '0.1.0' }] } }),
      );
      // Plain init prints the same enable the run makes.
      expect(await runInit({ cwd: repo, plugin: true })).toBe(ExitCode.Ok);
      expect(printed()).toContain('    claude plugin enable rulegate@rulegate --scope project\n');

      output = [];
      expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Ok);
      expect(await argv()).toEqual([
        ...PROBES,
        'plugin marketplace update rulegate',
        'plugin enable rulegate@rulegate --scope project',
        'plugin update rulegate@rulegate --scope user',
        'plugin list --json',
      ]);
      expect(JSON.parse(await readFile(project, 'utf8'))).toEqual({
        enabledPlugins: { 'rulegate@rulegate': true },
      });
      expect(printed()).toContain(`plugin  updated 0.1.0 → ${VERSION}`);
    },
  );

  /** `.claude/settings.local.json` switching the plugin off, as a local disable leaves it. */
  const localOff = async () => {
    await mkdir(path.join(repo, '.claude'), { recursive: true });
    const local = path.join(repo, '.claude/settings.local.json');
    await writeFile(local, JSON.stringify({ enabledPlugins: { 'rulegate@rulegate': false } }));
    return local;
  };

  posix('a fresh install under a local `false` is enabled there in the same run', async () => {
    await seedClaude();
    const local = await localOff();
    await stubClaude({ installed: null, markets: [], serves: VERSION, precedence: true });
    expect(await runInit({ cwd: repo, plugin: true })).toBe(ExitCode.Ok);
    expect(printed()).toContain(
      '    claude plugin install rulegate@rulegate --scope project\n' +
        '    claude plugin enable rulegate@rulegate --scope local\n',
    );

    output = [];
    expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Ok);
    expect(await argv()).toEqual([
      ...PROBES,
      'plugin marketplace add sayansr26/rulegate --scope project',
      'plugin install rulegate@rulegate --scope project',
      'plugin enable rulegate@rulegate --scope local',
      'plugin list --json',
    ]);
    expect(JSON.parse(await readFile(local, 'utf8'))).toEqual({
      enabledPlugins: { 'rulegate@rulegate': true },
    });
  });

  posix('a fresh project install under a user `false` never writes user settings', async () => {
    // The install's own project `true` outranks a user `false`; an enable at user scope
    // would instead switch the plugin on in every project on the machine.
    await seedClaude();
    await mkdir(claudeDir, { recursive: true });
    const user = path.join(claudeDir, 'settings.json');
    const off = JSON.stringify({ enabledPlugins: { 'rulegate@rulegate': false } });
    await writeFile(user, off);
    await stubClaude({ installed: null, markets: [], serves: VERSION, precedence: true });
    expect(await runInit({ cwd: repo, plugin: true })).toBe(ExitCode.Ok);
    expect(printed()).not.toContain('plugin enable');

    output = [];
    expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Ok);
    expect(await argv()).toEqual([
      ...PROBES,
      'plugin marketplace add sayansr26/rulegate --scope project',
      'plugin install rulegate@rulegate --scope project',
      'plugin list --json',
    ]);
    expect(await readFile(user, 'utf8')).toBe(off);
  });

  posix('a plugin left off names the settings file that decides, not the install', async () => {
    await seedClaude();
    await localOff();
    await stubClaude({
      installed: null,
      markets: [],
      serves: VERSION,
      precedence: true,
      enableNoop: true,
    });
    expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Failure);
    const text = printed();
    expect(text).toContain('rulegate@rulegate is still disabled at local scope');
    expect(text).toContain(
      'its local-scope settings file sets enabledPlugins["rulegate@rulegate"]',
    );
    // Repeating the install cannot clear a local `false`, so it is not what the hint offers.
    expect(text).not.toContain('/plugin install');
  });

  posix('an enable that exits 0 and leaves the plugin off is a failure', async () => {
    await seedClaude();
    await stubClaude({
      installed: { scope: 'user', version: '0.1.0', enabled: false },
      markets: ['rulegate'],
      serves: VERSION,
      enableNoop: true,
    });
    expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Failure);
    expect(printed()).toContain('rulegate@rulegate is still disabled at user scope');
    expect(printed()).not.toContain('plugin  updated');
  });

  posix('a `claude` call that times out says so', async () => {
    await stubClaude({
      installed: null,
      markets: [],
      serves: VERSION,
      hang: 'plugin marketplace add',
    });
    const r = await ensurePlugin({ root: repo, timeout: 500 });
    expect(r.reason).toBe('failed');
    expect(r.hint).toContain(
      '`claude plugin marketplace add sayansr26/rulegate --scope project` failed:',
    );
    expect(r.hint).toContain('  timed out after 0.5s and was stopped');
  });

  describe('a list it cannot read is a failure, never "nothing installed"', () => {
    posix.each([
      ['exits 1', { fail: 'plugin list' }, 'failed:'],
      [
        'prints a wrapper object',
        { listOutput: '{"plugins":[]}' },
        'printed output this rulegate does not recognise',
      ],
      [
        'prints something else',
        { listOutput: 'not json' },
        'printed output this rulegate does not recognise',
      ],
      [
        'renames the id field',
        { listOutput: '[{"pluginId":"rulegate@rulegate","scope":"user"}]' },
        'printed output this rulegate does not recognise',
      ],
    ])('`plugin list --json` %s', async (_, extra, message) => {
      await seedClaude();
      await stubClaude({ installed: null, markets: ['rulegate'], serves: VERSION, ...extra });
      expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Failure);
      expect(printed()).toContain(`\`claude plugin list --json\` ${message}`);
      expect(await argv()).toEqual(['--version', 'plugin list --json']);
    });

    posix('`plugin marketplace list --json` exits 1 (an older claude without --json)', async () => {
      await seedClaude();
      await stubClaude({
        installed: { scope: 'user', version: '0.1.0', enabled: true },
        markets: ['rulegate'],
        serves: VERSION,
        fail: 'plugin marketplace list',
      });
      expect(await runInit({ cwd: repo, yes: true, plugin: true })).toBe(ExitCode.Failure);
      expect(printed()).toContain('`claude plugin marketplace list --json` failed:');
      expect(await argv()).toEqual(PROBES);
    });
  });
});

describe('rulegate claude settings (T107, D2)', () => {
  const projectSettings = () => path.join(repo, '.claude/settings.json');
  const userSettings = () => path.join(claudeDir, 'settings.json');

  it('previews by default and writes nothing', async () => {
    await writeFile(path.join(repo, 'CLAUDE.md'), '# Project\n');
    expect(await runClaudeSettings({ cwd: repo })).toBe(ExitCode.Ok);
    expect(printed()).toContain('preview — nothing written');
    expect(printed()).toContain(`would add ${String(GIT_DENY.length)} git write rule(s)`);
    expect(await tree(repo)).toEqual(['CLAUDE.md']);
    expect(existsSync(claudeDir)).toBe(false);
  });

  it('--apply needs a named scope, and a scope it knows (exit 2)', async () => {
    expect(await runClaudeSettings({ cwd: repo, apply: true })).toBe(ExitCode.Usage);
    expect(await runClaudeSettings({ cwd: repo, scope: 'global' })).toBe(ExitCode.Usage);
    expect(existsSync(path.join(repo, '.claude'))).toBe(false);
  });

  it('applies at project scope, backing up the file it replaces, and is idempotent', async () => {
    await mkdir(path.join(repo, '.claude'));
    const original = `${JSON.stringify({ permissions: { allow: ['Bash(ls *)'] } }, null, 2)}\n`;
    await writeFile(projectSettings(), original);
    expect(await runClaudeSettings({ cwd: repo, scope: 'project', apply: true })).toBe(ExitCode.Ok);
    const next = JSON.parse(await readFile(projectSettings(), 'utf8')) as {
      permissions: { allow: string[]; deny: string[] };
      env: Record<string, string>;
    };
    expect(next.permissions.allow).toEqual(['Bash(ls *)']);
    expect(next.permissions.deny).toEqual([...GIT_DENY]);
    expect(next.env[TODO_ENV]).toBe('1');
    expect(await readFile(`${projectSettings()}.rulegate.bak`, 'utf8')).toBe(original);
    // Nothing at user scope: only the scope named is written.
    expect(existsSync(claudeDir)).toBe(false);

    const after = await readFile(projectSettings(), 'utf8');
    output = [];
    expect(await runClaudeSettings({ cwd: repo, scope: 'project', apply: true })).toBe(ExitCode.Ok);
    expect(await readFile(projectSettings(), 'utf8')).toBe(after);
    expect(await readFile(`${projectSettings()}.rulegate.bak`, 'utf8')).toBe(original);
    expect(printed()).toContain('git write protection already complete');
  });

  it('applies at user scope inside CLAUDE_CONFIG_DIR, never the real home', async () => {
    await mkdir(claudeDir, { recursive: true });
    await writeFile(userSettings(), '{"model":"opus"}\n');
    expect(await runClaudeSettings({ cwd: repo, scope: 'user', apply: true })).toBe(ExitCode.Ok);
    const next = JSON.parse(await readFile(userSettings(), 'utf8')) as Record<string, unknown>;
    expect(next.model).toBe('opus');
    expect(await readFile(`${userSettings()}.rulegate.bak`, 'utf8')).toBe('{"model":"opus"}\n');
    expect(await readFile(path.join(claudeDir, 'CLAUDE.md'), 'utf8')).toContain('TaskCreate');
    // The repository is untouched at user scope.
    expect(await tree(repo)).toEqual([]);
    // Everything written is under the sandbox's config dir.
    expect(await tree(sandbox)).toEqual(
      ['.claude/CLAUDE.md', '.claude/settings.json', '.claude/settings.json.rulegate.bak'].sort(),
    );
  });

  it('refuses invalid JSON with exit 1 and leaves the file as it was', async () => {
    await mkdir(path.join(repo, '.claude'));
    await writeFile(projectSettings(), '{ not json');
    expect(await runClaudeSettings({ cwd: repo, scope: 'project', apply: true })).toBe(
      ExitCode.Failure,
    );
    expect(await readFile(projectSettings(), 'utf8')).toBe('{ not json');
    expect(existsSync(`${projectSettings()}.rulegate.bak`)).toBe(false);
    expect(printed()).toContain('not valid JSON');
  });

  it('refuses a settings file Rulegate generated', async () => {
    await mkdir(path.join(repo, '.claude'));
    await mkdir(path.join(repo, '.rulegate'));
    const bytes = '{}\n';
    await writeFile(projectSettings(), bytes);
    const { createHash } = await import('node:crypto');
    await writeFile(
      path.join(repo, '.rulegate/state.json'),
      JSON.stringify({
        artifacts: [
          {
            adapter: 'claude-code',
            hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
            kind: 'rules',
            path: '.claude/settings.json',
          },
        ],
        schemaVersion: 1,
      }),
    );
    const code = await runClaudeSettings({ cwd: repo, scope: 'project', apply: true });
    expect(printed()).toMatch(/refused — generated by Rulegate|refused — .rulegate\/state.json/);
    expect(code).toBe(ExitCode.Failure);
    expect(await readFile(projectSettings(), 'utf8')).toBe(bytes);
  });
});

describe('the commands as registered (T107)', () => {
  const cli = async (...args: string[]): Promise<number> => {
    await buildProgram().parseAsync(['--cwd', repo, '--no-color', ...args], { from: 'user' });
    const code = process.exitCode ?? 0;
    process.exitCode = undefined;
    return Number(code);
  };

  it('reads --plugin / --no-plugin as three states', async () => {
    await seedClaude();
    expect(await cli('init')).toBe(ExitCode.Ok);
    expect(printed()).toContain('Claude Code\n');
    expect(printed()).toContain('rulegate init --plugin --yes');
    output = [];
    expect(await cli('init', '--no-plugin')).toBe(ExitCode.Ok);
    expect(printed()).not.toContain('Claude Code');
    output = [];
    expect(await cli('init', '--plugin')).toBe(ExitCode.Ok);
    expect(printed()).toContain('nothing was run. re-run with --yes');
  });

  it('registers `claude settings`, with usage errors as exit 2', async () => {
    expect(await cli('claude', 'settings')).toBe(ExitCode.Ok);
    expect(await cli('claude', 'settings', '--apply')).toBe(ExitCode.Usage);
    expect(await cli('claude', 'settings', '--scope', 'project', '--apply')).toBe(ExitCode.Ok);
    expect(existsSync(path.join(repo, '.claude/settings.json'))).toBe(true);
  });
});
