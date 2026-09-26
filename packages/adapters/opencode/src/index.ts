import {
  ADAPTER_API_VERSION,
  RulegateError,
  basenamePosix,
  claimRuleId,
  detected,
  finalizeArtifact,
  importConcatenated,
  importRuleId,
  isCanonicalSource,
  renderRuleSection,
  selects,
  slugForId,
  sortRules,
  stableJsonStringify,
  stripJsonc,
  withHtmlMarker,
  withJsonMarker,
  type Adapter,
  type AdapterContext,
  type Artifact,
  type DetectResult,
  type ImportResult,
  type RuleDocument,
} from '@rulegate/adapter-kit';
import { resolveInstructions } from './instructions.js';
import { docs } from './docs.js';

/**
 * The config layer Rulegate owns whole: `.opencode/opencode.json`.
 *
 * Never the root `opencode.json`. That file holds the user's model, providers and
 * permissions, and the kit has no "merged in place" artifact — `Artifact.contents` is a
 * whole file, and `state.json` records ownership of whole files. agent-os merged into the
 * root config; porting that would be the first write Rulegate ever made into a file it did
 * not generate. OpenCode loads `.opencode/opencode.json` as a separate layer and
 * **concatenates `instructions` across layers** (`mergeConfigConcatArrays` in
 * `packages/opencode/src/config/config.ts`), so owning this one file adds our rules to the
 * user's without touching theirs. It is the `.codex/config.toml` decision again: own the
 * file entirely, or not at all. An existing `.opencode/opencode.json` Rulegate did not
 * write is refused by `sync` like any other unowned file.
 */
export const CONFIG_FILE = '.opencode/opencode.json';
export const RULES_DIR = '.opencode/rules';
export const CONFIG_SCHEMA = 'https://opencode.ai/config.json';

/** Root first, then `.opencode/`: the order OpenCode merges them, so the order it lists them. */
const READ_CONFIGS = [
  'opencode.json',
  'opencode.jsonc',
  CONFIG_FILE,
  '.opencode/opencode.jsonc',
] as const;

const DETECTION_PATHS = ['.opencode', 'opencode.json', 'opencode.jsonc'] as const;

async function detect(ctx: AdapterContext): Promise<DetectResult> {
  const evidence: string[] = [];
  for (const path of DETECTION_PATHS) {
    if (await ctx.fs.exists(path)) evidence.push(path);
  }
  return detected(evidence);
}

/**
 * The top-level keys of `CONFIG_FILE` that Rulegate does not write.
 *
 * OpenCode loads `.opencode/opencode.json` as a whole config layer, so a user may keep
 * `model`, `permission` or `mcp` there. `init` takes ownership of every file it plans with
 * a backup, and this file is one it plans — so without this warning a permission policy
 * would stop applying with nothing said. The codex adapter warns the same way about
 * `.codex/config.toml`.
 */
async function foreignConfigKeys(ctx: AdapterContext): Promise<readonly string[]> {
  const contents = await ctx.fs.tryReadFile(CONFIG_FILE);
  if (contents === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(contents));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  return Object.keys(parsed)
    .filter((k) => k !== '$schema' && k !== 'instructions')
    .sort();
}

/**
 * The local files OpenCode's `instructions` point at, one rule per file.
 *
 * `AGENTS.md` and `CLAUDE.md` are what OpenCode reads first and are deliberately not
 * imported: codex and claude-code own them. What is left is what only OpenCode sends —
 * the files its configs list — and `resolveInstructions` refuses to follow an entry off
 * the machine, out of the repository, or into another importer's source tree.
 *
 * A file listed by a config Rulegate never writes stays listed after `init`, and OpenCode
 * de-duplicates `instructions` by path only — so unless the file already sits where the
 * render puts it, OpenCode sends the rule twice. `doctor` cannot see that (the original and
 * the render share neither a rule id nor bytes), so it is said here, once, at import.
 */
