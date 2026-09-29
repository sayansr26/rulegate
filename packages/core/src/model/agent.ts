import type { JsonValue, SourceRef } from './ids.js';
import type { ToolSelector } from './selector.js';

/**
 * A canonical subagent (RFC-0001 §14, T054): `.rulegate/agents/<name>.md`, a named agent
 * with its own prompt that a tool can hand work to.
 *
 * Most tools read the same shape — Markdown with YAML frontmatter, `name` and `description`,
 * the body as the agent's prompt — and several read one another's folders, so placement is
 * the skills problem and formats are the commands problem. Both are adapter data.
 */
export interface Agent {
  /** The file name without `.md`, which `name` must equal. */
  readonly id: string;
  /** Repo-relative POSIX path of the `.md` file. */
  readonly path: string;
  readonly name: string;
  readonly description: string;
  /**
   * Which adapters receive the agent, from the `adapters` key. Not `tools`: in an agent file
   * `tools` is the agent's own tool allowlist, as every tool that reads Claude's format writes
   * it. Never rendered.
   */
  readonly adapters: ToolSelector;
  /** Every frontmatter key in authored order, `adapters` included (see `Skill.frontmatter`). */
  readonly frontmatter: readonly (readonly [string, JsonValue])[];
  /** The agent's prompt, normalised exactly like `RuleDocument.body`. */
  readonly body: string;
  readonly source: SourceRef;
}

export { SKILL_ID_PATTERN as AGENT_ID_PATTERN } from './skill.js';

/**
 * Keys that **narrow** what an agent may do, in Claude Code's spelling. A tool that cannot
 * carry one is not given the agent at all: dropping a restriction would hand the agent more
 * power than its author wrote (RFC-0001 §14.2).
 */
export const AGENT_RESTRICTIONS: readonly string[] = ['tools', 'disallowedTools'];
