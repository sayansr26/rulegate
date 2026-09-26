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

// src/pre-edit.ts
import { readFileSync as readFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { join as join5, resolve as resolve2 } from "node:path";

// src/lib/guard.ts
import { existsSync as existsSync2, readdirSync as readdirSync2, realpathSync as realpathSync2 } from "node:fs";
import { basename, dirname, isAbsolute as isAbsolute2, join as join4, relative as relative2, resolve, sep as sep2 } from "node:path";

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

// src/session/marker.ts
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
var MARKER_DIR = "rulegate-plugin";
var safe = (s) => createHash("sha256").update(s).digest("hex").slice(0, 32);
function firstInSession(sessionId, key, base = join(tmpdir(), MARKER_DIR)) {
  try {
    mkdirSync(base, { recursive: true, mode: 448 });
    const st = lstatSync(base);
    if (!st.isDirectory()) return false;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return false;
    writeFileSync(join(base, `${safe(sessionId)}--${safe(key)}`), "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

// src/lib/read.ts
import { lstatSync as lstatSync2, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join as join2, relative, sep } from "node:path";
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
function readInRepo(root, rel) {
  try {
    const target = realpathSync(join2(root, rel));
    const within2 = relative(realpathSync(root), target);
    if (within2 === "" || within2 === ".." || within2.startsWith(`..${sep}`) || isAbsolute(within2)) {
      return void 0;
    }
    return read(target);
  } catch {
    return void 0;
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
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/lib/text.ts
var isControl = (c) => {
  const n = c.charCodeAt(0);
  return n < 32 || n === 127;
};
var hasControl = (s) => Array.from(s).some(isControl);
var stripControl = (s) => Array.from(s, (c) => isControl(c) ? " " : c).join("");

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
import { join as join3 } from "node:path";

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
  return new Promise((resolve3) => {
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
      (error, stdout) => resolve3(error ? void 0 : stdout)
    );
  });
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
  const found = DEFAULT_PARENTS.find((d) => isDir(join3(root, d)));
  return found ? [found] : [];
}
function featureOf(root, relPath) {
  for (const parent of featureParents(root)) {
    const m = new RegExp(`^${escape(parent)}/([^/]+)/`).exec(relPath);
    if (m?.[1] !== void 0) return { name: m[1], dir: `${parent}/${m[1]}` };
  }
  return void 0;
}
function cartographerDir(root) {
  for (const base of [".claude/agent-memory", ".claude/agent-memory-local"]) {
    for (const name of CARTOGRAPHER_DIRS) {
      const dir = join3(root, base, name);
      if (isDir(dir)) return dir;
    }
  }
  return void 0;
}
function mapFiles(root) {
  const dir = cartographerDir(root);
  if (dir === void 0) return [];
  return ls(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").map((file) => {
    const text = read(join3(dir, file)) ?? "";
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
async function tracked(root, dir) {
  const out = await runGit(["ls-files", "--", dir], root);
  return out === void 0 ? true : out.trim().length > 0;
}

// src/lib/settings.ts
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

// src/lib/session.ts
var inline = (s) => stripControl(s).replace(/`/g, "");

// src/lib/guard.ts
function realish(p) {
  const rest = [];
  let dir = p;
  for (let i = 0; i < 256; i++) {
    try {
      return join4(realpathSync2.native(dir), ...[...rest].reverse());
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
  const rel = relative2(root, abs);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep2}`) || isAbsolute2(rel)) return void 0;
  return rel.split(sep2).join("/");
}
function probeView(root) {
  return {
    listDir: (rel) => Promise.resolve(
      readdirSync2(join4(root, rel), { withFileTypes: true }).map((e) => ({
        name: e.name,
        kind: e.isSymbolicLink() ? "symlink" : e.isDirectory() ? "dir" : "file"
      }))
    ),
    exists: (rel) => Promise.resolve(existsSync2(join4(root, rel)))
  };
}
function ownerOf(abs) {
  const root = findRepoRoot(dirname(abs));
  const state = parseState(read(join4(root, STATE_PATH)));
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
  const spellings = [.../* @__PURE__ */ new Set([resolve(targetAbs), realish(targetAbs)])];
  for (const abs of spellings) {
    const decision = await judge(abs);
    if (decision !== void 0) return decision;
  }
  return void 0;
}
async function reminder(targetAbs, projectDir, sessionId, first = firstInSession) {
  if (pluginConfig(projectDir).cartographerReminder === false) return void 0;
  const rel = within(realish(projectDir), realish(targetAbs));
  if (rel === void 0) return void 0;
  const feature = featureOf(projectDir, rel);
  if (feature === void 0) return void 0;
  if (findMap(feature, mapFiles(projectDir)) !== void 0) return void 0;
  if (!await tracked(projectDir, feature.dir)) return void 0;
  if (!first(sessionId, feature.dir)) return void 0;
  const dir = inline(feature.dir);
  return {
    kind: "context",
    text: `Rulegate (advisory): ${dir}/ is an existing feature with no cartographer map. Before changing it further, ask rulegate:feature-cartographer how "${inline(feature.name)}" is built \u2014 it answers and files the map for every later session. This applies in plan mode too (ask it read-only; it files the map after plan mode ends). Shown once per feature per session.`
  };
}

// src/pre-edit.ts
process.stdout.on("error", () => void 0);
function emit(decision) {
  const output = decision.kind === "deny" ? { permissionDecision: "deny", permissionDecisionReason: decision.reason } : { additionalContext: decision.text };
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...output } })
  );
}
try {
  const payload = JSON.parse(readFileSync2(0, "utf8") || "{}");
  const input = isRecord(payload) && isRecord(payload.tool_input) ? payload.tool_input : {};
  const file = typeof input.file_path === "string" ? input.file_path : "";
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? (isRecord(payload) && typeof payload.cwd === "string" ? payload.cwd : process.cwd());
  const base = isRecord(payload) && typeof payload.cwd === "string" ? payload.cwd : projectDir;
  if (file !== "") {
    const expanded = file === "~" ? homedir() : file.startsWith("~/") ? join5(homedir(), file.slice(2)) : file;
    const target = resolve2(base, expanded);
    const session = isRecord(payload) && typeof payload.session_id === "string" ? payload.session_id : "nosession";
    const decision = await guard(target) ?? await reminder(target, projectDir, session);
    if (decision !== void 0) emit(decision);
  }
} catch {
}
process.exitCode = 0;
