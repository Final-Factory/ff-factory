- **Orchestrators may file 20 times between two of their person's messages, and a person's own timers may go further**
  (w1867, lothsahn: "Let's increase orchestrator actions between turns to 20 from 3." and "Let your timers go past the
  cap, with a limit of 100. Not a daily limit. If you hit the 100 limit, file a bug to investigate why."). The filings
  limit (`orchestrator.filingsPerMessage`) defaults to 20 for every orchestrator, up from 3; follow-ups stay at 3. A turn a
  person's own timer started has that person's limit in the new `orchestrator.timerFilingsPerMessage` (`{ "lothsahn": 100 }`,
  an owner's setting, 1 to 100; a person not named has the filings limit there too), counted with every other filing
  since the person last wrote. Person turns, dispatches and worker reports keep the filings limit. At 100 filings in one
  turn, or since the person last wrote, in any turn of any person's orchestrator, FF Factory files an investigation bug
  for that person on Final-Factory/ff-factory by itself, once per hit and against no limit, and the orchestrator's tool
  result names it. Docs: orchestrators.md ("Timers", "Loops, limits and safety"). Tests: `orchestrators.test.ts` (w1867),
  `appConfig.test.ts`.
