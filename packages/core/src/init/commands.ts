import { RulegateError } from '../model/errors.js';
import { ARGUMENTS_PLACEHOLDER, POSITIONAL_TOKEN, type Command } from '../model/command.js';
import { COMMANDS_DIR } from '../model/paths.js';
import { ALL_TOOLS, type ToolSelector } from '../model/selector.js';
import { renderSkillFile } from '../model/serialize.js';
import { parseCommandFile } from '../parse/commands.js';
import { HTML_MARKER } from '../render/marker.js';
import { compareCodepoint } from '../render/order.js';
import { readCommandToml } from './command-toml.js';
import type { Adapter } from '../adapter/adapter.js';
import type { CommandsSupport } from '../adapter/docs.js';
import type { JsonValue, ToolId } from '../model/ids.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

export interface ImportedCommands {
  readonly commands: readonly Command[];
  /** Every file a command was imported from, repo-relative. */
  readonly importedFrom: readonly string[];
  readonly warnings: readonly RulegateError[];
}

interface Copy {
  readonly tool: ToolId;
  readonly path: string;
  readonly command: Command;
}

/**
 * Import the commands a repository's tools already have (RFC-0001 §13.3, T053).
 *
 * Generic over `AdapterDocs.commands`, like rendering: the folders read are the ones the
 * detected tools declare, each file is read in its tool's format, and its argument spelling is
 * turned back into `$ARGUMENTS`.
 *
 * - The same command in several tools' folders — same description, same body — becomes one,
 *   carrying every frontmatter key any copy had (the first copy's value wins a clash).
 * - A copy that differs is not merged: the one in the first folder in codepoint order is
 *   imported and the rest are named and left where they are.
 * - `tools:` is set to the tools that had it, and omitted when that is every tool with
 *   commands. A positional placeholder then needs exactly one tool, as it does canonically.
 * - A file that cannot be read as a command is named and left in place, not guessed at.
 */
export async function importCommands(
  fs: ReadOnlyFileSystem,
  adapters: readonly Adapter[],
  detected: readonly ToolId[],
): Promise<ImportedCommands> {
  const readers = adapters
    .filter((a) => a.docs.commands !== undefined && detected.includes(a.name))
    .map((a) => ({ id: a.name, support: a.docs.commands! }))
    .sort((a, b) => compareCodepoint(a.id, b.id));

  const warnings: RulegateError[] = [];
  const skip = (path: string, why: string, hint: string): void => {
    warnings.push(
      new RulegateError({
        code: 'W_COMMAND_IMPORT',
        message: `${path} was not imported: ${why}`,
        source: { file: path },
        hint,
      }),
    );
  };

  const found = new Map<string, Copy[]>();
  for (const { id: tool, support } of readers) {
    if (!(await fs.exists(support.dir))) continue;
    for (const entry of await fs.listDir(support.dir)) {
      if (entry.kind !== 'file' || !entry.name.endsWith(support.extension)) continue;
      const path = `${support.dir}/${entry.name}`;
      const id = entry.name.slice(0, -support.extension.length);
      const read = readCopy(await fs.readFile(path), path, id, support);
      if (read.command === undefined) {
        skip(
          path,
          read.why,
          'fix it and run init again, or move it into .rulegate/commands/ by hand',
        );
        continue;
      }
      for (const key of read.ignored) {
        warnings.push(
          new RulegateError({
            code: 'W_COMMAND_IMPORT',
            message: `\`${key}\` in ${path} is ${tool}'s own key, not Rulegate's \`tools\`, and was left out`,
            source: { file: path },
            hint: `scope the command with \`tools:\` in .rulegate/commands/${id}.md if it needs one`,
          }),
        );
      }
      found.set(id, [...(found.get(id) ?? []), { tool, path, command: read.command }]);
    }
  }

  const commands: Command[] = [];
  const importedFrom: string[] = [];
  const allTools = readers.map((r) => r.id);

  for (const [id, all] of [...found].sort(([a], [b]) => compareCodepoint(a, b))) {
    const copies = [...all].sort((a, b) => compareCodepoint(a.path, b.path));
    const first = copies[0]!;
    const same = copies.filter((c) => sameCommand(c.command, first.command));
    for (const other of copies.filter((c) => !same.includes(c))) {
      warnings.push(
        new RulegateError({
          code: 'W_COMMAND_IMPORT',
          message: `${other.path} differs from ${first.path}: imported ${first.path} and left this one where it is`,
          source: { file: other.path },
          hint: `merge what you need into .rulegate/commands/${id}.md, then delete ${other.path}`,
        }),
      );
    }

    const having = same.map((c) => c.tool).sort(compareCodepoint);
    const tools: ToolSelector =
      having.length === allTools.length ? ALL_TOOLS : { kind: 'include', tools: having };
    const positional = POSITIONAL_TOKEN.exec(first.command.body);
    if (positional !== null && !(tools.kind === 'include' && tools.tools.length === 1)) {
      for (const copy of same) {
        skip(
          copy.path,
          `\`${positional[0]}\` means a different argument in ${having.join(' and ')}`,
          'rewrite it with $ARGUMENTS, or keep a copy per tool by hand',
        );
      }
      continue;
    }

    const frontmatter: (readonly [string, JsonValue])[] = [];
    const seen = new Set<string>();
    for (const copy of same) {
      for (const entry of copy.command.frontmatter) {
        if (seen.has(entry[0])) continue;
        seen.add(entry[0]);
        frontmatter.push(entry);
      }
    }
    if (tools.kind === 'include') frontmatter.push(['tools', [...tools.tools]]);

    const path = `${COMMANDS_DIR}/${id}.md`;
    commands.push({ ...first.command, path, tools, frontmatter, source: { file: path } });
    for (const copy of same) importedFrom.push(copy.path);
  }

  return { commands, importedFrom: importedFrom.sort(compareCodepoint), warnings };
}

