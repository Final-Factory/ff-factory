- **A pick between designs shows every design's own stills, in the card only** (w2664). Ben, 2026-10-31: "you didnt show
  me previews for C and D and you didnt give me the multiple choice options like you usually do", then "you did the
  multiple choice thing above which was correct, then immediately showed all the previews again in yoru next message for
  seemingly no reason". `ask_person`, `waiting_on_person` and `decide_work` ask now refuse a pick between designs while any
  design option lacks a still of its own (a still in the question stands for none, and `no_previews` cannot excuse it),
  and refuse more than 4 stills in a question or an option instead of dropping the rest silently. The ask_person result
  warns when the message before the card showed the card's stills too, and a message after the card that shows them again
  is told on the next result. A card's stills load eagerly, and a still on screen 4 s that the browser never requested is
  asked for again.
