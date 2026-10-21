// Notifications on this device (server/notify.ts): Web Push through the service worker, or, in a browser that has no
// Web Push, an in-page notification while the tab is in the background. "Turn off" is a choice kept in localStorage
// (and told to the service worker): off shows nothing by either route (shared/notifyDevice.ts, w1660).
import { useSyncExternalStore } from 'react';
import type { NotifyKind, NotifyPrefs } from '../../shared/types';
import { notifyMode, pageShows, type NotifyMode } from '../../shared/notifyDevice';
import { api } from './api';
import { lsGet, lsSet, navigate, parseRoute } from './util';

export const DEFAULT_PREFS: NotifyPrefs = { permission: true, person: true, turnEnd: true, error: true, standing: true, delegation: true, unity: true, host: true };

export interface PushState {
  /** This browser can do Web Push at all. */
  supported: boolean;
  /** iOS only allows push for an app added to the Home Screen. */
  needsHomeScreen: boolean;
  permission: NotificationPermission | 'unsupported';
  /** This device's subscription, if it has one. */
  endpoint?: string;
  /** The person turned notifications off on this device: nothing is shown, by push or in the page. */
  off: boolean;
  prefs: NotifyPrefs;
  busy: boolean;
}

const OFF_KEY = 'ffsb.notify.off';
/** Endpoints this device unsubscribed from that the server has not yet confirmed dropping (retried at boot). */
const DROP_KEY = 'ffsb.notify.drop';
/** Where the service worker reads the off choice (it has no localStorage). */
const SW_FLAG_CACHE = 'ffsb-device';
const SW_FLAG_URL = '/__notify-off';

const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

let state: PushState = {
  supported: 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window,
  needsHomeScreen: isIos && !standalone,
  permission: 'Notification' in window ? Notification.permission : 'unsupported',
  off: lsGet(OFF_KEY) === '1',
  prefs: { ...DEFAULT_PREFS, ...JSON.parse(lsGet('ffsb.notify.prefs') ?? '{}') },
  busy: false,
};
const listeners = new Set<() => void>();
const set = (p: Partial<PushState>) => {
  state = { ...state, ...p };
  if (p.prefs) lsSet('ffsb.notify.prefs', JSON.stringify(p.prefs));
  listeners.forEach((l) => l());
};

export const pushMode = (p: PushState = state): NotifyMode => notifyMode(p);

export function usePush(): PushState {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
  );
}

let registration: ServiceWorkerRegistration | undefined;

/** Register the service worker and learn whether this device is subscribed. Called once at boot. */
export async function initNotifications() {
  void tellServiceWorker(state.off);
  if (!('serviceWorker' in navigator)) return;
  try {
    registration = await navigator.serviceWorker.register('/sw.js');
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'navigate' && typeof e.data.hash === 'string') navigate(parseRoute(e.data.hash));
    });
    const sub = await registration.pushManager?.getSubscription();
    if (state.off) {
      // Turned off here: a subscription still on this browser (the unsubscribe failed) is dropped, never re-registered.
      if (sub) await dropSubscription(sub);
      await dropPending();
    } else if (sub) {
      set({ endpoint: sub.endpoint });
      // Re-register it (the server may have been reset) and take the server's copy of this device's choices.
      const r = await api.pushSubscribe(sub.toJSON(), state.prefs).catch(() => undefined);
      if (r) set({ prefs: r.prefs });
    }
  } catch (e) {
    console.warn('service worker:', e);
  }
}

