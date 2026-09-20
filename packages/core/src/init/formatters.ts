import { RulegateError } from '../model/errors.js';
import { matchesGlob } from '../fs/glob.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

/**
 * T072, which is a first-run experience rather than a bug in either tool.
 *
 * A formatter and a generator cannot both own a file. Reformat a generated one and the
 * next `sync` correctly reports it as hand-edited and refuses to write it — a deadlock
 * that looks, from the outside, like Rulegate being broken. Every user with a formatter
 * hits it, so `init` says so at the one moment the information is useful.
 *
 * It warns rather than editing the ignore file itself. That file is the user's, and a
 * tool whose pitch is that it never touches what it did not generate should not open its
 * first conversation by editing something it did not generate — the decision taken at
 * T019 and reaffirmed at T072. `init.test.ts` asserts `--yes` writes no ignore file, so
 * this is a guarantee rather than a comment.
 */

/** Where a formatter's exclusions live: a dedicated ignore file, or a key in its config. */
type Exclusions =
  | { readonly kind: 'ignore-file'; readonly path: string }
  | { readonly kind: 'config-key'; readonly key: string };

interface Formatter {
  readonly name: string;
  /** Presence of any of these means the tool is configured for this repository. */
  readonly configs: readonly string[];
  readonly exclusions: Exclusions;
  /**
   * Does depending on the tool, with no config file at all, count as configured? Prettier's
   * default is exactly that, so for Prettier it must. It is also what decides ESLint's two
   * entries between them: a repository that depends on `eslint` and has no config file is on
   * ESLint 9, where flat config is the default and `.eslintignore` no longer exists.
   */
  readonly bareDependencyCounts: boolean;
  /**
   * T092. Strings that prove this tool has been pointed at something other than JavaScript.
   * When present, the tool is only a threat to a generated file if one of them appears in
   * its config or in `package.json` — see the comment above `ESLINT_NON_JS_SIGNALS`.
   */
  readonly optInSignals?: readonly string[];
}

/**
 * T092: the opt-in ESLint needs before it can touch anything Rulegate generates.
 *
 * Rulegate never emits a `.js` or `.ts` file — every artifact is Markdown, `.mdc`, JSON,
 * TOML, YAML or an extensionless dotfile — and ESLint lints JavaScript and nothing else
 * until a plugin or processor extends it. So on an ordinary JavaScript repository the
 * ESLint half of this warning was pure noise: it fired on the first run, about files ESLint
 * would never open. That is the expensive kind of wrong, because the first run is where a
 * user decides whether these warnings are worth reading.
 *
 * The asymmetry the comment above `FORMATTERS` states — over-detecting costs a warning,
 * under-detecting costs the deadlock — is still right, and it is what keeps Prettier, Biome
 * and dprint unconditional: all three format Markdown and JSON by default, so for them the
 * deadlock is the default outcome. ESLint's default is the opposite, and applying the same
 * rule to both tools was reasoning from Prettier's facts about a linter.
 *
 * Matched as substrings of the config text and `package.json`, for the same reason
 * `packageJsonMentions` is a regex over text: deciding whether to *warn* must not depend on
 * executing a user's config, and a plugin that extends ESLint past JavaScript has to be
 * named in one of those two files to be loaded at all.
 */
const ESLINT_NON_JS_SIGNALS: readonly string[] = [
  '@eslint/markdown',
  'eslint-plugin-markdown',
  'eslint-plugin-mdx',
  '@eslint/json',
  'eslint-plugin-json',
  'eslint-plugin-jsonc',
  'eslint-plugin-yml',
  'eslint-plugin-yaml',
  'eslint-plugin-toml',
  // Runs Prettier as an ESLint rule, which brings Prettier's file coverage with it.
  'eslint-plugin-prettier',
];

/**
 * The four formatters a JavaScript repository actually uses, in five entries — ESLint needs
 * one per config shape, for the reason given below. Each entry names the file or
 * key its exclusions live in, because "add these lines to .prettierignore" is wrong advice
 * for Biome and dprint, which have no ignore file at all — their excludes are a key inside
 * the config. A hint that names the wrong file is the same failure as no hint.
 */
