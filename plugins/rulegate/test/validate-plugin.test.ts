import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validatePlugin } from '../../../scripts/validate-plugin.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const AGENT = `---
name: feature-cartographer
description: Maps a feature once and remembers it.
memory: project
---

Body.
`;

let root: string;

async function put(rel: string, content: string | object): Promise<void> {
  const abs = path.join(root, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
}

/** A minimal repository the validator passes: one agent, one skill, one hook, one version. */
async function validRepo(version = '1.2.0'): Promise<void> {
  await put('plugins/rulegate/.claude-plugin/plugin.json', {
    name: 'rulegate',
    description: 'd',
    version,
  });
  await put('.claude-plugin/marketplace.json', {
    name: 'rulegate',
    owner: { name: 'o' },
    metadata: { version },
    plugins: [{ name: 'rulegate', source: './plugins/rulegate' }],
  });
  await put('packages/cli/package.json', { name: 'rulegate', version });
  await put('CHANGELOG.md', `# Changelog\n\n## [Unreleased]\n\n## [${version}] — unreleased\n`);
  await put('plugins/rulegate/agents/feature-cartographer.md', AGENT);
  await put(
    'plugins/rulegate/skills/map/SKILL.md',
    '---\nname: map\ndescription: Map a feature.\n---\n',
  );
  await put('plugins/rulegate/dist/pre-edit.js', '');
  await put('plugins/rulegate/hooks/hooks.json', {
    hooks: {
      PreToolUse: [
        { hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/dist/pre-edit.js"' }] },
      ],
    },
  });
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rulegate-validate-plugin-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('validate-plugin (T103)', () => {
  it('passes on this repository', () => {
    // The CI step runs the script; this keeps a red validator from first showing up there.
    expect(validatePlugin(repoRoot).failures).toEqual([]);
  });

  it('passes on a well-formed plugin', async () => {
    // The positive control: without it, every failure case below could be passing because
    // the validator fails on everything.
    await validRepo();
    const { ok, failures } = validatePlugin(root);
    expect(failures).toEqual([]);
    expect(ok).toContain('PreToolUse -> dist/pre-edit.js');
    expect(ok).toContain('agents/feature-cartographer.md: memory: project');
  });

  it('fails an agent whose frontmatter lost its closing delimiter', async () => {
    await validRepo();
    await put(
      'plugins/rulegate/agents/feature-cartographer.md',
      AGENT.replace('---\n\nBody', '\nBody'),
    );
    expect(validatePlugin(root).failures).toEqual([
      'agents/feature-cartographer.md: no closing --- delimiter',
    ]);
  });

  it('fails an agent without project-scoped memory', async () => {
    await validRepo();
    await put(
      'plugins/rulegate/agents/feature-cartographer.md',
      AGENT.replace('memory: project', 'memory: user'),
    );
    expect(validatePlugin(root).failures).toEqual([
      expect.stringContaining('agents/feature-cartographer.md: memory is "user"'),
    ]);
  });

  it('fails escaped unicode in frontmatter', async () => {
    await validRepo();
    await put(
      'plugins/rulegate/agents/feature-cartographer.md',
      AGENT.replace('once and', 'once \\u2014 and'),
    );
    expect(validatePlugin(root).failures).toEqual([
      expect.stringContaining('unicode escape sequence'),
    ]);
  });

  it('fails a hook whose script does not exist', async () => {
    await validRepo();
    await rm(path.join(root, 'plugins/rulegate/dist/pre-edit.js'));
    expect(validatePlugin(root).failures).toEqual([
      'PreToolUse -> dist/pre-edit.js does not exist',
    ]);
  });

  it('fails a hook that does not resolve under CLAUDE_PLUGIN_ROOT', async () => {
    await validRepo();
    await put('plugins/rulegate/hooks/hooks.json', {
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node dist/pre-edit.js' }] }] },
    });
    expect(validatePlugin(root).failures).toEqual([
      expect.stringContaining('does not use ${CLAUDE_PLUGIN_ROOT}'),
    ]);
  });

  it('fails a skill directory with no SKILL.md', async () => {
    await validRepo();
    await mkdir(path.join(root, 'plugins/rulegate/skills/memory'));
    expect(validatePlugin(root).failures).toEqual(['skills/memory: no SKILL.md']);
  });

  it('fails when the plugin and the CLI are released at different versions', async () => {
    await validRepo();
    await put('packages/cli/package.json', { name: 'rulegate', version: '1.3.0' });
    expect(validatePlugin(root).failures).toEqual([
      expect.stringContaining('plugin.json 1.2.0 vs packages/cli/package.json 1.3.0'),
    ]);
  });

  it('fails when the marketplace and the plugin disagree', async () => {
    await validRepo();
    await put('.claude-plugin/marketplace.json', {
      name: 'rulegate',
      metadata: { version: '1.1.0' },
      plugins: [{ name: 'rulegate', source: './plugins/rulegate' }],
    });
    expect(validatePlugin(root).failures).toEqual([
      'version drift: plugin.json 1.2.0 vs marketplace metadata 1.1.0',
    ]);
  });

  it('fails a version the changelog does not mention', async () => {
    await validRepo();
    await put('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n## [1.1.0]\n');
    expect(validatePlugin(root).failures).toEqual(['CHANGELOG.md has no "## [1.2.0]" section']);
  });

  it('fails a term from a local .leakcheck file', async () => {
    await validRepo();
    await put('.leakcheck', '# private identifiers\nacme-billing\n');
    await put('plugins/rulegate/skills/map/SKILL.md', '---\ndescription: Map acme-billing.\n---\n');
    expect(validatePlugin(root).failures).toEqual([
      'plugins/rulegate/skills/map/SKILL.md contains "acme-billing" — examples must be invented, not lifted from a real codebase',
    ]);
  });
});
