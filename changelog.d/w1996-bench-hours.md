- **What the exclusive bench tickets cost each machine, per hour, in `portal_logs`** (w1996): every daemon reads its bench queue's
  history, works out the last 72 UTC hours (exclusive minutes and holds, the editor slots idled behind them, the minutes other
  sessions' shared tickets waited, the requests that held) and sends them to the portal after each welcome and every hour; the
  portal keeps 14 days. `portal_logs {source: "bench_hours", machine}` prints one line per machine-hour and a totals line, so a
  change to how timing runs are placed can be read before and after for BEAST and LothDesktop. Protocol unchanged (a new
  message an older portal drops).
