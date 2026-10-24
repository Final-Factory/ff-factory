import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_REASON_HELP, MODEL_REASON_MAX, workerModelChoice } from './workerModel.ts';
import { DEFAULT_WORKER_EFFORT, DEFAULT_WORKER_MODEL } from './config.ts';

const cfg = { models: ['opus', 'sonnet', 'haiku'], defaultModel: 'opus' };

test('w2010: a worker starts on the default model unless one is named, and the default needs no reason', () => {
  assert.deepEqual(workerModelChoice(cfg, {}, 'orchestrator'), { model: undefined, note: '' });
  assert.deepEqual(workerModelChoice(cfg, { model: ' Opus ' }, 'orchestrator'), { model: 'opus', note: '' });
});

test('w2010: an orchestrator naming another model says why, and the reason is what the log carries', () => {
  assert.throws(() => workerModelChoice(cfg, { model: 'sonnet' }, 'orchestrator'), { message: MODEL_REASON_HELP });
  assert.throws(() => workerModelChoice(cfg, { model: 'sonnet', model_reason: '   ' }, 'orchestrator'), { message: MODEL_REASON_HELP });
  assert.deepEqual(workerModelChoice(cfg, { model: 'sonnet', model_reason: 'small: one doc\n file, done-criteria in the brief' }, 'orchestrator'), {
    model: 'sonnet',
    note: ' on sonnet (small: one doc file, done-criteria in the brief)',
  });
  assert.equal(workerModelChoice(cfg, { model: 'sonnet', model_reason: 'x'.repeat(500) }, 'orchestrator').note.length, ' on sonnet ()'.length + MODEL_REASON_MAX);
});

test("w2010: a person's own start names the model with no reason; an unknown model is refused for anyone", () => {
  assert.deepEqual(workerModelChoice(cfg, { model: 'sonnet' }, 'human'), { model: 'sonnet', note: ' on sonnet' });
  assert.throws(() => workerModelChoice(cfg, { model: 'gpt', model_reason: 'small: x' }, 'orchestrator'), /model must be one of opus, sonnet, haiku \(default opus\)/);
});

test('w2010: with nothing configured, workers start on Opus at medium effort', () => {
  assert.equal(DEFAULT_WORKER_EFFORT, 'medium');
  assert.equal(DEFAULT_WORKER_MODEL, 'opus');
});
