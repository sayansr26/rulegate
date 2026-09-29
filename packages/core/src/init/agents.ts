import { RulegateError } from '../model/errors.js';
import { AGENT_RESTRICTIONS, type Agent } from '../model/agent.js';
import { AGENTS_DIR } from '../model/paths.js';
import { ALL_TOOLS, type ToolSelector } from '../model/selector.js';
import { renderSkillFile } from '../model/serialize.js';
import { parseAgentFile } from '../parse/agents.js';
import { compareCodepoint } from '../render/order.js';
import { readCommandToml } from './command-toml.js';
import type { Adapter } from '../adapter/adapter.js';
import type { AgentFolder } from '../adapter/docs.js';
import type { JsonValue, ToolId } from '../model/ids.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export interface ImportedAgents {
  readonly agents: readonly Agent[];
  /** Every file an agent was imported from, repo-relative, sorted. */
  readonly importedFrom: readonly string[];
  /** For each imported agent, the tool files it came from, and which tools read each. */
  readonly copies: readonly { readonly path: string; readonly readers: readonly ToolId[] }[];
  readonly warnings: readonly RulegateError[];
}

interface Copy {
  readonly dir: string;
  readonly path: string;
  readonly agent: Agent;
}

/**
 * Import the agents a repository's tools already have (RFC-0001 §14.3, T054).
 *
 * Generic over `AdapterDocs.agents`, like rendering: the folders read are the ones the detected
 * tools declare, each in its format. A folder several tools read is read once.
 *
 * - An agent is named by its `name`, or by its file where a tool writes no `name`.
 * - The same agent in several folders — same description, prompt and restrictions — becomes
 *   one, carrying every key any copy had (the first copy's value wins a clash). Restrictions
 *   are part of "the same" because merging one copy's `tools` into another's would take tools
 *   away from an agent that had them — or, the other way round, give them.
 * - A copy that differs is not merged: the one in the first folder in codepoint order is
 *   imported and the rest are named and left where they are.
 * - `adapters:` is set to the tools that read the folders it came from, and omitted when that
 *   is every tool with agents.
 */
export async function importAgents(
  fs: ReadOnlyFileSystem,
  adapters: readonly Adapter[],
  detected: readonly ToolId[],
): Promise<ImportedAgents> {
  const readers = adapters
    .filter((a) => a.docs.agents !== undefined && detected.includes(a.name))
    .map((a) => ({ id: a.name, folders: a.docs.agents!.folders }))
    .sort((a, b) => compareCodepoint(a.id, b.id));
  const folders = new Map<string, AgentFolder>();
  for (const r of readers)
    for (const f of r.folders) if (!folders.has(f.dir)) folders.set(f.dir, f);
  const readersOf = (dir: string): ToolId[] =>
    readers.filter((r) => r.folders.some((f) => f.dir === dir)).map((r) => r.id);

  const warnings: RulegateError[] = [];
  const found = new Map<string, Copy[]>();
  for (const [dir, folder] of [...folders].sort(([a], [b]) => compareCodepoint(a, b))) {
    if (!(await fs.exists(dir))) continue;
    for (const entry of await fs.listDir(dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith(folder.extension)) continue;
      const path = `${dir}/${entry.name}`;
      const read = readCopy(
        await fs.readFile(path),
        path,
        entry.name.slice(0, -folder.extension.length),
        folder,
      );
      if (read.agent === undefined) {
        warnings.push(
          new RulegateError({
            code: 'W_AGENT_IMPORT',
            message: `${path} was not imported: ${read.why}`,
            source: { file: path },
            hint: 'fix it and run init again, or move it into .rulegate/agents/ by hand',
          }),
        );
        continue;
      }
      found.set(read.agent.id, [
        ...(found.get(read.agent.id) ?? []),
        { dir, path, agent: read.agent },
      ]);
    }
  }

  const agents: Agent[] = [];
  const importedFrom: string[] = [];
  const copies: { path: string; readers: ToolId[] }[] = [];
  const allTools = readers.map((r) => r.id);

  for (const [id, all] of [...found].sort(([a], [b]) => compareCodepoint(a, b))) {
    const sorted = [...all].sort((a, b) => compareCodepoint(a.path, b.path));
    const first = sorted[0]!;
    const same = sorted.filter((c) => sameAgent(c.agent, first.agent));
    for (const other of sorted.filter((c) => !same.includes(c))) {
      warnings.push(
        new RulegateError({
          code: 'W_AGENT_IMPORT',
          message: `${other.path} differs from ${first.path}: imported ${first.path} and left this one where it is`,
          source: { file: other.path },
          hint: `merge what you need into .rulegate/agents/${id}.md, then delete ${other.path}`,
        }),
      );
    }

    const having = [...new Set(same.flatMap((c) => readersOf(c.dir)))].sort(compareCodepoint);
    const selector: ToolSelector =
      having.length === allTools.length ? ALL_TOOLS : { kind: 'include', tools: having };
    const frontmatter: (readonly [string, JsonValue])[] = [];
    const seen = new Set<string>();
    for (const copy of same) {
      for (const entry of copy.agent.frontmatter) {
        if (seen.has(entry[0])) continue;
        seen.add(entry[0]);
        frontmatter.push(entry);
      }
    }
    if (selector.kind === 'include') frontmatter.push(['adapters', [...selector.tools]]);

    const path = `${AGENTS_DIR}/${id}.md`;
    agents.push({ ...first.agent, path, adapters: selector, frontmatter, source: { file: path } });
    for (const copy of same) {
      importedFrom.push(copy.path);
      copies.push({ path: copy.path, readers: readersOf(copy.dir) });
    }
  }

  return { agents, importedFrom: importedFrom.sort(compareCodepoint), copies, warnings };
}

/**
 * One tool's file, in its folder's format. TOML is turned into the Markdown shape first, so
 * every copy goes through `parseAgentFile` and is normalised as `.rulegate/agents/` is when
 * `check` reads it back.
 */
function readCopy(
  raw: string,
  path: string,
  fileId: string,
  folder: AgentFolder,
): { agent: Agent } | { agent?: undefined; why: string } {
  let text = raw;
  if (folder.format === 'toml') {
    const toml = readCommandToml(raw);
    if (!toml.ok) return { why: toml.reason };
    const prompt = toml.values.get('developer_instructions');
    if (prompt === undefined) return { why: 'it has no `developer_instructions`' };
    const entries: (readonly [string, JsonValue])[] = [];
    for (const key of ['name', 'description']) {
      const value = toml.values.get(key);
      if (value !== undefined) entries.push([key, value]);
    }
    for (const [key, value] of toml.values) {
      if (key !== 'name' && key !== 'description' && key !== 'developer_instructions') {
        entries.push([key, value]);
      }
    }
    text = renderSkillFile(entries, prompt, false);
  }
  const parsed = parseAgentFile(text, path, fileId, { importing: true });
  if (parsed.agent === undefined) {
    return { why: parsed.errors[0]?.message ?? 'it is not a valid agent' };
  }
  return { agent: parsed.agent };
}

function sameAgent(a: Agent, b: Agent): boolean {
  const restrictions = (x: Agent): string =>
    JSON.stringify(
      AGENT_RESTRICTIONS.map((k) => x.frontmatter.find(([key]) => key === k)?.[1] ?? null),
    );
  return (
    a.description === b.description && a.body === b.body && restrictions(a) === restrictions(b)
  );
}
