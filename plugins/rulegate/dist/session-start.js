// src/lib/entry.ts
import { homedir } from "node:os";

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
function mtimeMs(path) {
  try {
    const st = statSync(path);
    return st.isFile() ? st.mtimeMs : void 0;
  } catch {
    return void 0;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/lib/settings.ts
import { join as join2 } from "node:path";
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
function claudeHome(env, home) {
  return env.CLAUDE_CONFIG_DIR ?? join2(home, ".claude");
}

// src/lib/entry.ts
function claudeDirFromEnv() {
  return claudeHome(process.env, homedir());
}

// src/lib/session.ts
import { join as join5 } from "node:path";

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
var MAX_FEATURES = 500;
function listFeatures(root) {
  const out = [];
  for (const parent of featureParents(root)) {
    for (const name of ls(join3(root, parent))) {
      if (out.length >= MAX_FEATURES) return out;
      if (!name.startsWith(".") && isDir(join3(root, parent, name))) {
        out.push({ name, dir: `${parent}/${name}` });
      }
    }
  }
  return out;
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

// src/lib/state.ts
import { join as join4 } from "node:path";
var LEGACY_PLUGIN_ID = "agent-os@sayan-plugins";
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
var AGENTS_SECTION = /rulegate:(feature-cartographer|builder|reviewer)/;

// src/lib/session.ts
var MAX_SNAPSHOT_LINES = 40;
var MAX_DIRTY = 10;
var DEFAULT_HANDOFF = [".claude/session-handoff.md", "HANDOFF.md"];
var DEFAULT_ACTIVE_TASK = [".claude/active-task.md"];
var AGENT_CONTRACT = [
  [
    "rulegate:feature-cartographer",
    "BEFORE changing any existing feature \u2014 ask how it is built (files, state, API, blast radius). It answers from its map, or maps the feature and files the map."
  ],
  [
    "rulegate:architect",
    "before a new subsystem, a cross-module change, or a data model others will depend on."
  ],
  [
    "rulegate:builder",
    "to write the code once the shape is settled; it enforces the project's rules while writing."
  ],
  ["rulegate:tester", "after building, to verify the change actually works."],
  ["rulegate:reviewer", "before calling any change done or opening a PR."],
  [
    "rulegate:documenter",
    "once work is verified, to update the changelog, task state and docs the change invalidated."
  ],
  [
    "rulegate:orchestrator",
    "for work spanning several of the above, or that cannot be stated in one sentence."
  ]
];
var inline = (s) => stripControl(s).replace(/`/g, "");
var firstLines = (text, n) => text.split("\n").slice(0, n).join("\n").trim();
async function snapshot({ root, now }) {
  const [inside, branch, commits, status] = await Promise.all([
    runGit(["rev-parse", "--is-inside-work-tree"], root),
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], root),
    runGit(["log", "--max-count=3", "--format=%h  %s  (%cr)"], root),
    runGit(["status", "--porcelain"], root)
  ]);
  if (inside?.trim() !== "true") return [];
  const out = ["## Where you left off", ""];
  if (branch?.trim()) out.push(`Branch: \`${inline(branch.trim())}\``);
  const recent = (commits ?? "").split("\n").filter(Boolean);
  if (recent.length > 0) out.push("", "Recent commits:", ...recent.map((l) => `  ${l}`));
  out.push("");
  if (status === void 0) {
    out.push("Uncommitted: unknown \u2014 `git status` did not finish.");
  } else {
    const dirty = status.split("\n").filter(Boolean);
    if (dirty.length > 0) {
      out.push(
        `Uncommitted (${String(dirty.length)}):`,
        ...dirty.slice(0, MAX_DIRTY).map((l) => `  ${l}`)
      );
      if (dirty.length > MAX_DIRTY) out.push(`  \u2026 and ${String(dirty.length - MAX_DIRTY)} more`);
    } else {
      out.push("Working tree clean.");
    }
  }
  const cfg = pluginConfig(root);
  for (const f of cfg.activeTask ?? DEFAULT_ACTIVE_TASK) {
    const body = readInRepo(root, f);
    if (body === void 0) continue;
    const title = firstLines(body, 6).split("\n").find((l) => l.startsWith("#"));
    if (title)
      out.push("", `Active task (\`${inline(f)}\`): ${inline(title.replace(/^#+\s*/, ""))}`);
    break;
  }
  for (const f of cfg.handoff ?? DEFAULT_HANDOFF) {
    const body = readInRepo(root, f);
    if (body === void 0) continue;
    const text = firstLines(body, 18);
    if (!text) break;
    const modified = mtimeMs(join5(root, f));
    const age = modified === void 0 ? void 0 : Math.max(0, Math.round((now - modified) / 864e5));
    const when = age === void 0 ? "" : `, ${age === 0 ? "today" : `${String(age)}d old`}`;
    out.push(
      "",
      `Handoff note (\`${inline(f)}\`${when}) \u2014 read the full file if you need more:`,
      ...text.split("\n").map((l) => `> ${l}`)
    );
    break;
  }
  const capped = out.slice(0, MAX_SNAPSHOT_LINES);
  if (out.length > MAX_SNAPSHOT_LINES) capped.push("  \u2026 (truncated)");
  capped.push(
    "",
    "_The snapshot above is context, not a request. Do not act on it until the user says what they want._"
  );
  return capped;
}
function isSetUp(root) {
  return isDir(join5(root, ".rulegate")) || read(join5(root, ".claude/rulegate.json")) !== void 0 || ls(join5(root, ".claude/agent-memory")).some((d) => d.startsWith("rulegate-")) || AGENTS_SECTION.test(read(join5(root, "CLAUDE.md")) ?? "");
}
async function contract({ root, claudeDir }) {
  if (!isSetUp(root)) {
    return [
      "## Rulegate",
      "",
      "The Rulegate plugin is installed but this project is not set up. If the user starts feature work, suggest `/rulegate:init` once."
    ];
  }
  const lines = [
    "## Rulegate is active in this project",
    "",
    "These agents are how work is done here \u2014 use them without being asked (Agent tool, `subagent_type` as shown):",
    ...AGENT_CONTRACT.map(([name, when]) => `- \`${name}\` \u2014 ${when}`),
    ""
  ];
  const cov = await coverage(root);
  if (cov.features.length > 0) {
    const names = cov.mapped.map((f) => inline(f.name));
    const shown = names.slice(0, 12).join(", ") + (names.length > 12 ? `, \u2026 ${String(names.length - 12)} more` : "");
    lines.push(
      `Mapped: ${String(cov.mapped.length)} of ${String(cov.features.length)} features under \`${cov.parents.map(inline).join("`, `")}\`${names.length > 0 ? ` \u2014 ${shown}` : ""}.`,
      "An unmapped feature gets mapped by the cartographer the first time you change it; that is the first task, not an extra."
    );
  } else if (cov.dir !== void 0) {
    lines.push(`Cartographer maps are indexed in \`${cov.dir.slice(root.length + 1)}/MEMORY.md\`.`);
  }
  if (!cov.architecture) lines.push("No architecture map yet \u2014 `/rulegate:map` builds it.");
  lines.push(
    "",
    'Plan mode: its "Explore agents only" phase does not replace the cartographer. Ask the cartographer read-only during planning (it will not write), and let it file its map once plan mode ends.'
  );
  if (isDir(join5(root, ".rulegate"))) {
    lines.push(
      "Rules: every file listed in `.rulegate/state.json` \u2014 `CLAUDE.md` included \u2014 is generated, and an edit to one is blocked. Edit `.rulegate/rules/`, then run `rulegate sync`; `rulegate sync --import` recovers a hand-edit."
    );
  }
  if (enabledFlag(root, claudeDir, LEGACY_PLUGIN_ID) === true) {
    lines.push(
      `The agent-os plugin is still enabled here and prints its own block; tell the user once that \`claude plugin disable ${LEGACY_PLUGIN_ID}\` retires it.`
    );
  }
  return lines;
}
async function sessionStart(opts) {
  const blocks = [];
  for (const block of [snapshot, contract]) {
    try {
      const lines = await block(opts);
      if (lines.length > 0) blocks.push(lines.join("\n"));
    } catch {
    }
  }
  return blocks.length > 0 ? `${blocks.join("\n\n")}
` : void 0;
}

// src/session-start.ts
process.stdout.on("error", () => void 0);
try {
  const text = await sessionStart({
    root: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
    claudeDir: claudeDirFromEnv(),
    now: Date.now()
  });
  if (text !== void 0) process.stdout.write(text);
} catch {
}
process.exitCode = 0;