const FORMATTERS: readonly Formatter[] = [
  {
    name: 'Prettier',
    configs: [
      '.prettierrc',
      '.prettierrc.json',
      '.prettierrc.json5',
      '.prettierrc.yaml',
      '.prettierrc.yml',
      '.prettierrc.toml',
      '.prettierrc.js',
      '.prettierrc.cjs',
      '.prettierrc.mjs',
      'prettier.config.js',
      'prettier.config.cjs',
      'prettier.config.mjs',
      'prettier.config.ts',
    ],
    exclusions: { kind: 'ignore-file', path: '.prettierignore' },
    bareDependencyCounts: true,
  },
  {
    name: 'Biome',
    configs: ['biome.json', 'biome.jsonc', '.biome.json'],
    exclusions: { kind: 'config-key', key: 'files.includes' },
    bareDependencyCounts: true,
  },
  {
    name: 'dprint',
    configs: ['dprint.json', 'dprint.jsonc', '.dprint.json', '.dprint.jsonc'],
    exclusions: { kind: 'config-key', key: 'excludes' },
    bareDependencyCounts: true,
  },
  /**
   * ESLint is two tools sharing one name, and splitting them is not cosmetic. ESLint 9 does
   * not read `.eslintignore` under flat config and *errors* when it finds one, so advising a
   * flat-config repository to create it breaks the lint run this warning exists to protect —
   * worse than the wrong-file failure the comment above describes, because acting on it is
   * what breaks things. Flat config's exclusions are an `ignores` entry in the config itself.
   *
   * Flat comes first because at most one warning is emitted per name, and flat is the config
   * ESLint actually loads when a repository carries both shapes.
   *
   * Found on a Next.js 16 repository during the T032 first-run rehearsal, where the hint
   * named `.eslintignore` for an `eslint.config.mjs` using `globalIgnores`.
   */
  {
    name: 'ESLint',
    configs: [
      'eslint.config.js',
      'eslint.config.mjs',
      'eslint.config.cjs',
      'eslint.config.ts',
      'eslint.config.mts',
      'eslint.config.cts',
    ],
    exclusions: { kind: 'config-key', key: 'ignores' },
    bareDependencyCounts: true,
    optInSignals: ESLINT_NON_JS_SIGNALS,
  },
  {
    // ESLint 8 and earlier, where `.eslintignore` is the mechanism. A bare dependency does
    // not land here: with no config file at all the repository is on 9.
    name: 'ESLint',
    configs: [
      '.eslintrc',
      '.eslintrc.json',
      '.eslintrc.yaml',
      '.eslintrc.yml',
      '.eslintrc.js',
      '.eslintrc.cjs',
    ],
    exclusions: { kind: 'ignore-file', path: '.eslintignore' },
    bareDependencyCounts: false,
    optInSignals: ESLINT_NON_JS_SIGNALS,
  },
];

/**
 * Prettier is also configured from `package.json` — a `prettier` key, or merely being a
 * dependency with no config file at all, which is the default a `create-*` scaffold
 * leaves behind. Detecting only config files misses the common case.
 *
 * Read as text rather than parsed: this decides whether to *warn*, the file may be any
 * shape a user's `package.json` takes, and a JSON parse failure here must not take an
 * `init` down. Over-detecting costs a warning; under-detecting costs the deadlock.
 */
function packageJsonMentions(pkg: string, name: string): boolean {
  return new RegExp(`"${name}"\\s*:`).test(pkg);
}

/**
 * Does an ignore file already cover this path?
 *
 * Exact line equality was the original test and it is wrong on every real repository:
 * this project's own `.prettierignore` lists `.cursor/rules/` and `.github/instructions/`,
 * which cover their contents without naming one of them. A warning that fires on a
 * correctly configured repository is one people learn to ignore, and then it is not there
 * for the repository that needs it.
 */
export function ignoreCovers(ignoreText: string, relPath: string): boolean {
  let covered = false;
  for (const raw of ignoreText.split('\n')) {
    let line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    // A negation is the user deliberately un-ignoring something, and the last matching
    // line wins — gitignore's own rule, and the one that decides the answer for a repo
    // that ignores `**/*.md` and then re-includes one file.
    const negated = line.startsWith('!');
    if (negated) line = line.slice(1);

    for (const pattern of expand(line)) {
      if (matchesGlob(relPath, pattern)) {
        covered = !negated;
        break;
      }
    }
  }
  return covered;
}

