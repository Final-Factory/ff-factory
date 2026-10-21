import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifyMode, pageShows, type DeviceNotify } from '../shared/notifyDevice.ts';

const base: DeviceNotify = { off: false, supported: true, permission: 'granted' };

test('a subscribed device gets push, and its page shows nothing itself', () => {
  const d = { ...base, endpoint: 'https://push.example/1' };
  assert.equal(notifyMode(d), 'push');
  assert.equal(pageShows(d, true, false), false);
});

test('w1660: after Turn off, permission still granted and the tab in the background shows nothing', () => {
  // disablePush clears the endpoint and sets off; the browser permission stays granted.
  const d = { ...base, off: true, endpoint: undefined };
  assert.equal(notifyMode(d), 'off');
  assert.equal(pageShows(d, true, false), false);
});

test('w1660: an explicit off wins even over a subscription that could not be dropped', () => {
  assert.equal(notifyMode({ ...base, off: true, endpoint: 'https://push.example/1' }), 'off');
});

test('a push-capable browser with no subscription is off, whatever its permission says', () => {
  assert.equal(notifyMode({ ...base }), 'off');
  assert.equal(pageShows({ ...base }, true, false), false);
});

test('a browser without Web Push that was allowed shows in the page while it is in the background', () => {
  const d = { ...base, supported: false };
  assert.equal(notifyMode(d), 'tab');
  assert.equal(pageShows(d, true, false), true);
  assert.equal(pageShows(d, true, true), false, 'the app is in front');
  assert.equal(pageShows(d, false, false), false, 'that kind is off');
  assert.equal(notifyMode({ ...d, permission: 'default' }), 'off');
  assert.equal(notifyMode({ ...d, permission: 'denied' }), 'off');
  assert.equal(notifyMode({ ...d, off: true }), 'off');
});
