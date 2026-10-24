- **A request is not closed because its worker's process ended while it still had work pending** (w1972, lothsahn: "Please fix the
  closing job so it doesn't close out jobs with errors. Those should be resumed to fix the error or escalated to an operator if the error
  can't be fixed"). A daemon update's drop marked w1945's and w1946's idle workers stopped (one with a check-in pending, one waiting on
  lothsahn), and the ops worker's DONE for its deploy job then closed both; w1962 the same. A stopped worker with a check-in, a wait on a
  person, a gate, a question, a still-open last report, or a stop its machine going offline made now stays on its request, and the ops
  worker's DONE alone never closes one when its own worker ends (docs/orchestrators.md, "An ended worker with work pending is still on it").
