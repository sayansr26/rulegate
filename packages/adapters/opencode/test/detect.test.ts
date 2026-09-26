import { describe, expect, it } from 'vitest';
import { contextFor, detectFixture } from '@rulegate/adapter-kit/testing';
import { opencode } from '../src/index.js';

describe('opencode detect()', () => {
  it('finds OpenCode and says what gave it away', async () => {
    const ctx = await contextFor(detectFixture('opencode', 'positive'), opencode);
    const result = await opencode.detect(ctx);

    expect(result.detected).toBe(true);
    // Evidence is sorted, so this is the order `doctor` prints.
    expect(result.evidence).toEqual(['opencode.json']);
  });

  it('reports absence on a repo that does not use it', async () => {
    const ctx = await contextFor(detectFixture('opencode', 'negative'), opencode);
    const result = await opencode.detect(ctx);

    expect(result.detected).toBe(false);
    expect(result.evidence).toEqual([]);
  });
});
