/**
 * Text normalization. Every text read passes through here, and every artifact is
 * finalized through here, so that a CRLF checkout and an LF checkout produce
 * byte-identical output. See docs/determinism.md.
 */

const BOM = '﻿';

export function stripBom(s: string): string {
  return s.startsWith(BOM) ? s.slice(1) : s;
}

export function normalizeEol(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

/**
 * Exactly one trailing newline, unless the content is empty — an adapter signals
 * "emit no file" by producing no artifact, so empty content stays empty rather than
 * becoming a lone newline.
 */
export function ensureSingleTrailingNewline(s: string): string {
  if (s === '') return '';
  // A scan from the end, not `/\n*$/`: an unanchored regex retries at every position, and
  // every artifact passes through here, so on a large render it was the hottest line (T062).
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 10) end -= 1;
  return `${s.slice(0, end)}\n`;
}

/** stripBom -> normalizeEol. Applied to every text read at the io boundary. */
export function normalizeText(s: string): string {
  return normalizeEol(stripBom(s));
}
