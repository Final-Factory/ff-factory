- **A finished design's go to build is asked on a card** (w4739, r290 fix 5; lothsahn: "File all six fixes from r290 at high
  now"). r290 measured 9 d 1 h between the finished multi-select design (r87, w3031) and the go to build it, offered in chat
  ("say 'file the w3031 implementation'") with no card. Now, when a request whose result is a design report closes on its
  DONE, its people's orchestrators get a `[design closed]` message: ask the go with ask_person, "File the build of <design>
  now?", "Yes, file the build now" recommended, and on yes file the build with the design in its related ids. A design
  whose report still lists open questions (its `## Open questions` section, read on every revision) has those asked first.
  No card when a request already names the design (its build is filed). Workers are told to end a design report with an
  `## Open questions` section and to ask all of a design's open questions together on one waiting_on_person card. Needs a
  portal deploy. Tests: `server/designGo.test.ts`, `server/orchestrators.test.ts` ("w4739: the w3031 replay").
