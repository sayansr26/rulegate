import { rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { planSettings } from '../src/lib/settings.js';
import { describeState, setupState } from '../src/lib/state.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  await sb.dispose();
});

const missing = async (root: string, claudeDir: string, expect?: string): Promise<string[]> =>
  (await setupState(root, claudeDir, { expect })).missing.map((i) => i.key);

/** Everything a set-up project has: the positive control for every REPAIR case below. */
async function healthy(version = '0.3.0'): Promise<void> {
  const protectedSettings = planSettings(undefined).next!;
  await sb.put('.rulegate/rulegate.yaml', 'schemaVersion: 1\n');
  await sb.put(
    'CLAUDE.md',
    '# P\n\n- Ask `rulegate:feature-cartographer` first.\n- Track with TaskCreate.\n',
  );
  await sb.put('.claude/settings.json', protectedSettings);
  await sb.putHome('settings.json', protectedSettings);
  await sb.putHome('plugins/installed_plugins.json', {
    plugins: { 'rulegate@rulegate': [{ scope: 'project', projectPath: sb.root, version }] },
  });
}

describe('setupState (T106)', () => {
  it('is FRESH on a project with nothing of the plugin in it', async () => {
    expect((await setupState(sb.root, sb.claudeDir)).status).toBe('fresh');
  });

  it('stays FRESH when only .rulegate/ exists — the CLI in use is not the plugin set up', async () => {
    await sb.put('.rulegate/rulegate.yaml', 'schemaVersion: 1\n');
    expect((await setupState(sb.root, sb.claudeDir)).status).toBe('fresh');
  });

  it('is HEALTHY when every item is in place', async () => {
    await healthy();
    const st = await setupState(sb.root, sb.claudeDir, { expect: '0.3.0' });
    expect(st.missing).toEqual([]);
    expect(st.status).toBe('healthy');
    expect(describeState(st)[0]).toBe('SETUP  HEALTHY');
  });

  it('is REPAIR, naming only what is missing', async () => {
    await healthy();
    await sb.putHome('settings.json', {});
    expect((await setupState(sb.root, sb.claudeDir)).status).toBe('repair');
    expect(await missing(sb.root, sb.claudeDir)).toEqual(['user-git', 'user-todo']);
  });

  it('wants the task rule in .rulegate/rules/, not the generated CLAUDE.md', async () => {
    await healthy();
    await sb.put('CLAUDE.md', '# P\n\n- Ask `rulegate:builder`.\n');
    const item = (await setupState(sb.root, sb.claudeDir)).items.find((i) => i.key === 'task-rule');
    expect(item).toMatchObject({
      ok: false,
      label: 'task-tracking rule (.rulegate/rules/working-agreement.md)',
    });
  });

  it('sends an existing working-agreement.md to a hand edit, not back to the settings pass', async () => {
    // The writer refuses to replace a canonical rule the user wrote, so pointing at
    // `/rulegate:init settings` would loop: the pass would refuse again, every time.
    await healthy();
    await sb.put('CLAUDE.md', '# P\n\n- Ask `rulegate:builder`.\n');
    await sb.put('.rulegate/rules/working-agreement.md', '---\ndescription: mine\n---\n\nx\n');
    const item = (await setupState(sb.root, sb.claudeDir)).items.find((i) => i.key === 'task-rule');
    expect(item?.ok).toBe(false);
    expect(item?.fix).toMatch(/by hand.*rulegate sync/);
    expect(item?.fix).not.toMatch(/\/rulegate:init/);
  });

  it.skipIf(process.platform === 'win32')(
    'sends a target the writer refuses to a hand fix, not back to the settings pass',
    async () => {
      // A dotfiles-linked ~/.claude/settings.json: the writer refuses it on every run, so
      // `/rulegate:init settings` as the fix would loop exactly as `exists` did.
      await healthy();
      await sb.putHome('dots/settings.json', '{}\n');
      await rm(path.join(sb.claudeDir, 'settings.json'));
      await symlink('dots/settings.json', path.join(sb.claudeDir, 'settings.json'));
      const st = await setupState(sb.root, sb.claudeDir);
      const git = st.items.find((i) => i.key === 'user-git');
      expect(git?.ok).toBe(false);
      expect(git?.fix).toMatch(/refuses this — a symlink/);
      expect(st.missing.map((i) => i.fix).join('\n')).not.toMatch(/\/rulegate:init settings/);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does the same for a task rule whose CLAUDE.md is a symlink',
    async () => {
      await healthy();
      await rm(path.join(sb.root, '.rulegate'), { recursive: true });
      await sb.put('AGENTS.md', '# P\n\n- Ask `rulegate:builder`.\n');
      await rm(path.join(sb.root, 'CLAUDE.md'));
      await symlink('AGENTS.md', path.join(sb.root, 'CLAUDE.md'));
      const item = (await setupState(sb.root, sb.claudeDir)).items.find(
        (i) => i.key === 'task-rule',
      );
      expect(item?.ok).toBe(false);
      expect(item?.fix).toMatch(/refuses this — CLAUDE\.md is a symlink/);
    },
  );

  it('flags an old plugin version against the version this script ships in', async () => {
    await healthy('0.2.0');
    expect(await missing(sb.root, sb.claudeDir, '0.3.0')).toEqual(['plugin-version']);
  });

  it('flags a plugin installed for another project as not installed here', async () => {
    await healthy();
    await sb.putHome('plugins/installed_plugins.json', {
      plugins: {
        'rulegate@rulegate': [{ scope: 'project', projectPath: '/elsewhere', version: '0.3.0' }],
      },
    });
    expect(await missing(sb.root, sb.claudeDir)).toEqual(['plugin']);
  });

  it('flags an agent-os plugin still enabled beside this one', async () => {
    await healthy();
    await sb.put('.claude/settings.local.json', {
      enabledPlugins: { 'agent-os@sayan-plugins': true },
    });
    expect(await missing(sb.root, sb.claudeDir)).toEqual(['legacy-plugin']);
  });

  it('reports invalid settings JSON instead of throwing', async () => {
    await healthy();
    await sb.put('.claude/settings.json', '{ nope');
    expect(await missing(sb.root, sb.claudeDir)).toContain('project-settings');
  });
});
