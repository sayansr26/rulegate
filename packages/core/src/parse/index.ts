import { RulegateError } from '../model/errors.js';
import { normalizeRelative } from '../fs/paths.js';
import {
  CANONICAL_SCHEMA_VERSION,
  DEFAULT_MANIFEST_OPTIONS,
  type Canonical,
  type RulegateManifest,
} from '../model/canonical.js';
import { DEFAULT_LINT_CONFIG } from '../model/lint.js';
import {
  AGENTS_MD,
  MANIFEST_PATH,
  MCP_SERVERS_PATH,
  RULES_DIR,
  RULES_GLOB,
  deriveRuleId,
} from '../model/paths.js';
import { compareCodepoint } from '../render/order.js';
import { parseManifest } from './manifest.js';
import { parseMcpServers } from './mcp.js';
import { parseRuleFile } from './rules.js';
import { suggest } from './suggest.js';
import type { McpServer } from '../model/mcp.js';
import type { RuleDocument } from '../model/rule.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export type CanonicalMode = 'rulegate-dir' | 'rules-only' | 'bare-agents-md';

export interface ParseInput {
  readonly fs: ReadOnlyFileSystem;
  /** Adapter ids registered in this process, used to seed a synthetic manifest. */
  readonly knownTools?: readonly string[];
  /**
   * Repo-relative POSIX directory holding the `.rulegate/` to read. Root when absent.
   *
   * For nested canonical sources in a monorepo (T061). A prefix rather than a re-rooted
   * filesystem because every path this function reports — `sourceFiles`, error `source`
   * refs, the rule `path` that becomes an artifact's provenance — has to stay
   * repo-relative. Re-rooting would make them relative to the package instead, and
   * `state.json`, the diff and every hint would then name a path that does not exist
   * from where the user is standing.
   */
  readonly dir?: string;
}

export interface ParseResult {
  readonly canonical: Canonical;
  readonly errors: readonly RulegateError[];
  readonly warnings: readonly RulegateError[];
  readonly mode: CanonicalMode | 'none';
  /** Every file read, repo-relative POSIX, sorted. Feeds `doctor` and state. */
  readonly sourceFiles: readonly string[];
}

/**
 * Read `.rulegate/` (or a bare AGENTS.md) into the canonical model.
 *
 * This never throws for anything a user could have written. It accumulates, so three
 * broken rule files produce three messages in one run rather than a game of
 * whack-a-mole. `sync` refuses to proceed when `errors` is non-empty.
 */
export async function parse(input: ParseInput): Promise<ParseResult> {
  const { fs } = input;
  const errors: RulegateError[] = [];
  const warnings: RulegateError[] = [];
  const sourceFiles: string[] = [];

  const dir = input.dir === undefined || input.dir === '' ? '' : normalizeRelative(input.dir);
  const at = (p: string): string => (dir === '' ? p : `${dir}/${p}`);

  const manifestRaw = await fs.tryReadFile(at(MANIFEST_PATH));
  const ruleFiles = (await fs.glob(at(RULES_GLOB))).filter((p) =>
    p.startsWith(`${at(RULES_DIR)}/`),
  );

  let mode: CanonicalMode | 'none';
  let manifest: RulegateManifest;

  if (manifestRaw !== undefined) {
    mode = 'rulegate-dir';
    sourceFiles.push(at(MANIFEST_PATH));
    const parsed = parseManifest(manifestRaw);
    manifest = parsed.manifest;
    errors.push(...parsed.errors);
    errors.push(...checkKnownTools(manifest, input.knownTools));
  } else if (ruleFiles.length > 0) {
    mode = 'rules-only';
    manifest = syntheticManifest(at(RULES_DIR), input.knownTools ?? [], []);
    // A nested level says something different from the root. The synthetic manifest is
    // only what this function can see on its own; `resolveNested` then replaces it with
    // the nearest ancestor's, which is the whole point of a rules-only package (T061). A
    // message promising "every detected tool" there would describe a tool list the run
    // does not use, and would send the reader off to write a manifest they do not need.
    warnings.push(
      new RulegateError({
        code: 'E_MANIFEST_INVALID',
        message:
          dir === ''
            ? `no ${MANIFEST_PATH}; assuming every detected tool is enabled`
            : `no ${at(MANIFEST_PATH)}; this level inherits the nearest ancestor's tool list`,
        source: { file: at(RULES_DIR) },
        hint:
          dir === ''
            ? `run: rulegate init  (or create ${MANIFEST_PATH})`
            : `create ${at(MANIFEST_PATH)} to give this level its own tool list`,
      }),
    );
  } else if (dir === '' && (await fs.exists(AGENTS_MD))) {
    mode = 'bare-agents-md';
    // AGENTS.md is canonical input here, so it is registered as a protected source.
    // Without this the Codex adapter (T014) would happily overwrite the very file it
    // was generated from.
    manifest = syntheticManifest(AGENTS_MD, input.knownTools ?? [], [AGENTS_MD]);
  } else {
    return {
      canonical: emptyResultCanonical(),
      errors: [
        new RulegateError({
          code: 'E_NO_CANONICAL_SOURCE',
          message: `no canonical source found (.rulegate/ or AGENTS.md)${dir === '' ? '' : ` in ${dir}`}`,
          source: { file: dir === '' ? '.' : dir },
          hint: 'run: rulegate init',
        }),
      ],
      warnings,
      mode: 'none',
      sourceFiles: [],
    };
  }

  const rules: RuleDocument[] = [];

  if (mode === 'bare-agents-md') {
    const raw = await fs.readFile(AGENTS_MD);
    sourceFiles.push(AGENTS_MD);
    const parsed = parseRuleFile(AGENTS_MD, raw);
    errors.push(...parsed.errors);
    if (parsed.rule) rules.push({ ...parsed.rule, id: 'agents' });
  } else {
    for (const path of ruleFiles) {
      const raw = await fs.readFile(path);
      sourceFiles.push(path);
      const parsed = parseRuleFile(path, raw);
      errors.push(...parsed.errors);
      if (parsed.rule) rules.push(parsed.rule);
    }
    errors.push(...detectIdConflicts(ruleFiles));
  }

  // MCP lives beside the rules, so it is read in every mode that has a `.rulegate/`.
  // A bare `AGENTS.md` repository has nowhere to put it and is not searched.
  const mcpServers: McpServer[] = [];
  if (mode !== 'bare-agents-md') {
    const mcpRaw = await fs.tryReadFile(at(MCP_SERVERS_PATH));
    if (mcpRaw !== undefined) {
      sourceFiles.push(at(MCP_SERVERS_PATH));
      const parsed = parseMcpServers(mcpRaw);
      mcpServers.push(...parsed.servers);
      errors.push(...parsed.errors);
    }
  }

  sourceFiles.sort(compareCodepoint);

  return {
    canonical: {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      manifest,
      rules,
      mcpServers,
      skills: [],
    },
    errors,
    warnings,
    mode,
    sourceFiles,
  };
}

