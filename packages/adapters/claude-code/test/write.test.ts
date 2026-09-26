import { describe, expect, it } from 'vitest';
import { ALL_TOOLS, type Canonical, type RuleDocument } from '@rulegate/adapter-kit';
import { claudeCode, CLAUDE_MD } from '../src/index.js';
import {
  contextFor,
  expectFixtureMatch,
  expectIdempotent,
  renderFixture,
} from '@rulegate/adapter-kit/testing';

describe('claude-code write()', () => {
  it('matches the golden fixture byte for byte', async () => {
    await expectFixtureMatch('claude-code', claudeCode);
  });

  it('excludes rules that target other tools', async () => {
    const actual = await renderFixture('claude-code', claudeCode);
    expect(actual.get(CLAUDE_MD)).not.toContain('This rule must not reach Claude Code');
  });

  it('records which rules produced each file', async () => {
    const ctx = await contextFor('claude-code/input', claudeCode);
    const artifacts = await claudeCode.write(ctx);

    // Disjoint by construction: `doctor`'s W_DUPLICATE_LOAD reads these, and a rule
    // claimed by both files would be reported as Claude Code loading it twice.
    expect(artifacts.map((a) => [a.path, a.provenance?.ruleIds])).toEqual([
      [CLAUDE_MD, ['10-style', '20-testing']],
      ['.claude/rules/30-frontend.md', ['30-frontend']],
    ]);
  });

  it('keeps a scoped rule out of CLAUDE.md and states its scope nowhere in prose', async () => {
    const actual = await renderFixture('claude-code', claudeCode);
    expect(actual.get(CLAUDE_MD)).not.toContain('Frontend');
    for (const contents of actual.values()) expect(contents).not.toContain('Applies to');
  });

  it('emits no CLAUDE.md when every rule is scoped', async () => {
    const ctx = await contextFor('claude-code/input', claudeCode);
    const canonical: Canonical = { ...ctx.canonical, rules: [scoped('only', ['src/**'])] };
    const artifacts = await claudeCode.write({ ...ctx, canonical });
    expect(artifacts.map((a) => a.path)).toEqual(['.claude/rules/only.md']);
  });

  it('applies a tools selector to scoped rules too', async () => {
    const ctx = await contextFor('claude-code/input', claudeCode);
    const rule: RuleDocument = {
      ...scoped('cursor-scoped', ['src/**']),
      frontmatter: {
        ...scoped('cursor-scoped', ['src/**']).frontmatter,
        tools: { kind: 'include', tools: ['cursor'] },
      },
    };
    const canonical: Canonical = { ...ctx.canonical, rules: [rule] };
    expect(await claudeCode.write({ ...ctx, canonical })).toEqual([]);
  });

  it('refuses two rules that would generate one path', async () => {
    const ctx = await contextFor('claude-code/input', claudeCode);
    const canonical: Canonical = {
      ...ctx.canonical,
      rules: [scoped('api-rules', ['a/**']), scoped('API rules', ['b/**'])],
    };
    await expect(claudeCode.write({ ...ctx, canonical })).rejects.toMatchObject({
      code: 'E_ARTIFACT_PATH_CONFLICT',
    });
  });

  it('never writes a scoped rule over a path that is canonical input', async () => {
    const ctx = await contextFor('claude-code/input', claudeCode);
    const canonical: Canonical = {
      ...ctx.canonical,
      manifest: {
        ...ctx.canonical.manifest,
        canonicalSources: ['.claude/rules/30-frontend.md'],
      },
    };
    const artifacts = await claudeCode.write({ ...ctx, canonical });
    expect(artifacts.map((a) => a.path)).toEqual([CLAUDE_MD]);
  });

  it('is idempotent across repeated renders', async () => {
    await expectIdempotent('claude-code', claudeCode);
  });

  it('emits no file when no rule targets this tool', async () => {
    const ctx = await contextFor('claude-code/input', claudeCode);
    const canonical: Canonical = { ...ctx.canonical, rules: [] };
    expect(await claudeCode.write({ ...ctx, canonical })).toEqual([]);
  });

  it('refuses to overwrite CLAUDE.md when it is the canonical source', async () => {
    const ctx = await contextFor('claude-code/input', claudeCode);
    const canonical: Canonical = {
      ...ctx.canonical,
      manifest: { ...ctx.canonical.manifest, canonicalSources: [CLAUDE_MD] },
    };

    // The self-reference guard. Generating a file from itself destroys the source,
    // which PRD §11 rates as trust-fatal. The guard is per path, so the scoped rule's
    // own file is still written.
    const artifacts = await claudeCode.write({ ...ctx, canonical });
    expect(artifacts.map((a) => a.path)).toEqual(['.claude/rules/30-frontend.md']);
  });

  it('omits the marker when the manifest disables it', async () => {
    const ctx = await contextFor('claude-code/input', claudeCode);
    const canonical: Canonical = {
      ...ctx.canonical,
      manifest: {
        ...ctx.canonical.manifest,
        options: { ...ctx.canonical.manifest.options, marker: false },
      },
    };
    const [artifact, scopedFile] = await claudeCode.write({ ...ctx, canonical });
    expect(artifact?.contents.startsWith('## Style')).toBe(true);
    // Frontmatter keeps the first bytes either way; the marker only ever follows it.
    expect(scopedFile?.contents).toBe(
      '---\npaths:\n  - "src/components/**/*.tsx"\n---\n## Frontend\n\nPrefer server components.\n',
    );
  });

  // The one-byte regression proof lives in `regression.test.ts`. The version that used to
  // sit here tampered with the *expected* string and asserted the untampered render still
  // matched, which proves `toBe` works and nothing about the harness.

  it('keeps the canonical rule order regardless of how rules arrive', async () => {
    const ctx = await contextFor('claude-code/input', claudeCode);
    const reversed: Canonical = { ...ctx.canonical, rules: [...ctx.canonical.rules].reverse() };
    const a = await claudeCode.write(ctx);
    const b = await claudeCode.write({ ...ctx, canonical: reversed });

    expect(b).toEqual(a);
  });

  it('renders a repo-wide rule with no Applies-to line', async () => {
    const ctx = await contextFor('claude-code/input', claudeCode);
    const canonical: Canonical = {
      ...ctx.canonical,
      rules: [
        {
          id: 'plain',
          path: '.rulegate/rules/plain.md',
          body: 'Body.\n',
          frontmatter: { globs: [], tools: ALL_TOOLS, order: 100, unknown: {} },
          source: { file: '.rulegate/rules/plain.md' },
        },
      ],
    };
    const [artifact] = await claudeCode.write({ ...ctx, canonical });
    expect(artifact?.contents).toBe(
      // No `## plain` heading: a rule with no description gets none, rather than one
      // invented from its id. See `renderRuleSection`.
      '<!-- generated by rulegate; edit .rulegate/ instead -->\n\nBody.\n',
    );
  });
});

function scoped(id: string, globs: readonly string[]): RuleDocument {
  return {
    id,
    path: `.rulegate/rules/${id}.md`,
    body: 'Body.\n',
    frontmatter: { globs, tools: ALL_TOOLS, order: 100, unknown: {} },
    source: { file: `.rulegate/rules/${id}.md` },
  };
}
