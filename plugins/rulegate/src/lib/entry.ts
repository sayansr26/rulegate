import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isRecord, readJson } from './read.js';
import { claudeHome } from './settings.js';

/**
 * What every script entry point resolves from its environment, kept out of the libraries
 * so those take everything as arguments and tests never touch the real `~/.claude`.
 */

/** The first non-flag argument, else the working directory. */
export function rootArg(argv: readonly string[]): string {
  return argv.find((a) => !a.startsWith('--')) ?? process.cwd();
}

export function claudeDirFromEnv(): string {
  return claudeHome(process.env, homedir());
}

/**
 * The version of the plugin this script ships in. Entries are bundled to `dist/<name>.js`,
 * one directory below the plugin root, which is also where `src/<name>.ts` sits — so one
 * relative path serves both.
 */
export function bundledVersion(entryUrl: string): string | undefined {
  const manifest = readJson(fileURLToPath(new URL('../.claude-plugin/plugin.json', entryUrl)));
  return isRecord(manifest) && typeof manifest.version === 'string' ? manifest.version : undefined;
}

export function print(lines: readonly string[]): void {
  process.stdout.write(`${lines.join('\n')}\n`);
}
