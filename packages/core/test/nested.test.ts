import { describe, expect, it } from 'vitest';
import { MemoryFileSystem } from '../src/io/memory.js';
import { discoverSources, resolveNested } from '../src/parse/nested.js';
import type { ResolvedLevel } from '../src/parse/nested.js';

const rule = (id: string, body: string, order = 10): string =>
  `---\norder: ${String(order)}\n---\n\n${body}\n`;

const manifest = (...tools: readonly string[]): string =>
  tools.length === 0
    ? 'schemaVersion: 1\ntools: []\n'
    : `schemaVersion: 1\ntools:\n${tools.map((t) => `  - ${t}\n`).join('')}`;

/**
 * A three-package monorepo, which is T061's validation fixture.
 *
 * - root        — manifest + two rules (`10-style`, `20-security`)
 * - packages/a  — manifest + one new rule and one that redefines `10-style`
 * - packages/b  — **rules-only**, no manifest, one new rule
 * - packages/c  — no `.rulegate/` at all, so it is not a level
 */
const MONOREPO = new MemoryFileSystem([
  ['.rulegate/rulegate.yaml', manifest('claude-code', 'cursor')],
  ['.rulegate/rules/10-style.md', rule('10-style', 'Root style: use tabs.')],
  ['.rulegate/rules/20-security.md', rule('20-security', 'Root security: no literal secrets.')],

  ['packages/a/.rulegate/rulegate.yaml', manifest('cursor')],
  ['packages/a/.rulegate/rules/10-style.md', rule('10-style', 'Package a style: use spaces.')],
  ['packages/a/.rulegate/rules/30-a-only.md', rule('30-a-only', 'Package a: prefer server comps.')],

  ['packages/b/.rulegate/rules/40-b-only.md', rule('40-b-only', 'Package b: no default exports.')],

  ['packages/c/src/index.ts', 'export const x = 1;\n'],

  // Neither of these is a level: a backup holds config Rulegate replaced, and a fixture
  // tree is test data. Both look exactly like a canonical source to a naive glob.
  ['.rulegate/backup/.rulegate/rulegate.yaml', manifest('gemini')],
  [
    '.rulegate/backup/.rulegate/rules/99-old.md',
    rule('99-old', 'An old rule, restored on demand.'),
  ],
]);

const at = (levels: readonly ResolvedLevel[], dir: string): ResolvedLevel => {
  const found = levels.find((l) => l.dir === dir);
  if (found === undefined) throw new Error(`no level at "${dir}"`);
  return found;
};

const idsOf = (level: ResolvedLevel): string[] => level.canonical.rules.map((r) => r.id).sort();

const bodyOf = (level: ResolvedLevel, id: string): string =>
  level.canonical.rules.find((r) => r.id === id)?.body ?? '';

describe('discoverSources', () => {
  it('finds every level, root first, and nothing that only looks like one', async () => {
    const sources = await discoverSources(MONOREPO);
    expect(sources.map((s) => s.dir)).toEqual(['', 'packages/a', 'packages/b']);
  });

  it('finds a rules-only level, which globbing the manifest alone would miss', async () => {
    const sources = await discoverSources(MONOREPO);
    expect(at(resolveNested(sources), 'packages/b').ownRuleIds).toEqual(['40-b-only']);
  });

  it('never treats a backup as a level', async () => {
    // The control that makes the exclusion mean something: the backup really does hold a
    // parseable manifest and rule, so a glob without the guard finds them.
    const sources = await discoverSources(MONOREPO);
    expect(sources.map((s) => s.dir)).not.toContain('.rulegate/backup');
    expect(sources.flatMap((s) => s.result.canonical.rules.map((r) => r.id))).not.toContain(
      '99-old',
    );
  });

  it('reports paths relative to the repository, not to the level', async () => {
    // A re-rooted filesystem would make these relative to `packages/a`, and every hint,
    // diff and `state.json` entry built from them would then name a path that does not
    // exist from where the user is standing.
    const sources = await discoverSources(MONOREPO);
    const a = sources.find((s) => s.dir === 'packages/a');
    expect(a?.result.sourceFiles).toContain('packages/a/.rulegate/rulegate.yaml');
    expect(a?.result.sourceFiles).toContain('packages/a/.rulegate/rules/30-a-only.md');
  });

  it('is byte-identical across repeated runs', async () => {
    const build = async (): Promise<string> =>
      JSON.stringify(resolveNested(await discoverSources(MONOREPO)));
    expect(await build()).toBe(await build());
  });
});

