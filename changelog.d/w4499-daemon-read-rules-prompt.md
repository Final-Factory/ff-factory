- **The worker prompt states exactly what the daemon-folder read guard allows, and `portal_logs` states its regex limit** (w4499; w4495's
  worker had five commands refused). Each daemon read is its own command with a full path (no cd, no `VAR=value` prefix, no `$(...)`),
  piped only into head, tail, grep, sort, wc, uniq, cut or jq; awk, mkdir or a second ls in the same command is refused (`server/daemonReads.ts`
  BESIDE set); more is done on a copy in `$TMPDIR`. `portal_logs`' description says a regex is at most 100 characters.
