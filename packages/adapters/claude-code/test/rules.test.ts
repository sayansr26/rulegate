import { describe, expect, it } from 'vitest';
import {
  ALL_TOOLS,
  MARKER_TEXT,
  importConcatenated,
  type RuleDocument,
} from '@rulegate/adapter-kit';
import {
  importRuleFile,
  parseRuleFile,
  renderPathsFrontmatter,
  renderScopedRule,
} from '../src/rules.js';

function rule(globs: readonly string[]): RuleDocument {
  return {
    id: 'r',
    path: '.rulegate/rules/r.md',
    body: 'Body.\n',
    frontmatter: { globs, tools: ALL_TOOLS, order: 100, unknown: {} },
    source: { file: '.rulegate/rules/r.md' },
  };
}

describe('.claude/rules frontmatter (T110)', () => {
  it('double-quotes every glob, so a leading `*` is never read as a YAML alias', () => {
    expect(renderPathsFrontmatter(['**/*.ts'])).toBe('---\npaths:\n  - "**/*.ts"\n---');
  });

  it('escapes the two characters a double-quoted scalar needs escaped', () => {
    const out = renderPathsFrontmatter(['a\\[b', 'say "hi"']);
    expect(out).toBe('---\npaths:\n  - "a\\\\[b"\n  - "say \\"hi\\""\n---');
    expect(parseRuleFile(`${out}\nx\n`).paths).toEqual(['a\\[b', 'say "hi"']);
  });

  it('keeps a brace glob with a comma in it as one pattern', () => {
    const out = renderPathsFrontmatter(['src/*.{ts,tsx}']);
    expect(parseRuleFile(`${out}\n`).paths).toEqual(['src/*.{ts,tsx}']);
  });

  it('rejects a glob with a line break rather than writing frontmatter that unscopes it', () => {
    let caught: unknown;
    try {
      renderScopedRule(rule(['a\nb']), 'x', true);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'E_FRONTMATTER_INVALID' });
  });

  it('reads all three spellings of `paths`', () => {
    const block = parseRuleFile('---\npaths:\n  - "a/**"\n  - \'b/**\'\n  - c/**\n---\nx\n');
    const flow = parseRuleFile('---\npaths: ["a/**", \'b/*.{ts,tsx}\', c/**]\n---\nx\n');
    const comma = parseRuleFile('---\npaths: a/**, b/*.{ts,tsx} ,c/**\n---\nx\n');
    expect(block.paths).toEqual(['a/**', 'b/**', 'c/**']);
    expect(flow.paths).toEqual(['a/**', 'b/*.{ts,tsx}', 'c/**']);
    expect(comma.paths).toEqual(['a/**', 'b/*.{ts,tsx}', 'c/**']);
  });

  it('keeps unknown keys, maps description, and drops canonical-only keys', () => {
    const parsed = parseRuleFile(
      '---\ndescription: "API"\nowner: team\nglobs: nope/**\npaths:\n  - "a/**"\n---\nx\n',
    );
    expect(parsed.description).toBe('API');
    expect(parsed.unknown).toEqual({ owner: 'team' });
    expect(parsed.paths).toEqual(['a/**']);
    expect(parsed.remainder).toBe('x\n');
  });

  // Claude Code loads a rule whose frontmatter does not parse as if it had no `paths`, so
  // the import does the same — and keeps the whole text, because none of it may be lost.
  it.each([
    ['no frontmatter', '# Title\n\nBody.\n'],
    ['an unterminated block', '---\npaths:\n  - "a/**"\nBody.\n'],
    ['an unquoted leading `*` on a list item', '---\npaths:\n  - **/*.ts\n---\nBody.\n'],
    ['an unterminated quote', '---\npaths:\n  - "a/**\n---\nBody.\n'],
    ['an unclosed flow list in a list item', '---\npaths:\n  - ["a/**"\n---\nBody.\n'],
  ])('reads %s as repo-wide and keeps the whole file', (_, contents) => {
    const parsed = parseRuleFile(contents);
    expect(parsed.paths).toEqual([]);
    expect(parsed.remainder).toBe(contents);
  });

  it('normalizes CRLF and a BOM before reading', () => {
    const parsed = parseRuleFile('\uFEFF---\r\npaths:\r\n  - "a/**"\r\n---\r\nx\r\n');
    expect(parsed.paths).toEqual(['a/**']);
    expect(parsed.remainder).toBe('x\n');
  });

  it('finds the marker after a `paths:` block longer than the 512-byte window', () => {
    const globs = Array.from({ length: 40 }, (_, i) => `packages/pkg-${String(i)}/src/**/*.ts`);
    const contents = renderScopedRule(
      { ...rule(globs), frontmatter: { ...rule(globs).frontmatter, description: 'Long' } },
      '## Long\n\nBody.',
      true,
    );
    expect(contents.indexOf(MARKER_TEXT)).toBeGreaterThan(512);

    const parsed = parseRuleFile(contents);
    expect(parsed.paths).toEqual(globs);
    const [imported] = importConcatenated({
      file: '.claude/rules/r.md',
      contents: parsed.remainder,
      headingLevel: 2,
      parseGlobs: false,
      idFallback: 'r',
    });
    // Structured import: the heading came back as the description, not as body text.
    expect(imported?.frontmatter.description).toBe('Long');
    expect(imported?.body).toBe('Body.\n');
  });
  // Valid YAML read as unparseable would unscope a rule Claude Code scopes: the fallback
  // is only honest for frontmatter Claude Code cannot read either.
  it.each([
    ['a trailing comment on a scalar', '---\npaths: "db/**" # sql\n---\nx\n', ['db/**']],
    ['a trailing comment on a bare scalar', '---\npaths: db/** # sql\n---\nx\n', ['db/**']],
    ['a trailing comment on a list item', '---\npaths:\n  - "src/**" # c\n---\nx\n', ['src/**']],
    ['a quoted key', '---\n"paths":\n  - "db/**"\n---\nx\n', ['db/**']],
    [
      'list items level with their key',
      '---\npaths:\n- "db/**"\n- src/**\n---\nx\n',
      ['db/**', 'src/**'],
    ],
    [
      'a nested mapping ahead of `paths`',
      '---\nmetadata:\n  owner: web\n  tags:\n    - a\npaths:\n  - "src/**/*.ts"\n---\nx\n',
      ['src/**/*.ts'],
    ],
    ['a `#` inside a glob', '---\npaths:\n  - src/#legacy/**\n---\nx\n', ['src/#legacy/**']],
  ])('reads %s', (_, contents, paths) => {
    const parsed = parseRuleFile(contents);
    expect(parsed.paths).toEqual(paths);
    expect(parsed.remainder).toBe('x\n');
  });

  it('keeps a nested mapping and reads a block-scalar description', () => {
    const parsed = parseRuleFile(
      '---\nmetadata:\n  owner: web # team\ndescription: >\n  Database\n  rules\npaths: db/**\n---\nx\n',
    );
    expect(parsed.unknown).toEqual({ metadata: { owner: 'web' } });
    expect(parsed.description).toBe('Database rules');
    expect(parsed.paths).toEqual(['db/**']);
  });

  // Claude Code 2.1.283 retries a failed parse after quoting top-level indicator values
  // and turning leading tabs into spaces. What that retry scopes is scoped here; what it
  // still cannot read falls back, as it does there.
  it.each([
    ['a tab-indented list', '---\npaths:\n\t- "a/**"\n---\nx\n', ['a/**']],
    ['a top-level value holding `: `', '---\npaths: a: b\n---\nx\n', ['a: b']],
    ['a top-level unquoted `**/*.ts`', '---\npaths: **/*.ts\n---\nx\n', ['**/*.ts']],
    ['a top-level unclosed flow list', '---\npaths: ["a/**"\n---\nx\n', ['["a/**"']],
    ['a top-level value opening with `*`', '---\npaths: *.tsx # c\n---\nx\n', ['*.tsx # c']],
    ['an empty list item', '---\npaths:\n  -\n---\nx\n', []],
    ['decoded double-quoted escapes', '---\npaths:\n  - "\\u0041/\\x42\\\\"\n---\nx\n', ['A/B\\']],
  ])('reads %s the way Claude Code does', (_, contents, paths) => {
    const parsed = parseRuleFile(contents);
    expect(parsed.paths).toEqual(paths);
    expect(parsed.remainder).toBe('x\n');
  });

  it('keeps the description beside a top-level value Claude Code repairs', () => {
    const parsed = parseRuleFile('---\ndescription: a: b\npaths:\n  - "src/**"\n---\nx\n');
    expect(parsed.description).toBe('a: b');
    expect(parsed.paths).toEqual(['src/**']);
  });

  it.each([
    ['a nested value holding `: `', '---\nmeta:\n  owner: a: b\npaths: src/**\n---\nx\n'],
    ['a list item opening with `*`', '---\npaths:\n  - **/*.tsx\n---\nx\n'],
    ['a tab after spaces in indentation', '---\npaths:\n  \t- "a/**"\n---\nx\n'],
    ['an unknown escape', '---\npaths:\n  - "a\\qb"\n---\nx\n'],
  ])('falls back on %s, which Claude Code does not repair', (_, contents) => {
    expect(parseRuleFile(contents)).toEqual({ paths: [], unknown: {}, remainder: contents });
  });

  it.each([
    ['a list of mappings', '---\npaths:\n  - glob: a/**\n---\nBody.\n'],
    ['a flow mapping', '---\npaths: {a: b}\n---\nBody.\n'],
    ['a stray indented line', '---\npaths: a/**\n  oops\n---\nBody.\n'],
  ])('still falls back on %s', (_, contents) => {
    expect(parseRuleFile(contents)).toEqual({ paths: [], unknown: {}, remainder: contents });
  });
});