/**
 * One tool's file, in that tool's format, as a command with `$ARGUMENTS` spelled canonically.
 * Every format goes through `parseCommandFile`, so what is imported is normalised exactly as
 * `.rulegate/commands/` is when `check` reads it back.
 */
function readCopy(
  raw: string,
  path: string,
  id: string,
  support: CommandsSupport,
): { command: Command; ignored: string[] } | { command?: undefined; why: string } {
  let text = raw;
  if (support.format === 'toml') {
    const toml = readCommandToml(raw);
    if (!toml.ok) return { why: toml.reason };
    const unknown = [...toml.values.keys()].filter((k) => k !== 'prompt' && k !== 'description');
    if (unknown.length > 0) {
      return {
        why: `it sets ${unknown.map((k) => `\`${k}\``).join(', ')}, which only \`prompt\` and \`description\` are documented beside`,
      };
    }
    const prompt = toml.values.get('prompt');
    if (prompt === undefined) return { why: 'it has no `prompt`' };
    const description = toml.values.get('description');
    text = renderSkillFile(
      description === undefined ? [] : [['description', description]],
      prompt,
      false,
    );
    if (description === undefined) text = `${prompt}\n`;
  } else if (support.format === 'markdown-plain' && !raw.startsWith('---')) {
    // The description is the first paragraph, as the renderer writes it.
    const paragraphs = raw
      .replace(HTML_MARKER, '')
      .trim()
      .split(/\n\s*\n/);
    const description = paragraphs[0]?.replace(/\s*\n\s*/g, ' ').trim() ?? '';
    const body = paragraphs.slice(1).join('\n\n');
    text = renderSkillFile([['description', description]], body === '' ? description : body, false);
  }

  const parsed = parseCommandFile(text, path, id, { importing: true });
  if (parsed.command === undefined) {
    return { why: parsed.errors[0]?.message ?? 'it is not a valid command' };
  }
  const spelling = support.arguments;
  const body =
    spelling === undefined || spelling === ARGUMENTS_PLACEHOLDER
      ? parsed.command.body
      : parsed.command.body.split(spelling).join(ARGUMENTS_PLACEHOLDER);
  return { command: { ...parsed.command, body }, ignored: parsed.ignored };
}

function sameCommand(a: Command, b: Command): boolean {
  return a.description === b.description && a.body === b.body;
}
