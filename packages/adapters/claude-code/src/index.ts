import {
  ADAPTER_API_VERSION,
  RulegateError,
  appliesRepoWide,
  basenamePosix,
  claimRuleId,
  detected,
  importConcatenated,
  importRuleId,
  finalizeArtifact,
  isCanonicalSource,
  renderConcatenated,
  renderRuleSection,
  selects,
  sortRules,
  withHtmlMarker,
  type Adapter,
  type AdapterContext,
  type Artifact,
  type Canonical,
  type DetectResult,
  type ImportResult,
  type RuleDocument,
} from '@rulegate/adapter-kit';
import { MCP_FILE, importMcpConfig, renderMcpJson } from './mcp.js';
import { RULES_DIR, importRuleFile, parseRuleFile, renderScopedRule, rulePath } from './rules.js';
import { docs } from './docs.js';

export const CLAUDE_MD = 'CLAUDE.md';

// `.mcp.json` is evidence as well as an artifact: `collectImports` is handed only the
// adapters that detected, so without it a repository whose sole AI configuration is an
// MCP file is never asked for its servers and `read()` never runs.
const DETECTION_PATHS = [CLAUDE_MD, 'CLAUDE.local.md', '.claude', MCP_FILE] as const;

async function detect(ctx: AdapterContext): Promise<DetectResult> {
  const evidence: string[] = [];
  for (const path of DETECTION_PATHS) {
    if (await ctx.fs.exists(path)) evidence.push(path);
  }
  return detected(evidence);
}

/**
 * Read the way `write` writes: repo-wide rules from `CLAUDE.md`, glob-scoped rules one per
 * `.claude/rules/*.md`. The `**Applies to:**` parsing on `CLAUDE.md` stays even though
 * `write` no longer emits it for this file, because a `CLAUDE.md` written before T110
 * carries its scoped rules that way and still has to import.
 */
async function read(ctx: AdapterContext): Promise<Partial<Canonical>> {
  const rules: RuleDocument[] = [];
  const taken = new Set<string>();

  // The same guard `write` makes, for the mirror-image reason: when this file is already
  // the canonical source, the parser has read it and importing it again would duplicate
  // every rule in it. It matters for AGENTS.md above all (T014).
  if (!isCanonicalSource(ctx.canonical.manifest, CLAUDE_MD)) {
    const contents = await ctx.fs.tryReadFile(CLAUDE_MD);
    if (contents !== undefined) {
      for (const rule of importConcatenated({
        file: CLAUDE_MD,
        contents,
        headingLevel: 2,
        idFallback: 'claude',
      })) {
        rules.push({ ...rule, id: claimRuleId(rule.id, taken) });
      }
    }
  }

  // Recursive, because Claude Code discovers `.claude/rules/**` recursively: a rule in
  // `backend/db.md` is loaded, so it is content an import must not leave behind.
  for (const path of await ctx.fs.glob(`${RULES_DIR}/**/*.md`)) {
    if (isCanonicalSource(ctx.canonical.manifest, path)) continue;
    const contents = await ctx.fs.tryReadFile(path);
    if (contents === undefined) continue;

    const base = basenamePosix(path).replace(/\.md$/i, '');
    // The id comes from the filename, not the heading: the filename is what `write`
    // produced and what the next `sync` has to match (T017).
    const rule = importRuleFile(
      path,
      claimRuleId(importRuleId(base, 'claude-rules'), taken),
      parseRuleFile(contents),
    );
    if (rule !== undefined) rules.push(rule);
  }

  return {
    ...(rules.length === 0 ? {} : { rules }),
    ...(await readMcp(ctx)),
  };
}

/**
 * The MCP half, guarded separately from the rules half.
 *
 * A repository can have `.mcp.json` and no `CLAUDE.md`, so returning early when the
 * instruction file is missing would import no servers at all — the mirror of the bug T046
 * found on the write side, where one early return covered the whole adapter.
 */
