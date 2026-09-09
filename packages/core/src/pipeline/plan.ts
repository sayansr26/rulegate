import { RulegateError } from '../model/errors.js';
import { escapesRoot, normalizeRelative } from '../fs/paths.js';
import { isCanonicalSource } from '../model/canonical.js';
import { STATE_PATH } from '../model/paths.js';
import { finalizeArtifact } from '../render/finalize.js';
import { scanTextForSecrets } from '../render/secrets.js';
import { sortArtifacts } from '../render/order.js';
import { buildState, type StateFile } from '../state/state.js';
import { parse } from '../parse/index.js';
import { discoverSources, resolveNested, type ResolvedLevel } from '../parse/nested.js';
import { nestedPath, nestedTargets, toolsWithoutNesting } from '../adapter/nesting.js';
import { ADAPTER_API_VERSION } from '../adapter/context.js';
import { compareCodepoint } from '../render/order.js';
import type { Adapter } from '../adapter/adapter.js';
import type { Artifact } from '../adapter/artifact.js';
import type { Canonical } from '../model/canonical.js';
import type { ToolId } from '../model/ids.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export interface PlanInput {
  readonly repoRoot: string;
  readonly fs: ReadOnlyFileSystem;
  readonly adapters: readonly Adapter[];
  /**
   * Plan from this model instead of parsing `.rulegate/` off disk.
   *
   * For `init` (T019), which has a canonical model in memory — imported from the
   * repository's existing tool configs — and nothing on disk yet to parse. It is a
   * parameter rather than a second planner on purpose: `computePlan` being the only
   * renderer is what makes `check` and `sync` structurally unable to disagree, and an
   * `init` that rendered its preview some other way would be able to promise a user
   * something the first `sync` then did not do.
   *
   * A model handed in this way is always the single level `''`: there is nothing on disk
   * to discover levels from, which is the whole reason the parameter exists.
   */
  readonly canonical?: Canonical;
  /**
   * Whether to plan every nested `.rulegate/` in the tree, or the repository root alone
   * (T062).
   *
   * Three states, and the default is the interesting one. **Unset means "cover whatever
   * the repository has"** — one level in an ordinary repository, every level in a
   * monorepo. Making the tree opt-in would mean a plain `check` after a recursive `sync`
   * finds every nested artifact recorded in `state.json` and absent from the plan, calls
   * it `orphaned`, and exits 1 on a repository that is correct; a plain `sync` would
   * delete them. `false` is the escape hatch — the root level only — and is why the flag
   * exists at all.
   */
  readonly recursive?: boolean;
}

/** What one canonical level contributed to the plan (T062). */
export interface PlanLevel {
  /** Repo-relative POSIX directory. `''` is the repository root. */
  readonly dir: string;
  /**
   * Enabled tools this level's rules cannot reach, because they declare no nested
   * artifact. Always empty at the root. Reported rather than folded into the root's
   * output: a rule scoped to one package, applied repository-wide, is a worse answer
   * than one that does not apply.
   */
  readonly skippedTools: readonly ToolId[];
  /** Rule ids this level declares itself, sorted. */
  readonly ownRuleIds: readonly string[];
  /** Rule ids this level redefines from an ancestor, sorted. */
  readonly overriddenRuleIds: readonly string[];
  /** Ancestor directories contributing rules, nearest last. */
  readonly inheritedFrom: readonly string[];
}

export interface Plan {
  /**
   * The **root** level's model. Every existing consumer — `doctor`, `lint`, `applyPlan`'s
   * `options.backup` — asks a repository-wide question, and the root manifest is what
   * answers it.
   */
  readonly canonical: Canonical;
  /** Finalized, deduplicated, sorted by path. Spans every level. */
  readonly artifacts: readonly Artifact[];
  /** Exactly what `state.json` would contain if this plan were applied. */
  readonly state: StateFile;
  readonly enabledAdapters: readonly ToolId[];
  /**
   * One entry per canonical level, root first. A repository with a single `.rulegate/`
   * has exactly one entry, `dir: ''`, so this is never empty.
   */
  readonly levels: readonly PlanLevel[];
  readonly errors: readonly RulegateError[];
  readonly warnings: readonly RulegateError[];
}

