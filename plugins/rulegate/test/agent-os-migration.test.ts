import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAudit } from '../src/lib/audit.js';
import { contract } from '../src/lib/session.js';
import { coverage } from '../src/lib/features.js';
import { KEPT_INDEX, keptPointer, planMemoryMigration } from '../src/lib/migrate.js';
import { describeScope, planTaskRule, TASK_RULE_FILE } from '../src/lib/settings.js';
import { describeState, setupState } from '../src/lib/state.js';
import { applyMemoryMigration } from '../src/migrate/memory.js';
import { applyScope, BACKUP_SUFFIX } from '../src/settings-writer/apply.js';
import { buildProgram } from 'rulegate';
import { sandbox, type Sandbox } from './helpers.js';

/**
 * T114's acceptance test: an agent-os project, migrated the way `/rulegate:init` migrates
 * it, ends `SETUP HEALTHY` with every map under its new name.
 *
 * `fixtures/agent-os-project/` holds three layers, copied into a sandbox whose project root
 * and Claude config dir are separate temp directories — nothing here reaches the real
 * `~/.claude`:
 *
 *   repo/          the project as agent-os left it: `.agent-os/`, bannered generated files,
 *                  maps under `agent-os-*` (one agent already has a `rulegate-*` twin),
 *                  a project settings file that declares agent-os's marketplace
 *   claude-home/   agent-os and rulegate both enabled and installed at user scope
 *   after-import/  what `npx rulegate init --yes` plus the skill's agents and task rules
 *                  leave, rendered by `rulegate sync`; its `.rulegate/` is committed as
 *                  `rulegate-source/`, and the second test holds it to the real CLI's output
 *
 * The steps are the skill's, in its order, with `claude plugin disable --scope local`
 * standing in as the one line it writes — the test never spawns `claude`.
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/agent-os-project/', import.meta.url));
const VERSION = '0.3.0';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
  await cp(path.join(FIXTURE, 'repo'), sb.root, { recursive: true });
  await cp(path.join(FIXTURE, 'claude-home'), sb.claudeDir, { recursive: true });
});
afterEach(async () => {
  await sb.dispose();
});

/** Every file under `dir`, relative, sorted. */
async function files(dir: string, rel = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...(await files(dir, r)));
    else out.push(r);
  }
  return out.sort();
}

const audit = async (): Promise<string> =>
  (
    await runAudit({ root: sb.root, claudeDir: sb.claudeDir, today: '2026-09-26', expect: VERSION })
  ).join('\n');

/** Each agent-os memory directory in the fixture, and where its files must end up. */
const MOVES = [
  ['.claude/agent-memory', 'agent-os-feature-cartographer', 'rulegate-feature-cartographer'],
  ['.claude/agent-memory', 'agent-os-reviewer', 'rulegate-reviewer'],
  ['.claude/agent-memory-local', 'agent-os-builder', 'rulegate-builder'],
] as const;

