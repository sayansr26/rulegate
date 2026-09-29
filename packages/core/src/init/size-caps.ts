import { RulegateError } from '../model/errors.js';
import { compareCodepoint } from '../render/order.js';
import { matchesGlob } from '../fs/glob.js';
import { byteLength, repoPattern } from '../doctor/resolve.js';
import type { Adapter } from '../adapter/adapter.js';
import type { AdapterDocs } from '../adapter/docs.js';
import type { Artifact } from '../adapter/artifact.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';
import type { ToolId } from '../model/ids.js';

/**
 * T142: a generated file `init` would grow past a cap a tool that reads it documents.
 *
 * Found on the first real migration. agent-os writes `AGENTS.md` as a short index of its
 * scoped rules; the codex adapter inlines every rule it is sent, so lmsfront's went from
 * 1 561 to 23 676 bytes — past Windsurf's 12,000 — and nothing said so until `lint` failed
 * the day after. `init` is the one command that has both sizes in hand, so it names the
 * growth, the cap and the tool before anything is written.
 *
 * Generic over `AdapterDocs`: which tool reads the file is its `files` entries matched the
 * way `doctor` matches them, and the cap is its `limits`. Every tool is asked, enabled or
 * not — the file is shared, and Windsurf reads an `AGENTS.md` it did not ask for — and the
 * message says which ones this repository will not enable, because `lint` reports those as
 * `info`. Only a *crossing* is reported: a file already over the cap is `doctor`'s and
 * `lint`'s to name, and `init` did not do that.
 */
export interface SizeCapInput {
  readonly fs: ReadOnlyFileSystem;
  readonly artifacts: readonly Artifact[];
  readonly adapters: readonly Adapter[];
  /** The tools the manifest `init` writes will enable. */
  readonly enabled: readonly ToolId[];
}

export async function sizeCapWarnings(input: SizeCapInput): Promise<readonly RulegateError[]> {
  const { fs, adapters, enabled } = input;
  const byTool = [...adapters].sort((a, b) => compareCodepoint(a.name, b.name));
  const artifacts = [...input.artifacts].sort((a, b) => compareCodepoint(a.path, b.path));
  const out: RulegateError[] = [];

  for (const artifact of artifacts) {
    const after = byteLength(artifact.contents);
    // `tryReadFile` is EOL-normalized and BOM-stripped, as `contents` is, so a CRLF
    // checkout of the same file measures what an LF one does.
    const existing = await fs.tryReadFile(artifact.path);
    const before = existing === undefined ? undefined : byteLength(existing);

    const crossed: { readonly tool: Adapter; readonly cap: string }[] = [];
    for (const tool of byTool) {
      const cap = crossedCap(tool.docs, artifact.path, before, after);
      if (cap !== undefined) crossed.push({ tool, cap });
    }
    if (crossed.length === 0) continue;

    const size =
      before === undefined
        ? `${artifact.path} will be ${String(after)} bytes`
        : `${artifact.path} grows from ${String(before)} to ${String(after)} bytes`;
    const unused = crossed.filter((c) => !enabled.includes(c.tool.name));
    const caps = crossed.map((c) => `the ${c.cap} ${c.tool.docs.toolName} documents`);
    const note =
      unused.length === 0
        ? ''
        : ` ${names(unused.map((c) => c.tool.docs.toolName))} ${unused.length === 1 ? 'is' : 'are'} not enabled here, so \`rulegate lint\` reports it as info.`;
    const rules = artifact.provenance?.ruleIds.length ?? 0;

    out.push(
      new RulegateError({
        code: 'W_SIZE_CAP_CROSSED',
        message: `${size}, past ${names(caps)}: content past the cap may be silently dropped.${note}`,
        source: { file: artifact.path },
        hint:
          `${artifact.path} is generated for ${artifact.adapter}` +
          (rules === 0 ? '' : ` from ${String(rules)} ${rules === 1 ? 'rule' : 'rules'}`) +
          `; to keep it under the cap, narrow \`tools:\` on the rules it carries so ${artifact.adapter} does not inline them`,
      }),
    );
  }
  return out;
}

/**
 * The lowest cap this tool documents that the file crosses, described; or `undefined`.
 *
 * A total cap counts too when the file alone passes it — the tool loads at least this
 * file, so its total is over whatever else it loads. Strictly `>`, as `doctor` compares: a
 * file exactly at a cap is under it.
 */
function crossedCap(
  docs: AdapterDocs,
  path: string,
  before: number | undefined,
  after: number,
): string | undefined {
  const limits = docs.limits;
  if (limits === undefined) return undefined;
  const reads = docs.files.some(
    (e) => e.role === 'instructions' && e.scope !== 'global' && matchesGlob(path, repoPattern(e)),
  );
  if (!reads) return undefined;

  const caps: { readonly bytes: number; readonly label: string }[] = [];
  if (limits.maxBytesPerFile !== undefined) {
    caps.push({ bytes: limits.maxBytesPerFile, label: 'per-file limit' });
  }
  if (limits.maxTotalBytes !== undefined) {
    caps.push({ bytes: limits.maxTotalBytes, label: 'total limit' });
  }
  const hit = caps
    .filter((c) => after > c.bytes && (before === undefined || before <= c.bytes))
    .sort((a, b) => a.bytes - b.bytes)[0];
  return hit === undefined ? undefined : `${String(hit.bytes)}-byte ${hit.label}`;
}

/** `a`, `a and b`, `a, b and c` — in the order given, which the caller has sorted. */
function names(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}
