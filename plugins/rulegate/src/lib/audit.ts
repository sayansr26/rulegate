import { basename, join } from 'node:path';
import { coverage } from './features.js';
import { isDir, isFile, isRealDir, isRecord, ls, read, readJson, size } from './read.js';
import { GIT_DENY, TODO_ENV, isRulegateProject, normRule } from './settings.js';
import {
  AGENTS_SECTION,
  LEGACY_PLUGIN_ID,
  describeState,
  enabledFlag,
  setupState,
} from './state.js';

/**
 * The audit behind `/rulegate:init` — one call, whole picture.
 *
 * Deterministic checks: line counts, frontmatter presence, file existence, JSON keys. Having
 * a model discover them with a dozen Read and Grep round trips costs tokens on every one;
 * this emits the lot in a single tool result. Read-only, and the entry point exits 0 even on
 * failures so a partial audit still reaches the caller.
 *
 * What agent-os's audit did and this one hands off: **drift** is `rulegate check`'s — the
 * skill runs it and reads the exit code, rather than a second, weaker drift check living
 * here — and **token cost per file** is `rulegate doctor`'s. What stays is the Claude-specific
 * context layer neither of those looks at.
 */

export interface AuditOptions {
  readonly root: string;
  readonly claudeDir: string;
  /** YYYY-MM-DD, passed in so the audit itself reads no clock. */
  readonly today: string;
  readonly expect?: string | undefined;
}

const PLUGIN_AGENTS = [
  'orchestrator',
  'architect',
  'builder',
  'reviewer',
  'tester',
  'documenter',
  'feature-cartographer',
];
const PLUGIN_SKILLS = ['init', 'map', 'memory'];

const lineCount = (s: string | undefined): number => (s ? s.split('\n').length : 0);
const frontmatter = (t: string): string =>
  t.startsWith('---\n') ? (t.slice(4).split('\n---')[0] ?? '') : '';
const pad = (s: string, n: number): string => s.padEnd(n);
const num = (n: number, w: number): string => String(n).padStart(w);

/**
 * The most directory entries either walk visits. The walks size a store and count source
 * files — estimates, where stopping early costs precision and never correctness — and the
 * repository decides how big the tree is. Symlinks are never followed (`isRealDir`).
 */
const WALK_BUDGET = 50_000;

function dirBytes(p: string, budget = { left: WALK_BUDGET }): number {
  let n = 0;
  for (const f of ls(p)) {
    if (--budget.left < 0) break;
    const fp = join(p, f);
    n += isRealDir(fp) ? dirBytes(fp, budget) : size(fp);
  }
  return n;
}

/** Paths `.rulegate/state.json` records — Rulegate's only record of what it generated. */
export function recordedPaths(root: string): Set<string> {
  const state = readJson(join(root, '.rulegate/state.json'));
  const artifacts = isRecord(state) && Array.isArray(state.artifacts) ? state.artifacts : [];
  return new Set(
    artifacts.filter(isRecord).flatMap((a) => (typeof a.path === 'string' ? [a.path] : [])),
  );
}

