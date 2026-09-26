// src/lib/audit.ts
import { basename, join as join5 } from "node:path";

// src/lib/features.ts
import { join as join2 } from "node:path";

// src/git/index.ts
import { execFile } from "node:child_process";
var GIT_SUBCOMMANDS = Object.freeze([
  "log",
  "ls-files",
  "rev-parse",
  "status"
]);
var GIT_OPTIONS = Object.freeze([
  "-z",
  "--abbrev-ref",
  "--branch",
  "--cached",
  "--exclude-standard",
  "--format=",
  "--is-inside-work-tree",
  "--max-count=",
  "--others",
  "--porcelain",
  "--show-toplevel"
]);
var GIT_SAFETY_ARGS = Object.freeze([
  "--no-lazy-fetch",
  "--no-optional-locks",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "log.showSignature=false"
]);
function allowed(args) {
  const [subcommand, ...rest] = args;
  if (subcommand === void 0 || !GIT_SUBCOMMANDS.includes(subcommand)) return false;
  for (const arg of rest) {
    if (arg === "--") return true;
    if (!arg.startsWith("-")) continue;
    const ok = GIT_OPTIONS.some((opt) => opt.endsWith("=") ? arg.startsWith(opt) : arg === opt);
    if (!ok) return false;
  }
  return true;
}
function runGit(args, cwd) {
  if (!allowed(args)) return Promise.resolve(void 0);
  return new Promise((resolve) => {
    execFile(
      "git",
      [...GIT_SAFETY_ARGS, ...args],
      {
        cwd,
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
        encoding: "utf8",
        // A hook runs inside the 10-second timeout its hooks.json gives it; git must give up first.
        maxBuffer: 16 * 1024 * 1024,
        timeout: 5e3,
        shell: false
      },
      (error, stdout) => resolve(error ? void 0 : stdout)
    );
  });
}

