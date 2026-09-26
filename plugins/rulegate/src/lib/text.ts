/**
 * Control characters in repo-derived text. The hooks print branch names, paths and
 * directory names into Claude's context; a newline in one must not be able to start a line
 * — or a heading — of its own. Char codes rather than a regex, which lint rightly flags.
 */
const isControl = (c: string): boolean => {
  const n = c.charCodeAt(0);
  return n < 0x20 || n === 0x7f;
};

export const hasControl = (s: string): boolean => Array.from(s).some(isControl);

export const stripControl = (s: string): string =>
  Array.from(s, (c) => (isControl(c) ? ' ' : c)).join('');
