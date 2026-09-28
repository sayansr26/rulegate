#!/usr/bin/env node
// Bump every release manifest to one version and close CHANGELOG's [Unreleased].
//
//   node .claude/skills/release/bump.mjs <version> [--date YYYY-MM-DD] [--yes]
//
// Prints the change set and writes nothing without --yes, like every other command in this
// repository that touches files. Versions are edited in place with a string replace rather
// than JSON.stringify, so each manifest keeps its bytes apart from the one value; the
// validator and release.yml's tag check then hold because every manifest moved together.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { manifests, root, status } from '../../hooks/release-status.mjs';

const args = process.argv.slice(2);
const version = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));
const yes = args.includes('--yes');
const dateAt = args.indexOf('--date');
const date = dateAt === -1 ? new Date().toISOString().slice(0, 10) : args[dateAt + 1];

if (!version || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) {
  process.stderr.write('usage: bump.mjs <x.y.z> [--date YYYY-MM-DD] [--yes]\n');
  process.exit(2);
}

const s = status();
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
const refuse = [
  ...s.gates.filter((g) => !g.passed).map((g) => `release gate ${g.id} is ${g.status}`),
  ...(newer(version, s.version) ? [] : [`${version} is not newer than ${s.version}`]),
  ...(s.unreleased.entries === 0 ? ['CHANGELOG [Unreleased] is empty'] : []),
];
if (refuse.length) {
  process.stderr.write(`refused:\n${refuse.map((r) => `  - ${r}`).join('\n')}\n`);
  process.exit(1);
}

const edits = [];
for (const m of manifests()) {
  const file = join(root, m.path);
  const text = readFileSync(file, 'utf8');
  // The first "version" key: top-level in package.json and plugin.json, metadata's in
  // marketplace.json, which has no other.
  const next = text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`);
  if (next !== text) edits.push({ path: m.path, from: m.version, text: next });
}

const logPath = join(root, 'CHANGELOG.md');
const log = readFileSync(logPath, 'utf8');
const prev = s.lastTag ?? `v${s.version}`;
let nextLog = log.replace(/^## \[Unreleased\]$/m, `## [Unreleased]\n\n## [${version}] — ${date}`);
nextLog = nextLog.replace(
  /^\[unreleased\]: (.+\/compare\/)v[^.\s]+\.[^.\s]+\.[^.\s]+\.\.\.HEAD$/m,
  `[unreleased]: $1v${version}...HEAD\n[${version}]: $1${prev}...v${version}`,
);
if (nextLog !== log) edits.push({ path: 'CHANGELOG.md', from: '[Unreleased]', text: nextLog });

for (const e of edits)
  process.stdout.write(`${yes ? 'wrote' : 'would write'}  ${e.path}  (${e.from} → ${version})\n`);
if (!yes) {
  process.stdout.write(`\npreview — nothing written; re-run with --yes\n`);
  process.exit(0);
}
for (const e of edits) writeFileSync(join(root, e.path), e.text);
