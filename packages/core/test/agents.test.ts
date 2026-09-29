import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/io/memory.js';
import { parse } from '../src/parse/index.js';
import { parseAgentFile, parseAgents } from '../src/parse/agents.js';
import { serializeAgent } from '../src/model/serialize.js';
import { ALL_TOOLS } from '../src/model/selector.js';

/** T054: canonical agents (RFC-0001 §14) parse, validate and round-trip without loss. */

const DIR = '.rulegate/agents';
const parseFiles = (files: [string, string][]) =>
  parseAgents(new MemoryFileSystem(files.map(([p, c]) => [`${DIR}/${p}`, c])), '');
const messages = (r: { errors: readonly { code: string; message: string }[] }) =>
  r.errors.map((e) => `${e.code} ${e.message}`);

describe('canonical agents (T054)', () => {
  it('reads an agent, keeps `tools` as its allowlist and `adapters` as the selector, and round-trips', async () => {
    const text =
      '---\nname: reviewer\ndescription: Reviews a diff for risks. Use after a change.\ntools: Read, Grep, Glob\nmodel: sonnet\nadapters:\n  - claude-code\n  - gemini\n---\n\nYou review diffs. List every risk with its file.\n';
    const r = await parseFiles([['reviewer.md', text]]);
    expect(r.errors).toEqual([]);
    const [agent] = r.agents;
    expect(agent!.id).toBe('reviewer');
    expect(agent!.adapters).toEqual({ kind: 'include', tools: ['claude-code', 'gemini'] });
    expect(agent!.frontmatter.map(([k]) => k)).toEqual([
      'name',
      'description',
      'tools',
      'model',
      'adapters',
    ]);
    expect(serializeAgent(agent!)).toBe(text);
  });

  it('defaults to every adapter', async () => {
    const r = await parseFiles([['a.md', '---\nname: a\ndescription: A.\n---\n\nDo A.\n']]);
    expect(r.agents[0]!.adapters).toEqual(ALL_TOOLS);
  });

  it('requires a name matching the file, a description and frontmatter', async () => {
    const r = await parseFiles([
      ['no-name.md', '---\ndescription: D.\n---\n\nB.\n'],
      ['other.md', '---\nname: renamed\ndescription: D.\n---\n\nB.\n'],
      ['no-desc.md', '---\nname: no-desc\n---\n\nB.\n'],
      ['bare.md', 'Just a prompt.\n'],
    ]);
    expect(messages(r)).toEqual([
      'E_AGENT_INVALID an agent has no frontmatter',
      'E_AGENT_INVALID `description` is required',
      'E_AGENT_INVALID `name` is required',
      'E_AGENT_INVALID `name` is `renamed` but the file is `other.md`; they must match',
    ]);
    expect(r.agents).toEqual([]);
  });

  it('refuses a folder, a file that is not Markdown, and a restriction no tool can read', async () => {
    const ok = '---\nname: x\ndescription: D.\n---\n\nB.\n';
    const r = await parseFiles([
      ['team/x.md', ok],
      ['notes.txt', 'x'],
      ['odd.md', '---\nname: odd\ndescription: D.\ntools: { Read: true }\n---\n\nB.\n'],
    ]);
    expect(messages(r)).toEqual([
      'E_AGENT_INVALID .rulegate/agents/notes.txt is not an agent',
      'E_AGENT_INVALID `tools` must be a comma-separated string or a list of tool names',
      'E_AGENT_INVALID agents cannot be grouped in folders: .rulegate/agents/team/',
    ]);
  });

  it('when importing, takes the id from `name`, or from the file when there is none', () => {
    const named = parseAgentFile(
      '---\nname: reviewer\ndescription: D.\n---\n\nB.\n',
      '.claude/agents/code-reviewer.md',
      'code-reviewer',
      { importing: true },
    );
    expect(named.agent!.id).toBe('reviewer');
    const unnamed = parseAgentFile(
      '---\ndescription: D.\n---\n\nB.\n',
      '.opencode/agents/fix.md',
      'fix',
      {
        importing: true,
      },
    );
    expect(unnamed.agent!.id).toBe('fix');
    expect(unnamed.agent!.frontmatter[0]).toEqual(['name', 'fix']);
  });

  it('is part of the canonical model `parse` returns', async () => {
    const result = await parse({
      fs: new MemoryFileSystem([
        ['.rulegate/rulegate.yaml', 'schemaVersion: 1\n'],
        [`${DIR}/a.md`, '---\nname: a\ndescription: A.\n---\n\nDo A.\n'],
      ]),
    });
    expect(result.errors).toEqual([]);
    expect(result.canonical.agents.map((a) => a.id)).toEqual(['a']);
    expect(result.sourceFiles).toContain(`${DIR}/a.md`);
  });
});
