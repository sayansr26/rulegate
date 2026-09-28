import { guard, inline, realish, within, type Decision } from '@rulegate/claude';
import { firstInSession } from '../session/marker.js';
import { pluginConfig } from './config.js';
import { featureOf, findMap, mapFiles, tracked } from './features.js';

/**
 * The PreToolUse hook's two jobs (T101), both at the moment an edit happens — a CLAUDE.md
 * sentence read an hour ago loses to whatever else is in context:
 *
 *   1. **Generated-file guard (blocks).** An edit to a path `.rulegate/state.json` records
 *      is denied. The guard lives in `@rulegate/claude`, because the settings writer's
 *      refusals ask it the same question.
 *   2. **Cartographer reminder (advisory).** The first edit to an existing feature with no
 *      map, once per feature per session, suggests asking the cartographer first.
 *
 * Every error means "say nothing": the one deliberate way this hook affects a session is
 * the deny.
 */
export { guard, type Decision };

export async function reminder(
  targetAbs: string,
  projectDir: string,
  sessionId: string,
  first: (session: string, key: string) => boolean = firstInSession,
): Promise<Decision | undefined> {
  if (pluginConfig(projectDir).cartographerReminder === false) return undefined;
  const rel = within(realish(projectDir), realish(targetAbs));
  if (rel === undefined) return undefined;
  const feature = featureOf(projectDir, rel);
  if (feature === undefined) return undefined;
  if (findMap(feature, mapFiles(projectDir)) !== undefined) return undefined;
  // A feature git has never seen is being created, not changed; there is nothing to map.
  if (!(await tracked(projectDir, feature.dir))) return undefined;
  if (!first(sessionId, feature.dir)) return undefined;
  const dir = inline(feature.dir);
  return {
    kind: 'context',
    text:
      `Rulegate (advisory): ${dir}/ is an existing feature with no cartographer map. ` +
      `Before changing it further, ask rulegate:feature-cartographer how "${inline(feature.name)}" is built — ` +
      'it answers and files the map for every later session. This applies in plan mode too ' +
      '(ask it read-only; it files the map after plan mode ends). Shown once per feature per session.',
  };
}
