import { describe, expect, it } from 'vitest';
import { ADAPTER_API_VERSION } from '../src/adapter/context.js';
import { MemoryFileSystem } from '../src/io/memory.js';
import { RULES } from '../src/lint/rules/index.js';
import { detected } from '../src/adapter/adapter.js';
import { runLint } from '../src/lint/engine.js';
import type { Adapter, DetectResult } from '../src/adapter/adapter.js';
import type { AdapterDocs, PrecedenceEntry } from '../src/adapter/docs.js';
import type { LintFinding, LintReport, LintRuleId } from '../src/lint/types.js';
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

interface StubInit {
  readonly name: ToolId;
  readonly files: readonly PrecedenceEntry[];
  readonly limits?: AdapterDocs['limits'];
  readonly writes?: readonly (readonly [string, string])[];
  readonly provenance?: Readonly<Record<string, readonly string[]>>;
}

function stub(init: StubInit): Adapter {
  const docs: AdapterDocs = {
    toolName: init.name.toUpperCase(),
    homepage: 'https://example.test',
    verifiedAgainst: { version: '1.x', date: '2026-09-09' },
    resolution: 'additive',
    files: init.files,
    ...(init.limits === undefined ? {} : { limits: init.limits }),
  };
  return {
    name: init.name,
    apiVersion: ADAPTER_API_VERSION,
    detect: (): Promise<DetectResult> => Promise.resolve(detected(['x'])),
    read: () => Promise.resolve({}),
    write: () =>
      Promise.resolve(
        (init.writes ?? []).map(([p, contents]) => ({
          path: p,
          contents,
          adapter: init.name,
          kind: 'rules' as const,
          ...(init.provenance?.[p] === undefined
            ? {}
            : { provenance: { ruleIds: init.provenance[p] } }),
        })),
      ),
    docs,
  };
}

async function lint(
  files: readonly (readonly [string, string])[],
  adapters: readonly Adapter[],
): Promise<LintReport> {
  return runLint({ repoRoot: '/repo', fs: new MemoryFileSystem(files), adapters });
}

const of = (r: LintReport, id: LintRuleId): LintFinding[] =>
  r.findings.filter((f) => f.rule === id);

const manifest = (...tools: readonly string[]): readonly [string, string] => [
  '.rulegate/rulegate.yaml',
  // `tools: []` when empty, never a bare `tools:` — that parses as null and is a
  // manifest error, which the engine correctly refuses to lint past. It cost a
  // debugging session here, so it is worth the branch.
  tools.length === 0
    ? 'schemaVersion: 1\ntools: []\n'
    : `schemaVersion: 1\ntools:\n${tools.map((t) => `  - ${t}\n`).join('')}`,
];

/** A canonical rule file. `order` keeps rendering deterministic. */
const rule = (id: string, body: string): readonly [string, string] => [
  `.rulegate/rules/${id}.md`,
  `---\norder: 10\n---\n\n${body}\n`,
];

describe('the shipped rule set', () => {
  it('registers exactly the four T064 rules', () => {
    expect(RULES.map((r) => r.id)).toEqual([
      'oversized-file',
      'conflicting-rules',
      'stale-path',
      'token-budget',
    ]);
  });

  it('never defaults a rule to error unless no correct repository can trip it', () => {
    // The T027/T047/T072 policy, asserted rather than left to reviewers. `oversized-file`
    // is the only rule whose condition is a published cap that content is silently
    // dropped past; the rest describe states a repository may legitimately be in.
    const byId = new Map(RULES.map((r) => [r.id, r.defaultSeverity]));
    expect(byId.get('oversized-file')).toBe('error');
    expect(byId.get('conflicting-rules')).toBe('warn');
    expect(byId.get('stale-path')).toBe('warn');
    expect(byId.get('token-budget')).toBe('warn');
  });
});