// src/lib/read.ts
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
var MAX_READ_BYTES = 4 * 1024 * 1024;
function read(path) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return void 0;
    return readFileSync(path, "utf8");
  } catch {
    return void 0;
  }
}
function readInRepo(root, rel) {
  try {
    const target = realpathSync(join(root, rel));
    const within = relative(realpathSync(root), target);
    if (within === "" || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      return void 0;
    }
    return read(target);
  } catch {
    return void 0;
  }
}
function readJson(path) {
  const text = read(path);
  if (text === void 0) return void 0;
  try {
    return JSON.parse(text);
  } catch {
    return "INVALID";
  }
}
function ls(path) {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
function isRealDir(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
function size(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/lib/text.ts
var isControl = (c) => {
  const n = c.charCodeAt(0);
  return n < 32 || n === 127;
};
var hasControl = (s) => Array.from(s).some(isControl);

// src/lib/config.ts
var CONFIG_PATH = ".claude/rulegate.json";
var strings = (value) => Array.isArray(value) ? value.filter((v) => typeof v === "string") : void 0;
var inRepo = (p) => p !== "" && !hasControl(p) && !/^([/\\]|[A-Za-z]:)/.test(p) && !p.split(/[/\\]/).includes("..");
var MAX_ENTRIES = 20;
var paths = (value) => strings(value)?.filter(inRepo).slice(0, MAX_ENTRIES);
function rawConfig(root) {
  const text = readInRepo(root, CONFIG_PATH);
  if (text === void 0) return void 0;
  try {
    return JSON.parse(text);
  } catch {
    return void 0;
  }
}
function pluginConfig(root) {
  const raw = rawConfig(root);
  if (!isRecord(raw)) return {};
  const features = paths(raw.features);
  const handoff = paths(raw.handoff);
  const activeTask = paths(raw.activeTask);
  return {
    ...features ? { features } : {},
    ...typeof raw.cartographerReminder === "boolean" ? { cartographerReminder: raw.cartographerReminder } : {},
    ...handoff ? { handoff } : {},
    ...activeTask ? { activeTask } : {}
  };
}

// src/lib/features.ts
var DEFAULT_PARENTS = [
  "src/features",
  "src/modules",
  "app/features",
  "features",
  "modules"
];
var CARTOGRAPHER_DIRS = [
  "rulegate-feature-cartographer",
  "agent-os-feature-cartographer",
  "feature-cartographer"
];
var escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function featureParents(root) {
  const configured = pluginConfig(root).features;
  if (configured && configured.length > 0) {
    return configured.map((g) => g.replace(/\/\*+$/, "").replace(/\/$/, "")).filter(Boolean);
  }
  const found = DEFAULT_PARENTS.find((d) => isDir(join2(root, d)));
  return found ? [found] : [];
}
var MAX_FEATURES = 500;
function listFeatures(root) {
  const out = [];
  for (const parent of featureParents(root)) {
    for (const name of ls(join2(root, parent))) {
      if (out.length >= MAX_FEATURES) return out;
      if (!name.startsWith(".") && isDir(join2(root, parent, name))) {
        out.push({ name, dir: `${parent}/${name}` });
      }
    }
  }
  return out;
}
function cartographerDir(root) {
  for (const base of [".claude/agent-memory", ".claude/agent-memory-local"]) {
    for (const name of CARTOGRAPHER_DIRS) {
      const dir = join2(root, base, name);
      if (isDir(dir)) return dir;
    }
  }
  return void 0;
}
function mapFiles(root) {
  const dir = cartographerDir(root);
  if (dir === void 0) return [];
  return ls(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").map((file) => {
    const text = read(join2(dir, file)) ?? "";
    const m = /^mapped:\s*["']?(\d{4}-\d{2}-\d{2})/m.exec(text);
    return { file, text, mapped: m?.[1] };
  });
}
function findMap(feature, maps) {
  const named = new RegExp(`${escape(feature.dir)}(?![\\w-])`);
  const slug = feature.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  for (const m of maps) {
    if (m.file.startsWith("_")) continue;
    if (m.file.replace(/\.md$/, "").toLowerCase() === slug) return m;
    const header = m.text.split("\n").some((l) => /^(description:|entry:|#)/.test(l) && named.test(l));
    if (header || m.text.split(`${feature.dir}/`).length - 1 >= 2) return m;
  }
  return void 0;
}
async function lastChanged(root, dir) {
  const out = (await runGit(["log", "--max-count=1", "--format=%cs", "--", dir], root))?.trim();
  return out !== void 0 && /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : void 0;
}
async function coverage(root, { stale = false } = {}) {
  const features = listFeatures(root);
  const maps = mapFiles(root);
  const mapped = [];
  const unmapped = [];
  const outdated = [];
  for (const f of features) {
    const m = findMap(f, maps);
    if (m === void 0) {
      unmapped.push(f);
      continue;
    }
    mapped.push({ ...f, map: m.file, date: m.mapped });
    if (stale && m.mapped !== void 0) {
      const changed = await lastChanged(root, f.dir);
      if (changed !== void 0 && changed > m.mapped) {
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
    architecture: maps.some((m) => m.file === "_architecture.md"),
    dir: cartographerDir(root)
  };
}

// src/lib/settings.ts
import { join as join3 } from "node:path";
var TODO_ENV = "CLAUDE_CODE_ENABLE_TODO_TOOLS";
var TASK_RULE = `- **Always track work with the task tool (TaskCreate / TaskUpdate).** Any request
  with more than one step gets a task list before work starts: one task per
  deliverable, marked \`in_progress\` when started and \`completed\` only when
  verified. Keep it current as scope changes, including work delegated to
  subagents, so I can see what is done, running and left at any moment.`;
var TASK_RULE_FILE = ".rulegate/rules/working-agreement.md";
var GIT_DENY = Object.freeze([
  "Bash(git -C*)",
  "Bash(git -c*)",
  "Bash(git --git-dir*)",
  "Bash(git --work-tree*)",
  "Bash(git --exec-path*)",
  "Bash(git add *)",
  "Bash(git am *)",
  "Bash(git apply *)",
  "Bash(git bisect *)",
  "Bash(git branch *)",
  "Bash(git checkout *)",
  "Bash(git cherry-pick *)",
  "Bash(git clean *)",
  "Bash(git clone *)",
  "Bash(git commit *)",
  "Bash(git config *)",
  "Bash(git fast-import *)",
  "Bash(git filter-branch *)",
  "Bash(git gc *)",
  "Bash(git init *)",
  "Bash(git merge *)",
  "Bash(git mv *)",
  "Bash(git notes *)",
  "Bash(git prune *)",
  "Bash(git pull *)",
  "Bash(git push *)",
  "Bash(git rebase *)",
  "Bash(git reflog *)",
  "Bash(git remote *)",
  "Bash(git repack *)",
  "Bash(git replace *)",
  "Bash(git reset *)",
  "Bash(git restore *)",
  "Bash(git revert *)",
  "Bash(git rm *)",
  "Bash(git stash *)",
  "Bash(git submodule *)",
  "Bash(git switch *)",
  "Bash(git symbolic-ref *)",
  "Bash(git tag *)",
  "Bash(git update-ref *)",
  "Bash(git worktree *)"
]);
var normRule = (r) => r.replace(/:\*\)$/, " *)").replace(/\s+/g, " ");
function claudeHome(env, home) {
  return env.CLAUDE_CONFIG_DIR ?? join3(home, ".claude");
}
function settingsPath(scope, root, claudeDir) {
  return scope === "user" ? join3(claudeDir, "settings.json") : join3(root, ".claude/settings.json");
}
var isRulegateProject = (root) => isDir(join3(root, ".rulegate"));
function planSettings(text, { todo = true } = {}) {
  let settings = {};
  if (text !== void 0) {
    try {
      const parsed = JSON.parse(text);
      if (!isRecord(parsed)) throw new Error("not an object");
      settings = parsed;
    } catch {
      return { status: "invalid", denyAdded: [], env: void 0, current: void 0 };
    }
  }
  const perms = isRecord(settings.permissions) ? settings.permissions : {};
  const deny = Array.isArray(perms.deny) ? perms.deny.filter((r) => typeof r === "string") : [];
  const have = new Set(deny.map(normRule));
  const denyAdded = GIT_DENY.filter((r) => !have.has(normRule(r)));
  const envBlock = isRecord(settings.env) ? settings.env : {};
  let env;
  const current = envBlock[TODO_ENV];
  if (todo) {
    if (current === void 0) env = "added";
    else env = current === "1" || current === "true" || current === true ? "present" : "conflict";
  }
  if (denyAdded.length === 0 && env !== "added") {
    return { status: "unchanged", denyAdded, env, current };
  }
  const next = { ...settings };
  if (denyAdded.length > 0) next.permissions = { ...perms, deny: [...deny, ...denyAdded] };
  if (env === "added") next.env = { ...envBlock, [TODO_ENV]: "1" };
  return {
    status: "changed",
    denyAdded,
    env,
    current,
    next: `${JSON.stringify(next, null, 2)}
`
  };
}
function insertTaskRule(text) {
  const heading = /^##\s+Operator preferences\s*$/m.exec(text);
  let next;
  if (heading) {
    const start = heading.index + heading[0].length;
    const rest = text.slice(start);
    const nextHeading = rest.search(/^##\s+/m);
    const end = nextHeading === -1 ? text.length : start + nextHeading;
    next = `${text.slice(0, end).trimEnd()}

${TASK_RULE}

${text.slice(end)}`;
  } else {
    next = `${text.trimEnd()}

## Working agreement

${TASK_RULE}
`;
  }
  return {
    next: next.replace(/\n{4,}/g, "\n\n\n"),
    section: heading ? "Operator preferences" : "Working agreement"
  };
}
function planTaskRule(scope, root, claudeDir) {
  if (scope === "user") {
    const file = join3(claudeDir, "CLAUDE.md");
    const text2 = read(file);
    if (text2 === void 0) {
      return {
        status: "add",
        file,
        how: "new file",
        next: `# Personal working agreement

${TASK_RULE}
`
      };
    }
    if (/TaskCreate/.test(text2)) return { status: "present", file };
    const { next: next2, section: section2 } = insertTaskRule(text2);
    return { status: "add", file, how: section2, next: next2 };
  }
  if (isRulegateProject(root)) {
    const inRules = ls(join3(root, ".rulegate/rules")).some(
      (f) => /TaskCreate/.test(read(join3(root, ".rulegate/rules", f)) ?? "")
    );
    if (inRules || /TaskCreate/.test(read(join3(root, "CLAUDE.md")) ?? "")) {
      return { status: "present", file: TASK_RULE_FILE };
    }
    return {
      status: "add",
      file: TASK_RULE_FILE,
      how: "new rule, then `rulegate sync`",
      next: `---
description: Working agreement
tools: [claude-code]
---

${TASK_RULE}
`
    };
  }
  const text = read(join3(root, "CLAUDE.md"));
  if (text === void 0) return { status: "no-file", file: "CLAUDE.md" };
  if (/TaskCreate/.test(text)) return { status: "present", file: "CLAUDE.md" };
  const { next, section } = insertTaskRule(text);
  return { status: "add", file: "CLAUDE.md", how: section, next };
}
function planScope(scope, root, claudeDir) {
  const settingsFile = settingsPath(scope, root, claudeDir);
  return {
    scope,
    settingsFile,
    settings: planSettings(read(settingsFile)),
    rule: planTaskRule(scope, root, claudeDir)
  };
}

// src/lib/state.ts
import { realpathSync as realpathSync2 } from "node:fs";
import { join as join4 } from "node:path";
var PLUGIN_ID = "rulegate@rulegate";
var LEGACY_PLUGIN_ID = "agent-os@sayan-plugins";
var real = (p) => {
  try {
    return realpathSync2(p);
  } catch {
    return p;
  }
};
function cmpVersion(a, b) {
  const pa = (a ?? "0").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = (b ?? "0").split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
function enabledFlag(root, claudeDir, id) {
  for (const p of [
    join4(root, ".claude/settings.local.json"),
    join4(root, ".claude/settings.json"),
    join4(claudeDir, "settings.json")
  ]) {
    const s = readJson(p);
    if (isRecord(s) && isRecord(s.enabledPlugins) && typeof s.enabledPlugins[id] === "boolean") {
      return s.enabledPlugins[id];
    }
  }
  return void 0;
}
function pluginState(root, claudeDir, id = PLUGIN_ID) {
  const rootReal = real(root);
  const file = readJson(join4(claudeDir, "plugins/installed_plugins.json"));
  const all = isRecord(file) && isRecord(file.plugins) ? file.plugins[id] : void 0;
  const records = (Array.isArray(all) ? all : []).filter(isRecord);
  const mine = records.filter(
    (r) => r.scope === "user" || typeof r.projectPath === "string" && real(r.projectPath) === rootReal
  );
  const pick = mine.find((r) => r.scope === "project" || r.scope === "local") ?? mine[0];
  const [plugin, market] = id.split("@");
  const cached = readJson(
    join4(
      claudeDir,
      "plugins/marketplaces",
      market ?? "",
      "plugins",
      plugin ?? "",
      ".claude-plugin/plugin.json"
    )
  );
  return {
    installed: pick !== void 0,
    scope: typeof pick?.scope === "string" ? pick.scope : void 0,
    version: typeof pick?.version === "string" ? pick.version : void 0,
    enabled: pick !== void 0 && enabledFlag(root, claudeDir, id) !== false,
    latest: isRecord(cached) && typeof cached.version === "string" ? cached.version : void 0
  };
}
var AGENTS_SECTION = /rulegate:(feature-cartographer|builder|reviewer)/;
function setupState(root, claudeDir, { expect } = {}) {
  const items = [];
  const add = (key, label, ok, fix) => {
    items.push({ key, label, ok, fix });
  };
  const hasSource = isDir(join4(root, ".rulegate"));
  const claudeMd = read(join4(root, "CLAUDE.md"));
  add("source", ".rulegate/ canonical rules", hasSource, "npx rulegate init");
  add(
    "claude-md",
    "CLAUDE.md",
    claudeMd !== void 0,
    hasSource ? "rulegate sync" : "/init, then /rulegate:init"
  );
  const scopes = ["project", "user"];
  let taskRuleOk = true;
  let taskRuleFile = "";
  for (const scope of scopes) {
    const p = planScope(scope, root, claudeDir);
    const where = scope === "user" ? "~/.claude/settings.json" : ".claude/settings.json";
    if (scope === "project") {
      taskRuleOk = p.rule.status === "present";
      taskRuleFile = p.rule.file;
    }
    if (p.settings.status === "invalid") {
      add(`${scope}-settings`, `${where} is valid JSON`, false, `fix ${where} by hand`);
      continue;
    }
    const have = GIT_DENY.length - p.settings.denyAdded.length;
    add(
      `${scope}-git`,
      `${where} git write protection (${String(have)}/${String(GIT_DENY.length)})`,
      p.settings.denyAdded.length === 0,
      "/rulegate:init settings"
    );
    add(
      `${scope}-todo`,
      `${where} task tools`,
      p.settings.env !== "added",
      "/rulegate:init settings"
    );
  }
  if (claudeMd !== void 0 || hasSource) {
    add("task-rule", `task-tracking rule (${taskRuleFile})`, taskRuleOk, "/rulegate:init settings");
    add(
      "agents-section",
      "CLAUDE.md says when to use each agent",
      AGENTS_SECTION.test(claudeMd ?? ""),
      "/rulegate:init (references/establishing.md, Step 4b)"
    );
  }
  const pl = pluginState(root, claudeDir);
  const want = [expect, pl.latest].filter((v) => v !== void 0).sort((a, b) => cmpVersion(b, a))[0];
  add("plugin", "Claude Code plugin installed", pl.installed, `/plugin install ${PLUGIN_ID}`);
  if (pl.installed) {
    add("plugin-enabled", "plugin enabled", pl.enabled, `claude plugin enable ${PLUGIN_ID}`);
    const behind = want !== void 0 && cmpVersion(pl.version, want) < 0;
    add(
      "plugin-version",
      `plugin version ${pl.version ?? "unknown"}${behind ? ` (latest ${want})` : ""}`,
      !behind,
      `/plugin update ${PLUGIN_ID}, then /reload-plugins`
    );
  }
  if (enabledFlag(root, claudeDir, LEGACY_PLUGIN_ID) === true) {
    add(
      "legacy-plugin",
      "agent-os plugin disabled",
      false,
      `claude plugin disable ${LEGACY_PLUGIN_ID}`
    );
  }
  const setUp = AGENTS_SECTION.test(claudeMd ?? "") || ls(join4(root, ".claude/agent-memory")).some((d) => d.startsWith("rulegate-")) || read(join4(root, ".claude/rulegate.json")) !== void 0;
  const missing = items.filter((i) => !i.ok);
  const status = !setUp ? "fresh" : missing.length > 0 ? "repair" : "healthy";
  return { status, items, missing, plugin: pl };
}
function describeState(st) {
  const lines = [
    `SETUP  ${st.status.toUpperCase()}${st.status === "repair" ? `  \u2014 ${String(st.missing.length)} item(s) to fix` : ""}`
  ];
  for (const i of st.items) {
    lines.push(`  ${i.ok ? "ok     " : "MISSING"} ${i.label}${i.ok ? "" : `  \u2192 ${i.fix}`}`);
  }
  return lines;
}

// src/lib/audit.ts
var PLUGIN_AGENTS = [
  "orchestrator",
  "architect",
  "builder",
  "reviewer",
  "tester",
  "documenter",
  "feature-cartographer"
];
var PLUGIN_SKILLS = ["init", "map", "memory"];
var lineCount = (s) => s ? s.split("\n").length : 0;
var frontmatter = (t) => t.startsWith("---\n") ? t.slice(4).split("\n---")[0] ?? "" : "";
var pad = (s, n) => s.padEnd(n);
var num = (n, w) => String(n).padStart(w);
var WALK_BUDGET = 5e4;
function dirBytes(p, budget = { left: WALK_BUDGET }) {
  let n = 0;
  for (const f of ls(p)) {
    if (--budget.left < 0) break;
    const fp = join5(p, f);
    n += isRealDir(fp) ? dirBytes(fp, budget) : size(fp);
  }
  return n;
}
function recordedPaths(root) {
  const state = readJson(join5(root, ".rulegate/state.json"));
  const artifacts = isRecord(state) && Array.isArray(state.artifacts) ? state.artifacts : [];
  return new Set(
    artifacts.filter(isRecord).flatMap((a) => typeof a.path === "string" ? [a.path] : [])
  );
}
async function runAudit({
  root,
  claudeDir,
  today,
  expect
}) {
  const out = [];
  const findings = [];
  const say = (s = "") => {
    out.push(s);
  };
  const flag = (sev, msg) => {
    findings.push(`${sev}  ${msg}`);
  };
  const rulegate = isRulegateProject(root);
  const recorded = recordedPaths(root);
  say(`RULEGATE AUDIT   ${root}`);
  say(`                 ${today}`);
  say();
  let residentBytes = 0;
  say("ALWAYS-LOADED  (cost on every turn)");
  for (const f of ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]) {
    const t = read(join5(root, f));
    if (!t) continue;
    const n = lineCount(t);
    residentBytes += t.length;
    const over = n > 200;
    const generated2 = recorded.has(f);
    say(
      `  ${pad(f, 30)} ${num(n, 4)} lines  ${num(t.length, 6)} B  ${over ? "OVER BUDGET (>200)" : "ok"}${generated2 ? "  (generated)" : ""}`
    );
    if (over) {
      flag(
        "WARN",
        generated2 ? `${f} is ${String(n)} lines; budget is 200. It is generated \u2014 trim or narrow rules in .rulegate/rules/ (a \`tools:\` selector, or \`globs:\` for file-scoped content), not the file.` : `${f} is ${String(n)} lines; budget is 200. Move path-scoped content to .claude/rules/.`
      );
    }
  }
  if (!residentBytes) {
    flag("WARN", "No CLAUDE.md at all \u2014 this project has no always-loaded instructions.");
  } else if (!AGENTS_SECTION.test(read(join5(root, "CLAUDE.md")) ?? "")) {
    flag(
      "INFO",
      'CLAUDE.md does not say when to use the rulegate agents \u2014 add the "Agents in this project" section (references/establishing.md, Step 4b).'
    );
  }
  say();
  if (rulegate) {
    const rules = ls(join5(root, ".rulegate/rules")).filter((f) => f.endsWith(".md"));
    say(
      `RULEGATE  .rulegate/  \u2014 ${String(rules.length)} rule(s), ${String(recorded.size)} generated file(s) recorded`
    );
    say(
      "  drift: run `npx rulegate check` \u2014 exit 1 means a generated file is stale or hand-edited"
    );
    say("  cost:  `npx rulegate doctor` reports what each tool loads and its token estimate");
  } else {
    say("RULEGATE  no .rulegate/ \u2014 rules are not generated here");
    flag(
      "INFO",
      "No .rulegate/ \u2014 `npx rulegate init` imports this project's existing agent configs into one canonical source. The plugin's generated-file guard has nothing to protect until then."
    );
  }
  const rulesDir = join5(root, ".claude/rules");
  const ruleFiles = ls(rulesDir).filter((f) => f.endsWith(".md"));
  say();
  say(`RULES  .claude/rules/  \u2014 ${String(ruleFiles.length)} file(s)`);
  if (ruleFiles.length === 0 && !isDir(rulesDir)) say("  (no rules directory)");
  for (const f of ruleFiles) {
    const t = read(join5(rulesDir, f)) ?? "";
    const fm = frontmatter(t);
    const scoped = /^paths:/m.test(fm);
    const globs = (fm.match(/-\s+["']/g) ?? []).length;
    say(
      `  ${scoped ? "ok  " : "WARN"} ${pad(f, 26)} ${num(lineCount(t), 4)} lines  ${scoped ? `paths: ${String(globs)}` : "NO paths: \u2014 loads every session"}`
    );
    if (!scoped) {
      residentBytes += t.length;
      flag(
        "WARN",
        `.claude/rules/${f} has no paths: frontmatter, so it loads every session like CLAUDE.md.`
      );
    }
  }
  const projSettings = readJson(join5(root, ".claude/settings.json"));
  say();
  say("HOOKS  .claude/settings.json");
  if (projSettings === void 0) say("  (no project settings.json)");
  else if (projSettings === "INVALID") flag("FAIL", ".claude/settings.json is not valid JSON.");
  else if (isRecord(projSettings)) {
    const hooks = isRecord(projSettings.hooks) ? projSettings.hooks : {};
    if (Object.keys(hooks).length === 0) say("  (none)");
    for (const [evt, entries] of Object.entries(hooks)) {
      for (const e of Array.isArray(entries) ? entries.filter(isRecord) : []) {
        for (const h of Array.isArray(e.hooks) ? e.hooks.filter(isRecord) : []) {
          const cmd = typeof h.command === "string" ? h.command : "";
          const m = /\$\{?CLAUDE_PROJECT_DIR\}?\/([^"']+)/.exec(cmd);
          if (m?.[1] === void 0) {
            say(`  ok   ${pad(evt, 14)} ${cmd.slice(0, 60)}`);
            continue;
          }
          const target = m[1];
          const exists = isFile(join5(root, target));
          if (/cartographer-reminder/.test(target)) {
            flag(
              "INFO",
              `${target} duplicates the plugin's own pre-edit reminder \u2014 remove the project copy and its hook entry.`
            );
          }
          say(
            `  ${exists ? "ok  " : "FAIL"} ${pad(evt, 14)} ${target}${exists ? "" : "  <- TARGET MISSING"}`
          );
          if (!exists) {
            flag(
              "FAIL",
              `${evt} hook points at ${target}, which does not exist. It fires at a missing path every session.`
            );
          }
        }
      }
    }
  }
  say();
  say("LEGACY STORES");
  const legacy = [
    ["memory-bank/", "memory-bank"],
    [".serena/memories/", ".serena/memories"],
    [".cursorrules", ".cursorrules"],
    [".cursor/rules/", ".cursor/rules"],
    [".windsurfrules", ".windsurfrules"],
    [".clinerules", ".clinerules"],
    [".agent-os/", ".agent-os"]
  ];
  const generated = (rel) => {
    const files = isDir(join5(root, rel)) ? ls(join5(root, rel)).map((f) => `${rel}/${f}`) : [rel];
    const readable = files.filter((f) => isFile(join5(root, f)));
    return readable.length > 0 && readable.every((f) => recorded.has(f));
  };
  let anyLegacy = false;
  let anyListed = false;
  for (const [label, rel] of legacy) {
    const p = join5(root, rel);
    if (!isDir(p) && !isFile(p)) continue;
    const dir = isDir(p);
    const n = dir ? ls(p).length : 1;
    const b = dir ? dirBytes(p) : size(p);
    anyListed = true;
    if (generated(rel)) {
      say(
        `  ${pad(label, 22)} ${String(n)} file(s)  ${String(b)} B  \u2014 generated by rulegate, not legacy`
      );
      continue;
    }
    anyLegacy = true;
    say(`  FOUND ${pad(label, 22)} ${String(n)} file(s)  ${String(b)} B`);
    flag(
      "INFO",
      rel === ".agent-os" ? ".agent-os/ exists \u2014 `npx rulegate init` imports it (T113); references/migrating.md covers the rest." : `${label} exists \u2014 preserve its content in ${rulegate ? ".rulegate/rules/" : "CLAUDE.md or .claude/rules/"} before deleting anything.`
    );
  }
  const mcp = readJson(join5(root, ".mcp.json"));
  const servers = isRecord(mcp) && isRecord(mcp.mcpServers) ? Object.keys(mcp.mcpServers) : [];
  if (isRecord(mcp)) {
    const memoryish = servers.filter((s) => /graphiti|memory|knowledge|mem0|zep|serena/i.test(s));
    say(`  .mcp.json servers: ${servers.join(", ") || "(none)"}`);
    if (memoryish.length > 0) {
      flag(
        "INFO",
        `.mcp.json has memory-ish server(s): ${memoryish.join(", ")}. Check they are still wanted.`
      );
    }
  }
  if (!anyListed) say("  none");
  say();
  say("MEMORY");
  for (const base of [".claude/agent-memory", ".claude/agent-memory-local"]) {
    const dir = join5(root, base);
    for (const agent of ls(dir)) {
      const adir = join5(dir, agent);
      if (!isDir(adir)) continue;
      const topics = ls(adir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
      const idx = read(join5(adir, "MEMORY.md"));
      const idxLines = idx ? idx.split("\n").filter((l) => l.trim()).length : 0;
      say(
        `  ${pad(agent, 34)} index ${num(idxLines, 3)} line(s)   ${String(topics.length)} topic file(s)`
      );
      if (idxLines < topics.length) {
        flag(
          "WARN",
          `${agent}: ${String(topics.length)} topic files but only ${String(idxLines)} indexed in MEMORY.md \u2014 the unindexed ones are invisible next session.`
        );
      }
      const slugs = topics.map((f) => basename(f, ".md").replace(/[-_]/g, ""));
      if (slugs.some((s, i) => slugs.indexOf(s) !== i)) {
        flag(
          "WARN",
          `${agent}: near-duplicate topic filenames (hyphen/underscore variants). Merge them.`
        );
      }
      if (idx && idx.split("\n").length > 200) {
        flag(
          "WARN",
          `${agent}: MEMORY.md over 200 lines \u2014 everything past that is dropped at startup.`
        );
      }
      for (const d of ls(adir).filter((e) => isDir(join5(adir, e)))) {
        flag(
          "WARN",
          `${agent}/${d}/ is a folder inside agent memory${d === ".claude" ? " \u2014 a memory write resolved against the wrong root" : ""}. Move any topic files up into ${agent}/ and delete it.`
        );
      }
      if (agent.startsWith("agent-os-")) {
        flag(
          "INFO",
          `${agent} is agent-os's memory \u2014 /rulegate:init moves it to rulegate-${agent.slice("agent-os-".length)} (T114).`
        );
      }
    }
  }
  if (!isDir(join5(root, ".claude/agent-memory")) && !isDir(join5(root, ".claude/agent-memory-local"))) {
    say("  no agent memory yet (agents have not run in this project)");
  }
  say();
  say(`MACHINE  ${claudeDir}`);
  const gClaude = read(join5(claudeDir, "CLAUDE.md"));
  say(`  CLAUDE.md${" ".repeat(24)}${gClaude ? `present  ${String(gClaude.length)} B` : "ABSENT"}`);
  if (!gClaude && residentBytes && /~\/\.claude\/CLAUDE\.md/.test(read(join5(root, "CLAUDE.md")) ?? "")) {
    flag(
      "FAIL",
      "Project CLAUDE.md refers to ~/.claude/CLAUDE.md, which does not exist \u2014 a dangling reference."
    );
  }
  for (const [d, names] of [
    ["agents", PLUGIN_AGENTS],
    ["skills", PLUGIN_SKILLS]
  ]) {
    const have = ls(join5(claudeDir, d)).map((f) => basename(f, ".md"));
    say(`  ${pad(`${d}/`, 33)}${have.length > 0 ? have.join(", ") : "absent"}`);
    const clash = have.filter((n) => names.includes(n));
    if (clash.length > 0) {
      flag(
        "FAIL",
        `~/.claude/${d}/ contains ${clash.join(", ")} \u2014 user scope OVERRIDES the plugin's copy, so plugin updates stop reaching you.`
      );
    }
  }
  const projClash = ls(join5(root, ".claude/agents")).map((f) => basename(f, ".md")).filter((n) => PLUGIN_AGENTS.includes(n));
  if (projClash.length > 0) {
    flag(
      "FAIL",
      `.claude/agents/ contains ${projClash.join(", ")} \u2014 shadows the plugin agent of the same name.`
    );
  }
  if (enabledFlag(root, claudeDir, LEGACY_PLUGIN_ID) === true) {
    flag(
      "FAIL",
      `${LEGACY_PLUGIN_ID} is still enabled \u2014 its session block prints next to this plugin's and its guard knows nothing of state.json. Disable it: claude plugin disable ${LEGACY_PLUGIN_ID}.`
    );
  }
  const gs = readJson(join5(claudeDir, "settings.json"));
  if (gs === "INVALID") flag("FAIL", "~/.claude/settings.json is not valid JSON.");
  else if (isRecord(gs)) {
    const perms = isRecord(gs.permissions) ? gs.permissions : {};
    const deny = Array.isArray(perms.deny) ? perms.deny : [];
    const mode2 = typeof perms.defaultMode === "string" ? perms.defaultMode : "(unset)";
    say(`  permissions.defaultMode${" ".repeat(10)}${mode2}`);
    say(`  permissions.deny${" ".repeat(17)}${String(deny.length)} rule(s)`);
    if (/auto|accept/i.test(mode2) && deny.length === 0) {
      flag(
        "WARN",
        `defaultMode is "${mode2}" with an empty deny list. A CLAUDE.md rule is context, not enforcement \u2014 see references/git-permissions.md.`
      );
    }
  } else say("  settings.json                    absent");
  {
    const denyOf = (st) => {
      const p = isRecord(st) && isRecord(st.permissions) ? st.permissions : {};
      const d = Array.isArray(p.deny) ? p.deny.filter((r) => typeof r === "string") : [];
      return new Set(d.map(normRule));
    };
    const envOn = (st) => isRecord(st) && isRecord(st.env) && ["1", "true", true].includes(st.env[TODO_ENV]);
    const u = denyOf(gs);
    const pj = denyOf(projSettings);
    const uHave = GIT_DENY.filter((r) => u.has(normRule(r))).length;
    const pHave = GIT_DENY.filter((r) => pj.has(normRule(r))).length;
    const total = String(GIT_DENY.length);
    say(
      `  git write protection            user ${String(uHave)}/${total}  project ${String(pHave)}/${total}`
    );
    say(
      `  env.${TODO_ENV}  user ${envOn(gs) ? "on" : "off"}  project ${envOn(projSettings) ? "on" : "off"}`
    );
    if (uHave < GIT_DENY.length || pHave < GIT_DENY.length) {
      flag(
        "INFO",
        `git write protection incomplete (user ${String(uHave)}/${total}, project ${String(pHave)}/${total}) \u2014 the settings pass applies it.`
      );
    }
    if (!envOn(gs) && !envOn(projSettings)) {
      flag(
        "INFO",
        `${TODO_ENV} is not on in user or project settings \u2014 the settings pass turns it on.`
      );
    }
  }
  say();
  say("PROJECT");
  const pkg = readJson(join5(root, "package.json"));
  const deps = isRecord(pkg) ? {
    ...isRecord(pkg.dependencies) ? pkg.dependencies : {},
    ...isRecord(pkg.devDependencies) ? pkg.devDependencies : {}
  } : {};
  const dep = (n) => n in deps;
  const stacks = [];
  if (dep("next")) stacks.push("Next.js");
  else if (dep("react")) stacks.push("React");
  if (dep("vue")) stacks.push("Vue");
  if (dep("@nestjs/core")) stacks.push("NestJS");
  else if (dep("express")) stacks.push("Express");
  if (dep("typescript")) stacks.push("TypeScript");
  if (dep("prisma") || dep("@prisma/client")) stacks.push("Prisma");
  for (const [f, label] of [
    ["pyproject.toml", "Python"],
    ["requirements.txt", "Python"],
    ["go.mod", "Go"],
    ["Cargo.toml", "Rust"],
    ["pom.xml", "Java/Maven"],
    ["Gemfile", "Ruby"],
    ["composer.json", "PHP"]
  ]) {
    if (isFile(join5(root, f)) && !stacks.includes(label)) stacks.push(label);
  }
  const SKIP = /* @__PURE__ */ new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "vendor",
    ".next",
    "target",
    "__pycache__",
    ".venv",
    "coverage"
  ]);
  const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|vue|svelte|kt|swift|cs)$/;
  let srcFiles = 0;
  let srcBytes = 0;
  let budget = WALK_BUDGET;
  const walk = (d, depth) => {
    if (depth > 8 || srcFiles > 2e4) return;
    for (const e of ls(d)) {
      if (--budget < 0) return;
      if (SKIP.has(e) || e.startsWith(".")) continue;
      const fp = join5(d, e);
      if (isRealDir(fp)) walk(fp, depth + 1);
      else if (CODE.test(e)) {
        srcFiles++;
        srcBytes += size(fp);
      }
    }
  };
  walk(root, 0);
  say(`  stack${" ".repeat(28)}${stacks.join(", ") || "not detected"}`);
  say(
    `  source files${" ".repeat(21)}${String(srcFiles)}  (~${String(Math.round(srcBytes / 1024))} KB)`
  );
  const LSP = {
    TypeScript: "typescript-lsp",
    Python: "pyright-lsp",
    Go: "gopls-lsp",
    Rust: "rust-analyzer-lsp",
    "Java/Maven": "jdtls-lsp",
    Ruby: "ruby-lsp",
    PHP: "php-lsp"
  };
  const wantLsp = stacks.map((s) => LSP[s]).filter((s) => s !== void 0);
  if (wantLsp[0] !== void 0 && srcFiles > 50) {
    flag(
      "INFO",
      `Install code intelligence: /plugin install ${wantLsp[0]}@claude-plugins-official \u2014 lets Claude jump to a definition instead of scanning files.`
    );
  }
  const gi = read(join5(root, ".gitignore")) ?? "";
  const unignored = ["dist", "build", "vendor", "generated", "src/generated", ".next"].filter((d) => isDir(join5(root, d))).filter((d) => !gi.split("\n").some((l) => l.trim().replace(/\/$/, "") === d));
  if (unignored.length > 0) {
    flag(
      "INFO",
      `Checked-in generated/vendored dirs (${unignored.join(", ")}) \u2014 add Read deny rules so Claude never opens them.`
    );
  }
  say();
  say("WHAT THIS PROJECT COULD ADD");
  const rec = [];
  const pkgDirs = ["packages", "apps", "services", "libs"].filter((d) => isDir(join5(root, d)));
  const subs = pkgDirs.flatMap((d) => ls(join5(root, d)).filter((s) => isDir(join5(root, d, s))));
  if (subs.length >= 3) {
    rec.push([
      "CLAUDE.md (nested)",
      `${String(subs.length)} packages under ${pkgDirs.join("/")} \u2014 a per-package CLAUDE.md loads only when Claude reads there${rulegate ? " (a nested .rulegate/ generates it)" : ""}`
    ]);
  }
  const lintCfg = [
    "eslint.config.js",
    ".eslintrc",
    ".eslintrc.json",
    "biome.json",
    "ruff.toml",
    ".golangci.yml"
  ].find((f) => isFile(join5(root, f)));
  const hookEvents = isRecord(projSettings) && isRecord(projSettings.hooks) ? Object.keys(projSettings.hooks) : [];
  if (lintCfg !== void 0 && !hookEvents.includes("PostToolUse")) {
    rec.push([
      "hook: PostToolUse",
      `${lintCfg} exists but nothing lints after an edit \u2014 a PostToolUse hook feeds errors straight back`
    ]);
  }
  const fast = [
    "react",
    "next",
    "tailwindcss",
    "react-router-dom",
    "vue",
    "svelte",
    "@angular/core"
  ].filter(dep);
  if (fast.length > 0 && !servers.includes("context7")) {
    rec.push([
      "MCP: context7",
      `${fast.slice(0, 3).join(", ")} move faster than model training \u2014 context7 serves current API docs`
    ]);
  }
  if (ls(join5(root, ".claude/skills")).length === 0 && srcFiles > 100) {
    rec.push([
      "skills",
      "no project skills \u2014 a multi-step procedure you repeat (scaffolding a feature, a release) belongs in one, loaded on invoke not every turn"
    ]);
  }
  if (srcFiles > 500 && !(isRecord(projSettings) && isRecord(projSettings.permissions) && Array.isArray(projSettings.permissions.deny) && projSettings.permissions.deny.length > 0)) {
    rec.push([
      "settings: Read deny",
      "large tree with no Read deny rules \u2014 block generated and vendored paths"
    ]);
  }
  if (rec.length === 0) say("  nothing obvious \u2014 the mechanisms in use look proportionate");
  for (const [what, why] of rec) say(`  ${pad(what, 24)} ${why}`);
  if (rec.length > 0) {
    flag(
      "INFO",
      `${String(rec.length)} extension(s) this project could use \u2014 see the list above. Each one costs context, so add only what earns it.`
    );
  }
  const cov = await coverage(root, { stale: true });
  say();
  say("CARTOGRAPHER");
  say(
    `  memory${" ".repeat(27)}${cov.dir !== void 0 ? cov.dir.slice(root.length + 1) : "none yet"}`
  );
  say(`  architecture map${" ".repeat(17)}${cov.architecture ? "present" : "MISSING"}`);
  if (cov.features.length > 0) {
    const pct = Math.round(cov.mapped.length / cov.features.length * 100);
    say(
      `  features mapped${" ".repeat(18)}${String(cov.mapped.length)} of ${String(cov.features.length)} (${String(pct)}%) under ${cov.parents.join(", ")}`
    );
    if (cov.mapped.length > 0) say(`    ${cov.mapped.map((f) => f.name).join(", ")}`);
    for (const f of cov.outdated) {
      say(`  STALE ${pad(f.name, 26)} mapped ${f.date}, code changed ${f.changed}  (${f.map})`);
    }
    if (cov.mapped.length < cov.features.length) {
      flag(
        "INFO",
        `${String(cov.features.length - cov.mapped.length)} of ${String(cov.features.length)} features have no cartographer map. They are mapped on first change; map the ones in active work now with /rulegate:map.`
      );
    }
    if (cov.outdated.length > 0) {
      flag(
        "INFO",
        `${String(cov.outdated.length)} map(s) older than their feature's last commit (${cov.outdated.map((f) => f.name).join(", ")}) \u2014 the cartographer re-checks them on next use.`
      );
    }
  } else {
    say(
      `  features${" ".repeat(25)}no feature directories found \u2014 set "features" in .claude/rulegate.json`
    );
  }
  const hasLayer = residentBytes > 0 || ruleFiles.length > 0;
  const mapped = cov.dir !== void 0 && cov.architecture;
  let mode;
  if (srcFiles < 5 && !hasLayer) mode = "TOO-EARLY";
  else if (!hasLayer) mode = "ESTABLISH";
  else if (anyLegacy || findings.some((f) => f.startsWith("WARN") || f.startsWith("FAIL")))
    mode = "MIGRATE";
  else if (!mapped) mode = "MAP";
  else mode = "MAINTAIN";
  say();
  for (const l of describeState(setupState(root, claudeDir, { expect }))) say(l);
  say();
  say(`MODE  ${mode}`);
  say(
    {
      "TOO-EARLY": "  Barely any source yet. Do not build a context layer over nothing \u2014\n  write code first, then run Claude Code's own /init, then come back.",
      ESTABLISH: "  Real code, no context layer. Build one FROM THE CODE: read\n  references/establishing.md. Do not invent conventions.",
      MIGRATE: "  A layer exists but has problems. Fix the findings below;\n  read references/migrating.md for anything legacy.",
      MAP: "  Layer is healthy but the codebase has never been mapped. Build the\n  architecture map: read references/establishing.md, 'Map the architecture'.",
      MAINTAIN: `  Layer is healthy and the architecture is mapped${cov.features.length > 0 ? ` (${String(cov.mapped.length)} of ${String(cov.features.length)} features)` : ""}.
  Nothing to set up; remaining features are mapped as they are changed.`
    }[mode] ?? ""
  );
  say();
  say(
    `STARTUP COST  ~${String(residentBytes)} B always loaded${rulegate ? "  (per-tool token estimate: npx rulegate doctor)" : ""}`
  );
  say();
  if (findings.length === 0) say("VERDICT  no findings \u2014 setup is clean.");
  else {
    say(`VERDICT  ${String(findings.length)} finding(s), worst first:`);
    const order = { FAIL: 0, WARN: 1, INFO: 2 };
    const rank = (f) => order[f.split(" ")[0] ?? ""] ?? 3;
    for (const f of [...findings].sort((a, b) => rank(a) - rank(b))) say(`  ${f}`);
  }
  return out;
}

// src/lib/entry.ts
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
function rootArg(argv) {
  return argv.find((a) => !a.startsWith("--")) ?? process.cwd();
}
function claudeDirFromEnv() {
  return claudeHome(process.env, homedir());
}
function bundledVersion(entryUrl) {
  const manifest = readJson(fileURLToPath(new URL("../.claude-plugin/plugin.json", entryUrl)));
  return isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : void 0;
}
function print(lines) {
  process.stdout.write(`${lines.join("\n")}
`);
}

// src/audit.ts
try {
  print(
    await runAudit({
      root: rootArg(process.argv.slice(2)),
      claudeDir: claudeDirFromEnv(),
      today: (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
      expect: bundledVersion(import.meta.url)
    })
  );
} catch (error) {
  print([`audit failed: ${error instanceof Error ? error.message : String(error)}`]);
}
