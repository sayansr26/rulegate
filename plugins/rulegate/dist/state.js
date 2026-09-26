// src/lib/entry.ts
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

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
function settingsPath(scope, root, claudeDir) {
  return scope === "user" ? join(claudeDir, "settings.json") : join(root, ".claude/settings.json");
}
var isRulegateProject = (root) => isDir(join(root, ".rulegate"));
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
  return {
    scope,
    settingsFile,
    settings: planSettings(read(settingsFile)),
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
import { realpathSync as realpathSync2 } from "node:fs";
import { join as join2 } from "node:path";
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
    join2(root, ".claude/settings.local.json"),
    join2(root, ".claude/settings.json"),
    join2(claudeDir, "settings.json")
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
  const file = readJson(join2(claudeDir, "plugins/installed_plugins.json"));
  const all = isRecord(file) && isRecord(file.plugins) ? file.plugins[id] : void 0;
  const records = (Array.isArray(all) ? all : []).filter(isRecord);
  const mine = records.filter(
    (r) => r.scope === "user" || typeof r.projectPath === "string" && real(r.projectPath) === rootReal
  );
  const pick = mine.find((r) => r.scope === "project" || r.scope === "local") ?? mine[0];
  const [plugin, market] = id.split("@");
  const cached = readJson(
    join2(
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
  const hasSource = isDir(join2(root, ".rulegate"));
  const claudeMd = read(join2(root, "CLAUDE.md"));
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
  const setUp = AGENTS_SECTION.test(claudeMd ?? "") || ls(join2(root, ".claude/agent-memory")).some((d) => d.startsWith("rulegate-")) || read(join2(root, ".claude/rulegate.json")) !== void 0;
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
    setupState(rootArg(process.argv.slice(2)), claudeDirFromEnv(), {
      expect: bundledVersion(import.meta.url)
    })
  )
);