describe('oversized-file', () => {
  const big = 'x'.repeat(200);
  const tool = (limits: AdapterDocs['limits']): Adapter =>
    stub({
      name: 'alpha',
      files: [entry('A.md', { managed: true })],
      writes: [['A.md', `${big}\n`]],
      ...(limits === undefined ? {} : { limits }),
    });

  it('fires when a loaded file is over the documented per-file cap', async () => {
    const r = await lint(
      [manifest('alpha'), ['A.md', `${big}\n`]],
      [tool({ maxBytesPerFile: 50 })],
    );
    expect(of(r, 'oversized-file')).toHaveLength(1);
    expect(of(r, 'oversized-file')[0]?.severity).toBe('error');
    expect(of(r, 'oversized-file')[0]?.paths).toEqual(['A.md']);
  });

  it('stays silent when the same file is under the cap', async () => {
    // The negative control. One fault removed — the cap raised above the file — and only
    // this finding may disappear.
    const r = await lint(
      [manifest('alpha'), ['A.md', `${big}\n`]],
      [tool({ maxBytesPerFile: 5000 })],
    );
    expect(of(r, 'oversized-file')).toEqual([]);
    expect(r.errorCount).toBe(0);
  });

  it('stays silent when the tool documents no cap at all', async () => {
    const r = await lint([manifest('alpha'), ['A.md', `${big}\n`]], [tool(undefined)]);
    expect(of(r, 'oversized-file')).toEqual([]);
  });

  it('accepts a file exactly at the cap', async () => {
    // Strictly `>`. A boundary this rule gets wrong is an error-severity false alarm on
    // correct output, which is the worst failure in the set.
    const exact = 'x'.repeat(49);
    const r = await lint(
      [manifest('alpha'), ['A.md', `${exact}\n`]],
      [
        stub({
          name: 'alpha',
          files: [entry('A.md', { managed: true })],
          writes: [['A.md', `${exact}\n`]],
          limits: { maxBytesPerFile: 50 },
        }),
      ],
    );
    expect(of(r, 'oversized-file')).toEqual([]);
  });
});

describe('conflicting-rules', () => {
  /** Two tools, both generating the same canonical rule, both read by `reader`. */
  const shared = (): readonly Adapter[] => [
    stub({
      name: 'alpha',
      files: [entry('A.md', { managed: true }), entry('SHARED.md')],
      writes: [['A.md', 'body\n']],
      provenance: { 'A.md': ['10-style'] },
    }),
    stub({
      name: 'beta',
      files: [entry('SHARED.md', { managed: true })],
      writes: [['SHARED.md', 'body\n']],
      provenance: { 'SHARED.md': ['10-style'] },
    }),
  ];

  it('fires when one tool receives the same canonical rule twice', async () => {
    const r = await lint(
      [manifest('alpha', 'beta'), rule('10-style', 'Use tabs.'), ['A.md', 'x'], ['SHARED.md', 'x']],
      shared(),
    );
    expect(of(r, 'conflicting-rules').length).toBeGreaterThan(0);
    expect(of(r, 'conflicting-rules')[0]?.severity).toBe('warn');
  });

  it('stays silent when only one mechanism delivers the rule', async () => {
    // The negative control: `beta` disabled, so nothing is delivered twice.
    const r = await lint(
      [manifest('alpha'), rule('10-style', 'Use tabs.'), ['A.md', 'x']],
      shared(),
    );
    expect(of(r, 'conflicting-rules')).toEqual([]);
  });
});

