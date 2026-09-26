import { describe, expect, it } from 'vitest';
import type { Canonical } from '@rulegate/adapter-kit';
import {
  contextFor,
  expectFixtureMatch,
  expectIdempotent,
  renderFixture,
} from '@rulegate/adapter-kit/testing';
import { antigravity, RULES_DIR } from '../src/index.js';

describe('antigravity write()', () => {
  it('matches the golden fixture byte for byte', async () => {
    await expectFixtureMatch('antigravity', antigravity);
  });

  it('is idempotent across repeated renders', async () => {
    // Determinism is a contract (NFR4): `check` compares bytes, so output that varies
    // between runs is drift the user cannot fix.
    await expectIdempotent('antigravity', antigravity);
  });

  it('excludes rules that target other tools', async () => {
    const actual = await renderFixture('antigravity', antigravity);
    // Every file, not one: this adapter writes one per rule.
    expect([...actual.values()].join('\n')).not.toContain('This rule must not reach antigravity');
    expect([...actual.keys()]).not.toContain(`${RULES_DIR}/30-cursor-only.md`);
  });

  it('puts the frontmatter at byte zero, ahead of the marker', async () => {
    // Antigravity silently discards a rule file whose first bytes are not a valid block,
    // so a marker above it would make every generated rule vanish with no error.
    const actual = await renderFixture('antigravity', antigravity);
    expect(actual.size).toBeGreaterThan(0);
    for (const contents of actual.values()) expect(contents.startsWith('---\n')).toBe(true);
  });

  it('gives a scoped rule a quoted, comma-separated glob trigger', async () => {
    const actual = await renderFixture('antigravity', antigravity);
    const scoped = actual.get(`${RULES_DIR}/40-sources.md`);
    expect(scoped).toContain('trigger: glob\n');
    // Quoted: bare, `*.proto` starts with `*` and YAML reads it as an alias.
    expect(scoped).toContain('globs: "src/**/*.ts, *.proto"\n');
    expect(scoped).not.toContain('Applies to:');
    expect(actual.get(`${RULES_DIR}/10-style.md`)).toContain('trigger: always_on\n');
  });

  it('quotes a description YAML would otherwise misread', async () => {
    const ctx = await contextFor('antigravity/input', antigravity);
    const rule = ctx.canonical.rules[0]!;
    const canonical: Canonical = {
      ...ctx.canonical,
      rules: [{ ...rule, frontmatter: { ...rule.frontmatter, description: 'Style: tabs' } }],
    };
    const [artifact] = await antigravity.write({ ...ctx, canonical });
    expect(artifact?.contents).toContain('description: "Style: tabs"\n');
  });

  it('refuses a glob with a comma in it rather than splitting it', async () => {
    const ctx = await contextFor('antigravity/input', antigravity);
    const rule = ctx.canonical.rules[0]!;
    const canonical: Canonical = {
      ...ctx.canonical,
      rules: [{ ...rule, frontmatter: { ...rule.frontmatter, globs: ['src/{a,b}/*.ts'] } }],
    };
    // Through a promise, so a synchronous throw and a rejection are both caught.
    await expect(
      Promise.resolve().then(() => antigravity.write({ ...ctx, canonical })),
    ).rejects.toThrow(/comma/);
  });

  it('records which rule produced each file', async () => {
    const ctx = await contextFor('antigravity/input', antigravity);
    const artifacts = await antigravity.write(ctx);
    expect(artifacts.map((a) => a.provenance?.ruleIds)).toEqual([
      ['10-style'],
      ['20-testing'],
      ['40-sources'],
    ]);
  });

  it('emits no file when no rule targets this tool', async () => {
    const ctx = await contextFor('antigravity/input', antigravity);
    const canonical: Canonical = { ...ctx.canonical, rules: [] };
    expect(await antigravity.write({ ...ctx, canonical })).toEqual([]);
  });
});
