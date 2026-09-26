// src/lib/entry.ts
import { homedir } from "node:os";

// src/lib/read.ts
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
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
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/lib/settings.ts
import { join } from "node:path";
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
  return env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
}
function settingsPath(scope2, root2, claudeDir) {
  return scope2 === "user" ? join(claudeDir, "settings.json") : join(root2, ".claude/settings.json");
}
var isRulegateProject = (root2) => isDir(join(root2, ".rulegate"));
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
function planTaskRule(scope2, root2, claudeDir) {
  if (scope2 === "user") {
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
  if (isRulegateProject(root2)) {
    const inRules = ls(join(root2, ".rulegate/rules")).some(
      (f) => /TaskCreate/.test(read(join(root2, ".rulegate/rules", f)) ?? "")
    );
    if (inRules || /TaskCreate/.test(read(join(root2, "CLAUDE.md")) ?? "")) {
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
  const text = read(join(root2, "CLAUDE.md"));
  if (text === void 0) return { status: "no-file", file: "CLAUDE.md" };
  if (/TaskCreate/.test(text)) return { status: "present", file: "CLAUDE.md" };
  const { next, section } = insertTaskRule(text);
  return { status: "add", file: "CLAUDE.md", how: section, next };
}
function planScope(scope2, root2, claudeDir) {
  const settingsFile = settingsPath(scope2, root2, claudeDir);
  return {
    scope: scope2,
    settingsFile,
    settings: planSettings(read(settingsFile)),
    rule: planTaskRule(scope2, root2, claudeDir)
  };
}
function describeScope(p, { dry }) {
  const verb = dry ? "would add" : "added";
  const s = p.settings;
  const lines = [`${p.scope === "user" ? "USER" : "PROJECT"}  ${p.settingsFile}`];
  if (s.status === "invalid") {
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
  if (r.status === "add")
    lines.push(`  ${r.file}  ${verb} the task-tracking rule (${r.how ?? ""})`);
  else if (r.status === "present") lines.push(`  ${r.file}  task-tracking rule already there`);
  else lines.push(`  ${r.file}  absent \u2014 /rulegate:init builds it`);
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

// src/settings.ts
var usage = (message) => {
  print([message, "usage: settings.js [--root <dir>] [--scope project|user|both]"]);
  process.exit(2);
};
var argv = process.argv.slice(2);
var values = /* @__PURE__ */ new Map();
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i] ?? "";
  if (flag === "--apply") {
    usage("--apply is not supported in this version of the plugin; nothing was written.");
  }
  if (flag !== "--root" && flag !== "--scope") usage(`unknown argument "${flag}"`);
  const value = argv[++i];
  if (value === void 0 || value.startsWith("--")) usage(`${flag} needs a value`);
  values.set(flag, value ?? "");
}
var scope = values.get("--scope") ?? "both";
if (scope !== "both" && scope !== "project" && scope !== "user") {
  usage(`--scope must be project, user or both (got "${scope}")`);
}
var scopes = scope === "both" ? ["project", "user"] : [scope];
var root = values.get("--root") ?? process.cwd();
var out = ["RULEGATE SETTINGS  preview \u2014 nothing written", ""];
for (const s of scopes) {
  out.push(...describeScope(planScope(s, root, claudeDirFromEnv()), { dry: true }), "");
}
if (scopes.includes("user")) out.push("~/.claude applies to every project on this machine.");
print(out);