describe('stale-path', () => {
  const tool = stub({ name: 'alpha', files: [entry('A.md')] });

  const withBody = (body: string, extra: readonly (readonly [string, string])[] = []) =>
    lint([manifest(), rule('10-style', body), ...extra], [tool]);

  it('fires on a backticked path whose first segment exists and whose file does not', async () => {
    const r = await withBody('See `docs/gone.md` for details.', [['docs/kept.md', 'x']]);
    expect(of(r, 'stale-path')).toHaveLength(1);
    expect(of(r, 'stale-path')[0]?.message).toContain('docs/gone.md');
    // Reported against the rule file, which is the file to open to fix it.
    expect(of(r, 'stale-path')[0]?.paths).toEqual(['.rulegate/rules/10-style.md']);
  });

  it('stays silent when the referenced file exists', async () => {
    const r = await withBody('See `docs/kept.md` for details.', [['docs/kept.md', 'x']]);
    expect(of(r, 'stale-path')).toEqual([]);
  });

  it('reports one finding for a path cited by several rules', async () => {
    const r = await lint(
      [
        manifest(),
        rule('10-style', 'See `docs/gone.md`.'),
        rule('20-other', 'Also `docs/gone.md`.'),
        ['docs/kept.md', 'x'],
      ],
      [tool],
    );
    expect(of(r, 'stale-path')).toHaveLength(1);
    expect(of(r, 'stale-path')[0]?.paths).toEqual([
      '.rulegate/rules/10-style.md',
      '.rulegate/rules/20-other.md',
    ]);
  });

  describe('what it deliberately does not report', () => {
    // Every case below was a false positive on this repository before it was excluded,
    // and they are the reason the rule is quiet enough to leave on. Which *mechanism*
    // excludes each is deliberately not asserted: mutation testing showed the
    // first-segment anchor check subsumes most of the string tests, so pinning a case to
    // one line would pass for the wrong reason the moment the other line changed. What
    // matters, and what is asserted, is that the rule stays silent.
    const quiet: readonly (readonly [string, string])[] = [
      ['prose without backticks', 'See docs/gone.md for details.'],
      ['a bare filename with no slash', 'The `state.json` file records ownership.'],
      ['a directory, which is often created on demand', 'Copies land in `.rulegate/backup/`.'],
      ['a path anchored somewhere else', 'Edit `src/docs.ts` in the new adapter.'],
      ['an npm scope', 'Adapters import `@rulegate/adapter-kit`.'],
      ['a glob', 'Generated into `docs/tools/*.md`.'],
      ['a brace expansion', 'Fixtures live in `fixtures/x/{input,expected}`.'],
      ['a scheme reference', 'Secrets are `env:GITHUB_TOKEN`.'],
      ['a URL', 'See `https://example.test/a/b.md`.'],
      ['an absolute path', 'Never `/etc/passwd`.'],
      ['a parent-relative path', 'Not `../outside/x.md`.'],
    ];

    it.each(quiet)('is silent on %s', async (_label, body) => {
      const r = await withBody(body, [['docs/kept.md', 'x']]);
      expect(of(r, 'stale-path')).toEqual([]);
    });

    it('still fires on a real stale path in the same body', async () => {
      // The positive control for the whole block above: an `isCandidate` that rejected
      // everything would pass all eleven cases and be useless.
      const body = `${quiet.map(([, b]) => b).join(' ')} And \`docs/gone.md\`.`;
      const r = await withBody(body, [['docs/kept.md', 'x']]);
      expect(of(r, 'stale-path')).toHaveLength(1);
      expect(of(r, 'stale-path')[0]?.message).toContain('docs/gone.md');
    });
  });
});

describe('token-budget', () => {
  const tool = stub({ name: 'alpha', files: [entry('A.md')] });
  const body = 'word '.repeat(400);

  /** A manifest enabling `alpha` with the given `lint.tokenBudget` entries. */
  const budgeted = (...entries: readonly string[]): readonly [string, string] => [
    '.rulegate/rulegate.yaml',
    `schemaVersion: 1\ntools:\n  - alpha\nlint:\n  tokenBudget:\n${entries
      .map((e) => `    ${e}\n`)
      .join('')}`,
  ];

  it('fires when a tool loads more than its configured budget', async () => {
    const r = await lint([budgeted('alpha: 10'), ['A.md', body]], [tool]);
    expect(of(r, 'token-budget')).toHaveLength(1);
    expect(of(r, 'token-budget')[0]?.message).toContain('over its budget of 10');
  });

  it('stays silent when the tool is under its budget', async () => {
    const r = await lint([budgeted('alpha: 100000'), ['A.md', body]], [tool]);
    expect(of(r, 'token-budget')).toEqual([]);
  });

  it('stays silent for a tool with no budget configured', async () => {
    // The rule has no default to fall back on: `AdapterDocs.limits` is in bytes, and the
    // estimator must not leak into a check it cannot answer (T024). No budget, no finding
    // — which is why the rule can default to `warn` without an opt-in of its own.
    const r = await lint([manifest('alpha'), ['A.md', body]], [tool]);
    expect(of(r, 'token-budget')).toEqual([]);
  });

  it('budgets each tool separately', async () => {
    const beta = stub({ name: 'beta', files: [entry('A.md')] });
    const r = await lint(
      [
        [
          '.rulegate/rulegate.yaml',
          'schemaVersion: 1\ntools:\n  - alpha\n  - beta\nlint:\n  tokenBudget:\n    alpha: 10\n',
        ],
        ['A.md', body],
      ],
      [tool, beta],
    );
    expect(of(r, 'token-budget').map((f) => f.tool)).toEqual(['alpha']);
  });
});
