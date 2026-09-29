#!/usr/bin/env node
// Verify a release against the registry, not against the publish step's exit code.
//
//   node scripts/verify-published.mjs <version> [--attestations]
//
// Every non-private workspace package must answer `<version>` on npm, and with
// --attestations must carry a provenance attestation. Both are read back from the registry
// because a green publish step has already lied once here: `pnpm publish --provenance` exited 0
// for 0.3.0 and 0.4.0 and signed nothing (T092). The registry also lags a fresh publish by
// minutes for packages that already had versions, so each package is retried for a while
// before it counts as missing.
//
// Repo tooling, run by release.yml after publishing: it is the one place in the repository
// allowed to reach the network, and it only reads.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2];
const wantAttestations = process.argv.includes('--attestations');
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  process.stderr.write('usage: verify-published.mjs <x.y.z> [--attestations]\n');
  process.exit(2);
}

const root = new URL('..', import.meta.url).pathname;
const dirs = [
  ...readdirSync(join(root, 'packages'))
    .filter((d) => d !== 'adapters')
    .map((d) => join(root, 'packages', d)),
  ...readdirSync(join(root, 'packages/adapters')).map((d) => join(root, 'packages/adapters', d)),
];
const names = dirs
  .map((d) => join(d, 'package.json'))
  .filter((f) => existsSync(f))
  .map((f) => JSON.parse(readFileSync(f, 'utf8')))
  .filter((p) => !p.private)
  .map((p) => p.name)
  .sort();

// `npm` is `npm.cmd` on Windows, which execFileSync cannot run without a shell.
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
function view(name) {
  try {
    const out = execFileSync(npm, ['view', `${name}@${version}`, 'version', 'dist', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: process.platform === 'win32',
    });
    return out.trim() === '' ? undefined : JSON.parse(out);
  } catch {
    return undefined;
  }
}

const ok = (info) =>
  info !== undefined &&
  info.version === version &&
  (!wantAttestations || Boolean(info.dist?.attestations?.url));

// 40 × 30s: the registry took about five minutes for 0.4.0. Overridable to check a version
// that is already settled without waiting out the retries.
const ATTEMPTS = Number(process.env.VERIFY_PUBLISHED_ATTEMPTS ?? 40);
let pending = names;
for (let attempt = 1; attempt <= ATTEMPTS && pending.length > 0; attempt++) {
  pending = pending.filter((name) => !ok(view(name)));
  if (pending.length > 0 && attempt < ATTEMPTS) {
    process.stdout.write(
      `waiting on ${pending.length} package(s), attempt ${attempt}/${ATTEMPTS}\n`,
    );
    execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  }
}

if (pending.length > 0) {
  for (const name of pending) {
    const info = view(name);
    const why =
      info?.version !== version
        ? `not at ${version}`
        : 'published without a provenance attestation';
    process.stderr.write(`${name}: ${why}\n`);
  }
  process.exit(1);
}
process.stdout.write(
  `${names.length} package(s) at ${version}${wantAttestations ? ', each with a provenance attestation' : ''}\n`,
);
