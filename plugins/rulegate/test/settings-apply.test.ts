import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GIT_DENY, TASK_RULE_FILE, TODO_ENV } from '../src/lib/settings.js';
import { applyScope, BACKUP_SUFFIX } from '../src/settings-writer/apply.js';
import { sandbox, type Sandbox } from './helpers.js';

/**
 * The settings writer (T109). Every case runs over a sandbox whose project root and Claude
 * config dir are separate temp directories, so nothing here can reach the real `~/.claude`;
 * the spawned-bundle cases point HOME and CLAUDE_CONFIG_DIR into the sandbox as well.
 */
let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(async () => {
  await sb.dispose();
});

const text = (abs: string): string => readFileSync(abs, 'utf8');
const json = (abs: string): Record<string, unknown> =>
  JSON.parse(text(abs)) as Record<string, unknown>;
const projectSettings = (): string => path.join(sb.root, '.claude/settings.json');
const userSettings = (): string => path.join(sb.claudeDir, 'settings.json');

describe('applyScope', () => {
  it('writes the merged plan to a fresh project and user scope', async () => {
    await sb.put('CLAUDE.md', '# P\n');
    const project = await applyScope('project', sb.root, sb.claudeDir);
    const user = await applyScope('user', sb.root, sb.claudeDir);
    expect(project.refused).toEqual([]);
    expect(user.refused).toEqual([]);
    for (const file of [projectSettings(), userSettings()]) {
      expect(json(file)).toMatchObject({
        permissions: { deny: [...GIT_DENY] },
        env: { [TODO_ENV]: '1' },
      });
    }
    expect(text(path.join(sb.root, 'CLAUDE.md'))).toMatch(/## Working agreement\n\n.*TaskCreate/);
    expect(text(path.join(sb.claudeDir, 'CLAUDE.md'))).toMatch(/^# Personal working agreement/);
    // Nothing existed at user scope, so there was nothing to back up.
    expect(user.backups).toEqual([]);
  });

  it('is idempotent: a second run writes nothing and leaves no new backup', async () => {
    await sb.putHome('settings.json', { model: 'x' });
    await applyScope('user', sb.root, sb.claudeDir);
    const after = text(userSettings());
    const again = await applyScope('user', sb.root, sb.claudeDir);
    expect(again.written).toEqual([]);
    expect(again.backups).toEqual([]);
    expect(text(userSettings())).toBe(after);
  });

  it('keeps allow rules, deny rules and other keys, and counts `git commit:*` as present', async () => {
    await sb.put('.claude/settings.json', {
      model: 'x',
      permissions: { allow: ['Bash(ls *)'], deny: ['Bash(git commit:*)', 'Read(.env)'] },
    });
    await applyScope('project', sb.root, sb.claudeDir);
    const next = json(projectSettings()) as {
      model: string;
      permissions: { allow: string[]; deny: string[] };
    };
    expect(next.model).toBe('x');
    expect(next.permissions.allow).toEqual(['Bash(ls *)']);
    expect(next.permissions.deny.slice(0, 2)).toEqual(['Bash(git commit:*)', 'Read(.env)']);
    expect(next.permissions.deny).not.toContain('Bash(git commit *)');
    expect(next.permissions.deny).toHaveLength(GIT_DENY.length + 1);
  });

  it('leaves a user-set env value alone', async () => {
    await sb.putHome('settings.json', { env: { [TODO_ENV]: '0' } });
    await applyScope('user', sb.root, sb.claudeDir);
    expect(json(userSettings())).toMatchObject({ env: { [TODO_ENV]: '0' } });
  });

  it('refuses invalid JSON and leaves it byte-identical', async () => {
    await sb.put('.claude/settings.json', '{ "permissions": ');
    const r = await applyScope('project', sb.root, sb.claudeDir);
    expect(r.refused.map((x) => x.item)).toContain('settings');
    expect(text(projectSettings())).toBe('{ "permissions": ');
  });

  it('backs up a user-scope file first, and keeps the first backup on a later run', async () => {
    const original = '{\n  "model": "x"\n}\n';
    await sb.putHome('settings.json', original);
    await sb.putHome('CLAUDE.md', '# Me\n');
    const r = await applyScope('user', sb.root, sb.claudeDir);
    expect([...r.backups].sort()).toEqual(
      [
        `${userSettings()}${BACKUP_SUFFIX}`,
        `${path.join(sb.claudeDir, 'CLAUDE.md')}${BACKUP_SUFFIX}`,
      ].sort(),
    );
    expect(text(`${userSettings()}${BACKUP_SUFFIX}`)).toBe(original);
    expect(text(`${path.join(sb.claudeDir, 'CLAUDE.md')}${BACKUP_SUFFIX}`)).toBe('# Me\n');

    // The user edits the file again; the next apply must not replace the true original.
    await sb.putHome('settings.json', { model: 'y' });
    await applyScope('user', sb.root, sb.claudeDir);
    expect(text(`${userSettings()}${BACKUP_SUFFIX}`)).toBe(original);
    expect(json(userSettings())).toMatchObject({ model: 'y' });
  });

  it('backs up project files inside a git tree too — .git says nothing about this file', async () => {
    // An untracked or gitignored CLAUDE.md, or an uncommitted edit, has no copy in git.
    await mkdir(path.join(sb.root, '.git'));
    const mine =
      '# P\n\n## Operator preferences\n\n- keep  \n\n## Code\n\n```\na\n\n\n\n\nb\n```\n';
    await sb.put('.claude/settings.json', '{"a":1}\n');
    await sb.put('CLAUDE.md', mine);
    const r = await applyScope('project', sb.root, sb.claudeDir);
    expect(r.refused).toEqual([]);
    expect(text(`${projectSettings()}${BACKUP_SUFFIX}`)).toBe('{"a":1}\n');
    expect(text(path.join(sb.root, `CLAUDE.md${BACKUP_SUFFIX}`))).toBe(mine);
    // The hard break and the blank run inside the fence survive: the rule is only inserted.
    const after = text(path.join(sb.root, 'CLAUDE.md'));
    expect(after).toContain('- keep  \n');
    expect(after).toContain('```\na\n\n\n\n\nb\n```\n');
    expect(after).toMatch(/TaskCreate/);
  });

  it('creates the canonical rule in a Rulegate project and never touches CLAUDE.md', async () => {
    await sb.put('.rulegate/rulegate.yaml', 'schemaVersion: 1\n');
    await sb.put('CLAUDE.md', '<!-- generated by rulegate -->\n');
    const r = await applyScope('project', sb.root, sb.claudeDir);
    expect(r.refused).toEqual([]);
    expect(text(path.join(sb.root, TASK_RULE_FILE))).toMatch(
      /^---\ndescription: Working agreement\ntools: \[claude-code\]\n---\n\n.*TaskCreate/,
    );
    expect(text(path.join(sb.root, 'CLAUDE.md'))).toBe('<!-- generated by rulegate -->\n');
  });

  it('refuses an existing working-agreement.md without the rule, and leaves it untouched', async () => {
    await sb.put(TASK_RULE_FILE, '---\ndescription: mine\n---\n\nBe kind.\n');
    const r = await applyScope('project', sb.root, sb.claudeDir);
    expect(r.plan.rule.status).toBe('exists');
    expect(r.refused.map((x) => x.item)).toEqual(['rule']);
    expect(text(path.join(sb.root, TASK_RULE_FILE))).toBe(
      '---\ndescription: mine\n---\n\nBe kind.\n',
    );
    // The settings half is independent and still applied.
    expect(existsSync(projectSettings())).toBe(true);
  });

  it('never creates a project CLAUDE.md outside a Rulegate project', async () => {
    await applyScope('project', sb.root, sb.claudeDir);
    expect(existsSync(path.join(sb.root, 'CLAUDE.md'))).toBe(false);
  });

  it('refuses a symlinked settings.json and writes nothing through it', async () => {
    const outside = path.join(sb.claudeDir, 'elsewhere.json');
    await writeFile(outside, '{}\n');
    await mkdir(path.join(sb.root, '.claude'));
    await symlink(outside, projectSettings());
    const r = await applyScope('project', sb.root, sb.claudeDir);
    expect(r.refused.map((x) => x.item)).toContain('settings');
    expect(lstatSync(projectSettings()).isSymbolicLink()).toBe(true);
    expect(text(outside)).toBe('{}\n');
  });

  it('refuses a symlinked .claude/ directory that leads out of the repository', async () => {
    const outside = path.join(sb.claudeDir, 'dir');
    await mkdir(outside);
    await symlink(outside, path.join(sb.root, '.claude'));
    const r = await applyScope('project', sb.root, sb.claudeDir);
    expect(r.refused.map((x) => x.item)).toContain('settings');
    expect(existsSync(path.join(outside, 'settings.json'))).toBe(false);
  });

  it('refuses a symlinked CLAUDE.md rather than rewriting its target', async () => {
    await sb.put('AGENTS.md', '# Shared\n');
    await symlink('AGENTS.md', path.join(sb.root, 'CLAUDE.md'));
    const r = await applyScope('project', sb.root, sb.claudeDir);
    expect(r.refused.map((x) => x.item)).toEqual(['rule']);
    expect(text(path.join(sb.root, 'AGENTS.md'))).toBe('# Shared\n');
  });

  it('refuses a target recorded in .rulegate/state.json', async () => {
    // A future adapter could claim a path under `.claude/`; the writer must not hand-edit it.
    await sb.put('.rulegate/rules/work.md', '---\ndescription: w\n---\nUse TaskCreate.\n');
    await sb.put('.rulegate/state.json', {
      schemaVersion: 1,
      artifacts: [{ path: '.claude/settings.json', adapter: 'x', hash: 'sha256:0', kind: 'rules' }],
    });
    await sb.put('.claude/settings.json', '{}\n');
    const r = await applyScope('project', sb.root, sb.claudeDir);
    expect(r.refused.map((x) => x.item)).toEqual(['settings']);
    expect(text(projectSettings())).toBe('{}\n');
  });

  it('fails closed when state.json does not parse, where the hook would let the edit through', async () => {
    // `--root` below the repository root: no `.rulegate/` there, so the planner inserts into
    // the subdirectory's CLAUDE.md — which the parent's state.json records.
    await sb.put('.rulegate/rules/a.md', '---\ndescription: a\n---\nA.\n');
    await sb.put('pkg/CLAUDE.md', '# Generated\n');
    const recorded = {
      schemaVersion: 1,
      artifacts: [
        { path: 'pkg/CLAUDE.md', adapter: 'claude-code', hash: 'sha256:0', kind: 'rules' },
      ],
    };
    const sub = path.join(sb.root, 'pkg');
    await sb.put('.rulegate/state.json', recorded);
    expect((await applyScope('project', sub, sb.claudeDir)).refused.map((x) => x.item)).toEqual([
      'rule',
    ]);
    await sb.put('.rulegate/state.json', `<<<<<<< ours\n${JSON.stringify(recorded)}\n=======\n`);
    const r = await applyScope('project', sub, sb.claudeDir);
    expect(r.refused.find((x) => x.item === 'rule')?.reason).toMatch(/does not parse/);
    expect(text(path.join(sub, 'CLAUDE.md'))).toBe('# Generated\n');
  });

  it('refuses a project target that is the user-level config (root is $HOME)', async () => {
    // Started in $HOME, `<root>/.claude/settings.json` *is* `~/.claude/settings.json`: the
    // project pass would change it with no backup and the user pass would then see nothing
    // to do.
    const home = path.dirname(sb.claudeDir);
    const claudeDir = path.join(home, '.claude');
    await writeFile(path.join(home, 'placeholder'), '');
    await mkdir(claudeDir);
    await writeFile(path.join(claudeDir, 'settings.json'), '{"theme":"dark"}\n');
    const project = await applyScope('project', home, claudeDir);
    expect(project.refused.map((x) => x.item)).toEqual(['settings']);
    expect(text(path.join(claudeDir, 'settings.json'))).toBe('{"theme":"dark"}\n');
    const user = await applyScope('user', home, claudeDir);
    expect(user.backups).toContain(path.join(claudeDir, `settings.json${BACKUP_SUFFIX}`));
  });

  const asRoot = process.getuid?.() === 0;
  it.skipIf(asRoot)(
    'refuses an existing settings.json it cannot read, instead of replacing it',
    async () => {
      await sb.put('.claude/settings.json', {
        model: 'opus',
        permissions: { allow: ['Bash(ls)'] },
      });
      chmodSync(projectSettings(), 0o000);
      try {
        const r = await applyScope('project', sb.root, sb.claudeDir);
        expect(r.refused.find((x) => x.item === 'settings')?.reason).toMatch(/could not be read/);
      } finally {
        chmodSync(projectSettings(), 0o644);
      }
      expect(json(projectSettings())).toMatchObject({ model: 'opus' });
    },
  );

  it('refuses a user CLAUDE.md too large to read, instead of replacing it', async () => {
    const big = `# Me\n${'x'.repeat(4 * 1024 * 1024)}\n`;
    await sb.putHome('CLAUDE.md', big);
    const r = await applyScope('user', sb.root, sb.claudeDir);
    expect(r.refused.map((x) => x.item)).toEqual(['rule']);
    expect(text(path.join(sb.claudeDir, 'CLAUDE.md'))).toBe(big);
    expect(existsSync(path.join(sb.claudeDir, `CLAUDE.md${BACKUP_SUFFIX}`))).toBe(false);
  });

  it('backs up project files outside any git working tree — nothing else holds the original', async () => {
    await sb.put('.claude/settings.json', '{"a":1}\n');
    await sb.put('CLAUDE.md', '# Mine\n');
    const r = await applyScope('project', sb.root, sb.claudeDir);
    expect(r.refused).toEqual([]);
    expect(text(`${projectSettings()}${BACKUP_SUFFIX}`)).toBe('{"a":1}\n');
    expect(text(path.join(sb.root, `CLAUDE.md${BACKUP_SUFFIX}`))).toBe('# Mine\n');
    expect(text(path.join(sb.root, 'CLAUDE.md'))).toMatch(/TaskCreate/);
  });

  it('refuses a CLAUDE.md that is not UTF-8 rather than writing U+FFFD over its bytes', async () => {
    const latin1 = Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a]); // "# Café" in Latin-1
    await writeFile(path.join(sb.root, 'CLAUDE.md'), latin1);
    await writeFile(path.join(sb.claudeDir, 'CLAUDE.md'), latin1);
    for (const scope of ['project', 'user'] as const) {
      const r = await applyScope(scope, sb.root, sb.claudeDir);
      expect(r.refused.find((x) => x.item === 'rule')?.reason).toMatch(/not UTF-8/);
    }
    expect(readFileSync(path.join(sb.root, 'CLAUDE.md')).equals(latin1)).toBe(true);
    expect(readFileSync(path.join(sb.claudeDir, 'CLAUDE.md')).equals(latin1)).toBe(true);
  });

  it('never deletes a file already at its temp name, and refuses the item instead', async () => {
    // `wx` fails on the name; what it found there is not the writer's to remove.
    const planted = `${projectSettings()}.${String(process.pid)}.rulegate-tmp`;
    await sb.put('.claude/settings.json', '{}\n');
    await writeFile(planted, 'not ours\n');
    const r = await applyScope('project', sb.root, sb.claudeDir);
    expect(r.refused.find((x) => x.item === 'settings')?.reason).toMatch(/EEXIST/);
    expect(text(planted)).toBe('not ours\n');
    expect(text(projectSettings())).toBe('{}\n');
  });

  it('keeps a 0600 user settings.json at 0600', async () => {
    await sb.putHome('settings.json', { env: { ANTHROPIC_API_KEY: 'x' } });
    chmodSync(userSettings(), 0o600);
    await applyScope('user', sb.root, sb.claudeDir);
    expect(json(userSettings())).toMatchObject({
      env: { ANTHROPIC_API_KEY: 'x', [TODO_ENV]: '1' },
    });
    expect(statSync(userSettings()).mode & 0o777).toBe(0o600);
  });

  it('keeps a CRLF CLAUDE.md CRLF', async () => {
    await sb.putHome('CLAUDE.md', '# Me\r\n\r\n- Be terse.\r\n');
    await applyScope('user', sb.root, sb.claudeDir);
    const next = text(path.join(sb.claudeDir, 'CLAUDE.md'));
    expect(next).toMatch(/TaskCreate/);
    expect(next).not.toMatch(/(^|[^\r])\n/);
  });
});

