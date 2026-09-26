import { describe, expect, it } from 'vitest';
import { contextFor, detectFixture } from '@rulegate/adapter-kit/testing';
import { antigravity } from '../src/index.js';

describe('antigravity detect()', () => {
  it('finds Antigravity and says what gave it away', async () => {
    const ctx = await contextFor(detectFixture('antigravity', 'positive'), antigravity);
    const result = await antigravity.detect(ctx);

    expect(result.detected).toBe(true);
    // Evidence is sorted, so this is the order `doctor` prints.
    expect(result.evidence).toEqual(['.agents/rules']);
  });

  it('reports absence on a repo that does not use it', async () => {
    // The negative fixture holds `.agents/skills/`, the cross-tool skills directory. A
    // detector keyed on bare `.agents/` would claim Antigravity in every repository that
    // shares a skill with Cursor or Gemini CLI.
    const ctx = await contextFor(detectFixture('antigravity', 'negative'), antigravity);
    const result = await antigravity.detect(ctx);

    expect(result.detected).toBe(false);
    expect(result.evidence).toEqual([]);
  });
});
