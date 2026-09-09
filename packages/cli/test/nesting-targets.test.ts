import { describe, expect, it } from 'vitest';
import { nestedPath, nestedTargets, toolsWithoutNesting } from '@rulegate/core';
import { ADAPTERS } from '../src/registry.js';

/**
 * Which tools can receive a nested level's rules, asserted against the **real** roster.
 *
 * This lives in `packages/cli/` for the reason T016 and T026 both give: core owns the
 * algorithm and takes the roster as a parameter, so the test that runs the shipped
 * adapters cannot live in core. It is deliberately an assertion about the *data* — if
 * an adapter's `docs` gains or loses a `nesting` value, this file is where that shows up,
 * rather than in a monorepo's output six months later.
 */
describe('nestedTargets — over the shipped adapters', () => {
  const targets = nestedTargets(ADAPTERS);

  it('names exactly the tools whose own managed artifact is read from a subdirectory', () => {
    expect([...new Set(targets.map((t) => t.tool))].sort()).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'gemini',
      'roo-code',
      'windsurf',
    ]);
  });

  it('maps each to the artifact that is actually nestable', () => {
    const byTool = Object.fromEntries(targets.map((t) => [t.tool, t.pattern]));
    expect(byTool).toEqual({
      'claude-code': 'CLAUDE.md',
      codex: 'AGENTS.md',
      cursor: '.cursor/rules/*.mdc',
      gemini: 'GEMINI.md',
      'roo-code': '.roo/rules/*.md',
      windsurf: '.windsurf/rules/*.md',
    });
  });

  it('carries the resolution the tool documents, not a default', () => {
    const byTool = Object.fromEntries(targets.map((t) => [t.tool, t.nesting]));
    expect(byTool['claude-code']).toBe('nearest-wins');
    expect(byTool['cursor']).toBe('nearest-wins');
    expect(byTool['gemini']).toBe('all-merged');
    expect(byTool['windsurf']).toBe('all-merged');
  });

  it('never offers to write a file the tool does not generate', () => {
    // The load-bearing exclusion. Copilot's only `nesting` entry is on `AGENTS.md`, which
    // it reads and Codex writes — attributing it to Copilot would have two adapters
    // claiming one path, which `computePlan` refuses as `E_ARTIFACT_PATH_CONFLICT`.
    for (const t of targets) {
      const entry = ADAPTERS.find((a) => a.name === t.tool)?.docs.files.find(
        (f) => f.pattern === t.pattern,
      );
      expect(entry?.managed, `${t.tool} ${t.pattern}`).toBe(true);
    }
    expect(targets.some((t) => t.tool === 'copilot')).toBe(false);
  });
});

describe('toolsWithoutNesting — over the shipped adapters', () => {
  it('names the four a nested level cannot reach', () => {
    // Aider and Cline declare no nested mechanism; Copilot's is somebody else's file;
    // Zed resolves `first-match`, so a nested copy would shadow the root rather than add
    // to it. `sync` skips these at a nested level and says so.
    expect([...toolsWithoutNesting(ADAPTERS)].sort()).toEqual(['aider', 'cline', 'copilot', 'zed']);
  });

  it('partitions the roster, leaving nobody unaccounted for', () => {
    // The control: a bug that returned an empty list, or every tool, would pass one of
    // the two assertions above on its own.
    const reachable = new Set(nestedTargets(ADAPTERS).map((t) => t.tool));
    const unreachable = new Set(toolsWithoutNesting(ADAPTERS));
    expect(reachable.size + unreachable.size).toBe(ADAPTERS.length);
    for (const a of ADAPTERS) {
      expect(reachable.has(a.name) !== unreachable.has(a.name), a.name).toBe(true);
    }
  });
});

describe('nestedPath', () => {
  it('leaves a root artifact alone and prefixes a nested one', () => {
    expect(nestedPath('', 'CLAUDE.md')).toBe('CLAUDE.md');
    expect(nestedPath('packages/a', 'CLAUDE.md')).toBe('packages/a/CLAUDE.md');
    expect(nestedPath('packages/a', '.cursor/rules/*.mdc')).toBe('packages/a/.cursor/rules/*.mdc');
  });
});
