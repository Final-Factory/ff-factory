- **The coordinators carry half as much in every call** (w1158, lothsahn: "1) Do it"). The dispatcher's first call went
  from 48,176 to 23,277 input tokens, Lothsahn's and Ben's orchestrators' from about 37,700 to 22,600 (measured on the
  API). Only their everyday tools are sent in full; the rest load with `ToolSearch` when needed. Rules most turns do not
  need moved to `read_rules <topic>` (`ffbox`, `intake`, `release`, `machines`, `reactions`), each still named in the brief
  with its gist and w-number, and the briefs lost their duplication. Docs: orchestrators.md, "What a coordinator's
  context costs". Tests: `coordinatorContext.test.ts` (a size budget, every topic named, every moved rule kept).
