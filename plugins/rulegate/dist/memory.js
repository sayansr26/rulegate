// src/lib/entry.ts
import { homedir } from "node:os";

// src/lib/read.ts
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
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
var isTopicFile = (f) => f.endsWith(".md") && !/^MEMORY(\..+)?\.md$/.test(f);
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
function claudeHome(env, home) {
  return resolve(env.CLAUDE_CONFIG_DIR || join(home, ".claude"));
}

// src/lib/entry.ts
function rootArg(argv2) {
  return argv2.find((a) => !a.startsWith("--")) ?? process.cwd();
}
function claudeDirFromEnv() {
  return claudeHome(process.env, homedir());
}
function print(lines) {
  process.stdout.write(`${lines.join("\n")}
`);
}

// src/lib/memory.ts
import { basename, join as join2 } from "node:path";

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
  return new Promise((resolve2) => {
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
      (error, stdout) => resolve2(error ? void 0 : stdout)
    );
  });
}

// src/lib/memory.ts
async function runMemory({
  root,
  claudeDir,
  stale = false
}) {
  const out = [];
  const issues = [];
  const say = (s = "") => {
    out.push(s);
  };
  say(`MEMORY STORES   ${root}`);
  say();
  let anyAgent = false;
  for (const [scope, base] of [
    ["project", ".claude/agent-memory"],
    ["local", ".claude/agent-memory-local"]
  ]) {
    for (const agent of ls(join2(root, base))) {
      const adir = join2(root, base, agent);
      if (!isDir(adir)) continue;
      anyAgent = true;
      const topics = ls(adir).filter(isTopicFile);
      const idxRaw = read(join2(adir, "MEMORY.md"));
      const idx = idxRaw ? idxRaw.split("\n").filter((l) => l.trim().startsWith("-")) : [];
      say(`${agent}  (${scope})`);
      say(
        `  index: ${String(idx.length)} entr${idx.length === 1 ? "y" : "ies"}   topics: ${String(topics.length)} file(s)`
      );
      const orphans = topics.filter((f) => !idxRaw?.includes(basename(f, ".md")));
      const key = (f) => basename(f, ".md").replace(/[-_]/g, "").toLowerCase();
      const seen = /* @__PURE__ */ new Map();
      const dupes = [];
      for (const f of topics) {
        const first = seen.get(key(f));
        if (first !== void 0) dupes.push([first, f]);
        else seen.set(key(f), f);
      }
      for (const f of topics) {
        const t = read(join2(adir, f)) ?? "";
        const mapped = /^mapped:\s*(\S+)/m.exec(t)?.[1];
        const entry = /^entry:\s*(\S+)/m.exec(t)?.[1];
        let note = "";
        if (orphans.includes(f)) note += "  NOT IN INDEX";
        if (stale && mapped !== void 0 && entry !== void 0) {
          const last = (await runGit(["log", "--max-count=1", "--format=%cs", "--", entry], root))?.trim();
          if (last && last > mapped) note += `  STALE (mapped ${mapped}, code changed ${last})`;
        }
        say(
          `    ${f.padEnd(34)} ${String(t.split("\n").length).padStart(4)} lines${mapped ? `  mapped ${mapped}` : ""}${note}`
        );
      }
      if (orphans.length > 0) {
        issues.push(
          `${agent}: ${String(orphans.length)} topic file(s) not in MEMORY.md \u2014 invisible next session: ${orphans.join(", ")}`
        );
      }
      for (const [a, b] of dupes)
        issues.push(`${agent}: "${a}" and "${b}" are the same subject \u2014 merge them`);
      if (idxRaw && idxRaw.split("\n").length > 200) {
        issues.push(
          `${agent}: MEMORY.md over 200 lines \u2014 everything past that is dropped at startup`
        );
      }
      say();
    }
  }
  if (!anyAgent) {
    say("no agent memory yet \u2014 agents have not run in this project");
    say();
  }
  const repo = (await runGit(["rev-parse", "--show-toplevel"], root))?.trim() || root;
  const autoDir = join2(claudeDir, "projects", repo.replace(/[/\\:]/g, "-"), "memory");
  say("auto memory (Claude Code's own)");
  if (!isDir(autoDir)) say(`  none yet at ${autoDir}`);
  else {
    const idx = read(join2(autoDir, "MEMORY.md"));
    const topics = ls(autoDir).filter(isTopicFile);
    say(`  ${autoDir}`);
    say(
      `  MEMORY.md: ${idx ? `${String(idx.split("\n").length)} lines` : "absent"}   topics: ${String(topics.length)}`
    );
    for (const f of topics) say(`    ${f}`);
    if (idx && idx.split("\n").length > 200) {
      issues.push("auto memory MEMORY.md over 200 lines \u2014 content past that is dropped at startup");
    }
  }
  const canonical = ls(join2(root, ".rulegate/rules")).filter((f) => f.endsWith(".md"));
  if (canonical.length > 0) {
    say();
    say(
      `canonical rules  .rulegate/rules/  \u2014 ${String(canonical.length)} file(s); every tool's copy is generated from these`
    );
  }
  const rules = ls(join2(root, ".claude/rules")).filter((f) => f.endsWith(".md"));
  say();
  say(`project rules  .claude/rules/  \u2014 ${String(rules.length)} file(s)`);
  for (const f of rules) {
    const t = read(join2(root, ".claude/rules", f)) ?? "";
    const scoped = /^paths:/m.test(t.split("---")[1] ?? "");
    say(`  ${scoped ? "scoped  " : "UNSCOPED"} ${f}`);
    if (!scoped) issues.push(`.claude/rules/${f} has no paths: \u2014 it loads every session`);
  }
  say();
  if (issues.length === 0) say("HEALTH  no issues.");
  else {
    say(`HEALTH  ${String(issues.length)} issue(s):`);
    for (const i of issues) say(`  - ${i}`);
  }
  return out;
}

// src/memory.ts
var argv = process.argv.slice(2);
print(
  await runMemory({
    root: rootArg(argv),
    claudeDir: claudeDirFromEnv(),
    stale: argv.includes("--stale")
  })
);
