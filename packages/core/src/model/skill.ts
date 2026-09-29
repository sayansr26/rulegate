import type { JsonValue, SourceRef } from './ids.js';
import type { ToolSelector } from './selector.js';

/**
 * A canonical skill (RFC-0001 §12, T051): `.rulegate/skills/<id>/`, holding a `SKILL.md`
 * and any other files.
 *
 * A canonical skill is a valid Agent Skill (agentskills.io) before Rulegate touches it —
 * every tool that supports skills reads that one directory format, and they differ only in
 * extra frontmatter and in which directory they read.
 */
export interface Skill {
  /** The directory name, which the Agent Skills spec requires `name` to equal. */
  readonly id: string;
  /** Repo-relative POSIX path of the skill directory. */
  readonly path: string;
  readonly name: string;
  readonly description: string;
  /** Which adapters receive the skill. Parsed from the `tools` key, which is never rendered. */
  readonly tools: ToolSelector;
  /**
   * Every frontmatter key in authored order, `tools` included — the Agent Skills fields and
   * each tool's extensions alike.
   *
   * An ordered list rather than typed fields because the skill is re-serialised, and a
   * serialiser that re-orders keys or drops one it has no field for costs a user content on
   * a round trip. Typed accessors for the fields Rulegate validates are above; adapters
   * decide per key what their tool reads (§12.2).
   */
  readonly frontmatter: readonly (readonly [string, JsonValue])[];
  /** Markdown body, normalised exactly like `RuleDocument.body`. */
  readonly body: string;
  /** Every file but `SKILL.md`, sorted by path. */
  readonly assets: readonly SkillAsset[];
  readonly source: SourceRef;
}

/**
 * A file shipped with a skill, carried as **raw bytes**: never decoded, EOL-normalised or
 * BOM-stripped. A PNG or a CRLF script must come out byte-identical, and every text path in
 * Rulegate normalises (`Artifact.contents`, `hashContents`), so an asset never takes one.
 */
export interface SkillAsset {
  /** Relative to the skill directory, POSIX. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** The Agent Skills name rule: 1–64 of `a-z`, `0-9`, `-`, no leading, trailing or double `-`. */
export const SKILL_ID_PATTERN = /^(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/;

/** Agent Skills limits, in characters. */
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_COMPATIBILITY_MAX = 500;
