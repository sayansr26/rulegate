import { RulegateError } from '../model/errors.js';
import { AGENT_RESTRICTIONS, type Agent } from '../model/agent.js';
import { renderSkillFile } from '../model/serialize.js';
import { selects } from '../model/selector.js';
import { compareCodepoint } from './order.js';
import { cover } from './cover.js';
import { HASH_MARKER } from './marker.js';
import { ensureSingleTrailingNewline } from './eol.js';
import { tomlBasic, tomlMultiline } from './toml.js';
import type { Adapter } from '../adapter/adapter.js';
import type { Artifact } from '../adapter/artifact.js';
import type { AgentFolder } from '../adapter/docs.js';
import type { JsonValue, ToolId } from '../model/ids.js';

/** Carried to every folder: the two keys every tool that has agents reads. */
const ALWAYS = new Set(['name', 'description']);

interface Reader {
  readonly id: ToolId;
  readonly folders: readonly AgentFolder[];
  readonly maxChars?: number;
}

export interface AgentsPlan {
  readonly artifacts: readonly Artifact[];
  readonly warnings: readonly RulegateError[];
}

/**
 * Render every agent into the folders that reach each tool meant to receive it (RFC-0001
 * §14.2, T054).
 *
 * Placement is the skills rule — the fewest folders covering every enabled tool the agent
 * selects, a shared folder owned by its first reader in codepoint order — with one addition:
 * a tool can be reached only through a folder where it reads the agent's restrictions. A tool
 * with no such folder does not get the agent, because the alternative is an agent with more
 * power than its author wrote.
 */
