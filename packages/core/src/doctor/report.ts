import { computePlan } from '../pipeline/plan.js';
import { verifyPlan } from '../pipeline/verify.js';
import { detectTools } from '../detect/engine.js';
import { compareToDisk } from '../state/compare.js';
import { EMPTY_STATE, parseState } from '../state/state.js';
import { MANIFEST_PATH, STATE_PATH } from '../model/paths.js';
import { compareCodepoint } from '../render/order.js';
import { SymlinkProbe, resolveTool } from './resolve.js';
import {
  buildManagedByIndex,
  duplicateLoadWarnings,
  orphanWarnings,
  overLimitWarnings,
  sortWarnings,
  symlinkWarnings,
  toolNoteWarnings,
} from './warnings.js';
import type { Adapter } from '../adapter/adapter.js';
import type { FileResolution } from '../adapter/docs.js';
import type { RulegateError } from '../model/errors.js';
import type { Plan } from '../pipeline/plan.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';
import type { DoctorReport, DoctorWarning, SkillDiagnosis, ToolDiagnosis } from './types.js';

export interface DoctorInput {
  readonly repoRoot: string;
  /** Rooted at the repository. */
  readonly fs: ReadOnlyFileSystem;
  readonly adapters: readonly Adapter[];
  /**
   * Rooted at the user's home directory, when the caller chooses to supply one.
   *
   * A parameter rather than something this module constructs, for the reasons `DetectInput`
   * gives at length: it keeps `node:fs` and `node:os` out of the algorithm, keeps the whole
   * thing unit-testable against `MemoryFileSystem`, and inherits containment from
   * `escapesRoot` rather than reimplementing it.
   */
  readonly globalFs?: ReadOnlyFileSystem;
  /**
   * Diagnose this plan instead of computing one.
   *
   * For `lint` (T057), which needs the same plan this function would build and would
   * otherwise walk `.rulegate/` twice for it. The same shape and the same reason as
   * `PlanInput.canonical`: a parameter, not a second assembly path, because everything
   * below derives from `plan` and a caller that built its own some other way could be
   * shown a diagnosis of a repository that does not exist.
   *
   * Optional and unset by every other caller, so `doctor` keeps computing its own.
   */
  readonly plan?: Plan;
}

/**
 * What will each tool read, what does it cost, and what is wrong with it?
 *
 * Reads only, and never throws for anything a repository could contain. It runs on
 * repositories that have never adopted Rulegate — that is its primary audience, and the
 * first thing `init` will ask of it — so a missing canonical source sets `adopted: false`
 * and is not an error. Only a canonical source that exists and cannot be parsed is.
 *
 * The algorithm lives in core and the roster is a parameter, the same split `detectTools`
 * and `computePlan` already use: core must contain no tool-specific logic, and the test
 * that runs the five real adapters therefore lives in `packages/cli/test/`.
 */
