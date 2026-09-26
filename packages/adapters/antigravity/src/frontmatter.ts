import { RulegateError, stripMarker } from '@rulegate/adapter-kit';

/**
 * Antigravity's workspace-rule frontmatter, hand-rendered.
 *
 * The same shape as Windsurf's — a derived `trigger` over `globs` — with two differences
 * that both come from Antigravity parsing the block as real YAML. A `globs` value that
 * starts with `*` is a YAML *alias* when bare, so the vendor quotes it; and a file whose
 * block does not parse, or whose `trigger` is not one of the four, is **silently
 * discarded**. A rendering mistake here does not produce an error anywhere — it produces
 * a rule that quietly never reaches the model.
 *
 * Source: https://antigravity.google/docs/rules (read 2026-09-26).
 */

/** The four documented activation modes. Rulegate emits two of them. */
export type Trigger = 'always_on' | 'glob' | 'model_decision' | 'manual';

const TRIGGERS: ReadonlySet<string> = new Set<Trigger>([
  'always_on',
  'glob',
  'model_decision',
  'manual',
]);

export interface FrontmatterInit {
  readonly globs: readonly string[];
  readonly description?: string;
}

/**
 * One double-quoted value, `"a, b"`, exactly as the vendor's example writes it.
 *
 * Always quoted rather than only when it starts with `*`: a quoted scalar is valid YAML for
 * every glob, and a rule that switches quoting on its first character is one more branch
 * that can pick wrong. `JSON.stringify` is the quoter because a JSON string is a valid YAML
 * double-quoted scalar, escapes included. A comma inside a glob is refused, as Cursor's and
 * Windsurf's are: the vendor separates patterns with commas and documents no escape, so it
 * would silently split into two wrong patterns.
 */
function renderGlobs(globs: readonly string[]): string {
  for (const glob of globs) {
    if (glob.includes(',')) {
      throw new RulegateError({
        code: 'E_FRONTMATTER_INVALID',
        message: `glob \`${glob}\` contains a comma, which antigravity cannot express`,
        hint: 'antigravity separates patterns with commas and has no escape for one inside a pattern; split the rule in two',
      });
    }
  }
  return JSON.stringify(globs.join(', '));
}

/** Words YAML reads as something other than a string when they stand bare. */
const YAML_KEYWORD = /^(?:true|false|yes|no|on|off|null|~)$/i;

/**
 * A single-line description, quoted only when a bare one would not survive YAML.
 *
 * Bare in the common case because that is how the vendor writes it and how a reader
 * expects it to look. Quoted when it would parse as something else — a `: ` makes it a
 * mapping, a leading digit or `true` makes it a scalar of another type — because a block
 * that fails to parse gets the whole rule discarded.
 */
function renderDescription(description: string): string {
  const folded = description.replace(/\s+/g, ' ').trim();
  const plain = /^[A-Za-z][A-Za-z0-9 _.,()/'-]*$/.test(folded) && !YAML_KEYWORD.test(folded);
  return plain ? folded : JSON.stringify(folded);
}

/**
 * The frontmatter block, including its delimiters and trailing blank line.
 *
 * `trigger` is derived — `glob` exactly when the rule is scoped, `always_on` otherwise —
 * for the reason Windsurf's is. `model_decision` and `manual` are never emitted: both let
 * the model skip a rule the author wrote in `.rulegate/rules/` to be applied.
 */
export function renderFrontmatter(init: FrontmatterInit): string {
  const lines: string[] = ['---'];
  const scoped = init.globs.length > 0;
  lines.push(`trigger: ${scoped ? 'glob' : 'always_on'}`);
  if (scoped) lines.push(`globs: ${renderGlobs(init.globs)}`);
  if (init.description !== undefined && init.description !== '') {
    lines.push(`description: ${renderDescription(init.description)}`);
  }
  lines.push('---', '', '');
  return lines.join('\n');
}

export interface ParsedRule {
  readonly globs: readonly string[];
  readonly description?: string;
  /** Undefined when the file has no frontmatter at all. */
  readonly trigger?: string;
  readonly hasFrontmatter: boolean;
  /**
   * The first key whose bare value starts with a YAML indicator (`*.ts` is an alias), so
   * the block does not parse as the text says and Antigravity discards the file.
   */
  readonly invalidKey?: string;
  readonly body: string;
}

/**
 * A bare scalar YAML cannot read as the plain string it looks like: `*` is an alias, `&` an
 * anchor, `!` a tag, and `@` and a backtick are reserved. `globs: *.ts` is exactly how a
 * Cursor or Windsurf user writes it, and this parser would otherwise take it at face value
 * and import as scoped a rule Antigravity drops today.
 */
const YAML_INDICATOR = /^[*&!@`]/;

function unquote(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/**
 * Read a workspace rule file back.
 *
 * `trigger` is reported rather than stored: canonical derives it from `globs` on the way
 * out, and the caller needs it only to warn about the two modes canonical cannot express.
 * The vendor accepts `glob:` as a synonym for `globs:`, so both are read.
 */
export function parseRule(contents: string): ParsedRule {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(contents);
  if (match === null) {
    return { globs: [], hasFrontmatter: false, body: stripMarker(contents).trim() };
  }

  // The marker sits below the frontmatter, so it comes off here; leaving it makes
  // `write()` -> `read()` grow a line of Rulegate's own text on every round trip.
  const body = stripMarker(contents.slice(match[0].length).replace(/^\s*\n/, ''));
  const globs: string[] = [];
  let description: string | undefined;
  let trigger: string | undefined;
  let invalidKey: string | undefined;
  const check = (key: string, raw: string): void => {
    if (invalidKey === undefined && YAML_INDICATOR.test(raw.trim())) invalidKey = key;
  };

  // The key a YAML block list (`globs:` then `  - "*.proto"`) is collecting items for. The
  // vendor writes one comma-separated value, but a block list is valid YAML for the same
  // key, and dropping its items would turn a scoped rule into an always-on one.
  let listKey: string | undefined;
  for (const line of match[1]!.split(/\r?\n/)) {
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item !== null && listKey !== undefined) {
      check(listKey, item[1]!);
      const glob = unquote(item[1]!.trim());
      if (glob !== '') globs.push(glob);
      continue;
    }
    listKey = undefined;
    const pair = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (pair === null) continue;
    const [, key, raw] = pair;
    check(key!, raw!);
    const value = unquote(raw!);
    if ((key === 'globs' || key === 'glob') && value === '') {
      listKey = key;
    } else if (key === 'globs' || key === 'glob') {
      // A flow list (`["*.ts", "*.tsx"]`) splits the same way once its brackets are off;
      // read as one value, `[]` would become a character-class glob matching nothing.
      const flow = /^\[(.*)\]$/.exec(value);
      const items = (flow === null ? value : flow[1]!).split(',');
      if (flow !== null) for (const g of items) check(key, g);
      globs.push(...items.map((g) => unquote(g)).filter((g) => g !== ''));
    } else if (key === 'description' && value !== '') {
      description = value;
    } else if (key === 'trigger') {
      trigger = value;
    }
  }

  return {
    globs,
    ...(description === undefined ? {} : { description }),
    ...(trigger === undefined ? {} : { trigger }),
    hasFrontmatter: true,
    ...(invalidKey === undefined ? {} : { invalidKey }),
    body: body.trim(),
  };
}

export function isKnownTrigger(trigger: string | undefined): trigger is Trigger {
  return trigger !== undefined && TRIGGERS.has(trigger);
}
