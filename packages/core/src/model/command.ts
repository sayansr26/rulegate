import type { JsonValue, SourceRef } from './ids.js';
import type { ToolSelector } from './selector.js';

/**
 * A canonical command (RFC-0001 §13, T053): `.rulegate/commands/<id>.md`, a prompt a user
 * invokes as `/<id>`.
 *
 * Unlike a skill there is no shared format to be a valid instance of: every tool spells the
 * file, the folder and the argument placeholder its own way. So the canonical form is the
 * common core — Markdown, a `description`, one `$ARGUMENTS` placeholder — and each tool's
 * spelling is data in its adapter's `docs.commands`.
 */
export interface Command {
  /** The file name without `.md`, which is the `/name` every tool derives. */
  readonly id: string;
  /** Repo-relative POSIX path of the `.md` file. */
  readonly path: string;
  readonly description: string;
  /** Which adapters receive the command. Parsed from the `tools` key, which is never rendered. */
  readonly tools: ToolSelector;
  /**
   * Every frontmatter key in authored order, `tools` included. Ordered entries rather than
   * typed fields for the reason `Skill.frontmatter` gives: a round trip must move nothing.
   */
  readonly frontmatter: readonly (readonly [string, JsonValue])[];
  /** Markdown body, normalised exactly like `RuleDocument.body`. */
  readonly body: string;
  readonly source: SourceRef;
}

/** The same rule as a skill's name: every tool turns the file name into `/<id>`. */
export { SKILL_ID_PATTERN as COMMAND_ID_PATTERN } from './skill.js';

/** The one canonical argument placeholder: the whole argument string, as typed. */
export const ARGUMENTS_PLACEHOLDER = '$ARGUMENTS';

/**
 * `$ARGUMENTS` as a whole token — not `$ARGUMENTS[0]`, which is positional, and not the
 * start of a longer name.
 */
export const ARGUMENTS_TOKEN = /\$ARGUMENTS(?![\w[])/g;

/**
 * A positional placeholder: `$0`–`$9` or `$ARGUMENTS[N]`. They are not portable — Claude
 * Code counts from `$0` and OpenCode from `$1`, so `$1` is a different argument in each —
 * which is why the parser refuses one unless `tools:` names a single tool.
 */
export const POSITIONAL_TOKEN = /\$(?:\d|ARGUMENTS\[\d+\])/;
