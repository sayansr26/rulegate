import { claudeDirFromEnv, print, rootArg } from './lib/entry.js';
import { runMemory } from './lib/memory.js';

// `node dist/memory.js [projectDir] [--stale]` — every memory store and its health.
const argv = process.argv.slice(2);
print(
  await runMemory({
    root: rootArg(argv),
    claudeDir: claudeDirFromEnv(),
    stale: argv.includes('--stale'),
  }),
);
