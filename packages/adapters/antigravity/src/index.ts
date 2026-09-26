import {
  ADAPTER_API_VERSION,
  RulegateError,
  basenamePosix,
  claimRuleId,
  detected,
  dirnamePosix,
  finalizeArtifact,
  importConcatenated,
  importRuleId,
  importedRule,
  isCanonicalSource,
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
import { isKnownTrigger, parseRule, renderFrontmatter } from './frontmatter.js';
import { docs } from './docs.js';

export const RULES_DIR = '.agents/rules';
/** The pre-rename directory, still read by Antigravity. Imported, never written. */
export const LEGACY_RULES_DIR = '.agent/rules';
/** Antigravity-only instruction files. Root `AGENTS.md`/`GEMINI.md` belong to codex/gemini. */
const AGENTS_DIR_FILES = ['.agents/AGENTS.md', '.agents/GEMINI.md'] as const;

/**
 * Never bare `.agents/`: that is the cross-tool skills directory (`.agents/skills/`), read by
 * Cursor, Windsurf and Gemini CLI as well, and treating it as evidence would have `init` and
 * `doctor` report Antigravity in every repository that shares a skill.
 */
const DETECTION_PATHS = [RULES_DIR, LEGACY_RULES_DIR] as const;

async function detect(ctx: AdapterContext): Promise<DetectResult> {
  const evidence: string[] = [];
  for (const path of DETECTION_PATHS) {
    if (await ctx.fs.exists(path)) evidence.push(path);
  }
  return detected(evidence);
}

/**
 * `.agents/rules/*.md`, the legacy `.agent/rules/*.md`, and `.agents/{AGENTS,GEMINI}.md`.
 *
 * Root `AGENTS.md` and `GEMINI.md` are read by Antigravity and deliberately not imported
 * here: codex and gemini own them, and importing a path two adapters claim hands
 * `dedupeImported` the same rules twice with different provenance.
 *
 * Nothing Antigravity would ignore is dropped silently. A file nested below `rules/`, one
 * with no frontmatter, and one with an unknown `trigger` are all inert in Antigravity today;
 * each is either imported with a warning or skipped with one, never neither.
 */
async function read(ctx: AdapterContext): Promise<ImportResult> {
  const rules: RuleDocument[] = [];
  const warnings: string[] = [];
  const taken = new Set<string>();

  for (const dir of [RULES_DIR, LEGACY_RULES_DIR]) {
    for (const path of await ctx.fs.glob(`${dir}/**/*.md`)) {
      if (isCanonicalSource(ctx.canonical.manifest, path)) continue;
      if (dirnamePosix(path) !== dir) {
        // The vendor scans immediate children only, unless a `rules.json` registers the
        // subdirectory — which Rulegate does not model. Importing it would switch on a
        // rule that is off today.
        warnings.push(
          `${path}: Antigravity scans only the immediate children of ${dir}/, so this file is not loaded and was not imported`,
        );
        continue;
      }
      const contents = await ctx.fs.tryReadFile(path);
      if (contents === undefined) continue;

      const parsed = parseRule(contents);
      if (parsed.body === '' && parsed.description === undefined) continue;

      if (parsed.hasFrontmatter && parsed.trigger === 'glob' && parsed.globs.length === 0) {
        // A glob trigger with no pattern matches nothing, so the rule is off today. Imported
        // unscoped, it would render `always_on` and apply to every request.
        // Skipped, the file still sits where `write()` renders: `init --yes` replaces it
        // (backing it up) if another tool's imported rule claims the same id, and
        // `init` otherwise cannot tell it apart from a file it imported.
        const overwritten =
          dir === RULES_DIR
            ? `; \`init --yes\` replaces it, with a backup under .rulegate/backup/, if a rule imported from another tool is named \`${basenamePosix(path).replace(/\.md$/i, '')}\``
            : '';
        warnings.push(
          `${path}: trigger \`glob\` with no globs matches no file, so Antigravity never applies this rule; it was not imported — add a \`globs:\` value and run \`init\` again to keep it${overwritten}`,
        );
        continue;
      }
      if (parsed.invalidKey !== undefined) {
        warnings.push(
          `${path}: the \`${parsed.invalidKey}:\` value starts with a YAML indicator (a bare \`*\` is an alias), so the frontmatter does not parse and Antigravity silently discards this rule today; it was imported so that nothing is lost, and Rulegate will render the value quoted`,
        );
      } else if (!parsed.hasFrontmatter || !isKnownTrigger(parsed.trigger)) {
        warnings.push(
          `${path}: Antigravity silently discards a rule file with missing frontmatter or an unrecognized trigger, so this rule is not in effect today; it was imported so that nothing is lost, and Rulegate will render it with a valid trigger`,
        );
      } else if (parsed.trigger === 'model_decision' || parsed.trigger === 'manual') {
        warnings.push(
          `${path}: trigger \`${parsed.trigger}\` has no canonical equivalent; imported as a rule Rulegate renders always_on (or glob, when it has globs)`,
        );
      }

      // `trigger` alone decides activation; `globs` under `always_on` is a leftover from a
      // mode switch and matches nothing. Imported, it would render `trigger: glob` and
      // narrow a rule that applies to every request today.
      const alwaysOn = parsed.hasFrontmatter && parsed.trigger === 'always_on';
      if (alwaysOn && parsed.globs.length > 0) {
        warnings.push(
          `${path}: trigger \`always_on\` ignores its \`globs:\` value, so Antigravity applies this rule to every request; it was imported unscoped, and the globs were dropped`,
        );
      }

      const base = basenamePosix(path).replace(/\.md$/i, '');
      rules.push(
        importedRule({
          id: claimRuleId(importRuleId(base, 'antigravity'), taken),
          ...(parsed.description === undefined ? {} : { description: parsed.description }),
          globs: alwaysOn ? [] : parsed.globs,
          body: parsed.body,
          source: { file: path, line: 1 },
        }),
      );
    }
  }

  for (const file of AGENTS_DIR_FILES) {
    if (isCanonicalSource(ctx.canonical.manifest, file)) continue;
    const contents = await ctx.fs.tryReadFile(file);
    if (contents === undefined) continue;
    const fallback = `antigravity-${basenamePosix(file).replace(/\.md$/i, '').toLowerCase()}`;
    for (const rule of importConcatenated({ file, contents, idFallback: fallback })) {
      rules.push({ ...rule, id: claimRuleId(rule.id, taken) });
    }
  }

  return {
    ...(rules.length === 0 ? {} : { rules }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

/**
 * One `.agents/rules/<id>.md` per rule, with a native `trigger: glob` for scoped rules.
 *
 * Only `.agents/rules/` is written. `AGENTS.md` and `GEMINI.md` are read by Antigravity
 * too, but they are codex's and gemini's output; a user who enables those adapters
 * alongside this one sends Antigravity the same rules twice, which `doctor` reports.
 */
function write(ctx: AdapterContext): Promise<readonly Artifact[]> {
  const { canonical } = ctx;
  const marker = canonical.manifest.options.marker;
  const rules = sortRules(
    canonical.rules.filter((r) => selects(r.frontmatter.tools, 'antigravity')),
  );

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
        hint: 'rename one of them; antigravity rule filenames are flattened rule ids',
      });
    }
    claimed.set(path, rule.id);

    const frontmatter = renderFrontmatter({
      globs: rule.frontmatter.globs,
      ...(rule.frontmatter.description === undefined
        ? {}
        : { description: rule.frontmatter.description }),
    });

    artifacts.push(
      finalizeArtifact({
        path,
        // The marker goes *after* the frontmatter. Antigravity discards a rule file whose
        // first bytes are not a valid block, silently — a comment above it would make
        // every generated rule vanish with nothing reported anywhere.
        contents: `${frontmatter}${withHtmlMarker(rule.body, marker)}`,
        adapter: 'antigravity',
        kind: 'rules',
        provenance: { ruleIds: [rule.id] },
      }),
    );
  }

  return Promise.resolve(artifacts);
}

export const antigravity: Adapter = {
  name: 'antigravity',
  apiVersion: ADAPTER_API_VERSION,
  detect,
  read,
  write,
  docs,
};

export default antigravity;
export { docs };
