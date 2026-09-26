import { formatterWarnings } from './formatters.js';
import { backupSecretWarnings } from './backup-secrets.js';
import { RulegateError } from '../model/errors.js';
import {
  CANONICAL_SCHEMA_VERSION,
  DEFAULT_MANIFEST_OPTIONS,
  emptyCanonical,
} from '../model/canonical.js';
import { DEFAULT_LINT_CONFIG } from '../model/lint.js';
import { MANIFEST_PATH } from '../model/paths.js';
import { serializeCanonical } from '../model/serialize.js';
import { compareCodepoint } from '../render/order.js';
import { detectTools } from '../detect/engine.js';
import { collectImports } from '../import/collect.js';
import { maskPaths } from '../fs/mask.js';
import { ADAPTER_API_VERSION } from '../adapter/context.js';
import { ORDER_STEP, dedupeImported, type ImportConflict } from '../import/dedupe.js';
import { claimRuleId } from '../import/rule.js';
import { dedupeMcpServers, type McpImportConflict } from '../import/dedupe-mcp.js';
import { computePlan, type Plan } from '../pipeline/plan.js';
import type { CanonicalFile } from '../pipeline/apply.js';
import type { Adapter } from '../adapter/adapter.js';
import type { AdapterContext } from '../adapter/context.js';
import type { RuleDocument } from '../model/rule.js';
import type { Canonical, ToolConfig } from '../model/canonical.js';
import type { ToolId } from '../model/ids.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export interface InitInput {
  readonly repoRoot: string;
  readonly fs: ReadOnlyFileSystem;
  readonly adapters: readonly Adapter[];
  /**
   * Read-only importers for competing rule-sync tools (T054).
   *
   * A separate list from `adapters`, and never merged into one: an adapter is a tool
   * Rulegate *generates for*, an interop importer is a tool it takes over *from*. Passing
   * ruler as an adapter would put it in `rulegate.yaml`, in `doctor`'s table and in every
   * rule's `tools:` selector — asserting Rulegate maintains a ruler config, which it must
   * never do. Optional, so every existing caller is unaffected.
   */
  readonly interop?: readonly InteropLike[];
}

/**
 * The shape `computeInitPlan` needs from an interop importer.
 *
 * Structural rather than an import of `@rulegate/interop`: `packages/core` depends on no
 * adapter and on no importer, and the dependency direction is what keeps core free of
 * tool-specific knowledge.
 */
export interface InteropLike {
  readonly name: string;
  readonly displayName: string;
  detect(ctx: AdapterContext): Promise<boolean>;
  read(ctx: AdapterContext): Promise<{
    readonly rules: readonly RuleDocument[];
    readonly generated: readonly string[];
    readonly notImported: readonly string[];
    readonly tools?: readonly string[];
    readonly notes?: readonly { readonly path: string; readonly message: string }[];
    readonly errors?: readonly RulegateError[];
  }>;
}

export interface InitPlan {
  /** True when the repository already has a `.rulegate/`. Then there is nothing to do. */
  readonly adopted: boolean;
  readonly detected: readonly ToolId[];
  readonly canonical: Canonical;
  /** The `.rulegate/` files init would write. */
  readonly canonicalFiles: readonly CanonicalFile[];
  /**
   * The artifact plan the first `sync` will apply, computed here from the same renderer.
   *
   * `init` shows it rather than only promising it, because the interesting question a
   * user has at this moment is not "what goes in `.rulegate/`" but "what happens to my
   * `CLAUDE.md`".
   */
  readonly plan: Plan;
  readonly conflicts: readonly ImportConflict[];
  /**
   * Server ids one tool defined differently from another (T048).
   *
   * Separate from `conflicts` because the two are resolved differently and a caller must
   * not print them the same way: a rule conflict keeps both variants and asks, while a
   * server id is a mapping key and can only have one definition, so one is taken and the
   * divergence is reported.
   */
  readonly mcpConflicts: readonly McpImportConflict[];
  /** Competing rule-sync tools found in the repository and imported from (T054). */
  readonly interop: readonly string[];
  readonly warnings: readonly RulegateError[];
  readonly errors: readonly RulegateError[];
}

