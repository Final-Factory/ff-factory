# w1209 state (on hold until Sun 2026-10-18 ~11:00Z, lothsahn's word)

Not for merge: a note on a branch. Everything below that is "done" is merged into main.

## Done (merged, deployed: the portal runs d0b773e)
- #362 (233fb28) spend_report bills coordinator turns apart from the workers' own cost (w1160).
- #381 (abc5bd7) coordination days per coordinator session, rebuilt by the rules that recorded each turn (w605 read as worker cost), and the accountRouting take-over test deflaked (one shared link stamp).
- #383 (56a6da2) closed requests leave a worker's split (`openFirst`); a coordinator the store forgot stays a coordinator (`infoOfRecord`); resumed context is `carried`, not `base`.
- #386 (d0b773e) `correctHistory` + `repairSpend` (server/spend.ts, server/index.ts): old restart-total double counts and citation-billed turns recorded again by the current rules; bucket request views; 25-session cap. docs/spend.md has the rules and the findings table (8 findings).

## What the live repair did (measured, journal 2026-10-13 09:02 -06:00)
`spend repair: 1088 session(s) looked at, 11 corrected ($10980.08 taken out of restart turns, $177.53 moved off requests a notice only cited), $1235.70 of coordination given its days; left as recorded: 6dca4d5c ($39.57 replay vs $28.26 record), ae965823 ($5.45 vs $4.79), a048b3a5 ($324.62 vs $249.80)`.
Backup of the record before it: `spend.json.pre-w1209` in the portal's data folder.

## Left
1. VERIFY the $10,980.08 (about half the 7-day total of $23,034 seen before): compare each corrected coordinator's new total with its own cost figure (f8862ae9 dispatcher, 204dd77f lothsahn's orchestrator, 303d4711 Ben's). If they do not match, restore `spend.json.pre-w1209` (ops worker, portal stopped) and fix `correctHistory` first.
2. After-deploy numbers: w605 (was workers $1,475 / then coordination $1,836) and w979 (was $308), coordination total against the orchestrator's ~$5.8k estimate, the top-20 worker-cost before/after (3 days). Before values are in the w1209 thread (spend_report 3c98743 run of 2026-10-13 ~14:10Z).
3. Findings not yet measured: #4 (closed requests on shared workers) and restart double counts on workers; the three sessions the guard refused.
4. Open question for lothsahn: per-message weighting of the whole-turn even split over the first 4 ids (spend.ts `attribute`); decide from the data in 2.

## Exact next step
Ask lothsahn's orchestrator for: spend_report days 3 and 7 top 20; request views w605, w979, _dispatcher; session views f8862ae9, 204dd77f, 303d4711; and each session's own cost from the session list. Then do 1 before anything else. I have no spend_report or spend.json access.
