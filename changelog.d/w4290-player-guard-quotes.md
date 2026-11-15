- **Guard: a `|` or `;` inside quotes no longer splits a command (w4290).** checkPlayerLaunch and checkScriptPlayerLaunch
  split a command on `&&`, `||`, `;`, `|` and newlines without regard to quotes, so a read-only
  `grep -n 'x\|finalfactory.app" \\' notes.md` read the text after the quoted `|` as a command whose program was the
  player, and was refused (m5/slot2, w4286, 2026-11-15). They now split only outside single and double quotes (and on an
  escaped `\|` only as text). A newline always splits, and a line left inside an unbalanced quote (`echo don't;
  ./finalfactory`) is split as before, so `ls | ./finalfactory` and other real launches are still refused.
