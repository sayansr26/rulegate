import { bundledVersion, claudeDirFromEnv, print, rootArg } from './lib/entry.js';
import { describeState, setupState } from './lib/state.js';

// `node dist/state.js [projectDir]` — FRESH, REPAIR with the items to fix, or HEALTHY.
print(
  describeState(
    setupState(rootArg(process.argv.slice(2)), claudeDirFromEnv(), {
      expect: bundledVersion(import.meta.url),
    }),
  ),
);
