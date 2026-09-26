import { stripJsonc, type ReadOnlyFileSystem } from '@rulegate/adapter-kit';

/**
 * The `instructions` array of an OpenCode-family config, resolved to repository files.
 *
 * A copy of the opencode adapter's module (adapters may not import each other; Kilo is an
 * OpenCode fork and reads the same `instructions` shape). A fix here belongs there too.
 *
 * Every entry the tool itself would resolve somewhere Rulegate must not look is skipped
 * with a warning, never followed:
 *
 *   - `http(s)://` — the tool fetches these at startup. Rulegate makes no network call in
 *     any code path, so a remote instruction is reported and left where it is.
 *   - `~/…`, absolute paths and anything climbing out with `..` — outside the repository,
 *     and `read()` must never look outside `ctx.repoRoot`.
 *   - `.agent-os/`, `.ruler/`, `.rulesync/` and `.rulegate/` — another importer's source
 *     tree. `packages/interop` reads the first three and the parser reads the last; an
 *     adapter that followed an `instructions` entry into one would import the same rules a
 *     second time under a different provenance, which is the duplicate `init` exists to
 *     collapse rather than create.
 *   - `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, in any directory — the instruction files
 *     codex, claude-code and gemini own, for the reason every adapter leaves another adapter's file alone.
 *   - Every file another registered adapter imports from or writes to
 *     (Cursor's `.mdc` rules, `.windsurf/rules/`, `.github/copilot-instructions.md`, …),
 *     except the caller's own. OpenCode's docs use `.cursor/rules/*.md` as an
 *     `instructions` example, and following it into `.mdc` files imports Cursor's rule a
 *     second time — unscoped, with Cursor's frontmatter left in the body, where it would
 *     drift from the copy the cursor adapter imports. The patterns are the owner's exact
 *     import globs, never its whole directory: `.claude/docs/x.md` is a file claude-code
 *     never reads, and skipping it would leave a rule OpenCode loads in no canonical source
 *     while the warning claims another adapter has it.
 *
 * All foreign checks ignore case. APFS and NTFS resolve `agents.md` to `AGENTS.md`, so an
 * exact-case check lets a differently spelled entry import codex's file under a second
 * provenance.
 *
 * A literal entry is resolved through `fs.glob` like a pattern, never `exists` +
 * `tryReadFile`. `glob` returns regular files only, by their on-disk spelling, and checks
 * a symlink's real path stays inside the repository; `exists` is a `stat`, true for a
 * directory (which `tryReadFile` then throws EISDIR on, aborting the whole import) and for
 * a link to anywhere on the machine.
 */

const FOREIGN_SOURCE_DIRS = ['.agent-os', '.ruler', '.rulesync', '.rulegate'] as const;
const FOREIGN_FILES: ReadonlySet<string> = new Set([
  'agents.md',
  'agents.override.md',
  'claude.md',
  'gemini.md',
]);

/** Kilo's built-in modes: the only `rules-<mode>` locations the kilo adapter imports. */
const KILO_MODES = '(?:code|architect|ask|debug|orchestrator)';

/**
 * Other adapters' import and output locations, matched against the lower-cased path. Kept in
 * step with each owner's `read()` globs and `docs.files` by hand — adapters may not import
 * each other, and the context carries no registry.
 *
 * `.opencode/rules/*.md` is deliberately absent. The opencode adapter imports a file there
 * only when an OpenCode config lists it, so for a Kilo config it is not foreign: listed by
 * neither, only Kilo loads it; listed by both, each imports it whole and `init` collapses
 * the byte-identical copies.
 */
const FOREIGN_ARTIFACTS: readonly { readonly owner: string; readonly pattern: RegExp }[] = [
  { owner: 'aider', pattern: /^conventions\.md$/ },
  { owner: 'antigravity', pattern: /^\.agents?\/rules\/[^/]+\.md$/ },
  { owner: 'claude-code', pattern: /^\.claude\/rules\/.+\.md$/ },
  { owner: 'claude-code', pattern: /^\.mcp\.json$/ },
  { owner: 'cline', pattern: /^\.clinerules\/[^/]+\.(?:md|txt)$/ },
  { owner: 'codex', pattern: /^\.codex\/config\.toml$/ },
  { owner: 'copilot', pattern: /^\.github\/copilot-instructions\.md$/ },
  { owner: 'copilot', pattern: /^\.github\/instructions\/.+\.instructions\.md$/ },
  { owner: 'copilot', pattern: /^\.vscode\/mcp\.json$/ },
  { owner: 'cursor', pattern: /^\.cursor\/rules\/.+\.mdc$/ },
  { owner: 'cursor', pattern: /^\.cursor\/mcp\.json$/ },
  { owner: 'cursor', pattern: /^\.cursorrules$/ },
  { owner: 'kilo', pattern: new RegExp(`^\\.kilocode/rules(?:-${KILO_MODES})?/[^/]+\\.md$`) },
  { owner: 'kilo', pattern: new RegExp(`^\\.kilocoderules(?:-${KILO_MODES})?$`) },
  { owner: 'kilo', pattern: /^(?:\.kilo\/)?kilo\.jsonc?$/ },
  { owner: 'opencode', pattern: /^(?:\.opencode\/)?opencode\.jsonc?$/ },
  { owner: 'roo-code', pattern: /^\.roo\/rules\/.+\.(?:md|txt)$/ },
  { owner: 'roo-code', pattern: /^\.roo\/mcp\.json$/ },
  { owner: 'roo-code', pattern: /^\.roorules$/ },
  { owner: 'windsurf', pattern: /^\.(?:windsurf|devin)\/rules\/.+\.md$/ },
  { owner: 'windsurf', pattern: /^\.windsurfrules$/ },
  { owner: 'zed', pattern: /^\.rules$/ },
];
const GLOB_CHARS = /[*?[\]{}]/;

