#!/usr/bin/env node
/**
 * Structural validation for the Claude Code plugin under `plugins/rulegate/` (T103).
 *
 * Offline and unauthenticated, so CI can gate every push; `claude plugin validate` needs
 * the Claude Code CLI installed and is the maintainer's local complement, not a
 * replacement. Every check below is ported from agent-os's validator, where each one
 * exists because the thing it catches actually shipped broken:
 *
 * - An agent's frontmatter lost its closing `---` in a scripted edit, and Claude Code
 *   dropped every field at load time without a word.
 * - A JSON-escaped description put `—` into YAML, where it is six literal characters.
 * - `plugin.json` and `marketplace.json` drifted to different versions.
 * - A hook pointed at a script that had been deleted.
 * - A version was bumped without a changelog entry, twice.
 *
 * One addition for Rulegate: the plugin's version is the CLI's. They are released
 * together and described together, so a skew between them is a release that forgot one
 * half, and it fails here rather than reaching the marketplace.
 *
 * Usage: node scripts/validate-plugin.mjs [repoRoot]   — exit 0 clean, 1 on any failure.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN = 'plugins/rulegate';
const MARKETPLACE = '.claude-plugin/marketplace.json';
const CLI_PACKAGE = 'packages/cli/package.json';

/**
 * Parse an agent's or skill's frontmatter. Anchored at byte 0 and requiring a closing
 * delimiter on its own line: splitting on `---` cannot tell a missing closing delimiter
 * from a body that happens to contain a horizontal rule.
 */
function frontmatter(text) {
  if (!text.startsWith('---\n')) return { err: 'no opening --- at the start of the file' };
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return { err: 'no closing --- delimiter' };
  const block = text.slice(4, end + 1);
  const fields = {};
  for (const line of block.split('\n')) {
    const m = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) fields[m[1]] = m[2].trim();
    else if (line.trim() !== '' && !/^[ \t]/.test(line)) {
      return { err: `unparseable frontmatter line: ${line.slice(0, 40)}` };
    }
  }
  return { fields, block };
}

