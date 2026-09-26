import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cartographerDir,
  coverage,
  featureOf,
  findMap,
  listFeatures,
} from '../src/lib/features.js';
import { sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  await sb.dispose();
});

describe('features (T106)', () => {
  it('uses the first default parent that exists', async () => {
    await sb.put('src/modules/billing/index.ts', '');
    await sb.put('src/modules/.hidden/x.ts', '');
    expect(listFeatures(sb.root)).toEqual([{ name: 'billing', dir: 'src/modules/billing' }]);
  });

  it('prefers .claude/rulegate.json over the defaults', async () => {
    await sb.put('src/features/a/x.ts', '');
    await sb.put('apps/web/x.ts', '');
    await sb.put('.claude/rulegate.json', { features: ['apps/*'] });
    expect(listFeatures(sb.root).map((f) => f.dir)).toEqual(['apps/web']);
    expect(featureOf(sb.root, 'apps/web/src/page.ts')).toEqual({ name: 'web', dir: 'apps/web' });
    expect(featureOf(sb.root, 'src/features/a/x.ts')).toBeUndefined();
  });

  it('reads a malformed config as no config', async () => {
    await sb.put('.claude/rulegate.json', '{ nope');
    await sb.put('features/a/x.ts', '');
    expect(listFeatures(sb.root).map((f) => f.dir)).toEqual(['features/a']);
  });

  it('does not match dashboard against dashboardV2, and never counts _architecture.md', () => {
    const maps = [
      { file: '_architecture.md', text: '# src/features/dashboard\n', mapped: undefined },
      { file: 'v2.md', text: '# src/features/dashboardV2\n', mapped: undefined },
    ];
    expect(findMap({ name: 'dashboard', dir: 'src/features/dashboard' }, maps)).toBeUndefined();
    expect(findMap({ name: 'dashboardV2', dir: 'src/features/dashboardV2' }, maps)?.file).toBe(
      'v2.md',
    );
  });

  it("prefers the plugin's memory directory over agent-os's", async () => {
    await sb.put('.claude/agent-memory/agent-os-feature-cartographer/MEMORY.md', '');
    await sb.put('.claude/agent-memory/rulegate-feature-cartographer/MEMORY.md', '');
    expect(cartographerDir(sb.root)).toMatch(/rulegate-feature-cartographer$/);
  });

  it("reports coverage, and a map older than its feature's last commit as stale", async () => {
    await sb.put('src/features/auth/login.ts', 'x');
    await sb.put('src/features/cart/cart.ts', 'x');
    await sb.put(
      '.claude/agent-memory/rulegate-feature-cartographer/auth.md',
      '---\nmapped: 2026-01-01\n---\n',
    );
    await sb.put('.claude/agent-memory/rulegate-feature-cartographer/_architecture.md', '# arch\n');
    sb.commit('2026-02-01');
    const cov = await coverage(sb.root, { stale: true });
    expect(cov.mapped.map((f) => f.name)).toEqual(['auth']);
    expect(cov.unmapped.map((f) => f.name)).toEqual(['cart']);
    expect(cov.architecture).toBe(true);
    expect(cov.outdated).toEqual([
      expect.objectContaining({ name: 'auth', changed: '2026-02-01' }),
    ]);
  });
});
