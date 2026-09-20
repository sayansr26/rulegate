import {
  RulegateError,
  appliesRepoWide,
  stripMarker,
  type JsonValue,
  type RuleDocument,
} from '@rulegate/adapter-kit';

/**
 * Cursor's `.mdc` frontmatter is *not* strict YAML as an emitter would produce it, and
 * this is the trap T007 exists to expose.
 *
 *   - `globs` is a bare, comma-joined string — `globs: a,b` — not a YAML sequence and
 *     not quoted. A YAML emitter would write a block sequence or quote the value, which
 *     looks plausible and behaves differently.
 *   - An empty `globs` is written as a bare key with nothing after it, not `globs: []`.
 *   - `alwaysApply` is *derived* from the canonical model (true exactly when the rule
 *     is repo-wide) rather than stored, so it never appears in canonical frontmatter.
 *
 * Hence: hand-rendered, and hand-rendered *here* rather than in core, because the
 * dialect is tool-specific and core must stay free of tool knowledge.
 */
export interface MdcFrontmatter {
  readonly description?: string;
  readonly globs: readonly string[];
  readonly alwaysApply: boolean;
}

export function frontmatterFor(rule: RuleDocument): MdcFrontmatter {
  const description = rule.frontmatter.description;
  return {
    ...(description === undefined ? {} : { description }),
    globs: rule.frontmatter.globs,
    alwaysApply: appliesRepoWide(rule),
  };
}

export function renderMdcFrontmatter(fm: MdcFrontmatter): string {
  const lines = ['---'];
  if (fm.description !== undefined) lines.push(`description: ${fm.description}`);
  lines.push(fm.globs.length === 0 ? 'globs:' : `globs: ${fm.globs.join(',')}`);
  lines.push(`alwaysApply: ${String(fm.alwaysApply)}`);
  lines.push('---');
  return lines.join('\n');
}

/**
 * The dialect has no escaping: a value runs to the end of the line. A description
 * containing a newline would silently corrupt the frontmatter and swallow the keys
 * after it, so it is rejected rather than mangled.
 */
export function assertRenderable(rule: RuleDocument): void {
  const description = rule.frontmatter.description;
  if (description !== undefined && /[\r\n]/.test(description)) {
    throw new RulegateError({
      code: 'E_FRONTMATTER_INVALID',
      message: `rule \`${rule.id}\` has a multi-line description, which Cursor's .mdc frontmatter cannot represent`,
      source: rule.source,
      hint: 'use a single-line description; put the detail in the rule body',
    });
  }
  for (const glob of rule.frontmatter.globs) {
    if (glob.includes(',')) {
      throw new RulegateError({
        code: 'E_FRONTMATTER_INVALID',
        message: `glob \`${glob}\` in rule \`${rule.id}\` contains a comma, which separates globs in Cursor's .mdc format`,
        source: rule.source,
        hint: 'split it into two glob entries',
      });
    }
  }
}

export interface ParsedMdc {
  readonly description?: string;
  readonly globs: readonly string[];
  /** Keys the dialect carried that canonical has no field for, preserved verbatim. */
  readonly unknown: Readonly<Record<string, JsonValue>>;
  readonly body: string;
}

const KEY_LINE = /^([^:\s][^:]*):[ \t]?(.*)$/;

/**
 * `.mdc` -> its parts. The inverse of `renderMdcFrontmatter`, and hand-rolled for the
 * same reason it is: **this is not YAML.**
 *
 * A YAML parser gets three things wrong here, all silently. `globs: src/**\/*.tsx` has an
 * unquoted `*` where a YAML alias may begin; the bare key `globs:` parses as `null`
 * rather than "no globs"; and a value containing `:` or `#` — ordinary in a description —
 * is either an error or a truncation. The dialect's actual rule is simpler than YAML:
 * a value runs to the end of the line and nothing escapes.
 */
export function parseMdc(contents: string): ParsedMdc {
  const lines = contents.split('\n');
  if ((lines[0] ?? '').trim() !== '---') {
    return { globs: [], unknown: {}, body: joinBody(lines) };
  }

  const close = lines.findIndex((line, i) => i > 0 && ['---', '...'].includes(line.trim()));
  // An unterminated block is the user's file, not ours. Treating the whole thing as body
  // keeps every byte; guessing where the frontmatter ended would drop the rest.
  if (close === -1) return { globs: [], unknown: {}, body: joinBody(lines) };

  let description: string | undefined;
  let globs: readonly string[] = [];
  const unknown: Record<string, JsonValue> = {};

  for (const line of lines.slice(1, close)) {
    const match = KEY_LINE.exec(line);
    if (match === null) continue;
    const key = (match[1] ?? '').trim();
    const value = (match[2] ?? '').trim();

    if (key === 'description') {
      if (value !== '') description = value;
    } else if (key === 'globs') {
      globs = splitGlobs(value);
    } else if (key === 'alwaysApply') {
      // Derived on the way out (`globs.length === 0`), so it is dropped on the way back
      // in. Preserving it in `unknown` would re-emit it into canonical, where the next
      // render would compute it again — and the two could then disagree.
      continue;
    } else if (key !== '') {
      unknown[key] = value;
    }
  }

  return {
    ...(description === undefined ? {} : { description }),
    globs,
    unknown,
    body: joinBody(lines.slice(close + 1)),
  };
}

/**
 * Cursor's own documentation shows `globs` three ways, and a repository in the wild carries
 * whichever one its author copied (T099).
 *
 * The bare comma-joined string is Cursor's native spelling and the one this adapter writes.
 * A **flow sequence** — `globs: ["**` + `/*.py"]` — is what the docs show for multiple
 * patterns, and it used to import as a single glob whose text was the sequence syntax
 * itself: brackets, quotes and all. That rule then matched nothing, while `init` reported
 * success and `check` reported `in sync`, because a Cursor-only round trip reproduced the
 * original bytes by coincidence — the writer printed the string back unquoted and it read
 * as a sequence again. The damage was invisible until a second tool rendered the same
 * canonical glob, as Copilot's `applyTo` or as Claude Code's prose scope line.
 *
 * Unwrapped textually rather than through a YAML parser, for the reason the comment above
 * `parseMdc` gives: `globs` is not YAML, and a glob is full of characters a YAML parser
 * reads as syntax. Quotes are stripped per item, so `["a", 'b']` and `[a, b]` agree.
 */
function splitGlobs(value: string): readonly string[] {
  const trimmed = value.trim();
  const flow = trimmed.startsWith('[') && trimmed.endsWith(']');
  const inner = flow ? trimmed.slice(1, -1) : trimmed;
  return inner
    .split(',')
    .map((part) => unquote(part.trim()))
    .filter((part) => part !== '');
}

/** One layer of matching quotes, which a flow sequence's items usually carry. */
function unquote(part: string): string {
  const quoted =
    part.length >= 2 && (part.startsWith('"') || part.startsWith("'")) && part.endsWith(part[0]!);
  return quoted ? part.slice(1, -1) : part;
}

function joinBody(lines: readonly string[]): string {
  const body = stripMarker(lines.join('\n')).replace(/^\n+/, '').replace(/\n+$/, '');
  return body === '' ? '' : `${body}\n`;
}
