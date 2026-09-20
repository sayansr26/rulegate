import { describe, expect, it } from 'vitest';
import { codex, AGENTS_MD } from '../src/index.js';
import { contextFor } from '@rulegate/adapter-kit/testing';

/**
 * T093. `next dev` is the one competing writer for this adapter's artifact that cannot be
 * configured away: it ships inside `node_modules` and runs on every dev server start.
 *
 * The docs note on this adapter makes a claim about *why* that is survivable — Next.js
 * replaces only its marker region and skips a write that would change nothing — and a note
 * is only worth what verifies it. `UPSTREAM_UPSERT` below is a replica of
 * `upsertAgentRulesBlock` from
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/server/lib/generate-agent-files.ts,
 * read from the bundled `next@16.3.5` copy on 2026-09-20, and is treated the same way as
 * everything in `docs.ts`: versioned data about someone else's tool, not a guess. If
 * Next.js changes the algorithm this test keeps passing and the note goes stale — which is
 * what `retrieved` is for, and why the block text is pinned here rather than paraphrased.
 */
const START = '<!-- BEGIN:nextjs-agent-rules -->';
const END = '<!-- END:nextjs-agent-rules -->';
const BLOCK = `${START}\n\n# This is NOT the Next.js you know\n\nBody text, elided.\n\n${END}`;

/** Replica of Next.js's `upsertAgentRulesBlock` for a `\n` file — see the comment above. */
function UPSTREAM_UPSERT(existing: string, block: string): string {
  const startIdx = existing.indexOf(START);
  const endIdx = existing.indexOf(END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return existing.slice(0, startIdx) + block + existing.slice(endIdx + END.length);
  }
  const separator = existing.length === 0 || /\r?\n$/.test(existing) ? '\n' : '\n\n';
  return existing + separator + block + '\n';
}

async function renderAgentsMd(body: string): Promise<string> {
  const ctx = await contextFor('codex/input', codex);
  const canonical = {
    ...ctx.canonical,
    rules: [
      {
        ...ctx.canonical.rules[0]!,
        body,
      },
    ],
  };
  const artifacts = await codex.write({ ...ctx, canonical });
  const agents = artifacts.find((a) => a.path === AGENTS_MD);
  expect(agents, 'the codex adapter must still emit AGENTS.md').toBeDefined();
  return agents!.contents;
}

describe('a foreign marker block inside the generated AGENTS.md', () => {
  /**
   * The state `init` leaves a Next.js repository in, and the reason the collision is not a
   * launch blocker: the block is imported as a canonical rule, so the rendered artifact
   * already carries it, and Next.js's replace-in-place is a no-op it does not even write.
   */
  it('survives the upstream upsert byte-identically when the block is canonical', async () => {
    const rendered = await renderAgentsMd(BLOCK);
    expect(rendered).toContain(START);
    expect(UPSTREAM_UPSERT(rendered, BLOCK)).toBe(rendered);
  });

  /**
   * The documented drift case, and the negative half without which the test above proves
   * nothing: drop the rule from `.rulegate/` and the upsert appends instead of replacing,
   * so the file on disk no longer matches the render. That is what `check` reports as a
   * hand-edit and what `sync` then refuses to overwrite — correctly, on both counts.
   */
  it('diverges from the render when the block is not canonical', async () => {
    const rendered = await renderAgentsMd('Some rule that is not the Next.js block.');
    expect(rendered).not.toContain(START);

    const afterNextDev = UPSTREAM_UPSERT(rendered, BLOCK);
    expect(afterNextDev).not.toBe(rendered);
    expect(afterNextDev).toContain(START);
    // The whole render is still there — Next.js appends, it does not truncate. So the
    // recovery really is `sync --import`: the user's content and the foreign block are
    // both present and separable.
    expect(afterNextDev.startsWith(rendered)).toBe(true);
  });
});
