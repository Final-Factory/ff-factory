// What this device does with a notification (web/src/notify.ts, web/public/sw.js). One decision, kept free of
// browser globals so a node test can pin it: turned off means nothing is shown, by push or in the page.

export type NotifyMode = 'push' | 'tab' | 'off';

export interface DeviceNotify {
  /** The person turned notifications off on this device (Settings, "Turn off"), kept in localStorage. */
  off: boolean;
  /** This device's Web Push subscription, if it has one. */
  endpoint?: string;
  /** The browser can do Web Push at all. */
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
}

/**
 * `push`: Web Push, shown by the service worker even with the app closed. `tab`: a browser with no Web Push that was
 * allowed to notify; the open tab shows them while it is in the background. `off`: nothing. A browser that can do Web
 * Push but has no subscription is off, however much permission it was given: permission alone is not a choice to be
 * notified (w1660: "I silenced notifications but the webpage keeps notifying me with windows toast messages").
 */
export function notifyMode(d: DeviceNotify): NotifyMode {
  if (d.off) return 'off';
  if (d.endpoint) return 'push';
  return !d.supported && d.permission === 'granted' ? 'tab' : 'off';
}

/** Whether the open page shows a notice itself: in `tab` mode only, for a kind that is on, with the app out of sight. */
export function pageShows(d: DeviceNotify, kindOn: boolean, appInFront: boolean): boolean {
  return notifyMode(d) === 'tab' && kindOn && !appInFront;
}
