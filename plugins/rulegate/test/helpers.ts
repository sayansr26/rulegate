import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** A throwaway directory holding a project root and a separate Claude config dir. */
export interface Sandbox {
  readonly root: string;
  readonly claudeDir: string;
  put(rel: string, content: string | object): Promise<void>;
  putHome(rel: string, content: string | object): Promise<void>;
  /** `git init` + one commit of everything, dated so `%cs` is predictable. */
  commit(date: string): void;
  dispose(): Promise<void>;
}

async function write(abs: string, content: string | object): Promise<void> {
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(
    abs,
    typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`,
  );
}

export async function sandbox(): Promise<Sandbox> {
  const base = await mkdtemp(path.join(tmpdir(), 'rulegate-plugin-'));
  const root = path.join(base, 'repo');
  const claudeDir = path.join(base, 'claude-home');
  await mkdir(root);
  await mkdir(claudeDir);
  // Tests spawn git freely: they are not shipped source, and the invariants scan skips them.
  const git = (args: string[], env: NodeJS.ProcessEnv = {}): void => {
    execFileSync(
      'git',
      [
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@example.invalid',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {
        cwd: root,
        stdio: 'ignore',
        env: { ...process.env, ...env },
      },
    );
  };
  return {
    root,
    claudeDir,
    put: (rel, content) => write(path.join(root, rel), content),
    putHome: (rel, content) => write(path.join(claudeDir, rel), content),
    commit(date) {
      git(['init', '-q']);
      git(['add', '-A']);
      git(['commit', '-q', '-m', 'fixture'], {
        GIT_AUTHOR_DATE: `${date}T12:00:00Z`,
        GIT_COMMITTER_DATE: `${date}T12:00:00Z`,
      });
    },
    dispose: () => rm(base, { recursive: true, force: true }),
  };
}
