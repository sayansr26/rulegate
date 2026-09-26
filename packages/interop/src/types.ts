import type { AdapterContext, RulegateError, RuleDocument } from '@rulegate/adapter-kit';

/**
 * A read-only importer for a *competing* rule-sync tool.
 *
 * **Deliberately not an `Adapter`, and never in `ADAPTERS`.** An adapter is a thing
 * Rulegate generates for; ruler and rulesync are things it takes over *from*. Registering
 * one would put `ruler` in `rulegate.yaml`'s tool list, in `doctor`'s table, and in the
 * `tools:` selector every rule is divided by — asserting that Rulegate maintains a ruler
 * config, which it must never do. Interop is one-way by construction: there is no `write`
 * on this interface, so there is nothing to call.
 *
 * The shape is otherwise an adapter's, so both live behind the same `AdapterContext` and
 * inherit its guarantees — a filesystem sandboxed to the repository, and no writer at all.
 */
export interface InteropImporter {
  /** For messages only. Never a `ToolId`: these do not join the tool set. */
  readonly name: string;
  readonly displayName: string;
  /** Present in this repository? */
  detect(ctx: AdapterContext): Promise<boolean>;
  read(ctx: AdapterContext): Promise<InteropResult>;
}

export interface InteropResult {
  readonly rules: readonly RuleDocument[];
  /**
   * Paths this tool **generates**, observed rather than assumed.
   *
   * This is the field that makes interop work at all. ruler and rulesync produce the very
   * files Rulegate's adapters import from — `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*` —
   * so importing both sides writes every rule twice: once from the source of truth and once
   * from its own generated output. These paths are hidden from the adapter pass.
   *
   * Reported per-file rather than as a fixed list, because only the importer can tell which
   * outputs a given repository's config actually produces.
   */
  readonly generated: readonly string[];
  /**
   * What was found and deliberately not imported — MCP servers, skills, subagents.
   *
   * Printed by `init`. Silence here would be the quiet loss this project refuses everywhere
   * else: a user migrating from ruler needs to know their `ruler.toml` MCP block did not
   * come across, not to discover it when a server stops working.
   */
  readonly notImported: readonly string[];
  /**
   * Rulegate tool ids the other tool was configured to generate for (T113).
   *
   * A repository's detected tools are only what is on disk today; a config naming its
   * targets is the user's own statement of which tools they use, and dropping it would
   * leave `rulegate.yaml` enabling fewer tools than the setup it replaces. Filtered by
   * `computeInitPlan` against the adapters this build has, so a name no adapter answers to
   * never reaches the manifest. Optional, so ruler and rulesync are unchanged.
   */
  readonly tools?: readonly string[];
  /**
   * Findings that need more than "copy it across by hand" — a setting with a new home, a
   * config left pointing at a directory the migration makes removable. Printed by `init`
   * with its own message, under the same code as `notImported`.
   */
  readonly notes?: readonly { readonly path: string; readonly message: string }[];
  /**
   * Reasons the import cannot go ahead at all (T113, T120).
   *
   * A source tree built out of some generator's output has no honest import: the real
   * source is gone, and canonical made from its rendering would carry the rendering's
   * losses forward. `init` writes nothing while this is non-empty, the same gate every
   * other error goes through.
   */
  readonly errors?: readonly RulegateError[];
}
