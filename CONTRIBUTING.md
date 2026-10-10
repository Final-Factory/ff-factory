# Contributing

Thanks for looking. This is a tool built for one team's workflow and shared as-is, so please open
an issue before a large change to check it fits.

## Development

```bash
npm ci && npm ci --prefix web
npm run typecheck && npm --prefix web run typecheck
npm --prefix web run build                 # the server serves web/dist
```

A throwaway `config.json` (set `FFSB_CONFIG` to its path) pointing `repo.url` at a local bare repo
and `unity.editorPath` at nothing is enough to run everything except Unity. See the Development
section of the README. Node 23.6 or newer runs the TypeScript directly; there is no build step for
the server.

## Tests

CI runs everything below on every push and pull request to `main`
([.github/workflows/ci.yml](.github/workflows/ci.yml)).

### Unit tests

```bash
npm test                  # node --test server/*.test.ts scripts/*.test.ts
npm run test:coverage     # the same, with a coverage table (node's built-in coverage)
node --test server/guard.test.ts    # one file
```

Tests live next to the code as `*.test.ts` and use `node:test`. A few (`updateSteps`, `republish`,
`elevation`) drive the PowerShell scripts and run only on Windows; CI runs the suite on Linux and
Windows. `server/agentSession.test.ts` shows how to test session behaviour without Claude: it swaps
the Agent SDK's `query()` for the scripted fake in `e2e/fakeAgent.ts` (`setQueryForTesting`).

Tests with a machine (`server/testMachine.ts`, a real daemon with git worktrees) share two rules (w759):

- **A sandbox's git is what the daemon's git look reports**: set it with `TestMachine.gitLook(name, { branch, pr })` and
  wait for the portal to have it. Written straight into the portal's machine record, the daemon's next report of the
  sandbox takes it away again, whenever that comes (on Windows under load, often mid-test).
