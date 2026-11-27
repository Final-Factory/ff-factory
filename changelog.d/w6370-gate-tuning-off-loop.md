- **The daily merge-gate tuning no longer stops the portal** (w6370). Its history queries run in a worker thread on
  their own read-only connection. On 2026-11-27 one of them held the portal's loop for 22.9 s, and every open page dropped.
