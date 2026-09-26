import {
  ADAPTER_API_VERSION,
  basenamePosix,
  claimRuleId,
  detected,
  dirnamePosix,
  finalizeArtifact,
  importConcatenated,
  importRuleId,
  isCanonicalSource,
  renderRuleSection,
  selects,
  slugForId,
  sortRules,
  withHtmlMarker,
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
 * The one Kilo path that is auto-loaded, plain Markdown, and not a config file.
 *
 * Current Kilo loads rules only through `instructions` in `kilo.jsonc`, and its Settings UI
 * writes that file — so owning it would make the tool itself produce hand-edit drift on
 * every settings change, and merging into it is a write into a file Rulegate did not
 * generate. `.kilocode/rules/*.md` is documented as still auto-loaded "for backward
 * compatibility", which is what makes it the only target a whole-file generator can own.
 * If Kilo drops the legacy loader, this adapter's output stops loading; `docs` says so.
 */
export const RULES_DIR = '.kilocode/rules';
export const LEGACY_FILE = '.kilocoderules';

/**
 * The modes Kilo's rules migrator looks for (`KNOWN_MODES` in
 * `packages/opencode/src/kilocode/rules-migrator.ts`). A `rules-<mode>` directory for any
 * other mode is never loaded, so it is not imported either.
 */
const KNOWN_MODES = ['code', 'architect', 'ask', 'debug', 'orchestrator'] as const;

/** Project configs in the order Kilo documents them; `.kilo/` takes priority. */
const READ_CONFIGS = ['kilo.json', 'kilo.jsonc', '.kilo/kilo.json', '.kilo/kilo.jsonc'] as const;

/**
 * Never `opencode.json`, although Kilo deep-merges it: that file is OpenCode's evidence,
 * and claiming it would report Kilo in every OpenCode repository.
 */
const DETECTION_PATHS = ['.kilo', '.kilocode', LEGACY_FILE, 'kilo.json', 'kilo.jsonc'] as const;

async function detect(ctx: AdapterContext): Promise<DetectResult> {
  const evidence: string[] = [];
  for (const path of DETECTION_PATHS) {
    if (await ctx.fs.exists(path)) evidence.push(path);
  }
  return detected(evidence);
}

/**
 * Everything Kilo auto-loads from the legacy layout, then what `kilo.json(c)` lists.
 *
 * Mode-specific rules (`.kilocoderules-<mode>`, `.kilocode/rules-<mode>/`) are imported as
 * ordinary rules, with a warning. That is not a simplification: Kilo's migrator loads them
 * in **every** mode, so an ordinary rule is exactly what Kilo sends today.
 *
 * `opencode.json` is not read even though Kilo merges it — the opencode adapter imports it,
 * and reading it here too would hand `init` the same rules twice. `AGENTS.md` is codex's.
 *
 * Every source except a `.kilocode/rules/NNN-<id>.md` is at a path the render never
 * writes, so after `init` Kilo loads the original *and* the generated copy. `init` takes
 * ownership only of the paths it renders, and `doctor` cannot pair an original with its
 * render (they share neither a rule id nor bytes), so each such file is named here.
 */
async function read(ctx: AdapterContext): Promise<ImportResult> {
  const manifest = ctx.canonical.manifest;
  const legacy: string[] = [];
  const warnings: string[] = [];

  for (const path of await ctx.fs.glob(`${RULES_DIR}/**/*.md`)) {
    if (dirnamePosix(path) !== RULES_DIR) {
      warnings.push(
        `${path}: Kilo loads only the immediate .md children of ${RULES_DIR}/, so this file is not loaded and was not imported`,
      );
      continue;
    }
    legacy.push(path);
  }
  if (await ctx.fs.exists(LEGACY_FILE)) legacy.push(LEGACY_FILE);
  for (const mode of KNOWN_MODES) {
    const modeFiles = [
      ...(await ctx.fs.glob(`.kilocode/rules-${mode}/*.md`)),
      ...((await ctx.fs.exists(`${LEGACY_FILE}-${mode}`)) ? [`${LEGACY_FILE}-${mode}`] : []),
    ];
    for (const path of modeFiles) {
      warnings.push(
        `${path}: a rule for the ${mode} mode; Kilo loads mode-specific rules in every mode, so it was imported as an ordinary rule`,
      );
      legacy.push(path);
    }
  }

  const loaded = new Set(legacy);
  const configs = READ_CONFIGS.filter((c) => !isCanonicalSource(manifest, c));
  const listed = await resolveInstructions(
    ctx.fs,
    configs,
    (p) => loaded.has(p) || isCanonicalSource(manifest, p),
    'kilo',
  );
  warnings.push(...listed.warnings);

  const stillLoaded = new Map<string, string>();
  for (const path of legacy) {
    // An indexed name is almost certainly an earlier render, which `init` takes over by path.
    if (dirnamePosix(path) === RULES_DIR && /^\d{3}-/.test(basenamePosix(path))) continue;
    stillLoaded.set(
      path,
      `${path}: Kilo keeps auto-loading this file beside the generated copy in ${RULES_DIR}/ — once \`init --yes\` has run, delete it or Kilo sends this rule twice`,
    );
  }
  for (const { path, config, entry } of listed.files) {
    stillLoaded.set(
      path,
      `${path}: ${config} lists it (\`${entry}\`), and Rulegate never writes ${config}, so Kilo keeps loading it beside the generated copy in ${RULES_DIR}/ — once \`init --yes\` has run, remove that entry or Kilo sends this rule twice`,
    );
  }

  const rules: RuleDocument[] = [];
  const taken = new Set<string>();
  for (const path of [...legacy, ...listed.files.map((f) => f.path)]) {
    if (isCanonicalSource(manifest, path)) continue;
    const contents = await ctx.fs.tryReadFile(path);
    if (contents === undefined) continue;
    // Strip the generated index before deriving an id, or a round trip grows a `001-`
    // prefix on every rule and the next render adds another. `.kilocoderules` has no
    // extension, and its dot-leading name slugs to the name itself.
    const base = basenamePosix(path)
      .replace(/\.md$/i, '')
      .replace(/^\d{3}-/, '');
    const id = importRuleId(base, 'kilo');
    for (const rule of importConcatenated({ file: path, contents, idFallback: id })) {
      rules.push({ ...rule, id: claimRuleId(id, taken) });
    }
    const warning = stillLoaded.get(path);
    if (warning !== undefined) warnings.push(warning);
  }

  return {
    ...(rules.length === 0 ? {} : { rules }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/**
 * The generated filename: a zero-padded position, then the rule id.
 *
 * Kilo concatenates `.kilocode/rules/` in directory-listing order and knows nothing about
 * canonical `order`. The index makes a name-sorted listing agree with `sortRules`, the
 * scheme Roo Code — Kilo's ancestor — needed for the same reason. The cost, accepted:
 * reordering rules renames files.
 */
function ruleFilename(rule: RuleDocument, position: number): string {
  return `${RULES_DIR}/${String(position + 1).padStart(3, '0')}-${slugForId(rule.id)}.md`;
}

/**
 * One `.kilocode/rules/<NNN>-<id>.md` per rule. Kilo has no per-glob mechanism for these
 * files, so a scoped rule keeps the prose `**Applies to:**` line.
 */
function write(ctx: AdapterContext): Promise<readonly Artifact[]> {
  const { canonical } = ctx;
  const marker = canonical.manifest.options.marker;
  const rules = sortRules(canonical.rules.filter((r) => selects(r.frontmatter.tools, 'kilo')));

  return Promise.resolve(
    rules.map((rule, i) =>
      finalizeArtifact({
        path: ruleFilename(rule, i),
        contents: withHtmlMarker(
          renderRuleSection(rule, { headingLevel: 2, showGlobs: true }),
          marker,
        ),
        adapter: 'kilo',
        kind: 'rules',
        provenance: { ruleIds: [rule.id] },
      }),
    ),
  );
}

export const kilo: Adapter = {
  name: 'kilo',
  apiVersion: ADAPTER_API_VERSION,
  detect,
  read,
  write,
  docs,
};

export default kilo;
export { docs };