async function readMcp(ctx: AdapterContext): Promise<ImportResult> {
  if (isCanonicalSource(ctx.canonical.manifest, MCP_FILE)) return {};
  const contents = await ctx.fs.tryReadFile(MCP_FILE);
  if (contents === undefined) return {};
  const { servers, warnings } = importMcpConfig(contents);
  return {
    ...(servers.length === 0 ? {} : { mcpServers: servers }),
    ...(warnings.length === 0 ? {} : { warnings }),
  };
}

async function write(ctx: AdapterContext): Promise<readonly Artifact[]> {
  const { canonical } = ctx;
  const marker = canonical.manifest.options.marker;
  const artifacts: Artifact[] = [];

  // Each artifact carries its own guards. This used to be one early return covering the
  // whole adapter, which was right while rules were the only output and became wrong the
  // moment MCP arrived: a repository whose `CLAUDE.md` is canonical input, or which has no
  // rules at all, still has MCP servers to generate.
  //
  // The canonical-source check is generic rather than Claude-specific: no adapter may write
  // over a file that is canonical input. It matters most for AGENTS.md (T014), but it costs
  // nothing to honour here and means every adapter inherits the protection.
  const rules = sortRules(
    canonical.rules.filter((r) => selects(r.frontmatter.tools, 'claude-code')),
  );

  // Each rule lands in exactly one file. Claude Code loads `CLAUDE.md` and every matching
  // `.claude/rules` file together, so a scoped rule also left in `CLAUDE.md` would be sent
  // twice — and unconditionally, which is the scoping it exists to avoid.
  const repoWide = rules.filter((r) => appliesRepoWide(r));
  // No rules means no file. Emitting an empty CLAUDE.md would create an artifact that
  // `check` then has to reason about, and that a user has to wonder about.
  if (repoWide.length > 0 && !isCanonicalSource(canonical.manifest, CLAUDE_MD)) {
    artifacts.push(
      finalizeArtifact({
        path: CLAUDE_MD,
        // showGlobs stays true although nothing here is scoped any more: it changes no
        // bytes, and it keeps the renderer the exact inverse of `read`'s parsing.
        contents: withHtmlMarker(
          renderConcatenated(repoWide, { headingLevel: 2, showGlobs: true }),
          marker,
        ),
        adapter: 'claude-code',
        kind: 'rules',
        provenance: { ruleIds: repoWide.map((r) => r.id) },
      }),
    );
  }

  const claimed = new Map<string, string>();
  for (const rule of rules.filter((r) => !appliesRepoWide(r))) {
    const path = rulePath(rule);

    const previous = claimed.get(path);
    if (previous !== undefined) {
      // Two rule ids slugging to one filename would silently drop one rule's content.
      throw new RulegateError({
        code: 'E_ARTIFACT_PATH_CONFLICT',
        message: `rules \`${previous}\` and \`${rule.id}\` both generate ${path}`,
        source: rule.source,
        hint: 'rename one of the rules so their generated filenames differ',
      });
    }
    claimed.set(path, rule.id);

    if (isCanonicalSource(canonical.manifest, path)) continue;

    artifacts.push(
      finalizeArtifact({
        path,
        // The description is a body heading, not a frontmatter key: Claude Code reads
        // only `paths` and strips the rest before the model sees the rule.
        contents: renderScopedRule(
          rule,
          renderRuleSection(rule, { headingLevel: 2, showGlobs: false }),
          marker,
        ),
        adapter: 'claude-code',
        kind: 'rules',
        provenance: { ruleIds: [rule.id] },
      }),
    );
  }

  // No `provenance`: no canonical rule contributed to this file, and claiming one would
  // mislead `doctor` and T051's merge, both of which read `ruleIds` as a real mapping.
  const mcp = renderMcpJson(canonical.mcpServers, marker);
  if (mcp !== '' && !isCanonicalSource(canonical.manifest, MCP_FILE)) {
    artifacts.push(
      finalizeArtifact({
        path: MCP_FILE,
        contents: mcp,
        adapter: 'claude-code',
        kind: 'mcp',
      }),
    );
  }

  return Promise.resolve(artifacts);
}

export const claudeCode: Adapter = {
  name: 'claude-code',
  apiVersion: ADAPTER_API_VERSION,
  detect,
  read,
  write,
  docs,
};

export default claudeCode;
export { docs, MCP_FILE, RULES_DIR, renderMcpJson };
