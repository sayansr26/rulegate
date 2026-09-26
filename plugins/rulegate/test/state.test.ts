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

const missing = (root: string, claudeDir: string, expect?: string): string[] =>
  setupState(root, claudeDir, { expect }).missing.map((i) => i.key);

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
  it('is FRESH on a project with nothing of the plugin in it', () => {
    expect(setupState(sb.root, sb.claudeDir).status).toBe('fresh');
  });

  it('stays FRESH when only .rulegate/ exists — the CLI in use is not the plugin set up', async () => {
    await sb.put('.rulegate/rulegate.yaml', 'schemaVersion: 1\n');
    expect(setupState(sb.root, sb.claudeDir).status).toBe('fresh');
  });

  it('is HEALTHY when every item is in place', async () => {
    await healthy();
    const st = setupState(sb.root, sb.claudeDir, { expect: '0.3.0' });
    expect(st.missing).toEqual([]);
    expect(st.status).toBe('healthy');
    expect(describeState(st)[0]).toBe('SETUP  HEALTHY');
  });

  it('is REPAIR, naming only what is missing', async () => {
    await healthy();
    await sb.putHome('settings.json', {});
    expect(setupState(sb.root, sb.claudeDir).status).toBe('repair');
    expect(missing(sb.root, sb.claudeDir)).toEqual(['user-git', 'user-todo']);
  });

  it('wants the task rule in .rulegate/rules/, not the generated CLAUDE.md', async () => {
    await healthy();
    await sb.put('CLAUDE.md', '# P\n\n- Ask `rulegate:builder`.\n');
    const item = setupState(sb.root, sb.claudeDir).items.find((i) => i.key === 'task-rule');
    expect(item).toMatchObject({
      ok: false,
      label: 'task-tracking rule (.rulegate/rules/working-agreement.md)',
    });
  });

  it('flags an old plugin version against the version this script ships in', async () => {
    await healthy('0.2.0');
    expect(missing(sb.root, sb.claudeDir, '0.3.0')).toEqual(['plugin-version']);
  });

  it('flags a plugin installed for another project as not installed here', async () => {
    await healthy();
    await sb.putHome('plugins/installed_plugins.json', {
      plugins: {
        'rulegate@rulegate': [{ scope: 'project', projectPath: '/elsewhere', version: '0.3.0' }],
      },
    });
    expect(missing(sb.root, sb.claudeDir)).toEqual(['plugin']);
  });

  it('flags an agent-os plugin still enabled beside this one', async () => {
    await healthy();
    await sb.put('.claude/settings.local.json', {
      enabledPlugins: { 'agent-os@sayan-plugins': true },
    });
    expect(missing(sb.root, sb.claudeDir)).toEqual(['legacy-plugin']);
  });

  it('reports invalid settings JSON instead of throwing', async () => {
    await healthy();
    await sb.put('.claude/settings.json', '{ nope');
    expect(missing(sb.root, sb.claudeDir)).toContain('project-settings');
  });
});
