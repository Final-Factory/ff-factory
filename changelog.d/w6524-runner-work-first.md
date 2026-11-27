- **A low clean-up lists idle FFU runners' job folders even while a long pass runs** (w6524, warn-only). On LothDesktop
  on 2026-11-27, V: fell to 6 GB free while an hourly pass ran for 45+ minutes. The ffu slots' first step, which runs on
  its own then, planned nothing four times, and a runner's 13.8 GB `_work\ffu` waited. With the disk low, that step now
  also judges idle runners' settled job folders by the rule the full pass uses (`ffu-runner-work`). New `runnerFirstMode`
  in `installLeftovers`: `warn` (the default) lists them and logs `runner job folder(s) listed, none removed`; `on` plans
  them; `off` restores the old step. The switch to on comes in a separate PR. Tests: `w6524RunnerWorkFirst.test.ts`.
