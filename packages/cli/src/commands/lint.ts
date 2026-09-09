import {
  createHomeFileSystem,
  createReadOnlyFileSystem,
  resolveRepoRoot,
  runLint,
} from '@rulegate/core';
import { ADAPTERS } from '../registry.js';
import { createOutput, formatErrors, pluralize } from '../ui/report.js';
import { formatTable } from '../ui/table.js';
import { ExitCode, type ExitCodeValue } from '../ui/exit.js';
import type { LintReport } from '@rulegate/core';
import type { Output } from '../ui/report.js';

export interface LintOptions {
  readonly cwd: string;
  /** Skip the user-level probe entirely; nothing outside the repository is read. */
  readonly noGlobal?: boolean;
  /** Where the user-level probe is rooted. Not a flag — a test seam, as in `doctor`. */
  readonly homeRoot?: string;
  readonly json?: boolean;
  readonly quiet?: boolean;
  readonly color?: boolean;
  readonly announceRoot?: boolean;
}

/**
 * Lint the canonical rules and the context they generate.
 *
 * Read-only by construction, the same way `check` is: the filesystem it holds has no
 * write methods on it at all, and `invariants.test.ts` scans this file for the name of
 * the one function that writes.
 *
 * **Exit 1 only on an `error`-severity finding**, never on a warning. This is not the
 * same call `doctor` makes, and the difference is that lint's severities are
 * configurable: a repository that disagrees with a default can say so in its manifest,
 * so failing on what it did not silence is a gate it chose. `doctor`'s warnings cannot
 * be reconfigured and several are permanently correct, which is why it exits 0.
 * A usage mistake exits 2 in `program.ts` and never here.
 */
export async function runLintCommand(options: LintOptions): Promise<ExitCodeValue> {
  const out = createOutput({
    ...(options.quiet === undefined ? {} : { quiet: options.quiet }),
    ...(options.color === undefined ? {} : { color: options.color }),
  });

  const repoRoot = resolveRepoRoot(options.cwd);
  const fs = createReadOnlyFileSystem(repoRoot);
  const globalFs = options.noGlobal === true ? undefined : createHomeFileSystem(options.homeRoot);

  const report = await runLint({
    repoRoot,
    fs,
    adapters: ADAPTERS,
    ...(globalFs === undefined ? {} : { globalFs }),
  });

  if (options.json === true) {
    out.log(JSON.stringify(report, null, 2));
    if (report.errors.length > 0) out.error(formatErrors(report.errors));
    return exitFor(report);
  }

  if (options.announceRoot === true) out.log(`repo  ${repoRoot}`);

  // Exit 1 like `check` does on an unrenderable plan, and say what was not done. A
  // canonical source that does not parse must never leave through the "no findings"
  // path: nothing was linted, and reporting that as clean is worse than reporting
  // nothing at all.
  if (report.errors.length > 0) {
    out.error(formatErrors(report.errors));
    out.error(`\n${pluralize(report.errors.length, 'error')}; nothing was linted.`);
    return ExitCode.Failure;
  }

  printReport(out, report);
  return exitFor(report);
}

function exitFor(report: LintReport): ExitCodeValue {
  return report.errors.length > 0 || report.errorCount > 0 ? ExitCode.Failure : ExitCode.Ok;
}

/** Terminals narrower than this are treated as 80: below it, nothing helps. */
const MIN_WIDTH = 80;

/**
 * Name the first path and count the rest.
 *
 * Listing every path inline turns one duplicate-load finding across a monorepo into a
 * wall of text and buries the findings after it — `doctor`'s `describePath` reached the
 * same conclusion for the same reason.
 */
function describePaths(paths: readonly string[]): string {
  const first = paths[0] ?? '-';
  return paths.length === 1 ? first : `${first} (+${String(paths.length - 1)})`;
}

/**
 * Findings on stdout, the summary and the advice on stderr.
 *
 * The same split `check` and `doctor` use, and for the same reason: `-q` leaves the
 * machine-readable half and a piped run stays a clean list.
 */
function printReport(out: Output, report: LintReport): void {
  // An unknown rule id is reported before anything else, because it means part of the
  // manifest is doing nothing and every other line below is therefore incomplete.
  for (const id of report.unknownRules) {
    out.error(`!  \`lint.rules.${id}\` configures a rule that does not exist`);
  }

  if (report.findings.length === 0) {
    const off =
      report.disabledRules.length === 0
        ? ''
        : ` (${pluralize(report.disabledRules.length, 'rule')} off: ${report.disabledRules.join(', ')})`;
    out.log(`no lint findings${off}`);
    return;
  }

  // The message is **not** a table column, and this was a finding rather than a choice.
  // Doctor's warnings are whole sentences, so a four-column table never fits 80 and
  // `formatTable` correctly drops every droppable column — leaving a list of bare paths
  // and no indication of what was wrong with them. Three short columns always fit; the
  // message goes underneath, indented, where its length costs nothing.
  const rows = report.findings.map((f) => [
    f.severity,
    f.rule,
    f.paths.length === 0 ? '-' : describePaths(f.paths),
  ]);
  const width = Math.max(MIN_WIDTH, process.stdout.columns ?? MIN_WIDTH);
  const header = formatTable([{ priority: 0 }, { priority: 0 }, { priority: 0 }], rows, width);

  report.findings.forEach((f, i) => {
    out.log(header[i] ?? '');
    out.log(`  ${f.message}`);
    if (f.source !== undefined) out.log(`  ${f.source.title} — ${f.source.url}`);
  });

  out.error('');
  out.error(`${pluralize(report.errorCount, 'error')}, ${pluralize(report.warnCount, 'warning')}.`);
  // One hint per distinct rule, not per finding: twenty oversized files share one fix.
  const seen = new Set<string>();
  for (const f of report.findings) {
    if (seen.has(f.rule)) continue;
    seen.add(f.rule);
    out.error(`hint: ${f.rule} — ${f.hint}`);
  }
}
