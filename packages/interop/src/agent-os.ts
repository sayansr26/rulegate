import {
  MARKER_TEXT,
  RulegateError,
  claimRuleId,
  compareCodepoint,
  importRuleId,
  importedRule,
  stripJsonc,
  type AdapterContext,
  type JsonValue,
  type RuleDocument,
} from '@rulegate/adapter-kit';
import { FRONTMATTER, readFrontmatter } from './frontmatter.js';
import type { InteropImporter, InteropResult } from './types.js';

const AGENT_OS_DIR = '.agent-os';
const CONFIG = `${AGENT_OS_DIR}/config.json`;
const SOURCE_AGENTS = `${AGENT_OS_DIR}/AGENTS.md`;
const RULES_DIR = `${AGENT_OS_DIR}/rules`;
const SKILLS_DIR = `${AGENT_OS_DIR}/skills`;

/**
 * agent-os keeps its sources in `.agent-os/` — `config.json`, `AGENTS.md`, `rules/*.md` and
 * `skills/<name>/` — and compiles them into each tool's native files.
 *
 * Verified against agent-os 0.6.0 (`@sayansr26/agent-os`, 2026-09-26): `src/source.mjs`
 * (`load`, `parseFrontmatter`, `BANNER`) for the source format, and `src/targets.mjs`
 * (`TARGETS`, `SKILL_DIRS`, `UNIVERSAL`) for what it writes and where its banner sits.
 * The fixture's outputs were checked byte-for-byte against agent-os's own `compile()`.
 *
 * The banner's tail names the command to run and has changed between releases, so only
 * the stable head is matched.
 */
export const AGENT_OS_BANNER = 'agent-os: generated from .agent-os/';

/**
 * agent-os target ids that name a tool Rulegate also has.
 *
 * `codex` is absent because agent-os has no such target: it writes `AGENTS.md` for every
 * project whatever the targets say, and codex is the adapter that owns that file, so
 * `read()` adds it unconditionally.
 */
export const TARGET_TO_TOOL: Readonly<Record<string, string>> = {
  antigravity: 'antigravity',
  'claude-code': 'claude-code',
  cline: 'cline',
  cursor: 'cursor',
  'gemini-cli': 'gemini',
  kilo: 'kilo',
  opencode: 'opencode',
  windsurf: 'windsurf',
};

/**
 * Where agent-os writes a bannered file. Each is masked from the adapter pass only when the
 * file on disk carries a banner, never because the path matches: a hand-written `AGENTS.md`
 * in an agent-os repository is somebody's work, not agent-os's output.
 *
 * The merged JSON configs (`.gemini/settings.json`, `opencode.json`, `kilo.json`) carry no
 * banner and are the user's files with a key added, so they are reported, not masked.
 */
const OUTPUTS = [
  'AGENTS.md',
  '.agents/rules/*.md',
  '.claude/rules/*.md',
  '.clinerules/*.md',
  '.cursor/rules/*.mdc',
  '.windsurf/rules/*.md',
] as const;

/** `SKILL_DIRS`' destinations: where agent-os copies each `.agent-os/skills/<name>/`. */
const SKILL_COPIES = ['.agents/skills', '.claude/skills', '.cline/skills'] as const;

/** The configs agent-os merges an `instructions` list into, pointing at `.agent-os/rules/`. */
const INSTRUCTION_CONFIGS = ['opencode.json', 'kilo.json'] as const;

/** Any of these stops Claude Code falling back to AGENTS.md (the claude-code adapter's docs). */
const CLAUDE_MEMORY = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'] as const;

/**
 * The placeholder `agent-os init` writes to `.agent-os/AGENTS.md` (`scaffold` in
 * `src/cli.mjs`), unchanged from 0.5.0, which introduced it, to 0.6.0.
 */
const SCAFFOLD = `# Project instructions

Replace this with what is true in **every** session: how to build, how to run,
how to verify, and the conventions that are not obvious from the code.

Keep it short. Anything that only matters for part of the tree belongs in
\`.agent-os/rules/\` instead, where it can be scoped to the files it applies to.`;

/** The index `agentsMd` appends to AGENTS.md: this head, then one entry per scoped rule. */
const SCOPED_INDEX = `## Path-scoped rules

These apply only to matching files. Tools with conditional rule loading
receive them as real scoped rules; read the relevant one before editing.`;
/** The entry for the scaffold's `rules/example.md`, listed long after the file is deleted. */
const EXAMPLE_ENTRY = '- `src/api/**` — Conventions for the API layer';

