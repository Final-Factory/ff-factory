import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRealModelId, modelGlance, modelName } from '../shared/models.ts';

test('model ids in words (w1358)', () => {
  const names: [string, string][] = [
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-sonnet-5-5', 'Sonnet 5.5'],
    ['claude-haiku-4-5', 'Haiku 4.5'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-opus-4-5-20251101', 'Opus 4.5'],
    ['claude-opus-4-20250514', 'Opus 4'],
    ['claude-opus-5', 'Opus 5'],
    ['claude-3-5-sonnet-20241022', 'Sonnet 3.5'],
    ['claude-3-haiku-20240307', 'Haiku 3'],
    ['claude-opus-5-5[1m]', 'Opus 5.5 (1M)'],
    ['CLAUDE-OPUS-5-5', 'Opus 5.5'],
    ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'Sonnet 4.5'],
    ['anthropic/claude-opus-5-5', 'Opus 5.5'],
    ['opus', 'Opus'],
    ['sonnet[1m]', 'Sonnet (1M)'],
    ['haiku', 'Haiku'],
  ];
  for (const [id, name] of names) assert.equal(modelName(id), name, id);
  // An id it does not know stays as it is; none gives none.
  assert.equal(modelName('gpt-5'), 'gpt-5');
  assert.equal(modelName('fake-model'), 'fake-model');
  assert.equal(modelName(undefined), undefined);
  assert.equal(modelName('  '), undefined);
});

test('the header shows the model of the last reply, else the configured one marked, else nothing (w1358)', () => {
  assert.deepEqual(modelGlance({ activeModel: 'claude-sonnet-5-5', model: 'claude-opus-5-5' }), { name: 'Sonnet 5.5', id: 'claude-sonnet-5-5', configured: false });
  assert.deepEqual(modelGlance({ model: 'claude-opus-5-5' }), { name: 'Opus 5.5', id: 'claude-opus-5-5', configured: true });
  assert.equal(modelGlance({}), undefined);
  // Claude Code's placeholder for a message no model wrote is no model.
  assert.equal(isRealModelId('<synthetic>'), false);
  assert.equal(modelGlance({ activeModel: '<synthetic>' }), undefined);
  assert.equal(modelGlance({ activeModel: '<synthetic>', model: 'claude-opus-5-5' })?.configured, true);
});