/**
 * Turn a repository into the complete set of artifacts that *should* exist.
 *
 * Reads only; writes nothing, ever. `sync` feeds the result to `applyPlan` and `check`
 * feeds the same result to `verifyPlan`, so the two commands consume one rendering
 * pass and cannot disagree about what the output ought to be. This is the project's
 * single most important structural constraint, and it is a property of this function
 * being the only renderer rather than a rule anyone has to remember.
 *
 * Nested levels (T062) are rendered by the same loop, at prefixed paths, for exactly
 * that reason: a `computeTreePlan` beside this one would be a second renderer, and the
 * two would eventually disagree about a monorepo. One `claimedBy` map, one
 * `sortArtifacts` and one `buildState` span every level, so a cross-level path collision
 * is caught by the check that already exists and `state.json` stays one complete
 * ownership record for the whole tree.
 */
export async function computePlan(input: PlanInput): Promise<Plan> {
  const { fs, repoRoot, adapters } = input;
  const errors: RulegateError[] = [];
  const warnings: RulegateError[] = [];

  const levels = await resolveLevels(input, errors, warnings);
  // `resolveLevels` always yields the root, so this is total.
  const rootLevel = levels.find((l) => l.dir === '') ?? levels[0]!;

  const artifacts: Artifact[] = [];
  const claimedBy = new Map<string, ToolId>();
  const planLevels: PlanLevel[] = [];
  const enabledEverywhere = new Set<ToolId>();

  for (const level of levels) {
    const canonical = level.canonical;
    const nested = level.dir !== '';
    const enabled = canonical.manifest.tools.filter((t) => t.enabled).map((t) => t.id);
    const selected = adapters.filter((a) => enabled.includes(a.name));

    // Which of this level's enabled tools can actually receive a nested artifact, read
    // off `AdapterDocs.nesting` rather than a hand-kept list (T062, `adapter/nesting.ts`).
    // Gating is per tool, not per produced path: a tool declaring `nesting` on its
    // managed pattern is the tool saying it reads that artifact from a subdirectory, and
    // matching each rendered filename back against the declared glob would re-derive the
    // same answer by a route that can disagree with `buildManagedByIndex`.
    const skippedTools = nested ? toolsWithoutNesting(selected) : [];
    const skipped = new Set<ToolId>(skippedTools);
    const eligible = selected.filter((a) => !skipped.has(a.name));

    if (nested) warnings.push(...allMergedWarnings(level, eligible));

    planLevels.push({
      dir: level.dir,
      skippedTools,
      ownRuleIds: level.ownRuleIds,
      overriddenRuleIds: level.overriddenRuleIds,
      inheritedFrom: level.inheritedFrom,
    });

    for (const adapter of eligible) {
      enabledEverywhere.add(adapter.name);

      // `apiVersion` is only versioning if something reads it. TypeScript pins it to 1 for
      // any adapter compiled against this kit, so this branch is unreachable from our own
      // packages — it exists for the cases the type system does not cover: a plain-JS
      // adapter, and a `node_modules` holding an adapter built against a different kit.
      // When v2 arrives, this is the branch that decides whether a v1 adapter still runs.
      if (adapter.apiVersion !== ADAPTER_API_VERSION) {
        errors.push(
          new RulegateError({
            code: 'E_ADAPTER_API_VERSION',
            message: `adapter \`${adapter.name}\` targets adapter API v${String(adapter.apiVersion)}, but this build speaks v${String(ADAPTER_API_VERSION)}`,
            source: { file: canonical.manifest.source.file },
            hint: `upgrade the adapter, or pin rulegate to a version that speaks v${String(adapter.apiVersion)}`,
          }),
        );
        continue;
      }

      const options = canonical.manifest.tools.find((t) => t.id === adapter.name)?.options ?? {};
      const ctx = { repoRoot, canonical, fs, options, apiVersion: ADAPTER_API_VERSION };

      let produced: readonly Artifact[];
      try {
        produced = await adapter.write(ctx);
      } catch (cause) {
        // One broken adapter must not take down the run: the user still needs to see
        // what the others would do, and which one failed.
        errors.push(
          cause instanceof RulegateError
            ? cause
            : new RulegateError({
                code: 'E_ADAPTER_FAILED',
                message: `adapter \`${adapter.name}\` failed: ${describe(cause)}`,
                source: { file: canonical.manifest.source.file },
                cause,
              }),
        );
        continue;
      }

      for (const raw of produced) {
        const artifact = finalizeArtifact(raw);
        // The adapter renders a repo-relative path and knows nothing about levels; the
        // prefix is applied here, once, so no adapter has to be nesting-aware.
        const local = normalizeRelative(artifact.path);
        const path = normalizeRelative(nestedPath(level.dir, local));

        if (escapesRoot(path)) {
          errors.push(
            new RulegateError({
              code: 'E_PATH_ESCAPE',
              message: `adapter \`${adapter.name}\` tried to write outside the repository: ${artifact.path}`,
              source: { file: artifact.path },
            }),
          );
          continue;
        }

        // The last gate in front of a git-committed credential (T044). The parser refuses
        // a literal in `env`, `headers` and preserved unknown keys, and `SecretValue` keeps
        // an adapter from being handed one — but an adapter renders its own text, and this
        // is the only place that sees what it actually produced. Scoped to `mcp` artifacts
        // because that is where credentials belong: a generic entropy scan over rendered
        // *instructions* fires on git hashes and code samples, and a check people learn to
        // override is not a check.
        if (artifact.kind === 'mcp') {
          const found = scanTextForSecrets(artifact.contents);
          if (found.length > 0) {
            errors.push(
              new RulegateError({
                code: 'E_LITERAL_SECRET',
                // Locations, never the values. A message that quoted what it found would
                // print the secret into CI logs.
                message: `adapter \`${adapter.name}\` would write a literal credential to ${path} (${found.join(', ')})`,
                source: { file: path },
                hint: 'use an `env:NAME` reference in .rulegate/mcp/servers.yaml; rulegate never writes a literal secret',
              }),
            );
            continue;
          }
        }

        // Both spellings, because a level's `canonicalSources` may be written relative to
        // the level or to the repository and refusing is the safe direction: the failure
        // this guards is Codex's `AGENTS.md` being both a canonical input and its own
        // output, and a missed match there overwrites the user's source.
        if (
          isCanonicalSource(canonical.manifest, path) ||
          isCanonicalSource(canonical.manifest, local)
        ) {
          errors.push(
            new RulegateError({
              code: 'E_ARTIFACT_OVERWRITES_SOURCE',
              message: `adapter \`${adapter.name}\` tried to overwrite the canonical source ${path}`,
              source: { file: path },
              hint: 'the file it generates is also the file it reads from; disable that tool or move your canonical source',
            }),
          );
          continue;
        }

        if (local === STATE_PATH) {
          errors.push(
            new RulegateError({
              code: 'E_ARTIFACT_PATH_CONFLICT',
              message: `adapter \`${adapter.name}\` tried to write ${STATE_PATH}, which Rulegate owns`,
              source: { file: path },
            }),
          );
          continue;
        }

        // Case-folded, because NTFS and APFS are case-insensitive: two artifacts differing
        // only in case are two entries for **one physical file** there, so a plan that is
        // legal on Linux makes `check` fail forever on Windows and macOS. Refusing costs an
        // external adapter a rename; not refusing costs a user a repository that can never be
        // in sync (T069). The map spans levels, so two levels claiming one path — a nested
        // level whose `dir` collides with a root artifact's directory — is caught here too.
        const key = path.toLowerCase();
        const other = claimedBy.get(key);
        if (other !== undefined) {
          errors.push(
            new RulegateError({
              code: 'E_ARTIFACT_PATH_CONFLICT',
              message: `adapters \`${other}\` and \`${adapter.name}\` both generate ${path}`,
              source: { file: path },
              hint: 'disable one of the two tools, or report this as an adapter bug. Paths that differ only in case are the same file on Windows and macOS.',
            }),
          );
          continue;
        }

        claimedBy.set(key, adapter.name);
        artifacts.push({ ...artifact, path });
      }
    }
  }

  const sorted = sortArtifacts(artifacts);

  return {
    canonical: rootLevel.canonical,
    artifacts: sorted,
    state: buildState(sorted),
    enabledAdapters: [...enabledEverywhere].sort(compareCodepoint),
    levels: planLevels,
    errors,
    warnings,
  };
}

