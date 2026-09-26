import type { JsonValue } from '@rulegate/adapter-kit';

/** A leading `---` block, LF or CRLF. */
export const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface Frontmatter {
  readonly description?: string;
  /** One entry per requested list key, present even when the block did not set it. */
  readonly lists: Readonly<Record<string, readonly string[]>>;
  /**
   * Every other key, as a scalar string or a block list of them — preserved, never
   * interpreted here. A key that canonical frontmatter also defines arrives renamed (see
   * `CANONICAL_KEYS`).
   */
  readonly unknown: Readonly<Record<string, JsonValue>>;
}

/**
 * Keys canonical rule frontmatter interprets. A preserved key is serialized into the same
 * YAML map as the canonical ones and read back by `parseRuleFile`, so one carried under its
 * own name would stop being preserved and start being obeyed: agent-os ignores a Windsurf
 * rule's `globs:` (it scopes by `paths:`), and `order: 5` comes back as the string `"5"`,
 * which fails every later `check`. The canonical model init renders has to be the one it
 * writes. `description` is absent because this reader always claims it.
 */
const CANONICAL_KEYS: ReadonlySet<string> = new Set(['globs', 'tools', 'order']);

/**
 * A deliberately small YAML reader for the handful of keys another tool's rule frontmatter
 * uses.
 *
 * The kit exposes no YAML parser and this package may not reach past it, exactly as an
 * adapter may not. The shapes are `description` (a scalar) and the caller's list keys —
 * inline or block sequences of scalars, or a single scalar — the same subset the `.mdc`
 * and `.instructions.md` readers handle, and for the same reason: a dependency here would
 * be a supply-chain surface in a tool whose pitch is a thin dependency tree.
 *
 * The list keys are a parameter because a key read as a scalar loses its block list: under
 * rulesync's keys, agent-os's `paths:` with `- "src/**"` lines below it would land in
 * `unknown` as an empty string, and the rule would import unscoped.
 *
 * `owner` prefixes a preserved key that canonical frontmatter would otherwise interpret —
 * `globs` from agent-os becomes `agent-os-globs` — so the value stays visible to the author
 * without changing what the rule means.
 */
export function readFrontmatter(
  block: string,
  listKeys: readonly string[],
  owner: string,
): Frontmatter {
  const lists: Record<string, string[]> = {};
  for (const key of listKeys) lists[key] = [];
  // Other keys in source order, a bare `key:` collecting the block list below it.
  const others: { key: string; value: string | string[] }[] = [];
  let description: string | undefined;
  let list: string[] | undefined;

  const scalar = (raw: string): string => raw.trim().replace(/^["']|["']$/g, '');

  for (const line of block.split(/\r?\n/)) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item !== null && list !== undefined) {
      list.push(scalar(item[1]!));
      continue;
    }

    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (pair === null) continue;
    list = undefined;
    const [, key, rest] = pair;
    const value = (rest ?? '').trim();

    const target = listKeys.includes(key!) ? lists[key!] : undefined;
    if (target !== undefined) {
      if (value.startsWith('[')) {
        target.push(
          ...value
            .replace(/^\[|\]$/g, '')
            .split(',')
            .map(scalar)
            .filter((v) => v !== ''),
        );
      } else if (value === '') list = target;
      else target.push(scalar(value));
      continue;
    }
    if (key === 'description') {
      if (value !== '') description = scalar(value);
      continue;
    }
    if (value === '') {
      list = [];
      others.push({ key: key!, value: list });
    } else others.push({ key: key!, value: scalar(value) });
  }

  // A key this reader does not understand is not a key the user should lose — not as a
  // block list, and not to its own rename: `globs:` becomes `agent-os-globs` only when the
  // author did not write that key too, and otherwise takes the next free suffix. Names the
  // author wrote are reserved before any rename is placed, so line order decides nothing.
  const written = new Set(others.filter((o) => !CANONICAL_KEYS.has(o.key)).map((o) => o.key));
  const unknown: Record<string, JsonValue> = {};
  for (const { key, value } of others) {
    if (value.length === 0) continue;
    let name = key;
    if (CANONICAL_KEYS.has(key)) {
      name = `${owner}-${key}`;
      for (let n = 2; written.has(name) || Object.hasOwn(unknown, name); n++)
        name = `${owner}-${key}-${n}`;
    }
    unknown[name] = typeof value === 'string' ? value : [...value];
  }

  return { ...(description === undefined ? {} : { description }), lists, unknown };
}
