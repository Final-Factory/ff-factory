import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarker, reopenCs } from './unityMcp.ts';

test('unity bridge: the FFSB marker is found inside the tool result JSON', () => {
  const wrapped = JSON.stringify([{ type: 'text', text: JSON.stringify({ success: true, data: { result: 'FFSB|playing=0|dirty=|scenes=Assets/A.unity;Assets/B.unity|active=Assets/A.unity' } }) }]);
  assert.deepEqual(parseMarker(wrapped), { playing: '0', dirty: '', scenes: 'Assets/A.unity;Assets/B.unity', active: 'Assets/A.unity' });
  assert.equal(parseMarker('nothing here'), undefined);
});

test('unity bridge: scene paths become C# literals', () => {
  const cs = reopenCs(['Assets/Scenes/Main.unity', 'Assets/Odd "name".unity'], 'Assets/Scenes/Main.unity');
  assert.match(cs, /new string\[\] \{ "Assets\/Scenes\/Main.unity", "Assets\/Odd \\"name\\".unity" \}/);
  assert.match(cs, /GetSceneByPath\("Assets\/Scenes\/Main.unity"\)/);
});
