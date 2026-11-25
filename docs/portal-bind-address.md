# The portal's bind address (`host`)

`config.json`'s `host` is the address the portal listens on (`server.listen(cfg.port, cfg.host)`, server/index.ts).
**The default is `127.0.0.1`** (w5538, finding 30 of the w5452 security audit; lothsahn: "default the bind address to
127.0.0.1"). Until then it was `0.0.0.0`, which served the dashboard, with the password, over plain HTTP to the whole LAN of a
portal run on a PC.

## Who reaches the portal, and how

| Who | How | Needs |
|---|---|---|
| People, the machines' daemons, FFBox's connector | `https://<name>.<tailnet>.ts.net`: Tailscale serve (tailnet) and Funnel (public) terminate TLS and proxy to `http://127.0.0.1:8790` (`fffctl tailscale-join`, docs/portal-on-ffbox-host.md). The connector dials out to `wss://<public URL>/provider` (docs/ffbox-connector-contract.md). | loopback |
| The portal host's own machine daemon (`local`) | `http://127.0.0.1:8790` (server/machines.ts) | loopback |
| The VM host's health check and `fff-vm status` | `http://<VM bridge IP>:8790/api/health` (deploy/vm/host/fff-vm); the VM's firewall admits only that one source address to 22 and 8790 (deploy/vm/guest/install.sh, `host_rule`) | **not loopback** |

A machine joined from a browser on the LAN gets that page's origin as its portal URL (server/index.ts, `originOf`), so on a PC
whose config has no `host`, such a machine reaches the portal only through the tailnet name: join it from that name.

The portal warns at every start when its config has no `host` (`hostDefaultWarning`, server/config.ts; logged beside `listen` in server/index.ts, never by a CLI).

So a portal on a PC (README "Setup") needs nothing set: `127.0.0.1`, published by `tailscale funnel --bg 8790`.

## The portal VM

The VM's `config.json` carries `"host": "0.0.0.0"` explicitly: the host's health check connects to the VM's own address, which
a loopback listener would refuse: `portal_healthy` (deploy/vm/host/lib.sh) would fail, and after `PORTAL_DOWN_RESET_MIN` (60 min)
`fff-vm` resets the VM, at most 3 times in 6 h. People would still reach it (Funnel proxies to 127.0.0.1), and a person can
recover over the tailnet with ssh (port 22): set `host`, or `fff-update rollback`.
The VM's own firewall (table `inet fff_guest`) is what keeps the port off everything but that host; the tailnet reaches only 443
and 22. `install.sh` writes the VM's config from `deploy/vm/guest/config.vm.example.json`, which sets `host` explicitly, and on a
rerun, where it keeps an existing config, it warns when that config has no `host` (such a config silently moved from
`0.0.0.0` to `127.0.0.1` with this change). The live VM's config was not changed; `host` is a config.json key that `fffctl conf` does not set.

`scripts/instance/new.ts` (a second portal instance on a dev PC) still writes `"host": "0.0.0.0"` explicitly, as before.

Tests: `server/config.test.ts` (loopback with no host, an explicit host honoured, the template values).