/**
 * What `agentsMd` compiled from the rules on disk, in the text form `normalize` gives it:
 * one `## <name>` section per universal rule, and one index entry per scoped rule.
 */
export interface AgentOsCompiled {
  readonly sections?: ReadonlySet<string>;
  readonly entries?: ReadonlySet<string>;
}

/** Line endings, trailing whitespace and the outer blank lines: forgiven in every comparison. */
function normalize(text: string): string {
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * Whether `.agent-os/AGENTS.md` is still the placeholder, never filled in.
 *
 * 0.5.0 wrote AGENTS.md without a banner and 0.6.0's `init` adopts an unbannered AGENTS.md
 * as the source, so a project set up on 0.5.0 holds the placeholder followed by the
 * path-scoped index 0.5.0 compiled into it (lmsfront, T110), with a section for each
 * universal rule ahead of the index — agent-os's text throughout. Line endings, trailing
 * whitespace and blank lines are forgiven; anything else is an edit, and an edited body is
 * somebody's instructions. A section or index entry counts as agent-os's only when a rule in
 * `compiled` compiles to it, or the entry is the scaffold's example: the shape alone is one
 * anybody can type, and a stale one for a rule since renamed errs towards importing.
 */
export function isAgentOsScaffold(contents: string, compiled: AgentOsCompiled = {}): boolean {
  const { sections = new Set<string>(), entries = new Set<string>() } = compiled;
  const text = normalize(contents);
  if (!text.startsWith(SCAFFOLD)) return false;
  let rest = text.slice(SCAFFOLD.length);
  while (rest !== '') {
    if (!rest.startsWith('\n\n')) return false;
    rest = rest.replace(/^\n+/, '');
    const match = [...sections].find((s) => rest === s || rest.startsWith(`${s}\n\n`));
    if (match !== undefined) {
      rest = rest.slice(match.length);
      continue;
    }
    if (!rest.startsWith(`${SCOPED_INDEX}\n\n`)) return false;
    const lines = rest.slice(SCOPED_INDEX.length + 2).split('\n');
    const end = lines.findIndex((line) => line !== EXAMPLE_ENTRY && !entries.has(line));
    if (end === 0) return false;
    // What follows the entries starts with the blank line before the next index.
    rest = end === -1 ? '' : `\n${lines.slice(end).join('\n')}`;
  }
  return true;
}

/**
 * Which generator's banner a file carries, if any: Rulegate's or agent-os's.
 *
 * Either one makes the file derived (T113). agent-os adopted this very repository once and
 * turned Rulegate's generated sections into its own sources, banner and all, then stacked
 * its banner on the generated `AGENTS.md` — so each tool's output can carry the other's
 * banner, and checking for one only is how a rendering gets imported as a source.
 *
 * The banner is looked for in the leading HTML comments after any frontmatter, which is
 * where both tools put it: first in `AGENTS.md` and `.agents/rules`, after the `---` block
 * in `.mdc`, `.claude/rules`, `.clinerules` and `.windsurf/rules`. Rulegate's wins when
 * both are there, because it names the stronger fact — the real source was `.rulegate/`.
 */
export function derivedFrom(contents: string): 'rulegate' | 'agent-os' | undefined {
  const text = contents.replace(/^\uFEFF/, '');
  const match = FRONTMATTER.exec(text);
  const rest = match === null ? text : text.slice(match[0].length);
  let found: 'rulegate' | 'agent-os' | undefined;
  for (const line of rest.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (!trimmed.startsWith('<!--')) break;
    if (trimmed.includes(MARKER_TEXT)) return 'rulegate';
    if (trimmed.includes(AGENT_OS_BANNER)) found = 'agent-os';
  }
  return found;
}

type Note = { readonly path: string; readonly message: string };

/**
 * What names agent-os as the place to edit rules: its source directory and its package. A
 * rule is imported as it is, so a line telling the agent to edit `.agent-os/rules/` and run
 * agent-os's `sync` survives into `.rulegate/rules/` and, once `.agent-os/` is gone, sends
 * it to a directory nothing reads (T146). Reported, never rewritten: the sentence around it
 * is the author's, and only they know what it should say instead. The plugin audit's twin is
 * `AGENT_OS_MENTION` in `@rulegate/claude`, which checks the canonical rules after the fact.
 */
export const AGENT_OS_MENTION = /\.agent-os\/|@sayansr26\/agent-os\b/;

/** 1-based lines naming agent-os, skipping a banner comment: its text names `.agent-os/` too. */
function agentOsMentionLines(contents: string): number[] {
  return contents.split(/\r?\n/).flatMap((l, i) => {
    const t = l.trim();
    if (t.startsWith('<!--') && t.includes(AGENT_OS_BANNER)) return [];
    return AGENT_OS_MENTION.test(l) ? [i + 1] : [];
  });
}

function mentionNote(path: string, lines: readonly number[]): Note {
  const one = lines.length === 1;
  return {
    path,
    message: `${one ? 'line' : 'lines'} ${lines.join(', ')} ${one ? 'names' : 'name'} \`.agent-os/\` or \`@sayansr26/agent-os\` as where rules are edited, and the rule imported from it keeps ${one ? 'it' : 'them'} as written. Once .agent-os/ is gone an edit made there changes nothing: after init, change ${one ? 'it' : 'them'} in .rulegate/rules/ to name .rulegate/rules/ and \`rulegate sync\``,
  };
}

async function detect(ctx: AdapterContext): Promise<boolean> {
  return ctx.fs.exists(AGENT_OS_DIR);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readJson(ctx: AdapterContext, path: string): Promise<unknown> {
  const contents = await ctx.fs.tryReadFile(path);
  if (contents === undefined) return undefined;
  try {
    return JSON.parse(stripJsonc(contents)) as unknown;
  } catch {
    return undefined;
  }
}

/** A source that is some generator's output: refused, and why. */
function derivedSource(path: string, by: 'rulegate' | 'agent-os'): RulegateError {
  return by === 'rulegate'
    ? new RulegateError({
        code: 'E_NO_CANONICAL_SOURCE',
        message: `${path} is Rulegate's own generated output, not a source: agent-os imported it from a repository Rulegate managed, and importing it back would rebuild .rulegate/ from a rendering that has already lost its frontmatter`,
        source: { file: path },
        hint: 'restore .rulegate/ from git history and run `rulegate sync` instead of `rulegate init`',
      })
    : new RulegateError({
        code: 'E_NO_CANONICAL_SOURCE',
        message: `${path} carries agent-os's generated-file banner: it is agent-os output copied back into agent-os's own source, and importing it would import the rules it was built from a second time`,
        source: { file: path },
        hint: `replace ${path} with the file it was generated from, or delete it, then run \`rulegate init\` again`,
      });
}

const stringList = (v: unknown): boolean =>
  Array.isArray(v) && v.every((e) => typeof e === 'string');

/**
 * Every key `.claude/rulegate.json` has, in the plugin's documented order, with the type it
 * reads. agent-os 0.6.0 itself has only the first two; the others are carried too, because
 * a key the plugin reads is not one to report as "no such setting".
 */
const PLUGIN_SETTINGS: Readonly<Record<string, (v: unknown) => boolean>> = {
  features: stringList,
  cartographerReminder: (v) => typeof v === 'boolean',
  handoff: stringList,
  activeTask: stringList,
};

/**
 * `.agent-os/config.json`'s `claude` block, as the `.claude/rulegate.json` it becomes.
 *
 * Printed, never written (decision P1): that file is the Rulegate plugin's own settings,
 * the CLI never reads it, and its existence is how the plugin tells a project that has run
 * `/rulegate:init` from one that has not — so `rulegate init` creating it would mark a
 * project set up before its setup ran. `/rulegate:init` writes it inside Claude Code; the
 * note carries the exact payload so it can also be written by hand.
 */
function claudeNote(block: unknown): Note {
  const payload: Record<string, JsonValue> = {};
  const dropped: string[] = [];
  if (isRecord(block)) {
    for (const [key, value] of Object.entries(block)) {
      // Own keys only: a config key named `toString` must not reach Object.prototype.
      const accepts = Object.hasOwn(PLUGIN_SETTINGS, key) ? PLUGIN_SETTINGS[key] : undefined;
      if (accepts?.(value) === true) payload[key] = value as JsonValue;
      else dropped.push(key);
    }
  }
  // In the order the plugin documents the file, whatever order the config used.
  const ordered: Record<string, JsonValue> = {};
  for (const key of Object.keys(PLUGIN_SETTINGS)) {
    if (key in payload) ordered[key] = payload[key]!;
  }

  const parts = [
    '`claude` holds settings for the Rulegate plugin for Claude Code, which reads them from .claude/rulegate.json, not from .rulegate/.',
  ];
  if (Object.keys(ordered).length > 0) {
    parts.push(
      `\`rulegate init\` does not write that file; /rulegate:init does, inside Claude Code, or create it with:\n${JSON.stringify(ordered, null, 2)}`,
    );
  }
  if (!isRecord(block)) parts.push('It is not a JSON object, so nothing in it was carried.');
  else if (dropped.length > 0) {
    parts.push(
      `Not carried, because the plugin has no such setting or the value has the wrong type: ${dropped.map((k) => `\`${k}\``).join(', ')}.`,
    );
  }
  return { path: CONFIG, message: parts.join(' ') };
}

async function readConfig(
  ctx: AdapterContext,
  notes: Note[],
): Promise<{ targets: readonly string[] }> {
  const contents = await ctx.fs.tryReadFile(CONFIG);
  // agent-os's own default when the file is absent.
  if (contents === undefined) return { targets: [] };

  let config: unknown;
  try {
    config = JSON.parse(contents) as unknown;
  } catch {
    notes.push({
      path: CONFIG,
      message:
        'not valid JSON, so its `targets` could not be read; enable tools in .rulegate/rulegate.yaml by hand',
    });
    return { targets: [] };
  }
  if (!isRecord(config)) return { targets: [] };

  const targets = Array.isArray(config['targets'])
    ? config['targets'].filter((t): t is string => typeof t === 'string')
    : [];
  if (config['targets'] !== undefined && !Array.isArray(config['targets'])) {
    notes.push({
      path: CONFIG,
      message: '`targets` is not a list, so no tool was enabled from it',
    });
  }
  if (config['claude'] !== undefined) notes.push(claudeNote(config['claude']));

  const other = Object.keys(config).filter((k) => k !== 'targets' && k !== 'claude');
  if (other.length > 0) {
    notes.push({
      path: CONFIG,
      message: `${other.map((k) => `\`${k}\``).join(', ')} ${other.length === 1 ? 'is' : 'are'} not an agent-os 0.6.0 setting Rulegate knows, and ${other.length === 1 ? 'was' : 'were'} not carried`,
    });
  }
  return { targets };
}

/**
 * agent-os's own fence, from `parseFrontmatter` in its `src/source.mjs`: the raw file must
 * start with exactly `---\n` and hold a later `\n---\n`. Not the shared `FRONTMATTER`, which
 * also takes CRLF, a BOM (stripped by every `readFile` before a regex sees it) and a closing
 * `---` at end of file, and needs a line between the fences. On each of those the two
 * readings disagree, and the import has to mean what agent-os compiled: a CRLF rule it read
 * as unfenced went to AGENTS.md for every tool, and scoping it on migration would silently
 * stop most tools loading it.
 */
function agentOsFence(raw: string): { block: string; body: string } | undefined {
  if (!raw.startsWith('---\n')) return undefined;
  const end = raw.indexOf('\n---\n', 3);
  if (end === -1) return undefined;
  return { block: raw.slice(4, end + 1), body: raw.slice(end + 5) };
}

/** A rule as agent-os's `load` holds it: what `agentsMd` compiles from. */
interface AgentOsRule {
  readonly name: string;
  readonly description: string;
  readonly paths: readonly string[];
  readonly always: boolean;
  readonly body: string;
}

/**
 * `parseFrontmatter` and `load` from agent-os's `src/source.mjs`, line for line, for
 * rebuilding exactly the text `agentsMd` wrote. Not `readFrontmatter`, which unquotes every
 * scalar and splits an inline `[a, b]`: agent-os keeps a scalar as written, quotes and all,
 * and takes a scalar `paths:` as one literal path, so only its own reading reproduces the
 * index entry for `description: "Routing"` or `paths: [a, b]`.
 */
function agentOsRule(name: string, raw: string): AgentOsRule {
  const fence = agentOsFence(raw);
  const fields = new Map<string, string | string[]>();
  let key: string | undefined;
  for (const line of fence?.block.split('\n') ?? []) {
    const kv = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line);
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (kv !== null) {
      key = kv[1]!;
      const v = kv[2]!.trim();
      fields.set(key, v === '' ? [] : v);
    } else if (item !== null && key !== undefined) {
      const list = fields.get(key);
      const items = Array.isArray(list) ? list : [];
      items.push(item[1]!.trim().replace(/^["']|["']$/g, ''));
      fields.set(key, items);
    }
  }
  const p = fields.get('paths');
  const paths = Array.isArray(p) ? p : p ? [p] : [];
  const description = fields.get('description');
  return {
    name,
    description: typeof description === 'string' ? description : '',
    paths,
    always: String(fields.get('always')) === 'true' || paths.length === 0,
    body: (fence === undefined ? raw : fence.body.replace(/^\n+/, '')).trim(),
  };
}

/** The index entry `agentsMd` writes for a scoped rule. */
function indexEntry(rule: AgentOsRule): string {
  return `- \`${rule.paths.join('`, `')}\` — ${rule.description || rule.name}`;
}

/** The section `agentsMd` writes for a universal rule. */
function section(rule: AgentOsRule): string {
  return `## ${rule.name}\n\n${rule.body}`;
}

/** `agentsMd` from `src/targets.mjs`, without its banner: the AGENTS.md body agent-os writes. */
function agentsMd(agents: string, rules: readonly AgentOsRule[]): string {
  const scoped = rules.filter((r) => !r.always);
  const parts = [agents, ...rules.filter((r) => r.always).map(section)];
  if (scoped.length > 0) parts.push(`${SCOPED_INDEX}\n\n${scoped.map(indexEntry).join('\n')}`);
  return parts.filter(Boolean).join('\n\n');
}

/** One `.agent-os/rules/*.md`, read with agent-os's semantics. */
function ruleFrom(
  path: string,
  contents: string,
  raw: string,
  taken: Set<string>,
  notes: Note[],
): RuleDocument {
  const fence = agentOsFence(raw);
  if (fence === undefined && FRONTMATTER.test(contents)) {
    notes.push({
      path,
      message:
        'agent-os did not read this frontmatter — it needs LF line endings, no byte-order mark and a newline after the closing `---` — so it compiled the rule for every tool with the block in its text. It is imported the same way; fix the fence in the canonical rule to scope it',
    });
  }
  const meta = readFrontmatter(fence?.block ?? '', ['paths'], 'agent-os');
  const body = (fence === undefined ? contents : fence.body.replace(/\r\n?/g, '\n')).trim();

  // agent-os: `always = always === 'true' || paths.length === 0`. An `always` rule is
  // repo-wide however many `paths` it lists — agent-os writes it to AGENTS.md and never to
  // `.claude/rules/` — so its globs are empty. The paths it named are kept, in `unknown`,
  // because an author who wrote them should find them rather than have them vanish.
  const { always, ...unknown } = meta.unknown;
  const paths = meta.lists['paths'] ?? [];
  const repoWide = always === 'true' || paths.length === 0;
  const name = path.slice(RULES_DIR.length + 1).replace(/\.md$/, '');
  // agent-os compiles a rule with neither body nor description all the same, describing it
  // by its name (`r.description || r.name`), and writes it to every target. Skipping it
  // would lose its `paths` and leave those outputs behind with nothing saying why, so it is
  // imported as agent-os rendered it.
  const description = meta.description ?? (body === '' ? name : undefined);

  return importedRule({
    id: claimRuleId(importRuleId(name, 'agent-os'), taken),
    ...(description === undefined ? {} : { description }),
    globs: repoWide ? [] : paths,
    body,
    unknown: repoWide && paths.length > 0 ? { ...unknown, paths: [...paths] } : unknown,
    source: { file: path, line: 1 },
  });
}

/**
 * Whether Gemini CLI reads AGENTS.md because agent-os made it: the `gemini-cli` target adds
 * AGENTS.md to `context.fileName`. Set by the user without that target, the alias is theirs
 * and stays.
 */
async function geminiReadsAgents(
  ctx: AdapterContext,
  targets: readonly string[],
): Promise<boolean> {
  if (!targets.includes('gemini-cli')) return false;
  const gemini = await readJson(ctx, '.gemini/settings.json');
  const context = isRecord(gemini) ? gemini['context'] : undefined;
  const fileName = isRecord(context) ? context['fileName'] : undefined;
  return (Array.isArray(fileName) ? fileName : [fileName]).includes('AGENTS.md');
}

/**
 * Where the AGENTS.md agent-os writes stands: never synced into this tree, agent-os's
 * output, or a file somebody wrote in its place.
 */
type AgentsOnDisk = 'missing' | 'output' | 'hand-written';

/**
 * The tools `.agent-os/AGENTS.md` reached, judged by the files on disk (T142).
 *
 * agent-os puts the project body into AGENTS.md and nowhere else, so imported unscoped it
 * would reach Claude Code through a generated CLAUDE.md for the first time — ahead of the
 * CLAUDE.md somebody wrote. AGENTS.md is codex's artifact, and every tool that reads it
 * natively still does after the migration. Two readers do not: Gemini CLI, whose
 * agent-os-added alias the `.gemini/settings.json` note asks to remove, and Claude Code, which reads
 * AGENTS.md only while no CLAUDE.md exists and stops once Rulegate generates one. A CLAUDE.md
 * that is agent-os's compiled AGENTS.md (`claudeOutput`) carried the body to Claude Code too.
 */
async function bodyTools(
  ctx: AdapterContext,
  geminiAlias: boolean,
  claudeOutput: boolean,
  agents: AgentsOnDisk,
): Promise<{ tools: string[]; unsynced: boolean }> {
  const tools = new Set<string>(claudeOutput ? ['claude-code'] : []);
  // agent-os writes AGENTS.md on every sync, so its absence says the outputs were never
  // generated in this tree — gitignored, or a clone nobody synced — not that nothing read
  // the body. Only a hand-written AGENTS.md says that.
  const unsynced = agents === 'missing';
  if (agents !== 'hand-written') {
    tools.add('codex');
    if (geminiAlias) tools.add('gemini');
    let memory = false;
    for (const file of CLAUDE_MEMORY) memory ||= await ctx.fs.exists(file);
    if (!memory) tools.add('claude-code');
  }
  return { tools: [...tools].sort(compareCodepoint), unsynced };
}

/**
 * Whether a file is agent-os's output: past agent-os's banner, if it has one, its text is
 * the AGENTS.md body agent-os compiles from `.agent-os/`. Two files need more than the banner.
 * agent-os never writes CLAUDE.md, so a bannered one was copied by hand, and what somebody
 * added below that banner would have lasted under agent-os. And 0.5.0 wrote AGENTS.md with no
 * banner at all. Only the banner line is dropped: `mdHeader` is that line and a blank one,
 * so a comment opening the body is part of the body.
 */
function isCompiledAgents(contents: string, compiled: string): boolean {
  if (normalize(compiled) === '') return false;
  const lines = contents.replace(/^\uFEFF/, '').split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== '');
  const head = (lines[first] ?? '').trim();
  const banner = /^<!--.*-->$/.test(head) && head.includes(AGENT_OS_BANNER);
  return normalize(lines.slice(banner ? first + 1 : 0).join('\n')) === normalize(compiled);
}

/**
 * `.agent-os/AGENTS.md` as a rule scoped to the tools it reached, or nothing: the untouched
 * `agent-os init` placeholder, or a body no generated file carries, which no tool had read.
 *
 * Claimed last and placed first. The basenames of `rules/` are the ids that render to the
 * paths agent-os wrote, which is what lets `init` take those files over one for one; a
 * `rules/agents.md` must keep `agents`, and the project body, which agent-os writes to no
 * per-rule path at all, is the one that can take a suffix.
 */
async function projectBody(
  ctx: AdapterContext,
  body: string,
  geminiAlias: boolean,
  claudeOutput: boolean,
  agents: AgentsOnDisk,
  compiled: AgentOsCompiled,
  taken: Set<string>,
  notes: Note[],
): Promise<RuleDocument | undefined> {
  if (isAgentOsScaffold(body, compiled)) {
    notes.push({
      path: SOURCE_AGENTS,
      message:
        'still the placeholder `agent-os init` writes ("Replace this with what is true in every session…"), so it was not imported: it would open every tool\'s instructions with it. Write what is true in every session as a rule in .rulegate/rules/',
    });
    return undefined;
  }
  const { tools, unsynced } = await bodyTools(ctx, geminiAlias, claudeOutput, agents);
  if (tools.length === 0) {
    notes.push({
      path: SOURCE_AGENTS,
      message:
        'no file agent-os generated from it is on disk — AGENTS.md carries no agent-os banner and is not what agent-os compiles — so no tool was reading it, and it was not imported. Copy what still holds into .rulegate/rules/ by hand',
    });
    return undefined;
  }
  if (unsynced) {
    notes.push({
      path: SOURCE_AGENTS,
      message:
        'AGENTS.md, which `agent-os sync` writes from it, is not on disk, so it is scoped to the tools that would read the AGENTS.md agent-os writes',
    });
  }
  const id = claimRuleId(importRuleId('AGENTS', 'agent-os'), taken);
  notes.push({
    path: SOURCE_AGENTS,
    message: `the files agent-os generated from it reach ${tools.join(', ')} and no other tool, so .rulegate/rules/${id}.md is scoped \`tools: [${tools.join(', ')}]\` to keep it there; delete that line to send it to every tool`,
  });
  const rule = importedRule({ id, body, source: { file: SOURCE_AGENTS, line: 1 } });
  return { ...rule, frontmatter: { ...rule.frontmatter, tools: { kind: 'include', tools } } };
}

async function read(ctx: AdapterContext): Promise<InteropResult> {
  const rules: RuleDocument[] = [];
  const taken = new Set<string>();
  const generated: string[] = [];
  const notImported: string[] = [];
  const notes: Note[] = [];
  const errors: RulegateError[] = [];
  // The rules as agent-os reads them, for rebuilding what `agentsMd` wrote from them.
  const compiledFrom: AgentOsRule[] = [];

  const { targets } = await readConfig(ctx, notes);
  let agentsBody: string | undefined;

  // `.agent-os/AGENTS.md` first: agent-os puts it at the top of the AGENTS.md it builds, and
  // array position becomes canonical order. Then `rules/` one level deep, codepoint-sorted by
  // `glob` — agent-os reads that directory with a non-recursive `readdirSync`.
  const sources = [SOURCE_AGENTS, ...(await ctx.fs.glob(`${RULES_DIR}/*.md`))];
  for (const path of sources) {
    const contents = await ctx.fs.tryReadFile(path);
    if (contents === undefined) continue;

    // Refused, not cleaned: stripping the banner and importing the rest is exactly the T113
    // failure, a rendering promoted to a source.
    const by = derivedFrom(contents);
    if (by !== undefined) {
      errors.push(derivedSource(path, by));
      continue;
    }

    if (path === SOURCE_AGENTS) {
      agentsBody = contents.trim();
      continue;
    }
    // Decoded with its BOM kept, as agent-os's `readFileSync(..., 'utf8')` reads it.
    const raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(
      await ctx.fs.readFileRaw(path),
    );
    rules.push(ruleFrom(path, contents, raw, taken, notes));
    compiledFrom.push(agentOsRule(path.slice(RULES_DIR.length + 1).replace(/\.md$/, ''), raw));
  }
  const geminiAlias = await geminiReadsAgents(ctx, targets);

  const compiledAgents = agentsMd(agentsBody ?? '', compiledFrom);
  const agentsFile = await ctx.fs.tryReadFile('AGENTS.md');
  let agents: AgentsOnDisk = 'hand-written';
  if (agentsFile === undefined) agents = 'missing';
  else if (derivedFrom(agentsFile) === 'agent-os') agents = 'output';
  else if (derivedFrom(agentsFile) === undefined && isCompiledAgents(agentsFile, compiledAgents)) {
    // 0.5.0's unbannered AGENTS.md; a bannered one is masked with the other outputs below.
    agents = 'output';
    generated.push('AGENTS.md');
  }

  const claude = await ctx.fs.tryReadFile('CLAUDE.md');
  let claudeOutput = false;
  if (claude !== undefined && derivedFrom(claude) === 'agent-os') {
    claudeOutput = isCompiledAgents(claude, compiledAgents);
    if (claudeOutput) generated.push('CLAUDE.md');
    else {
      notes.push({
        path: 'CLAUDE.md',
        message:
          "carries agent-os's banner, but agent-os never writes CLAUDE.md and this is not what agent-os compiles from .agent-os/, so it is imported as the hand-written file it is, agent-os's banner and text included: keep only what was added to it",
      });
    }
  }

  if (agentsBody !== undefined && agentsBody !== '') {
    const compiled: AgentOsCompiled = {
      sections: new Set(compiledFrom.filter((r) => r.always).map((r) => normalize(section(r)))),
      entries: new Set(compiledFrom.filter((r) => !r.always).map((r) => normalize(indexEntry(r)))),
    };
    const rule = await projectBody(
      ctx,
      agentsBody,
      geminiAlias,
      claudeOutput,
      agents,
      compiled,
      taken,
      notes,
    );
    if (rule !== undefined) rules.unshift(rule);
  }

  const flat = new Set(sources);
  for (const path of await ctx.fs.glob(`${RULES_DIR}/**/*.md`)) {
    if (flat.has(path)) continue;
    notes.push({
      path,
      message:
        'agent-os reads .agent-os/rules/ one level deep and never loaded this file, so it was not imported either',
    });
  }

  const tools = new Set(['codex']);
  for (const target of targets) {
    const tool = TARGET_TO_TOOL[target];
    if (tool !== undefined) tools.add(tool);
    else {
      notes.push({
        path: CONFIG,
        message: `target \`${target}\` names no tool Rulegate generates for, so it was not enabled`,
      });
    }
  }

  // By files, not by the directory: `agent-os init` creates an empty `skills/`, and git does
  // not track an empty directory, so a check on it would answer differently in a fresh clone.
  if ((await ctx.fs.glob(`${SKILLS_DIR}/**/*`)).length > 0) {
    notImported.push(SKILLS_DIR);
    const copies: string[] = [];
    for (const skill of await ctx.fs.glob(`${SKILLS_DIR}/*/SKILL.md`)) {
      const name = skill.slice(SKILLS_DIR.length + 1, -'/SKILL.md'.length);
      for (const dir of SKILL_COPIES) {
        if (await ctx.fs.exists(`${dir}/${name}`)) copies.push(`${dir}/${name}`);
      }
    }
    if (copies.length > 0) {
      notes.push({
        path: SKILLS_DIR,
        message: `agent-os copied these skills to ${copies.join(', ')}. Rulegate does not manage skills yet, so the copies stay as they are and nothing keeps them in step with ${SKILLS_DIR} any more`,
      });
    }
  }

  if (geminiAlias) {
    notes.push({
      path: '.gemini/settings.json',
      message:
        '`context.fileName` lists AGENTS.md, which agent-os adds so Gemini CLI reads its rules. Rulegate generates GEMINI.md and AGENTS.md with the same rules, so Gemini CLI would load every rule twice: remove "AGENTS.md" from that list once init has run',
    });
  }

  for (const config of INSTRUCTION_CONFIGS) {
    const parsed = await readJson(ctx, config);
    const list = isRecord(parsed) ? parsed['instructions'] : undefined;
    if (!Array.isArray(list)) continue;
    const into = list.filter(
      (e): e is string =>
        typeof e === 'string' && e.replace(/^(\.\/)+/, '').startsWith(`${AGENT_OS_DIR}/`),
    );
    if (into.length === 0) continue;
    notes.push({
      path: config,
      message: `\`instructions\` lists ${into.join(', ')}. Those are agent-os's sources, loaded beside the rules Rulegate generates, and they point at nothing once ${AGENT_OS_DIR}/ is removed: delete those entries once init has run`,
    });
  }

  for (const pattern of OUTPUTS) {
    for (const path of await ctx.fs.glob(pattern)) {
      const contents = await ctx.fs.tryReadFile(path);
      if (contents !== undefined && derivedFrom(contents) !== undefined) generated.push(path);
    }
  }

  // Every file whose text becomes a canonical rule: agent-os's sources that were imported,
  // and the CLAUDE.md and AGENTS.md the adapters import because no generator wrote them.
  const imported = new Set(rules.map((r) => r.source.file));
  const mentioned = [
    ...sources.filter((p) => imported.has(p)),
    ...(claude !== undefined && !claudeOutput && derivedFrom(claude) !== 'rulegate'
      ? ['CLAUDE.md']
      : []),
    ...(agentsFile !== undefined &&
    agents === 'hand-written' &&
    derivedFrom(agentsFile) !== 'rulegate'
      ? ['AGENTS.md']
      : []),
  ];
  for (const path of mentioned) {
    const lines = agentOsMentionLines((await ctx.fs.tryReadFile(path)) ?? '');
    if (lines.length > 0) notes.push(mentionNote(path, lines));
  }

  return { rules, generated, notImported, tools: [...tools], notes, errors };
}

export const agentOs: InteropImporter = {
  name: 'agent-os',
  displayName: 'agent-os',
  detect,
  read,
};