export async function buildDoctorReport(input: DoctorInput): Promise<DoctorReport> {
  const { repoRoot, fs, adapters, globalFs } = input;

  const plan = input.plan ?? (await computePlan({ repoRoot, fs, adapters }));
  const adopted = !plan.errors.some((e) => e.code === 'E_NO_CANONICAL_SOURCE');
  const errors: readonly RulegateError[] = plan.errors.filter(
    (e) => e.code !== 'E_NO_CANONICAL_SOURCE',
  );

  const detection = await detectTools({
    repoRoot,
    fs,
    canonical: plan.canonical,
    adapters,
    ...(globalFs === undefined ? {} : { globalFs }),
  });

  const comparison = await compareToDisk(
    parseState(await fs.tryReadFile(STATE_PATH)) ?? EMPTY_STATE,
    plan.artifacts,
    fs,
  );

  // The verdict `check` would give, per planned path. `compareToDisk` above answers the
  // ownership question and cannot answer this one: an artifact whose rule was edited
  // without a `sync` still matches its recorded hash (T073).
  const verify = await verifyPlan(plan, fs);
  const verdicts = new Map(verify.entries.map((e) => [e.path, e.status]));

  const managedBy = buildManagedByIndex(adapters);

  // Which canonical rules produced each generated file. This is what lets the duplicate
  // scan see that `.clinerules/10-style.md` and `AGENTS.md` carry the same rule, which no
  // byte comparison can (T043).
  const provenance = new Map<string, readonly string[]>();
  for (const artifact of plan.artifacts) {
    const ids = artifact.provenance?.ruleIds;
    if (ids !== undefined && ids.length > 0) provenance.set(artifact.path, ids);
  }
  const byName = new Map(adapters.map((a) => [a.name, a]));
  const symlinks = new SymlinkProbe(fs);

  const tools: ToolDiagnosis[] = [];
  const warnings: DoctorWarning[] = [];
  const explicitManifest = plan.canonical.manifest.source.file === MANIFEST_PATH;

  // Sequentially, never `Promise.all`. `detect/engine.ts` records the reason: a loop that
  // appends in settle order produces a different report on a slow disk, which is a
  // nondeterminism bug that only shows up on somebody else's machine.
  for (const detected of detection.tools) {
    const adapter = byName.get(detected.name);
    if (adapter === undefined) continue;
    const docs = adapter.docs;
    const resolution: FileResolution = docs.resolution ?? 'override';

    const resolved = await resolveTool(docs, {
      fs,
      ...(globalFs === undefined ? {} : { globalFs }),
      detection: detected,
      comparison,
      verdicts,
      managedBy,
      symlinks,
    });

    const skills = docs.skills === undefined ? undefined : await skillsOnDisk(fs, docs.skills.dirs);
    const diagnosis: ToolDiagnosis = {
      name: detected.name,
      toolName: docs.toolName,
      detected: detected.detected,
      enabled: plan.enabledAdapters.includes(detected.name),
      evidence: detected.evidence,
      resolution,
      files: resolved.files,
      loadedCount: resolved.loaded.length,
      loadedBytes: resolved.loaded.reduce((n, m) => n + m.bytes, 0),
      loadedTokens: resolved.loaded.reduce((n, m) => n + m.tokens, 0),
      ...(skills === undefined ? {} : { skills }),
      ...(detected.failed === undefined ? {} : { failed: detected.failed }),
    };
    tools.push(diagnosis);

    warnings.push(...duplicateLoadWarnings(diagnosis, resolved.loaded, provenance));
    // Only for a tool in use: detected, or enabled by a real manifest. Without `.rulegate/`
    // the plan's manifest is synthetic and enables every tool, which would flag skills for
    // tools nobody runs here.
    if (diagnosis.detected || (explicitManifest && diagnosis.enabled)) {
      warnings.push(...skillDuplicateWarnings(diagnosis));
    }
    warnings.push(...overLimitWarnings(diagnosis, docs, resolved.loaded));
    warnings.push(...toolNoteWarnings(diagnosis, docs));
  }

  warnings.push(...symlinkWarnings(symlinks.found()));
  warnings.push(
    ...(await orphanWarnings(
      fs,
      comparison,
      adapters,
      tools,
      plan.canonical.manifest.options.ignore,
    )),
  );

  return {
    repoRoot,
    adopted,
    globalProbed: detection.globalProbed,
    tools,
    warnings: sortWarnings(warnings),
    errors,
  };
}

/** Which skills sit in each of a tool's skill directories on disk (T052). */
async function skillsOnDisk(
  fs: ReadOnlyFileSystem,
  dirs: readonly string[],
): Promise<readonly SkillDiagnosis[]> {
  const found = new Map<string, string[]>();
  for (const dir of dirs) {
    if (!(await fs.exists(dir))) continue;
    for (const entry of await fs.listDir(dir)) {
      if (entry.kind !== 'dir' || !(await fs.exists(`${dir}/${entry.name}/SKILL.md`))) continue;
      found.set(entry.name, [...(found.get(entry.name) ?? []), dir]);
    }
  }
  return [...found]
    .sort(([a], [b]) => compareCodepoint(a, b))
    .map(([id, where]) => ({ id, dirs: where }));
}

/** A skill a tool finds in two of its directories is loaded twice (T052). */
function skillDuplicateWarnings(tool: ToolDiagnosis): readonly DoctorWarning[] {
  return (tool.skills ?? [])
    .filter((s) => s.dirs.length > 1)
    .map((s) => ({
      code: 'W_DUPLICATE_LOAD' as const,
      tool: tool.name,
      paths: s.dirs.map((d) => `${d}/${s.id}/SKILL.md`).sort(compareCodepoint),
      message: `loads the skill \`${s.id}\` twice, from ${s.dirs.join(' and ')}`,
    }));
}
