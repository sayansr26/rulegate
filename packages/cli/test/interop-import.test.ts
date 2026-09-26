import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeFileSystem, computeInitPlan } from '@rulegate/core';
import { AGENT_OS_BANNER, INTEROP, agentOs, derivedFrom, ruler, rulesync } from '@rulegate/interop';
import { ADAPTERS } from '../src/registry.js';
import { ADAPTER_NAMES } from '../src/registry.js';
import { runInit } from '../src/commands/init.js';
import { runCheck } from '../src/commands/check.js';
import { ExitCode } from '../src/ui/exit.js';

const fixtures = path.resolve(import.meta.dirname, '../../../fixtures');

async function init(name: string) {
  const repoRoot = path.join(fixtures, name, 'input');
  return computeInitPlan({
    repoRoot,
    fs: new NodeFileSystem(repoRoot),
    adapters: ADAPTERS,
    interop: INTEROP,
  });
}

describe('interop — T054', () => {
  it('keeps interop importers out of the adapter set entirely', () => {
    // The structural claim. An id in both lists would put a tool Rulegate never generates
    // for into rulegate.yaml, doctor's table, and every rule's `tools:` selector —
    // asserting Rulegate maintains a ruler config, which it must never do.
    for (const importer of INTEROP) {
      expect(ADAPTER_NAMES).not.toContain(importer.name);
    }
    // And nothing in the interop surface can write: there is no `write` to call.
    for (const importer of INTEROP) {
      expect('write' in importer).toBe(false);
    }
  });

  it('imports ruler’s sources once, not its generated copies as well', async () => {
    // The load-bearing behaviour. ruler concatenates `.ruler/*.md` into AGENTS.md and
    // CLAUDE.md, which are exactly the files the codex and claude-code adapters import
    // from — so without masking, every rule arrives three times: once from the source a
    // user edits and once from each generated copy.
    const plan = await init('ruler-import');
    expect(plan.interop).toEqual(['ruler']);

    const bodies = plan.canonical.rules.map((r) => r.body);
    expect(bodies.filter((b) => b.includes('Prefer small modules')).length).toBe(1);
    expect(bodies.filter((b) => b.includes('Colocate tests')).length).toBe(1);

    // And nothing came from the files ruler generated. (Not "everything came from
    // .ruler/": the fixture also holds a hand-written GEMINI.md, which the gemini adapter
    // correctly imports — masking must not reach it.)
    const sources = plan.canonical.rules.map((r) => r.source.file);
    expect(sources).not.toContain('AGENTS.md');
    expect(sources).not.toContain('CLAUDE.md');
    expect(sources).toContain('.ruler/AGENTS.md');
  });

  it('masks only files ruler actually wrote, judged by its own Source marker', async () => {
    // The containment on the masking. A hand-written CLAUDE.md carries no
    // `<!-- Source: -->` marker, and dropping it because a `.ruler/` directory happens to
    // exist would lose a file the user wrote — the failure this whole feature exists to
    // avoid, arriving through the fix for it.
    const repoRoot = path.join(fixtures, 'ruler-import/input');
    const ctx = {
      repoRoot,
      canonical: (await init('ruler-import')).canonical,
      fs: new NodeFileSystem(repoRoot),
      options: {},
      apiVersion: 1 as const,
    };
    const found = await ruler.read(ctx);
    // GEMINI.md is in the fixture, is a filename ruler is known to write, and carries no
    // Source marker because a person wrote it. It must not be masked.
    expect([...found.generated].sort()).toEqual(['AGENTS.md', 'CLAUDE.md']);

    // And the consequence, which is what actually matters: its content reaches canonical.
    // Without this the assertion above passes against an importer that masks everything,
    // because a list is only wrong if something reads it.
    const plan = await init('ruler-import');
    const bodies = plan.canonical.rules.map((r) => r.body).join('\n');
    expect(bodies).toContain('This file is not ruler’s output'.replace('’', "'"));
  });

  it('preserves rulesync’s `targets` as a real tools selector', async () => {
    // rulesync is the one source with a field that maps straight onto canonical `tools`,
    // so it survives rather than widening to `all` the way an adapter import must.
    const plan = await init('rulesync-import');
    expect(plan.interop).toEqual(['rulesync']);

    const scoped = plan.canonical.rules.find((r) => r.frontmatter.description === 'Test files');
    expect(scoped).toBeDefined();
    expect(scoped!.frontmatter.tools).toEqual({
      kind: 'include',
      tools: ['claude-code', 'cursor'],
    });
    expect(scoped!.frontmatter.globs).toEqual(['**/*.test.ts']);

    // The control: a `targets: ["*"]` rule stays `all`, so the mapping is doing work
    // rather than narrowing everything it touches.
    const wide = plan.canonical.rules.find((r) => r.frontmatter.description === 'Style');
    expect(wide!.frontmatter.tools).toEqual({ kind: 'all' });
  });

  it('reports what it found and did not import, rather than dropping it silently', async () => {
    const repoRoot = path.join(fixtures, 'rulesync-import/input');
    const found = await rulesync.read({
      repoRoot,
      canonical: (await init('rulesync-import')).canonical,
      fs: new NodeFileSystem(repoRoot),
      options: {},
      apiVersion: 1 as const,
    });
    // Nothing unsupported in this fixture, so the list is empty — the assertion that
    // matters is that the field exists and `init` surfaces it, covered below.
    expect(found.notImported).toEqual([]);
    expect(found.rules.length).toBe(2);
  });

  it('never tells the user to delete a directory Rulegate renders into', async () => {
    // rulesync names `.clinerules` whole, and Cline's adapter renders `.clinerules/<id>.md`:
    // "delete .clinerules once init has run" would delete what init just wrote.
    const repo = await mkdtemp(path.join(tmpdir(), 'rulegate-rulesync-'));
    try {
      await mkdir(path.join(repo, '.rulesync/rules'), { recursive: true });
      await mkdir(path.join(repo, '.clinerules'), { recursive: true });
      await writeFile(path.join(repo, '.rulesync/rules/style.md'), 'Tabs.\n');
      await writeFile(path.join(repo, '.clinerules/style.md'), 'Tabs.\n');
      const plan = await computeInitPlan({
        repoRoot: repo,
        fs: new NodeFileSystem(repo),
        adapters: ADAPTERS,
        interop: INTEROP,
      });
      expect(plan.plan.artifacts.map((a) => a.path)).toContain('.clinerules/style.md');
      expect(plan.warnings.filter((w) => w.code === 'W_INTEROP_OUTPUT_LEFT')).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  it('does not import from a repository that uses neither tool', async () => {
    // The negative half. Without it every assertion above would pass against an importer
    // that reported the same thing for every repository.
    const plan = await init('claude-code-import');
    expect(plan.interop).toEqual([]);
  });
});

/** An importer's context over a fixture input, as `computeInitPlan` builds one. */
async function readWith(importer: typeof agentOs, name: string) {
  const repoRoot = path.join(fixtures, name, 'input');
  return importer.read({
    repoRoot,
    canonical: (await init('claude-code-import')).canonical,
    fs: new NodeFileSystem(repoRoot),
    options: {},
    apiVersion: 1 as const,
  });
}

/** Every file under `dir`, relative and sorted. */
async function files(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await files(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.sort();
}

/** agent-os 0.6.0's bannered outputs in `fixtures/agent-os-import/input`. */
const AGENT_OS_OUTPUTS = [
  '.agents/rules/api.md',
  '.agents/rules/style.md',
  '.agents/rules/tests.md',
  '.claude/rules/api.md',
  '.claude/rules/tests.md',
  '.clinerules/api.md',
  '.clinerules/tests.md',
  '.cursor/rules/api.mdc',
  '.cursor/rules/style.mdc',
  '.cursor/rules/tests.mdc',
  '.windsurf/rules/api.md',
  '.windsurf/rules/style.md',
  '.windsurf/rules/tests.md',
  'AGENTS.md',
];

describe('interop — agent-os (T113)', () => {
  it('writes the hand-written .rulegate/ golden, byte for byte', async () => {
    // The fixture-first assertion: `expected/` was written from agent-os's documented
    // source format before the importer existed. It pins the rules (`.agent-os/AGENTS.md`
    // first, then `rules/` in order), `paths` → `globs` in both the list and scalar shapes,
    // `always: true` as repo-wide with its description kept, the banner-free CLAUDE.md as
    // an ordinary claude-code import, and the tools: every mapped target plus codex.
    const plan = await init('agent-os-import');
    expect(plan.interop).toEqual(['agent-os']);
    expect(plan.errors).toEqual([]);

    const expectedDir = path.join(fixtures, 'agent-os-import/expected');
    const expected = new Map<string, string>();
    for (const rel of await files(expectedDir)) {
      expected.set(`.rulegate/${rel}`, await readFile(path.join(expectedDir, rel), 'utf8'));
    }
    expect(new Map(plan.canonicalFiles.map((f) => [f.path, f.contents]))).toEqual(expected);
  });

  it('imports each rule once, from .agent-os/, never from a bannered output', async () => {
    const plan = await init('agent-os-import');
    const sources = plan.canonical.rules.map((r) => r.source.file);
    expect(sources).toEqual([
      '.agent-os/AGENTS.md',
      '.agent-os/rules/api.md',
      '.agent-os/rules/style.md',
      '.agent-os/rules/tests.md',
      // The controls against masking everything: people wrote these, with no banner, and
      // the second sits where agent-os writes its own `.mdc` files.
      'CLAUDE.md',
      '.cursor/rules/team.mdc',
    ]);
    const bodies = plan.canonical.rules.map((r) => r.body).join('\n');
    expect(bodies.split('Colocate tests').length - 1).toBe(1);
    expect(bodies).not.toContain(AGENT_OS_BANNER);
  });

  it('masks exactly the files that carry a banner', async () => {
    const found = await readWith(agentOs, 'agent-os-import');
    // Not CLAUDE.md or `.cursor/rules/team.mdc`, not the merged JSON configs, not the skill
    // copies: none carries a banner, and each is somebody's file or a copy no adapter
    // imports. `team.mdc` is the one that matters — it is in an output location.
    expect([...found.generated].sort()).toEqual(AGENT_OS_OUTPUTS);
  });

  it('takes ownership of every agent-os output by rendering to the same path', async () => {
    // Ids are agent-os's basenames, so Rulegate renders `.cursor/rules/api.mdc` where
    // agent-os did and `init --yes` takes the file over with a backup. A prefixed id would
    // leave every one of these on disk beside a second copy.
    const plan = await init('agent-os-import');
    const rendered = new Set(plan.plan.artifacts.map((a) => a.path));
    for (const output of AGENT_OS_OUTPUTS) expect(rendered, output).toContain(output);
    expect(plan.warnings.filter((w) => w.code === 'W_INTEROP_OUTPUT_LEFT')).toEqual([]);
  });

  it('names everything it did not carry, and prints the plugin settings it cannot write', async () => {
    const plan = await init('agent-os-import');
    const messages = plan.warnings
      .filter((w) => w.code === 'W_INTEROP_NOT_IMPORTED')
      .map((w) => w.message);

    expect(messages).toContainEqual(expect.stringContaining('`.agent-os/skills` was found'));
    expect(messages).toContainEqual(
      expect.stringContaining('.agents/skills/review, .claude/skills/review, .cline/skills/review'),
    );
    // The exact `.claude/rulegate.json` payload, so /rulegate:init (T114) or a person can
    // write it: `rulegate init` never does, because the file's existence is how the plugin
    // knows a project has been set up.
    const claude = messages.find((m) => m.includes('.claude/rulegate.json'));
    expect(claude).toContain(
      '{\n  "features": [\n    "src/features/*"\n  ],\n  "cartographerReminder": false\n}',
    );
    expect(messages).toContainEqual(
      expect.stringContaining('`.gemini/settings.json`: `context.fileName` lists AGENTS.md'),
    );
    for (const config of ['opencode.json', 'kilo.json']) {
      expect(messages).toContainEqual(
        expect.stringContaining(
          `\`${config}\`: \`instructions\` lists .agent-os/rules/api.md, .agent-os/rules/tests.md`,
        ),
      );
    }
  });

  it('refuses a .agent-os/ that agent-os built out of Rulegate output (T120)', async () => {
    const found = await readWith(agentOs, 'agent-os-import-adopted');
    expect(found.rules).toEqual([]);
    // AGENTS.md carries both banners; either makes it derived.
    expect(found.generated).toEqual(['AGENTS.md']);
    expect((found.errors ?? []).map((e) => e.source?.file)).toEqual([
      '.agent-os/AGENTS.md',
      '.agent-os/rules/10-project.md',
      '.agent-os/rules/20-architecture.md',
      '.agent-os/rules/30-invariants.md',
      '.agent-os/rules/40-commands.md',
      '.agent-os/rules/50-conventions.md',
    ]);
    expect(found.errors?.[0]?.hint).toContain('restore .rulegate/ from git');

    // And the refusal reaches `init`, whose gate is `errors`. No output-left advice either:
    // "delete AGENTS.md once init has run" would be wrong about a run that never happens.
    const plan = await init('agent-os-import-adopted');
    expect(plan.errors.length).toBe(6);
    expect(plan.warnings.filter((w) => w.code === 'W_INTEROP_OUTPUT_LEFT')).toEqual([]);
  });

  it('judges a file derived by either banner, in the leading comments only', () => {
    const agentOsLine = `<!-- ${AGENT_OS_BANNER} — edit the source -->`;
    const rulegateLine = '<!-- generated by rulegate; edit .rulegate/ instead -->';
    expect(derivedFrom(`${agentOsLine}\n\n# x\n`)).toBe('agent-os');
    expect(derivedFrom(`${rulegateLine}\n\n# x\n`)).toBe('rulegate');
    // Stacked, as agent-os did to this repository's AGENTS.md: Rulegate's names the real
    // source, so it wins.
    expect(derivedFrom(`${agentOsLine}\n\n${rulegateLine}\n\n# x\n`)).toBe('rulegate');
    // After frontmatter, where `.mdc`, `.claude/rules` and `.clinerules` carry it.
    expect(derivedFrom(`---\npaths:\n  - "a/**"\n---\n\n${agentOsLine}\n\nbody\n`)).toBe(
      'agent-os',
    );
    // A rule that *mentions* the banner in its text is somebody's rule, not output.
    expect(derivedFrom(`# Notes\n\nagent-os files start with ${agentOsLine}\n`)).toBeUndefined();
    expect(derivedFrom('# Plain\n')).toBeUndefined();
  });
});

describe('interop — agent-os edge cases (T113)', () => {
  let repo = '';
  const setup = async () => {
    repo = await mkdtemp(path.join(tmpdir(), 'rulegate-agent-os-'));
    return repo;
  };
  const cleanup = () => rm(repo, { recursive: true, force: true });
  const initAt = (repoRoot: string) =>
    computeInitPlan({
      repoRoot,
      fs: new NodeFileSystem(repoRoot),
      adapters: ADAPTERS,
      interop: INTEROP,
    });
  const readAt = async (repoRoot: string) =>
    agentOs.read({
      repoRoot,
      canonical: (await init('claude-code-import')).canonical,
      fs: new NodeFileSystem(repoRoot),
      options: {},
      apiVersion: 1 as const,
    });
  const put = async (rel: string, contents: string) => {
    await mkdir(path.dirname(path.join(repo, rel)), { recursive: true });
    await writeFile(path.join(repo, rel), contents);
  };

  it('names an agent-os output that nothing Rulegate renders replaces', async () => {
    await setup();
    try {
      await cp(path.join(fixtures, 'agent-os-import/input'), repo, { recursive: true });
      // Left by a rule since deleted from .agent-os/, and one whose name differs only in
      // case from what Rulegate renders.
      await put('.windsurf/rules/stale.md', `<!-- ${AGENT_OS_BANNER} -->\n\nold\n`);
      await rename(
        path.join(repo, '.cursor/rules/api.mdc'),
        path.join(repo, '.cursor/rules/API.mdc'),
      );
      const warnings = (await initAt(repo)).warnings.filter(
        (w) => w.code === 'W_INTEROP_OUTPUT_LEFT',
      );
      const byFile = new Map(warnings.map((w) => [w.source?.file, w]));
      expect(byFile.get('.windsurf/rules/stale.md')?.hint).toBe(
        'once init has run, delete .windsurf/rules/stale.md if agent-os generated it: the agent-os source it was built from is in .rulegate/rules/ now',
      );
      // `glob` reports the on-disk spelling on every filesystem. On a case-insensitive one,
      // API.mdc *is* the file Rulegate renders as api.mdc, so "delete it" would delete the
      // output: the hint has to send the user to look first.
      expect(byFile.get('.cursor/rules/API.mdc')?.hint).toContain('list the directory');
      expect(warnings.map((w) => w.source?.file)).toEqual([
        '.cursor/rules/API.mdc',
        '.windsurf/rules/stale.md',
      ]);
    } finally {
      await cleanup();
    }
  });

  it('keeps one id space across agent-os rules and adapter imports', async () => {
    await setup();
    try {
      await put('.agent-os/rules/style.md', '---\nalways: true\n---\n\nTabs.\n');
      await put('CLAUDE.md', '## Style\n\nSpaces, in this one.\n');
      const plan = await initAt(repo);
      expect(plan.errors).toEqual([]);
      const ids = plan.canonical.rules.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      // The source a user edits keeps the name; the other copy is suffixed.
      expect(plan.canonical.rules.find((r) => r.id === 'style')?.source.file).toBe(
        '.agent-os/rules/style.md',
      );
      // And order: interop rules first, as numbers, not left at the default that would
      // rank them after every adapter rule.
      expect(plan.canonical.rules.map((r) => r.frontmatter.order)).toEqual([10, 20]);
    } finally {
      await cleanup();
    }
  });

  it('enables the tools agent-os was configured for, even with nothing on disk yet', async () => {
    // A target whose files were never generated — `agent-os sync` not yet run after adding
    // it — is invisible to detection. The config is the user's word that they use Windsurf,
    // and dropping it would leave rulegate.yaml enabling less than the setup it replaces.
    await setup();
    try {
      await put('.agent-os/config.json', JSON.stringify({ targets: ['windsurf'] }));
      await put('.agent-os/rules/style.md', 'Tabs.\n');
      const plan = await initAt(repo);
      expect(plan.detected).toEqual(['codex', 'windsurf']);
      expect(plan.canonical.manifest.tools.map((t) => t.id)).toEqual(['codex', 'windsurf']);
    } finally {
      await cleanup();
    }
  });

  it('never enables a tool id no adapter answers to', async () => {
    // The importer's word is filtered against the adapters, in core: a name that reached
    // the manifest unchecked would make the first `sync` fail with E_UNKNOWN_TOOL.
    await setup();
    try {
      await put('.agent-os/rules/style.md', 'Tabs.\n');
      const loud = {
        ...agentOs,
        read: async (ctx: Parameters<typeof agentOs.read>[0]) => ({
          ...(await agentOs.read(ctx)),
          tools: ['codex', 'not-a-tool'],
        }),
      };
      const plan = await computeInitPlan({
        repoRoot: repo,
        fs: new NodeFileSystem(repo),
        adapters: ADAPTERS,
        interop: [loud],
      });
      expect(plan.canonical.manifest.tools.map((t) => t.id)).toEqual(['codex']);
    } finally {
      await cleanup();
    }
  });

  it('keeps the paths of an `always` rule rather than dropping them', async () => {
    await setup();
    try {
      await put(
        '.agent-os/rules/db.md',
        '---\nalways: true\npaths: [db/**, migrations/**]\n---\n\nNo raw SQL.\n',
      );
      const found = await agentOs.read({
        repoRoot: repo,
        canonical: (await init('claude-code-import')).canonical,
        fs: new NodeFileSystem(repo),
        options: {},
        apiVersion: 1 as const,
      });
      // agent-os treats it as repo-wide and never writes it to `.claude/rules/`.
      expect(found.rules[0]?.frontmatter.globs).toEqual([]);
      expect(found.rules[0]?.frontmatter.unknown).toEqual({ paths: ['db/**', 'migrations/**'] });
      // No config at all: agent-os still writes AGENTS.md, so codex alone is enabled.
      expect(found.tools).toEqual(['codex']);
      // And the kept key survives the round trip through `.rulegate/` rather than failing
      // the first `sync` on a frontmatter key canonical has no field for.
      const plan = await initAt(repo);
      expect(plan.errors).toEqual([]);
      const written = plan.canonicalFiles.find((f) => f.path === '.rulegate/rules/db.md');
      expect(written?.contents).toContain('paths:\n  - db/**\n  - migrations/**\n');
    } finally {
      await cleanup();
    }
  });

  it('carries only settings the plugin has, and says which it dropped', async () => {
    await setup();
    try {
      await put(
        '.agent-os/config.json',
        JSON.stringify({ targets: ['claude-code', 'zed-ish'], claude: { features: 'nope', x: 1 } }),
      );
      const found = await agentOs.read({
        repoRoot: repo,
        canonical: (await init('claude-code-import')).canonical,
        fs: new NodeFileSystem(repo),
        options: {},
        apiVersion: 1 as const,
      });
      const notes = (found.notes ?? []).map((n) => n.message);
      expect(notes).toContainEqual(expect.stringContaining('`features`, `x`'));
      expect(notes.join('\n')).not.toContain('create it with');
      expect(notes).toContainEqual(expect.stringContaining('target `zed-ish`'));
      expect([...(found.tools ?? [])].sort()).toEqual(['claude-code', 'codex']);
    } finally {
      await cleanup();
    }
  });

  it('carries every setting the plugin reads, in its documented order', async () => {
    await setup();
    try {
      await put(
        '.agent-os/config.json',
        JSON.stringify({
          claude: {
            activeTask: ['.claude/active-task.md'],
            handoff: ['NOTES.md'],
            features: ['src/features/*'],
            toString: 1,
          },
        }),
      );
      const found = await readAt(repo);
      const note = (found.notes ?? []).map((n) => n.message).find((m) => m.includes('create it'));
      expect(note).toContain(
        `create it with:\n${JSON.stringify(
          {
            features: ['src/features/*'],
            handoff: ['NOTES.md'],
            activeTask: ['.claude/active-task.md'],
          },
          null,
          2,
        )} `,
      );
      // `handoff` is a setting the plugin has; only the key it does not have is named.
      expect(note).toContain('wrong type: `toString`.');
    } finally {
      await cleanup();
    }
  });

  it('imports a rule with neither body nor description, as agent-os compiles it', async () => {
    // agent-os writes it everywhere, described by its name. Skipped, its `paths` were lost
    // and its outputs were reported as replaced by a source that never came across.
    await setup();
    try {
      await put('.agent-os/config.json', JSON.stringify({ targets: ['cursor'] }));
      await put('.agent-os/rules/e.md', '---\npaths:\n  - "src/**"\n---\n\n');
      await put(
        '.cursor/rules/e.mdc',
        `---\ndescription: e\nglobs: src/**\nalwaysApply: false\n---\n\n<!-- ${AGENT_OS_BANNER} -->\n`,
      );
      const plan = await initAt(repo);
      expect(plan.errors).toEqual([]);
      const rule = plan.canonical.rules.find((r) => r.id === 'e');
      expect(rule?.frontmatter.description).toBe('e');
      expect(rule?.frontmatter.globs).toEqual(['src/**']);
      expect(plan.warnings.filter((w) => w.code === 'W_INTEROP_OUTPUT_LEFT')).toEqual([]);
      expect(plan.plan.artifacts.map((a) => a.path)).toContain('.cursor/rules/e.mdc');
      // And it survives the round trip through `.rulegate/`.
      expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);
      expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    } finally {
      await cleanup();
    }
  });

  it('leaves a rule named agents.md its own id, and suffixes the project body instead', async () => {
    // agent-os wrote `rules/agents.md` to `.cursor/rules/agents.mdc`; the project body it
    // writes to no per-rule path, so it is the one that can move without breaking takeover.
    await setup();
    try {
      await put('.agent-os/AGENTS.md', '# Project\n\nHello.\n');
      await put('.agent-os/rules/agents.md', '---\npaths:\n  - agents/**\n---\n\nScoped.\n');
      const found = await readAt(repo);
      expect(found.rules.map((r) => [r.id, r.source.file])).toEqual([
        ['agents-2', '.agent-os/AGENTS.md'],
        ['agents', '.agent-os/rules/agents.md'],
      ]);
      const plan = await initAt(repo);
      expect(plan.canonical.rules.map((r) => r.id)).toEqual(['agents-2', 'agents']);
    } finally {
      await cleanup();
    }
  });

  it('never lets a source key canonical also defines change the rule after init', async () => {
    // agent-os adopts `.windsurf/rules/*.md` verbatim, and those carry `globs:` it ignores.
    // Carried under its own name, the key became a canonical scope the render never had,
    // and `order: 5` came back as the string "5", failing every later check.
    await setup();
    try {
      await put('.agent-os/config.json', JSON.stringify({ targets: ['cursor', 'windsurf'] }));
      await put(
        '.agent-os/rules/w.md',
        '---\ntrigger: glob\nglobs: src/**\norder: 5\ntools: cursor\ndescription: W\n---\n\nBody\n',
      );
      const plan = await initAt(repo);
      expect(plan.errors).toEqual([]);
      const rule = plan.canonical.rules.find((r) => r.id === 'w');
      expect(rule?.frontmatter.globs).toEqual([]);
      expect(rule?.frontmatter.tools).toEqual({ kind: 'all' });
      expect(rule?.frontmatter.unknown).toEqual({
        trigger: 'glob',
        'agent-os-globs': 'src/**',
        'agent-os-order': '5',
        'agent-os-tools': 'cursor',
      });
      expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);
      expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    } finally {
      await cleanup();
    }
  });

  it('keeps a block-list key and never lets a rename overwrite a key the author wrote', async () => {
    // The scalar-only rename dropped `globs:` written as a block list, and wrote the renamed
    // key over a literal `agent-os-globs:` — whichever came last won, in either order.
    await setup();
    try {
      await put('.agent-os/config.json', JSON.stringify({ targets: ['windsurf'] }));
      await put(
        '.agent-os/rules/a.md',
        '---\ntrigger: glob\nglobs:\n  - src/**\n  - "lib/**"\npaths:\n  - app/**\n---\n\nA\n',
      );
      await put(
        '.agent-os/rules/b.md',
        '---\nglobs: x\nagent-os-globs: y\ndescription: B\n---\n\nB\n',
      );
      await put(
        '.agent-os/rules/c.md',
        '---\nagent-os-globs: y\nglobs: x\ndescription: C\n---\n\nC\n',
      );
      const plan = await initAt(repo);
      expect(plan.errors).toEqual([]);
      const unknown = (id: string) => plan.canonical.rules.find((r) => r.id === id)?.frontmatter;
      expect(unknown('a')?.globs).toEqual(['app/**']);
      expect(unknown('a')?.unknown).toEqual({
        trigger: 'glob',
        'agent-os-globs': ['src/**', 'lib/**'],
      });
      expect(unknown('b')?.unknown).toEqual({ 'agent-os-globs-2': 'x', 'agent-os-globs': 'y' });
      expect(unknown('c')?.unknown).toEqual({ 'agent-os-globs': 'y', 'agent-os-globs-2': 'x' });
      expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);
      expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    } finally {
      await cleanup();
    }
  });

  it("reads a rule's fence exactly as agent-os does", async () => {
    // agent-os's `parseFrontmatter` needs a raw `---\n` start and a later `\n---\n`. A CRLF
    // or BOM file, or one ending on `---`, it compiled unscoped with the block as text; an
    // empty fence it stripped. Importing either differently changes what tools load.
    await setup();
    try {
      await put('.agent-os/config.json', JSON.stringify({ targets: ['claude-code'] }));
      await put('.agent-os/rules/crlf.md', '---\r\npaths:\r\n  - src/**\r\n---\r\n\r\nCRLF\r\n');
      await put('.agent-os/rules/bom.md', '\uFEFF---\npaths:\n  - src/**\n---\n\nBOM\n');
      await put('.agent-os/rules/eof.md', '---\npaths:\n  - src/**\ndescription: x\n---');
      await put('.agent-os/rules/empty.md', '---\n---\n\nEmpty fence\n');
      await put('.agent-os/rules/lf.md', '---\npaths:\n  - src/**\n---\n\nLF\n');
      const found = await readAt(repo);
      const rule = (id: string) => found.rules.find((r) => r.id === id);
      for (const id of ['crlf', 'bom', 'eof']) {
        expect(rule(id)?.frontmatter.globs).toEqual([]);
        expect(rule(id)?.body.startsWith('---\npaths:\n  - src/**\n')).toBe(true);
      }
      expect(rule('empty')?.body).toBe('Empty fence');
      expect(rule('lf')?.frontmatter.globs).toEqual(['src/**']);
      expect(rule('lf')?.body).toBe('LF');
      const flagged = (found.notes ?? [])
        .filter((n) => n.message.includes('did not read this frontmatter'))
        .map((n) => n.path);
      expect(flagged).toEqual([
        '.agent-os/rules/bom.md',
        '.agent-os/rules/crlf.md',
        '.agent-os/rules/eof.md',
      ]);
      expect(await runInit({ cwd: repo, yes: true, quiet: true })).toBe(ExitCode.Ok);
      expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    } finally {
      await cleanup();
    }
  });

  it('does not import from a repository without .agent-os/', async () => {
    const plan = await init('claude-code-import');
    expect(plan.interop).toEqual([]);
    expect(
      await agentOs.detect({
        repoRoot: path.join(fixtures, 'claude-code-import/input'),
        canonical: plan.canonical,
        fs: new NodeFileSystem(path.join(fixtures, 'claude-code-import/input')),
        options: {},
        apiVersion: 1 as const,
      }),
    ).toBe(false);
  });
});
