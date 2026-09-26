import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentOsInstall, disableCommand } from '../src/lib/legacy.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  await sb.dispose();
});

const enable = (value: boolean): object => ({
  enabledPlugins: { 'agent-os@sayan-plugins': value },
});

describe('agentOsInstall (T114)', () => {
  it('finds nothing in a project agent-os never touched', () => {
    expect(agentOsInstall(sb.root, sb.claudeDir)).toMatchObject({
      plugin: undefined,
      memory: [],
      source: false,
      marketplace: false,
      found: false,
    });
  });

  it('names the most local settings file that enables agent-os', async () => {
    await sb.putHome('settings.json', enable(true));
    expect(agentOsInstall(sb.root, sb.claudeDir).plugin).toBe('user');
    await sb.put('.claude/settings.json', enable(true));
    expect(agentOsInstall(sb.root, sb.claudeDir).plugin).toBe('project');
  });

  it('treats a local false as disabled here, whatever the user file says', async () => {
    await sb.putHome('settings.json', enable(true));
    await sb.put('.claude/settings.local.json', enable(false));
    const found = agentOsInstall(sb.root, sb.claudeDir);
    expect(found.plugin).toBeUndefined();
    expect(found.bothEnabled).toBe(false);
  });

  it('says both plugins are enabled unless rulegate is explicitly off', async () => {
    await sb.putHome('settings.json', enable(true));
    expect(agentOsInstall(sb.root, sb.claudeDir).bothEnabled).toBe(true);
    await sb.put('.claude/settings.local.json', { enabledPlugins: { 'rulegate@rulegate': false } });
    expect(agentOsInstall(sb.root, sb.claudeDir).bothEnabled).toBe(false);
  });

  it('lists agent-os memory at both bases, and marks one whose rulegate twin exists', async () => {
    await sb.put('.claude/agent-memory/agent-os-reviewer/MEMORY.md', '');
    await sb.put('.claude/agent-memory/rulegate-reviewer/MEMORY.md', '');
    await sb.put('.claude/agent-memory-local/agent-os-builder/MEMORY.md', '');
    await sb.put('.claude/agent-memory/agent-os-notes.md', 'a file, not an agent');
    expect(agentOsInstall(sb.root, sb.claudeDir).memory).toEqual([
      {
        base: '.claude/agent-memory',
        name: 'agent-os-reviewer',
        target: 'rulegate-reviewer',
        split: true,
      },
      {
        base: '.claude/agent-memory-local',
        name: 'agent-os-builder',
        target: 'rulegate-builder',
        split: false,
      },
    ]);
  });

  it('calls .agent-os/ imported once .rulegate/ exists beside it', async () => {
    await sb.put('.agent-os/config.json', '{}');
    expect(agentOsInstall(sb.root, sb.claudeDir)).toMatchObject({ source: true, imported: false });
    await sb.put('.rulegate/rulegate.yaml', 'schemaVersion: 1\n');
    expect(agentOsInstall(sb.root, sb.claudeDir)).toMatchObject({ source: true, imported: true });
  });

  it("notices agent-os's marketplace in the project settings only", async () => {
    const markets = { extraKnownMarketplaces: { 'sayan-plugins': { source: {} } } };
    await sb.putHome('settings.json', markets);
    expect(agentOsInstall(sb.root, sb.claudeDir).marketplace).toBe(false);
    await sb.put('.claude/settings.json', markets);
    expect(agentOsInstall(sb.root, sb.claudeDir)).toMatchObject({ marketplace: true, found: true });
  });
});

describe('disableCommand', () => {
  it('always passes a scope, and never user — that would reach every project', () => {
    expect(disableCommand('user')).toBe(
      'claude plugin disable agent-os@sayan-plugins --scope local',
    );
    expect(disableCommand('local')).toBe(
      'claude plugin disable agent-os@sayan-plugins --scope local',
    );
    expect(disableCommand('project')).toBe(
      'claude plugin disable agent-os@sayan-plugins --scope project',
    );
  });
});
