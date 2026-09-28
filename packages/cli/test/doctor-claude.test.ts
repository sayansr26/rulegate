import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from '../src/commands/doctor.js';
import { ExitCode } from '../src/ui/exit.js';
import type { ClaudePluginReport } from '../src/commands/doctor-claude.js';

/**
 * T108: doctor's Claude Code plugin line. The fixtures below copy the layout of a real
 * `~/.claude/plugins/` (Claude Code 2.x, read 2026-09-28): `installed_plugins.json` at
 * `version: 2` with an array of install records per `<plugin>@<marketplace>`, and each
 * marketplace cloned under `marketplaces/<name>/`, where the plugin's own manifest carries
 * the version the cache offers. They are synthesised per test in a temp directory that
 * `CLAUDE_CONFIG_DIR` and `HOME` both point at, so the machine's real records are never
 * read — the plugin line of a developer who has rulegate installed would otherwise pass
 * every assertion about an install for the wrong reason.
 */

let root: string;
let repo: string;
let home: string;
let claudeDir: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rulegate-doctor-claude-'));
  repo = path.join(root, 'repo');
  home = path.join(root, 'home');
  claudeDir = path.join(home, '.claude');
  await mkdir(repo, { recursive: true });
  await mkdir(claudeDir, { recursive: true });
  // What claude-code's detect() needs, and nothing more.
  await writeFile(path.join(repo, 'CLAUDE.md'), '# Rules\n\nUse tabs.\n');
  // os.homedir() reads USERPROFILE on Windows, not HOME, and CI runs there too.
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('CLAUDE_CONFIG_DIR', claudeDir);
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
  await rm(root, { recursive: true, force: true });
});

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

interface Install {
  readonly scope: 'user' | 'project' | 'local';
  readonly version: string;
  readonly projectPath?: string;
}

async function install(id: string, records: readonly Install[]): Promise<void> {
  const [plugin, market] = id.split('@') as [string, string];
  await writeJson(path.join(claudeDir, 'plugins/installed_plugins.json'), {
    version: 2,
    plugins: {
      [id]: records.map((r) => ({
        scope: r.scope,
        ...(r.scope === 'user' ? {} : { projectPath: r.projectPath ?? repo }),
        installPath: path.join(claudeDir, 'plugins/cache', market, plugin, r.version),
        version: r.version,
        installedAt: '2026-09-01T00:00:00.000Z',
        lastUpdated: '2026-09-01T00:00:00.000Z',
        gitCommitSha: '0000000000000000000000000000000000000000',
      })),
    },
  });
}

async function marketplace(version: string): Promise<void> {
  const clone = path.join(claudeDir, 'plugins/marketplaces/rulegate');
  await writeJson(path.join(claudeDir, 'plugins/known_marketplaces.json'), {
    rulegate: {
      source: { source: 'github', repo: 'sayansr26/rulegate' },
      installLocation: clone,
      lastUpdated: '2026-09-01T00:00:00.000Z',
    },
  });
  await writeJson(path.join(clone, '.claude-plugin/marketplace.json'), {
    name: 'rulegate',
    owner: { name: 'x' },
    plugins: [{ name: 'rulegate', source: './plugins/rulegate' }],
  });
  await writeJson(path.join(clone, 'plugins/rulegate/.claude-plugin/plugin.json'), {
    name: 'rulegate',
    version,
  });
}

/** A repository with `.rulegate/`: where `init --plugin --yes` writes nothing to the repo. */
async function adopt(): Promise<void> {
  await mkdir(path.join(repo, '.rulegate/rules'), { recursive: true });
  await writeFile(
    path.join(repo, '.rulegate/rulegate.yaml'),
    'schemaVersion: 1\ntools:\n  - claude-code\n',
  );
  await writeFile(path.join(repo, '.rulegate/rules/10-style.md'), 'Use tabs.\n');
}

async function report(extra: { noGlobal?: boolean } = {}): Promise<ClaudePluginReport | null> {
  stdout.length = 0;
  expect(await runDoctor({ cwd: repo, json: true, color: false, homeRoot: home, ...extra })).toBe(
    ExitCode.Ok,
  );
  return (JSON.parse(stdout.join('')) as { claudePlugin: ClaudePluginReport | null }).claudePlugin;
}