export interface InstructionFile {
  /** Repo-relative POSIX path, as spelled on disk. */
  readonly path: string;
  /** The config whose `instructions` listed it first. */
  readonly config: string;
  /** The entry, as written in that config, that matched it. */
  readonly entry: string;
}

export interface ResolvedInstructions {
  /** In the order the configs list them, each path at most once. */
  readonly files: readonly InstructionFile[];
  readonly warnings: readonly string[];
}

function skipReason(entry: string, self: string): string | undefined {
  if (/^https?:\/\//i.test(entry)) {
    return 'a remote URL; the tool fetches it, and Rulegate makes no network calls';
  }
  if (entry.startsWith('~')) return 'in the home directory, outside the repository';
  if (entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry)) {
    return 'an absolute path, outside the repository';
  }
  const segments = entry.split('/');
  if (segments.includes('..')) return 'outside the repository';
  const first = segments[0]!.toLowerCase();
  if ((FOREIGN_SOURCE_DIRS as readonly string[]).includes(first)) {
    return `inside ${first}/, which another importer owns`;
  }
  // By basename, at any depth: codex, claude-code and gemini generate nested copies too.
  if (FOREIGN_FILES.has(segments[segments.length - 1]!.toLowerCase())) {
    return 'owned by another adapter';
  }
  const lower = entry.toLowerCase();
  const owner = FOREIGN_ARTIFACTS.find((f) => f.owner !== self && f.pattern.test(lower))?.owner;
  if (owner !== undefined) return `a location the ${owner} adapter imports from and writes to`;
  return undefined;
}

function normalize(entry: string): string {
  return entry
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
}

/** The string entries of `instructions`, or a warning when the file does not parse. */
function entriesOf(file: string, contents: string): { entries: string[]; warning?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(contents));
  } catch {
    return {
      entries: [],
      warning: `${file}: not valid JSON or JSONC; its instructions were not imported`,
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return { entries: [] };
  const list = (parsed as Record<string, unknown>)['instructions'];
  if (!Array.isArray(list)) return { entries: [] };
  return { entries: list.filter((e): e is string => typeof e === 'string') };
}

export async function resolveInstructions(
  fs: ReadOnlyFileSystem,
  configs: readonly string[],
  skip: (path: string) => boolean,
  /** The calling adapter's id; its own locations are not foreign to it. */
  self: string,
): Promise<ResolvedInstructions> {
  const files: InstructionFile[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];

  for (const config of configs) {
    const contents = await fs.tryReadFile(config);
    if (contents === undefined) continue;
    const { entries, warning } = entriesOf(config, contents);
    if (warning !== undefined) warnings.push(warning);

    for (const raw of entries) {
      const entry = normalize(raw);
      if (entry === '') continue;
      const reason = skipReason(entry, self);
      if (reason !== undefined) {
        warnings.push(`${config}: instruction \`${raw}\` was not imported: it is ${reason}`);
        continue;
      }

      // `glob` returns codepoint-sorted paths, never a directory walk's order.
      const matches = await fs.glob(entry);
      if (matches.length === 0 && !GLOB_CHARS.test(entry) && (await fs.exists(entry))) {
        warnings.push(
          `${config}: instruction \`${raw}\` was not imported: it is not a regular file inside the repository by that exact spelling (a directory, a link out of the repository, a different letter case, or under node_modules/ or .git/)`,
        );
        continue;
      }
      for (const path of matches) {
        // A glob can reach into a foreign tree even when its first segment does not name
        // one (`**/AGENTS.md`), so every match is checked, not only the entry.
        if (skipReason(path, self) !== undefined || skip(path) || seen.has(path)) continue;
        seen.add(path);
        files.push({ path, config, entry: raw });
      }
    }
  }

  return { files, warnings };
}
