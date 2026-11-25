- **A machine whose update download was cut gets it again by itself** (w5593). Over a slow or relayed link a daemon can give up
  on its update's bundle at its 480 s limit (BEAST on 2026-11-25 08:20Z: 47% of 29 MB at 35 KB/s). Nothing on the machine
  changed, but the update then waited for the next portal deploy. Now the rollout sends the update (and its agent tools run)
  again 5 minutes after it failed, while the machine is online, at most 3 times per rollout.
