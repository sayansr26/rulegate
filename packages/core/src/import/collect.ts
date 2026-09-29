import { RulegateError } from '../model/errors.js';
import { ADAPTER_API_VERSION } from '../adapter/context.js';
import { emptyCanonical } from '../model/canonical.js';
import type { Adapter } from '../adapter/adapter.js';
import type { Canonical } from '../model/canonical.js';
import type { JsonValue } from '../model/ids.js';
import { filesOnly } from '../fs/files-only.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';
import { RULE_FRONTMATTER_KEYS, type RuleDocument } from '../model/rule.js';
import type { ImportSource } from './dedupe.js';

export interface CollectOptions {
  readonly repoRoot: string;
  readonly fs: ReadOnlyFileSystem;
  readonly adapters: readonly Adapter[];
  /**
   * Defaults to an empty model, which is what `init` has: it runs on a repository with no
   * `.rulegate/`, so there is nothing to parse. Pass a real one only to honour an
   * existing manifest's `canonicalSources`.
   */
  readonly canonical?: Canonical;
  readonly options?: Readonly<Record<string, Readonly<Record<string, JsonValue>>>>;
}

export interface CollectResult {
  /** One entry per adapter, including adapters that found nothing. */
  readonly sources: readonly ImportSource[];
  readonly errors: readonly RulegateError[];
}

/**
 * Run every adapter's `read()` over one repository.
 *
 * Adapters that find nothing still get an entry, because "this tool was read and had no
 * rules" is different from "this tool was not read" — `dedupeImported` decides whether a
 * rule is `tools: all` by comparing against the tools that participated, and an adapter
 * missing from the list would silently narrow every selector.
 *
 * A failing adapter is recorded and skipped rather than aborting, the same rule
 * `computePlan` follows: one broken adapter must not hide what the others would have
 * found, least of all during `init`, where the alternative is a new user's first command
 * failing with somebody else's bug.
 */
export async function collectImports(options: CollectOptions): Promise<CollectResult> {
  const canonical = options.canonical ?? emptyCanonical({ file: '<import>' });
  const fs = filesOnly(options.fs);
  const sources: ImportSource[] = [];
  const errors: RulegateError[] = [];

  for (const adapter of options.adapters) {
    try {
      const partial = await adapter.read({
        repoRoot: options.repoRoot,
        canonical,
        fs,
        options: options.options?.[adapter.name] ?? {},
        apiVersion: ADAPTER_API_VERSION,
      });
      sources.push({
        tool: adapter.name,
        rules: (partial.rules ?? []).map((rule) => withoutCanonicalKeys(rule, adapter.name)),
        mcpServers: partial.mcpServers ?? [],
        carriesMcp: carriesMcp(adapter),
        mcpWarnings: partial.warnings ?? [],
      });
    } catch (error) {
      sources.push({
        tool: adapter.name,
        rules: [],
        mcpServers: [],
        carriesMcp: carriesMcp(adapter),
        mcpWarnings: [],
      });
      errors.push(
        error instanceof RulegateError
          ? error
          : new RulegateError({
              code: 'E_ADAPTER_FAILED',
              message: `adapter \`${adapter.name}\` failed while importing: ${String(error)}`,
              cause: error,
            }),
      );
    }
  }

  return { sources, errors };
}

/**
 * A rule whose preserved keys are all ones canonical does not interpret (T115).
 *
 * An adapter keeps the frontmatter keys its format does not understand in `unknown`, and
 * `unknown` is serialized into the same YAML map as `order` and `tools`. A Cursor rule
 * carrying `order: 1` would come back from `.rulegate/` as the string `"1"`, which fails
 * every `check` after `init`; `tools: [claude-code]` would stop being preserved and start
 * moving the rule out of Cursor. Renamed here, once, for every adapter — the scheme the
 * interop importers already use — rather than trusted to each adapter's reader: the key
 * stays visible to its author without changing what the rule means.
 */
function withoutCanonicalKeys(rule: RuleDocument, owner: string): RuleDocument {
  const keys = Object.keys(rule.frontmatter.unknown);
  if (!keys.some((key) => RULE_FRONTMATTER_KEYS.has(key))) return rule;
  // Names the author wrote are reserved before any rename is placed, so key order decides
  // nothing and a rename never lands on a key that was already there.
  const written = new Set(keys.filter((key) => !RULE_FRONTMATTER_KEYS.has(key)));
  const unknown: Record<string, JsonValue> = {};
  for (const key of keys) {
    let name = key;
    if (RULE_FRONTMATTER_KEYS.has(key)) {
      name = `${owner}-${key}`;
      for (let n = 2; written.has(name) || Object.hasOwn(unknown, name); n++) {
        name = `${owner}-${key}-${n}`;
      }
    }
    unknown[name] = rule.frontmatter.unknown[key] as JsonValue;
  }
  return { ...rule, frontmatter: { ...rule.frontmatter, unknown } };
}

/**
 * Does this adapter generate a project-level MCP file?
 *
 * Read off the adapter's own `docs` rather than from a list of tool names, for the reason
 * T072 established: a warning or a selector derived from a hardcoded roster stops being
 * true the moment somebody writes a sixth adapter.
 */
function carriesMcp(adapter: Adapter): boolean {
  return adapter.docs.files.some((f) => f.managed && f.role === 'mcp' && f.scope !== 'global');
}