function keyBytes(b64: string) {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** Ask for permission and subscribe this device. */
export async function enablePush() {
  set({ busy: true });
  try {
    const permission = await Notification.requestPermission();
    set({ permission });
    if (permission !== 'granted') throw new Error('Notifications are blocked for this site in the browser settings.');
    registration ??= await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    const { publicKey } = await api.push();
    const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    const r = await api.pushSubscribe(sub.toJSON(), state.prefs);
    setOff(false);
    set({ endpoint: sub.endpoint, prefs: r.prefs });
  } finally {
    set({ busy: false });
  }
}

/** Allow in-tab notifications in a browser that has no Web Push, and turn them on. */
export async function enableInTab() {
  const permission = await Notification.requestPermission();
  set({ permission });
  if (permission !== 'granted') throw new Error('Notifications are blocked for this site in the browser settings.');
  setOff(false);
}

function setOff(off: boolean) {
  lsSet(OFF_KEY, off ? '1' : null);
  set({ off });
  void tellServiceWorker(off);
}

/** The service worker cannot read localStorage: it reads this flag from the Cache API. */
async function tellServiceWorker(off: boolean) {
  try {
    const cache = await caches.open(SW_FLAG_CACHE);
    if (off) await cache.put(SW_FLAG_URL, new Response('off'));
    else await cache.delete(SW_FLAG_URL);
  } catch {
    // no Cache API here (an insecure page): the page's own check still holds, and an unsubscribed browser gets no push
  }
}

const pendingDrops = (): string[] => JSON.parse(lsGet(DROP_KEY) ?? '[]');

async function dropOnServer(endpoint: string) {
  const left = pendingDrops().filter((e) => e !== endpoint);
  try {
    await api.pushUnsubscribe(endpoint);
    lsSet(DROP_KEY, left.length ? JSON.stringify(left) : null);
  } catch {
    lsSet(DROP_KEY, JSON.stringify([...left, endpoint]));
  }
}

async function dropPending() {
  for (const e of pendingDrops()) await dropOnServer(e);
}

async function dropSubscription(sub: PushSubscription) {
  await dropOnServer(sub.endpoint);
  await sub.unsubscribe().catch(() => false);
}

/** Turn notifications off on this device: no push, no in-page notice, and the server forgets this device. */
export async function disablePush() {
  set({ busy: true });
  // First, so a notice arriving meanwhile is already refused; the rest may fail and is retried at the next boot.
  setOff(true);
  try {
    const endpoint = state.endpoint;
    const sub = await registration?.pushManager.getSubscription();
    set({ endpoint: undefined });
    if (endpoint && endpoint !== sub?.endpoint) await dropOnServer(endpoint);
    if (sub) await dropSubscription(sub);
  } finally {
    set({ busy: false });
  }
}

export async function setPref(kind: NotifyKind, on: boolean) {
  const prefs = { ...state.prefs, [kind]: on };
  set({ prefs });
  if (state.endpoint) set({ prefs: (await api.pushPrefs(state.endpoint, { [kind]: on })).prefs });
}

/** A test to this device: through push when subscribed, else in-page when this browser notifies from the page. */
export async function testNotification(): Promise<string> {
  if (pushMode() === 'off') throw new Error('Turn notifications on first.');
  if (state.endpoint) {
    const r = await api.pushTest(state.endpoint);
    return r.delivered ? 'Sent. It should appear in a moment (even with this tab in front).' : 'The push service did not take it; try turning notifications off and on.';
  }
  await show({ title: 'FF Factory', body: 'Test notification: this tab will tell you while it is in the background.', url: '#/', tag: 'test' });
  return 'Shown.';
}

async function show(n: { title: string; body: string; url: string; tag: string }) {
  const opts = { body: n.body, tag: n.tag, icon: '/icon-192.png', data: { url: n.url } };
  if (registration) return registration.showNotification(n.title, opts);
  const note = new Notification(n.title, opts);
  note.onclick = () => {
    window.focus();
    navigate(parseRoute(n.url));
  };
}

/** A `notify` event from the server: shown here only by a browser with no Web Push, never after "Turn off". */
export function onNotice(n: { kind: NotifyKind; title: string; body: string; url: string; tag: string }) {
  const inFront = document.visibilityState === 'visible' && document.hasFocus();
  if (pageShows(state, state.prefs[n.kind], inFront)) void show(n);
}
