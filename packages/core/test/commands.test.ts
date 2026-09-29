import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/io/memory.js';
import { parse } from '../src/parse/index.js';
import { parseCommands } from '../src/parse/commands.js';
import { serializeCommand } from '../src/model/serialize.js';
import { ALL_TOOLS } from '../src/model/selector.js';

/**
 * T053: canonical commands (RFC-0001 §13) parse, validate and round-trip without loss.
 */

const DIR = '.rulegate/commands';
const parseFiles = (files: [string, string][]) =>
  parseCommands(new MemoryFileSystem(files.map(([p, c]) => [`${DIR}/${p}`, c])), '');
const messages = (r: Awaited<ReturnType<typeof parseFiles>>) =>
  r.errors.map((e) => `${e.code} ${e.message}`);

describe('canonical commands (T053)', () => {
  it('reads a command, keeps every key in order, and serialises it back byte for byte', async () => {
    const text =
      '---\ndescription: Review the open pull request.\nargument-hint: "[pr-number]"\nmodel: sonnet\ntools:\n  - claude-code\n  - gemini\n---\n\nReview PR $ARGUMENTS and list risks.\n';
    const r = await parseFiles([['review.md', text]]);
    expect(r.errors).toEqual([]);
    expect(r.sourceFiles).toEqual([`${DIR}/review.md`]);
    const [command] = r.commands;
    expect(command!.id).toBe('review');
    expect(command!.description).toBe('Review the open pull request.');
    expect(command!.tools).toEqual({ kind: 'include', tools: ['claude-code', 'gemini'] });
    expect(command!.frontmatter.map(([k]) => k)).toEqual([
      'description',
      'argument-hint',
      'model',
      'tools',
    ]);
    expect(serializeCommand(command!)).toBe(text);
  });

  it('defaults to every tool, and sorts by id', async () => {
    const md = (d: string) => `---\ndescription: ${d}\n---\n\nDo it.\n`;
    const r = await parseFiles([
      ['ship.md', md('Ship.')],
      ['build.md', md('Build.')],
    ]);
    expect(r.commands.map((c) => c.id)).toEqual(['build', 'ship']);
    expect(r.commands[0]!.tools).toEqual(ALL_TOOLS);
  });

  it('requires a description and frontmatter', async () => {
    const r = await parseFiles([
      ['a.md', '---\nargument-hint: x\n---\n\nBody.\n'],
      ['b.md', 'Just a body.\n'],
    ]);
    expect(messages(r)).toEqual([
      'E_COMMAND_INVALID `description` is required',
      'E_COMMAND_INVALID a command has no frontmatter',
    ]);
    expect(r.commands).toEqual([]);
  });

  it('refuses an invalid name, a folder and a file that is not Markdown', async () => {
    const ok = '---\ndescription: D.\n---\n\nB.\n';
    const r = await parseFiles([
      ['Deploy.md', ok],
      ['team/deploy.md', ok],
      ['notes.txt', 'x'],
    ]);
    expect(messages(r)).toEqual([
      'E_COMMAND_INVALID command name `Deploy` is not valid',
      'E_COMMAND_INVALID .rulegate/commands/notes.txt is not a command',
      'E_COMMAND_INVALID commands cannot be grouped in folders: .rulegate/commands/team/',
    ]);
  });

  it('refuses a positional placeholder unless `tools:` names one tool', async () => {
    const body = 'Compare $1 with $ARGUMENTS[2].\n';
    const r = await parseFiles([
      ['everyone.md', `---\ndescription: D.\n---\n\n${body}`],
      ['two.md', `---\ndescription: D.\ntools: [claude-code, opencode]\n---\n\n${body}`],
      ['one.md', `---\ndescription: D.\ntools: [claude-code]\n---\n\n${body}`],
    ]);
    expect(messages(r)).toEqual([
      'E_COMMAND_INVALID `$1` means a different argument in different tools: Claude Code counts from $0, OpenCode from $1',
      'E_COMMAND_INVALID `$1` means a different argument in different tools: Claude Code counts from $0, OpenCode from $1',
    ]);
    expect(r.errors.map((e) => e.source?.file)).toEqual([`${DIR}/everyone.md`, `${DIR}/two.md`]);
    expect(r.commands.map((c) => c.id)).toEqual(['one']);
  });

  it('accepts $ARGUMENTS anywhere, including as a whole token next to punctuation', async () => {
    const r = await parseFiles([
      ['fix.md', '---\ndescription: D.\n---\n\nFix issue #$ARGUMENTS, then ($ARGUMENTS).\n'],
    ]);
    expect(r.errors).toEqual([]);
  });

  it('is part of the canonical model `parse` returns, and absent without the folder', async () => {
    const manifest: [string, string] = ['.rulegate/rulegate.yaml', 'schemaVersion: 1\n'];
    const withCommands = await parse({
      fs: new MemoryFileSystem([
        manifest,
        [`${DIR}/ship.md`, '---\ndescription: Ship.\n---\n\nGo.\n'],
      ]),
    });
    expect(withCommands.errors).toEqual([]);
    expect(withCommands.canonical.commands.map((c) => c.id)).toEqual(['ship']);
    expect(withCommands.sourceFiles).toContain(`${DIR}/ship.md`);

    const without = await parse({ fs: new MemoryFileSystem([manifest]) });
    expect(without.canonical.commands).toEqual([]);
  });
});
