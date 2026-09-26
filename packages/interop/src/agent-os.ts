import {
  MARKER_TEXT,
  RulegateError,
  claimRuleId,
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

/**
 * Which generator's banner a file carries, if any: Rulegate's or agent-os's.
 *
 * Either one makes the file derived (T120). agent-os adopted this very repository once and
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

async function read(ctx: AdapterContext): Promise<InteropResult> {
  const rules: RuleDocument[] = [];
  const taken = new Set<string>();
  const generated: string[] = [];
  const notImported: string[] = [];
  const notes: Note[] = [];
  const errors: RulegateError[] = [];

  const { targets } = await readConfig(ctx, notes);
  let agentsBody: string | undefined;

  // `.agent-os/AGENTS.md` first: agent-os puts it at the top of the AGENTS.md it builds, and
  // array position becomes canonical order. Then `rules/` one level deep, codepoint-sorted by
  // `glob` — agent-os reads that directory with a non-recursive `readdirSync`.
  const sources = [SOURCE_AGENTS, ...(await ctx.fs.glob(`${RULES_DIR}/*.md`))];
  for (const path of sources) {
    const contents = await ctx.fs.tryReadFile(path);
    if (contents === undefined) continue;

    // Refused, not cleaned: stripping the banner and importing the rest is exactly the T120
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
  }
  // Claimed last and placed first. The basenames of `rules/` are the ids that render to the
  // paths agent-os wrote, which is what lets `init` take those files over one for one; a
  // `rules/agents.md` must keep `agents`, and the project body, which agent-os writes to no
  // per-rule path at all, is the one that can take a suffix.
  if (agentsBody !== undefined && agentsBody !== '') {
    rules.unshift(
      importedRule({
        id: claimRuleId(importRuleId('AGENTS', 'agent-os'), taken),
        body: agentsBody,
        source: { file: SOURCE_AGENTS, line: 1 },
      }),
    );
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

  const gemini = await readJson(ctx, '.gemini/settings.json');
  const context = isRecord(gemini) ? gemini['context'] : undefined;
  const fileName = isRecord(context) ? context['fileName'] : undefined;
  const names = Array.isArray(fileName) ? fileName : [fileName];
  if (targets.includes('gemini-cli') && names.includes('AGENTS.md')) {
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

  return { rules, generated, notImported, tools: [...tools], notes, errors };
}

export const agentOs: InteropImporter = {
  name: 'agent-os',
  displayName: 'agent-os',
  detect,
  read,
};
