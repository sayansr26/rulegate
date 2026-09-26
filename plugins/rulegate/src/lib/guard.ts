import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  STATE_PATH,
  findArtifact,
  findRepoRoot,
  parseState,
  pathKeyFor,
  probeCaseInsensitive,
  type DirEntry,
  type ReadOnlyFileSystem,
  type StateFile,
} from '@rulegate/core';
import { firstInSession } from '../session/marker.js';
import { pluginConfig } from './config.js';
import { featureOf, findMap, mapFiles, tracked } from './features.js';
import { read } from './read.js';
import { inline } from './session.js';

/**
 * The PreToolUse hook's two jobs (T108), both at the moment an edit happens — a CLAUDE.md
 * sentence read an hour ago loses to whatever else is in context:
 *
 *   1. **Generated-file guard (blocks).** An edit to a path `.rulegate/state.json` records
 *      is denied. `state.json` is Rulegate's only ownership record, so the guard asks it
 *      exactly as `sync` does — `parseState`, `findArtifact`, and T085's case-folded identity
 *      where the filesystem folds case — from `@rulegate/core`, bundled (decision P2). A
 *      second ownership model in a hook is the thing that would eventually disagree.
 *   2. **Cartographer reminder (advisory).** The first edit to an existing feature with no
 *      map, once per feature per session, suggests asking the cartographer first.
 *
 * Every error means "say nothing": the one deliberate way this hook affects a session is
 * the deny.
 */

export type Decision =
  | { readonly kind: 'deny'; readonly reason: string }
  | { readonly kind: 'context'; readonly text: string };

/**
 * `realpath`, or its parent's `realpath` plus the name, for a file that does not exist yet.
 * The native form, because it returns the casing on disk: the JavaScript form keeps the
 * casing it was given, so on a case-insensitive filesystem `/Repo` and `/repo` would compute
 * as two trees and an edit spelled the other way would walk out of the repository — and past
 * the guard.
 */
function realish(p: string): string {
  // The nearest ancestor that exists, resolved, plus the segments below it. Resolving only
  // the parent was not enough: a recorded `.cursor/rules/a.mdc` with no `.cursor/` on disk
  // kept its unresolved `/var/…` prefix on macOS, computed as outside the repository's
  // `/private/var/…` root, and a Write recreating it walked past the guard.
  const rest: string[] = [];
  let dir = p;
  for (let i = 0; i < 256; i++) {
    try {
      return join(realpathSync.native(dir), ...[...rest].reverse());
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return p;
      rest.push(basename(dir));
      dir = parent;
    }
  }
  return p;
}

/** Repo-relative POSIX path, or `undefined` when `abs` is not inside `root`. */
function within(root: string, abs: string): string | undefined {
  const rel = relative(root, abs);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/** The two methods `probeCaseInsensitive` asks of a filesystem, over the repository root. */
function probeView(root: string): Pick<ReadOnlyFileSystem, 'listDir' | 'exists'> {
  return {
    listDir: (rel) =>
      Promise.resolve(
        readdirSync(join(root, rel), { withFileTypes: true }).map((e): DirEntry => ({
          name: e.name,
          kind: e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'dir' : 'file',
        })),
      ),
    exists: (rel) => Promise.resolve(existsSync(join(root, rel))),
  };
}

/**
 * Which repository owns `abs`, asked the way the CLI asks it: core's `findRepoRoot`, from
 * the file's own directory. That makes `.git` the boundary, so an edit in a sibling
 * repository or a nested one is judged by *its* `state.json`, and a `.rulegate/` that is
 * test data inside another repository — `fixtures/doctor/adopted/` here — is never taken
 * for the owner.
 */
function ownerOf(abs: string): { root: string; state: StateFile } | undefined {
  const root = findRepoRoot(dirname(abs));
  // Unreadable state (a merge conflict, typically) records nothing, and denies nothing:
  // `rulegate check` reports the broken file, and a guard that blocked every edit until
  // then would be worse than none.
  const state = parseState(read(join(root, STATE_PATH)));
  return state === undefined ? undefined : { root, state };
}

async function judge(abs: string): Promise<Decision | undefined> {
  const owner = ownerOf(abs);
  if (owner === undefined) return undefined;
  const rel = within(owner.root, abs);
  if (rel === undefined) return undefined;
  const key = pathKeyFor(await probeCaseInsensitive(probeView(owner.root)));

  // The ownership record and the backups are `sync`'s own bookkeeping. A hand edit to
  // `state.json` is how Rulegate comes to call its own artifact somebody else's. Keyed like
  // every other lookup, so `.Rulegate/STATE.json` is the same file where the disk says so.
  if (key(rel) === key(STATE_PATH) || key(rel).startsWith(key('.rulegate/backup/'))) {
    return {
      kind: 'deny',
      reason: `${inline(rel)} is maintained by \`rulegate sync\` and \`rulegate restore\`, not by hand. Edit .rulegate/rules/ and run \`rulegate sync\`.`,
    };
  }
  const artifact = findArtifact(owner.state, rel, key);
  if (artifact === undefined) return undefined;
  return {
    kind: 'deny',
    reason:
      `${inline(artifact.path)} is generated by Rulegate (${inline(artifact.adapter)}) from .rulegate/rules/, ` +
      'and the next `rulegate sync` would revert this edit. Make the change in the rule that produces it, ' +
      'then run `rulegate sync`. If the file already carries a hand-edit worth keeping, `rulegate sync --import` merges it back into the rule.',
  };
}

/**
 * Judge both spellings of the target and deny if either is a recorded artifact. The textual
 * one (`path.resolve`) is what the edit tool itself computes, so `dir/link/../CLAUDE.md`
 * means the repository's `CLAUDE.md`; the real one sees through symlinks and, from
 * `realpathSync.native`, has the casing on disk. Either alone missed an edit the other
 * caught.
 */
export async function guard(targetAbs: string): Promise<Decision | undefined> {
  const spellings = [...new Set([resolve(targetAbs), realish(targetAbs)])];
  for (const abs of spellings) {
    const decision = await judge(abs);
    if (decision !== undefined) return decision;
  }
  return undefined;
}

export async function reminder(
  targetAbs: string,
  projectDir: string,
  sessionId: string,
  first: (session: string, key: string) => boolean = firstInSession,
): Promise<Decision | undefined> {
  if (pluginConfig(projectDir).cartographerReminder === false) return undefined;
  const rel = within(realish(projectDir), realish(targetAbs));
  if (rel === undefined) return undefined;
  const feature = featureOf(projectDir, rel);
  if (feature === undefined) return undefined;
  if (findMap(feature, mapFiles(projectDir)) !== undefined) return undefined;
  // A feature git has never seen is being created, not changed; there is nothing to map.
  if (!(await tracked(projectDir, feature.dir))) return undefined;
  if (!first(sessionId, feature.dir)) return undefined;
  const dir = inline(feature.dir);
  return {
    kind: 'context',
    text:
      `Rulegate (advisory): ${dir}/ is an existing feature with no cartographer map. ` +
      `Before changing it further, ask rulegate:feature-cartographer how "${inline(feature.name)}" is built — ` +
      'it answers and files the map for every later session. This applies in plan mode too ' +
      '(ask it read-only; it files the map after plan mode ends). Shown once per feature per session.',
  };
}
