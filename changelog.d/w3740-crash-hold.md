- **Crash hold (w3740).** When a machine drops mid-turn (not a drop the portal made) under a worker whose game player or
  exclusive timing ticket the portal saw there in the last 30 minutes, each open request that worker holds gets a crash
  hold on that machine: its priorities.json mark makes the guard refuse that request's player launches there
  (`player_slots.py launch` or the binary), and the worker's resume says why and what to do. Only a person's own
  orchestrator clears it, in their turn with their verbatim words (`clear_crash_hold`, kind P; without arguments it lists
  the holds). A worker that ran on through the drop (a network blip) clears its own hold with its gate. Every worker's
  "Processes you start" now says one crash ends its runs there, and the `machines` rules topic (which the dispatcher's
  and orchestrators' briefs now name for crash repros) says a crash-repro brief states "stop after one crash".
  After w3704's crash tests took Ben's m3 down twice in one request (19:50Z and 21:37Z, 2026-11-08).
