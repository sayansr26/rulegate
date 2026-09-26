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

// src/migrate-memory.ts
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
var LEGACY_PLUGIN_ID = "agent-os@sayan-plugins";
var LEGACY_MARKETPLACE = "sayan-plugins";
function enabledAt(root2, claudeDir2, id) {
  for (const [scope, p] of [
    ["local", join(root2, ".claude/settings.local.json")],
    ["project", join(root2, ".claude/settings.json")],
    ["user", join(claudeDir2, "settings.json")]
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
function enabledFlag(root2, claudeDir2, id) {
  return enabledAt(root2, claudeDir2, id)?.value;
}
function claudeHome(env, home) {
  return resolve(env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
}

// src/lib/entry.ts
function claudeDirFromEnv() {
  return claudeHome(process.env, homedir());
}
function print(lines) {
  process.stdout.write(`${lines.join("\n")}
`);
}

// src/lib/migrate.ts
import { createHash } from "node:crypto";
import { lstatSync as lstatSync3, readFileSync as readFileSync2 } from "node:fs";
import { join as join5 } from "node:path";

// src/lib/legacy.ts
import { join as join2 } from "node:path";
var MEMORY_BASES = [".claude/agent-memory", ".claude/agent-memory-local"];
var LEGACY_PREFIX = "agent-os-";
var MEMORY_PREFIX = "rulegate-";
function agentOsInstall(root2, claudeDir2) {
  const at = enabledAt(root2, claudeDir2, LEGACY_PLUGIN_ID);
  const plugin = at?.value === true ? at.scope : void 0;
  const shared = plugin === void 0 && enabledIn(join2(root2, ".claude/settings.json"), LEGACY_PLUGIN_ID) === true;
  const memory = [];
  for (const base of MEMORY_BASES) {
    const names = ls(join2(root2, base));
    for (const name of names) {
      if (!name.startsWith(LEGACY_PREFIX) || !isDir(join2(root2, base, name))) continue;
      const target = `${MEMORY_PREFIX}${name.slice(LEGACY_PREFIX.length)}`;
      memory.push({ base, name, target, split: names.includes(target) });
    }
  }
  const source = isDir(join2(root2, ".agent-os"));
  const project = readJson(join2(root2, ".claude/settings.json"));
  const marketplace = isRecord(project) && isRecord(project.extraKnownMarketplaces) && LEGACY_MARKETPLACE in project.extraKnownMarketplaces;
  return {
    plugin,
    shared,
    // Installed goes without saying — this runs from the installed plugin — so enabled is
    // anything short of an explicit `false`.
    bothEnabled: plugin !== void 0 && enabledFlag(root2, claudeDir2, PLUGIN_ID) !== false,
    memory,
    source,
    imported: source && isDir(join2(root2, ".rulegate")),
    marketplace,
    found: plugin !== void 0 || shared || memory.length > 0 || source || marketplace
  };
}

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
function within(root2, abs) {
  const rel = relative(root2, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return void 0;
  return rel.split(sep).join("/");
}
function probeView(root2) {
  return {
    listDir: (rel) => Promise.resolve(
      readdirSync2(join3(root2, rel), { withFileTypes: true }).map((e) => ({
        name: e.name,
        kind: e.isSymbolicLink() ? "symlink" : e.isDirectory() ? "dir" : "file"
      }))
    ),
    exists: (rel) => Promise.resolve(existsSync2(join3(root2, rel)))
  };
}
function ownerOf(abs) {
  const root2 = findRepoRoot(dirname(abs));
  const state = parseState(read(join3(root2, STATE_PATH)));
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
async function blocked(scope, root2, claudeDir2, abs, { bytes = false } = {}) {
  if (scope === "project") {
    if (inside(claudeDir2, abs)) {
      return "this is the user-level Claude config \u2014 `--scope user` changes it, backup first";
    }
    const rel = relative2(root2, abs);
    let at = root2;
    for (const part of rel.split(sep2)) {
      at = join4(at, part);
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

// src/lib/migrate.ts
var AGENT_NAME = /^agent-os-[a-z0-9][a-z0-9_-]*$/i;
var KEPT_INDEX = "MEMORY.agent-os.md";
var MAX_KEPT = 100;
var keptName = (n) => n === 1 ? KEPT_INDEX : `MEMORY.agent-os.${String(n)}.md`;
var keptPointer = (name) => `- [agent-os index](${name}) \u2014 agent-os's MEMORY.md, kept whole when the two were merged`;
var INDEX_LOADED_LINES = 200;
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
var indexLines = (text) => text === "" ? 0 : text.replace(/\r?\n$/, "").split("\n").length;
var indexEntries = (source) => source.split("\n").map(norm).filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
async function planAgent(root2, claudeDir2, base, from, to) {
  const srcDir = join5(root2, base, from);
  const dstDir = join5(root2, base, to);
  const shell = { base, from, to, srcDir, dstDir, dirs: [], files: [] };
  const refuse = (reason) => ({ ...shell, kind: "refused", reason });
  if (!AGENT_NAME.test(from)) return refuse("not a plain agent name");
  const parts = [...base.split("/"), from];
  for (let i = 1; i <= parts.length; i++) {
    const rel = parts.slice(0, i).join("/");
    if (stat(join5(root2, rel))?.isSymbolicLink() === true) return refuse(`${rel} is a symlink`);
  }
  if (inside(claudeDir2, srcDir)) {
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
      const why = await blocked("project", root2, claudeDir2, p, { bytes: true });
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
        const why = await blocked("project", root2, claudeDir2, p);
        if (why !== void 0) return refuse(`${p === src ? from : to}/${rel}: ${why}`);
      }
      let name;
      let keptBytes;
      for (let n = 1; n <= MAX_KEPT && name === void 0; n++) {
        const candidate = keptName(n);
        if (tree.files.includes(candidate)) continue;
        const kept = join5(dstDir, candidate);
        const why = await blocked("project", root2, claudeDir2, kept, { bytes: true });
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
async function planMemoryMigration(root2, claudeDir2) {
  const agents = [];
  for (const m of agentOsInstall(root2, claudeDir2).memory) {
    agents.push(await planAgent(root2, claudeDir2, m.base, m.name, m.target));
  }
  const gitignore = [];
  for (const f of [".gitignore", ".claude/.gitignore"]) {
    (read(join5(root2, f)) ?? "").split("\n").forEach((line, i) => {
      if (line.includes(LEGACY_PREFIX)) gitignore.push(`${f}:${String(i + 1)}  ${norm(line)}`);
    });
  }
  return { agents, gitignore };
}
var where = (a) => `${a.base}/${a.from}`;
function describeMigration(plan, { dry, moved = [], failed = [] }) {
  const lines = [
    `RULEGATE MIGRATE-MEMORY  ${dry ? "preview \u2014 nothing written; re-run with --apply" : "applied"}`,
    ""
  ];
  if (plan.agents.length === 0)
    lines.push("  nothing to migrate \u2014 no agent-os memory in this project");
  for (const a of plan.agents) {
    lines.push(`  ${where(a)} \u2192 ${a.to}`);
    if (a.kind === "refused") {
      lines.push(`    ${dry ? "will be refused" : "refused"} \u2014 ${a.reason ?? ""}; nothing touched`);
      continue;
    }
    const count = (action) => a.files.filter((f) => f.action === action).length;
    const union = a.files.find((f) => f.action === "union");
    const kept = a.files.find((f) => f.alias === true);
    const parts = [
      `${dry ? "copy" : "copied"} ${String(count("copy"))} file(s)`,
      ...count("same") > 0 ? [`${String(count("same"))} already there`] : [],
      ...union !== void 0 ? [
        `MEMORY.md ${dry ? "gains" : "gained"} ${String(union.added?.length ?? 0)} index line(s)`
      ] : [],
      ...kept !== void 0 ? [`agent-os's MEMORY.md kept whole as ${kept.rel}`] : []
    ];
    lines.push(`    ${a.kind === "move" ? "new directory" : "merge"}: ${parts.join(", ")}`);
    const size = union?.next === void 0 ? 0 : indexLines(union.next);
    if (size > INDEX_LOADED_LINES) {
      lines.push(
        `    MEMORY.md ${dry ? "will be" : "is"} ${String(size)} lines \u2014 Claude Code loads the first ${String(INDEX_LOADED_LINES)}; trim it with /rulegate:memory`
      );
    }
    const fail = failed.find((f) => f.agent === where(a));
    if (fail !== void 0) lines.push(`    stopped \u2014 ${fail.reason}; ${a.from} left in place`);
    else if (moved.includes(where(a))) lines.push(`    verified; ${a.from} removed`);
    else if (dry) lines.push(`    then ${a.from} is removed, once every file is verified`);
  }
  for (const g of plan.gitignore) {
    lines.push(
      "",
      `  ${g}`,
      "    names agent-os memory \u2014 it stops matching once the directory moves; update it by hand"
    );
  }
  return lines;
}

// src/migrate/memory.ts
import {
  constants,
  copyFileSync,
  lstatSync as lstatSync4,
  mkdirSync,
  readFileSync as readFileSync3,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
var BACKUP_SUFFIX = ".rulegate.bak";
var MAX_BACKUPS = 100;
function verify(f) {
  if (sha256(readFileSync3(f.dst)) !== f.sha) throw new Error(`${f.rel} did not copy exactly`);
}
function backupPath(dst, before) {
  for (let n = 1; n <= MAX_BACKUPS; n++) {
    const path2 = n === 1 ? `${dst}${BACKUP_SUFFIX}` : `${dst}.rulegate.${String(n)}.bak`;
    const st = lstatSync4(path2, { throwIfNoEntry: false });
    if (st === void 0) return path2;
    if (st.isFile() && readFileSync3(path2).equals(before)) return path2;
  }
  throw new Error(`MEMORY.md has ${String(MAX_BACKUPS)} backups already \u2014 merge by hand`);
}
function replaceIndex(f, next) {
  const before = readFileSync3(f.dst);
  if (sha256(before) !== f.dstSha) throw new Error(`${f.rel} changed during the move`);
  const bak = backupPath(f.dst, before);
  try {
    copyFileSync(f.dst, bak, constants.COPYFILE_EXCL);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  if (!readFileSync3(bak).equals(before)) throw new Error(`${f.rel} changed during the move`);
  const mode = lstatSync4(f.dst).mode & 511;
  const tmp = `${f.dst}.${String(process.pid)}.rulegate-tmp`;
  let created = false;
  try {
    writeFileSync(tmp, next, { flag: "wx", mode });
    created = true;
    renameSync(tmp, f.dst);
  } catch (e) {
    if (created) unlinkSync(tmp);
    throw e;
  }
}
function migrateAgent(a) {
  if (!exists(a.dstDir)) mkdirSync(a.dstDir);
  for (const d of a.dirs) if (!exists(d.dst)) mkdirSync(d.dst);
  for (const f of a.files) {
    if (f.action === "copy") {
      copyFileSync(f.src, f.dst, constants.COPYFILE_EXCL);
      verify(f);
    } else if (f.action === "same") {
      verify(f);
    } else {
      if (f.next !== void 0) replaceIndex(f, f.next);
      const have = new Set(indexEntries(readFileSync3(f.dst, "utf8")));
      const lost = indexEntries(readFileSync3(f.src, "utf8")).filter((l) => !have.has(l));
      if (lost.length > 0)
        throw new Error(`MEMORY.md union is missing ${String(lost.length)} line(s)`);
    }
  }
  for (const f of a.files) {
    if (sha256(readFileSync3(f.src)) !== f.sha) throw new Error(`${f.rel} changed during the move`);
  }
  for (const f of a.files) if (f.alias !== true) unlinkSync(f.src);
  try {
    for (const d of [...a.dirs].reverse()) rmdirSync(d.src);
    rmdirSync(a.srcDir);
  } catch (e) {
    if (e.code !== "ENOTEMPTY") throw e;
    throw new Error(`${a.from} gained files since the plan \u2014 they are left there; re-run`);
  }
}
async function applyMemoryMigration(root2, claudeDir2) {
  const plan = await planMemoryMigration(root2, claudeDir2);
  const moved = [];
  const failed = [];
  for (const a of plan.agents) {
    if (a.kind === "refused") continue;
    const agent = `${a.base}/${a.from}`;
    try {
      migrateAgent(a);
      moved.push(agent);
    } catch (e) {
      const code = e.code;
      failed.push({
        agent,
        reason: code !== void 0 ? `could not write (${code})` : e.message
      });
    }
  }
  return { plan, moved, failed };
}

// src/migrate-memory.ts
var usage = (message) => {
  print([message, "usage: migrate-memory.js [--root <dir>] [--apply]"]);
  process.exit(2);
};
var argv = process.argv.slice(2);
var apply = false;
var rootArg;
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i] ?? "";
  if (flag === "--apply") {
    apply = true;
    continue;
  }
  if (flag !== "--root") usage(`unknown argument "${flag}"`);
  const value = argv[++i];
  if (value === void 0 || value === "" || value.startsWith("--")) usage(`${flag} needs a value`);
  rootArg = value;
}
var root = resolve3(rootArg ?? process.cwd());
if (!isDir(root)) usage(`--root must be an existing directory (got "${root}")`);
var claudeDir = claudeDirFromEnv();
if (apply) {
  const r = await applyMemoryMigration(root, claudeDir);
  print(describeMigration(r.plan, { dry: false, moved: r.moved, failed: r.failed }));
  if (r.failed.length > 0 || r.plan.agents.some((a) => a.kind === "refused")) process.exitCode = 1;
} else {
  const plan = await planMemoryMigration(root, claudeDir);
  print(describeMigration(plan, { dry: true }));
  if (plan.agents.some((a) => a.kind === "refused")) process.exitCode = 1;
}
