import { describe, expect, it } from 'vitest';
import { readCommandToml } from '../src/init/command-toml.js';

/** T053: the sliver of TOML a Gemini CLI command file holds, read exactly or not at all. */

const values = (text: string) => {
  const read = readCommandToml(text);
  return read.ok ? Object.fromEntries(read.values) : read.reason;
};

describe('readCommandToml (T053)', () => {
  it('reads all four string forms, with comments around them', () => {
    expect(
      values(
        [
          '# a comment',
          'a = "basic \\"q\\" \\\\ \\t \\u00e9" # trailing',
          "b = 'literal \\n stays'",
          'c = """',
          'multi "one" ""line""',
          '"""',
          "d = '''",
          "raw \\ text'''",
          '',
        ].join('\n'),
      ),
    ).toEqual({
      a: 'basic "q" \\ \t é',
      b: 'literal \\n stays',
      c: 'multi "one" ""line""\n',
      d: 'raw \\ text',
    });
  });

  it('lets up to two quotes close a multi-line string, and a line-ending backslash join lines', () => {
    expect(values('a = """x""""\nb = """one \\\n    two"""\n')).toEqual({ a: 'x"', b: 'one two' });
  });

  it('reads CRLF as LF', () => {
    expect(values('p = """\r\nline one\r\nline two\r\n"""\r\n')).toEqual({
      p: 'line one\nline two\n',
    });
  });

  it('refuses everything outside the sliver rather than half-reading it', () => {
    expect(values('[table]\n')).toBe('it has a table, and only top-level string keys are read');
    expect(values('n = 1\n')).toBe('`n` is not a string');
    expect(values('a = "x"\na = "y"\n')).toBe('`a` is set twice');
    expect(values('a = "x" "y"\n')).toBe('something follows the value of `a`');
    expect(values('a = "unterminated\n')).toBe('`a` is not a string');
    expect(values('a = "\\ud800"\n')).toBe('`a` is not a string');
    expect(values('"quoted key" = "x"\n')).toBe(
      '`"quoted key"` is not a key this reader understands',
    );
  });
});