describe('migrating an agent-os project (T114)', () => {
  it('ends SETUP HEALTHY with every map under the new name', async () => {
    // ---- before: an agent-os project is a repair, not a fresh setup
    const before = await setupState(sb.root, sb.claudeDir, { expect: VERSION });
    expect(before.status).toBe('repair');
    expect(before.missing.map((i) => i.key)).toEqual(
      expect.arrayContaining([
        'source',
        'agents-section',
        'legacy-plugin',
        'legacy-memory',
        'legacy-marketplace',
      ]),
    );
    const legacyPlugin = before.missing.find((i) => i.key === 'legacy-plugin');
    expect(legacyPlugin?.fix).toBe('claude plugin disable agent-os@sayan-plugins --scope local');
    const pre = await audit();
    expect(pre).toContain('FAIL  agent-os@sayan-plugins is still enabled — both plugins enabled');
    expect(pre).toContain('--scope local');
    expect(pre).toMatch(
      /WARN {2}\.claude\/agent-memory\/agent-os-reviewer and rulegate-reviewer both exist/,
    );
    expect(
      (await contract({ root: sb.root, claudeDir: sb.claudeDir, now: 0 })).join('\n'),
    ).toContain('`claude plugin disable agent-os@sayan-plugins --scope local`');

    const seeded = new Map<string, Buffer>();
    for (const [base, from] of MOVES) {
      for (const f of await files(path.join(sb.root, base, from))) {
        seeded.set(`${base}/${from}/${f}`, await readFile(path.join(sb.root, base, from, f)));
      }
    }
    const reviewerIndex = await readFile(
      path.join(sb.root, '.claude/agent-memory/rulegate-reviewer/MEMORY.md'),
      'utf8',
    );

    // ---- (a) memory: preview, then apply
    const preview = await planMemoryMigration(sb.root, sb.claudeDir);
    expect(preview.agents.map((a) => [a.from, a.kind])).toEqual([
      ['agent-os-feature-cartographer', 'move'],
      ['agent-os-reviewer', 'merge'],
      ['agent-os-builder', 'move'],
    ]);
    const moved = await applyMemoryMigration(sb.root, sb.claudeDir);
    expect(moved.failed).toEqual([]);
    expect(moved.moved).toHaveLength(3);

    // ---- (b) `npx rulegate init --yes` for .agent-os/, then the skill's rules and sync
    // The canonical dir is committed as `rulegate-source/`: a `.rulegate/` under this
    // repository would be a nested level of its own dogfood, which `sync` would render into.
    const overlay = path.join(FIXTURE, 'after-import');
    await cp(path.join(overlay, 'rulegate-source'), path.join(sb.root, '.rulegate'), {
      recursive: true,
    });
    for (const f of await files(overlay)) {
      if (!f.startsWith('rulegate-source/')) await cp(path.join(overlay, f), path.join(sb.root, f));
    }

    // ---- (c) the disable, exactly what `claude plugin disable … --scope local` writes
    await sb.put('.claude/settings.local.json', {
      enabledPlugins: { 'agent-os@sayan-plugins': false },
    });
    // …then the settings pass, which now retires agent-os's marketplace
    const settings = await applyScope('project', sb.root, sb.claudeDir);
    expect(settings.refused).toEqual([]);
    expect(describeScope(settings.plan, { dry: false }).join('\n')).toContain(
      'extraKnownMarketplaces  replaced sayan-plugins (agent-os) with rulegate',
    );
    const project = JSON.parse(
      await readFile(path.join(sb.root, '.claude/settings.json'), 'utf8'),
    ) as { extraKnownMarketplaces: Record<string, unknown> };
    expect(project.extraKnownMarketplaces).toEqual({
      rulegate: { source: { source: 'github', repo: 'sayansr26/rulegate' } },
    });
    expect(existsSync(path.join(sb.root, `.claude/settings.json${BACKUP_SUFFIX}`))).toBe(true);

    // ---- after
    const after = await setupState(sb.root, sb.claudeDir, { expect: VERSION });
    expect(after.missing).toEqual([]);
    expect(after.status).toBe('healthy');
    expect(describeState(after)[0]).toBe('SETUP  HEALTHY');

    // Every seeded file, byte for byte, under its new name — the one index both agents
    // wrote is the union, the rulegate lines first, and agent-os's side is kept whole.
    for (const [key, bytes] of seeded) {
      const moved = MOVES.reduce(
        (k, [base, from, to]) => k.replace(`${base}/${from}/`, `${base}/${to}/`),
        key,
      );
      const now = await readFile(path.join(sb.root, moved));
      if (moved === '.claude/agent-memory/rulegate-reviewer/MEMORY.md') {
        // The pointer to the kept index leads the entries, inside the 200 lines that load.
        expect(now.toString()).toBe(
          `${reviewerIndex.replace('\n\n', `\n\n${keptPointer(KEPT_INDEX)}\n`)}- [patterns](patterns.md) — review findings that keep recurring\n`,
        );
        const kept = await readFile(
          path.join(sb.root, '.claude/agent-memory/rulegate-reviewer/MEMORY.agent-os.md'),
        );
        expect(kept.equals(bytes)).toBe(true);
      } else {
        expect(now.equals(bytes), moved).toBe(true);
      }
    }
    for (const base of ['.claude/agent-memory', '.claude/agent-memory-local']) {
      expect(
        (await readdir(path.join(sb.root, base))).filter((d) => d.startsWith('agent-os-')),
      ).toEqual([]);
    }

    const cov = await coverage(sb.root);
    expect(cov.dir).toBe(path.join(sb.root, '.claude/agent-memory/rulegate-feature-cartographer'));
    expect(cov.mapped.map((f) => f.name)).toEqual(['auth', 'billing']);
    expect(cov.architecture).toBe(true);

    const post = await audit();
    expect(post).not.toContain('agent-os@sayan-plugins is still enabled');
    expect(post).not.toContain("agent-os's memory");
    expect(post).toContain('.agent-os/ is already imported into .rulegate/ — safe to delete');
    expect(post).toContain('SETUP  HEALTHY');

    // A second run of the migrator has nothing to do.
    expect((await planMemoryMigration(sb.root, sb.claudeDir)).agents).toEqual([]);
  });

  it('lays down exactly what the real `rulegate init --yes` and the skill leave', async () => {
    // The overlay above is committed so that test runs without the CLI; this one is what
    // keeps it honest. Without it the overlay is whatever the plugin assumed the import
    // does, and the migration could pass against an init that never produces that tree.
    const rulegate = async (...args: string[]): Promise<void> => {
      await buildProgram().parseAsync(['--cwd', sb.root, '--quiet', '--no-color', ...args], {
        from: 'user',
      });
      const code = process.exitCode;
      process.exitCode = undefined;
      expect(code ?? 0, `rulegate ${args.join(' ')}`).toBe(0);
    };
    const rules = path.join(sb.root, '.rulegate/rules');

    await rulegate('init', '--yes');
    // establishing.md Step 4b on a migrated project: agent-os's agents section is already
    // in the rule imported from CLAUDE.md, and is rewritten there rather than added twice.
    const claude = await readFile(path.join(rules, 'claude.md'), 'utf8');
    expect(claude).toContain('## Agents in this project (agent-os)');
    await writeFile(
      path.join(rules, 'claude.md'),
      claude
        .replace('## Agents in this project (agent-os)', '## Agents in this project')
        .replaceAll('`agent-os:', '`rulegate:'),
    );
    // The settings pass's task rule, as it plans it for a Rulegate project.
    const task = planTaskRule('project', sb.root, sb.claudeDir);
    expect(task.status).toBe('add');
    await writeFile(path.join(sb.root, TASK_RULE_FILE), task.next ?? '');
    await rulegate('sync');
    await rulegate('check');

    const overlay = path.join(FIXTURE, 'after-import');
    const source = path.join(overlay, 'rulegate-source');
    // backup/ holds `repo/`'s own bytes, which the fixture already has.
    const made = (await files(path.join(sb.root, '.rulegate'))).filter(
      (f) => !f.startsWith('backup/'),
    );
    expect(made).toEqual(await files(source));
    for (const f of made) {
      expect(await readFile(path.join(sb.root, '.rulegate', f), 'utf8'), f).toBe(
        await readFile(path.join(source, f), 'utf8'),
      );
    }
    // Every file the overlay lays over the project is one Rulegate generated, and all of them.
    const state = JSON.parse(await readFile(path.join(source, 'state.json'), 'utf8')) as {
      artifacts: { path: string }[];
    };
    const generated = (await files(overlay)).filter((f) => !f.startsWith('rulegate-source/'));
    expect(generated).toEqual(state.artifacts.map((a) => a.path).sort());
    for (const f of generated) {
      expect(await readFile(path.join(sb.root, f), 'utf8'), f).toBe(
        await readFile(path.join(overlay, f), 'utf8'),
      );
    }
  });

  it('keeps the settings pass off the marketplace while agent-os is still enabled', async () => {
    // Pulling the marketplace from under a plugin that is still loading is how a session
    // ends up with neither; the disable comes first.
    const early = await applyScope('project', sb.root, sb.claudeDir);
    expect(early.plan.settings.marketplace).toBe('blocked');
    expect(early.written).not.toContain(path.join(sb.root, '.claude/settings.json'));
    const project = await readFile(path.join(sb.root, '.claude/settings.json'), 'utf8');
    expect(project).toContain('sayan-plugins');
  });
});
