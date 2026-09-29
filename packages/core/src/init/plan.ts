import { formatterWarnings } from './formatters.js';
import { backupSecretWarnings } from './backup-secrets.js';
import { sizeCapWarnings } from './size-caps.js';
import { RulegateError } from '../model/errors.js';
import {
  CANONICAL_SCHEMA_VERSION,
  DEFAULT_MANIFEST_OPTIONS,
  emptyCanonical,
} from '../model/canonical.js';
import { DEFAULT_LINT_CONFIG } from '../model/lint.js';
import {
  MANIFEST_PATH,
  MCP_SERVERS_PATH,
  RULES_DIR,
  RULES_GLOB,
  SKILLS_DIR,
} from '../model/paths.js';
import { serializeCanonical, serializeSkill } from '../model/serialize.js';
import { importSkills } from './skills.js';
import { importCommands } from './commands.js';
import { parse } from '../parse/index.js';
import { MemoryFileSystem } from '../io/memory.js';
import { compareCodepoint } from '../render/order.js';
import { detectTools } from '../detect/engine.js';
import { collectImports } from '../import/collect.js';
import { filesOnly, notAFile } from '../fs/files-only.js';
import { maskPaths } from '../fs/mask.js';
import { pathKeyFor, probeCaseInsensitive, type PathKey } from '../fs/case.js';
import { ADAPTER_API_VERSION } from '../adapter/context.js';
import { ORDER_STEP, dedupeImported, type ImportConflict } from '../import/dedupe.js';
import { claimRuleId } from '../import/rule.js';
import { dedupeMcpServers, type McpImportConflict } from '../import/dedupe-mcp.js';
import { computePlan, type Plan } from '../pipeline/plan.js';
import { artifactHash, hashOnDisk, isBinaryArtifact } from '../state/state.js';
import type { Artifact } from '../adapter/artifact.js';
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
   * Read-only importers for competing rule-sync tools (T048).
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
    readonly inferred?: readonly string[];
    readonly skillSources?: readonly string[];
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
   * Server ids one tool defined differently from another (T040).
   *
   * Separate from `conflicts` because the two are resolved differently and a caller must
   * not print them the same way: a rule conflict keeps both variants and asks, while a
   * server id is a mapping key and can only have one definition, so one is taken and the
   * divergence is reported.
   */
  readonly mcpConflicts: readonly McpImportConflict[];
  /** Competing rule-sync tools found in the repository and imported from (T048). */
  readonly interop: readonly string[];
  /**
   * Paths in `plan` that already exist with other bytes and that nothing was imported from
   * (T124). Applying backs each up and replaces it like every other file init takes over;
   * listed so the caller can say so beside the path, because nothing in it reached
   * `.rulegate/`.
   */
  readonly unimported: readonly string[];
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
      unimported: [],
      warnings: adoptedPlan.warnings,
      errors: adoptedPlan.errors,
    };
  }

  // Interop runs first, and its results shape the adapter pass. ruler and rulesync generate
  // the files the adapters import from, so without masking the observed outputs every rule
  // arrives twice — once from the source the user edits, once from the copy built out of it.
  const interopRules: RuleDocument[] = [];
  // Every file anything was imported from, for T124's check of what init replaces.
  const importedFrom = new Set<string>();
  // Path -> the importer that generated it, for the warning about outputs left behind.
  const generated = new Map<string, string>();
  // The subset of `generated` an importer took on its presence alone, not its content.
  const inferred = new Set<string>();
  const interopTools = new Set<string>();
  const skillSources: string[] = [];
  const interopFound: string[] = [];
  for (const importer of input.interop ?? []) {
    const ctx = {
      repoRoot,
      canonical: emptyCanonical({ file: MANIFEST_PATH }),
      fs: filesOnly(fs),
      options: {},
      apiVersion: ADAPTER_API_VERSION,
    };
    if (!(await importer.detect(ctx))) continue;
    const found = await importer.read(ctx);
    interopRules.push(...found.rules);
    for (const rule of found.rules) importedFrom.add(rule.source.file);
    for (const path of found.generated) generated.set(path, importer.displayName);
    for (const path of found.inferred ?? []) inferred.add(path);
    skillSources.push(...(found.skillSources ?? []));
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

  // A competing tool's generated output is never a source: it is hidden from the adapters and
  // from the skills importer alike, or its copies arrive beside the source it was built from.
  const importFs = generated.size === 0 ? fs : maskPaths(fs, generated.keys());
  const collected = await collectImports({
    repoRoot,
    fs: importFs,
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
  const imported = await importSkills(filesOnly(importFs), adapters, detected, skillSources);
  warnings.push(...imported.warnings);
  for (const file of imported.importedFrom) importedFrom.add(file);
  const commands = await importCommands(filesOnly(importFs), adapters, detected);
  warnings.push(...commands.warnings);
  for (const file of commands.importedFrom) importedFrom.add(file);
  const canonical = canonicalFrom(rules, mcpServers, detected, imported.skills, commands.commands);

  // Import warnings are warnings and never errors. `runInit` returns without writing while
  // `errors` is non-empty, so one odd server in somebody's `.mcp.json` would otherwise make
  // a new user's very first command fail on a file Rulegate merely read — T071's shape.
  for (const source of collected.sources) {
    for (const message of source.mcpWarnings) {
      warnings.push(new RulegateError({ code: 'W_MCP_IMPORT', message }));
    }
  }

  // The plan is rendered from the canonical files as `check` will read them, not from the
  // model they were serialized out of (T115). Rendering the in-memory model applied a plan
  // that the written `.rulegate/` did not describe whenever the trip lost something — two
  // rules on one path, a preserved `order` key read back as a string — and the first
  // `check` after `init --yes` exited 1. What is lost on the trip is refused below.
  const serialized = serializeCanonical(canonical);
  // Skills beside the text files: a skill's assets are bytes, which the text map cannot hold.
  const skillFiles = new Map<string, string | Uint8Array>();
  for (const skill of canonical.skills) {
    for (const [path, contents] of serializeSkill(skill)) skillFiles.set(path, contents);
  }
  const canonicalFiles = await classify(serialized, skillFiles, fs);
  errors.push(...(await canonicalInTheWay(fs, serialized, skillFiles)));
  const written = await parse({
    fs: new MemoryFileSystem([...serialized, ...skillFiles]),
    knownTools: adapters.map((a) => a.name),
  });
  const plan = await computePlan({
    repoRoot,
    fs,
    adapters,
    canonical: written.errors.length === 0 ? written.canonical : canonical,
  });
  errors.push(...written.errors.map(unreadableCanonical));
  errors.push(...plan.errors);
  warnings.push(...plan.warnings);
  if (errors.length === 0) {
    const fromModel = await computePlan({ repoRoot, fs, adapters, canonical });
    errors.push(...lostInWriting(fromModel.artifacts, plan.artifacts));
  }
  const generatedPaths = plan.artifacts.map((a) => a.path);
  errors.push(...(await notFiles(fs, plan.artifacts)));
  for (const source of collected.sources) {
    for (const rule of source.rules) importedFrom.add(rule.source.file);
    for (const server of source.mcpServers) importedFrom.add(server.source.file);
  }
  const key = pathKeyFor(await probeCaseInsensitive(fs));
  const verified = [...generated.keys()].filter((path) => !inferred.has(path));
  // Through `filesOnly`: a path `notFiles` refused is already an error, and each check below
  // would otherwise throw on it with a bare errno before the refusal could be reported.
  const probe = filesOnly(fs);
  const unimported = await unimportedPaths(probe, plan.artifacts, importedFrom, verified, key);
  const inferredBy = (file: string): string | undefined => {
    const by = [...inferred].find((g) => covers(g, file, key));
    return by === undefined ? undefined : generated.get(by);
  };
  warnings.push(...unimported.map((file) => unimportedWarning(file, inferredBy(file))));
  warnings.push(...(await formatterWarnings({ fs: probe, generated: generatedPaths })));
  warnings.push(...(await backupSecretWarnings({ fs: probe, taking: generatedPaths })));
  warnings.push(
    ...(await sizeCapWarnings({
      fs: probe,
      artifacts: plan.artifacts,
      adapters,
      enabled: detected,
    })),
  );
  warnings.push(...leftBehindWarnings(collected.sources, generatedPaths));
  warnings.push(...skillsLeftBehind(imported.copies, generatedPaths, adapters, detected));
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
    unimported,
    warnings,
    errors,
  };
}

/**
 * Rendered paths that exist with other bytes and that init did not import from (T124).
 *
 * `init` applies with `force`, on the premise that everything it overwrites is a file it
 * just imported from — so its content is in `.rulegate/` and the copy in
 * `.rulegate/backup/` is only a courtesy. A file an adapter renders to but did not read
 * breaks that premise: OpenCode's `.opencode/opencode.json` with settings in it, or an
 * unlisted `.opencode/rules/<id>.md` whose name an imported rule takes. Asked generically,
 * of every rendered path, rather than left to each adapter to warn about its own, because
 * the next adapter with a config file of its own would otherwise repeat the bug.
 *
 * A competing tool's generated output counts as imported only when the importer read the
 * file and found its mark (`verified`): its source came across instead, and a directory it
 * generates into covers every file in it. An output inferred from the tool's presence alone
 * is checked like any other file, because a hand-written `CLAUDE.md` in a repository that
 * uses rulesync for Cursor only is masked from the adapter pass all the same, and nothing
 * in it reached `.rulegate/`.
 *
 * Paths are compared under `key`, case-folded only where the filesystem folds: on APFS the
 * imported `TypeScript.mdc` *is* the rendered `typescript.mdc`, and calling it a file
 * nothing was imported from contradicts the warning that says it was.
 * Byte-equal files are not listed: applying leaves them untouched.
 */
async function unimportedPaths(
  fs: ReadOnlyFileSystem,
  artifacts: readonly Artifact[],
  importedFrom: ReadonlySet<string>,
  verified: readonly string[],
  key: PathKey,
): Promise<readonly string[]> {
  const imported = new Set([...importedFrom].map(key));
  const out: string[] = [];
  for (const artifact of artifacts) {
    if (imported.has(key(artifact.path))) continue;
    if (verified.some((g) => covers(g, artifact.path, key))) continue;
    const onDisk = await hashOnDisk(fs, artifact.path, isBinaryArtifact(artifact));
    if (onDisk === undefined) continue;
    if (onDisk === artifactHash(artifact)) continue;
    out.push(artifact.path);
  }
  return out.sort(compareCodepoint);
}

/**
 * Rendered paths that no file can be written to: a directory stands there, or a file stands
 * where one of its parent directories must go (T148).
 *
 * Detection counts a directory as evidence as readily as a file — `.rules/` enables Zed, a
 * legacy `.clinerules` file enables Cline, whose output is the `.clinerules/` directory — and
 * once another tool's rules arrive unscoped, that adapter renders onto the very path.
 * Reported here, by path and before anything is written, rather than left to the reads below
 * and to `applyPlan`, where it surfaced as a bare EISDIR or ENOTDIR with no path in it.
 */
async function notFiles(
  fs: ReadOnlyFileSystem,
  artifacts: readonly Artifact[],
): Promise<readonly RulegateError[]> {
  const out: RulegateError[] = [];
  for (const { path: file, adapter } of artifacts) {
    let what: string | undefined;
    try {
      // Absent is not yet free: Windows answers ENOENT, not ENOTDIR, beneath a file, so a
      // file standing where a parent directory goes is found by walking the parents.
      if ((await fs.tryReadFile(file)) === undefined && (await fileAncestor(fs, file))) {
        what = 'a file stands where one of its parent directories goes';
      }
    } catch (e) {
      if (!notAFile(e)) throw e;
      what =
        (e as { code?: string }).code === 'EISDIR'
          ? 'a directory stands there'
          : 'a file stands where one of its parent directories goes';
    }
    if (what !== undefined) {
      out.push(
        new RulegateError({
          code: 'E_INIT_NOT_A_FILE',
          message: `${adapter} generates this file, and ${what}`,
          source: { file },
          hint: `${adapter} is enabled because its configuration was detected here; move or rename what is in the way and run init again`,
        }),
      );
    }
  }
  return out;
}

/**
 * Is one of `file`'s parent directories a regular file? A directory answers EISDIR to a
 * read and an absent parent ends the walk, since nothing can stand beneath it.
 */
async function fileAncestor(fs: ReadOnlyFileSystem, file: string): Promise<boolean> {
  const parts = file.split('/');
  for (let i = 1; i < parts.length; i++) {
    try {
      if ((await fs.tryReadFile(parts.slice(0, i).join('/'))) === undefined) return false;
      return true;
    } catch (e) {
      if (!notAFile(e)) throw e;
      if ((e as { code?: string }).code === 'ENOTDIR') return true;
    }
  }
  return false;
}

/** Is `file` the generated path `output`, or inside the directory it names? */
function covers(output: string, file: string, key: PathKey): boolean {
  const [o, f] = [key(output), key(file)];
  return f === o || f.startsWith(`${o}/`);
}

function unimportedWarning(file: string, inferredBy: string | undefined): RulegateError {
  return new RulegateError({
    code: 'W_INIT_NOT_IMPORTED',
    message:
      inferredBy === undefined
        ? `${file} exists and nothing was imported from it: applying backs it up to .rulegate/backup/${file} and replaces it with generated output`
        : `${file} exists and was not imported: it is taken for ${inferredBy}'s output only because ${inferredBy} is set up here, and applying backs it up to .rulegate/backup/${file} and replaces it with generated output`,
    source: { file },
    hint:
      inferredBy === undefined
        ? `if it holds anything you still need, such as settings or rules the tool does not load, copy it out before running init --yes; afterwards the original is only in .rulegate/backup/${file}`
        : `if ${inferredBy} generated it, its rules came across from ${inferredBy}'s source; if you wrote it by hand, copy what you need into .rulegate/rules/ before running init --yes; afterwards the original is only in .rulegate/backup/${file}`,
  });
}

/**
 * Canonical files already on disk that `init` would overwrite, or that `check` would read
 * beside the ones `init` writes.
 *
 * Reachable without a manifest: the parser's `rules-only` mode reads `.rulegate/rules/`
 * alone, and init's own no-tools hint says to write it by hand. The parse-back above runs
 * over only the files init writes, so a rule already there is invisible to it and the first
 * `check` renders it into files init just generated; one init would replace is the user's
 * source, and `applyCanonicalFiles` has no backup for it. Byte-equal files are fine, which
 * is the leave-alone case.
 */
async function canonicalInTheWay(
  fs: ReadOnlyFileSystem,
  serialized: ReadonlyMap<string, string>,
  skillFiles: ReadonlyMap<string, string | Uint8Array>,
): Promise<readonly RulegateError[]> {
  const onDisk = (await fs.glob(RULES_GLOB)).filter((p) => p.startsWith(`${RULES_DIR}/`));
  if (await fs.exists(MCP_SERVERS_PATH)) onDisk.push(MCP_SERVERS_PATH);
  // Skills too (T052): an asset is compared as bytes, as it will be written.
  onDisk.push(...(await fs.glob(`${SKILLS_DIR}/**`)).filter((p) => p.startsWith(`${SKILLS_DIR}/`)));
  const out: RulegateError[] = [];
  for (const file of [...new Set(onDisk)].sort(compareCodepoint)) {
    const ours = serialized.get(file) ?? skillFiles.get(file);
    if (typeof ours === 'string' && (await fs.tryReadFile(file)) === ours) continue;
    if (ours instanceof Uint8Array && sameBytes(await fs.readFileRaw(file), ours)) continue;
    out.push(
      new RulegateError({
        code: 'E_INIT_CANONICAL_EXISTS',
        message:
          ours === undefined
            ? `${file} already exists and is not one of the files init would write: \`check\` would render it beside what init imported`
            : `${file} already exists with other contents, and init would overwrite it`,
        source: { file },
        hint: `nothing was written. To keep it, create ${MANIFEST_PATH} and run: rulegate sync; to import instead, move it out of .rulegate/ and run init again`,
      }),
    );
  }
  return out;
}

/**
 * A canonical file `init` would write that does not parse back (T115). Always Rulegate's
 * bug, never the user's — they have not written anything yet — so it names the file and
 * stops before anything is written, instead of leaving a `.rulegate/` no command can read.
 */
function unreadableCanonical(error: RulegateError): RulegateError {
  const file = error.source?.file ?? '.rulegate/';
  return new RulegateError({
    code: 'E_INIT_CANONICAL_MISMATCH',
    message: `${file}, as init would write it, does not read back: ${error.message}`,
    source: { file },
    hint: 'this is a Rulegate bug; nothing was written. Please report it with the file init imported this rule from',
  });
}

/**
 * Generated files whose render from the written `.rulegate/` differs from the render of
 * what was imported (T115).
 *
 * The applied plan is the first; a difference means the trip through `.rulegate/` changed
 * a rule, and applying it would take ownership of the user's files with content that is
 * not the content they had. Refused, not warned: that is the silent loss the T032 gate
 * exists to catch, and a refusal leaves every file where it was.
 */
function lostInWriting(
  imported: readonly Artifact[],
  written: readonly Artifact[],
): readonly RulegateError[] {
  // Instruction text only: a binary asset is compared by hash, never as a string (T052).
  const text = (a: Artifact): boolean => a.bytes === undefined;
  const render = new Map(written.filter(text).map((a) => [a.path, a.contents]));
  const paths = new Set([...imported.filter(text).map((a) => a.path), ...render.keys()]);
  const importedBy = new Map(imported.filter(text).map((a) => [a.path, a.contents]));
  return [...paths]
    .filter((path) => importedBy.get(path) !== render.get(path))
    .sort(compareCodepoint)
    .map(
      (file) =>
        new RulegateError({
          code: 'E_INIT_CANONICAL_MISMATCH',
          message: `${file} would not be generated from .rulegate/ as it was imported: the canonical rules init would write lose part of it`,
          source: { file },
          hint: 'this is a Rulegate bug; nothing was written. Please report it with the files init imported from',
        }),
    );
}

function canonicalFrom(
  rules: Canonical['rules'],
  mcpServers: Canonical['mcpServers'],
  detected: readonly ToolId[],
  skills: Canonical['skills'],
  commands: Canonical['commands'],
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
    skills,
    commands,
  };
}