describe('dist/settings.js --apply', () => {
  const bin = fileURLToPath(new URL('../dist/settings.js', import.meta.url));
  const run = (args: string[]): { code: number; out: string } => {
    try {
      const out = execFileSync(process.execPath, [bin, ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: sb.claudeDir, CLAUDE_CONFIG_DIR: sb.claudeDir },
      });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { code: err.status, out: err.stdout };
    }
  };

  it('applies inside the sandbox, then reports unchanged on a second run', async () => {
    await sb.put('.rulegate/rulegate.yaml', 'schemaVersion: 1\n');
    const first = run(['--root', sb.root, '--scope', 'both', '--apply']);
    expect(first.code).toBe(0);
    expect(first.out).toMatch(/^RULEGATE SETTINGS {2}applied/);
    expect(first.out).toMatch(/rulegate sync/);
    expect(existsSync(userSettings())).toBe(true);
    expect(existsSync(path.join(sb.root, TASK_RULE_FILE))).toBe(true);
    const second = run(['--root', sb.root, '--scope', 'both', '--apply']);
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/already complete/);
    expect(second.out).not.toMatch(/ added /);
  });

  it('exits 2 on a --root that is not an existing directory, and creates nothing', async () => {
    const typo = path.join(sb.root, 'prjo');
    const missing = run(['--root', typo, '--scope', 'project', '--apply']);
    expect(missing.code).toBe(2);
    expect(existsSync(typo)).toBe(false);
    await sb.put('file.txt', 'x');
    expect(run(['--root', path.join(sb.root, 'file.txt'), '--scope', 'project']).code).toBe(2);
  });

  it('exits 2 on an empty --root rather than running in the cwd', () => {
    const cwdRun = (): number => {
      try {
        execFileSync(process.execPath, [bin, '--root', '', '--scope', 'project', '--apply'], {
          cwd: sb.root,
          env: { ...process.env, HOME: sb.claudeDir, CLAUDE_CONFIG_DIR: sb.claudeDir },
        });
        return 0;
      } catch (e) {
        return (e as { status: number }).status;
      }
    };
    expect(cwdRun()).toBe(2);
    expect(existsSync(projectSettings())).toBe(false);
  });

  it.skipIf(process.platform === 'win32')(
    'previews a symlinked ~/.claude/settings.json as refused, not as "would add"',
    async () => {
      await sb.putHome('dots/settings.json', '{}\n');
      await symlink('dots/settings.json', userSettings());
      const r = run(['--root', sb.root, '--scope', 'user']);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/will be refused — a symlink/);
      expect(r.out).not.toMatch(/would add \d+ git write rule/);
    },
  );

  it('backs up ~/.claude/settings.json when started in $HOME with --scope both', async () => {
    const home = path.dirname(sb.claudeDir);
    await mkdir(path.join(home, '.claude'));
    await writeFile(path.join(home, '.claude/settings.json'), '{"theme":"dark"}\n');
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.CLAUDE_CONFIG_DIR;
    let code = 0;
    try {
      execFileSync(process.execPath, [bin, '--scope', 'both', '--apply'], { cwd: home, env });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    // The project item is refused (exit 1); the user pass applies it, backup first.
    expect(code).toBe(1);
    expect(text(path.join(home, `.claude/settings.json${BACKUP_SUFFIX}`))).toBe(
      '{"theme":"dark"}\n',
    );
    expect(json(path.join(home, '.claude/settings.json'))).toMatchObject({ theme: 'dark' });
  });

  it('exits 1 over invalid JSON and writes nothing to it', async () => {
    await sb.putHome('settings.json', '{ nope');
    const r = run(['--root', sb.root, '--scope', 'user', '--apply']);
    expect(r.code).toBe(1);
    expect(text(userSettings())).toBe('{ nope');
    expect(existsSync(`${userSettings()}${BACKUP_SUFFIX}`)).toBe(false);
  });
});

describe('/rulegate:init settings fallback', () => {
  it('hands over the scope the user chose, never a hard-coded --scope both', () => {
    const skill = readFileSync(
      fileURLToPath(new URL('../skills/init/SKILL.md', import.meta.url)),
      'utf8',
    );
    expect(skill).toMatch(
      /! node "<plugin root>\/dist\/settings\.js" --scope <both\|project> --apply/,
    );
    expect(skill).not.toMatch(/--scope both --apply/);
  });

  it('never has the agent run a bare npx rulegate, which fetches from the registry without a TTY', () => {
    const skill = readFileSync(
      fileURLToPath(new URL('../skills/init/SKILL.md', import.meta.url)),
      'utf8',
    );
    expect(skill).toMatch(/npx --no rulegate sync/);
    expect(skill).toMatch(/npx --no rulegate check/);
    // `init` is the user's to run and is handed over, never run by the agent.
    expect(skill.match(/npx rulegate (?!init)\w+/g)).toBeNull();
  });
});