export async function runAudit({
  root,
  claudeDir,
  today,
  expect,
}: AuditOptions): Promise<string[]> {
  const out: string[] = [];
  const findings: string[] = [];
  const say = (s = ''): void => {
    out.push(s);
  };
  const flag = (sev: 'FAIL' | 'WARN' | 'INFO', msg: string): void => {
    findings.push(`${sev}  ${msg}`);
  };
  const rulegate = isRulegateProject(root);
  const recorded = recordedPaths(root);

  say(`RULEGATE AUDIT   ${root}`);
  say(`                 ${today}`);
  say();

  // ---------------------------------------------------------- always-loaded
  let residentBytes = 0;
  say('ALWAYS-LOADED  (cost on every turn)');
  for (const f of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']) {
    const t = read(join(root, f));
    if (!t) continue;
    const n = lineCount(t);
    residentBytes += t.length;
    const over = n > 200;
    const generated = recorded.has(f);
    say(
      `  ${pad(f, 30)} ${num(n, 4)} lines  ${num(t.length, 6)} B  ${over ? 'OVER BUDGET (>200)' : 'ok'}${generated ? '  (generated)' : ''}`,
    );
    if (over) {
      flag(
        'WARN',
        generated
          ? `${f} is ${String(n)} lines; budget is 200. It is generated — trim or narrow rules in .rulegate/rules/ (a \`tools:\` selector, or \`globs:\` for file-scoped content), not the file.`
          : `${f} is ${String(n)} lines; budget is 200. Move path-scoped content to .claude/rules/.`,
      );
    }
  }
  if (!residentBytes) {
    flag('WARN', 'No CLAUDE.md at all — this project has no always-loaded instructions.');
  } else if (!AGENTS_SECTION.test(read(join(root, 'CLAUDE.md')) ?? '')) {
    flag(
      'INFO',
      'CLAUDE.md does not say when to use the rulegate agents — add the "Agents in this project" section (references/establishing.md, Step 4b).',
    );
  }

  // ---------------------------------------------------------- rulegate
  say();
  if (rulegate) {
    const rules = ls(join(root, '.rulegate/rules')).filter((f) => f.endsWith('.md'));
    say(
      `RULEGATE  .rulegate/  — ${String(rules.length)} rule(s), ${String(recorded.size)} generated file(s) recorded`,
    );
    say(
      '  drift: run `npx rulegate check` — exit 1 means a generated file is stale or hand-edited',
    );
    say('  cost:  `npx rulegate doctor` reports what each tool loads and its token estimate');
  } else {
    say('RULEGATE  no .rulegate/ — rules are not generated here');
    flag(
      'INFO',
      "No .rulegate/ — `npx rulegate init` imports this project's existing agent configs into one canonical source. The plugin's generated-file guard has nothing to protect until then.",
    );
  }

  // ---------------------------------------------------------- rules
  const rulesDir = join(root, '.claude/rules');
  const ruleFiles = ls(rulesDir).filter((f) => f.endsWith('.md'));
  say();
  say(`RULES  .claude/rules/  — ${String(ruleFiles.length)} file(s)`);
  if (ruleFiles.length === 0 && !isDir(rulesDir)) say('  (no rules directory)');
  for (const f of ruleFiles) {
    const t = read(join(rulesDir, f)) ?? '';
    const fm = frontmatter(t);
    const scoped = /^paths:/m.test(fm);
    const globs = (fm.match(/-\s+["']/g) ?? []).length;
    say(
      `  ${scoped ? 'ok  ' : 'WARN'} ${pad(f, 26)} ${num(lineCount(t), 4)} lines  ${scoped ? `paths: ${String(globs)}` : 'NO paths: — loads every session'}`,
    );
    if (!scoped) {
      residentBytes += t.length;
      flag(
        'WARN',
        `.claude/rules/${f} has no paths: frontmatter, so it loads every session like CLAUDE.md.`,
      );
    }
  }

  // ---------------------------------------------------------- hooks
  const projSettings = readJson(join(root, '.claude/settings.json'));
  say();
  say('HOOKS  .claude/settings.json');
  if (projSettings === undefined) say('  (no project settings.json)');
  else if (projSettings === 'INVALID') flag('FAIL', '.claude/settings.json is not valid JSON.');
  else if (isRecord(projSettings)) {
    const hooks = isRecord(projSettings.hooks) ? projSettings.hooks : {};
    if (Object.keys(hooks).length === 0) say('  (none)');
    for (const [evt, entries] of Object.entries(hooks)) {
      for (const e of Array.isArray(entries) ? entries.filter(isRecord) : []) {
        for (const h of Array.isArray(e.hooks) ? e.hooks.filter(isRecord) : []) {
          const cmd = typeof h.command === 'string' ? h.command : '';
          const m = /\$\{?CLAUDE_PROJECT_DIR\}?\/([^"']+)/.exec(cmd);
          if (m?.[1] === undefined) {
            say(`  ok   ${pad(evt, 14)} ${cmd.slice(0, 60)}`);
            continue;
          }
          const target = m[1];
          const exists = isFile(join(root, target));
          if (/cartographer-reminder/.test(target)) {
            flag(
              'INFO',
              `${target} duplicates the plugin's own pre-edit reminder — remove the project copy and its hook entry.`,
            );
          }
          say(
            `  ${exists ? 'ok  ' : 'FAIL'} ${pad(evt, 14)} ${target}${exists ? '' : '  <- TARGET MISSING'}`,
          );
          if (!exists) {
            flag(
              'FAIL',
              `${evt} hook points at ${target}, which does not exist. It fires at a missing path every session.`,
            );
          }
        }
      }
    }
  }

  // ---------------------------------------------------------- legacy stores
  say();
  say('LEGACY STORES');
  const legacy: [string, string][] = [
    ['memory-bank/', 'memory-bank'],
    ['.serena/memories/', '.serena/memories'],
    ['.cursorrules', '.cursorrules'],
    ['.cursor/rules/', '.cursor/rules'],
    ['.windsurfrules', '.windsurfrules'],
    ['.clinerules', '.clinerules'],
    ['.agent-os/', '.agent-os'],
  ];
  // A store Rulegate generated is not legacy — telling someone to fold `sync`'s own output
  // back into CLAUDE.md and delete it would destroy what `sync` just wrote. `state.json`
  // is the ownership record, so a store counts as generated when every file in it is
  // recorded there; agent-os's banner is no evidence of anything here.
  const generated = (rel: string): boolean => {
    const files = isDir(join(root, rel)) ? ls(join(root, rel)).map((f) => `${rel}/${f}`) : [rel];
    const readable = files.filter((f) => isFile(join(root, f)));
    return readable.length > 0 && readable.every((f) => recorded.has(f));
  };
  let anyLegacy = false;
  let anyListed = false;
  for (const [label, rel] of legacy) {
    const p = join(root, rel);
    if (!isDir(p) && !isFile(p)) continue;
    const dir = isDir(p);
    const n = dir ? ls(p).length : 1;
    const b = dir ? dirBytes(p) : size(p);
    anyListed = true;
    if (generated(rel)) {
      say(
        `  ${pad(label, 22)} ${String(n)} file(s)  ${String(b)} B  — generated by rulegate, not legacy`,
      );
      continue;
    }
    anyLegacy = true;
    say(`  FOUND ${pad(label, 22)} ${String(n)} file(s)  ${String(b)} B`);
    flag(
      'INFO',
      rel === '.agent-os'
        ? '.agent-os/ exists — `npx rulegate init` imports it (T113); references/migrating.md covers the rest.'
        : `${label} exists — preserve its content in ${rulegate ? '.rulegate/rules/' : 'CLAUDE.md or .claude/rules/'} before deleting anything.`,
    );
  }
  const mcp = readJson(join(root, '.mcp.json'));
  const servers = isRecord(mcp) && isRecord(mcp.mcpServers) ? Object.keys(mcp.mcpServers) : [];
  if (isRecord(mcp)) {
    const memoryish = servers.filter((s) => /graphiti|memory|knowledge|mem0|zep|serena/i.test(s));
    say(`  .mcp.json servers: ${servers.join(', ') || '(none)'}`);
    if (memoryish.length > 0) {
      flag(
        'INFO',
        `.mcp.json has memory-ish server(s): ${memoryish.join(', ')}. Check they are still wanted.`,
      );
    }
  }
  if (!anyListed) say('  none');

  // ---------------------------------------------------------- agent memory
  say();
  say('MEMORY');
  for (const base of ['.claude/agent-memory', '.claude/agent-memory-local']) {
    const dir = join(root, base);
    for (const agent of ls(dir)) {
      const adir = join(dir, agent);
      if (!isDir(adir)) continue;
      const topics = ls(adir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
      const idx = read(join(adir, 'MEMORY.md'));
      const idxLines = idx ? idx.split('\n').filter((l) => l.trim()).length : 0;
      say(
        `  ${pad(agent, 34)} index ${num(idxLines, 3)} line(s)   ${String(topics.length)} topic file(s)`,
      );
      if (idxLines < topics.length) {
        flag(
          'WARN',
          `${agent}: ${String(topics.length)} topic files but only ${String(idxLines)} indexed in MEMORY.md — the unindexed ones are invisible next session.`,
        );
      }
      const slugs = topics.map((f) => basename(f, '.md').replace(/[-_]/g, ''));
      if (slugs.some((s, i) => slugs.indexOf(s) !== i)) {
        flag(
          'WARN',
          `${agent}: near-duplicate topic filenames (hyphen/underscore variants). Merge them.`,
        );
      }
      if (idx && idx.split('\n').length > 200) {
        flag(
          'WARN',
          `${agent}: MEMORY.md over 200 lines — everything past that is dropped at startup.`,
        );
      }
      // An agent that writes `.claude/agent-memory/<agent>/x.md` relative to its own
      // memory directory nests a copy of the tree inside it.
      for (const d of ls(adir).filter((e) => isDir(join(adir, e)))) {
        flag(
          'WARN',
          `${agent}/${d}/ is a folder inside agent memory${d === '.claude' ? ' — a memory write resolved against the wrong root' : ''}. Move any topic files up into ${agent}/ and delete it.`,
        );
      }
      if (agent.startsWith('agent-os-')) {
        flag(
          'INFO',
          `${agent} is agent-os's memory — /rulegate:init moves it to rulegate-${agent.slice('agent-os-'.length)} (T114).`,
        );
      }
    }
  }
  if (
    !isDir(join(root, '.claude/agent-memory')) &&
    !isDir(join(root, '.claude/agent-memory-local'))
  ) {
    say('  no agent memory yet (agents have not run in this project)');
  }

  // ---------------------------------------------------------- machine layer
  say();
  say(`MACHINE  ${claudeDir}`);
  const gClaude = read(join(claudeDir, 'CLAUDE.md'));
  say(`  CLAUDE.md${' '.repeat(24)}${gClaude ? `present  ${String(gClaude.length)} B` : 'ABSENT'}`);
  if (
    !gClaude &&
    residentBytes &&
    /~\/\.claude\/CLAUDE\.md/.test(read(join(root, 'CLAUDE.md')) ?? '')
  ) {
    flag(
      'FAIL',
      'Project CLAUDE.md refers to ~/.claude/CLAUDE.md, which does not exist — a dangling reference.',
    );
  }
  for (const [d, names] of [
    ['agents', PLUGIN_AGENTS],
    ['skills', PLUGIN_SKILLS],
  ] as const) {
    const have = ls(join(claudeDir, d)).map((f) => basename(f, '.md'));
    say(`  ${pad(`${d}/`, 33)}${have.length > 0 ? have.join(', ') : 'absent'}`);
    const clash = have.filter((n) => names.includes(n));
    if (clash.length > 0) {
      flag(
        'FAIL',
        `~/.claude/${d}/ contains ${clash.join(', ')} — user scope OVERRIDES the plugin's copy, so plugin updates stop reaching you.`,
      );
    }
  }
  const projClash = ls(join(root, '.claude/agents'))
    .map((f) => basename(f, '.md'))
    .filter((n) => PLUGIN_AGENTS.includes(n));
  if (projClash.length > 0) {
    flag(
      'FAIL',
      `.claude/agents/ contains ${projClash.join(', ')} — shadows the plugin agent of the same name.`,
    );
  }
  if (enabledFlag(root, claudeDir, LEGACY_PLUGIN_ID) === true) {
    flag(
      'FAIL',
      `${LEGACY_PLUGIN_ID} is still enabled — its session block prints next to this plugin's and its guard knows nothing of state.json. Disable it: claude plugin disable ${LEGACY_PLUGIN_ID}.`,
    );
  }

  const gs = readJson(join(claudeDir, 'settings.json'));
  if (gs === 'INVALID') flag('FAIL', '~/.claude/settings.json is not valid JSON.');
  else if (isRecord(gs)) {
    const perms = isRecord(gs.permissions) ? gs.permissions : {};
    const deny = Array.isArray(perms.deny) ? perms.deny : [];
    const mode = typeof perms.defaultMode === 'string' ? perms.defaultMode : '(unset)';
    say(`  permissions.defaultMode${' '.repeat(10)}${mode}`);
    say(`  permissions.deny${' '.repeat(17)}${String(deny.length)} rule(s)`);
    if (/auto|accept/i.test(mode) && deny.length === 0) {
      flag(
        'WARN',
        `defaultMode is "${mode}" with an empty deny list. A CLAUDE.md rule is context, not enforcement — see references/git-permissions.md.`,
      );
    }
  } else say('  settings.json                    absent');

  // Git write protection and the task tools, wherever either is set.
  {
    const denyOf = (st: unknown): Set<string> => {
      const p = isRecord(st) && isRecord(st.permissions) ? st.permissions : {};
      const d = Array.isArray(p.deny)
        ? p.deny.filter((r): r is string => typeof r === 'string')
        : [];
      return new Set(d.map(normRule));
    };
    const envOn = (st: unknown): boolean =>
      isRecord(st) && isRecord(st.env) && ['1', 'true', true].includes(st.env[TODO_ENV] as string);
    const u = denyOf(gs);
    const pj = denyOf(projSettings);
    const uHave = GIT_DENY.filter((r) => u.has(normRule(r))).length;
    const pHave = GIT_DENY.filter((r) => pj.has(normRule(r))).length;
    const total = String(GIT_DENY.length);
    say(
      `  git write protection            user ${String(uHave)}/${total}  project ${String(pHave)}/${total}`,
    );
    say(
      `  env.${TODO_ENV}  user ${envOn(gs) ? 'on' : 'off'}  project ${envOn(projSettings) ? 'on' : 'off'}`,
    );
    if (uHave < GIT_DENY.length || pHave < GIT_DENY.length) {
      flag(
        'INFO',
        `git write protection incomplete (user ${String(uHave)}/${total}, project ${String(pHave)}/${total}) — the settings pass applies it.`,
      );
    }
    if (!envOn(gs) && !envOn(projSettings)) {
      flag(
        'INFO',
        `${TODO_ENV} is not on in user or project settings — the settings pass turns it on.`,
      );
    }
  }

  // ---------------------------------------------------------- stack + scale
  say();
  say('PROJECT');
  const pkg = readJson(join(root, 'package.json'));
  const deps = isRecord(pkg)
    ? {
        ...(isRecord(pkg.dependencies) ? pkg.dependencies : {}),
        ...(isRecord(pkg.devDependencies) ? pkg.devDependencies : {}),
      }
    : {};
  const dep = (n: string): boolean => n in deps;
  const stacks: string[] = [];
  if (dep('next')) stacks.push('Next.js');
  else if (dep('react')) stacks.push('React');
  if (dep('vue')) stacks.push('Vue');
  if (dep('@nestjs/core')) stacks.push('NestJS');
  else if (dep('express')) stacks.push('Express');
  if (dep('typescript')) stacks.push('TypeScript');
  if (dep('prisma') || dep('@prisma/client')) stacks.push('Prisma');
  for (const [f, label] of [
    ['pyproject.toml', 'Python'],
    ['requirements.txt', 'Python'],
    ['go.mod', 'Go'],
    ['Cargo.toml', 'Rust'],
    ['pom.xml', 'Java/Maven'],
    ['Gemfile', 'Ruby'],
    ['composer.json', 'PHP'],
  ] as const) {
    if (isFile(join(root, f)) && !stacks.includes(label)) stacks.push(label);
  }

  // Source scale: a cheap walk that skips the usual noise.
  const SKIP = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'vendor',
    '.next',
    'target',
    '__pycache__',
    '.venv',
    'coverage',
  ]);
  const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|vue|svelte|kt|swift|cs)$/;
  let srcFiles = 0;
  let srcBytes = 0;
  let budget = WALK_BUDGET;
  const walk = (d: string, depth: number): void => {
    if (depth > 8 || srcFiles > 20000) return;
    for (const e of ls(d)) {
      if (--budget < 0) return;
      if (SKIP.has(e) || e.startsWith('.')) continue;
      const fp = join(d, e);
      if (isRealDir(fp)) walk(fp, depth + 1);
      else if (CODE.test(e)) {
        srcFiles++;
        srcBytes += size(fp);
      }
    }
  };
  walk(root, 0);
  say(`  stack${' '.repeat(28)}${stacks.join(', ') || 'not detected'}`);
  say(
    `  source files${' '.repeat(21)}${String(srcFiles)}  (~${String(Math.round(srcBytes / 1024))} KB)`,
  );

  // LSP: the official plugins answer "find the definition" without reading files.
  const LSP: Record<string, string> = {
    TypeScript: 'typescript-lsp',
    Python: 'pyright-lsp',
    Go: 'gopls-lsp',
    Rust: 'rust-analyzer-lsp',
    'Java/Maven': 'jdtls-lsp',
    Ruby: 'ruby-lsp',
    PHP: 'php-lsp',
  };
  const wantLsp = stacks.map((s) => LSP[s]).filter((s): s is string => s !== undefined);
  if (wantLsp[0] !== undefined && srcFiles > 50) {
    flag(
      'INFO',
      `Install code intelligence: /plugin install ${wantLsp[0]}@claude-plugins-official — lets Claude jump to a definition instead of scanning files.`,
    );
  }

  // Checked-in generated or vendored code costs reads.
  const gi = read(join(root, '.gitignore')) ?? '';
  const unignored = ['dist', 'build', 'vendor', 'generated', 'src/generated', '.next']
    .filter((d) => isDir(join(root, d)))
    .filter((d) => !gi.split('\n').some((l) => l.trim().replace(/\/$/, '') === d));
  if (unignored.length > 0) {
    flag(
      'INFO',
      `Checked-in generated/vendored dirs (${unignored.join(', ')}) — add Read deny rules so Claude never opens them.`,
    );
  }

  // ---------------------------------------------------------- what to add
  // Only suggest a mechanism when the repo shows evidence it would help — an unused
  // mechanism is cost.
  say();
  say('WHAT THIS PROJECT COULD ADD');
  const rec: [string, string][] = [];
  const pkgDirs = ['packages', 'apps', 'services', 'libs'].filter((d) => isDir(join(root, d)));
  const subs = pkgDirs.flatMap((d) => ls(join(root, d)).filter((s) => isDir(join(root, d, s))));
  if (subs.length >= 3) {
    rec.push([
      'CLAUDE.md (nested)',
      `${String(subs.length)} packages under ${pkgDirs.join('/')} — a per-package CLAUDE.md loads only when Claude reads there${rulegate ? ' (a nested .rulegate/ generates it)' : ''}`,
    ]);
  }
  const lintCfg = [
    'eslint.config.js',
    '.eslintrc',
    '.eslintrc.json',
    'biome.json',
    'ruff.toml',
    '.golangci.yml',
  ].find((f) => isFile(join(root, f)));
  const hookEvents =
    isRecord(projSettings) && isRecord(projSettings.hooks) ? Object.keys(projSettings.hooks) : [];
  if (lintCfg !== undefined && !hookEvents.includes('PostToolUse')) {
    rec.push([
      'hook: PostToolUse',
      `${lintCfg} exists but nothing lints after an edit — a PostToolUse hook feeds errors straight back`,
    ]);
  }
  const fast = [
    'react',
    'next',
    'tailwindcss',
    'react-router-dom',
    'vue',
    'svelte',
    '@angular/core',
  ].filter(dep);
  if (fast.length > 0 && !servers.includes('context7')) {
    rec.push([
      'MCP: context7',
      `${fast.slice(0, 3).join(', ')} move faster than model training — context7 serves current API docs`,
    ]);
  }
  if (ls(join(root, '.claude/skills')).length === 0 && srcFiles > 100) {
    rec.push([
      'skills',
      'no project skills — a multi-step procedure you repeat (scaffolding a feature, a release) belongs in one, loaded on invoke not every turn',
    ]);
  }
  if (
    srcFiles > 500 &&
    !(
      isRecord(projSettings) &&
      isRecord(projSettings.permissions) &&
      Array.isArray(projSettings.permissions.deny) &&
      projSettings.permissions.deny.length > 0
    )
  ) {
    rec.push([
      'settings: Read deny',
      'large tree with no Read deny rules — block generated and vendored paths',
    ]);
  }
  if (rec.length === 0) say('  nothing obvious — the mechanisms in use look proportionate');
  for (const [what, why] of rec) say(`  ${pad(what, 24)} ${why}`);
  if (rec.length > 0) {
    flag(
      'INFO',
      `${String(rec.length)} extension(s) this project could use — see the list above. Each one costs context, so add only what earns it.`,
    );
  }

  // ---------------------------------------------------------- cartographer
  // "Mapped" means the architecture map exists. Feature maps are built lazily — the first
  // change to a feature maps it, and the pre-edit hook reminds — so coverage is reported
  // rather than used as a pass/fail gate.
  const cov = await coverage(root, { stale: true });
  say();
  say('CARTOGRAPHER');
  say(
    `  memory${' '.repeat(27)}${cov.dir !== undefined ? cov.dir.slice(root.length + 1) : 'none yet'}`,
  );
  say(`  architecture map${' '.repeat(17)}${cov.architecture ? 'present' : 'MISSING'}`);
  if (cov.features.length > 0) {
    const pct = Math.round((cov.mapped.length / cov.features.length) * 100);
    say(
      `  features mapped${' '.repeat(18)}${String(cov.mapped.length)} of ${String(cov.features.length)} (${String(pct)}%) under ${cov.parents.join(', ')}`,
    );
    if (cov.mapped.length > 0) say(`    ${cov.mapped.map((f) => f.name).join(', ')}`);
    for (const f of cov.outdated) {
      say(`  STALE ${pad(f.name, 26)} mapped ${f.date}, code changed ${f.changed}  (${f.map})`);
    }
    if (cov.mapped.length < cov.features.length) {
      flag(
        'INFO',
        `${String(cov.features.length - cov.mapped.length)} of ${String(cov.features.length)} features have no cartographer map. They are mapped on first change; map the ones in active work now with /rulegate:map.`,
      );
    }
    if (cov.outdated.length > 0) {
      flag(
        'INFO',
        `${String(cov.outdated.length)} map(s) older than their feature's last commit (${cov.outdated.map((f) => f.name).join(', ')}) — the cartographer re-checks them on next use.`,
      );
    }
  } else {
    say(
      `  features${' '.repeat(25)}no feature directories found — set "features" in .claude/rulegate.json`,
    );
  }

  const hasLayer = residentBytes > 0 || ruleFiles.length > 0;
  const mapped = cov.dir !== undefined && cov.architecture;
  let mode: string;
  if (srcFiles < 5 && !hasLayer) mode = 'TOO-EARLY';
  else if (!hasLayer) mode = 'ESTABLISH';
  else if (anyLegacy || findings.some((f) => f.startsWith('WARN') || f.startsWith('FAIL')))
    mode = 'MIGRATE';
  else if (!mapped) mode = 'MAP';
  else mode = 'MAINTAIN';

  // ---------------------------------------------------------- setup state
  // Install and settings, as opposed to MODE, which is about the context layer.
  say();
  for (const l of describeState(setupState(root, claudeDir, { expect }))) say(l);

  say();
  say(`MODE  ${mode}`);
  say(
    {
      'TOO-EARLY':
        "  Barely any source yet. Do not build a context layer over nothing —\n  write code first, then run Claude Code's own /init, then come back.",
      ESTABLISH:
        '  Real code, no context layer. Build one FROM THE CODE: read\n  references/establishing.md. Do not invent conventions.',
      MIGRATE:
        '  A layer exists but has problems. Fix the findings below;\n  read references/migrating.md for anything legacy.',
      MAP: "  Layer is healthy but the codebase has never been mapped. Build the\n  architecture map: read references/establishing.md, 'Map the architecture'.",
      MAINTAIN: `  Layer is healthy and the architecture is mapped${cov.features.length > 0 ? ` (${String(cov.mapped.length)} of ${String(cov.features.length)} features)` : ''}.\n  Nothing to set up; remaining features are mapped as they are changed.`,
    }[mode] ?? '',
  );

  // ---------------------------------------------------------- verdict
  say();
  say(
    `STARTUP COST  ~${String(residentBytes)} B always loaded${rulegate ? '  (per-tool token estimate: npx rulegate doctor)' : ''}`,
  );
  say();
  if (findings.length === 0) say('VERDICT  no findings — setup is clean.');
  else {
    say(`VERDICT  ${String(findings.length)} finding(s), worst first:`);
    const order: Record<string, number> = { FAIL: 0, WARN: 1, INFO: 2 };
    const rank = (f: string): number => order[f.split(' ')[0] ?? ''] ?? 3;
    for (const f of [...findings].sort((a, b) => rank(a) - rank(b))) say(`  ${f}`);
  }
  return out;
}
