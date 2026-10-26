import { atom, read, update } from 'claude-code';
import type { ModelEffort, Register } from 'claude-code';

import type { Mode, Route, Tier } from '../types';

// Edit this table to change what each tier runs on.
const TIERS: Record<Tier, { model: string; effort: ModelEffort }> = {
  light: { model: 'claude-haiku-5-5', effort: 'low' },
  standard: { model: 'claude-sonnet-5-5', effort: 'medium' },
  deep: { model: 'claude-opus-5-5', effort: 'high' },
  max: { model: 'claude-opus-5-5', effort: 'max' },
};

// Checked top to bottom; the first tier whose pattern matches wins.
const RULES: { tier: Tier; reason: string; pattern: RegExp }[] = [
  {
    tier: 'max',
    reason: 'asked to think hard',
    pattern: /\b(ultrathink|think (really )?hard|think harder|deep dive)\b/i,
  },
  {
    tier: 'max',
    reason: 'security or concurrency',
    pattern:
      /\b(security (audit|review)|vulnerabilit|race condition|deadlock|memory leak|incident|data loss)/i,
  },
  {
    tier: 'deep',
    reason: 'design or debugging',
    pattern:
      /\b(architect|design|refactor|migrat|debug|root cause|investigate|why (is|does|doesn't|isn't)|plan|implement|build (a|the|an)|new feature|end[- ]to[- ]end|across|whole (repo|codebase|app)|optimi[sz]e|performance|review)/i,
  },
  {
    tier: 'light',
    reason: 'small or lookup task',
    pattern:
      /^(what|which|where|who|when|is|are|does|do|can|show|list|print|explain briefly|rename|fix (the )?typo|format|lint|bump|commit message|thanks|thank you|ok|yes|no)\b/i,
  },
];

export const classify = (text: string): Route => {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const rule = RULES.find((one) => one.pattern.test(text));

  if (rule && !(rule.tier === 'light' && words > 40)) {
    return { tier: rule.tier, reason: rule.reason };
  }

  if (words > 150) {
    return { tier: 'deep', reason: 'long, detailed prompt' };
  }

  return words <= 8
    ? { tier: 'light', reason: 'short prompt' }
    : { tier: 'standard', reason: 'regular coding task' };
};

const MODES: readonly Mode[] = ['auto', 'off', 'light', 'standard', 'deep', 'max'];

const mode = atom({ plugin: 'auto-route', key: 'mode' } as const, 'auto');
const route = atom({ plugin: 'auto-route', key: 'route' } as const, null);

const describe = (current: Mode, last: Route | null) => {
  if (current === 'off') {
    return 'auto-route: off';
  }

  const pinned = current === 'auto' ? '' : ' (pinned)';
  const tier = current === 'auto' ? last?.tier : current;

  if (!tier) {
    return 'auto-route: waiting for a prompt';
  }

  const { model, effort } = TIERS[tier];

  return `auto-route: ${tier}${pinned} · ${model.replace(/^claude-/, '')} / ${effort}`;
};

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'route',
      description: 'Auto model routing: auto, off, or pin light | standard | deep | max',
    });

    return next(e);
  });

  on('command.run', { command: 'route' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase();

    if (asked !== '') {
      const next = MODES.find((one) => one === asked);

      if (!next) {
        return { text: `auto-route: unknown mode "${asked}". Use ${MODES.join(', ')}.` };
      }

      await update($, mode, () => next);
    }

    const text = describe(await read($, mode), await read($, route));
    $.ui.status(text);

    return { text: text.replace(/^auto-route: /, '') };
  });

  on('prompt.submit', async ($, e, next) => {
    // A prompt delivered into a running turn keeps that turn's route.
    const current = await read($, mode);
    const isRouted = e.turnId === undefined && !e.command && current === 'auto';
    $.ui.log(
      `auto-route: prompt.submit mode=${current} turnId=${e.turnId ?? '-'} command=${e.command ? 'yes' : 'no'} routed=${isRouted}`,
    );

    if (isRouted) {
      const picked = classify(e.text);
      await update($, route, () => picked);
      $.ui.status(describe('auto', picked));
    }

    return next(e);
  }).catch(($, e, next) => {
    $.ui.log('auto-route: prompt.submit hook failed');

    return next(e);
  });

  on('turn.step', async function* ($, e, next) {
    const current = await read($, mode);
    const last = await read($, route);
    const tier = current === 'auto' ? last?.tier : current === 'off' ? undefined : current;

    // Subagents choose their own model; leave their requests alone.
    if (e.agentId !== undefined || !tier) {
      return yield* next(e);
    }

    const { model, effort } = TIERS[tier];
    $.ui.log(`auto-route: turn.step ${e.model}/${e.effort ?? '-'} -> ${model}/${effort}`);

    return yield* next({ ...e, model, effort });
  });
};