/**
 * The gitignore-style spellings of "this directory and everything under it", written out
 * as globs the matcher understands. `dist`, `dist/` and `/dist` all cover `dist/a.md`,
 * and a bare name with no slash matches at every depth — the rule that quietly excluded
 * this repository's Claude fixtures for the whole of M0.
 */
function expand(line: string): readonly string[] {
  const rooted = line.startsWith('/');
  const body = (rooted ? line.slice(1) : line).replace(/\/$/, '');
  if (body === '') return [];

  const out = [body, `${body}/**`];
  // No slash anywhere means gitignore matches it at any depth, not only at the root.
  if (!rooted && !body.includes('/')) out.push(`**/${body}`, `**/${body}/**`);
  return out;
}

export interface FormatterWarningInput {
  readonly fs: ReadOnlyFileSystem;
  /** The paths `sync` would generate. */
  readonly generated: readonly string[];
}

/** One warning per configured formatter that would fight over a generated path. */
export async function formatterWarnings(
  input: FormatterWarningInput,
): Promise<readonly RulegateError[]> {
  const { fs, generated } = input;
  if (generated.length === 0) return [];

  const pkg = (await fs.tryReadFile('package.json')) ?? '';
  const warnings: RulegateError[] = [];

  // One warning per tool rather than per entry: ESLint's two config shapes share a name,
  // and a repository holding both must get the flat answer only — the second entry would
  // otherwise contradict the first with the advice that breaks ESLint 9.
  const decided = new Set<string>();

  for (const formatter of FORMATTERS) {
    if (decided.has(formatter.name)) continue;
    const config = await configuredBy(fs, formatter, pkg);
    if (config === undefined) continue;
    decided.add(formatter.name);

    // Configured, but configured for JavaScript only, which no generated path is.
    if (formatter.optInSignals !== undefined) {
      const configText = (await fs.tryReadFile(config)) ?? '';
      const opted = formatter.optInSignals.some(
        (signal) => configText.includes(signal) || pkg.includes(signal),
      );
      if (!opted) continue;
    }

    const { exclusions } = formatter;
    const ignoreText =
      exclusions.kind === 'ignore-file' ? ((await fs.tryReadFile(exclusions.path)) ?? '') : '';
    const unlisted = generated.filter((p) => !ignoreCovers(ignoreText, p));
    if (unlisted.length === 0) continue;

    warnings.push(
      new RulegateError({
        code: 'E_FORMATTER_CONFLICT',
        message: `this repository uses ${formatter.name}, and ${String(unlisted.length)} generated file(s) are not excluded from it`,
        source: exclusions.kind === 'ignore-file' ? { file: exclusions.path } : { file: config },
        hint: advice(formatter, config, unlisted),
      }),
    );
  }

  return warnings;
}

/**
 * The config file that proves this formatter is configured, or `undefined` if none does.
 *
 * It returns the path rather than a boolean because a `config-key` hint has to name a file,
 * and naming the first entry in the table is wrong as soon as a tool has several spellings —
 * telling an `eslint.config.mjs` repository to edit `eslint.config.js` sends it to a file
 * that does not exist. A bare dependency has no file to name, so it falls back to the
 * canonical one, which for that repository is the file it should create.
 */
async function configuredBy(
  fs: ReadOnlyFileSystem,
  formatter: Formatter,
  pkg: string,
): Promise<string | undefined> {
  for (const config of formatter.configs) {
    if (await fs.exists(config)) return config;
  }
  if (!formatter.bareDependencyCounts) return undefined;
  const name = formatter.name.toLowerCase();
  return packageJsonMentions(pkg, name) ? formatter.configs[0]! : undefined;
}

function advice(formatter: Formatter, config: string, unlisted: readonly string[]): string {
  const lines = unlisted.join(', ');
  const consequence = `or the next format run will rewrite them and sync will then refuse to`;
  return formatter.exclusions.kind === 'ignore-file'
    ? `add these lines to ${formatter.exclusions.path}, ${consequence}: ${lines}`
    : `exclude these paths under \`${formatter.exclusions.key}\` in ${config}, ${consequence}: ${lines}`;
}
