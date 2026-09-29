import { RulegateError } from '../model/errors.js';
import { ARGUMENTS_TOKEN } from '../model/command.js';
import { renderSkillFile } from '../model/serialize.js';
import { selects } from '../model/selector.js';
import { compareCodepoint } from '../render/order.js';
import { HASH_MARKER, HTML_MARKER } from '../render/marker.js';
import { ensureSingleTrailingNewline } from '../render/eol.js';
import { tomlBasic, tomlMultiline } from './toml.js';
import type { Adapter } from '../adapter/adapter.js';
import type { Artifact } from '../adapter/artifact.js';
import type { CommandsSupport } from '../adapter/docs.js';
import type { Command } from '../model/command.js';
import type { JsonValue, ToolId } from '../model/ids.js';
import type { Skill } from '../model/skill.js';

export interface CommandsPlan {
  readonly artifacts: readonly Artifact[];
  readonly warnings: readonly RulegateError[];
}

/**
 * Render every command into the folder of each enabled tool it selects (RFC-0001 §13.2,
 * T053).
 *
 * Generic over `AdapterDocs.commands`: the folder, the file format, the argument spelling and
 * the keys a tool reads are adapter data, so no tool is named here. Each tool has its own
 * folder, so unlike skills there is nothing to share and each copy is owned by its tool.
 *
 * What cannot be carried is said, aggregated so one cause is one warning: a command using
 * `$ARGUMENTS` for a tool with no argument syntax, a key a tool does not read, a copy over a
 * tool's size cap, and a skill of the same name that also answers `/<id>`.
 */
export function planCommands(
  commands: readonly Command[],
  skills: readonly Skill[],
  adapters: readonly Adapter[],
  marker: boolean,
): CommandsPlan {
  const tools = adapters
    .filter((a) => a.docs.commands !== undefined)
    .map((a) => ({ id: a.name, support: a.docs.commands!, skills: a.docs.skills !== undefined }))
    .sort((a, b) => compareCodepoint(a.id, b.id));
  if (tools.length === 0 || commands.length === 0) return { artifacts: [], warnings: [] };

  const artifacts: Artifact[] = [];
  const noArguments = new Map<ToolId, string[]>();
  const dropped = new Map<string, string[]>();
  const overLimit = new Map<ToolId, string[]>();
  const shadowed = new Map<ToolId, string[]>();

  for (const command of [...commands].sort((a, b) => compareCodepoint(a.id, b.id))) {
    const usesArguments = new RegExp(ARGUMENTS_TOKEN.source).test(command.body);
    for (const tool of tools) {
      if (!selects(command.tools, tool.id)) continue;
      const { support } = tool;
      if (usesArguments && support.arguments === undefined) {
        noArguments.set(tool.id, [...(noArguments.get(tool.id) ?? []), command.id]);
        continue;
      }

      const understood = new Set(support.extensions);
      const entries: (readonly [string, JsonValue])[] = [];
      for (const entry of command.frontmatter) {
        const [key] = entry;
        if (key === 'tools') continue;
        if (key === 'description' || understood.has(key)) {
          entries.push(entry);
          continue;
        }
        const k = `${command.id}\u0000${key}`;
        dropped.set(k, [...(dropped.get(k) ?? []), tool.id]);
      }

      const body =
        support.arguments === undefined ? command.body : respell(command.body, support.arguments);
      const contents = renderCommand(support, entries, command.description, body, marker);
      if (support.maxChars !== undefined && [...contents].length > support.maxChars) {
        overLimit.set(tool.id, [...(overLimit.get(tool.id) ?? []), command.id]);
      }
      if (tool.skills && skills.some((s) => s.id === command.id && selects(s.tools, tool.id))) {
        shadowed.set(tool.id, [...(shadowed.get(tool.id) ?? []), command.id]);
      }
      artifacts.push({
        path: `${support.dir}/${command.id}${support.extension}`,
        contents,
        adapter: tool.id,
        kind: 'command',
      });
    }
  }

  const warnings: RulegateError[] = [];
  const list = (ids: readonly string[]): string => ids.map((i) => `\`${i}\``).join(', ');
  for (const [tool, ids] of sortedEntries(noArguments)) {
    const them = ids.length === 1 ? 'it' : 'them';
    warnings.push(
      new RulegateError({
        code: 'W_COMMAND_ARGUMENTS',
        message: `${list(ids)} ${ids.length === 1 ? 'uses' : 'use'} $ARGUMENTS, which ${tool} has no syntax for, so ${tool} does not get ${them}`,
        hint: 'leave $ARGUMENTS out of a command every tool should get, or scope it with `tools:`',
      }),
    );
  }
  for (const [k, toolIds] of sortedEntries(dropped)) {
    const [id, key] = k.split('\u0000') as [string, string];
    warnings.push(
      new RulegateError({
        code: 'W_COMMAND_FIELD_DROPPED',
        message: `\`${key}\` in \`${id}\` was left out for ${toolIds.join(', ')}, which ${toolIds.length === 1 ? 'does' : 'do'} not read it`,
        hint: 'keep it only if a tool you use reads it, or scope the command with `tools:`',
      }),
    );
  }
  for (const [tool, ids] of sortedEntries(overLimit)) {
    const max = tools.find((t) => t.id === tool)!.support.maxChars!;
    warnings.push(
      new RulegateError({
        code: 'W_COMMAND_OVER_LIMIT',
        message: `${list(ids)} ${ids.length === 1 ? 'is' : 'are'} longer than the ${max} characters ${tool} reads of a command`,
        hint: 'shorten it, or move the detail into a skill',
      }),
    );
  }
  for (const [tool, ids] of sortedEntries(shadowed)) {
    warnings.push(
      new RulegateError({
        code: 'W_COMMAND_SHADOWED',
        message: `${list(ids)} ${ids.length === 1 ? 'is' : 'are'} both a skill and a command for ${tool}, so two things answer the same /name`,
        hint: 'rename one of them, or scope one away from this tool with `tools:`',
      }),
    );
  }

  return { artifacts, warnings };
}

/** `$ARGUMENTS` in the tool's spelling. A function replacement, so `$` in it is literal. */
function respell(body: string, spelling: string): string {
  return body.replace(ARGUMENTS_TOKEN, () => spelling);
}

function renderCommand(
  support: CommandsSupport,
  entries: readonly (readonly [string, JsonValue])[],
  description: string,
  body: string,
  marker: boolean,
): string {
  switch (support.format) {
    case 'markdown':
      return renderSkillFile(entries, body, marker);
    case 'markdown-plain': {
      const text = `${description.trim()}\n\n${ensureSingleTrailingNewline(body)}`;
      return marker ? `${HTML_MARKER}\n\n${text}` : text;
    }
    case 'toml': {
      const toml = `description = ${tomlBasic(description)}\nprompt = """\n${tomlMultiline(ensureSingleTrailingNewline(body))}"""\n`;
      return marker ? `${HASH_MARKER}\n\n${toml}` : toml;
    }
  }
}

function sortedEntries<T>(map: ReadonlyMap<string, T>): [string, T][] {
  return [...map].sort(([a], [b]) => compareCodepoint(a, b));
}
