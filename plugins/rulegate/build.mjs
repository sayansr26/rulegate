import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * Bundle the plugin's hook and skill scripts into the committed `dist/` (T104).
 *
 * Claude Code runs a plugin's hooks from its plugin cache, a copy of this directory with
 * no `npm install` ever run in it, so a hook cannot import `@rulegate/core` or anything
 * else at run time. The choice was dependency-free `.mjs` or TypeScript bundled here, and
 * it is bundled: the PreToolUse guard has to answer "did Rulegate generate this path?"
 * exactly as `sync` does — `state.json` parsing, and T085's case-insensitive path identity
 * — and a hand-written second copy of that in a hook is a second ownership model, which is
 * the thing that eventually disagrees with the first.
 *
 * **Every top-level `src/*.ts` is an entry**, bundled on its own to `dist/<name>.js`;
 * subdirectories of `src/` are libraries the entries import. A hook is added by adding a
 * file, not by editing this script. With no entries yet (T107/T108 add the first), the
 * build produces nothing and `--check` asserts `dist/` holds nothing.
 *
 * Same discipline as `action/build.mjs`, for the same reasons: `absWorkingDir` is pinned
 * because esbuild writes module paths into the output relative to it, and `--check`
 * compares a fresh in-memory build against the committed files byte for byte.
 */
const here = fileURLToPath(new URL('.', import.meta.url));
const srcDir = path.join(here, 'src');
const distDir = path.join(here, 'dist');

const entries = (await readdir(srcDir, { withFileTypes: true }))
  .filter((e) => e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.test.ts'))
  .map((e) => path.join(srcDir, e.name))
  .sort();

/** @type {Map<string, string>} dist-relative POSIX path -> contents */
const fresh = new Map();
if (entries.length > 0) {
  const result = await build({
    entryPoints: entries,
    absWorkingDir: here,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    legalComments: 'none',
    entryNames: '[name]',
    outdir: distDir,
    write: false,
  });
  for (const file of result.outputFiles) {
    fresh.set(path.relative(distDir, file.path).split(path.sep).join('/'), file.text);
  }
}

async function committed(dir = distDir, prefix = '') {
  /** @type {Map<string, string>} */
  const out = new Map();
  let names;
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of names) {
    const rel = prefix + entry.name;
    if (entry.isDirectory()) {
      for (const [k, v] of await committed(path.join(dir, entry.name), `${rel}/`)) out.set(k, v);
    } else {
      out.set(rel, await readFile(path.join(dir, entry.name), 'utf8'));
    }
  }
  return out;
}

/**
 * `--check` is the CI gate. A stale bundle is worse than none: the hook keeps running and
 * keeps enforcing an older commit's rules. A file left in `dist/` by a deleted entry is
 * stale too — the validator would still let `hooks.json` point at it.
 */
if (process.argv.includes('--check')) {
  const onDisk = await committed();
  const problems = [];
  for (const [rel, text] of fresh) {
    if (!onDisk.has(rel)) problems.push(`missing  dist/${rel}`);
    else if (onDisk.get(rel) !== text) problems.push(`stale    dist/${rel}`);
  }
  for (const rel of onDisk.keys()) {
    if (!fresh.has(rel)) problems.push(`orphan   dist/${rel}`);
  }
  if (problems.length === 0) {
    console.log(`plugins/rulegate/dist is up to date (${String(fresh.size)} bundle(s))`);
    process.exit(0);
  }
  for (const p of problems.sort()) console.error(p);
  console.error('plugins/rulegate/dist does not match a fresh build of plugins/rulegate/src.');
  console.error('run: pnpm --filter @rulegate/claude-code-plugin build   and commit the result');
  process.exit(1);
}

await rm(distDir, { recursive: true, force: true });
for (const [rel, text] of [...fresh].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
  const target = path.join(distDir, rel);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text);
  console.log(`plugins/rulegate/dist/${rel}  ${String(text.length)} bytes`);
}
if (fresh.size === 0) console.log('plugins/rulegate: no entries in src/, nothing to bundle');
