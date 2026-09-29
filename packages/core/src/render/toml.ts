/**
 * TOML strings, for the command and agent files core writes (T053, T054). Every `"` and `\` is escaped, and every
 * control character but newline and tab, so no body can close the string early or change
 * what TOML reads. Reference: https://toml.io/en/v1.0.0#string.
 */
export function tomlBasic(value: string): string {
  return `"${escapeToml(value, false)}"`;
}

export function tomlMultiline(value: string): string {
  return escapeToml(value, true);
}

function escapeToml(value: string, multiline: boolean): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += multiline ? '\n' : '\\n';
    else if (ch === '\t') out += multiline ? '\t' : '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out;
}
