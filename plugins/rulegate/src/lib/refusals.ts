import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { STATE_PATH, findRepoRoot, parseState } from '@rulegate/core';
import { guard } from './guard.js';
import { exists, isUtf8File, read } from './read.js';
import { ruleTarget, type Refusal, type Scope, type ScopePlan } from './settings.js';

/**
 * What the settings writer refuses, and why — read-only, so the preview, the setup state
 * and the writer ask one question. Before this lived here the writer alone knew it, and
 * the preview promised "would add" for a symlinked `~/.claude/settings.json` while the setup
 * state sent the user back to a pass that refused it on every run.
 *
 * Refused, per item and without touching the file:
 *
 *   - a plan that cannot merge (invalid JSON) or would replace a canonical rule (`exists`);
 *   - a symlink anywhere between the project root and a project target, which is also what
 *     keeps a project write inside the repository — `.claude -> ~/somewhere` would otherwise
 *     turn "the project's settings" into any file the repository names;
 *   - a symlinked user-scope file (a dotfiles link): replacing it would cut the link, and
 *     writing through it would edit a file the pass never planned;
 *   - a path `.rulegate/state.json` records. A generated file is `sync`'s, and the guard
 *     answers that exactly as the PreToolUse hook does — except that a `state.json` that
 *     does not parse refuses here, where the hook lets the edit through;
 *   - a project target inside the Claude config dir: started in `$HOME`, "the project's
 *     `.claude/settings.json`" is the user's, and the project pass would change it with no
 *     backup — the user pass covers it, backup first;
 *   - a file that exists but cannot be read (permissions, or over `MAX_READ_BYTES`). The
 *     planner sees it as absent and plans a fresh file, which would replace the user's;
 *   - a file that is not UTF-8. The planner's text has U+FFFD where its bytes were, and
 *     writing that back is a loss no backup should be needed to undo.
 */

/** `realpath` of the nearest existing ancestor, plus the segments below it. */
function real(p: string): string {
  const rest: string[] = [];
  let at = p;
  for (;;) {
    try {
      return join(realpathSync.native(at), ...rest.reverse());
    } catch {
      const up = dirname(at);
      if (up === at) return p;
      rest.push(basename(at));
      at = up;
    }
  }
}

function inside(dir: string, abs: string): boolean {
  const rel = relative(real(dir), real(abs));
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * The PreToolUse guard fails open on a `state.json` that does not parse — blocking every
 * edit until someone fixes a merge conflict would be worse than no guard. A writer has the
 * opposite trade: refusing costs a re-run, and writing costs a generated file that the next
 * `sync` calls hand-edited. Empty is core's "nothing recorded", not a broken record.
 */
function unreadableState(abs: string): boolean {
  const state = join(findRepoRoot(dirname(abs)), STATE_PATH);
  if (!exists(state)) return false;
  const text = read(state);
  return text?.trim() !== '' && parseState(text) === undefined;
}

/** Why `abs` must not be written, or `undefined` when it may be. */
export async function blocked(
  scope: Scope,
  root: string,
  claudeDir: string,
  abs: string,
): Promise<string | undefined> {
  if (scope === 'project') {
    if (inside(claudeDir, abs)) {
      return 'this is the user-level Claude config — `--scope user` changes it, backup first';
    }
    // Every component that exists below the root must be a real directory, and the target
    // itself a regular file. `root` is exempt: a repository checked out under a symlinked
    // path (`/var` on macOS) is still the repository.
    const rel = relative(root, abs);
    let at = root;
    for (const part of rel.split(sep)) {
      at = join(at, part);
      if (!exists(at)) break;
      const st = lstatSync(at);
      if (st.isSymbolicLink()) return `${relative(root, at)} is a symlink`;
      if (at !== abs && !st.isDirectory()) return `${relative(root, at)} is not a directory`;
      if (at === abs && !st.isFile()) return 'not a regular file';
    }
  } else if (exists(abs)) {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return 'a symlink — edit the file it points at by hand';
    if (!st.isFile()) return 'not a regular file';
  }
  if (exists(abs) && read(abs) === undefined) {
    return 'could not be read (permissions, or larger than 4 MB) — left as it is';
  }
  if (exists(abs) && !isUtf8File(abs)) {
    return 'not UTF-8 text — rewriting it would replace the bytes it cannot decode';
  }
  if (unreadableState(abs)) {
    return '.rulegate/state.json does not parse, so ownership cannot be checked — fix it first';
  }
  if ((await guard(abs))?.kind === 'deny') {
    return 'generated by Rulegate (recorded in .rulegate/state.json)';
  }
  return undefined;
}

/** Every item of `plan` the writer would refuse. An item with nothing to change is never one. */
export async function refusals(
  plan: ScopePlan,
  root: string,
  claudeDir: string,
): Promise<Refusal[]> {
  const out: Refusal[] = [];
  const s = plan.settings;
  if (s.status === 'invalid') {
    out.push({ item: 'settings', file: plan.settingsFile, reason: 'not valid JSON' });
  } else if (s.status === 'changed') {
    const why = await blocked(plan.scope, root, claudeDir, plan.settingsFile);
    if (why !== undefined) out.push({ item: 'settings', file: plan.settingsFile, reason: why });
  }
  const r = plan.rule;
  if (r.status === 'exists') {
    out.push({ item: 'rule', file: r.file, reason: 'exists without the task-tracking rule' });
  } else if (r.status === 'add') {
    const why = await blocked(plan.scope, root, claudeDir, ruleTarget(plan.scope, root, claudeDir));
    if (why !== undefined) out.push({ item: 'rule', file: r.file, reason: why });
  }
  return out;
}
