- **The ops worker's brief and docs/ops-worker.md carry two lessons from the w6597 dedup test** (w6797): over ssh on a
  Windows machine with a restrictive execution policy (LothDesktop) run a script as
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script>`, not with `&`; and in a multi-step job check that
  each install or change step worked (read a scheduled task's arguments back) before the next one.
