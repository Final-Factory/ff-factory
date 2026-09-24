// The app is a fixed-size screen, not a scrolling document: only its inner scrollers (the
// transcript, a long text box, sheets, lists) move. Mobile browsers fight that: they scroll the
// page to reveal a focused field (even with overflow hidden), the URL bar changes the viewport
// height, and the on-screen keyboard shrinks the visual viewport without resizing the layout
// (iOS). Left alone, the page ends up panned up and sideways with the composer half off screen.
//
// So: the body is fixed to the visual viewport (its top and height follow window.visualViewport),
// and any scroll of the document or of the layout containers is put back to 0.

/** Layout boxes that must never scroll; everything scrollable lives inside them. */
const LOCKED = 'html, body, #root, .shell, .main, .orch, .sb-panel, .session-view, .composer, .composer-box, .composer-actions, .ph, .orch-head, .session-head';

export function lockViewport() {
  const body = document.body;
  const vv = window.visualViewport;
  const apply = () => {
    const h = vv ? vv.height : window.innerHeight;
    // offsetTop: how far iOS has panned the visual viewport down (keyboard up); follow it.
    const top = vv ? Math.max(0, vv.offsetTop) : 0;
    body.style.setProperty('--app-h', `${Math.round(h)}px`);
    body.style.setProperty('--app-top', `${Math.round(top)}px`);
    if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
  };
  apply();
  vv?.addEventListener('resize', apply);
  vv?.addEventListener('scroll', apply);
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', apply);
  document.addEventListener('focusin', () => requestAnimationFrame(() => apply()));
  document.addEventListener(
    'scroll',
    (e) => {
      const t = e.target;
      if (t === document || t === document.documentElement) {
        if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
        return;
      }
      if (t instanceof Element && t.matches(LOCKED) && (t.scrollTop || t.scrollLeft)) {
        t.scrollTop = 0;
        t.scrollLeft = 0;
      }
    },
    { capture: true, passive: true },
  );
}