- **Nothing still runs in a folder that is being deleted.** `TestMachine.stop()` waits for the git the daemon's pool
  started (a `git -C <worktree>` sits in that folder, and Windows refuses to delete a folder a live process is in:
  `EPERM, Permission denied`). `rmSync`'s `maxRetries` does not cover it on Node before 24.21 / 26.8: those retry
  EBUSY, ENOTEMPTY and EPERM but not Windows' access-denied (`std::errc::permission_denied`), and wait 0 ms between tries
  (nodejs/node#64698). CI runs Node 24.21 or later; a Windows PC with an older Node shows the failures CI does not.

Two more rules from flakes (w858, corrected by w906):

- **A test and the code under it read one clock.** `ledgerSweep.test.ts` dated its requests against a fixed NOW and the
  ledger's own rules (`updateProblem`: no reopening a request closed more than 7 days ago) read the wall clock, so two
  tests failed on main from the day NOW was a week old. Pin the code's clock (`o.now = () => new Date(NOW)`) or date
  everything from `Date.now()`. Never write the month or year into an expected string that the code builds from `new Date()`.
  `SKEW_DAYS=30 node --import ./scripts/clock-skew.mjs --test server/<file>.test.ts` runs a file a month ahead.
- **A node process a test starts and then ends by force must not inherit `NODE_V8_COVERAGE`** (`node --test
  --experimental-test-coverage` sets it): its coverage file is left empty and node exits 1 with every test green
  ("coverage file is empty", Windows CI). Set it to `''` (`withoutCoverage()` in `machineDeployWin.test.ts`); a deleted
  one comes back, because node's spawn copies it into any env without the key (w906). A script a test runs ends its
  node too when it cuts the output short: PowerShell's `& node ... | Select-Object -First 1` ends node mid-exit; take
  `(& node ...) | Select-Object -First 1` (w906: the probe's `node -p` was every empty file).

Two from hangs (w906):

- **Never end a process by a stale id.** Windows reuses process ids and never clears a dead parent's id from
  `ParentProcessId`. A walk down a process tree takes a child only when it started no earlier than its parent
  (`Get-FFKillSet` in `server/machineDeployWin.ts`), and a test forgets an id once it has seen that process gone. On a
  GitHub runner, wininit.exe's parent id is free, and a walk that drew it reaches the runner's own processes: the job
  then hangs to its timeout and loses its whole log.
- **A hung unit-test run names itself.** CI runs the tests under `scripts/test-watchdog.ts` with
  `scripts/test-inflight-reporter.ts` and `--test-timeout=300000`: a test that runs 5 min fails by name, and a run past
  its deadline prints the tests still running and the processes under it, then fails its step. Read that before
  re-running a job; a test file listed with no test under it is a process that does not exit (an open handle).

### End-to-end tests (Playwright)

```bash
npx playwright install chromium webkit        # once
npm --prefix web run build                    # the test server serves web/dist
npm run test:e2e                              # all three projects
npm run test:e2e -- --project=mobile-safari e2e/chat.spec.ts   # one project, one file
npx playwright show-report                    # after a run: the HTML report, with traces of failures
```

`e2e/server.ts` starts the real server against a throwaway config and data folder under the system
temp directory, with a fake agent (`e2e/fakeAgent.ts`) in place of Claude: no Unity, no network, no
credentials. The fake answers by tag (`#perm` asks for a permission, `#long`, `#screenshot`, `#slow`,
`#fail`; anything else is echoed). It seeds three sandboxes (`alpha` for tests to use, `gallery` with a
fixed transcript for screenshots, `stuck` with a blocked Unity editor) and the login `tester` /
`e2e-password-123`. Each project (desktop Chromium, Pixel-sized Chrome, iPhone-sized WebKit) gets its
own server on ports 8791-8793, so run nothing else there.

Tests in one project share one server, so they share the owner's orchestrator chat (w866, which went red twice on CI
for it). In a test that reads that chat: find your own lines by the unique tag or the text you quoted, never by position
(`events.slice(before)`) or by a count of every user event; and press a hover-only button (`Reply`, `React`) with the
hover and the click retried together (`press` in `e2e/replies.spec.ts`), because another test's answer scrolls the page
and ends the hover. On a touch project the same button is shown by a tap on the message.

A test that intercepts the page's requests (`page.route`) sets `test.use({ serviceWorkers: 'block' })`: the app registers a
service worker, and WebKit does not route the requests of a page one controls (the route is never hit and the real server
answers; w893, `e2e/composerClears.spec.ts`).

Visual snapshots (`toHaveScreenshot`) are compared only on Linux, where CI renders them; the
baselines are the `*-linux.png` files in `e2e/__screenshots__/`. When you change the UI on purpose,
run the CI workflow by hand with **update snapshots** ticked (Actions → CI → Run workflow), download
the `linux-snapshots` artifact, review the images and commit them. On Windows or macOS set
`E2E_SNAPSHOTS=1` to compare against baselines of your own (those files are gitignored).

### Performance

```bash
npm --prefix web run build
node web/perf/bench.ts                                   # 7,000 stopped agents, an 8,000-event chat, live traffic
node web/perf/bench.ts --route '#/machine/beast/sandbox/agent-mcp'# the chat beside the sandbox holding most past agents
node web/perf/bench.ts --cpu 4 --memory 60               # a 4x slower CPU; the JS heap over an hour
node web/perf/bench.ts --check --live 0                  # the budgets CI holds the page to
```

`web/perf/bench.ts` runs the built page against the mock backend (`web/mock/`) at a real portal's scale
(`web/mock/scale.ts`) in headless Chromium: per key typed, the time to the next frame, React commits and components
rendered, and long tasks; at rest, the main thread's busy share and layouts per second; the heap over time. With
`MOCK_STATE_FILE`, `MOCK_TRANSCRIPT_FILE` and `MOCK_WORK_FILE` it uses a portal's own `state.json`, a transcript
and `work.json` instead of generated ones (strip any secrets first, and never commit them). CI runs `--check`, which
fails on components rendered per key, DOM size, typing p95, long tasks and layouts at rest: counts where possible,
so a slow runner does not fail it.

## Versions and releases

The version lives in `package.json` (web/package.json follows it) and uses semantic versioning. Add
a note for your change in its own file, `changelog.d/<request or topic>.md` (see [changelog.d/README.md](changelog.d/README.md);
never edit [CHANGELOG.md](CHANGELOG.md) for it: two pull requests that both add to **[Unreleased]** conflict, and a conflicted
pull request gets no CI). To release:

```bash
npm run release -- minor --dry-run   # patch | minor | major | X.Y.Z: shows the notes
npm run release -- minor             # bumps, cuts the changelog, commits "Release vX.Y.Z", tags it
```

Then push the commit and the tag (the script prints the command).

## Guidelines

- Keep changes focused, with a test for new server behaviour (`server/*.test.ts`) and an E2E test for
  a new UI flow.
- **Commit with your GitHub noreply address** (`<id>+<login>@users.noreply.github.com`, from GitHub
  Settings → Emails): the history is public, and CI fails any commit whose author or committer email
  is not a noreply address. Set it with `git config user.email` in your clone.
- Never commit `config.json`, `data/`, real hostnames, usernames, tokens or paths from your
  machine. Use neutral examples (`C:/path/to/...`, `<host>.<tailnet>.ts.net`). CI runs gitleaks.
- Anything that widens what agents may do (guard rules, tool groups, permissions) needs a clear
  reason in the pull request.

- **A new `fffctl` command or form: allow its read-only parts to the ops worker, in the same pull request**
  (Lothsahn, 2026-10-09, w745: "anytime a new fffctl command is provided, all read only parts of it should be allowed by
  the orchestrator worker"). Add it to `FFFCTL_FORMS` in `server/opsWorker.ts` (allowed when it changes nothing and prints
  no secret, otherwise `changes`) and to `deploy/vm/guest/fff-ops-priv` with its exact arguments pinned, with cases in
  `deploy/vm/test/fff-ops.test.sh` and `server/opsWorker.test.ts`. `server/opsFffctlForms.test.ts` fails until you have.
  How to tell the two apart: docs/ops-worker.md, "A new fffctl command".

By contributing you agree that your contributions are licensed under the MIT License
([LICENSE](LICENSE)).
