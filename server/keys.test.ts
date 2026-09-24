import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enterAction } from '../shared/keys.ts';

const k = (over: Partial<Parameters<typeof enterAction>[0]> = {}) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...over });
const desk = { touch: false, canSend: true };

test('Enter sends; Shift+Enter and Ctrl/Cmd+Enter make a new line', () => {
  assert.equal(enterAction(k(), desk), 'send');
  assert.equal(enterAction(k({ shiftKey: true }), desk), 'default', 'the browser inserts the newline');
  assert.equal(enterAction(k({ ctrlKey: true }), desk), 'newline', 'a textarea ignores Ctrl+Enter, so we insert it');
  assert.equal(enterAction(k({ metaKey: true }), desk), 'newline');
  assert.equal(enterAction(k({ key: 'a' }), desk), 'default');
});

test('IME composition, touch keyboards and empty messages', () => {
  assert.equal(enterAction(k({ isComposing: true }), desk), 'default');
  assert.equal(enterAction(k({ keyCode: 229 }), desk), 'default');
  assert.equal(enterAction(k(), { touch: true, canSend: true }), 'default', 'phone: Enter is a new line, the button sends');
  assert.equal(enterAction(k(), { touch: false, canSend: false }), 'ignore', 'nothing to send: Enter does nothing');
});