/** @returns {{ ok: string[], failures: string[] }} */
export function validatePlugin(repoRoot) {
  const ok = [];
  const failures = [];
  const check = (pass, good, badMessage) => (pass ? ok.push(good) : failures.push(badMessage));
  const abs = (rel) => path.join(repoRoot, rel);
  const read = (rel) => {
    try {
      return readFileSync(abs(rel), 'utf8');
    } catch {
      return null;
    }
  };
  const json = (rel) => {
    const text = read(rel);
    if (text === null) return { err: `${rel} is missing` };
    try {
      return { val: JSON.parse(text) };
    } catch (e) {
      return { err: `${rel}: ${e.message}` };
    }
  };
  const listDir = (rel) => (existsSync(abs(rel)) ? readdirSync(abs(rel)).sort() : []);

  // ---- manifests and versions ----
  const plugin = json(`${PLUGIN}/.claude-plugin/plugin.json`);
  const market = json(MARKETPLACE);
  const cli = json(CLI_PACKAGE);
  for (const m of [plugin, market, cli]) if (m.err) failures.push(m.err);

  if (plugin.val) {
    for (const field of ['name', 'description', 'version']) {
      check(plugin.val[field], `plugin.json has ${field}`, `plugin.json is missing ${field}`);
    }
    check(
      /^[a-z0-9-]+$/.test(plugin.val.name ?? ''),
      'plugin name is kebab-case',
      `plugin name "${plugin.val.name}" is not kebab-case`,
    );
    // Claude Code reads only plugin.json here; anything else is a file somebody expected
    // to take effect and it never will.
    const extra = listDir(`${PLUGIN}/.claude-plugin`).filter((f) => f !== 'plugin.json');
    check(
      extra.length === 0,
      '.claude-plugin holds only plugin.json',
      `${PLUGIN}/.claude-plugin should hold only plugin.json, found: ${extra.join(', ')}`,
    );
  }
  if (plugin.val && market.val) {
    const entry = (market.val.plugins ?? []).find((p) => p.name === plugin.val.name);
    check(
      entry,
      `marketplace lists "${plugin.val.name}"`,
      `${MARKETPLACE} has no plugin named "${plugin.val.name}"`,
    );
    if (entry) {
      check(
        entry.source === `./${PLUGIN}`,
        `marketplace source is ./${PLUGIN}`,
        `marketplace source is "${entry.source}", not "./${PLUGIN}"`,
      );
    }
    check(
      market.val.metadata?.version === plugin.val.version,
      `marketplace and plugin versions agree (${plugin.val.version})`,
      `version drift: plugin.json ${plugin.val.version} vs marketplace metadata ${market.val.metadata?.version}`,
    );
  }
  if (plugin.val && cli.val) {
    check(
      cli.val.version === plugin.val.version,
      `plugin version matches the CLI (${cli.val.version})`,
      `version drift: plugin.json ${plugin.val.version} vs ${CLI_PACKAGE} ${cli.val.version} — they release together`,
    );
  }

  // ---- changelog ----
  // Presence, not position: this repository keeps `## [Unreleased]` above the newest
  // version, so "newest entry equals the version" would fail every day between releases.
  const changelog = read('CHANGELOG.md');
  if (changelog === null) failures.push('CHANGELOG.md is missing');
  else if (plugin.val?.version) {
    const heads = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
    check(
      heads.includes(plugin.val.version),
      `CHANGELOG documents ${plugin.val.version}`,
      `CHANGELOG.md has no "## [${plugin.val.version}]" section`,
    );
  }

  // ---- agents ----
  // An empty directory is valid until T105 ports the agents; a malformed file never is.
  for (const f of listDir(`${PLUGIN}/agents`).filter((n) => n.endsWith('.md'))) {
    const stem = path.basename(f, '.md');
    const fm = frontmatter(read(`${PLUGIN}/agents/${f}`) ?? '');
    if (fm.err) {
      failures.push(`agents/${f}: ${fm.err}`);
      continue;
    }
    check(
      fm.fields.name === stem,
      `agents/${f}: name matches filename`,
      `agents/${f}: name "${fm.fields.name}" != filename "${stem}"`,
    );
    check(
      fm.fields.description,
      `agents/${f}: has description`,
      `agents/${f}: no description — it will not be selectable`,
    );
    check(
      fm.fields.memory === 'project',
      `agents/${f}: memory: project`,
      `agents/${f}: memory is "${fm.fields.memory}" — any other scope leaks one repository's knowledge into every other`,
    );
    check(
      !/\\u[0-9a-fA-F]{4}/.test(fm.block),
      `agents/${f}: no escaped unicode`,
      `agents/${f}: unicode escape sequence in frontmatter — write the real character`,
    );
  }

  // ---- skills ----
  for (const dir of listDir(`${PLUGIN}/skills`)) {
    if (!statSync(abs(`${PLUGIN}/skills/${dir}`)).isDirectory()) continue;
    const text = read(`${PLUGIN}/skills/${dir}/SKILL.md`);
    // agent-os skipped such a directory silently; a skill without SKILL.md is not a skill.
    if (text === null) {
      failures.push(`skills/${dir}: no SKILL.md`);
      continue;
    }
    const fm = frontmatter(text);
    if (fm.err) {
      failures.push(`skills/${dir}/SKILL.md: ${fm.err}`);
      continue;
    }
    check(fm.fields.description, `skills/${dir}: has description`, `skills/${dir}: no description`);
    check(
      !fm.fields.name || fm.fields.name === dir,
      `skills/${dir}: name consistent`,
      `skills/${dir}: frontmatter name "${fm.fields.name}" != directory name`,
    );
  }

  // ---- hooks ----
  const hooksRel = `${PLUGIN}/hooks/hooks.json`;
  if (existsSync(abs(hooksRel))) {
    const hooks = json(hooksRel);
    if (hooks.err) failures.push(hooks.err);
    else {
      for (const [event, entries] of Object.entries(hooks.val.hooks ?? {})) {
        for (const hook of entries.flatMap((e) => e.hooks ?? [])) {
          // Installed plugins run from Claude Code's cache, so a path relative to the
          // project, or an absolute one from the author's machine, resolves to nothing.
          const m = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"']+)/.exec(hook.command ?? '');
          if (!m) {
            failures.push(
              `${event}: command does not use \${CLAUDE_PLUGIN_ROOT} — it will not resolve once installed`,
            );
            continue;
          }
          check(
            existsSync(abs(`${PLUGIN}/${m[1]}`)),
            `${event} -> ${m[1]}`,
            `${event} -> ${m[1]} does not exist`,
          );
        }
      }
    }
  }

  // ---- leak check ----
  // Examples in a public plugin must be invented, never lifted from a codebase the author
  // happens to have open. That cannot be checked generically, so a maintainer keeps a local,
  // git-ignored `.leakcheck` — one term per line — and the terms never enter the repository.
  const leak = read('.leakcheck');
  if (leak !== null) {
    const terms = leak
      .split('\n')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l !== '' && !l.startsWith('#'));
    const files = [MARKETPLACE];
    (function walk(rel) {
      for (const name of listDir(rel)) {
        const child = `${rel}/${name}`;
        if (name === 'node_modules') continue;
        if (statSync(abs(child)).isDirectory()) walk(child);
        else if (/\.(md|mjs|js|ts|json|ya?ml)$/.test(name)) files.push(child);
      }
    })(PLUGIN);
    let hits = 0;
    for (const f of files) {
      const body = (read(f) ?? '').toLowerCase();
      for (const term of terms) {
        if (body.includes(term)) {
          failures.push(
            `${f} contains "${term}" — examples must be invented, not lifted from a real codebase`,
          );
          hits++;
        }
      }
    }
    if (hits === 0) ok.push(`no leaked identifiers (${terms.length} term(s) checked)`);
  }

  return { ok, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = process.argv[2]
    ? path.resolve(process.argv[2])
    : fileURLToPath(new URL('../', import.meta.url));
  const { ok, failures } = validatePlugin(repoRoot);
  for (const line of ok) console.log(`  ok    ${line}`);
  for (const line of failures) console.log(`  FAIL  ${line}`);
  console.log(
    `\n${failures.length > 0 ? 'FAILED' : 'PASSED'}  ${ok.length}/${ok.length + failures.length} checks`,
  );
  process.exitCode = failures.length > 0 ? 1 : 0;
}
