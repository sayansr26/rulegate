import { describe, expect, it } from 'vitest';
import { ADAPTER_API_VERSION } from '../src/adapter/context.js';
import { MemoryFileSystem } from '../src/io/memory.js';
import { RULES } from '../src/lint/rules/index.js';
import { detected } from '../src/adapter/adapter.js';
import { runLint } from '../src/lint/engine.js';
import type { Adapter, DetectResult } from '../src/adapter/adapter.js';
import type { AdapterDocs, PrecedenceEntry } from '../src/adapter/docs.js';
import type { LintFindingInit, LintReport, LintRule, LintRuleId } from '../src/lint/types.js';
import type { ToolId } from '../src/model/ids.js';

const source = { url: 'https://example.test/docs', title: 'Docs', retrieved: '2026-09-09' };

function entry(pattern: string, over: Partial<PrecedenceEntry> = {}): PrecedenceEntry {
  return {
    pattern,
    scope: 'project',
    role: 'instructions',
    managed: false,
    description: 'test entry',
    source,
    ...over,
  };
}

function stub(name: ToolId): Adapter {
  const docs: AdapterDocs = {
    toolName: name.toUpperCase(),
    homepage: 'https://example.test',
    verifiedAgainst: { version: '1.x', date: '2026-09-09' },
    files: [entry('A.md')],
  };
  return {
    name,
    apiVersion: ADAPTER_API_VERSION,
    detect: (): Promise<DetectResult> => Promise.resolve(detected(['x'])),
    read: () => Promise.resolve({}),
    write: () => Promise.resolve([]),
    docs,
  };
}

/** A rule that reports exactly what it is told to, so severity and suppression are testable. */
function firing(
  id: LintRuleId,
  findings: readonly LintFindingInit[],
  defaultSeverity: LintRule['defaultSeverity'] = 'warn',
): LintRule {
  return {
    id,
    defaultSeverity,
    description: `test rule ${id}`,
    check: () => findings,
  };
}

const finding = (path: string, message = 'found something'): LintFindingInit => ({
  paths: path === '' ? [] : [path],
  message,
  hint: 'do the thing',
});

async function lint(manifest: string, rules?: readonly LintRule[]): Promise<LintReport> {
  return runLint({
    repoRoot: '/repo',
    fs: new MemoryFileSystem([
      ['.rulegate/rulegate.yaml', manifest],
      ['A.md', 'a'],
      ['fixtures/tool/expected/A.md', 'a'],
    ]),
    adapters: [stub('alpha')],
    ...(rules === undefined ? {} : { rules }),
  });
}

const BARE = 'schemaVersion: 1\ntools: []\n';

describe('runLint — the engine with zero rules', () => {
  it('reports nothing and counts nothing', async () => {
    // T063's validation clause. It was written when the shipped registry was genuinely
    // empty and passed for that reason; T064 filled it, so the empty case is now stated
    // explicitly. The registry is asserted non-empty alongside, because a test named
    // "with zero rules" that silently became "with the real rules" is how a contract
    // stops being checked without anybody noticing.
    expect(RULES.length).toBeGreaterThan(0);

    const r = await lint(BARE, []);
    expect(r.findings).toEqual([]);
    expect(r.errorCount).toBe(0);
    expect(r.warnCount).toBe(0);
    expect(r.unknownRules).toEqual([]);
    expect(r.disabledRules).toEqual([]);
  });

  it('runs on a repository that has never adopted rulegate', async () => {
    const r = await runLint({
      repoRoot: '/repo',
      fs: new MemoryFileSystem([['A.md', 'hand written']]),
      adapters: [stub('alpha')],
      rules: [],
    });
    expect(r.findings).toEqual([]);
  });
});