describe('resolveNested — inheritance', () => {
  it('gives the root only its own rules', async () => {
    const levels = resolveNested(await discoverSources(MONOREPO));
    expect(idsOf(at(levels, ''))).toEqual(['10-style', '20-security']);
    expect(at(levels, '').inheritedFrom).toEqual([]);
  });

  it('gives a nested level the root rules plus its own', async () => {
    const a = at(resolveNested(await discoverSources(MONOREPO)), 'packages/a');
    expect(idsOf(a)).toEqual(['10-style', '20-security', '30-a-only']);
    expect(a.inheritedFrom).toEqual(['']);
  });

  it('lets a nearer rule win by id, and says which it overrode', async () => {
    const a = at(resolveNested(await discoverSources(MONOREPO)), 'packages/a');
    expect(bodyOf(a, '10-style')).toContain('Package a style: use spaces.');
    expect(a.overriddenRuleIds).toEqual(['10-style']);
    expect(a.ownRuleIds).toEqual(['10-style', '30-a-only']);
  });

  it('leaves an inherited rule the root wrote untouched', async () => {
    // The negative control for the override above: if inheritance replaced wholesale, or
    // if the nearer level won for everything, this would carry package a's text.
    const a = at(resolveNested(await discoverSources(MONOREPO)), 'packages/a');
    expect(bodyOf(a, '20-security')).toContain('Root security: no literal secrets.');
  });

  it('inherits into a rules-only level too', async () => {
    const b = at(resolveNested(await discoverSources(MONOREPO)), 'packages/b');
    expect(idsOf(b)).toEqual(['10-style', '20-security', '40-b-only']);
    expect(bodyOf(b, '10-style')).toContain('Root style: use tabs.');
    expect(b.overriddenRuleIds).toEqual([]);
  });
});

describe('resolveNested — the manifest does not merge', () => {
  it("takes a level's own tool list rather than adding it to the root's", async () => {
    // Package a enables cursor only. Merging tool lists would silently re-enable
    // claude-code, which is the adapter it deliberately left out.
    const a = at(resolveNested(await discoverSources(MONOREPO)), 'packages/a');
    expect(a.canonical.manifest.tools.map((t) => t.id)).toEqual(['cursor']);
  });

  it('gives a rules-only level the nearest ancestor manifest, not a synthetic one', async () => {
    // Package b has rules and no manifest. Falling back to `parse`'s synthetic manifest
    // would enable every known tool — turning on adapters the root had switched off.
    const b = at(resolveNested(await discoverSources(MONOREPO)), 'packages/b');
    expect(b.canonical.manifest.tools.map((t) => t.id)).toEqual(['claude-code', 'cursor']);
  });
});

describe('resolveNested — deeper nesting', () => {
  const DEEP = new MemoryFileSystem([
    ['.rulegate/rulegate.yaml', manifest('claude-code')],
    ['.rulegate/rules/10-style.md', rule('10-style', 'root')],
    ['apps/.rulegate/rules/10-style.md', rule('10-style', 'apps')],
    ['apps/web/.rulegate/rules/10-style.md', rule('10-style', 'apps/web')],
    ['apps/api/.rulegate/rules/50-api.md', rule('50-api', 'api only')],
  ]);

  it('resolves three levels deep, nearest winning at each', async () => {
    const levels = resolveNested(await discoverSources(DEEP));
    expect(bodyOf(at(levels, ''), '10-style')).toContain('root');
    expect(bodyOf(at(levels, 'apps'), '10-style')).toContain('apps');
    expect(bodyOf(at(levels, 'apps/web'), '10-style')).toContain('apps/web');
    expect(at(levels, 'apps/web').inheritedFrom).toEqual(['', 'apps']);
  });

  it('does not leak a sibling level into another', async () => {
    // `apps/api` and `apps/web` share an ancestor and must not see each other's rules —
    // a prefix test that used `startsWith` without the separator would join them.
    const levels = resolveNested(await discoverSources(DEEP));
    expect(idsOf(at(levels, 'apps/api'))).toEqual(['10-style', '50-api']);
    expect(bodyOf(at(levels, 'apps/api'), '10-style')).toContain('apps');
    expect(idsOf(at(levels, 'apps/web'))).toEqual(['10-style']);
  });

  it('does not treat a similarly-named sibling directory as a parent', async () => {
    const TRICKY = new MemoryFileSystem([
      ['.rulegate/rulegate.yaml', manifest('claude-code')],
      ['apps/.rulegate/rules/10-style.md', rule('10-style', 'apps')],
      ['apps-legacy/.rulegate/rules/20-legacy.md', rule('20-legacy', 'legacy')],
    ]);
    const levels = resolveNested(await discoverSources(TRICKY));
    // `apps-legacy`.startsWith('apps') is true; only the separator check keeps them apart.
    expect(at(levels, 'apps-legacy').inheritedFrom).toEqual(['']);
    expect(idsOf(at(levels, 'apps-legacy'))).toEqual(['20-legacy']);
  });
});