async function text(extra: { noGlobal?: boolean } = {}): Promise<{ out: string; err: string }> {
  stdout.length = 0;
  stderr.length = 0;
  expect(await runDoctor({ cwd: repo, color: false, homeRoot: home, ...extra })).toBe(ExitCode.Ok);
  return { out: stdout.join(''), err: stderr.join('') };
}

describe('rulegate doctor — Claude Code plugin line (T108)', () => {
  it('pins the JSON shape', async () => {
    await install('rulegate@rulegate', [{ scope: 'project', version: '0.2.0' }]);
    await marketplace('0.3.0');
    await writeJson(path.join(repo, '.claude/settings.json'), {
      enabledPlugins: { 'rulegate@rulegate': true },
    });

    expect(await report()).toEqual({
      id: 'rulegate@rulegate',
      globalProbed: true,
      userDir: 'CLAUDE_CONFIG_DIR',
      installed: true,
      scope: 'project',
      version: '0.2.0',
      latest: '0.3.0',
      outdated: true,
      active: true,
      decidedAt: 'project',
      enabled: { local: null, project: true, user: null },
      legacy: {
        found: false,
        plugin: null,
        shared: false,
        bothEnabled: false,
        memory: 0,
        source: false,
        imported: false,
        marketplace: false,
      },
    });
  });

  it('reports an outdated install as a warning with the update command, and exits 0', async () => {
    await install('rulegate@rulegate', [{ scope: 'project', version: '0.2.0' }]);
    await marketplace('0.3.0');
    await adopt();
    const { out, err } = await text();

    expect(out).toContain('Claude Code plugin  rulegate@rulegate 0.2.0, project scope');
    expect(out).toContain('latest    0.3.0');
    expect(err).toContain("0.2.0 is behind the marketplace's 0.3.0");
    // The update runs through `rulegate init --plugin --yes`, the one path allowed to spawn
    // `claude`, rather than a `claude plugin` command doctor would have to vouch for.
    expect(err).toContain('`rulegate init --plugin --yes` updates it');
  });

  it('without .rulegate/, the update hint is the in-Claude-Code steps, not init --yes', async () => {
    // A user-scope install counts for every repository, so an unrelated one with a
    // hand-written CLAUDE.md sees the warning too — and there `init --plugin --yes` would
    // import the repository and take over CLAUDE.md before it reached the plugin.
    await install('rulegate@rulegate', [{ scope: 'user', version: '0.2.0' }]);
    await marketplace('0.3.0');
    const { out, err } = await text();
    expect(out).toContain('no .rulegate/ here');
    expect(err).toContain("0.2.0 is behind the marketplace's 0.3.0");
    expect(err).toContain(
      '/plugin marketplace update rulegate, then /plugin update rulegate@rulegate',
    );
    expect(err).not.toContain('--yes');
  });

  it('is silent about updates when the install is current', async () => {
    await install('rulegate@rulegate', [{ scope: 'user', version: '0.3.0' }]);
    await marketplace('0.3.0');
    const r = await report();
    expect(r?.installed).toBe(true);
    expect(r?.scope).toBe('user');
    expect(r?.outdated).toBe(false);
    expect((await text()).err).not.toContain('is behind');
  });

  it("does not count another project's install as this one's", async () => {
    await install('rulegate@rulegate', [
      { scope: 'project', version: '0.3.0', projectPath: path.join(root, 'elsewhere') },
    ]);
    const r = await report();
    expect(r?.installed).toBe(false);
    const { out } = await text();
    expect(out).toContain('rulegate@rulegate not installed');
    // Opt-in (D3): absence is stated, never raised as a warning.
    expect(out).toContain('rulegate init --plugin');
  });

  it('reads enabledPlugins per scope', async () => {
    await install('rulegate@rulegate', [{ scope: 'user', version: '0.3.0' }]);
    await writeJson(path.join(repo, '.claude/settings.local.json'), {
      enabledPlugins: { 'rulegate@rulegate': false },
    });
    await writeJson(path.join(claudeDir, 'settings.json'), {
      enabledPlugins: { 'rulegate@rulegate': true },
    });
    expect((await report())?.enabled).toEqual({ local: false, project: null, user: true });
    expect((await text()).out).toContain('enabled   local off, project unset, user on');
  });

  it('reports what agent-os left behind, with the migration hint', async () => {
    await writeJson(path.join(repo, '.claude/settings.json'), {
      enabledPlugins: { 'agent-os@sayan-plugins': true },
      extraKnownMarketplaces: { 'sayan-plugins': { source: { source: 'github', repo: 'x/y' } } },
    });
    await mkdir(path.join(repo, '.claude/agent-memory/agent-os-builder'), { recursive: true });
    await mkdir(path.join(repo, '.agent-os'), { recursive: true });

    const r = await report();
    expect(r?.legacy).toMatchObject({
      found: true,
      plugin: 'project',
      memory: 1,
      source: true,
      imported: false,
      marketplace: true,
    });
    const { out, err } = await text();
    expect(out).toContain('agent-os  enabled (project), 1 memory dir, .agent-os/ not imported');
    expect(err).toContain('rulegate init imports them');
    // Not installed, so not "both enabled" — and /rulegate:init does not exist yet, so the
    // plugin install comes first.
    expect(r?.installed).toBe(false);
    expect(r?.legacy.bothEnabled).toBe(false);
    expect(err).not.toContain('both enabled');
    expect(err).toContain('agent-os is still set up here.');
    // No .rulegate/: the hint is init's dry run, which shows the import before any --yes.
    expect(err).toContain('`rulegate init --plugin` (a dry run), then /rulegate:init');
    expect(err).not.toContain('--yes');

    await adopt();
    expect((await text()).err).toContain('`rulegate init --plugin --yes`, then /rulegate:init');
  });

  it('the paired case: with rulegate installed, agent-os enabled beside it is "both enabled"', async () => {
    await install('rulegate@rulegate', [{ scope: 'project', version: '0.3.0' }]);
    await writeJson(path.join(repo, '.claude/settings.json'), {
      enabledPlugins: { 'agent-os@sayan-plugins': true },
    });
    const r = await report();
    expect(r?.installed).toBe(true);
    expect(r?.legacy.bothEnabled).toBe(true);
    const { err } = await text();
    expect(err).toContain('agent-os and rulegate are both enabled');
    expect(err).toContain('run /rulegate:init in Claude Code');
    expect(err).not.toContain('--plugin');

    // Explicitly off is not "both enabled", installed or not.
    await writeJson(path.join(repo, '.claude/settings.json'), {
      enabledPlugins: { 'agent-os@sayan-plugins': true, 'rulegate@rulegate': false },
    });
    const off = await report();
    expect(off?.legacy.bothEnabled).toBe(false);
    expect(off?.active).toBe(false);
    // And a disabled plugin's /rulegate:init is not loaded, so it is enabled first.
    const offErr = (await text()).err;
    expect(offErr).toContain('agent-os is still set up here.');
    expect(offErr).toContain('/plugin enable rulegate@rulegate, then /rulegate:init');
    expect(offErr).not.toContain('run /rulegate:init');
    expect(offErr).not.toContain('--yes');

    await adopt();
    expect((await text()).err).toContain(
      '`rulegate init --plugin --yes` enables it, then /rulegate:init',
    );
  });

  it('names the settings file when the flag that turns it off is not at the install scope', async () => {
    // `init --plugin --yes` and `/plugin enable` both write the install's own scope. A user
    // install turned off in settings.local.json stays off after that write — local wins —
    // so promising that init enables it sent the user round the same hint forever.
    await install('rulegate@rulegate', [{ scope: 'user', version: '0.3.0' }]);
    await writeJson(path.join(repo, '.claude/settings.json'), {
      enabledPlugins: { 'agent-os@sayan-plugins': true },
    });
    await writeJson(path.join(repo, '.claude/settings.local.json'), {
      enabledPlugins: { 'rulegate@rulegate': false },
    });
    await writeJson(path.join(claudeDir, 'settings.json'), {
      enabledPlugins: { 'rulegate@rulegate': true },
    });
    await adopt();
    const r = await report();
    expect(r).toMatchObject({ scope: 'user', active: false, decidedAt: 'local' });
    let err = (await text()).err;
    expect(err).toContain('agent-os is still set up here.');
    expect(err).toContain('turn rulegate on in .claude/settings.local.json, then /rulegate:init');
    expect(err).not.toContain('--yes');
    expect(err).not.toContain('/plugin enable');

    // A false in the committed settings outranks the user file the same way.
    await rm(path.join(repo, '.claude/settings.local.json'));
    await writeJson(path.join(repo, '.claude/settings.json'), {
      enabledPlugins: { 'agent-os@sayan-plugins': true, 'rulegate@rulegate': false },
    });
    expect((await report())?.decidedAt).toBe('project');
    err = (await text()).err;
    expect(err).toContain('turn rulegate on in .claude/settings.json, then /rulegate:init');

    // The paired control: turned off at the install's own scope, the enable write reaches
    // the file that decides, so init is the right hint again.
    await writeJson(path.join(repo, '.claude/settings.json'), {
      enabledPlugins: { 'agent-os@sayan-plugins': true },
    });
    await writeJson(path.join(claudeDir, 'settings.json'), {
      enabledPlugins: { 'rulegate@rulegate': false },
    });
    expect((await report())?.decidedAt).toBe('user');
    err = (await text()).err;
    expect(err).toContain('`rulegate init --plugin --yes` enables it, then /rulegate:init');
    expect(err).not.toContain('turn rulegate on');

    // A false less local than the install is outranked by the enable's own write, so the
    // committed or machine-wide file it sits in is never the one to edit.
    await install('rulegate@rulegate', [{ scope: 'project', version: '0.3.0' }]);
    expect(await report()).toMatchObject({ scope: 'project', active: false, decidedAt: 'user' });
    err = (await text()).err;
    expect(err).toContain('`rulegate init --plugin --yes` enables it, then /rulegate:init');
    expect(err).not.toContain('turn rulegate on');
  });

  it('--no-global cannot see an install record, so it never claims both are enabled', async () => {
    await install('rulegate@rulegate', [{ scope: 'project', version: '0.3.0' }]);
    await writeJson(path.join(repo, '.claude/settings.json'), {
      enabledPlugins: { 'agent-os@sayan-plugins': true },
    });
    const r = await report({ noGlobal: true });
    expect(r?.installed).toBeNull();
    expect(r?.legacy.plugin).toBe('project');
    expect(r?.legacy.bothEnabled).toBe(false);
    const { err } = await text({ noGlobal: true });
    expect(err).not.toContain('both enabled');
    expect(err).toContain('once the rulegate plugin is installed');
  });

  it('says where the user-level records came from when CLAUDE_CONFIG_DIR moves them', async () => {
    // The fixtures point CLAUDE_CONFIG_DIR at the default location; core's probe reads
    // ~/.claude regardless, so the report names the variable whenever it is set.
    expect((await report())?.userDir).toBe('CLAUDE_CONFIG_DIR');
    expect((await text()).out).toContain('plugin records read from $CLAUDE_CONFIG_DIR');

    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    expect((await report())?.userDir).toBe('~/.claude');
    expect((await text()).out).not.toContain('$CLAUDE_CONFIG_DIR');
    expect((await report({ noGlobal: true }))?.userDir).toBeNull();
  });

  it('the paired control: a clean repository reports no agent-os and no warning', async () => {
    const { out, err } = await text();
    expect(out).toContain('agent-os  none found');
    expect(err).not.toContain('agent-os');
  });

  it('--no-global reads nothing user-level: the install record is there and goes unreported', async () => {
    await install('rulegate@rulegate', [{ scope: 'user', version: '0.2.0' }]);
    await marketplace('0.3.0');
    await writeJson(path.join(claudeDir, 'settings.json'), {
      enabledPlugins: { 'rulegate@rulegate': true, 'agent-os@sayan-plugins': true },
    });
    await writeJson(path.join(repo, '.claude/settings.json'), {
      enabledPlugins: { 'rulegate@rulegate': true },
    });

    const r = await report({ noGlobal: true });
    expect(r).toMatchObject({
      globalProbed: false,
      installed: null,
      version: null,
      latest: null,
      outdated: false,
      enabled: { local: null, project: true, user: null },
    });
    // The user-scope agent-os enable is the tell: seen only when the user file is read.
    expect(r?.legacy.plugin).toBeNull();
    const { out } = await text({ noGlobal: true });
    expect(out).toContain('install record not probed');
    expect(out).toContain('user not probed');

    // And the same records are seen with the probe on, so the assertions above can fail.
    const probed = await report();
    expect(probed?.installed).toBe(true);
    expect(probed?.enabled.user).toBe(true);
    expect(probed?.legacy.plugin).toBe('user');
  });

  it('is absent when Claude Code is not detected', async () => {
    await rm(path.join(repo, 'CLAUDE.md'));
    await writeFile(path.join(repo, 'AGENTS.md'), '# Rules\n\nUse tabs.\n');
    expect(await report()).toBeNull();
    expect((await text()).out).not.toContain('Claude Code plugin');
  });

  it('never puts an absolute path in the JSON, and stays within 80 columns', async () => {
    await install('rulegate@rulegate', [{ scope: 'project', version: '0.2.0' }]);
    await marketplace('0.3.0');
    const r = await report();
    for (const value of JSON.stringify(r).match(/"[^"]*"/g) ?? []) {
      expect(value.startsWith('"/')).toBe(false);
    }
    // Every hint variant, adopted or not: the plugin block and its own warnings only — the
    // `not detected:` list and core's warnings are single lines by design and wrap.
    const lines = async (): Promise<string[]> => {
      const { out, err } = await text();
      const block = out.slice(out.indexOf('Claude Code plugin')).split('\n\n')[0] ?? '';
      const mine = /^! claude-code: (rulegate@rulegate|agent-os|\.agent-os\/)/;
      const ours = err
        .split('\n')
        .filter((l, i, all) => mine.test(l) || mine.test(all[i - 1] ?? ''));
      expect(block).toContain('agent-os');
      expect(ours.length).toBeGreaterThan(0);
      return [...block.split('\n'), ...ours];
    };
    await writeJson(path.join(repo, '.claude/settings.json'), {
      enabledPlugins: { 'agent-os@sayan-plugins': true, 'rulegate@rulegate': false },
    });
    const seen = [...(await lines())];
    await adopt();
    seen.push(...(await lines()));
    // The longest file name a hint can carry: a project install turned off in the local
    // file. A user-level file is never named — nothing is less local than an install there.
    await writeJson(path.join(repo, '.claude/settings.json'), {
      enabledPlugins: { 'agent-os@sayan-plugins': true },
    });
    await writeJson(path.join(repo, '.claude/settings.local.json'), {
      enabledPlugins: { 'rulegate@rulegate': false },
    });
    seen.push(...(await lines()));
    expect(seen.join('\n')).toContain('turn rulegate on in .claude/settings.local.json');
    expect(seen.join('\n')).toContain('rulegate init --plugin --yes');
    expect(seen.join('\n')).toContain('/plugin marketplace update');
    for (const line of seen) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it("writes nothing into Claude Code's directory or the repository", async () => {
    await install('rulegate@rulegate', [{ scope: 'project', version: '0.2.0' }]);
    await marketplace('0.3.0');
    const before = await snapshot(root);
    await text();
    await report();
    expect(await snapshot(root)).toEqual(before);
    // Anti-vacuity: the snapshot sees the files the fixture wrote.
    expect(before.some((l) => l.startsWith('home/.claude/plugins/installed_plugins.json'))).toBe(
      true,
    );
    expect(
      JSON.parse(await readFile(path.join(claudeDir, 'plugins/installed_plugins.json'), 'utf8')),
    ).toHaveProperty('version', 2);
  });
});

async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const child = path.join(d, entry.name);
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child, rel);
        continue;
      }
      const s = await stat(child);
      out.push(`${rel}\t${String(s.size)}\t${String(s.mtimeMs)}`);
    }
  };
  await walk(dir, '');
  return out.sort();
}
