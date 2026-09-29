/**
 * A TOML reader for exactly what a command or agent file holds: top-level `key = string`
 * pairs, in any of TOML's four string forms, and comments (RFC-0001 §13.3, §14.3).
 *
 * Hand-written because core's dependencies are an allowlist and a command file needs a sliver
 * of TOML. Anything outside that sliver — a table, a number, an array — makes the whole file
 * unreadable rather than half-read: `init` then names it and leaves it where it is.
 *
 * Reference: https://toml.io/en/v1.0.0#string (read 2026-09-29).
 */
export type CommandToml =
  | { readonly ok: true; readonly values: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly reason: string };

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function readCommandToml(text: string): CommandToml {
  const values = new Map<string, string>();
  let i = 0;
  const fail = (reason: string): CommandToml => ({ ok: false, reason });

  while (i < text.length) {
    // Blank lines and comments.
    while (i < text.length && /[ \t\r\n]/.test(text[i]!)) i += 1;
    if (i >= text.length) break;
    if (text[i] === '#') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (text[i] === '[') return fail('it has a table, and only top-level string keys are read');

    const eq = text.indexOf('=', i);
    const nl = text.indexOf('\n', i);
    if (eq === -1 || (nl !== -1 && nl < eq)) return fail('a line is not `key = value`');
    const key = text.slice(i, eq).trim();
    if (!BARE_KEY.test(key)) return fail(`\`${key}\` is not a key this reader understands`);
    if (values.has(key)) return fail(`\`${key}\` is set twice`);
    i = eq + 1;
    while (text[i] === ' ' || text[i] === '\t') i += 1;

    const read = readString(text, i);
    if (read === undefined) return fail(`\`${key}\` is not a string`);
    values.set(key, read.value);
    i = read.end;
    // Only a comment may follow a value on its line.
    while (text[i] === ' ' || text[i] === '\t') i += 1;
    if (text[i] === '#') while (i < text.length && text[i] !== '\n') i += 1;
    if (i < text.length && text[i] !== '\n' && text[i] !== '\r') {
      return fail(`something follows the value of \`${key}\``);
    }
  }
  return { ok: true, values };
}

function readString(text: string, at: number): { value: string; end: number } | undefined {
  if (text.startsWith('"""', at)) return readDelimited(text, at + 3, '"""', true, true);
  if (text.startsWith("'''", at)) return readDelimited(text, at + 3, "'''", false, true);
  if (text[at] === '"') return readDelimited(text, at + 1, '"', true, false);
  if (text[at] === "'") return readDelimited(text, at + 1, "'", false, false);
  return undefined;
}

function readDelimited(
  text: string,
  start: number,
  close: string,
  escapes: boolean,
  multiline: boolean,
): { value: string; end: number } | undefined {
  let i = start;
  // A newline straight after the opening delimiter is trimmed.
  if (multiline && text.startsWith('\r\n', i)) i += 2;
  else if (multiline && text[i] === '\n') i += 1;
  let out = '';
  while (i < text.length) {
    if (text.startsWith(close, i)) {
      // Up to two quotes may sit right before the closing delimiter of a multi-line string.
      let end = i + close.length;
      while (multiline && text[end] === close[0] && end - i < close.length + 2) {
        out += close[0];
        end += 1;
      }
      return { value: out, end };
    }
    const ch = text[i]!;
    if (!multiline && ch === '\n') return undefined;
    if (escapes && ch === '\\') {
      const next = text[i + 1];
      if (multiline && (next === '\n' || next === '\r' || next === ' ' || next === '\t')) {
        // A line-ending backslash swallows the newline and the whitespace after it.
        let j = i + 1;
        while (j < text.length && /[ \t]/.test(text[j]!)) j += 1;
        if (text[j] !== '\n' && text[j] !== '\r') return undefined;
        while (j < text.length && /[ \t\r\n]/.test(text[j]!)) j += 1;
        i = j;
        continue;
      }
      const simple: Record<string, string> = {
        '"': '"',
        '\\': '\\',
        n: '\n',
        t: '\t',
        r: '\r',
        b: '\b',
        f: '\f',
      };
      if (next !== undefined && next in simple) {
        out += simple[next];
        i += 2;
        continue;
      }
      const width = next === 'u' ? 4 : next === 'U' ? 8 : 0;
      const hex = text.slice(i + 2, i + 2 + width);
      if (width === 0 || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== width) return undefined;
      const code = Number.parseInt(hex, 16);
      // TOML allows Unicode scalar values only: no surrogates, nothing past U+10FFFF.
      if (code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return undefined;
      out += String.fromCodePoint(code);
      i += 2 + width;
      continue;
    }
    // CRLF inside a multi-line string is a newline, like every canonical text (§9).
    if (multiline && ch === '\r' && text[i + 1] === '\n') {
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return undefined;
}
