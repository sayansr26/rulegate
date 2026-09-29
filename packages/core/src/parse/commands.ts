import { type Node } from 'yaml';
import { RulegateError } from '../model/errors.js';
import { COMMANDS_DIR } from '../model/paths.js';
import { COMMAND_ID_PATTERN, POSITIONAL_TOKEN, type Command } from '../model/command.js';
import { ALL_TOOLS } from '../model/selector.js';
import { compareCodepoint } from '../render/order.js';
import { splitFrontmatter } from './frontmatter.js';
import { parseToolSelector } from './rules.js';
import { Validator } from './validate.js';
import { parseYaml } from './yaml.js';
import type { JsonValue } from '../model/ids.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export interface ParsedCommands {
  readonly commands: readonly Command[];
  readonly errors: readonly RulegateError[];
  /** Every file read, repo-relative POSIX. */
  readonly sourceFiles: readonly string[];
}

const invalid = (file: string, message: string, hint?: string): RulegateError =>
  new RulegateError({
    code: 'E_COMMAND_INVALID',
    message,
    source: { file },
    ...(hint === undefined ? {} : { hint }),
  });

/**
 * Read `.rulegate/commands/<id>.md` files into canonical commands (RFC-0001 §13).
 *
 * `root` is the `.rulegate/` level being parsed. Accumulates rather than throws, like the
 * rest of `parse`.
 */
export async function parseCommands(fs: ReadOnlyFileSystem, root: string): Promise<ParsedCommands> {
  const dir = root === '' ? COMMANDS_DIR : `${root}/${COMMANDS_DIR}`;
  if (!(await fs.exists(dir))) return { commands: [], errors: [], sourceFiles: [] };

  const commands: Command[] = [];
  const errors: RulegateError[] = [];
  const sourceFiles: string[] = [];

  for (const entry of await fs.listDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.kind === 'symlink') {
      errors.push(
        invalid(path, 'a command may not be a symlink', 'replace it with the file itself'),
      );
      continue;
    }
    if (entry.kind === 'dir') {
      // Only Claude Code and Gemini CLI turn a folder into a namespace, so a grouped command
      // would be `/team:deploy` in two tools and something else, or nothing, in the rest.
      errors.push(
        invalid(
          path,
          `commands cannot be grouped in folders: ${path}/`,
          `move each command directly into ${dir}/`,
        ),
      );
      continue;
    }
    if (!entry.name.endsWith('.md')) {
      errors.push(invalid(path, `${path} is not a command`, `commands are \`<name>.md\` files`));
      continue;
    }
    sourceFiles.push(path);
    const parsed = parseCommandFile(
      await fs.readFile(path),
      path,
      entry.name.slice(0, -'.md'.length),
    );
    errors.push(...parsed.errors);
    if (parsed.command !== undefined) commands.push(parsed.command);
  }

  return {
    commands: commands.sort((a, b) => compareCodepoint(a.id, b.id)),
    errors,
    sourceFiles: sourceFiles.sort(compareCodepoint),
  };
}

export interface CommandFileOptions {
  /**
   * A tool's own copy, read by `init` (RFC-0001 §13.3), which is looser than the canonical
   * format in the ways the tools are: frontmatter and `description` may be absent — Claude Code
   * then describes a command by its first line, and so does the import — and a `tools` key is
   * the tool's own (Copilot's names chat tools), so it is set aside rather than read as an
   * adapter selector. The positional check waits until the importer knows which tools a
   * command is for.
   */
  readonly importing?: boolean;
}

/** One command file's text — a canonical one, or a tool's copy `init` imports. */
export function parseCommandFile(
  raw: string,
  path: string,
  id: string,
  options: CommandFileOptions = {},
): { command?: Command; errors: RulegateError[]; ignored: string[] } {
  const importing = options.importing === true;
  const errors: RulegateError[] = [];
  const ignored: string[] = [];
  if (!COMMAND_ID_PATTERN.test(id)) {
    errors.push(
      invalid(
        path,
        `command name \`${id}\` is not valid`,
        'use 1-64 lowercase letters, digits and hyphens, with no leading, trailing or double hyphen',
      ),
    );
  }

  const split = splitFrontmatter(raw, path);
  if (!split.ok) return { errors: [...errors, split.error], ignored };
  const { yaml, yamlLineOffset, body } = split.value;
  const fallback = importing ? firstLine(body) : undefined;

  if (yaml === undefined || yaml.trim() === '') {
    if (fallback === undefined) {
      errors.push(
        invalid(path, 'a command has no frontmatter', 'add a `description` between `---` lines'),
      );
    }
    if (errors.length > 0) return { errors, ignored };
    return {
      command: {
        id,
        path,
        description: fallback!,
        tools: ALL_TOOLS,
        frontmatter: [['description', fallback!]],
        body,
        source: { file: path },
      },
      errors,
      ignored,
    };
  }

  const parsedYaml = parseYaml(yaml, path, yamlLineOffset);
  if (!parsedYaml.ok) return { errors: [...errors, parsedYaml.error], ignored };
  const v = new Validator(path, parsedYaml.value, 'E_COMMAND_INVALID');
  const rootNode = parsedYaml.value.doc.contents as Node | null;
  const map = rootNode === null ? undefined : v.asMap(rootNode, 'frontmatter');

  let description = v.string(v.get(map, 'description'), 'description');
  const described = description !== undefined && description.trim() !== '';
  if (!described && fallback !== undefined) {
    description = fallback;
  } else if (!described) {
    v.fail(
      map,
      'description',
      '`description` is required',
      'say what the command does; most tools list it beside `/name`',
    );
  }
  if (v.get(map, 'argument-hint') !== undefined) {
    v.string(v.get(map, 'argument-hint'), 'argument-hint');
  }

  const tools = importing ? undefined : parseToolSelector(v, v.get(map, 'tools'));
  const selector = tools ?? ALL_TOOLS;
  const single = selector.kind === 'include' && selector.tools.length === 1;
  const positional = POSITIONAL_TOKEN.exec(body);
  if (positional !== null && !single && !importing) {
    v.fail(
      map,
      'tools',
      `\`${positional[0]}\` means a different argument in different tools: Claude Code counts from $0, OpenCode from $1`,
      'use $ARGUMENTS, or name the one tool this command is for with `tools:`',
    );
  }

  const frontmatter: (readonly [string, JsonValue])[] = [];
  if (!described && description !== undefined) frontmatter.push(['description', description]);
  for (const key of v.keys(map)) {
    if (importing && key === 'tools') {
      ignored.push(key);
      continue;
    }
    if (key === 'description' && !described) continue;
    frontmatter.push([key, v.plain(v.get(map, key))]);
  }

  errors.push(...v.errors);
  if (errors.length > 0) return { errors, ignored };

  return {
    command: {
      id,
      path,
      description: description ?? '',
      tools: selector,
      frontmatter,
      body,
      source: { file: path },
    },
    errors,
    ignored,
  };
}

/** Claude Code's default description: the body's first non-empty line, heading marks off. */
function firstLine(body: string): string | undefined {
  const line = body
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l !== '');
  return line;
}
