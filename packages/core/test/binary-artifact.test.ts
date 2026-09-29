import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFileSystem } from '../src/io/node.js';
import { applyPlan } from '../src/pipeline/apply.js';
import { verifyPlan } from '../src/pipeline/verify.js';
import { buildState, loadState, RAW_HASH_PREFIX } from '../src/state/state.js';
import { emptyCanonical } from '../src/model/canonical.js';
import type { Artifact } from '../src/adapter/artifact.js';
import type { Plan } from '../src/pipeline/plan.js';

/**
 * T052: a binary artifact goes to disk, into `state.json` and through `check` as the bytes
 * it is. The bytes below are chosen to break every text path: a UTF-8 BOM, `\r\n` pairs a
 * text hash would fold to `\n`, a NUL and an invalid UTF-8 sequence.
 */
const BYTES = new Uint8Array([
  0xef, 0xbb, 0xbf, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0xff, 0x0d, 0x0a,
]);
const ASSET = '.claude/skills/demo/assets/logo.png';
const TEXT = '.claude/skills/demo/SKILL.md';

const binary = (bytes = BYTES): Artifact => ({
  path: ASSET,
  contents: '',
  bytes,
  adapter: 'claude-code',
  kind: 'skill',
});
const text: Artifact = {
  path: TEXT,
  contents: '---\nname: demo\ndescription: D.\n---\n\nBody.\n',
  adapter: 'claude-code',
  kind: 'skill',
};

function planOf(artifacts: readonly Artifact[]): Plan {
  const sorted = [...artifacts].sort((a, b) => (a.path < b.path ? -1 : 1));
  return {
    canonical: emptyCanonical({ file: '.rulegate/rulegate.yaml' }),
    artifacts: sorted,
    state: buildState(sorted),
    enabledAdapters: ['claude-code'],
    levels: [
      { dir: '', skippedTools: [], ownRuleIds: [], overriddenRuleIds: [], inheritedFrom: [] },
    ],
    errors: [],
    warnings: [],
  };
}

const scratch: string[] = [];
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function repo(): Promise<{ root: string; fs: NodeFileSystem }> {
  const root = await mkdtemp(path.join(tmpdir(), 'rulegate-binary-'));
  scratch.push(root);
  return { root, fs: new NodeFileSystem(root) };
}

describe('binary artifacts (T052)', () => {
  it('writes the bytes unmodified and records a raw hash', async () => {
    const { root, fs } = await repo();
    const report = await applyPlan(planOf([binary(), text]), fs);
    expect(report.written).toEqual([TEXT, ASSET]);
    expect(new Uint8Array(await readFile(path.join(root, ASSET)))).toEqual(BYTES);

    const { state } = await loadState(fs);
    expect(state.artifacts.find((a) => a.path === ASSET)?.hash.startsWith(RAW_HASH_PREFIX)).toBe(
      true,
    );
    expect(state.artifacts.find((a) => a.path === TEXT)?.hash.startsWith('sha256:')).toBe(true);

    expect((await verifyPlan(planOf([binary(), text]), fs)).clean).toBe(true);
    const again = await applyPlan(planOf([binary(), text]), fs);
    expect(again.written).toEqual([]);
  });

  it('sees a difference a text hash would fold away: \\r\\n rewritten as \\n', async () => {
    const { root, fs } = await repo();
    await applyPlan(planOf([binary()]), fs);
    const folded = Buffer.from(BYTES).toString('latin1').replace(/\r\n/g, '\n');
    await writeFile(path.join(root, ASSET), Buffer.from(folded, 'latin1'));

    const report = await verifyPlan(planOf([binary()]), fs);
    expect(report.clean).toBe(false);
    expect(report.entries).toEqual([{ path: ASSET, status: 'hand-edited', binary: true }]);

    // `sync` keeps the edit rather than overwrite it, as for any hand-edited file.
    const sync = await applyPlan(planOf([binary()]), fs);
    expect(sync.skipped).toEqual([{ path: ASSET, reason: 'hand-edited' }]);
  });

  it('reports a render change as stale and rewrites it', async () => {
    const { root, fs } = await repo();
    await applyPlan(planOf([binary()]), fs);
    const next = new Uint8Array([...BYTES, 0x01]);
    expect((await verifyPlan(planOf([binary(next)]), fs)).entries).toEqual([
      { path: ASSET, status: 'stale', binary: true },
    ]);
    await applyPlan(planOf([binary(next)]), fs);
    expect(new Uint8Array(await readFile(path.join(root, ASSET)))).toEqual(next);
  });

  it('deletes an untouched binary orphan with a byte-exact backup, and refuses an edited one', async () => {
    const { root, fs } = await repo();
    await applyPlan(planOf([binary(), text]), fs);
    expect((await verifyPlan(planOf([text]), fs)).entries).toEqual([
      { path: ASSET, status: 'orphaned', binary: true },
    ]);
    const removed = await applyPlan(planOf([text]), fs);
    expect(removed.deleted).toEqual([ASSET]);
    expect(new Uint8Array(await readFile(path.join(root, '.rulegate/backup', ASSET)))).toEqual(
      BYTES,
    );

    await applyPlan(planOf([binary(), text]), fs);
    await writeFile(path.join(root, ASSET), Buffer.from([1, 2, 3]));
    const refused = await applyPlan(planOf([text]), fs);
    expect(refused.deleted).toEqual([]);
    expect(refused.skipped).toEqual([{ path: ASSET, reason: 'orphan-hand-edited' }]);
  });

  it("refuses to overwrite somebody else's file standing where an asset goes", async () => {
    const { root, fs } = await repo();
    await writeFile(path.join(root, 'placeholder'), '');
    await (
      await import('node:fs/promises')
    ).mkdir(path.dirname(path.join(root, ASSET)), {
      recursive: true,
    });
    await writeFile(path.join(root, ASSET), Buffer.from([9, 9]));
    const report = await applyPlan(planOf([binary()]), fs);
    expect(report.skipped).toEqual([{ path: ASSET, reason: 'unmanaged' }]);
    expect([...(await readFile(path.join(root, ASSET)))]).toEqual([9, 9]);
  });
});
