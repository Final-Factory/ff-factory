- **The ops worker runs git and GitHub jobs over ssh on a signed-in machine, by itself** (w1869; lothsahn: "Analyze your
  recent tool failures and make it so they don't happen in the future"). Deleting w1788's three branches first failed on
  "no git here" in the VM until a follow-up named m3's gh login. Its brief now gives the route (m3 first, else beast; the
  PATH a Mac's ssh shell needs; a branch delete with `gh api` and a `git ls-remote` check), the guard's refusal of `git`
  and `gh` in the VM repeats it, and docs/ops-worker.md has "Git and GitHub jobs". Test: `server/opsWorker.test.ts`.
