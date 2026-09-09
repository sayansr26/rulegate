export const RULEGATE_DIR = '.rulegate';
export const MANIFEST_PATH = `${RULEGATE_DIR}/rulegate.yaml`;
export const RULES_DIR = `${RULEGATE_DIR}/rules`;
export const RULES_GLOB = `${RULES_DIR}/**/*.md`;
export const MCP_DIR = `${RULEGATE_DIR}/mcp`;
export const MCP_SERVERS_PATH = `${MCP_DIR}/servers.yaml`;
export const STATE_PATH = `${RULEGATE_DIR}/state.json`;
export const BACKUP_DIR = `${RULEGATE_DIR}/backup`;
export const AGENTS_MD = 'AGENTS.md';

/**
 * `.rulegate/rules/frontend/react.md` -> `frontend/react`.
 *
 * NFC normalization is not cosmetic. macOS returns decomposed (NFD) filenames while
 * Linux returns composed (NFC), so a rule named `café.md` would otherwise carry a
 * different id on each platform — and since ids break ordering ties, the same repo
 * would render different bytes on macOS and Linux CI. That is the NFR4 failure mode
 * that stays invisible until the cross-platform matrix goes red.
 */
export function deriveRuleId(relPath: string): string {
  // The prefix is stripped wherever it appears, not only at the start, so a rule id is
  // relative to **its own level**: `packages/a/.rulegate/rules/10-style.md` is `10-style`,
  // the same id the root's `10-style` carries. That is what lets a nested source override
  // an inherited rule (T061) — an id that embedded the package path could never collide
  // with the rule it is meant to replace, and inheritance would silently accumulate two.
  const marker = `${RULES_DIR}/`;
  const idx = relPath.lastIndexOf(marker);
  const withoutPrefix = idx === -1 ? relPath : relPath.slice(idx + marker.length);
  return withoutPrefix.replace(/\\/g, '/').replace(/\.md$/i, '').normalize('NFC');
}

export function ruleIdToPath(id: string): string {
  return `${RULES_DIR}/${id}.md`;
}