describe('runLint — severity', () => {
  const rules = [firing('oversized-file', [finding('A.md')])];

  it("counts a rule's own default when the manifest says nothing", async () => {
    const r = await lint(BARE, rules);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]?.severity).toBe('warn');
    expect(r.warnCount).toBe(1);
    expect(r.errorCount).toBe(0);
  });

  it('lets the manifest raise a rule to error', async () => {
    const r = await lint(`${BARE}lint:\n  rules:\n    oversized-file: error\n`, rules);
    expect(r.findings[0]?.severity).toBe('error');
    expect(r.errorCount).toBe(1);
    expect(r.warnCount).toBe(0);
  });

  it('lets the manifest lower a rule below its default', async () => {
    // The positive control for the test above: a `severityFor` that only ever raised
    // would pass it. A rule defaulting to `error` must be demotable to `warn`, or a
    // repository with a standing correct violation has no option but to turn it off.
    const loud = [firing('oversized-file', [finding('A.md')], 'error')];
    expect((await lint(BARE, loud)).errorCount).toBe(1);

    const r = await lint(`${BARE}lint:\n  rules:\n    oversized-file: warn\n`, loud);
    expect(r.findings[0]?.severity).toBe('warn');
    expect(r.errorCount).toBe(0);
  });

  it('drops a rule set to off, and says which', async () => {
    const r = await lint(`${BARE}lint:\n  rules:\n    oversized-file: off\n`, rules);
    expect(r.findings).toEqual([]);
    expect(r.disabledRules).toEqual(['oversized-file']);
  });

  it('never runs a disabled rule at all', async () => {
    // Filtering findings after the fact would give the same report and a rule that did
    // real work for nothing — and `stale-path` stats files.
    let ran = false;
    const spy: LintRule = {
      id: 'stale-path',
      defaultSeverity: 'warn',
      description: 'spy',
      check: () => {
        ran = true;
        return [];
      },
    };
    await lint(`${BARE}lint:\n  rules:\n    stale-path: off\n`, [spy]);
    expect(ran).toBe(false);
  });
});

describe('runLint — suppression', () => {
  const rules = [firing('oversized-file', [finding('fixtures/tool/expected/A.md')])];

  it('silences a finding whose path matches lint.ignore', async () => {
    const r = await lint(`${BARE}lint:\n  ignore:\n    - 'fixtures/**'\n`, rules);
    expect(r.findings).toEqual([]);
  });

  it('leaves a finding outside the ignored globs alone', async () => {
    // The negative control. Without it, an `isSuppressed` that returned true for
    // everything would pass the test above.
    const r = await lint(`${BARE}lint:\n  ignore:\n    - 'fixtures/**'\n`, [
      firing('oversized-file', [finding('A.md')]),
    ]);
    expect(r.findings).toHaveLength(1);
  });

  it('keeps a multi-path finding unless every path is ignored', async () => {
    const spanning = [
      firing('conflicting-rules', [
        { paths: ['fixtures/tool/expected/A.md', 'A.md'], message: 'both', hint: 'h' },
      ]),
    ];
    expect(
      (await lint(`${BARE}lint:\n  ignore:\n    - 'fixtures/**'\n`, spanning)).findings,
    ).toHaveLength(1);

    const allIgnored = [
      firing('conflicting-rules', [
        { paths: ['fixtures/tool/expected/A.md'], message: 'one', hint: 'h' },
      ]),
    ];
    expect(
      (await lint(`${BARE}lint:\n  ignore:\n    - 'fixtures/**'\n`, allIgnored)).findings,
    ).toEqual([]);
  });

  it('never silences a repository-wide finding with a path glob', async () => {
    // A finding with no paths is about the manifest, not a file. Suppressing it behind
    // an unrelated fixture glob is how "your manifest configures a rule that does not
    // exist" becomes invisible to the person who mistyped it.
    const r = await lint(`${BARE}lint:\n  ignore:\n    - '**'\n`, [
      firing('oversized-file', [finding('')]),
    ]);
    expect(r.findings).toHaveLength(1);
  });
});

describe('runLint — contract', () => {
  it('names a configured rule id that no rule answers to', async () => {
    const r = await lint(`${BARE}lint:\n  rules:\n    no-such-rule: warn\n`);
    expect(r.unknownRules).toEqual(['no-such-rule']);
  });

  it('does not call a registered rule unknown', async () => {
    const r = await lint(`${BARE}lint:\n  rules:\n    oversized-file: warn\n`, [
      firing('oversized-file', []),
    ]);
    expect(r.unknownRules).toEqual([]);
  });

  it('sorts findings by rule then path, not by discovery order', async () => {
    const rules = [
      firing('stale-path', [finding('z.md', 'z'), finding('a.md', 'a')]),
      firing('conflicting-rules', [finding('m.md', 'm')]),
    ];
    const r = await lint(BARE, rules);
    expect(r.findings.map((f) => [f.rule, f.paths[0]])).toEqual([
      ['conflicting-rules', 'm.md'],
      ['stale-path', 'a.md'],
      ['stale-path', 'z.md'],
    ]);
  });

  it('is byte-identical across repeated runs', async () => {
    const rules = [firing('stale-path', [finding('b.md'), finding('a.md')])];
    const build = (): Promise<LintReport> => lint(BARE, rules);
    expect(JSON.stringify(await build())).toBe(JSON.stringify(await build()));
  });
});
