// The app is a fixed-size screen, not a scrolling document: only its inner scrollers (the
// transcript, a long text box, sheets, lists) move. Mobile browsers fight that: they scroll the
// page to reveal a focused field (even with overflow hidden), the URL bar changes the viewport
// height, and the on-screen keyboard shrinks the visual viewport without resizing the layout
// (iOS). Left alone, the page ends up panned up and sideways with the composer half off screen.
//
// So the body is fixed to the visual viewport: its top and height follow window.visualViewport.
// When a keyboard (or iPad's shortcut bar, with a hardware keyboard) takes the bottom of the screen,
// the body gets shorter, so the composer at its bottom lifts above it; when Safari pans the visual
// viewport to reveal the focused field, the body moves down with it, so the header stays where it
// was on screen. The document itself is never scrolled back by script: that fought Safari's own
// scroll into view and made the whole page jump on an iPad. Sideways scroll, and scroll of the
// layout containers (which have nothing to scroll), are put back.

/** Layout boxes that must never scroll; everything scrollable lives inside them. */
const LOCKED = '.shell, .main, .orch, .sb-panel, .session-view, .search-view, .composer, .composer-box, .composer-actions, .ph, .orch-head, .page-head';

export function lockViewport() {
  const body = document.body;
  const vv = window.visualViewport;
  let applied = '';
  const apply = () => {
    const h = Math.round(vv ? vv.height : window.innerHeight);
    // offsetTop: how far Safari has panned the visual viewport down (keyboard or shortcut bar up); follow it.
    const top = Math.round(vv ? Math.max(0, vv.offsetTop) : 0);
    const key = `${h}/${top}`;
    if (key !== applied) {
      applied = key;
      body.style.setProperty('--app-h', `${h}px`);
      body.style.setProperty('--app-top', `${top}px`);
    }
    if (window.scrollX) window.scrollTo(0, window.scrollY);
  };

  // Safari animates the keyboard and its pan, and does not always fire an event for the last step
  // (the iPad's shortcut bar with a hardware keyboard): after anything that may move the viewport,
  // follow it frame by frame for a second.
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
  document.addEventListener('focusout', follow);
  document.addEventListener(
    'scroll',
    (e) => {
      const t = e.target;
      if (t === document || t === document.documentElement) return follow();
      if (t instanceof Element && t.matches(LOCKED) && (t.scrollTop || t.scrollLeft)) {
        t.scrollTop = 0;
        t.scrollLeft = 0;
      }
    },
    { capture: true, passive: true },
  );
}
