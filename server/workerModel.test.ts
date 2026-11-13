import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_REASON_HELP, MODEL_REASON_MAX, modelAllowed, modelChoices, workerModelChoice } from './workerModel.ts';
import { DEFAULT_CONFIG_MODELS, DEFAULT_WORKER_EFFORT, DEFAULT_WORKER_MODEL } from './config.ts';

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
  assert.throws(() => workerModelChoice(cfg, { model: 'gpt', model_reason: 'small: x' }, 'orchestrator'), /model must be one of opus, sonnet, haiku or a full id of one of those families \(default opus\)/);
});

test('w2010: with nothing configured, workers start on Opus at medium effort', () => {
  assert.equal(DEFAULT_WORKER_EFFORT, 'medium');
  assert.equal(DEFAULT_WORKER_MODEL, 'opus');
});

test('w5: a full model id of a listed family is taken by its id; another family, an alias not listed or a malformed id is not', () => {
  const withFable = { models: ['opus', 'sonnet', 'haiku', 'fable'], defaultModel: 'opus' };
  assert.deepEqual(workerModelChoice(withFable, { model: 'claude-fable-5-2' }, 'human'), { model: 'claude-fable-5-2', note: ' on claude-fable-5-2' });
  assert.equal(workerModelChoice(withFable, { model: 'Claude-Opus-5-5[1m]', model_reason: 'asked: "opus 1m"' }, 'orchestrator').model, 'claude-opus-5-5[1m]');
  assert.throws(() => workerModelChoice(cfg, { model: 'claude-fable-5-2' }, 'human'), /model must be one of opus, sonnet, haiku or a full id/);
  assert.throws(() => workerModelChoice(withFable, { model: 'claude-mythos-5-2' }, 'human'), /model must be one of/);
  assert.throws(() => workerModelChoice(withFable, { model: 'claude-fable-5-2; rm' }, 'human'), /model must be one of/);
  assert.equal(modelAllowed(['claude-fable-5-2'], 'claude-fable-5-2'), true);
  assert.equal(modelAllowed(['opus'], 'claude-opus'), false);
  assert.equal(modelChoices(withFable), 'One of opus, sonnet, haiku, fable or their full ids. Default opus.');
});

test('w5: Fable 5.2 is offered by its id with nothing configured', () => {
  assert.ok(DEFAULT_CONFIG_MODELS.includes('claude-fable-5-2'));
});
