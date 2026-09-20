import { describe, expect, it } from 'vitest';
import { expectContentCovered, expectImportMatch } from '@rulegate/adapter-kit/testing';
import { cursor } from '../src/index.js';
import { parseMdc } from '../src/mdc.js';

describe('cursor read() (T017)', () => {
  it('imports the fixture repo into the expected canonical rules', async () => {
    await expectImportMatch('cursor', cursor);
  });

  it('loses no user content, including the legacy file', async () => {
    await expectContentCovered('cursor', cursor, [
      '.cursor/rules/10-style.mdc',
      '.cursor/rules/30-frontend.mdc',
      '.cursorrules',
    ]);
  });
});

/**
 * T099, found on a real Python repository during the T032 rehearsals.
 *
 * Cursor's docs show `globs` as a bare comma-joined string, as a flow sequence and as a
 * quoted flow sequence, and a repository carries whichever one its author copied. The flow
 * forms used to import as a *single* glob whose text was the sequence syntax itself, so a
 * rule scoped to Python files matched nothing — while `init` said it succeeded and `check`
 * said the repository was in sync.
 *
 * These are unit tests on the parser rather than fixtures, because the fixture corpus is
 * what missed it: a Cursor-only round trip reproduced the original bytes by coincidence, so
 * a golden could hold the broken value and still pass.
 */
describe('cursor .mdc globs, in every spelling Cursor accepts (T099)', () => {
  it.each([
    ['bare comma-joined', 'globs: **/*.py,src/**/*.ts'],
    ['flow sequence', 'globs: ["**/*.py", "src/**/*.ts"]'],
    ['single-quoted flow sequence', "globs: ['**/*.py', 'src/**/*.ts']"],
    ['unquoted flow sequence', 'globs: [**/*.py, src/**/*.ts]'],
  ])('reads a %s into the same two globs', (_label, line) => {
    const parsed = parseMdc(
      ['---', 'description: Style', line, 'alwaysApply: false', '---', '', 'Body.'].join('\n'),
    );
    expect(parsed.globs).toEqual(['**/*.py', 'src/**/*.ts']);
  });

  it('still reads one bare glob, and still reads none', () => {
    // The controls. A single glob has no comma and no brackets, and an empty `globs:` is a
    // bare key — the spelling the adapter itself writes for a repo-wide rule.
    expect(parseMdc(['---', 'globs: src/**/*.tsx', '---', ''].join('\n')).globs).toEqual([
      'src/**/*.tsx',
    ]);
    expect(parseMdc(['---', 'globs:', '---', ''].join('\n')).globs).toEqual([]);
  });

  it('leaves a bracket that is part of a glob alone', () => {
    // `[` is legal in a glob. Only a value that opens *and* closes with brackets is a flow
    // sequence, so a character class survives — the case that makes this textual unwrap
    // safe rather than lucky.
    expect(parseMdc(['---', 'globs: src/[abc]*.ts', '---', ''].join('\n')).globs).toEqual([
      'src/[abc]*.ts',
    ]);
  });
});