/**
 * Every canonical level this run covers, root first — and always at least the root.
 *
 * Discovery is skipped entirely for an in-memory `canonical` and for `recursive: false`,
 * so neither pays for a tree walk it cannot use. When discovery finds only the root, its
 * already-parsed result is reused rather than parsed a second time: a single-level
 * repository must render byte-identically to how it did before nesting existed, and the
 * cheapest way to guarantee that is for it to run the same parse once.
 */
async function resolveLevels(
  input: PlanInput,
  errors: RulegateError[],
  warnings: RulegateError[],
): Promise<readonly ResolvedLevel[]> {
  const { fs, adapters } = input;

  if (input.canonical !== undefined) {
    return [
      {
        dir: '',
        canonical: input.canonical,
        ownRuleIds: input.canonical.rules.map((r) => r.id),
        overriddenRuleIds: [],
        inheritedFrom: [],
      },
    ];
  }

  const knownTools = adapters.map((a) => a.name);

  // The root is parsed first and unconditionally, because discovery needs its answer:
  // `options.ignore` is where a repository says which subtrees are not its own, and
  // finding that out requires reading the manifest that declares it. The root is a level
  // either way — it is every other level's ancestor, and it owns `plan.canonical`.
  const rootResult = await parse({ fs, knownTools });
  const nested =
    input.recursive === false
      ? []
      : (await discoverSources(fs, knownTools, rootResult.canonical.manifest.options.ignore))
          // Discovery re-finds the root; the already-parsed result is used instead of
          // parsing the same directory a second time.
          .filter((source) => source.dir !== '');

  const sources = [{ dir: '', result: rootResult }, ...nested];

  for (const source of sources) {
    // A root with no canonical source of its own is not an error when a package has one:
    // `E_NO_CANONICAL_SOURCE` describes a repository nobody can render, and this one
    // renders. Reported as usual when the root is all there is.
    if (source.dir === '' && rootResult.mode === 'none' && nested.length > 0) continue;
    errors.push(...source.result.errors);
    warnings.push(...source.result.warnings);
  }

  return resolveNested(sources);
}

