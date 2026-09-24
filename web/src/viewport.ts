// The app is a fixed-size screen, not a scrolling document: only its inner scrollers (the
// transcript, a long text box, sheets, lists) move. Mobile browsers fight that: they scroll the
// page to reveal a focused field (even with overflow hidden), the URL bar changes the viewport
// height, and the on-screen keyboard shrinks the visual viewport without resizing the layout
// (iOS). Left alone, the page ends up panned up and sideways with the composer half off screen.
//
// So the body is fixed, and its top follows window.visualViewport: when Safari pans the visual
// viewport to reveal the focused box, the body moves down with it, so the header stays where it
// was on screen. Its height is the layout viewport's, except while a real on-screen keyboard covers
// the bottom: then it is the visual viewport's, so the composer at its bottom sits just above the
// keyboard. Anything smaller at the bottom (the bar an iPad shows with a hardware keyboard, which
// iOS counts as covered although most of it still shows the page) floats over a full-height app:
// shrinking the app to it left a dead band under the composer. When the focused box moves, its
// caret is set again where it is (iOS may go on drawing it where it was). The document is never
// scrolled back by script, nor is a box that holds the focused field: moving either under the
// caret is what made iOS draw the caret in the wrong place.

/** The visible size while no text field has the focus: what an on-screen keyboard takes its height from. */
let rest = { w: 0, h: 0 };

const typing = () => {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
};

const zoomed = (vv: VisualViewport) => Math.abs(vv.scale - 1) > 0.01;

/**
 * How much of the bottom of the screen iOS counts as covered: it keeps the layout and shrinks the
 * visual viewport under a keyboard or a bar. 0 on Android, whose keyboard shrinks the layout itself
 * (interactive-widget=resizes-content), and while the page is pinch-zoomed.
 */
function covered(): number {
  const vv = window.visualViewport;
  if (!vv || zoomed(vv)) return 0;
  return Math.max(0, Math.round(window.innerHeight - vv.height));
}

/**
 * More covered than this is an on-screen keyboard: 30% of the screen, at least 120 px (a phone on
 * its side) and at most 200 px. A hardware keyboard leaves at most a bar: iPadOS's shortcut bar and
 * Chrome's AutoFill bar took 164 px together on a 12.9" iPad on its side, whose own keyboard takes
 * 300 px or more.
 */
const keyboardMin = () => Math.min(200, Math.max(120, 0.3 * (rest.h || window.innerHeight)));

/**
 * Whether the device's own on-screen keyboard is up for the focused field, rather than a hardware
 * keyboard (an iPad's, or one paired with a phone). On Android the layout shrinks with the keyboard,
 * so the height before the field took the focus is the other measure.
 */
export function onScreenKeyboard(): boolean {
  if (!typing()) return false;
  const vv = window.visualViewport;
  const w = Math.round(vv ? vv.width : window.innerWidth);
  const shrunk = rest.w === w ? rest.h - (vv ? vv.height : window.innerHeight) : 0;
  return Math.max(covered(), shrunk) > keyboardMin();
}

/**
 * Set the focused field's caret (or selection) again where it is, once the field has moved: iOS may
 * go on drawing it where the field was. Where it is now, not where it was when the field moved: a
 * key typed in between would otherwise be undone, the caret going back before it.
 */
function redrawCaret() {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const { selectionStart: s, selectionEnd: e, selectionDirection: d } = el;
    if (s !== null && e !== null) el.setSelectionRange(s, e, d ?? undefined);
    return;
  }
  if (!(el instanceof HTMLElement) || !el.isContentEditable) return;
  const sel = window.getSelection();
  const { anchorNode, anchorOffset, focusNode, focusOffset } = sel ?? {};
  if (!sel || !anchorNode || !focusNode || !el.contains(anchorNode) || !el.contains(focusNode)) return;
  sel.removeAllRanges();
  sel.setBaseAndExtent(anchorNode, anchorOffset!, focusNode, focusOffset!);
}

/** Layout boxes that must never scroll; everything scrollable lives inside them. */
const LOCKED = '.shell, .main, .orch, .sb-panel, .session-view, .search-view, .composer, .composer-box, .composer-actions, .ph, .orch-head, .page-head';

const unscroll = (el: Element) => {
  if (el.scrollTop || el.scrollLeft) {
    el.scrollTop = 0;
    el.scrollLeft = 0;
  }
};

export function lockViewport() {
  const body = document.body;
  const vv = window.visualViewport;
  let applied = '';
  // An IME composition (Japanese, Chinese, …) would be cut short by setting the selection again.
  let composing = false;
  const apply = () => {
    const visible = Math.round(vv ? vv.height : window.innerHeight);
    const under = covered();
    if (!typing() && !under) rest = { w: Math.round(vv ? vv.width : window.innerWidth), h: visible };
    const h = under > keyboardMin() ? visible : window.innerHeight;
    // offsetTop: how far Safari has panned the visual viewport down to reveal the field; follow it.
    const top = vv && !zoomed(vv) ? Math.max(0, Math.round(vv.offsetTop)) : 0;
    const key = `${h}/${top}`;
    const sideways = window.scrollX !== 0;
    if (key === applied && !sideways) return;
    if (key !== applied) {
      applied = key;
      body.style.setProperty('--app-h', `${h}px`);
      body.style.setProperty('--app-top', `${top}px`);
    }
    if (sideways) window.scrollTo(0, window.scrollY);
    requestAnimationFrame(() => !composing && redrawCaret());
  };

  // Safari animates the keyboard and its pan, and does not always fire an event for the last step:
  // after anything that may move the viewport, follow it frame by frame for a second.
  let until = 0;
  let frame = 0;
  const follow = () => {
    apply();
    until = performance.now() + 1000;
    if (frame) return;
    const tick = () => {
      apply();
      frame = performance.now() < until ? requestAnimationFrame(tick) : 0;
    };
    frame = requestAnimationFrame(tick);
  };

  apply();
  vv?.addEventListener('resize', follow);
  vv?.addEventListener('scroll', follow);
  window.addEventListener('resize', follow);
  window.addEventListener('orientationchange', follow);
  document.addEventListener('focusin', follow);
  document.addEventListener('focusout', () => {
    follow();
    // What was left alone while it held the focused field goes back once the field has let go.
    requestAnimationFrame(() => document.querySelectorAll(LOCKED).forEach((el) => !el.contains(document.activeElement) && unscroll(el)));
  });
  document.addEventListener('compositionstart', () => (composing = true), true);
  document.addEventListener('compositionend', () => (composing = false), true);
  document.addEventListener(
    'scroll',
    (e) => {
      const t = e.target;
      if (t === document || t === document.documentElement) return follow();
      if (t instanceof Element && t.matches(LOCKED) && !t.contains(document.activeElement)) unscroll(t);
    },
    { capture: true, passive: true },
  );
}
