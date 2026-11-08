// The page a one-time set-password link opens (w3714, `node server/user.ts <name> --link`): no app bundle, no login. The
// token rides in the URL's #fragment, so it never reaches a server log or a Referer; the page posts it with the new
// password to /api/set-password, which logs this browser in, then opens the portal.
import { randomBytes } from 'node:crypto';

export function setPasswordPage(): { nonce: string; html: string } {
  const nonce = randomBytes(16).toString('base64');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Set your password</title>
<style nonce="${nonce}">
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0e13; color: #e6edf3; font: 15px/1.5 system-ui, sans-serif; }
  form { width: min(360px, 90vw); display: grid; gap: 12px; padding: 28px; border: 1px solid #263040; border-radius: 12px; background: #0d1218; }
  h1 { margin: 0 0 4px; font-size: 20px; }
  label { display: grid; gap: 4px; color: #9aa7b4; }
  input { padding: 10px 12px; border: 1px solid #263040; border-radius: 8px; background: #0a0e13; color: inherit; font: inherit; }
  button { padding: 10px; border: 0; border-radius: 8px; background: #ff9f1c; color: #0a0e13; font: inherit; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: 0.6; cursor: default; }
  #msg { min-height: 1.5em; margin: 0; color: #ff7b72; }
</style>
</head>
<body>
<form id="f">
  <h1>Set your password</h1>
  <p id="who">At least 12 characters. This link works once.</p>
  <label>New password <input id="p1" type="password" autocomplete="new-password" minlength="12" required autofocus></label>
  <label>Again <input id="p2" type="password" autocomplete="new-password" minlength="12" required></label>
  <button id="go" type="submit">Set password and log in</button>
  <p id="msg" role="alert"></p>
</form>
<script nonce="${nonce}">
  const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
  const msg = document.getElementById('msg');
  const go = document.getElementById('go');
  if (!token) { msg.textContent = 'This link has no token. Ask for a new one.'; go.disabled = true; }
  document.getElementById('f').addEventListener('submit', async (e) => {
    e.preventDefault();
    const p1 = document.getElementById('p1').value, p2 = document.getElementById('p2').value;
    if (p1 !== p2) { msg.textContent = 'The two passwords differ.'; return; }
    go.disabled = true; msg.textContent = '';
    try {
      const r = await fetch('/api/set-password', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: p1 }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok) { history.replaceState(null, '', '/set-password'); location.href = '/'; return; }
      msg.textContent = j.error || ('Refused (' + r.status + ').');
    } catch { msg.textContent = 'The portal did not answer. Try again.'; }
    go.disabled = false;
  });
</script>
</body>
</html>
`;
  return { nonce, html };
}