/**
 * A nested level overriding an inherited rule id, for a tool that cannot override.
 *
 * `nearest-wins` tools load the nearer file instead of the further one, which is what
 * an override means. `all-merged` tools — Gemini, Roo Code, Windsurf — load **both**, so
 * a package redefining `10-style` hands that tool the root's text and the package's text,
 * one after the other, and the contradiction is silent at every layer that only compares
 * bytes. A warning rather than an error: this is a correct permanent property of the
 * tool, `check` owns exit 1 for drift alone, and refusing to render would leave the
 * package with no rules at all rather than with reported ones.
 */
function allMergedWarnings(
  level: ResolvedLevel,
  eligible: readonly Adapter[],
): readonly RulegateError[] {
  if (level.overriddenRuleIds.length === 0) return [];

  const out: RulegateError[] = [];
  for (const target of nestedTargets(eligible)) {
    if (target.nesting !== 'all-merged') continue;
    for (const id of level.overriddenRuleIds) {
      out.push(
        new RulegateError({
          code: 'W_NESTED_MERGE_CONFLICT',
          message: `${level.dir} redefines rule \`${id}\`, but ${target.tool} merges nested files instead of overriding: it will load both texts`,
          source: { file: nestedPath(level.dir, target.pattern) },
          hint: `give the rule a different id in ${level.dir}, or disable ${target.tool} there`,
        }),
      );
    }
  }
  return out;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
