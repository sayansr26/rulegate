import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeFileSystem } from '@rulegate/core';
import { runCheck } from '../src/commands/check.js';
import { runSync } from '../src/commands/sync.js';
import { ExitCode } from '../src/ui/exit.js';

const fixtures = fileURLToPath(new URL('../../../fixtures/', import.meta.url));

let repo: string;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'rulegate-merge-'));
  stdout = [];
  stderr = [];
  await cp(path.join(fixtures, 'doctor/adopted'), repo, { recursive: true });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  await runSync({ cwd: repo, quiet: true });
  stdout.length = 0;
  stderr.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(repo, { recursive: true, force: true });
});

const read = (rel: string) => readFile(path.join(repo, rel), 'utf8');
const rulePath = '.rulegate/rules/10-style.md';

/** Hand-edit a generated file the way a user does: type into it. */
async function handEdit(artifact: string, line: string): Promise<void> {
  const text = await read(artifact);
  await writeFile(path.join(repo, artifact), text.replace('## Style', `## Style\n\n${line}`));
}

describe('rulegate sync --import (T051)', () => {
  it('recovers the edit into the rule it came from, and writes nothing without --yes', async () => {
    await handEdit('CLAUDE.md', 'A line the user added by hand.');
    const before = await read(rulePath);

    const spy = vi.spyOn(NodeFileSystem.prototype, 'writeFile');
    try {
      expect(await runSync({ cwd: repo, import: true })).toBe(ExitCode.Ok);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(await read(rulePath)).toBe(before);
    // The plan is shown, not merely counted: the diff is what makes it reviewable.
    expect(stdout.join('')).toContain('would merge');
    expect(stdout.join('')).toContain('+A line the user added by hand.');

    expect(await runSync({ cwd: repo, import: true, yes: true })).toBe(ExitCode.Ok);
    expect(await read(rulePath)).toContain('A line the user added by hand.');
  });

  it('closes the loop: import, sync, and the repository is clean', async () => {
    await handEdit('GEMINI.md', 'Recovered from the Gemini artifact.');

    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Failure);
    expect(await runSync({ cwd: repo, import: true, yes: true, quiet: true })).toBe(ExitCode.Ok);
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);

    // The edit reached every adapter, which is the whole point of putting it in canonical
    // rather than back into the one file it was typed into.
    for (const artifact of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) {
      expect(await read(artifact)).toContain('Recovered from the Gemini artifact.');
    }
  });

  /**
   * The case the task text does not describe, and the one that shapes the design:
   * `state.json` holds a hash, not the ancestor's text. When canonical has moved on too,
   * the version the user edited is not reconstructible from anything, and inventing an
   * ancestor is how a silent clobber gets in.
   */
  it('refuses when canonical also moved on, instead of guessing an ancestor', async () => {
    await handEdit('CLAUDE.md', 'edited in the artifact.');
    await writeFile(path.join(repo, rulePath), `${await read(rulePath)}\nand in canonical too.\n`);
    const before = await read(rulePath);

    expect(await runSync({ cwd: repo, import: true, yes: true })).toBe(ExitCode.Failure);
    expect(stderr.join('')).toContain('no-ancestor');
    expect(stderr.join('')).toContain('CLAUDE.md');
    // Nothing was written, and --yes did not make it write anyway.
    expect(await read(rulePath)).toBe(before);
  });

  it('refuses a rule two files edited differently, naming both', async () => {
    await handEdit('CLAUDE.md', 'edited one way.');
    await handEdit('AGENTS.md', 'edited another way.');
    const before = await read(rulePath);

    expect(await runSync({ cwd: repo, import: true, yes: true })).toBe(ExitCode.Failure);
    const text = stderr.join('');
    expect(text).toContain('conflict');
    expect(text).toContain('CLAUDE.md');
    expect(text).toContain('AGENTS.md');
    expect(await read(rulePath)).toBe(before);
  });

  /**
   * Matching is by position, because a rule's `id` does not survive rendering — the
   * heading is its *description* (T017). Adding a heading by hand desynchronizes that
   * zip, and a misaligned merge writes one rule's text into another rule's file: silent,
   * and worse than the edit being lost.
   */
  it('refuses a file whose section count no longer matches the rules that produced it', async () => {
    await writeFile(
      path.join(repo, 'CLAUDE.md'),
      `${await read('CLAUDE.md')}\n## Invented\n\nnew.\n`,
    );
    const before = await read(rulePath);

    expect(await runSync({ cwd: repo, import: true, yes: true })).toBe(ExitCode.Failure);
    expect(stderr.join('')).toContain('unrecoverable');
    expect(await read(rulePath)).toBe(before);
  });

  // A `.claude/rules` file carries its scope in `paths:`, and that is exactly what a user
  // edits. Merging the body alone reported success and left `check` failing on the one
  // line the user changed, for the next `sync` to revert (T110).
  it('recovers an edited `paths:` scope along with the body', async () => {
    await writeFile(
      path.join(repo, '.rulegate/rules/30-frontend.md'),
      "---\ndescription: Frontend\nglobs:\n  - 'src/**/*.tsx'\n---\n\nUse hooks.\n",
    );
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);

    const artifact = '.claude/rules/30-frontend.md';
    const text = await read(artifact);
    await writeFile(
      path.join(repo, artifact),
      text.replace('"src/**/*.tsx"', '"app/**/*.tsx"').replace('Use hooks.', 'Use hooks always.'),
    );

    expect(await runSync({ cwd: repo, import: true, yes: true, quiet: true })).toBe(ExitCode.Ok);
    const canonical = await read('.rulegate/rules/30-frontend.md');
    expect(canonical).toContain('app/**/*.tsx');
    expect(canonical).not.toContain('src/**/*.tsx');
    expect(canonical).toContain('Use hooks always.');

    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  it('leaves the scope alone for formats that do not carry it', async () => {
    await writeFile(
      path.join(repo, '.rulegate/rules/30-frontend.md'),
      "---\ndescription: Frontend\nglobs:\n  - 'src/**/*.tsx'\n---\n\nUse hooks.\n",
    );
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    await handEdit('CLAUDE.md', 'A line the user added by hand.');

    expect(await runSync({ cwd: repo, import: true, yes: true, quiet: true })).toBe(ExitCode.Ok);
    expect(await read('.rulegate/rules/30-frontend.md')).toContain('src/**/*.tsx');
    expect(await read(rulePath)).toContain('A line the user added by hand.');
  });

  // A render need not read back to the body it came from, so an edit is measured against
  // the ancestor read back through the adapter, not against canonical (T110).
  it('keeps a heading of the rule body when the scoped rule has no description', async () => {
    await writeFile(
      path.join(repo, '.rulegate/rules/30-server.md'),
      "---\nglobs:\n  - 'src/**'\n---\n\n## Server components\n\nUse them.\n",
    );
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);

    const artifact = '.claude/rules/30-server.md';
    await writeFile(
      path.join(repo, artifact),
      (await read(artifact)).replace('"src/**"', '"app/**"'),
    );

    expect(await runSync({ cwd: repo, import: true, yes: true, quiet: true })).toBe(ExitCode.Ok);
    const canonical = await read('.rulegate/rules/30-server.md');
    expect(canonical).toContain('app/**');
    expect(canonical).toContain('## Server components\n\nUse them.');
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  it('does not copy the description heading into the body when the marker is off', async () => {
    const manifest = path.join(repo, '.rulegate/rulegate.yaml');
    await writeFile(
      manifest,
      `${await read('.rulegate/rulegate.yaml')}options:\n  marker: false\n`,
    );
    await writeFile(
      path.join(repo, '.rulegate/rules/30-frontend.md'),
      "---\ndescription: Frontend\nglobs:\n  - 'src/**/*.tsx'\n---\n\nPrefer server components.\n",
    );
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);

    const artifact = '.claude/rules/30-frontend.md';
    await writeFile(
      path.join(repo, artifact),
      (await read(artifact)).replace('Prefer server components.', 'Prefer RSC.'),
    );

    expect(await runSync({ cwd: repo, import: true, yes: true, quiet: true })).toBe(ExitCode.Ok);
    const canonical = await read('.rulegate/rules/30-frontend.md');
    expect(canonical).toContain('Prefer RSC.');
    expect(canonical).not.toContain('## Frontend');
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    expect(await read('AGENTS.md')).not.toMatch(/## Frontend[\s\S]*## Frontend/);
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  it('refuses a scoped rule file whose frontmatter no longer parses', async () => {
    const rule = '.rulegate/rules/30-frontend.md';
    await writeFile(
      path.join(repo, rule),
      "---\ndescription: Frontend\nglobs:\n  - 'src/**/*.tsx'\n---\n\nUse hooks.\n",
    );
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    const before = await read(rule);

    // An unquoted `*` opens a YAML alias: the whole file, marker and all, reads back as
    // one unscoped body, and merging it would write raw YAML into canonical.
    const artifact = '.claude/rules/30-frontend.md';
    await writeFile(
      path.join(repo, artifact),
      (await read(artifact))
        .replace('"src/components/**/*.tsx"', '**/*.tsx')
        .replace('"src/**/*.tsx"', '**/*.tsx'),
    );

    await runSync({ cwd: repo, import: true, yes: true });
    expect(await read(rule)).toBe(before);
    expect(stdout.join('') + stderr.join('')).toContain(artifact);
  });

  it('refuses broken frontmatter with the marker off, where no marker gives it away', async () => {
    await writeFile(
      path.join(repo, '.rulegate/rulegate.yaml'),
      `${await read('.rulegate/rulegate.yaml')}options:\n  marker: false\n`,
    );
    const rule = '.rulegate/rules/30-frontend.md';
    await writeFile(
      path.join(repo, rule),
      "---\ndescription: Frontend\nglobs:\n  - 'src/**/*.tsx'\n---\n\nUse hooks.\n",
    );
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    const before = await read(rule);

    const artifact = '.claude/rules/30-frontend.md';
    await writeFile(
      path.join(repo, artifact),
      (await read(artifact)).replace('"src/**/*.tsx"', '**/*.tsx'),
    );

    await runSync({ cwd: repo, import: true, yes: true });
    expect(await read(rule)).toBe(before);
    expect(stderr.join('')).toContain('unrecoverable');
  });

  // The edited heading is text the user typed. Handed to `String.replace` as a replacement
  // string, `$'` pasted the rest of the body into it and `$$` lost a dollar.
  it('carries an edited heading holding `$` patterns into canonical verbatim', async () => {
    const rule = '.rulegate/rules/30-price.md';
    await writeFile(
      path.join(repo, rule),
      "---\nglobs:\n  - 'src/**'\n---\n\n## Price\n\nCharge it.\n",
    );
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);

    const artifact = '.claude/rules/30-price.md';
    await writeFile(
      path.join(repo, artifact),
      (await read(artifact)).replace('## Price', () => "## Cost in US$' and $$5 and $&"),
    );

    expect(await runSync({ cwd: repo, import: true, yes: true, quiet: true })).toBe(ExitCode.Ok);
    expect(await read(rule)).toContain("\n## Cost in US$' and $$5 and $&\n\nCharge it.\n");
    expect(await read(rule)).not.toMatch(/Charge it\.[\s\S]*Charge it\./);
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  // A repository that uses Rulegate has a natural rule about the marker, and quoting it
  // is not the marker having leaked out of broken frontmatter.
  it('merges an edit to a rule whose own text quotes the marker', async () => {
    await writeFile(
      path.join(repo, rulePath),
      `${await read(rulePath)}\nNever edit a file headed \`<!-- generated by rulegate; edit .rulegate/ instead -->\`.\n`,
    );
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    await handEdit('CLAUDE.md', 'A line the user added by hand.');

    expect(await runSync({ cwd: repo, import: true, yes: true, quiet: true })).toBe(ExitCode.Ok);
    expect(await read(rulePath)).toContain('A line the user added by hand.');
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  // In a CLAUDE.md section, which has no frontmatter, a leading `---` is a horizontal rule.
  it('merges a horizontal rule at the start of a plain section body', async () => {
    await handEdit('CLAUDE.md', '---\n\nText after the rule.');

    expect(await runSync({ cwd: repo, import: true, yes: true, quiet: true })).toBe(ExitCode.Ok);
    expect(await read(rulePath)).toContain('---\n\nText after the rule.');
  });

  // An emptied `paths:` makes the rule repo-wide, and Claude Code renders a repo-wide rule
  // into CLAUDE.md. Merged, the edited file became a hand-edited orphan `sync` must refuse
  // to delete — even with --force — and the rule loaded from both files.
  it('refuses a scope edit that moves the rule out of the file the user edited', async () => {
    const rule = '.rulegate/rules/30-frontend.md';
    await writeFile(
      path.join(repo, rule),
      "---\ndescription: Frontend\nglobs:\n  - 'src/**/*.tsx'\n---\n\nUse hooks.\n",
    );
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
    const before = await read(rule);

    const artifact = '.claude/rules/30-frontend.md';
    await writeFile(
      path.join(repo, artifact),
      (await read(artifact)).replace(/^---\n[\s\S]*?\n---\n/, ''),
    );

    expect(await runSync({ cwd: repo, import: true, yes: true })).toBe(ExitCode.Failure);
    expect(await read(rule)).toBe(before);
    expect(stderr.join('')).toContain(artifact);
    expect(stderr.join('')).toContain('sync --force');

    // The recovery the refusal names does close the loop.
    expect(await runSync({ cwd: repo, force: true, quiet: true })).toBe(ExitCode.Ok);
    expect(await runCheck({ cwd: repo, quiet: true })).toBe(ExitCode.Ok);
  });

  it('refuses the same move the other way, a scope typed into CLAUDE.md', async () => {
    const before = await read(rulePath);
    await handEdit('CLAUDE.md', '**Applies to:** `src/**`');

    expect(await runSync({ cwd: repo, import: true, yes: true })).toBe(ExitCode.Failure);
    expect(await read(rulePath)).toBe(before);
    expect(stderr.join('')).toContain('moves rule `10-style` out of this file');
  });

  it('says so plainly when there is nothing to import', async () => {
    expect(await runSync({ cwd: repo, import: true })).toBe(ExitCode.Ok);
    expect(stdout.join('')).toContain('nothing to import');
  });

  it('agrees with check about which files are hand-edited', async () => {
    await handEdit('CLAUDE.md', 'one edit.');
    await runCheck({ cwd: repo });
    const checked = stdout.join('').includes('hand-edited  CLAUDE.md');
    stdout.length = 0;

    await runSync({ cwd: repo, import: true });
    // Both answers come from `verifyPlan`, so they cannot describe one file two ways —
    // an import that decided this question its own way could offer to merge a file
    // `check` calls clean.
    expect(checked).toBe(true);
    expect(stdout.join('')).toContain('CLAUDE.md');
  });
});

describe('sync --force covers hand-edited files (T075)', () => {
  it('overwrites the edit, but only after copying it to .rulegate/backup/', async () => {
    await handEdit('CLAUDE.md', 'about to be discarded.');
    const edited = await read('CLAUDE.md');

    // Without --force it is still refused: widening the flag must not widen the default.
    expect(await runSync({ cwd: repo, quiet: true })).toBe(ExitCode.Failure);
    expect(await read('CLAUDE.md')).toBe(edited);

    expect(await runSync({ cwd: repo, force: true, quiet: true })).toBe(ExitCode.Ok);
    expect(await read('CLAUDE.md')).not.toContain('about to be discarded.');
    // T020's rule: a destructive operation backs up first, and `restore` can undo it.
    expect(await read('.rulegate/backup/CLAUDE.md')).toBe(edited);
  });

  it('offers both recoveries when it refuses, not just the destructive one', async () => {
    await handEdit('CLAUDE.md', 'an edit worth keeping.');
    await runSync({ cwd: repo });

    const hints = stderr.join('');
    expect(hints).toContain('re-apply your edit in .rulegate/');
    expect(hints).toContain('--import');
  });
});