/**
 * A tool id nobody claims is almost always a typo, and an unvalidated one is a config
 * line that silently does nothing — the user sees a tool "enabled" and no output for
 * it. Only checked when the caller says which adapters are registered; parsing with no
 * registry (tests, `doctor` on an unknown repo) stays permissive.
 */
function checkKnownTools(
  manifest: RulegateManifest,
  knownTools: readonly string[] | undefined,
): RulegateError[] {
  if (knownTools === undefined || knownTools.length === 0) return [];
  const out: RulegateError[] = [];
  for (const tool of manifest.tools) {
    if (knownTools.includes(tool.id)) continue;
    const guess = suggest(tool.id, knownTools);
    out.push(
      new RulegateError({
        code: 'E_UNKNOWN_TOOL',
        message: `no adapter named \`${tool.id}\``,
        source: tool.source,
        hint:
          guess === undefined
            ? `known adapters: ${[...knownTools].sort().join(', ')}`
            : `did you mean \`${guess}\`?`,
      }),
    );
  }
  return out;
}

/**
 * Two files can normalize to one id — `a/b.md` and `a\b.md` on Windows, or NFC and
 * NFD spellings of the same accented name. Silently keeping the last one read would
 * make output depend on filesystem order, so this is an error.
 */
function detectIdConflicts(paths: readonly string[]): RulegateError[] {
  const byId = new Map<string, string[]>();
  for (const path of paths) {
    const id = deriveRuleId(path);
    byId.set(id, [...(byId.get(id) ?? []), path]);
  }
  const out: RulegateError[] = [];
  for (const [id, files] of byId) {
    if (files.length < 2) continue;
    out.push(
      new RulegateError({
        code: 'E_RULE_ID_CONFLICT',
        message: `rule id \`${id}\` is claimed by ${files.join(' and ')}`,
        source: { file: files[0]! },
        hint: 'rename one of the files so each rule has a unique id',
      }),
    );
  }
  return out;
}

function syntheticManifest(
  file: string,
  knownTools: readonly string[],
  canonicalSources: readonly string[],
): RulegateManifest {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    tools: knownTools.map((id) => ({ id, enabled: true, options: {}, source: { file } })),
    options: DEFAULT_MANIFEST_OPTIONS,
    canonicalSources,
    lint: DEFAULT_LINT_CONFIG,
    source: { file },
  };
}

function emptyResultCanonical(): Canonical {
  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    manifest: {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      tools: [],
      options: DEFAULT_MANIFEST_OPTIONS,
      canonicalSources: [],
      lint: DEFAULT_LINT_CONFIG,
      source: { file: '.' },
    },
    rules: [],
    mcpServers: [],
    skills: [],
  };
}

export { parseManifest } from './manifest.js';
export { parseRuleFile } from './rules.js';
export { splitFrontmatter } from './frontmatter.js';
