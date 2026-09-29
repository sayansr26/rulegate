#!/usr/bin/env node
// Lay out the published Action for its own repository, sayansr26/rulegate-action.
//
//   node scripts/stage-action-repo.mjs <dir>           write the files into <dir>
//   node scripts/stage-action-repo.mjs <dir> --check   exit 1 if <dir> is out of date
//
// GitHub Marketplace lists only an `action.yml` at a repository's root, and ours lives in
// `action/` here, so the listing comes from a second repository holding the built Action and
// nothing else (T047a). This script is the one definition of what that repository contains,
// so each release refreshes it the same way. It touches no git: committing and tagging the
// other repository are the maintainer's.
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const [target, ...flags] = process.argv.slice(2);
const check = flags.includes('--check');
if (!target) {
  process.stderr.write('usage: stage-action-repo.mjs <dir> [--check]\n');
  process.exit(2);
}

const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p));

// The bundle is ESM, and a `.js` file is CommonJS unless the nearest package.json says
// otherwise — without this file the runner fails on the bundle's first import.
const manifest = `${JSON.stringify(
  {
    name: 'rulegate-action',
    private: true,
    type: 'module',
    description: 'Published build of the Rulegate check GitHub Action.',
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/sayansr26/rulegate.git' },
  },
  null,
  2,
)}\n`;

const files = new Map([
  ['action.yml', read('action/action.yml')],
  ['dist/main.js', read('action/dist/main.js')],
  ['package.json', Buffer.from(manifest)],
  ['README.md', read('action/README.md')],
  ['LICENSE', read('LICENSE')],
]);

const out = resolve(target);
const stale = [];
for (const [rel, bytes] of files) {
  const dest = join(out, rel);
  const same = existsSync(dest) && readFileSync(dest).equals(bytes);
  if (check) {
    if (!same) stale.push(rel);
    continue;
  }
  if (same) continue;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, bytes);
  process.stdout.write(`wrote  ${rel}\n`);
}

if (check) {
  if (stale.length > 0) {
    process.stderr.write(`out of date: ${stale.join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`${out} is up to date (${files.size} files)\n`);
}
