import { describe, expect, it } from 'vitest';
import type { Canonical } from '@rulegate/adapter-kit';
import {
  contextFor,
  expectFixtureMatch,
  expectIdempotent,
  renderFixture,
} from '@rulegate/adapter-kit/testing';
import { RULES_DIR, kilo } from '../src/index.js';

describe('kilo write()', () => {
  it('matches the golden fixture byte for byte', async () => {
    await expectFixtureMatch('kilo', kilo);
  });

  it('is idempotent across repeated renders', async () => {
    await expectIdempotent('kilo', kilo);
  });

  it('excludes rules that target other tools', async () => {
    const actual = await renderFixture('kilo', kilo);
    expect([...actual.values()].join('\n')).not.toContain('This rule must not reach kilo');
  });

  it('writes only rule files, never a Kilo config', async () => {
    // Kilo's Settings UI edits kilo.json(c); owning one would make the tool itself
    // produce hand-edit drift on every settings change.
    const actual = await renderFixture('kilo', kilo);
    expect([...actual.keys()].filter((p) => !p.startsWith(`${RULES_DIR}/`))).toEqual([]);
  });

  it('names files so a sorted listing matches canonical order', async () => {
    const actual = await renderFixture('kilo', kilo);
    const names = [...actual.keys()];
    expect(names).toEqual([...names].sort());
    expect(names).toEqual([
      `${RULES_DIR}/001-10-style.md`,
      `${RULES_DIR}/002-20-testing.md`,
      `${RULES_DIR}/003-40-sources.md`,
    ]);
  });

  it('records which rule produced each file', async () => {
    const ctx = await contextFor('kilo/input', kilo);
    const artifacts = await kilo.write(ctx);
    expect(artifacts.map((a) => a.provenance?.ruleIds)).toEqual([
      ['10-style'],
      ['20-testing'],
      ['40-sources'],
    ]);
  });

  it('emits no file when no rule targets this tool', async () => {
    const ctx = await contextFor('kilo/input', kilo);
    const canonical: Canonical = { ...ctx.canonical, rules: [] };
    expect(await kilo.write({ ...ctx, canonical })).toEqual([]);
  });
});