/**
 * Detect -> import -> dedupe -> a plan of every file that would be created, modified or
 * left alone.
 *
 * Computes and writes nothing. Whether to apply it is the caller's decision and the
 * user's, which is the point: `init` is the first command anyone runs, on a repository
 * whose contents Rulegate did not write, and a first command that changes files before
 * showing what it will change is how a tool loses a user in one step.
 */
export async function computeInitPlan(input: InitInput): Promise<InitPlan> {
  const { repoRoot, fs, adapters } = input;
  const errors: RulegateError[] = [];
  const warnings: RulegateError[] = [];

  if (await fs.exists(MANIFEST_PATH)) {
    // Not an error. Running `init` twice is a reasonable thing to do, and the answer is
    // "you already have one" rather than a failure — and the repository now parses, so
    // the plan shown is the real one `sync` would apply.
    const adoptedPlan = await computePlan({ repoRoot, fs, adapters });
    return {
      adopted: true,
      detected: adoptedPlan.enabledAdapters,
      canonical: adoptedPlan.canonical,
      canonicalFiles: [],
      plan: adoptedPlan,
      conflicts: [],
      mcpConflicts: [],
      interop: [],
      warnings: adoptedPlan.warnings,
      errors: adoptedPlan.errors,
    };
  }

  // Interop runs first, and its results shape the adapter pass. ruler and rulesync generate
  // the files the adapters import from, so without masking the observed outputs every rule
  // arrives twice — once from the source the user edits, once from the copy built out of it.
  const interopRules: RuleDocument[] = [];
  // Path -> the importer that generated it, for the warning about outputs left behind.
  const generated = new Map<string, string>();
  const interopTools = new Set<string>();
  const interopFound: string[] = [];
  for (const importer of input.interop ?? []) {
    const ctx = {
      repoRoot,
      canonical: emptyCanonical({ file: MANIFEST_PATH }),
      fs,
      options: {},
      apiVersion: ADAPTER_API_VERSION,
    };
    if (!(await importer.detect(ctx))) continue;
    const found = await importer.read(ctx);
    interopRules.push(...found.rules);
    for (const path of found.generated) generated.set(path, importer.displayName);
    for (const tool of found.tools ?? []) interopTools.add(tool);
    errors.push(...(found.errors ?? []));
    interopFound.push(importer.displayName);
    for (const path of found.notImported) {
      warnings.push(
        new RulegateError({
          code: 'W_INTEROP_NOT_IMPORTED',
          message: `${importer.displayName}: \`${path}\` was found and not imported. Rulegate imports rules only; copy anything else across by hand before removing it.`,
        }),
      );
    }
    for (const note of found.notes ?? []) {
      warnings.push(
        new RulegateError({
          code: 'W_INTEROP_NOT_IMPORTED',
          message: `${importer.displayName}: \`${note.path}\`: ${note.message}`,
        }),
      );
    }
  }

  const detection = await detectTools({
    repoRoot,
    fs,
    adapters,
    canonical: emptyCanonical({ file: MANIFEST_PATH }),
  });
  const found = detection.tools.filter((t) => t.detected).map((t) => t.name);
  const present = adapters.filter((a) => found.includes(a.name));
  // The tools a competing tool was configured to generate for join the detected ones: its
  // config is the user's own statement of which tools they use, and the files on disk may
  // not show all of them yet. Only names an adapter answers to — an importer's word never
  // puts an unknown id into the manifest.
  const detected = adapters
    .map((a) => a.name)
    .filter((name) => found.includes(name) || interopTools.has(name));

  const collected = await collectImports({
    repoRoot,
    fs: generated.size === 0 ? fs : maskPaths(fs, generated.keys()),
    adapters: present,
  });
  errors.push(...collected.errors);

  const { rules: adapterRules, conflicts } = dedupeImported(collected.sources);
  // Interop rules first: they are the source a user edits, and document order becomes
  // canonical `order` (T018), so putting the generated copies ahead of them would rank a
  // derived file above its own source.
  //
  // Hence the renumbering: `importedRule` leaves every interop rule at the default order,
  // which ranks after every numbered adapter rule, and an order is the only thing that
  // survives serialization. And one id space across both halves, because each was claimed
  // separately — an importer's `style` rule and a `## Style` section of a hand-written
  // CLAUDE.md would otherwise both become `.rulegate/rules/style.md`.
  const taken = new Set<string>();
  const rules = [...interopRules, ...adapterRules].map((rule, index) => ({
    ...rule,
    id: claimRuleId(rule.id, taken),
    frontmatter: { ...rule.frontmatter, order: (index + 1) * ORDER_STEP },
  }));
  const { servers: mcpServers, conflicts: mcpConflicts } = dedupeMcpServers(collected.sources);
  const canonical = canonicalFrom(rules, mcpServers, detected);

  // Import warnings are warnings and never errors. `runInit` returns without writing while
  // `errors` is non-empty, so one odd server in somebody's `.mcp.json` would otherwise make
  // a new user's very first command fail on a file Rulegate merely read — T077's shape.
  for (const source of collected.sources) {
    for (const message of source.mcpWarnings) {
      warnings.push(new RulegateError({ code: 'W_MCP_IMPORT', message }));
    }
  }

  const plan = await computePlan({ repoRoot, fs, adapters, canonical });
  errors.push(...plan.errors);
  warnings.push(...plan.warnings);

  const canonicalFiles = await classify(serializeCanonical(canonical), fs);
  const generatedPaths = plan.artifacts.map((a) => a.path);
  warnings.push(...(await formatterWarnings({ fs, generated: generatedPaths })));
  warnings.push(...(await backupSecretWarnings({ fs, taking: generatedPaths })));
  warnings.push(...leftBehindWarnings(collected.sources, generatedPaths));
  // Only for a plan that will be applied: the hint is "delete it once init has run", and
  // when init refuses, the file it names may be the only copy of the output left.
  if (errors.length === 0) warnings.push(...outputLeftWarnings(generated, generatedPaths));

  return {
    adopted: false,
    detected,
    canonical,
    canonicalFiles,
    plan,
    conflicts,
    mcpConflicts,
    interop: interopFound,
    warnings,
    errors,
  };
}