describe('importRuleFile (T110)', () => {
  const marked = (body: string): string =>
    `---\npaths:\n  - "src/**"\n---\n<!-- generated by rulegate; edit .rulegate/ instead -->\n\n${body}`;

  it('reads one file as one rule, even when the body has its own `##` heading', () => {
    const rule = importRuleFile(
      '.claude/rules/r.md',
      'r',
      parseRuleFile(marked('## Frontend\n\nUse hooks.\n\n## Server components\n\nPrefer RSC.\n')),
    );
    expect(rule?.id).toBe('r');
    expect(rule?.frontmatter.description).toBe('Frontend');
    expect(rule?.frontmatter.globs).toEqual(['src/**']);
    expect(rule?.body).toBe('Use hooks.\n\n## Server components\n\nPrefer RSC.\n');
  });

  it('keeps a marked file with broken frontmatter as one body, frontmatter and all', () => {
    const contents =
      '---\npaths:\n  - **/*.tsx\n---\n<!-- generated by rulegate; edit .rulegate/ instead -->\n\n## Frontend\n\nUse hooks.\n';
    const rule = importRuleFile('.claude/rules/r.md', 'r', parseRuleFile(contents));
    expect(rule?.frontmatter.globs).toEqual([]);
    expect(rule?.frontmatter.description).toBeUndefined();
    expect(rule?.body).toBe(contents);
  });

  // Ambiguous by construction: with no description, `write` adds no heading, so a body's
  // own leading `##` reads back as one. `sync --import` measures edits against this
  // read-back rather than canonical, which is what keeps the heading (import-merge.test).
  it('reads a leading body heading of a description-less rule back as its description', () => {
    const rule = importRuleFile(
      '.claude/rules/r.md',
      'r',
      parseRuleFile(marked('## Server components\n\nUse them.\n')),
    );
    expect(rule?.frontmatter.description).toBe('Server components');
    expect(rule?.body).toBe('Use them.\n');
  });

  it("takes no heading from an unmarked file: its headings are the author's prose", () => {
    const rule = importRuleFile('.claude/rules/r.md', 'r', parseRuleFile('## API\n\nBody.\n'));
    expect(rule?.frontmatter.description).toBeUndefined();
    expect(rule?.body).toBe('## API\n\nBody.\n');
  });
});
