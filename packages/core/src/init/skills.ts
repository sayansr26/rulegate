import { Buffer } from 'node:buffer';
import { RulegateError } from '../model/errors.js';
import { SKILL_FILE, SKILLS_DIR } from '../model/paths.js';
import { ALL_TOOLS, type ToolSelector } from '../model/selector.js';
import { parseSkillDir } from '../parse/skills.js';
import { compareCodepoint } from '../render/order.js';
import type { Adapter } from '../adapter/adapter.js';
import type { JsonValue, ToolId } from '../model/ids.js';
import type { Skill } from '../model/skill.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export interface ImportedSkills {
  readonly skills: readonly Skill[];
  /** Every file a skill was imported from, repo-relative. */
  readonly importedFrom: readonly string[];
  /** Each tool directory a skill was imported from, as `<dir>/<id>`, for the left-behind check. */
  readonly copies: readonly { readonly dir: string; readonly id: string }[];
  readonly warnings: readonly RulegateError[];
}

/**
 * Import the skills a repository's tools already have (RFC-0001 §12.4, T052).
 *
 * Generic over `AdapterDocs.skills`, like rendering: the directories scanned are the ones the
 * detected tools declare, and no tool is named here. A skill is parsed exactly as
 * `.rulegate/skills/` is, so what is imported is what `check` will read back.
 *
 * - The same skill in several directories, byte for byte, becomes one canonical skill.
 * - A copy that differs is **not** merged or renamed: `name` must equal the directory, so two
 *   copies cannot both live at `.rulegate/skills/<id>/`. The copy from the first directory in
 *   codepoint order is imported and the other is named and left where it is.
 * - `tools:` is set to the tools that were reading the directories it came from, as imported
 *   rules keep their origin, and omitted when that is every tool with skills.
 * - An invalid skill is not imported, and not guessed at: it is named and left in place.
 */
export async function importSkills(
  fs: ReadOnlyFileSystem,
  adapters: readonly Adapter[],
  detected: readonly ToolId[],
  /** Skill directories an interop importer named as its source (`skillSources`). */
  sources: readonly string[] = [],
): Promise<ImportedSkills> {
  const readers = adapters
    .filter((a) => a.docs.skills !== undefined && detected.includes(a.name))
    .map((a) => ({ id: a.name, dirs: a.docs.skills!.dirs }))
    .sort((a, b) => compareCodepoint(a.id, b.id));
  const dirs = [...new Set(readers.flatMap((r) => r.dirs))].sort(compareCodepoint);

  const warnings: RulegateError[] = [];
  const found = new Map<string, { dir: string; skill: Skill }[]>();
  // A competing tool's own source comes first: it is what that tool built the copies from.
  const fromSource = new Set<string>();
  for (const path of [...sources].sort(compareCodepoint)) {
    const id = path.slice(path.lastIndexOf('/') + 1);
    const parsed = await parseSkillDir(fs, path, id);
    if (parsed.skill === undefined) {
      warnings.push(
        new RulegateError({
          code: 'W_SKILL_IMPORT',
          message: `${path}/ was not imported: ${parsed.errors[0]?.message ?? 'it is not a valid skill'}`,
          source: { file: path },
          hint: 'fix it and run init again',
        }),
      );
      continue;
    }
    fromSource.add(id);
    found.set(id, [{ dir: path.slice(0, path.lastIndexOf('/')), skill: parsed.skill }]);
  }
  for (const dir of dirs) {
    if (!(await fs.exists(dir))) continue;
    for (const entry of await fs.listDir(dir)) {
      if (entry.kind !== 'dir') continue;
      const path = `${dir}/${entry.name}`;
      // A skill a competing tool keeps a source for is imported from that source alone.
      if (fromSource.has(entry.name)) continue;
      const parsed = await parseSkillDir(fs, path, entry.name);
      if (parsed.skill === undefined) {
        warnings.push(
          new RulegateError({
            code: 'W_SKILL_IMPORT',
            message: `${path}/ was not imported: ${parsed.errors[0]?.message ?? 'it is not a valid skill'}`,
            source: { file: path },
            hint: 'fix it and run init again, or move it into .rulegate/skills/ by hand once it is valid',
          }),
        );
        continue;
      }
      found.set(entry.name, [...(found.get(entry.name) ?? []), { dir, skill: parsed.skill }]);
    }
  }

  const skills: Skill[] = [];
  const importedFrom: string[] = [];
  const copies: { dir: string; id: string }[] = [];
  const allTools = readers.map((r) => r.id);

  for (const [id, all] of [...found].sort(([a], [b]) => compareCodepoint(a, b))) {
    const first = all[0]!;
    const same = all.filter((c) => fingerprint(c.skill) === fingerprint(first.skill));
    for (const other of all.filter((c) => !same.includes(c))) {
      warnings.push(
        new RulegateError({
          code: 'W_SKILL_IMPORT',
          message: `${other.dir}/${id}/ differs from ${first.dir}/${id}/: imported the copy in ${first.dir}/ and left this one where it is`,
          source: { file: `${other.dir}/${id}` },
          hint: `merge what you need into .rulegate/skills/${id}/, then delete ${other.dir}/${id}/`,
        }),
      );
    }

    const sourceDirs = same.map((c) => c.dir);
    const reading = fromSource.has(id)
      ? allTools
      : readers.filter((r) => r.dirs.some((d) => sourceDirs.includes(d))).map((r) => r.id);
    const tools: ToolSelector =
      reading.length === allTools.length ? ALL_TOOLS : { kind: 'include', tools: reading };
    const frontmatter: (readonly [string, JsonValue])[] = first.skill.frontmatter.filter(
      ([key]) => key !== 'tools',
    );
    if (tools.kind === 'include') frontmatter.push(['tools', [...tools.tools]]);

    const path = `${SKILLS_DIR}/${id}`;
    skills.push({
      ...first.skill,
      path,
      tools,
      frontmatter,
      source: { file: `${path}/${SKILL_FILE}` },
    });
    for (const copy of same) {
      copies.push({ dir: copy.dir, id });
      importedFrom.push(`${copy.dir}/${id}/${SKILL_FILE}`);
      for (const asset of copy.skill.assets) importedFrom.push(`${copy.dir}/${id}/${asset.path}`);
    }
  }

  return { skills, importedFrom: importedFrom.sort(compareCodepoint), copies, warnings };
}

/** Two copies are the same skill when every key, the body and every asset byte agree. */
function fingerprint(skill: Skill): string {
  return JSON.stringify({
    frontmatter: skill.frontmatter,
    body: skill.body,
    assets: skill.assets.map((a) => [a.path, Buffer.from(a.bytes).toString('base64')]),
  });
}
