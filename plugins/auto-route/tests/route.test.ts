import { expect, test } from 'claude-code/testing';
import type { HookStream, TurnStepChunk, TurnStepInput, TurnStepResult } from 'claude-code';

import { classify } from '../hooks/register';

const STEP: TurnStepInput = {
  turnId: 't1',
  index: 0,
  model: 'claude-opus-5-5',
  effort: 'high',
  messageCount: 1,
};

const ORIGIN = { kind: 'composer' } as const;

const prompt = (text: string) => ({ text, wait: false, origin: ORIGIN });

const route = (args: string) => ({
  command: 'route',
  args,
  origin: ORIGIN,
  presentation: { isFullscreen: false, columns: 120 },
});

// Reads the request's stream to its end, as the engine would.
type Steps = { turn: { step: (e: TurnStepInput) => HookStream<TurnStepChunk, TurnStepResult> } };

const step = async ($: Steps, e: TurnStepInput) => {
  const stream = $.turn.step(e);
  for await (const _ of stream) {
  }
  return stream.result;
};

test('prompts land in the expected tier', async () => {
  expect(classify('what does this function return?').tier).toBe('light');
  expect(classify('ok').tier).toBe('light');
  expect(
    classify(
      'add a loading spinner to the submit button on the ask form and disable it while saving',
    ).tier,
  ).toBe('standard');
  expect(classify('refactor the fix ranking so it weighs environment matches').tier).toBe('deep');
  expect(classify('debug why the MCP search is slow').tier).toBe('deep');
  expect(classify('ultrathink about the verification model').tier).toBe('max');
  expect(classify('is there a race condition in the release watcher?').tier).toBe('max');
});

test('the routed model and effort reach the request, subagents untouched', async ($, on) => {
  const sent: TurnStepInput[] = [];
  on('ui.status', () => ({ value: undefined }));
  on('prompt.submit', (_, e) => ({ text: e.text }));
  on('turn.step', async function* (_, e) {
    sent.push(e);
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    };
  });

  await $.prompt.submit(prompt('what is in package.json?'));
  await step($, STEP);
  await step($, { ...STEP, agentId: 'a1' });

  expect(sent[0]?.model).toBe('claude-haiku-5-5');
  expect(sent[0]?.effort).toBe('low');
  expect(sent[1]?.model).toBe('claude-opus-5-5');
  expect(sent[1]?.effort).toBe('high');
});

test('/route pins a tier and off stops routing', async ($, on) => {
  const sent: TurnStepInput[] = [];
  on('command.register', () => ({ value: { command: 'route' } }));
  on('session.start', (_, e) => ({ cwd: e.cwd }));
  on('ui.status', () => ({ value: undefined }));
  on('prompt.submit', (_, e) => ({ text: e.text }));
  on('turn.step', async function* (_, e) {
    sent.push(e);
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn',
      usage: null,
    };
  });

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true });
  await $.command.run(route('max'));
  await $.prompt.submit(prompt('ok'));
  await step($, STEP);
  expect(sent[0]?.effort).toBe('max');

  await $.command.run(route('off'));
  await step($, { ...STEP, model: 'claude-sonnet-5-5', effort: 'medium' });
  expect(sent[1]?.model).toBe('claude-sonnet-5-5');
  expect(sent[1]?.effort).toBe('medium');
});
