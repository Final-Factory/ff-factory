# w553: FFBox facts for a pause/control design (ffbox master 00e84ab, read-only analysis)

1. The release lane has no runner of its own: every self-hosted job, release included, is `runs-on: ffgithubrunners`
   (game repo `.github/workflows/main.yml:141,683`; `rebuild-caches.yml:90,166`); runners are one-job JIT runners with
   labels `Linux,X64,ffgithubrunners` (`runners/lib/config.sh:236`), in group 1 Default (`runners/lib/gh.sh:157-166`).
   A job is known as a release only after a runner took it (`ask-release`, `main.yml:690-717`), and the release waits
   for its run's "Test in" jobs (`release_lane.py:682-687`) on the same label. Stopping CI minting stops releases too.
2. `draining` and the kill switch feed `host_drained` into `ci_lane.keep()` (`ffwatch.py:26807-26809`), which stops
   minting (`ci_lane.py:1389-1395`); the kill switch also holds every outbound Discord message
   (`ffwatch.py:19928-19935`). `quiet_hours` leaves CI alone but is a config edit (drain + restart) and posts "break"
   notices (`ffwatch.py:10925-10927`).
3. The updater, when an update applies, writes `update.drain-owned` unconditionally (`update_ffbox.sh:854`) and then
   `lift_drain` deletes `draining` and `githubrunners/drain` (`:545-562`, called at `:1122`): a drain-file pause would end
   at the next ffbox master merge (code reading; not run).
4. Nothing FF Factory sends is a command; no inbound message carries a signature or user id; the bearer token
   authenticates FFBox to FF Factory (`fffconnector.py:1205`), FF Factory is trusted through TLS to a root-chosen URL.
   Some inbound messages have effects (board verdicts, dev_reply posts, dev_update moves a watched branch, report_fixed).
5. The approved shape for anything from FF Factory: the connector writes `/run/fffconnector/<sub>/<id>.json`, ffwatch
   re-validates it as untrusted (`design/fff_connector_design.txt:282-285, 310-322`); that dir is wiped on connector
   restart (`ffwatch.py:24023-24027`), so state must persist on ffwatch's side. "Never a call from the connector's
   account into ffwatch." New commands from FF Factory are "a new trust boundary and need their own review"
   (`docs/docker-security-model.md:700-702`).
6. The connector runs as `User=fffconnector`, token via `LoadCredential`, feed bound read-only, only AF_INET/AF_INET6,
   listens on nothing (`systemd/fffconnector.service:5,41,43,58,81`); no container mounts its dirs.
7. Holds are files: kill `~/.config/ffbox/discord.disabled`, drain `~/.config/ffbox/draining` (`ffwatch.py:831,836`),
   CI drain `~/.config/ffbox/githubrunners/drain` (`ci_lane.py:299-309`); set by `ffwatch drain|resume` and
   `ffgithubrunners drain|resume`. `schedule()` (the one place ffagent/ffdev/ffdiagnose turns start,
   `ffwatch.py:13292`) returns early on failsafe/kill/drain (`:13151-13172`); `keep_pool` stops staging via
   `pool_hold_reason`. Running work always finishes. There is no existing "pause" switch and no `ffbox hold`.
8. FF Factory sees `capacity.state` in {updating, draining, running} (`ffwatch.py:23660-23665`); any other value fails
   `BOX_STATES` (`fffconnector.py:302,366-367`) and the capacity message is dropped: a new state needs a connector
   change. `capacity.holds` lists kill/failsafe/quiet/subscription holds but not the drain.
9. Release ledger: `~/ffbox-state/builds/<branch>/<version>/release.json` (`release_lane.py:131-165`); landed =
   `uploads[app].state == "done"` plus `setlive` (`:640-700`). Not in FF Factory's feed today.
10. Other ways in: ssh + the CLIs (works today); Discord owner directives by author id (`!branch`, `!conv`, `!lock`,
    `!unlock`, no pause); ffweb has per-operator login but no drain/pause.