async function classify(
  files: ReadonlyMap<string, string>,
  skillFiles: ReadonlyMap<string, string | Uint8Array>,
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
  for (const [path, contents] of skillFiles) {
    if (typeof contents === 'string') {
      const existing = await fs.tryReadFile(path);
      out.push({
        path,
        contents,
        kind: existing === undefined ? 'create' : existing === contents ? 'leave-alone' : 'modify',
      });
      continue;
    }
    const existing = (await fs.exists(path)) ? await fs.readFileRaw(path) : undefined;
    out.push({
      path,
      contents: '',
      bytes: contents,
      kind:
        existing === undefined
          ? 'create'
          : sameBytes(existing, contents)
            ? 'leave-alone'
            : 'modify',
    });
  }
  return out.sort((a, b) => compareCodepoint(a.path, b.path));
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * A tool's skill directory init imported from and that no generated file replaces (T052):
 * the tools reading it still load it, beside the generated copy — the skills half of
 * `leftBehindWarnings`.
 */
function skillsLeftBehind(
  copies: readonly { readonly dir: string; readonly id: string }[],
  generated: readonly string[],
  adapters: readonly Adapter[],
  detected: readonly ToolId[],
): readonly RulegateError[] {
  const written = new Set(generated);
  const out: RulegateError[] = [];
  for (const { dir, id } of copies) {
    if (written.has(`${dir}/${id}/SKILL.md`)) continue;
    const readers = adapters
      .filter((a) => detected.includes(a.name) && a.docs.skills?.dirs.includes(dir) === true)
      .map((a) => a.name)
      .sort(compareCodepoint);
    out.push(
      new RulegateError({
        code: 'W_IMPORT_LEFT_BEHIND',
        message: `${dir}/${id}/ was imported and stays on disk: ${readers.join(', ')} will load it beside the generated copy`,
        source: { file: `${dir}/${id}` },
        hint: `delete ${dir}/${id}/ once init has run; the skill now lives in .rulegate/skills/${id}/`,
      }),
    );
  }
  return out;
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
