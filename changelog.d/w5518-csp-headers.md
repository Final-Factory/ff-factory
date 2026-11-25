- **The dashboard sends a Content-Security-Policy, nosniff and HSTS** (w5518, finding 12 of the w5452 security audit). The app
  page (`/`, `/login` and every app route) carries a CSP: scripts only from the portal itself (no inline script, no `eval`, no
  `blob:`), no plug-ins (`object-src 'none'`), no framing (`frame-ancestors 'none'`), `base-uri 'none'`; stills, clips and
  previews from the portal, `data:` and `blob:`; the page socket on its own host. Every answer carries
  `X-Content-Type-Options: nosniff`, and over HTTPS (Funnel) `Strict-Transport-Security: max-age=31536000`
  (`server/webStatic.ts` `appCsp`, `server/index.ts`). **Remote images in agent text no longer load** (an `![x](https://…)`
  shows its alt text, as an image that is not available does): only the portal's own stills, `data:` images and local previews do. The voice tap's AudioWorklet
  is now a file of its own (`web/public/voice-tap.js`) instead of a `blob:` script. Mermaid is 12.3.0, which brings
  DOMPurify 3.5.0 (npm audit flagged DOMPurify ≤ 3.4.16 as high); `web` has no npm audit findings left. Every e2e test on the
  signed-in page now fails on a CSP refusal in the browser console (`e2e/fixtures.ts`), and `e2e/csp.spec.ts` checks the
  headers and the remote-image refusal on a login of its own.
