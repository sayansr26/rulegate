#!/usr/bin/env node
// SessionStart: say when a release is due, and what still blocks it.
//
// A release here is a tag push that `release.yml` turns into 18 npm packages and a
// marketplace version, and npm versions are immutable — so the two failure modes are
// releasing too early (before a milestone gate like T109 has passed) and forgetting to
// release at all while CHANGELOG's [Unreleased] grows. This reports both, offline: it
// reads the tree and runs read-only git, never npm, because a hook that needs the network
// fails exactly when it is least wanted.
//
// Silent when nothing is unreleased. `--json` prints the full status for /release.
// Never fails the session: any error exits 0 with no output.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Tasks in task-breakdown.md that must be COMPLETED before the next release. Edit as
// milestones change. Empty for v0.4.0 by maintainer decision (2026-09-28): it ships
// unannounced so T032's recruits get the T124/T115/T148 fixes, before T109 has proven the
// agent-os migration; T109 still gates the announced launch (T156 onwards).
const RELEASE_GATES = [];

export const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function git(...args) {
  try {
    return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
    }).trim();
  } catch {
    return undefined;
  }
}

export const readJson = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));

// Every manifest that carries the release version. The Action versions on its own
// (action/package.json, private) and is deliberately absent.
export function manifests() {
  const out = [];
  const add = (p, version) => out.push({ path: p, version });
  const pkg = (p) => existsSync(join(root, p)) && add(p, readJson(p).version);
  for (const dir of readdirSync(join(root, 'packages'))) {
    if (dir === 'adapters') continue;
    pkg(`packages/${dir}/package.json`);
  }
  for (const dir of readdirSync(join(root, 'packages/adapters'))) {
    pkg(`packages/adapters/${dir}/package.json`);
  }
  pkg('plugins/rulegate/package.json');
  add(
    'plugins/rulegate/.claude-plugin/plugin.json',
    readJson('plugins/rulegate/.claude-plugin/plugin.json').version,
  );
  add(
    '.claude-plugin/marketplace.json',
    readJson('.claude-plugin/marketplace.json').metadata?.version,
  );
  return out.filter((m) => m.path);
}

// The [Unreleased] section: its bullet count and which ### headings it has, since the
// headings decide the bump.
function unreleased() {
  const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');
  const start = text.indexOf('\n## [Unreleased]');
  if (start === -1) return { entries: 0, sections: [] };
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n## [', 1);
  const body = next === -1 ? rest : rest.slice(0, next);
  return {
    entries: (body.match(/^- /gm) ?? []).length,
    sections: [...body.matchAll(/^### (.+)$/gm)].map((m) => m[1].trim()),
  };
}

function gateStatus() {
  const file = join(root, 'task-breakdown.md');
  if (!existsSync(file)) return [];
  const text = readFileSync(file, 'utf8');
  return RELEASE_GATES.map((id) => {
    const at = text.indexOf(`\n### ${id}:`);
    const status =
      at === -1
        ? 'missing'
        : (/\*\*Status\*\*:\s*(\S+)/.exec(text.slice(at, at + 400))?.[1] ?? 'unknown');
    return { id, status, passed: status === 'COMPLETED' };
  });
}

function suggestBump(version, sections) {
  const [major, minor, patch] = version.split('.').map(Number);
  const has = (s) => sections.some((x) => x.toLowerCase() === s);
  // Pre-1.0, a breaking change moves the minor, as 0.2.0 → 0.3.0 did.
  if (has('breaking')) return major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
  if (has('added')) return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function status() {
  const tag = git('describe', '--tags', '--abbrev=0', '--match', 'v*');
  const since = tag ? Number(git('rev-list', '--count', `${tag}..HEAD`) ?? 0) : undefined;
  const all = manifests();
  const versions = [...new Set(all.map((m) => m.version))];
  const version = readJson('packages/cli/package.json').version;
  const log = unreleased();
  const gates = gateStatus();
  const dirty = (git('status', '--porcelain') ?? '').split('\n').filter(Boolean).length;
  const blockers = [
    ...gates.filter((g) => !g.passed).map((g) => `${g.id} is ${g.status}`),
    ...(versions.length > 1 ? [`manifests disagree: ${versions.join(', ')}`] : []),
    ...(tag && `v${version}` !== tag
      ? [`manifests are at ${version} but the last tag is ${tag}; a bump is already in progress`]
      : []),
  ];
  return {
    lastTag: tag,
    commitsSinceTag: since,
    version,
    manifests: all,
    unreleased: log,
    gates,
    uncommittedFiles: dirty,
    due: (since ?? 0) > 0 && log.entries > 0,
    blockers,
    suggestedVersion: suggestBump(version, log.sections),
  };
}

// Imported by .claude/skills/release/bump.mjs for the same facts; runs only as a script.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const s = status();
    if (process.argv.includes('--json')) {
      process.stdout.write(JSON.stringify(s, null, 2) + '\n');
    } else if (s.due) {
      const head = `Release: ${s.commitsSinceTag} commit(s) and ${s.unreleased.entries} CHANGELOG entr${s.unreleased.entries === 1 ? 'y' : 'ies'} since ${s.lastTag} (${s.unreleased.sections.join(', ')}).`;
      const tail = s.blockers.length
        ? `Not yet: ${s.blockers.join('; ')}. Do not bump or tag until these clear.`
        : `Ready to cut v${s.suggestedVersion} — run /release when the maintainer asks.`;
      process.stdout.write(`${head}\n${tail}\n`);
    }
  } catch {
    // A status line is never worth a broken session.
  }
  process.exit(0);
}