function canonicalFrom(
  rules: Canonical['rules'],
  mcpServers: Canonical['mcpServers'],
  detected: readonly ToolId[],
): Canonical {
  const source = { file: MANIFEST_PATH };
  const tools: ToolConfig[] = [...detected]
    .sort(compareCodepoint)
    .map((id) => ({ id, enabled: true, options: {}, source }));

  return {
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    manifest: {
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      tools,
      options: DEFAULT_MANIFEST_OPTIONS,
      lint: DEFAULT_LINT_CONFIG,
      // Deliberately empty. The native files a user already has are what init just
      // imported *from*; from here they are generated output, and listing one as a
      // canonical source would freeze it as hand-maintained forever — the opposite of
      // what somebody running `init` asked for.
      canonicalSources: [],
      source,
    },
    rules,
    mcpServers,
    skills: [],
  };
}

async function classify(
  files: ReadonlyMap<string, string>,
  fs: ReadOnlyFileSystem,
): Promise<readonly CanonicalFile[]> {
  const out: CanonicalFile[] = [];
  for (const [path, contents] of files) {
    const existing = await fs.tryReadFile(path);
    out.push({
      path,
      contents,
      kind: existing === undefined ? 'create' : existing === contents ? 'leave-alone' : 'modify',
    });
  }
  return out.sort((a, b) => compareCodepoint(a.path, b.path));
}

/**
 * Imported files that no generated file replaces.
 *
 * Taking ownership of a file is what removes the original from play; a file imported from
 * and then left alone is still read by the tool that reads it, beside the generated copy
 * of the same rules. Compared case-folded as well, because on APFS and NTFS `API.md` and
 * `api.md` are one file and deleting the "left-behind" one would delete the output. The
 * hint cannot be "rename" either: the same text prints on the `--yes` run, and after it on
 * a case-sensitive filesystem a rename moves the original over the file Rulegate now owns,
 * which `check` then reports as hand-edited. Which filesystem this is cannot be known from
 * here, so the hint names what the user can see: a listing, because on a case-insensitive
 * filesystem a lookup of either name finds the one file and `test -e` would mislead.
 */
