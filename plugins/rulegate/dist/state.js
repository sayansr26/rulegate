var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};

// ../../packages/core/src/fs/glob.ts
var init_glob = __esm({
  "../../packages/core/src/fs/glob.ts"() {
    "use strict";
  }
});

// src/lib/entry.ts
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// src/lib/read.ts
import { isUtf8 } from "node:buffer";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
var MAX_READ_BYTES = 4 * 1024 * 1024;
function read(path2) {
  try {
    const st = statSync(path2);
    if (!st.isFile() || st.size > MAX_READ_BYTES) return void 0;
    return readFileSync(path2, "utf8");
  } catch {
    return void 0;
  }
}
function isUtf8File(path2) {
  try {
    const st = statSync(path2);
    return st.isFile() && st.size <= MAX_READ_BYTES && isUtf8(readFileSync(path2));
  } catch {
    return false;
  }
}
function readJson(path2) {
  const text = read(path2);
  if (text === void 0) return void 0;
  try {
    return JSON.parse(text);
  } catch {
    return "INVALID";
  }
}
function ls(path2) {
  try {
    return readdirSync(path2).sort();
  } catch {
    return [];
  }
}
function isDir(path2) {
  try {
    return statSync(path2).isDirectory();
  } catch {
    return false;
  }
}
function exists(path2) {
  try {
    lstatSync(path2);
    return true;
  } catch {
    return false;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/lib/settings.ts
import { join, resolve } from "node:path";
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
var PLUGIN_ID = "rulegate@rulegate";
var MARKETPLACE_NAME = "rulegate";
var LEGACY_PLUGIN_ID = "agent-os@sayan-plugins";
var LEGACY_MARKETPLACE = "sayan-plugins";
var MARKETPLACE_ENTRY = {
  source: { source: "github", repo: "sayansr26/rulegate" }
};
function enabledAt(root, claudeDir, id) {
  for (const [scope, p] of [
    ["local", join(root, ".claude/settings.local.json")],
    ["project", join(root, ".claude/settings.json")],
    ["user", join(claudeDir, "settings.json")]
  ]) {
    const value = enabledIn(p, id);
    if (value !== void 0) return { value, scope };
  }
  return void 0;
}
function enabledIn(file, id) {
  const s = readJson(file);
  return isRecord(s) && isRecord(s.enabledPlugins) && typeof s.enabledPlugins[id] === "boolean" ? s.enabledPlugins[id] : void 0;
}
function enabledFlag(root, claudeDir, id) {
  return enabledAt(root, claudeDir, id)?.value;
}
var normRule = (r) => r.replace(/:\*\)$/, " *)").replace(/\s+/g, " ");
function claudeHome(env, home) {
  return resolve(env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
}
function settingsPath(scope, root, claudeDir) {
  return scope === "user" ? join(claudeDir, "settings.json") : join(root, ".claude/settings.json");
}
var isRulegateProject = (root) => isDir(join(root, ".rulegate"));
function ruleTarget(scope, root, claudeDir) {
  if (scope === "user") return join(claudeDir, "CLAUDE.md");
  return isRulegateProject(root) ? join(root, TASK_RULE_FILE) : join(root, "CLAUDE.md");
}
function swapMarketplace(markets) {
  const out = {};
  for (const [k, v] of Object.entries(markets)) if (k !== LEGACY_MARKETPLACE) out[k] = v;
  if (!(MARKETPLACE_NAME in out)) out[MARKETPLACE_NAME] = MARKETPLACE_ENTRY;
  return out;
}
function planSettings(text, { todo = true, retireMarketplace } = {}) {
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
  const markets = isRecord(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : void 0;
  const marketplace = retireMarketplace === void 0 || markets === void 0 || !(LEGACY_MARKETPLACE in markets) ? void 0 : retireMarketplace ? "retire" : "blocked";
  const withMarket = marketplace === void 0 ? {} : { marketplace };
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
  if (denyAdded.length === 0 && env !== "added" && marketplace !== "retire") {
    return { status: "unchanged", denyAdded, env, current, ...withMarket };
  }
  const next = { ...settings };
  if (denyAdded.length > 0) next.permissions = { ...perms, deny: [...deny, ...denyAdded] };
  if (env === "added") next.env = { ...envBlock, [TODO_ENV]: "1" };
  if (marketplace === "retire" && markets !== void 0) {
    next.extraKnownMarketplaces = swapMarketplace(markets);
  }
  return {
    status: "changed",
    denyAdded,
    env,
    current,
    ...withMarket,
    next: `${JSON.stringify(next, null, 2)}
`
  };
}
function insertTaskRule(input) {
  const crlf = input.includes("\r\n") && !/(^|[^\r])\n/.test(input);
  const text = crlf ? input.replace(/\r\n/g, "\n") : input;
  const heading = /^##\s+Operator preferences\s*$/m.exec(text);
  let next;
  const pad = (before) => before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  if (heading) {
    const start = heading.index + heading[0].length;
    const rest = text.slice(start);
    const nextHeading = rest.search(/^##\s+/m);
    const end = nextHeading === -1 ? text.length : start + nextHeading;
    const before = text.slice(0, end);
    const after = text.slice(end);
    next = `${before}${pad(before)}${TASK_RULE}
${after === "" ? "" : "\n"}${after}`;
  } else {
    next = `${text}${pad(text)}## Working agreement

${TASK_RULE}
`;
  }
  return {
    next: crlf ? next.replace(/\n/g, "\r\n") : next,
    section: heading ? "Operator preferences" : "Working agreement"
  };
}
function planTaskRule(scope, root, claudeDir) {
  if (scope === "user") {
    const file = join(claudeDir, "CLAUDE.md");
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
    const inRules = ls(join(root, ".rulegate/rules")).some(
      (f) => /TaskCreate/.test(read(join(root, ".rulegate/rules", f)) ?? "")
    );
    if (inRules || /TaskCreate/.test(read(join(root, "CLAUDE.md")) ?? "")) {
      return { status: "present", file: TASK_RULE_FILE };
    }
    if (exists(join(root, TASK_RULE_FILE))) return { status: "exists", file: TASK_RULE_FILE };
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
  const text = read(join(root, "CLAUDE.md"));
  if (text === void 0) return { status: "no-file", file: "CLAUDE.md" };
  if (/TaskCreate/.test(text)) return { status: "present", file: "CLAUDE.md" };
  const { next, section } = insertTaskRule(text);
  return { status: "add", file: "CLAUDE.md", how: section, next };
}
function planScope(scope, root, claudeDir) {
  const settingsFile = settingsPath(scope, root, claudeDir);
  const retireMarketplace = scope === "project" ? enabledFlag(root, claudeDir, LEGACY_PLUGIN_ID) !== true && enabledIn(settingsFile, LEGACY_PLUGIN_ID) !== true : void 0;
  return {
    scope,
    settingsFile,
    settings: planSettings(read(settingsFile), { retireMarketplace }),
    rule: planTaskRule(scope, root, claudeDir)
  };
}

// src/lib/entry.ts
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

// src/lib/state.ts
import { realpathSync as realpathSync4 } from "node:fs";
import { join as join6 } from "node:path";

// src/lib/legacy.ts
import { join as join2 } from "node:path";
var MEMORY_BASES = [".claude/agent-memory", ".claude/agent-memory-local"];
var LEGACY_PREFIX = "agent-os-";
var MEMORY_PREFIX = "rulegate-";
function agentOsInstall(root, claudeDir) {
  const at = enabledAt(root, claudeDir, LEGACY_PLUGIN_ID);
  const plugin = at?.value === true ? at.scope : void 0;
  const shared = plugin === void 0 && enabledIn(join2(root, ".claude/settings.json"), LEGACY_PLUGIN_ID) === true;
  const memory = [];
  for (const base of MEMORY_BASES) {
    const names = ls(join2(root, base));
    for (const name of names) {
      if (!name.startsWith(LEGACY_PREFIX) || !isDir(join2(root, base, name))) continue;
      const target = `${MEMORY_PREFIX}${name.slice(LEGACY_PREFIX.length)}`;
      memory.push({ base, name, target, split: names.includes(target) });
    }
  }
  const source = isDir(join2(root, ".agent-os"));
  const project = readJson(join2(root, ".claude/settings.json"));
  const marketplace = isRecord(project) && isRecord(project.extraKnownMarketplaces) && LEGACY_MARKETPLACE in project.extraKnownMarketplaces;
  return {
    plugin,
    shared,
    // Installed goes without saying — this runs from the installed plugin — so enabled is
    // anything short of an explicit `false`.
    bothEnabled: plugin !== void 0 && enabledFlag(root, claudeDir, PLUGIN_ID) !== false,
    memory,
    source,
    imported: source && isDir(join2(root, ".rulegate")),
    marketplace,
    found: plugin !== void 0 || shared || memory.length > 0 || source || marketplace
  };
}
function disableCommand(scope) {
  return `claude plugin disable ${LEGACY_PLUGIN_ID} --scope ${scope === "project" ? "project" : "local"}`;
}

// src/lib/migrate.ts
import { createHash } from "node:crypto";
import { lstatSync as lstatSync3, readFileSync as readFileSync2 } from "node:fs";
import { join as join5 } from "node:path";

// src/lib/refusals.ts
import { lstatSync as lstatSync2, realpathSync as realpathSync3 } from "node:fs";
import { basename as basename2, dirname as dirname2, isAbsolute as isAbsolute2, join as join4, relative as relative2, sep as sep2 } from "node:path";

// ../../packages/core/src/model/paths.ts
var RULEGATE_DIR = ".rulegate";
var MANIFEST_PATH = `${RULEGATE_DIR}/rulegate.yaml`;
var RULES_DIR = `${RULEGATE_DIR}/rules`;
var RULES_GLOB = `${RULES_DIR}/**/*.md`;
var MCP_DIR = `${RULEGATE_DIR}/mcp`;
var MCP_SERVERS_PATH = `${MCP_DIR}/servers.yaml`;
var STATE_PATH = `${RULEGATE_DIR}/state.json`;
var BACKUP_DIR = `${RULEGATE_DIR}/backup`;

// ../../packages/core/src/fs/case.ts
function foldPath(relPath) {
  return relPath.toLowerCase();
}
function pathKeyFor(caseInsensitive) {
  return caseInsensitive ? foldPath : (relPath) => relPath;
}
function flipCase(name) {
  let flipped = "";
  for (const char of name) {
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    flipped += char === lower ? upper : lower;
  }
  return flipped;
}
async function probeCaseInsensitive(fs) {
  let entries;
  try {
    entries = await fs.listDir("");
  } catch {
    return false;
  }
  const listed = new Set(entries.map((e) => e.name));
  for (const entry of entries) {
    if (entry.kind !== "file") continue;
    const flipped = flipCase(entry.name);
    if (listed.has(flipped)) continue;
    return await fs.exists(flipped);
  }
  return false;
}

// ../../packages/core/src/index.ts
init_glob();

// ../../packages/core/src/state/state.ts
function parseState(text) {
  if (text === void 0 || text.trim() === "") return void 0;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return void 0;
  }
  if (typeof raw !== "object" || raw === null) return void 0;
  const record = raw;
  if (typeof record["schemaVersion"] !== "number") return void 0;
  if (!Array.isArray(record["artifacts"])) return void 0;
  const artifacts = [];
  for (const entry of record["artifacts"]) {
    if (typeof entry !== "object" || entry === null) return void 0;
    const item = entry;
    if (typeof item["path"] !== "string" || typeof item["hash"] !== "string" || typeof item["adapter"] !== "string" || typeof item["kind"] !== "string") {
      return void 0;
    }
    artifacts.push({
      path: item["path"],
      hash: item["hash"],
      adapter: item["adapter"],
      kind: item["kind"]
    });
  }
  return { schemaVersion: record["schemaVersion"], artifacts };
}
function findArtifact(state, path2, key = (p) => p) {
  const wanted = key(path2);
  return state.artifacts.find((a) => key(a.path) === wanted);
}

// ../../packages/core/src/io/node.ts
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
function findRepoRoot(startDir) {
  const start = path.resolve(startDir);
  const home = path.resolve(os.homedir());
  let dir = start;
  let outermost;
  for (; ; ) {
    if (probe(path.join(dir, ".git"))) return dir;
    if (probe(path.join(dir, RULEGATE_DIR))) outermost = dir;
    const parent = path.dirname(dir);
    if (parent === dir || dir === home) return outermost ?? start;
    dir = parent;
  }
}
function probe(absPath) {
  try {
    return existsSync(absPath);
  } catch {
    return false;
  }
}

// src/lib/guard.ts
import { existsSync as existsSync2, readdirSync as readdirSync2, realpathSync as realpathSync2 } from "node:fs";
import { basename, dirname, isAbsolute, join as join3, relative, resolve as resolve2, sep } from "node:path";

// src/lib/text.ts
var isControl = (c) => {
  const n = c.charCodeAt(0);
  return n < 32 || n === 127;
};
var stripControl = (s) => Array.from(s, (c) => isControl(c) ? " " : c).join("");

// src/git/index.ts
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

// src/lib/session.ts
var inline = (s) => stripControl(s).replace(/`/g, "");

// src/lib/guard.ts
function realish(p) {
  const rest = [];
  let dir = p;
  for (let i = 0; i < 256; i++) {
    try {
      return join3(realpathSync2.native(dir), ...[...rest].reverse());
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return p;
      rest.push(basename(dir));
      dir = parent;
    }
  }
  return p;
}
function within(root, abs) {
  const rel = relative(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return void 0;
  return rel.split(sep).join("/");
}
function probeView(root) {
  return {
    listDir: (rel) => Promise.resolve(
      readdirSync2(join3(root, rel), { withFileTypes: true }).map((e) => ({
        name: e.name,
        kind: e.isSymbolicLink() ? "symlink" : e.isDirectory() ? "dir" : "file"
      }))
    ),
    exists: (rel) => Promise.resolve(existsSync2(join3(root, rel)))
  };
}
function ownerOf(abs) {
  const root = findRepoRoot(dirname(abs));
  const state = parseState(read(join3(root, STATE_PATH)));
  return state === void 0 ? void 0 : { root, state };
}
async function judge(abs) {
  const owner = ownerOf(abs);
  if (owner === void 0) return void 0;
  const rel = within(owner.root, abs);
  if (rel === void 0) return void 0;
  const key = pathKeyFor(await probeCaseInsensitive(probeView(owner.root)));
  if (key(rel) === key(STATE_PATH) || key(rel).startsWith(key(".rulegate/backup/"))) {
    return {
      kind: "deny",
      reason: `${inline(rel)} is maintained by \`rulegate sync\` and \`rulegate restore\`, not by hand. Edit .rulegate/rules/ and run \`rulegate sync\`.`
    };
  }
  const artifact = findArtifact(owner.state, rel, key);
  if (artifact === void 0) return void 0;
  return {
    kind: "deny",
    reason: `${inline(artifact.path)} is generated by Rulegate (${inline(artifact.adapter)}) from .rulegate/rules/, and the next \`rulegate sync\` would revert this edit. Make the change in the rule that produces it, then run \`rulegate sync\`. If the file already carries a hand-edit worth keeping, \`rulegate sync --import\` merges it back into the rule.`
  };
}
async function guard(targetAbs) {
  const spellings = [.../* @__PURE__ */ new Set([resolve2(targetAbs), realish(targetAbs)])];
  for (const abs of spellings) {
    const decision = await judge(abs);
    if (decision !== void 0) return decision;
  }
  return void 0;
}

// src/lib/refusals.ts
function real(p) {
  const rest = [];
  let at = p;
  for (; ; ) {
    try {
      return join4(realpathSync3.native(at), ...rest.reverse());
    } catch {
      const up = dirname2(at);
      if (up === at) return p;
      rest.push(basename2(at));
      at = up;
    }
  }
}
function inside(dir, abs) {
  const rel = relative2(real(dir), real(abs));
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep2}`) || isAbsolute2(rel));
}
function unreadableState(abs) {
  const state = join4(findRepoRoot(dirname2(abs)), STATE_PATH);
  if (!exists(state)) return false;
  const text = read(state);
  return text?.trim() !== "" && parseState(text) === void 0;
}
async function blocked(scope, root, claudeDir, abs, { bytes = false } = {}) {
  if (scope === "project") {
    if (inside(claudeDir, abs)) {
      return "this is the user-level Claude config \u2014 `--scope user` changes it, backup first";
    }
    const rel = relative2(root, abs);
    let at = root;
    for (const part of rel.split(sep2)) {
      at = join4(at, part);
      if (!exists(at)) break;
      const st = lstatSync2(at);
      if (st.isSymbolicLink()) return `${relative2(root, at)} is a symlink`;
      if (at !== abs && !st.isDirectory()) return `${relative2(root, at)} is not a directory`;
      if (at === abs && !st.isFile()) return "not a regular file";
    }
  } else if (exists(abs)) {
    const st = lstatSync2(abs);
    if (st.isSymbolicLink()) return "a symlink \u2014 edit the file it points at by hand";
    if (!st.isFile()) return "not a regular file";
  }
  if (!bytes && exists(abs) && read(abs) === void 0) {
    return "could not be read (permissions, or larger than 4 MB) \u2014 left as it is";
  }
  if (!bytes && exists(abs) && !isUtf8File(abs)) {
    return "not UTF-8 text \u2014 rewriting it would replace the bytes it cannot decode";
  }
  if (unreadableState(abs)) {
    return ".rulegate/state.json does not parse, so ownership cannot be checked \u2014 fix it first";
  }
  if ((await guard(abs))?.kind === "deny") {
    return "generated by Rulegate (recorded in .rulegate/state.json)";
  }
  return void 0;
}
async function refusals(plan, root, claudeDir) {
  const out = [];
  const s = plan.settings;
  if (s.status === "invalid") {
    out.push({ item: "settings", file: plan.settingsFile, reason: "not valid JSON" });
  } else if (s.status === "changed") {
    const why = await blocked(plan.scope, root, claudeDir, plan.settingsFile);
    if (why !== void 0) out.push({ item: "settings", file: plan.settingsFile, reason: why });
  }
  const r = plan.rule;
  if (r.status === "exists") {
    out.push({ item: "rule", file: r.file, reason: "exists without the task-tracking rule" });
  } else if (r.status === "add") {
    const why = await blocked(plan.scope, root, claudeDir, ruleTarget(plan.scope, root, claudeDir));
    if (why !== void 0) out.push({ item: "rule", file: r.file, reason: why });
  }
  return out;
}

// src/lib/migrate.ts
var AGENT_NAME = /^agent-os-[a-z0-9][a-z0-9_-]*$/i;
var KEPT_INDEX = "MEMORY.agent-os.md";
var MAX_KEPT = 100;
var keptName = (n) => n === 1 ? KEPT_INDEX : `MEMORY.agent-os.${String(n)}.md`;
var keptPointer = (name) => `- [agent-os index](${name}) \u2014 agent-os's MEMORY.md, kept whole when the two were merged`;
var MAX_ENTRIES = 5e3;
var sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
function stat(p) {
  try {
    return lstatSync3(p);
  } catch {
    return void 0;
  }
}
function walk(dir) {
  const dirs = [];
  const files = [];
  let left = MAX_ENTRIES;
  const visit = (rel) => {
    for (const name of ls(rel === "" ? dir : join5(dir, rel))) {
      if (--left < 0) return `more than ${String(MAX_ENTRIES)} entries`;
      const r = rel === "" ? name : `${rel}/${name}`;
      const st = stat(join5(dir, r));
      if (st === void 0) return `${r} vanished while being read`;
      if (st.isSymbolicLink()) return `${r} is a symlink`;
      if (st.isDirectory()) {
        dirs.push(r);
        const why2 = visit(r);
        if (why2 !== void 0) return why2;
      } else if (st.isFile()) files.push(r);
      else return `${r} is not a regular file`;
    }
    return void 0;
  };
  const why = visit("");
  return why === void 0 ? { dirs, files } : { reason: why };
}
var norm = (line) => line.replace(/^\uFEFF/, "").replace(/\r$/, "").trimEnd();
function unionIndex(target, source, first = []) {
  const have = new Set(target.split("\n").map(norm));
  const take = (lines) => {
    const out = [];
    for (const raw of lines) {
      const line = norm(raw);
      if (line.trim() === "" || line.trimStart().startsWith("#") || have.has(line)) continue;
      have.add(line);
      out.push(line);
    }
    return out;
  };
  const top = take(first);
  const tail = take(source.split("\n"));
  const added = [...top, ...tail];
  if (added.length === 0) return { added };
  const crlf = target.includes("\r\n") && !/(^|[^\r])\n/.test(target);
  const eol = crlf ? "\r\n" : "\n";
  let head = "";
  let rest = target;
  if (top.length > 0) {
    let at = 0;
    for (const line of target.split("\n")) {
      const l = norm(line);
      if (l.trim() !== "" && !l.trimStart().startsWith("#")) break;
      at += line.length + 1;
    }
    if (at < target.length) {
      head = `${target.slice(0, at)}${top.join(eol)}${eol}`;
      rest = target.slice(at);
    } else tail.unshift(...top);
  }
  const body = `${head}${rest}`;
  if (tail.length === 0) return { added, next: body };
  const lead = body === "" || body.endsWith("\n") ? "" : eol;
  return { added, next: `${body}${lead}${tail.join(eol)}${eol}` };
}
async function planAgent(root, claudeDir, base, from, to) {
  const srcDir = join5(root, base, from);
  const dstDir = join5(root, base, to);
  const shell = { base, from, to, srcDir, dstDir, dirs: [], files: [] };
  const refuse = (reason) => ({ ...shell, kind: "refused", reason });
  if (!AGENT_NAME.test(from)) return refuse("not a plain agent name");
  const parts = [...base.split("/"), from];
  for (let i = 1; i <= parts.length; i++) {
    const rel = parts.slice(0, i).join("/");
    if (stat(join5(root, rel))?.isSymbolicLink() === true) return refuse(`${rel} is a symlink`);
  }
  if (inside(claudeDir, srcDir)) {
    return refuse("this is the user-level Claude config, not a project \u2014 run from the project");
  }
  const target = stat(dstDir);
  if (target !== void 0 && (target.isSymbolicLink() || !target.isDirectory())) {
    return refuse(`${to} exists and is not a directory`);
  }
  const tree = walk(srcDir);
  if ("reason" in tree) return refuse(tree.reason);
  for (const d of tree.dirs) {
    const st = stat(join5(dstDir, d));
    if (st !== void 0 && (st.isSymbolicLink() || !st.isDirectory())) {
      return refuse(`${to}/${d} exists and is not a directory`);
    }
  }
  const files = [];
  const conflicts = [];
  for (const rel of tree.files) {
    const src = join5(srcDir, rel);
    const dst = join5(dstDir, rel);
    for (const p of [src, dst]) {
      const why = await blocked("project", root, claudeDir, p, { bytes: true });
      if (why !== void 0) return refuse(`${p === src ? from : to}/${rel}: ${why}`);
    }
    let bytes;
    try {
      bytes = readFileSync2(src);
    } catch {
      return refuse(`${from}/${rel} could not be read`);
    }
    const sha = sha256(bytes);
    const there = stat(dst);
    if (there === void 0) {
      files.push({ rel, action: "copy", src, dst, sha });
      continue;
    }
    let theirs;
    try {
      theirs = readFileSync2(dst);
    } catch {
      return refuse(`${to}/${rel} could not be read`);
    }
    if (theirs.equals(bytes)) files.push({ rel, action: "same", src, dst, sha });
    else if (rel === "MEMORY.md") {
      for (const p of [src, dst]) {
        const why = await blocked("project", root, claudeDir, p);
        if (why !== void 0) return refuse(`${p === src ? from : to}/${rel}: ${why}`);
      }
      let name;
      let keptBytes;
      for (let n = 1; n <= MAX_KEPT && name === void 0; n++) {
        const candidate = keptName(n);
        if (tree.files.includes(candidate)) continue;
        const kept = join5(dstDir, candidate);
        const why = await blocked("project", root, claudeDir, kept, { bytes: true });
        if (why !== void 0) return refuse(`${to}/${candidate}: ${why}`);
        if (stat(kept) === void 0) {
          name = candidate;
          keptBytes = void 0;
          break;
        }
        try {
          keptBytes = readFileSync2(kept);
        } catch {
          return refuse(`${to}/${candidate} could not be read`);
        }
        if (keptBytes.equals(bytes)) name = candidate;
      }
      if (name === void 0) {
        return refuse(`${String(MAX_KEPT)} kept agent-os indexes already \u2014 merge them by hand`);
      }
      files.push({
        rel: name,
        action: keptBytes === void 0 ? "copy" : "same",
        src,
        dst: join5(dstDir, name),
        sha,
        alias: true
      });
      const { next, added } = unionIndex(theirs.toString("utf8"), read(src) ?? "", [
        keptPointer(name)
      ]);
      files.push({
        rel,
        action: "union",
        src,
        dst,
        sha,
        added,
        dstSha: sha256(theirs),
        ...next === void 0 ? {} : { next }
      });
    } else conflicts.push(rel);
  }
  if (conflicts.length > 0) {
    return refuse(
      `${conflicts.join(", ")} differ${conflicts.length === 1 ? "s" : ""} from ${to}/ \u2014 merge by hand (/rulegate:memory), then re-run`
    );
  }
  const dirs = tree.dirs.map((rel) => ({ rel, src: join5(srcDir, rel), dst: join5(dstDir, rel) }));
  return { ...shell, kind: target === void 0 ? "move" : "merge", dirs, files };
}
async function planMemoryMigration(root, claudeDir) {
  const agents = [];
  for (const m of agentOsInstall(root, claudeDir).memory) {
    agents.push(await planAgent(root, claudeDir, m.base, m.name, m.target));
  }
  const gitignore = [];
  for (const f of [".gitignore", ".claude/.gitignore"]) {
    (read(join5(root, f)) ?? "").split("\n").forEach((line, i) => {
      if (line.includes(LEGACY_PREFIX)) gitignore.push(`${f}:${String(i + 1)}  ${norm(line)}`);
    });
  }
  return { agents, gitignore };
}

// src/lib/state.ts
var real2 = (p) => {
  try {
    return realpathSync4(p);
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
function pluginState(root, claudeDir, id = PLUGIN_ID) {
  const rootReal = real2(root);
  const file = readJson(join6(claudeDir, "plugins/installed_plugins.json"));
  const all = isRecord(file) && isRecord(file.plugins) ? file.plugins[id] : void 0;
  const records = (Array.isArray(all) ? all : []).filter(isRecord);
  const mine = records.filter(
    (r) => r.scope === "user" || typeof r.projectPath === "string" && real2(r.projectPath) === rootReal
  );
  const pick = mine.find((r) => r.scope === "project" || r.scope === "local") ?? mine[0];
  const [plugin, market] = id.split("@");
  const cached = readJson(
    join6(
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
async function setupState(root, claudeDir, { expect } = {}) {
  const items = [];
  const add = (key, label, ok, fix) => {
    items.push({ key, label, ok, fix });
  };
  const hasSource = isDir(join6(root, ".rulegate"));
  const claudeMd = read(join6(root, "CLAUDE.md"));
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
  let taskRuleFix = "/rulegate:init settings";
  let marketplace;
  const byHand = (reason) => `the settings pass refuses this \u2014 ${reason}`;
  for (const scope of scopes) {
    const p = planScope(scope, root, claudeDir);
    const refused = await refusals(p, root, claudeDir);
    const settingsRefused = refused.find((r) => r.item === "settings");
    const ruleRefused = refused.find((r) => r.item === "rule");
    const where = scope === "user" ? "~/.claude/settings.json" : ".claude/settings.json";
    if (scope === "project" && p.settings.marketplace !== void 0) {
      marketplace = {
        state: p.settings.marketplace,
        fix: settingsRefused === void 0 ? "/rulegate:init settings" : byHand(settingsRefused.reason)
      };
    }
    if (scope === "project") {
      taskRuleOk = p.rule.status === "present";
      taskRuleFile = p.rule.file;
      if (p.rule.status === "exists") {
        taskRuleFix = `add the rule to ${p.rule.file} by hand, then \`rulegate sync\``;
      } else if (ruleRefused !== void 0) {
        taskRuleFix = byHand(ruleRefused.reason);
      }
    }
    if (p.settings.status === "invalid") {
      add(`${scope}-settings`, `${where} is valid JSON`, false, `fix ${where} by hand`);
      continue;
    }
    const fix = settingsRefused === void 0 ? "/rulegate:init settings" : byHand(settingsRefused.reason);
    const have = GIT_DENY.length - p.settings.denyAdded.length;
    add(
      `${scope}-git`,
      `${where} git write protection (${String(have)}/${String(GIT_DENY.length)})`,
      p.settings.denyAdded.length === 0,
      fix
    );
    add(`${scope}-todo`, `${where} task tools`, p.settings.env !== "added", fix);
  }
  if (claudeMd !== void 0 || hasSource) {
    add("task-rule", `task-tracking rule (${taskRuleFile})`, taskRuleOk, taskRuleFix);
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
  const legacy = agentOsInstall(root, claudeDir);
  if (legacy.plugin !== void 0 || legacy.shared) {
    add(
      "legacy-plugin",
      "agent-os plugin disabled",
      false,
      disableCommand(legacy.plugin ?? "project")
    );
  }
  if (legacy.memory.length > 0) {
    const refused = (await planMemoryMigration(root, claudeDir)).agents.filter(
      (a) => a.kind === "refused"
    );
    add(
      "legacy-memory",
      `agent-os memory moved to rulegate-* (${String(legacy.memory.length)} left)`,
      false,
      refused.length === 0 ? "/rulegate:init (migrate-memory.js)" : `the migration refuses ${refused.map((a) => `${a.base}/${a.from} \u2014 ${a.reason ?? ""}`).join("; ")}`
    );
  }
  if (marketplace !== void 0) {
    add(
      "legacy-marketplace",
      `.claude/settings.json declares ${MARKETPLACE_NAME}, not ${LEGACY_MARKETPLACE}`,
      false,
      marketplace.state === "retire" ? marketplace.fix : `${disableCommand(legacy.plugin ?? "project")}, then ${marketplace.fix}`
    );
  }
  const setUp = legacy.found || AGENTS_SECTION.test(claudeMd ?? "") || ls(join6(root, ".claude/agent-memory")).some((d) => d.startsWith("rulegate-")) || read(join6(root, ".claude/rulegate.json")) !== void 0;
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

// src/state.ts
print(
  describeState(
    await setupState(rootArg(process.argv.slice(2)), claudeDirFromEnv(), {
      expect: bundledVersion(import.meta.url)
    })
  )
);
