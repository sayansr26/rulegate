import { formatSourceRef, type SourceRef } from './ids.js';

export type RulegateErrorCode =
  | 'E_NO_CANONICAL_SOURCE'
  | 'E_YAML_SYNTAX'
  | 'E_MANIFEST_INVALID'
  | 'E_FRONTMATTER_INVALID'
  | 'E_FRONTMATTER_UNTERMINATED'
  | 'E_RULE_ID_CONFLICT'
  // A skill directory that is not a valid Agent Skill, or one Rulegate cannot carry (T051):
  // a missing `SKILL.md`, an id or `name` breaking the spec, a nested skill, a symlink.
  | 'E_SKILL_INVALID'
  // A tool will load a skill twice, from two directories it reads, or loads one its `tools:`
  // leaves out (T052). A warning: nothing is wrong on disk, and the fix is the user's choice.
  | 'W_SKILL_LOAD'
  // A skill's frontmatter key that no tool reading a directory understands was left out of
  // that directory's copy (T052). Said rather than done silently (RFC-0001 §12.2).
  | 'W_SKILL_FIELD_DROPPED'
  // Skills in a nested `.rulegate/` are not rendered yet (T052): only Claude Code and Codex
  // document how nested skill directories resolve.
  | 'W_SKILL_NESTED'
  // A tool's skill `init` could not import as-is — invalid as an Agent Skill, or a copy that
  // differs from the one imported under the same name (T052). It is left where it is.
  | 'W_SKILL_IMPORT'
  // A command file Rulegate cannot render for every tool it selects (T053): no frontmatter or
  // `description`, a name no tool accepts, a folder, or a positional placeholder (`$1`) that
  // means a different argument in different tools.
  | 'E_COMMAND_INVALID'
  // A command uses `$ARGUMENTS` and a tool it selects documents no argument syntax, so that
  // tool does not get it (T053).
  | 'W_COMMAND_ARGUMENTS'
  // A command's frontmatter key a tool does not read was left out of its copy (T053).
  | 'W_COMMAND_FIELD_DROPPED'
  // A rendered command is longer than a tool's documented per-file cap (T053).
  | 'W_COMMAND_OVER_LIMIT'
  // A command and a skill share a name in a tool that has both, so two answer `/<name>` (T053).
  | 'W_COMMAND_SHADOWED'
  // Commands in a nested `.rulegate/` are not rendered yet (T053), as for skills.
  | 'W_COMMAND_NESTED'
  // A tool's command `init` could not import as-is — invalid here, or a copy that differs from
  // the one imported under the same name (T053). It is left where it is.
  | 'W_COMMAND_IMPORT'
  | 'E_UNKNOWN_TOOL'
  | 'E_ARTIFACT_PATH_CONFLICT'
  | 'E_ARTIFACT_OVERWRITES_SOURCE'
  | 'E_PATH_ESCAPE'
  | 'E_STATE_INVALID'
  | 'E_HAND_EDITED'
  // A deletion was proposed for a path `state.json` does not record as ours. Unreachable
  // from `compareToDisk`, whose orphan set is built from state — it guards the one place
  // where being wrong means destroying somebody else's file (T020).
  | 'E_DELETE_UNRECORDED'
  // A formatter and a generator both claim a generated file. Raised as a warning by
  // `init` (T066): reformatting generated output makes the next `sync` report it as
  // hand-edited and refuse to write it, which reads as Rulegate being broken.
  | 'E_FORMATTER_CONFLICT'
  // `rulegate adapter new` refused rather than overwrite a path that already exists, or
  // patch one that does not (T028).
  | 'E_SCAFFOLD_CONFLICT'
  // `check --staged` needed the git index, and git could not answer. Two codes rather
  // than one: not being in a git working tree at all is a different situation from a
  // file that is simply not staged, and only the first is worth a hint about `--staged`.
  | 'E_GIT_UNAVAILABLE'
  | 'E_GIT_NOT_STAGED'
  | 'E_GIT_FAILED'
  | 'E_ADAPTER_FAILED'
  | 'E_ADAPTER_API_VERSION'
  // `.rulegate/mcp/servers.yaml` does not describe a server Rulegate can render (T035).
  | 'E_MCP_INVALID'
  // A value that should be an `env:` reference is a literal (T036). Its own code because
  // it is the one parse failure whose *message must not quote the offending value*.
  | 'E_LITERAL_SECRET'
  // A canonical MCP server is valid, and the target format has no way to say it (T039).
  //
  // **No longer raised by the Codex writer (T041)** — that path omits the server and names
  // it in the generated file instead, because failing the run took down every other
  // artifact too. The code stays: it is the right answer for a target that cannot degrade
  // at all, and removing it would make the next such case reach for something weaker.
  //
  // Distinct from `E_MCP_INVALID`, which means the *author* wrote something wrong. Here
  // the canonical file is correct and one destination cannot express it — Codex has no
  // variable substitution at all, so an `env:` reference under a key it cannot map is
  // inexpressible there and expressible everywhere else. Raised only where the loss would
  // be silent and wrong (a credential that never arrives); a loss that is merely lossy and
  // still functional, such as `transport: sse` on a target with no discriminator, is a
  // `warn` note in the adapter's `docs` instead.
  | 'E_MCP_UNREPRESENTABLE'
  // Something in somebody else's MCP config was not imported (T040). A **warning**, and
  // deliberately not an error: `runInit` writes nothing while `errors` is non-empty, so an
  // error here would make a new user's first command fail on a file Rulegate only read —
  // T071's shape. The server is absent from canonical and the reason is printed.
  | 'W_MCP_IMPORT'
  // The platform refused a path — Windows' 260-character limit, in practice (T063). Its own
  // code because the bare errno names no limit and suggests no action, and because it makes
  // `check` fail on one platform and pass on another for the same repository.
  | 'E_PATH_TOO_LONG'
  // A competing rule-sync tool held something Rulegate imports rules but not everything
  // from — MCP, skills, subagents (T048). A warning: `init` completes, and the user is told
  // what did not come across rather than discovering it when a server stops working.
  | 'W_INTEROP_NOT_IMPORTED'
  // Taking ownership of a file that holds a literal credential copies it verbatim into
  // `.rulegate/backup/`, and `.rulegate/` is the canonical source users are told to commit
  // (T087). A **warning**, not an error: the copy is what makes `restore` faithful, the
  // credential was already on disk, and refusing to onboard a repository over its own
  // existing file would be T071's shape again. Reported only when `.gitignore` does not
  // already cover the backup, so a repository that is fine hears nothing.
  | 'W_BACKUP_SECRET'
  // A nested level redefines a rule id, for a tool that merges nested files rather than
  // overriding them (T056). A warning: it is a correct permanent property of Gemini, Roo
  // Code and Windsurf, not a repository defect, and `check` owns exit 1 for drift alone.
  // Silence is the only wrong answer — the tool loads both texts and no byte comparison
  // anywhere can see the contradiction.
  | 'W_NESTED_MERGE_CONFLICT'
  // `init` imported a file that `sync` will not write back to the same path — an unscoped
  // or nested `.claude/rules` file, a filename that slugs differently, Cursor's legacy
  // `.cursorrules` (T102). A warning: the import is complete and correct, but the original
  // stays on disk, unowned, and every tool that still reads it gets its rules twice. Nothing
  // later can see it — `check` compares only what Rulegate owns, and `doctor`'s duplicate
  // count keys on provenance the original never had — so `init` is the one place to say so.
  | 'W_IMPORT_LEFT_BEHIND'
  // A competing tool's generated file that no enabled adapter renders back to the same path
  // (T105) — masked from the import because its source was imported instead, then left on
  // disk. A warning: the rules are in canonical, but the file is not in `state.json`, so
  // Rulegate can neither own nor delete it, and the tool that reads it keeps loading a copy
  // nothing updates. `init` is the only command that knows the file was derived at all.
  | 'W_INTEROP_OUTPUT_LEFT'
  // A generated file `init` would grow past a byte cap a tool that reads it documents in
  // `AdapterDocs.limits` (T142) — codex inlining every scoped rule into an `AGENTS.md` that
  // Windsurf caps at 12,000. A warning: the plan is correct and may be what the user wants,
  // but the growth happens on a file they did not ask to change, and `init` is the one
  // command that knows its size before and after.
  | 'W_SIZE_CAP_CROSSED'
  // A file already on disk where `init` renders, that no adapter imported from and no
  // competing tool generated (T124) — OpenCode's `.opencode/opencode.json` holding settings,
  // an unlisted `.opencode/rules/<id>.md` an imported rule's name lands on. A warning: `init`
  // backs it up before replacing it, so nothing is lost, but none of its content came across
  // to `.rulegate/` either, and a replacement the dry run never named is the silent kind.
  | 'W_INIT_NOT_IMPORTED'
  // The `.rulegate/` `init` would write does not render what it imported (T115): a file
  // that does not parse back, or a generated file whose content changed on the trip. Always
  // Rulegate's bug, and an error so that nothing is written: applying would take ownership
  // of the user's files with content that is not theirs, and the next `check` would fail.
  | 'E_INIT_CANONICAL_MISMATCH'
  // A canonical file already in `.rulegate/`, with no manifest beside it, that `init` would
  // overwrite or that `check` would read beside what `init` writes. Refused: it is the
  // user's hand-written source, which `init` has no backup path for, and planning around it
  // renders a repository the first `check` reports as drifted.
  | 'E_INIT_CANONICAL_EXISTS'
  // A path `init` would generate a file at is a directory, or lies beneath a file (T148): a
  // `.rules/` directory enables Zed and a legacy `.clinerules` file enables Cline, and both
  // adapters render onto that very path. Refused by name before anything is written, where it
  // otherwise surfaced as a bare EISDIR or ENOTDIR.
  | 'E_INIT_NOT_A_FILE';

export interface RulegateErrorInit {
  readonly code: RulegateErrorCode;
  readonly message: string;
  readonly source?: SourceRef;
  /** One actionable sentence, rendered on its own line as "hint: ...". */
  readonly hint?: string;
  readonly cause?: unknown;
}

/**
 * Every user-facing failure. Carries the file, line, and offending field so that a
 * malformed config produces an actionable message rather than a stack trace.
 */
export class RulegateError extends Error {
  readonly code: RulegateErrorCode;
  readonly source: SourceRef | undefined;
  readonly hint: string | undefined;

  constructor(init: RulegateErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'RulegateError';
    this.code = init.code;
    this.source = init.source;
    this.hint = init.hint;
  }

  /** e.g. `.rulegate/rules/style.md:4:8  E_FRONTMATTER_INVALID  ...` plus a hint line. */
  format(): string {
    const where = this.source ? formatSourceRef(this.source) : '';
    const head = [where, this.code, this.message].filter((p) => p !== '').join('  ');
    return this.hint === undefined ? head : `${head}\n  hint: ${this.hint}`;
  }
}

export function isRulegateError(e: unknown): e is RulegateError {
  return e instanceof RulegateError;
}
