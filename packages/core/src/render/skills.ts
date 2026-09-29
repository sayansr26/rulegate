import { RulegateError } from '../model/errors.js';
import { SKILL_FILE } from '../model/paths.js';
import { renderSkillFile } from '../model/serialize.js';
import { selects } from '../model/selector.js';
import { compareCodepoint } from '../render/order.js';
import { cover } from './cover.js';
import type { Adapter } from '../adapter/adapter.js';
import type { Artifact } from '../adapter/artifact.js';
import type { JsonValue, ToolId } from '../model/ids.js';
import type { Skill } from '../model/skill.js';

/**
 * Agent Skills fields: carried to every tool. Everything else in a skill's frontmatter but
 * `tools` is a tool extension, passed only where a reader understands it (RFC-0001 §12.2).
 */
const AGENT_SKILLS_FIELDS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools',
]);

interface Reader {
  readonly id: ToolId;
  readonly dirs: readonly string[];
  readonly extensions: ReadonlySet<string>;
}

export interface SkillsPlan {
  readonly artifacts: readonly Artifact[];
  readonly warnings: readonly RulegateError[];
}

/**
 * Render every skill into the directories that reach each tool meant to receive it
 * (RFC-0001 §12.3, T052).
 *
 * Generic over `AdapterDocs.skills`: which directories exist, who reads them and which keys
 * each reader understands are all adapter data, so no tool is named here. Per skill, the
 * directories are the **fewest that cover every enabled tool the skill selects** — tools that
 * share `.agents/skills/` get one copy, not one each — chosen greedily and deterministically.
 * A directory's owner in `state.json` is its first reader in codepoint order, so ownership
 * does not move when a skill's `tools:` does.
 *
 * What cannot be avoided is said: a tool that reads two chosen directories loads the skill
 * twice, and a tool a skill's `tools:` leaves out still loads it from a directory it shares.
 */
export function planSkills(
  skills: readonly Skill[],
  adapters: readonly Adapter[],
  marker: boolean,
): SkillsPlan {
  const readers: Reader[] = adapters
    .filter((a) => a.docs.skills !== undefined)
    .map((a) => ({
      id: a.name,
      dirs: a.docs.skills!.dirs,
      extensions: new Set(a.docs.skills!.extensions),
    }))
    .sort((a, b) => compareCodepoint(a.id, b.id));
  if (readers.length === 0 || skills.length === 0) return { artifacts: [], warnings: [] };

  const artifacts: Artifact[] = [];
  const doubleLoads = new Map<string, string[]>();
  const leaks = new Map<string, string[]>();
  const dropped = new Map<string, string[]>();

  for (const skill of [...skills].sort((a, b) => compareCodepoint(a.id, b.id))) {
    const targets = readers.filter((r) => selects(skill.tools, r.id));
    if (targets.length === 0) continue;
    const chosen = cover(targets);

    for (const dir of chosen) {
      const readersOfDir = readers.filter((r) => r.dirs.includes(dir));
      const owner = readersOfDir[0]!.id;
      const understood = new Set(readersOfDir.flatMap((r) => [...r.extensions]));
      const entries: (readonly [string, JsonValue])[] = [];
      for (const entry of skill.frontmatter) {
        const [key] = entry;
        if (key === 'tools') continue;
        if (AGENT_SKILLS_FIELDS.has(key) || understood.has(key)) {
          entries.push(entry);
          continue;
        }
        const k = `${dir}\u0000${key}`;
        dropped.set(k, [...(dropped.get(k) ?? []), skill.id]);
      }
      const base = `${dir}/${skill.id}`;
      artifacts.push({
        path: `${base}/${SKILL_FILE}`,
        contents: renderSkillFile(entries, skill.body, marker),
        adapter: owner,
        kind: 'skill',
      });
      for (const asset of skill.assets) {
        artifacts.push({
          path: `${base}/${asset.path}`,
          contents: '',
          bytes: asset.bytes,
          adapter: owner,
          kind: 'skill',
        });
      }
    }

    for (const reader of readers) {
      const reads = chosen.filter((d) => reader.dirs.includes(d));
      if (reads.length > 1) {
        const k = `${reader.id}\u0000${reads.join(' and ')}`;
        doubleLoads.set(k, [...(doubleLoads.get(k) ?? []), skill.id]);
      } else if (reads.length === 1 && !selects(skill.tools, reader.id)) {
        const k = `${reader.id}\u0000${reads[0]!}`;
        leaks.set(k, [...(leaks.get(k) ?? []), skill.id]);
      }
    }
  }

  const warnings: RulegateError[] = [];
  const list = (ids: readonly string[]): string => ids.map((i) => `\`${i}\``).join(', ');
  for (const [k, ids] of sortedEntries(doubleLoads)) {
    const [tool, dirs] = k.split('\u0000') as [string, string];
    warnings.push(
      new RulegateError({
        code: 'W_SKILL_LOAD',
        message: `${tool} reads ${dirs}, so it loads ${list(ids)} twice`,
        hint: 'add `tools:` to the skill to keep it out of one of the directories, or disable a tool',
      }),
    );
  }
  for (const [k, ids] of sortedEntries(leaks)) {
    const [tool, dir] = k.split('\u0000') as [string, string];
    warnings.push(
      new RulegateError({
        code: 'W_SKILL_LOAD',
        message: `${list(ids)} leave ${tool} out with \`tools:\`, but ${tool} also reads ${dir}, where another tool gets them`,
        hint: 'a directory several tools read cannot be given to only some of them',
      }),
    );
  }
  for (const [k, ids] of sortedEntries(dropped)) {
    const [dir, key] = k.split('\u0000') as [string, string];
    warnings.push(
      new RulegateError({
        code: 'W_SKILL_FIELD_DROPPED',
        message: `\`${key}\` in ${list(ids)} was left out of ${dir}/: no tool that reads it understands the key`,
        hint: 'keep it only if a tool you use reads it, or scope the skill with `tools:`',
      }),
    );
  }

  return { artifacts, warnings };
}

function sortedEntries<T>(map: ReadonlyMap<string, T>): [string, T][] {
  return [...map].sort(([a], [b]) => compareCodepoint(a, b));
}
