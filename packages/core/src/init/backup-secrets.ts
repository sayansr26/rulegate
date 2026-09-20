import { RulegateError } from '../model/errors.js';
import { scanTextForSecrets } from '../render/secrets.js';
import { backupPathFor } from '../pipeline/apply.js';
import { ignoreCovers } from './formatters.js';
import type { ReadOnlyFileSystem } from '../fs/types.js';

/**
 * T095, and the one hole T044 leaves open.
 *
 * T044 makes "never write a literal secret" a property of the *render* path: `SecretValue`
 * is `EnvRef`, the parser refuses a literal, and `render/secrets.ts` catches anything that
 * reaches `unknown`. None of that applies here, because taking ownership of a file copies
 * it to `.rulegate/backup/` **verbatim** — which is exactly what it must do for `restore`
 * to return a CRLF or BOM original byte for byte. For an `.mcp.json` holding a token, that
 * faithful copy is a plaintext credential.
 *
 * What makes it worth a warning rather than a shrug is where the copy lands. `.rulegate/`
 * is the canonical source, so users are told to commit it, and the backup rides along
 * inside. A repository that deliberately kept the token out of git with a `.mcp.json` line
 * in `.gitignore` can end up committing it from a path that line does not cover.
 *
 * **It warns and never edits.** Adding `.rulegate/backup/` to somebody's `.gitignore` is
 * still editing a file Rulegate did not generate, refused at T019 and reaffirmed at T072 —
 * and the right answer may instead be to move the credential out of the file entirely, which
 * is the user's call and not a line Rulegate can write for them.
 */

/** The ignore files worth consulting. `.git/info/exclude` is deliberately not read: it is */
/** private to one clone, so a warning suppressed by it would fire for every colleague. */
const IGNORE_FILES: readonly string[] = ['.gitignore'];

export interface BackupSecretWarningInput {
  readonly fs: ReadOnlyFileSystem;
  /**
   * Paths Rulegate is about to take ownership of — the generated paths. Only those that
   * already exist on disk can be backed up, and only those are read.
   */
  readonly taking: readonly string[];
}

/**
 * One warning per file whose backup would carry a credential into version control.
 *
 * Silent in the two cases that matter: a file with no literal secret in it, and a
 * repository whose ignore rules already cover the backup path. The second is not a
 * courtesy — a bare `.mcp.json` line matches at every depth under gitignore's rules, so it
 * covers `.rulegate/backup/.mcp.json` too, and firing there would be a warning on a
 * correctly configured repository. That is the failure mode `ignoreCovers` was written for.
 */
export async function backupSecretWarnings(
  input: BackupSecretWarningInput,
): Promise<readonly RulegateError[]> {
  const { fs, taking } = input;
  if (taking.length === 0) return [];

  let ignoreText = '';
  for (const file of IGNORE_FILES) {
    const text = await fs.tryReadFile(file);
    if (text !== undefined) ignoreText += `\n${text}`;
  }

  const warnings: RulegateError[] = [];
  for (const path of taking) {
    const original = await fs.tryReadFile(path);
    if (original === undefined) continue;

    // Key paths, never values. `scanTextForSecrets` is built so that nothing it returns can
    // print the credential, and this message keeps that bargain.
    const found = scanTextForSecrets(original);
    if (found.length === 0) continue;

    const backup = backupPathFor(path);
    if (ignoreCovers(ignoreText, backup)) continue;

    warnings.push(
      new RulegateError({
        code: 'W_BACKUP_SECRET',
        message: `${path} holds a literal credential (at ${found.join(', ')}), and taking ownership of it copies the file verbatim to ${backup} — inside the directory you are meant to commit`,
        source: { file: path },
        hint: `add \`.rulegate/backup/\` to .gitignore before committing, or move the credential to an environment variable first — the generated ${path} will reference it rather than contain it`,
      }),
    );
  }

  return warnings;
}
