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

// src/settings.ts
import { resolve as resolve3 } from "node:path";

// src/lib/entry.ts
import { homedir } from "node:os";

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
var normRule = (r) => r.replace(/:\*\)$/, " *)").replace(/\s+/g, " ");
function claudeHome(env, home) {
  return resolve(env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
}
function settingsPath(scope2, root2, claudeDir2) {
  return scope2 === "user" ? join(claudeDir2, "settings.json") : join(root2, ".claude/settings.json");
}
var isRulegateProject = (root2) => isDir(join(root2, ".rulegate"));
function ruleTarget(scope2, root2, claudeDir2) {
  if (scope2 === "user") return join(claudeDir2, "CLAUDE.md");
  return isRulegateProject(root2) ? join(root2, TASK_RULE_FILE) : join(root2, "CLAUDE.md");
}
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
function planTaskRule(scope2, root2, claudeDir2) {
  if (scope2 === "user") {
    const file = join(claudeDir2, "CLAUDE.md");
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
  if (isRulegateProject(root2)) {
    const inRules = ls(join(root2, ".rulegate/rules")).some(
      (f) => /TaskCreate/.test(read(join(root2, ".rulegate/rules", f)) ?? "")
    );
    if (inRules || /TaskCreate/.test(read(join(root2, "CLAUDE.md")) ?? "")) {
      return { status: "present", file: TASK_RULE_FILE };
    }
    if (exists(join(root2, TASK_RULE_FILE))) return { status: "exists", file: TASK_RULE_FILE };
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
  const text = read(join(root2, "CLAUDE.md"));
  if (text === void 0) return { status: "no-file", file: "CLAUDE.md" };
  if (/TaskCreate/.test(text)) return { status: "present", file: "CLAUDE.md" };
  const { next, section } = insertTaskRule(text);
  return { status: "add", file: "CLAUDE.md", how: section, next };
}
function planScope(scope2, root2, claudeDir2) {
  const settingsFile = settingsPath(scope2, root2, claudeDir2);
  return {
    scope: scope2,
    settingsFile,
    settings: planSettings(read(settingsFile)),
    rule: planTaskRule(scope2, root2, claudeDir2)
  };
}
function describeScope(p, { dry, refused: refused2 = [], backups = [] }) {
  const verb = dry ? "would add" : "added";
  const s = p.settings;
  const lines = [`${p.scope === "user" ? "USER" : "PROJECT"}  ${p.settingsFile}`];
  const refusedSettings = refused2.find((r2) => r2.item === "settings");
  const refusedRule = refused2.find((r2) => r2.item === "rule");
  const refusal = (reason) => dry ? `will be refused \u2014 ${reason}` : `refused \u2014 ${reason}; nothing written`;
  if (refusedSettings !== void 0 && s.status !== "invalid") {
    lines.push(`  ${refusal(refusedSettings.reason)}`);
  } else if (s.status === "invalid") {
    lines.push("  not valid JSON \u2014 left alone; fix it and re-run");
  } else {
    const have = GIT_DENY.length - s.denyAdded.length;
    lines.push(
      s.denyAdded.length > 0 ? `  permissions.deny   ${verb} ${String(s.denyAdded.length)} git write rule(s)${have > 0 ? ` (${String(have)} already there)` : ""}` : "  permissions.deny   git write protection already complete"
    );
    if (s.env === "added") lines.push(`  env.${TODO_ENV}  ${verb} "1"`);
    else if (s.env === "present") lines.push(`  env.${TODO_ENV}  already on`);
    else if (s.env === "conflict")
      lines.push(`  env.${TODO_ENV}  is "${String(s.current)}" \u2014 left as set`);
  }
  const r = p.rule;
  if (refusedRule !== void 0 && r.status === "add") {
    lines.push(`  ${r.file}  ${refusal(refusedRule.reason)}`);
  } else if (r.status === "add") {
    lines.push(`  ${r.file}  ${verb} the task-tracking rule (${r.how ?? ""})`);
    if (!dry && r.file === TASK_RULE_FILE) lines.push("  now run `rulegate sync`");
  } else if (r.status === "present") lines.push(`  ${r.file}  task-tracking rule already there`);
  else if (r.status === "exists") {
    lines.push(
      `  ${r.file}  exists without the task-tracking rule \u2014 left alone; add the rule by hand, then run \`rulegate sync\``
    );
  } else lines.push(`  ${r.file}  absent \u2014 /rulegate:init builds it`);
  for (const b of backups) lines.push(`  backup  ${b}`);
  return lines;
}

// src/lib/entry.ts
function claudeDirFromEnv() {
  return claudeHome(process.env, homedir());
}
function print(lines) {
  process.stdout.write(`${lines.join("\n")}
`);
}

// src/lib/refusals.ts
import { lstatSync as lstatSync2, realpathSync as realpathSync3 } from "node:fs";
import { basename as basename2, dirname as dirname2, isAbsolute as isAbsolute2, join as join3, relative as relative2, sep as sep2 } from "node:path";

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
import { basename, dirname, isAbsolute, join as join2, relative, resolve as resolve2, sep } from "node:path";

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
      return join2(realpathSync2.native(dir), ...[...rest].reverse());
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return p;
      rest.push(basename(dir));
      dir = parent;
    }
  }
  return p;
}
function within(root2, abs) {
  const rel = relative(root2, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return void 0;
  return rel.split(sep).join("/");
}
function probeView(root2) {
  return {
    listDir: (rel) => Promise.resolve(
      readdirSync2(join2(root2, rel), { withFileTypes: true }).map((e) => ({
        name: e.name,
        kind: e.isSymbolicLink() ? "symlink" : e.isDirectory() ? "dir" : "file"
      }))
    ),
    exists: (rel) => Promise.resolve(existsSync2(join2(root2, rel)))
  };
}
function ownerOf(abs) {
  const root2 = findRepoRoot(dirname(abs));
  const state = parseState(read(join2(root2, STATE_PATH)));
  return state === void 0 ? void 0 : { root: root2, state };
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
      return join3(realpathSync3.native(at), ...rest.reverse());
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
  const state = join3(findRepoRoot(dirname2(abs)), STATE_PATH);
  if (!exists(state)) return false;
  const text = read(state);
  return text?.trim() !== "" && parseState(text) === void 0;
}
async function blocked(scope2, root2, claudeDir2, abs) {
  if (scope2 === "project") {
    if (inside(claudeDir2, abs)) {
      return "this is the user-level Claude config \u2014 `--scope user` changes it, backup first";
    }
    const rel = relative2(root2, abs);
    let at = root2;
    for (const part of rel.split(sep2)) {
      at = join3(at, part);
      if (!exists(at)) break;
      const st = lstatSync2(at);
      if (st.isSymbolicLink()) return `${relative2(root2, at)} is a symlink`;
      if (at !== abs && !st.isDirectory()) return `${relative2(root2, at)} is not a directory`;
      if (at === abs && !st.isFile()) return "not a regular file";
    }
  } else if (exists(abs)) {
    const st = lstatSync2(abs);
    if (st.isSymbolicLink()) return "a symlink \u2014 edit the file it points at by hand";
    if (!st.isFile()) return "not a regular file";
  }
  if (exists(abs) && read(abs) === void 0) {
    return "could not be read (permissions, or larger than 4 MB) \u2014 left as it is";
  }
  if (exists(abs) && !isUtf8File(abs)) {
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
async function refusals(plan, root2, claudeDir2) {
  const out2 = [];
  const s = plan.settings;
  if (s.status === "invalid") {
    out2.push({ item: "settings", file: plan.settingsFile, reason: "not valid JSON" });
  } else if (s.status === "changed") {
    const why = await blocked(plan.scope, root2, claudeDir2, plan.settingsFile);
    if (why !== void 0) out2.push({ item: "settings", file: plan.settingsFile, reason: why });
  }
  const r = plan.rule;
  if (r.status === "exists") {
    out2.push({ item: "rule", file: r.file, reason: "exists without the task-tracking rule" });
  } else if (r.status === "add") {
    const why = await blocked(plan.scope, root2, claudeDir2, ruleTarget(plan.scope, root2, claudeDir2));
    if (why !== void 0) out2.push({ item: "rule", file: r.file, reason: why });
  }
  return out2;
}

// src/settings-writer/apply.ts
import {
  constants,
  copyFileSync,
  lstatSync as lstatSync3,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { dirname as dirname3 } from "node:path";
var BACKUP_SUFFIX = ".rulegate.bak";
function replaceFile(file, next) {
  mkdirSync(dirname3(file), { recursive: true });
  const mode = exists(file) ? lstatSync3(file).mode & 511 : 438;
  let saved;
  if (exists(file)) {
    try {
      copyFileSync(file, `${file}${BACKUP_SUFFIX}`, constants.COPYFILE_EXCL);
      saved = `${file}${BACKUP_SUFFIX}`;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
  }
  const tmp = `${file}.${String(process.pid)}.rulegate-tmp`;
  let created = false;
  try {
    writeFileSync(tmp, next, { flag: "wx", mode });
    created = true;
    renameSync(tmp, file);
  } catch (e) {
    if (created) rmSync(tmp, { force: true });
    throw e;
  }
  return saved;
}
var failure = (e) => `could not write (${e.code ?? String(e)})`;
async function applyScope(scope2, root2, claudeDir2) {
  const plan = planScope(scope2, root2, claudeDir2);
  const written = [];
  const backups = [];
  const refused2 = await refusals(plan, root2, claudeDir2);
  const isRefused = (item) => refused2.some((x) => x.item === item);
  const s = plan.settings;
  const settingsFile = settingsPath(scope2, root2, claudeDir2);
  if (s.status === "changed" && s.next !== void 0 && !isRefused("settings")) {
    try {
      const saved = replaceFile(settingsFile, s.next);
      if (saved !== void 0) backups.push(saved);
      written.push(settingsFile);
    } catch (e) {
      refused2.push({ item: "settings", file: settingsFile, reason: failure(e) });
    }
  }
  const r = plan.rule;
  if (r.status === "add" && r.next !== void 0 && !isRefused("rule")) {
    const ruleFile = ruleTarget(scope2, root2, claudeDir2);
    try {
      if (r.file === TASK_RULE_FILE) {
        mkdirSync(dirname3(ruleFile), { recursive: true });
        writeFileSync(ruleFile, r.next, { flag: "wx" });
      } else {
        const saved = replaceFile(ruleFile, r.next);
        if (saved !== void 0) backups.push(saved);
      }
      written.push(ruleFile);
    } catch (e) {
      refused2.push({ item: "rule", file: r.file, reason: failure(e) });
    }
  }
  return { plan, written, backups, refused: refused2 };
}

// src/settings.ts
var usage = (message) => {
  print([message, "usage: settings.js [--root <dir>] [--scope project|user|both] [--apply]"]);
  process.exit(2);
};
var argv = process.argv.slice(2);
var values = /* @__PURE__ */ new Map();
var apply = false;
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i] ?? "";
  if (flag === "--apply") {
    apply = true;
    continue;
  }
  if (flag !== "--root" && flag !== "--scope") usage(`unknown argument "${flag}"`);
  const value = argv[++i];
  if (value === void 0 || value === "" || value.startsWith("--")) usage(`${flag} needs a value`);
  values.set(flag, value ?? "");
}
var scope = values.get("--scope") ?? "both";
if (scope !== "both" && scope !== "project" && scope !== "user") {
  usage(`--scope must be project, user or both (got "${scope}")`);
}
var scopes = scope === "both" ? ["project", "user"] : [scope];
var root = resolve3(values.get("--root") ?? process.cwd());
if (!isDir(root)) usage(`--root must be an existing directory (got "${root}")`);
var claudeDir = claudeDirFromEnv();
var out = [
  `RULEGATE SETTINGS  ${apply ? "applied" : "preview \u2014 nothing written; re-run with --apply"}`,
  ""
];
var refused = false;
for (const s of scopes) {
  if (apply) {
    const r = await applyScope(s, root, claudeDir);
    refused ||= r.refused.length > 0;
    out.push(...describeScope(r.plan, { dry: false, refused: r.refused, backups: r.backups }), "");
  } else {
    const plan = planScope(s, root, claudeDir);
    const refused2 = await refusals(plan, root, claudeDir);
    out.push(...describeScope(plan, { dry: true, refused: refused2 }), "");
  }
}
if (scopes.includes("user")) out.push("~/.claude applies to every project on this machine.");
print(out);
if (refused) process.exitCode = 1;
