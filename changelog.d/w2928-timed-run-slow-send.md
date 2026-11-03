- **A timed run whose builds take long to send no longer hangs its worker** (w2928, found by lothsahn's 4-hourly unjam
  rule: tr_affa494c34 and tr_2b5e6e6230 sat at "40 of 40 pieces to send"). The worker's `timed_run` held until every
  piece was sent, and m3's four builds took 40 min to reach the portal, past the 20 min the agent host waits: the call
  failed, the worker sent everything again, and the first run later took LothDesktop's bench ticket for nobody. Now the
  call answers within 10 min with the run id and goes on sending in the background; the worker is messaged when the run is
  handed over or the send fails, and a second call while one still sends is refused. Docs: machines.md ("A slow send
  answers in time"). Test: `w2928TimedSlowSend.test.ts`.
