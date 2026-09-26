import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { exists } from '../lib/read.js';
import {
  indexEntries,
  planMemoryMigration,
  sha256,
  type AgentMove,
  type FileMove,
  type MemoryPlan,
} from '../lib/migrate.js';

/**
 * The memory migration's writer (T114) — the plugin's third writer under the amended P3,
 * pinned in `invariants.test.ts` by shape. Only `src/migrate-memory.ts` imports it, so no
 * hook bundle and neither the audit nor the state script can carry its calls.
 *
 * It does what `planMemoryMigration` planned and nothing else, re-planned here rather than
 * taken from the preview. Every path comes from the plan; this module builds none. The one
 * rule it exists to keep is **never lose a map**, so the order is fixed:
 *
 *   1. create the target directories, one level at a time;
 *   2. copy each new file with `COPYFILE_EXCL` — never over something already there — and
 *      compare the copy's bytes with the planned hash;
 *   3. union `MEMORY.md`: the source index has already gone through step 2 whole, as
 *      `MEMORY.agent-os.md` (or the next free `MEMORY.agent-os.<n>.md` when an earlier
 *      merge kept other bytes there) — a union keeps index lines only, never headings,
 *      repeats or fences. The target must still be the bytes the union was built from; its
 *      original is copied to `MEMORY.md.rulegate.bak` first (or the next free
 *      `MEMORY.md.rulegate.<n>.bak` when an earlier merge's backup holds other bytes), and
 *      the new index replaces it through a `wx` sibling and a rename, keeping its mode; then
 *      every source entry is checked present;
 *   4. only then, remove the source: each file it planned, one `unlink` at a time, then its
 *      directories deepest first with `rmdir`, which fails on anything it did not plan.
 *
 * A failure anywhere before step 4 leaves the source whole, and a re-run finds the copies
 * already made identical and carries on. Nothing is deleted recursively. These are files
 * Rulegate never generated — the CLI's delete invariant is `state.json`'s, and this is a
 * rename with a verified copy in between, which is why each source file goes only after
 * its bytes are proven to be at the target.
 */
const BACKUP_SUFFIX = '.rulegate.bak';
const MAX_BACKUPS = 100;

export interface MigrationResult {
  readonly plan: MemoryPlan;
  readonly moved: readonly string[];
  readonly failed: readonly { readonly agent: string; readonly reason: string }[];
}

function verify(f: FileMove): void {
  if (sha256(readFileSync(f.dst)) !== f.sha) throw new Error(`${f.rel} did not copy exactly`);
}

/**
 * Where this merge's pre-image goes: the first backup name that is free or already holds
 * these bytes. Keeping only the first backup would leave a second merge's pre-image — an
 * entry written since the first — with no copy anywhere.
 */
function backupPath(dst: string, before: Buffer): string {
  for (let n = 1; n <= MAX_BACKUPS; n++) {
    const path = n === 1 ? `${dst}${BACKUP_SUFFIX}` : `${dst}.rulegate.${String(n)}.bak`;
    const st = lstatSync(path, { throwIfNoEntry: false });
    if (st === undefined) return path;
    if (st.isFile() && readFileSync(path).equals(before)) return path;
  }
  throw new Error(`MEMORY.md has ${String(MAX_BACKUPS)} backups already — merge by hand`);
}

/**
 * The target `MEMORY.md` replaced by `next`, backup first, never through a planted link.
 * `next` was built from the target as planned; one that changed since — a subagent's entry,
 * a pull — is refused rather than overwritten, as a source that changed is.
 */
function replaceIndex(f: FileMove, next: string): void {
  const before = readFileSync(f.dst);
  if (sha256(before) !== f.dstSha) throw new Error(`${f.rel} changed during the move`);
  const bak = backupPath(f.dst, before);
  try {
    copyFileSync(f.dst, bak, constants.COPYFILE_EXCL);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  if (!readFileSync(bak).equals(before)) throw new Error(`${f.rel} changed during the move`);
  const mode = lstatSync(f.dst).mode & 0o777;
  const tmp = `${f.dst}.${String(process.pid)}.rulegate-tmp`;
  let created = false;
  try {
    writeFileSync(tmp, next, { flag: 'wx', mode });
    created = true;
    renameSync(tmp, f.dst);
  } catch (e) {
    if (created) unlinkSync(tmp);
    throw e;
  }
}

function migrateAgent(a: AgentMove): void {
  if (!exists(a.dstDir)) mkdirSync(a.dstDir);
  for (const d of a.dirs) if (!exists(d.dst)) mkdirSync(d.dst);
  for (const f of a.files) {
    if (f.action === 'copy') {
      copyFileSync(f.src, f.dst, constants.COPYFILE_EXCL);
      verify(f);
    } else if (f.action === 'same') {
      verify(f);
    } else {
      if (f.next !== undefined) replaceIndex(f, f.next);
      const have = new Set(indexEntries(readFileSync(f.dst, 'utf8')));
      const lost = indexEntries(readFileSync(f.src, 'utf8')).filter((l) => !have.has(l));
      if (lost.length > 0)
        throw new Error(`MEMORY.md union is missing ${String(lost.length)} line(s)`);
    }
  }
  // Every file is at the target, verified. The source file must still be the bytes that
  // were copied — one edited since would lose the edit.
  for (const f of a.files) {
    if (sha256(readFileSync(f.src)) !== f.sha) throw new Error(`${f.rel} changed during the move`);
  }
  // An alias shares its source with the `MEMORY.md` entry, which unlinks it once.
  for (const f of a.files) if (f.alias !== true) unlinkSync(f.src);
  try {
    for (const d of [...a.dirs].reverse()) rmdirSync(d.src);
    rmdirSync(a.srcDir);
  } catch (e) {
    // Something was added to the source after planning. It was not copied, so it stays
    // where it is; everything that was planned is already at the target.
    if ((e as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw e;
    throw new Error(`${a.from} gained files since the plan — they are left there; re-run`);
  }
}

export async function applyMemoryMigration(
  root: string,
  claudeDir: string,
): Promise<MigrationResult> {
  const plan = await planMemoryMigration(root, claudeDir);
  const moved: string[] = [];
  const failed: { agent: string; reason: string }[] = [];
  for (const a of plan.agents) {
    if (a.kind === 'refused') continue;
    const agent = `${a.base}/${a.from}`;
    try {
      migrateAgent(a);
      moved.push(agent);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      failed.push({
        agent,
        reason: code !== undefined ? `could not write (${code})` : (e as Error).message,
      });
    }
  }
  return { plan, moved, failed };
}