async function read(ctx: AdapterContext): Promise<ImportResult> {
  const manifest = ctx.canonical.manifest;
  const configs = READ_CONFIGS.filter((c) => !isCanonicalSource(manifest, c));
  const resolved = await resolveInstructions(
    ctx.fs,
    configs,
    (p) => isCanonicalSource(manifest, p),
    'opencode',
  );
  const warnings = [...resolved.warnings];

  const foreign = configs.includes(CONFIG_FILE) ? await foreignConfigKeys(ctx) : [];
  if (foreign.length > 0) {
    warnings.push(
      `${CONFIG_FILE}: ${String(foreign.length)} setting(s) (${foreign.join(', ')}) are not imported. Rulegate owns this whole file once it writes it, so they will stop applying after \`init --yes\` or the first \`sync --force\` — move them to the root opencode.json first.`,
    );
  }

  const rules: RuleDocument[] = [];
  const taken = new Set<string>();
  for (const { path, config, entry } of resolved.files) {
    const contents = await ctx.fs.tryReadFile(path);
    if (contents === undefined) continue;
    const base = basenamePosix(path).replace(/\.[^.]+$/, '');
    const id = importRuleId(base, 'opencode');
    // A file Rulegate wrote is one `##` section — split it back into its heading, globs and
    // body. Any other file is imported whole, which is what `importConcatenated` does for a
    // file without the marker.
    const fromFile = importConcatenated({ file: path, contents, idFallback: id }).map((rule) => ({
      ...rule,
      id: claimRuleId(id, taken),
    }));
    rules.push(...fromFile);

    const inPlace =
      fromFile.length === 1 && `${RULES_DIR}/${slugForId(fromFile[0]!.id)}.md` === path;
    if (config !== CONFIG_FILE && !inPlace) {
      warnings.push(
        `${path}: ${config} lists it (\`${entry}\`), and Rulegate never writes ${config}, so OpenCode keeps loading it beside the generated copy under ${RULES_DIR}/ — once \`init --yes\` has run, remove that entry from ${config} or OpenCode sends this rule twice`,
      );
    }
  }

  // `write()` renders into the whole of RULES_DIR, but only listed files are imported. An
  // unlisted one is not loaded by OpenCode, so importing it would switch on a rule that is
  // off today — and `init` applies with `force`, on the premise that every path it
  // overwrites is one it imported from. Said here so the dry run names it before `--yes`.
  const imported = new Set(resolved.files.map((f) => f.path));
  for (const path of await ctx.fs.glob(`${RULES_DIR}/*.md`)) {
    if (imported.has(path) || isCanonicalSource(manifest, path)) continue;
    warnings.push(
      `${path}: no OpenCode config lists it, so OpenCode does not load it and it was not imported; it sits where Rulegate renders rules, and \`init --yes\` replaces it, with a backup under .rulegate/backup/, if an imported rule is named \`${basenamePosix(path).replace(/\.md$/, '')}\` — move it out of ${RULES_DIR}/ first to keep it in place`,
    );
  }

  return {
    ...(rules.length === 0 ? {} : { rules }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/**
 * `.opencode/rules/<id>.md` per rule, and the `.opencode/opencode.json` that lists them.
 *
 * The list is explicit and in canonical order, never a glob: OpenCode loads instructions in
 * the order they are listed, and a `.opencode/rules/*.md` entry would also sweep in any file
 * a user dropped into the directory. OpenCode has no per-glob mechanism, so a scoped rule
 * keeps the prose `**Applies to:**` line.
 */
function write(ctx: AdapterContext): Promise<readonly Artifact[]> {
  const { canonical } = ctx;
  const marker = canonical.manifest.options.marker;
  const rules = sortRules(canonical.rules.filter((r) => selects(r.frontmatter.tools, 'opencode')));
  if (rules.length === 0 || isCanonicalSource(canonical.manifest, CONFIG_FILE)) {
    return Promise.resolve([]);
  }

  const artifacts: Artifact[] = [];
  const claimed = new Map<string, string>();

  for (const rule of rules) {
    const path = `${RULES_DIR}/${slugForId(rule.id)}.md`;
    const previous = claimed.get(path);
    if (previous !== undefined) {
      throw new RulegateError({
        code: 'E_ARTIFACT_PATH_CONFLICT',
        message: `rules \`${previous}\` and \`${rule.id}\` both render to ${path}`,
        source: rule.source,
        hint: 'rename one of them; opencode rule filenames are flattened rule ids',
      });
    }
    claimed.set(path, rule.id);

    artifacts.push(
      finalizeArtifact({
        path,
        contents: withHtmlMarker(
          renderRuleSection(rule, { headingLevel: 2, showGlobs: true }),
          marker,
        ),
        adapter: 'opencode',
        kind: 'rules',
        provenance: { ruleIds: [rule.id] },
      }),
    );
  }

  artifacts.push(
    finalizeArtifact({
      path: CONFIG_FILE,
      // The marker is off here whatever `options.marker` says. OpenCode's config schema
      // sets `additionalProperties: false`, so the `"//"` key would make OpenCode reject
      // the file as invalid on startup. Ownership still lives in `state.json`, where it
      // always has; nothing in core infers it from a JSON marker.
      contents: stableJsonStringify(
        withJsonMarker({ $schema: CONFIG_SCHEMA, instructions: [...claimed.keys()] }, false),
      ),
      adapter: 'opencode',
      // No provenance: the file lists paths, not rules, so `sync --import` has no section
      // to map an edit back to and should say so rather than try.
      kind: 'other',
    }),
  );

  return Promise.resolve(artifacts);
}

export const opencode: Adapter = {
  name: 'opencode',
  apiVersion: ADAPTER_API_VERSION,
  detect,
  read,
  write,
  docs,
};

export default opencode;
export { docs };
