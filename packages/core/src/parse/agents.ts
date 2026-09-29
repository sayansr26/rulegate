import { isScalar, isSeq, type Node } from 'yaml';
import { RulegateError } from '../model/errors.js';
import { AGENTS_DIR } from '../model/paths.js';
import { AGENT_ID_PATTERN, AGENT_RESTRICTIONS, type Agent } from '../model/agent.js';
import { compareCodepoint } from '../render/order.js';
import { splitFrontmatter } from './frontmatter.js';
import { parseToolSelector } from './rules.js';
import { Validator } from './validate.js';
import { parseYaml } from './yaml.js';
import type { JsonValue } from '../model/ids.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export interface ParsedAgents {
  readonly agents: readonly Agent[];
  readonly errors: readonly RulegateError[];
  /** Every file read, repo-relative POSIX. */
  readonly sourceFiles: readonly string[];
}

const invalid = (file: string, message: string, hint?: string): RulegateError =>
  new RulegateError({
    code: 'E_AGENT_INVALID',
    message,
    source: { file },
    ...(hint === undefined ? {} : { hint }),
  });

/**
 * Read `.rulegate/agents/<name>.md` files into canonical agents (RFC-0001 §14).
 *
 * `root` is the `.rulegate/` level being parsed. Accumulates rather than throws, like the
 * rest of `parse`.
 */
export async function parseAgents(fs: ReadOnlyFileSystem, root: string): Promise<ParsedAgents> {
  const dir = root === '' ? AGENTS_DIR : `${root}/${AGENTS_DIR}`;
  if (!(await fs.exists(dir))) return { agents: [], errors: [], sourceFiles: [] };

  const agents: Agent[] = [];
  const errors: RulegateError[] = [];
  const sourceFiles: string[] = [];

  for (const entry of await fs.listDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.kind === 'symlink') {
      errors.push(
        invalid(path, 'an agent may not be a symlink', 'replace it with the file itself'),
      );
      continue;
    }
    if (entry.kind === 'dir') {
      errors.push(
        invalid(
          path,
          `agents cannot be grouped in folders: ${path}/`,
          `move each agent directly into ${dir}/`,
        ),
      );
      continue;
    }
    if (!entry.name.endsWith('.md')) {
      errors.push(invalid(path, `${path} is not an agent`, 'agents are `<name>.md` files'));
      continue;
    }
    sourceFiles.push(path);
    const parsed = parseAgentFile(
      await fs.readFile(path),
      path,
      entry.name.slice(0, -'.md'.length),
    );
    errors.push(...parsed.errors);
    if (parsed.agent !== undefined) agents.push(parsed.agent);
  }

  return {
    agents: agents.sort((a, b) => compareCodepoint(a.id, b.id)),
    errors,
    sourceFiles: sourceFiles.sort(compareCodepoint),
  };
}

export interface AgentFileOptions {
  /**
   * A tool's own copy, read by `init` (RFC-0001 §14.3). Claude Code and Codex name an agent by
   * its `name` field whatever the file is called, so the file name only stands in when `name`
   * is absent — the tools that name agents by file (OpenCode, Kilo) write no `name`.
   */
  readonly importing?: boolean;
}

/** One agent file's text — a canonical one, or a tool's copy `init` imports. */
export function parseAgentFile(
  raw: string,
  path: string,
  fileId: string,
  options: AgentFileOptions = {},
): { agent?: Agent; errors: RulegateError[] } {
  const importing = options.importing === true;
  const errors: RulegateError[] = [];

  const split = splitFrontmatter(raw, path);
  if (!split.ok) return { errors: [split.error] };
  const { yaml, yamlLineOffset, body } = split.value;
  if (yaml === undefined || yaml.trim() === '') {
    return {
      errors: [
        invalid(
          path,
          'an agent has no frontmatter',
          'add `name` and `description` between `---` lines',
        ),
      ],
    };
  }

  const parsedYaml = parseYaml(yaml, path, yamlLineOffset);
  if (!parsedYaml.ok) return { errors: [parsedYaml.error] };
  const v = new Validator(path, parsedYaml.value, 'E_AGENT_INVALID');
  const rootNode = parsedYaml.value.doc.contents as Node | null;
  const map = rootNode === null ? undefined : v.asMap(rootNode, 'frontmatter');

  const declared = v.string(v.get(map, 'name'), 'name');
  const id = importing ? (declared ?? fileId) : fileId;
  if (!AGENT_ID_PATTERN.test(id)) {
    v.fail(
      v.get(map, 'name') ?? map,
      'name',
      `agent name \`${id}\` is not valid`,
      'use 1-64 lowercase letters, digits and hyphens, with no leading, trailing or double hyphen',
    );
  }
  if (declared === undefined && !importing) {
    v.fail(map, 'name', '`name` is required', `set \`name: ${fileId}\``);
  } else if (declared !== undefined && declared !== id) {
    v.fail(
      v.get(map, 'name'),
      'name',
      `\`name\` is \`${declared}\` but the file is \`${fileId}.md\`; they must match`,
      `rename the file to ${declared}.md, or set \`name: ${fileId}\``,
    );
  }

  const description = v.string(v.get(map, 'description'), 'description');
  if (description === undefined || description.trim() === '') {
    v.fail(
      map,
      'description',
      '`description` is required',
      'say when a tool should hand work to this agent',
    );
  }

  // A restriction every tool that reads it takes as a list or a comma-separated string.
  for (const key of AGENT_RESTRICTIONS) {
    const node = v.get(map, key);
    if (node === undefined) continue;
    if (isScalar(node) && typeof node.value === 'string') continue;
    if (isSeq(node)) {
      v.stringArray(node, key);
      continue;
    }
    v.fail(node, key, `\`${key}\` must be a comma-separated string or a list of tool names`);
  }

  const adapters = parseToolSelector(v, v.get(map, 'adapters'), 'adapters');

  const frontmatter: (readonly [string, JsonValue])[] = [];
  if (declared === undefined && importing) frontmatter.push(['name', id]);
  for (const key of v.keys(map)) frontmatter.push([key, v.plain(v.get(map, key))]);

  errors.push(...v.errors);
  if (errors.length > 0) return { errors };

  return {
    agent: {
      id,
      path,
      name: id,
      description: description ?? '',
      adapters,
      frontmatter,
      body,
      source: { file: path },
    },
    errors,
  };
}