export function planAgents(
  agents: readonly Agent[],
  adapters: readonly Adapter[],
  marker: boolean,
): AgentsPlan {
  const readers: Reader[] = adapters
    .filter((a) => a.docs.agents !== undefined)
    .map((a) => ({
      id: a.name,
      folders: a.docs.agents!.folders,
      ...(a.docs.agents!.maxChars === undefined ? {} : { maxChars: a.docs.agents!.maxChars }),
    }))
    .sort((a, b) => compareCodepoint(a.id, b.id));
  if (readers.length === 0 || agents.length === 0) return { artifacts: [], warnings: [] };

  const artifacts: Artifact[] = [];
  const restricted = new Map<ToolId, string[]>();
  const doubleLoads = new Map<string, string[]>();
  const leaks = new Map<string, string[]>();
  const unrestricted = new Map<string, string[]>();
  const dropped = new Map<string, string[]>();
  const overLimit = new Map<ToolId, string[]>();

  const push = (map: Map<string, string[]>, key: string, id: string): void => {
    map.set(key, [...(map.get(key) ?? []), id]);
  };
  const folderOf = (reader: Reader, dir: string): AgentFolder | undefined =>
    reader.folders.find((f) => f.dir === dir);

  for (const agent of [...agents].sort((a, b) => compareCodepoint(a.id, b.id))) {
    const keys = new Set(agent.frontmatter.map(([k]) => k));
    const restrictions = AGENT_RESTRICTIONS.filter((k) => keys.has(k));
    const carries = (folder: AgentFolder): boolean =>
      restrictions.every((k) => folder.extensions.includes(k));

    const targets: { id: string; dirs: string[] }[] = [];
    for (const reader of readers) {
      if (!selects(agent.adapters, reader.id)) continue;
      const dirs = reader.folders.filter(carries).map((f) => f.dir);
      if (dirs.length === 0) push(restricted, reader.id, agent.id);
      else targets.push({ id: reader.id, dirs });
    }
    if (targets.length === 0) continue;
    const chosen = cover(targets);

    for (const dir of chosen) {
      const readersOfDir = readers.filter((r) => folderOf(r, dir) !== undefined);
      const owner = readersOfDir[0]!;
      const folder = folderOf(owner, dir)!;
      const understood = new Set(readersOfDir.flatMap((r) => folderOf(r, dir)!.extensions));
      const entries: (readonly [string, JsonValue])[] = [];
      for (const entry of agent.frontmatter) {
        const [key] = entry;
        if (key === 'adapters') continue;
        if (ALWAYS.has(key) || restrictions.includes(key) || understood.has(key)) {
          entries.push(entry);
          continue;
        }
        push(dropped, `${dir}\u0000${key}`, agent.id);
      }
      artifacts.push({
        path: `${dir}/${agent.id}${folder.extension}`,
        contents:
          folder.format === 'toml'
            ? renderToml(entries, agent.body, marker, (key) =>
                push(dropped, `${dir}\u0000${key}`, agent.id),
              )
            : renderSkillFile(entries, agent.body, marker),
        adapter: owner.id,
        kind: 'subagent',
      });
    }

    for (const reader of readers) {
      const reads = chosen.filter((d) => folderOf(reader, d) !== undefined);
      if (reads.length === 0) continue;
      const blind = reads.filter((d) => !carries(folderOf(reader, d)!));
      if (blind.length > 0) {
        push(unrestricted, `${reader.id}\u0000${blind.join(' and ')}`, agent.id);
      } else if (reads.length > 1) {
        push(doubleLoads, `${reader.id}\u0000${reads.join(' and ')}`, agent.id);
      } else if (!selects(agent.adapters, reader.id)) {
        push(leaks, `${reader.id}\u0000${reads[0]!}`, agent.id);
      }
      if (reader.maxChars !== undefined && [...agent.body].length > reader.maxChars) {
        push(overLimit, reader.id, agent.id);
      }
    }
  }

  const warnings: RulegateError[] = [];
  const list = (ids: readonly string[]): string => ids.map((i) => `\`${i}\``).join(', ');
  const split = (k: string): [string, string] => k.split('\u0000') as [string, string];
  const them = (ids: readonly string[]): string => (ids.length === 1 ? 'it' : 'them');

  for (const [tool, ids] of sortedEntries(restricted)) {
    warnings.push(
      new RulegateError({
        code: 'W_AGENT_RESTRICTED',
        message: `${list(ids)} ${ids.length === 1 ? 'restricts' : 'restrict'} its tools, which ${tool} cannot be told, so ${tool} does not get ${them(ids)}`,
        hint: 'an agent without `tools` or `disallowedTools` goes to every tool; or scope this one with `adapters:`',
      }),
    );
  }
  for (const [k, ids] of sortedEntries(unrestricted)) {
    const [tool, dirs] = split(k);
    warnings.push(
      new RulegateError({
        code: 'W_AGENT_LOAD',
        message: `${tool} reads ${dirs}, where ${list(ids)} ${ids.length === 1 ? 'loads' : 'load'} without the tool restriction ${tool} cannot read`,
        hint: 'disable one of the tools, or drop the restriction if every tool may have it',
      }),
    );
  }
  for (const [k, ids] of sortedEntries(doubleLoads)) {
    const [tool, dirs] = split(k);
    warnings.push(
      new RulegateError({
        code: 'W_AGENT_LOAD',
        message: `${tool} reads ${dirs}, so it loads ${list(ids)} twice`,
        hint: 'add `adapters:` to the agent to keep it out of one of the folders, or disable a tool',
      }),
    );
  }
  for (const [k, ids] of sortedEntries(leaks)) {
    const [tool, dir] = split(k);
    warnings.push(
      new RulegateError({
        code: 'W_AGENT_LOAD',
        message: `${list(ids)} leave ${tool} out with \`adapters:\`, but ${tool} also reads ${dir}, where another tool gets ${them(ids)}`,
        hint: 'a folder several tools read cannot be given to only some of them',
      }),
    );
  }
  for (const [k, ids] of sortedEntries(dropped)) {
    const [dir, key] = split(k);
    warnings.push(
      new RulegateError({
        code: 'W_AGENT_FIELD_DROPPED',
        message: `\`${key}\` in ${list([...new Set(ids)])} was left out of ${dir}/: no tool that reads it understands the key`,
        hint: 'keep it only if a tool you use reads it, or scope the agent with `adapters:`',
      }),
    );
  }
  for (const [tool, ids] of sortedEntries(overLimit)) {
    const max = readers.find((r) => r.id === tool)!.maxChars!;
    warnings.push(
      new RulegateError({
        code: 'W_AGENT_OVER_LIMIT',
        message: `${list(ids)} ${ids.length === 1 ? 'has a prompt' : 'have prompts'} longer than the ${max} characters ${tool} reads`,
        hint: 'shorten the prompt, or move the detail into a skill the agent loads',
      }),
    );
  }

  return { artifacts, warnings };
}

/**
 * Codex's agent file: its own TOML keys, the prompt as `developer_instructions`. A value TOML
 * here cannot hold as a string is dropped and named, like any key a folder does not read.
 */
function renderToml(
  entries: readonly (readonly [string, JsonValue])[],
  body: string,
  marker: boolean,
  drop: (key: string) => void,
): string {
  const lines: string[] = [];
  for (const [key, value] of entries) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key)) {
      drop(key);
      continue;
    }
    lines.push(`${key} = ${tomlBasic(value)}`);
  }
  lines.push(
    `developer_instructions = """\n${tomlMultiline(ensureSingleTrailingNewline(body))}"""`,
  );
  const toml = `${lines.join('\n')}\n`;
  return marker ? `${HASH_MARKER}\n\n${toml}` : toml;
}

function sortedEntries<T>(map: ReadonlyMap<string, T>): [string, T][] {
  return [...map].sort(([a], [b]) => compareCodepoint(a, b));
}
