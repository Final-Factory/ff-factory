- **`fffctl migrate --cut-over` refuses a move that would lock every daemon out** (w5716, item 4 of w5707's review of
  w5575). On the config the new portal will start on, under `machineLinkTailnet` enforce (unset included), it goes on
  only behind Tailscale Serve (with `trustProxy` on) or to a `publicUrl` whose host is a Tailscale address. Otherwise it
  stops with exit code 4 before the typed confirmation, touching nothing, and says to set `"warn"` first.
