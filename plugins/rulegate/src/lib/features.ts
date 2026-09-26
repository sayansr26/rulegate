import { join } from 'node:path';
import { runGit } from '../git/index.js';
import { pluginConfig } from './config.js';
import { isDir, ls, read } from './read.js';

/**
 * What counts as a feature, and which features the cartographer has mapped.
 *
 * Shared by the session hook, the pre-edit hook and the audit so the three never disagree
 * about coverage. Read-only and never throws. Feature directories come from
 * `.claude/rulegate.json`'s `features` (`<dir>/*`: every direct subdirectory of `<dir>` is a
 * feature); with none configured, the first of `DEFAULT_PARENTS` that exists is used.
 */

export const DEFAULT_PARENTS = [
  'src/features',
  'src/modules',
  'app/features',
  'features',
  'modules',
] as const;

/**
 * Where the cartographer's memory may be, most specific first. A plugin agent's memory
 * directory carries the plugin's name; the `agent-os-` directory is what an agent-os
 * install left behind, read until T114 migrates it; the bare name is a standalone copy.
 */
export const CARTOGRAPHER_DIRS = [
  'rulegate-feature-cartographer',
  'agent-os-feature-cartographer',
  'feature-cartographer',
] as const;

export interface Feature {
  readonly name: string;
  readonly dir: string;
}

export interface MapFile {
  readonly file: string;
  readonly text: string;
  readonly mapped: string | undefined;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The parent directories whose children are features, relative to root. */
export function featureParents(root: string): string[] {
  const configured = pluginConfig(root).features;
  if (configured && configured.length > 0) {
    return configured.map((g) => g.replace(/\/\*+$/, '').replace(/\/$/, '')).filter(Boolean);
  }
  const found = DEFAULT_PARENTS.find((d) => isDir(join(root, d)));
  return found ? [found] : [];
}

/** Enough for any real project; a bound so a huge parent cannot outlast a hook timeout. */
export const MAX_FEATURES = 500;

export function listFeatures(root: string): Feature[] {
  const out: Feature[] = [];
  for (const parent of featureParents(root)) {
    for (const name of ls(join(root, parent))) {
      if (out.length >= MAX_FEATURES) return out;
      if (!name.startsWith('.') && isDir(join(root, parent, name))) {
        out.push({ name, dir: `${parent}/${name}` });
      }
    }
  }
  return out;
}

/** The feature a repo-relative POSIX path belongs to. */
export function featureOf(root: string, relPath: string): Feature | undefined {
  for (const parent of featureParents(root)) {
    const m = new RegExp(`^${escape(parent)}/([^/]+)/`).exec(relPath);
    if (m?.[1] !== undefined) return { name: m[1], dir: `${parent}/${m[1]}` };
  }
  return undefined;
}

/** The cartographer's memory directory, absolute. */
export function cartographerDir(root: string): string | undefined {
  for (const base of ['.claude/agent-memory', '.claude/agent-memory-local']) {
    for (const name of CARTOGRAPHER_DIRS) {
      const dir = join(root, base, name);
      if (isDir(dir)) return dir;
    }
  }
  return undefined;
}

export function mapFiles(root: string): MapFile[] {
  const dir = cartographerDir(root);
  if (dir === undefined) return [];
  return ls(dir)
    .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
    .map((file) => {
      const text = read(join(dir, file)) ?? '';
      const m = /^mapped:\s*["']?(\d{4}-\d{2}-\d{2})/m.exec(text);
      return { file, text, mapped: m?.[1] };
    });
}

/**
 * Does some topic file map this feature? A map names its subject in a header line
 * (`description:`, `entry:`, a heading), is named after it, or mentions its directory at
 * least twice. `_architecture.md` is the system map and never counts as a feature map,
 * and `dashboard` must not match `dashboardV2`.
 */
export function findMap(feature: Feature, maps: readonly MapFile[]): MapFile | undefined {
  const named = new RegExp(`${escape(feature.dir)}(?![\\w-])`);
  const slug = feature.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  for (const m of maps) {
    if (m.file.startsWith('_')) continue;
    if (m.file.replace(/\.md$/, '').toLowerCase() === slug) return m;
    const header = m.text
      .split('\n')
      .some((l) => /^(description:|entry:|#)/.test(l) && named.test(l));
    if (header || m.text.split(`${feature.dir}/`).length - 1 >= 2) return m;
  }
  return undefined;
}

/** Is anything under this directory tracked by git? Unknown counts as yes. */
export async function tracked(root: string, dir: string): Promise<boolean> {
  const out = await runGit(['ls-files', '--', dir], root);
  return out === undefined ? true : out.trim().length > 0;
}

/** Date (YYYY-MM-DD) of the last commit touching dir. */
export async function lastChanged(root: string, dir: string): Promise<string | undefined> {
  const out = (await runGit(['log', '--max-count=1', '--format=%cs', '--', dir], root))?.trim();
  return out !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : undefined;
}

export interface Coverage {
  readonly parents: string[];
  readonly features: Feature[];
  readonly mapped: (Feature & { map: string; date: string | undefined })[];
  readonly unmapped: Feature[];
  readonly outdated: (Feature & { map: string; date: string; changed: string })[];
  readonly architecture: boolean;
  readonly dir: string | undefined;
}

/**
 * Coverage summary. `stale` compares each map's `mapped:` date with the last commit to its
 * feature, one git call per mapped feature — the audit asks for it, the hooks do not.
 */
export async function coverage(root: string, { stale = false } = {}): Promise<Coverage> {
  const features = listFeatures(root);
  const maps = mapFiles(root);
  const mapped: Coverage['mapped'] = [];
  const unmapped: Feature[] = [];
  const outdated: Coverage['outdated'] = [];
  for (const f of features) {
    const m = findMap(f, maps);
    if (m === undefined) {
      unmapped.push(f);
      continue;
    }
    mapped.push({ ...f, map: m.file, date: m.mapped });
    if (stale && m.mapped !== undefined) {
      const changed = await lastChanged(root, f.dir);
      if (changed !== undefined && changed > m.mapped) {
        outdated.push({ ...f, map: m.file, date: m.mapped, changed });
      }
    }
  }
  return {
    parents: featureParents(root),
    features,
    mapped,
    unmapped,
    outdated,
    architecture: maps.some((m) => m.file === '_architecture.md'),
    dir: cartographerDir(root),
  };
}
