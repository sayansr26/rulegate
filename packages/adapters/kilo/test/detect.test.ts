import { describe, expect, it } from 'vitest';
import { contextFor, detectFixture } from '@rulegate/adapter-kit/testing';
import { kilo } from '../src/index.js';

describe('kilo detect()', () => {
  it('finds Kilo and says what gave it away', async () => {
    const ctx = await contextFor(detectFixture('kilo', 'positive'), kilo);
    const result = await kilo.detect(ctx);

    expect(result.detected).toBe(true);
    // Evidence is sorted, so this is the order `doctor` prints.
    expect(result.evidence).toEqual(['.kilocode', 'kilo.jsonc']);
  });

  it('reports absence on a repo that does not use it', async () => {
    // The negative fixture holds an `opencode.json`. Kilo merges that file, but it is
    // OpenCode's evidence: claiming it would report Kilo in every OpenCode repository.
    const ctx = await contextFor(detectFixture('kilo', 'negative'), kilo);
    const result = await kilo.detect(ctx);

    expect(result.detected).toBe(false);
    expect(result.evidence).toEqual([]);
  });
});