function leftBehindWarnings(
  sources: readonly { readonly tool: ToolId; readonly rules: readonly RuleDocument[] }[],
  generated: readonly string[],
): readonly RulegateError[] {
  const written = new Set(generated);
  const folded = new Map(generated.map((p) => [p.toLowerCase(), p]));
  const files = new Map<string, ToolId>();
  for (const source of sources) {
    for (const rule of source.rules) {
      if (!files.has(rule.source.file)) files.set(rule.source.file, source.tool);
    }
  }

  const out: RulegateError[] = [];
  for (const [file, tool] of [...files].sort(([a], [b]) => compareCodepoint(a, b))) {
    if (written.has(file)) continue;
    const renamed = folded.get(file.toLowerCase());
    out.push(
      new RulegateError({
        code: 'W_IMPORT_LEFT_BEHIND',
        message:
          renamed === undefined
            ? `${file} was imported for ${tool}, but no generated file replaces it: it stays on disk, and any tool that still reads it gets its rules a second time`
            : `${file} was imported for ${tool} and regenerates as ${renamed}: on a case-sensitive filesystem both stay on disk and its rules load twice`,
        source: { file },
        hint:
          renamed === undefined
            ? `delete ${file} once init has run; its content is in .rulegate/rules/ now`
            : `once init has run, list the directory: if it shows both ${file} and ${renamed}, delete ${file}; if it shows one, the filesystem ignores case, they are one file and nothing is left behind`,
      }),
    );
  }
  return out;
}

/**
 * Another tool's outputs that no enabled adapter renders back to the same path.
 *
 * They were masked from the import because their source came across instead, so nothing
 * else reports them: they are not imported, so `W_IMPORT_LEFT_BEHIND` never sees them, and
 * they are not in `state.json`, so `check` never compares them and `sync` can neither own
 * nor delete them. The tool that reads one keeps loading a copy of the rules that nothing
 * updates any more. Case is folded for the reason `leftBehindWarnings` gives: on a
 * case-insensitive filesystem `API.mdc` and `api.mdc` are one file, and "delete it" would
 * delete Rulegate's output.
 */
function outputLeftWarnings(
  generated: ReadonlyMap<string, string>,
  rendered: readonly string[],
): readonly RulegateError[] {
  const written = new Set(rendered);
  const folded = new Map(rendered.map((p) => [p.toLowerCase(), p]));
  const out: RulegateError[] = [];
  for (const [file, by] of [...generated].sort(([a], [b]) => compareCodepoint(a, b))) {
    if (written.has(file)) continue;
    // An importer may name a directory it generates into — rulesync's `.clinerules` — and
    // Rulegate renders into the same one. "Delete it" would delete Rulegate's own output
    // along with it, so a directory holding a rendered path is not left behind. Folded, for
    // the case-insensitive filesystem where `.ClineRules` is that same directory.
    const dir = `${file.toLowerCase()}/`;
    if (rendered.some((p) => p.toLowerCase().startsWith(dir))) continue;
    const renamed = folded.get(file.toLowerCase());
    out.push(
      new RulegateError({
        code: 'W_INTEROP_OUTPUT_LEFT',
        message:
          renamed === undefined
            ? `${file} was generated by ${by}, and nothing Rulegate generates replaces it: it stays on disk, unowned, and any tool that reads it keeps loading a copy of the rules that nothing updates`
            : `${file} was generated by ${by} and regenerates as ${renamed}: on a case-sensitive filesystem both stay on disk and its rules load twice`,
        source: { file },
        hint:
          renamed === undefined
            ? `once init has run, delete ${file} if ${by} generated it: the ${by} source it was built from is in .rulegate/rules/ now`
            : `once init has run, list the directory: if it shows both ${file} and ${renamed}, delete ${file}; if it shows one, the filesystem ignores case, they are one file and nothing is left behind`,
      }),
    );
  }
  return out;
}
