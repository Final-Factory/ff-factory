- **FF Factory no longer sweeps the FFU runners' cargo targets** (w6291). `runnerTargetMode` now defaults to `off`, as
  lothsahn decided on 2026-11-28 ("Drop FF Factory's sweep; the CI's own cap is enough."). ffu's own
  `tools/ci-runners/keep_target.sh` already trims each runner's `target/` at the end of every job. In warn mode this rule
  listed nothing on LothDesktop: CI creates `target/` before cargo does, so it has no `CACHEDIR.TAG`. `warn` and `on`
  still work when set in code.
