# Recorded command output for the path watch tests

`deploy/vm/test/fff-vm-path.test.sh` feeds `fff-vm watch`'s path checks (`deploy/vm/host/pathwatch.sh`) the output of the
commands it runs. `healthy/` holds a full set; every other folder holds only the files that differ in that scenario
(`ts-health-warning/ts-status.json`, `fw-broad/nft-input.txt`, ...). Where each came from, stated plainly, because none of
it was recorded on the live portal VM (w681 had no access to it):

| Files | Command | Provenance |
|---|---|---|
| `*/ts-status.json` | `tailscale status --json` | **Recorded** on BEAST (tailscale 1.102.2, the same tailnet), then rewritten: `Self` became the portal VM (name `fff`, tag `tag:fff-portal`, `funnel`/`https` in `CapMap`, addresses 100.64.0.5 and fd7a:115c:a1e0::5a34:ac62), four `funnel-ingress-node` (`tag:ingress`) and two member peers kept in BEAST's real field structure with keys, ids, names and addresses replaced. Handshake times are `@AGO:<seconds>@` placeholders the fake `tailscale` turns into a time that many seconds ago. The failing variants (health warning, Stopped, NeedsLogin, untagged, no `funnel` capability, silent or stale Funnel servers, none) change those fields; **edited by hand**. |
| `*/ts-serve.json` | `tailscale serve status --json` | **Recorded** on BEAST, where the same route (`/` to `http://127.0.0.1:8790`, `AllowFunnel`) is live; the name replaced. The failing variants (no route `{}`, no `AllowFunnel`, another target port) are **edited** copies. |
| `healthy/nft-input.txt`, `fw-pre-w681/`, `fw-broad/`, `fw-temp/`, `fw-no22/` | `nft list chain inet fff_guest input` | **Recorded** with nft 1.0.9 in a throwaway network namespace (`unshare -rn`), loading the guest firewall exactly as `install.sh` renders it: `healthy` is the w683 ruleset (22 and 443 counted, the rest dropped and counted), `fw-pre-w681` the one before w681 (22 and 443), `fw-broad` the any-port rule w681 first shipped, `fw-temp` the pre-w681 rules plus `nft add rule inet fff_guest input iifname "tailscale0" tcp dport { 59343, 59917 } accept` (the temporary fix that was in place), `fw-no22` the w683 rules without 22. |
| `healthy/ss.txt` | `ss -ltnpH` | **Recorded** with `ss` from iproute2 in the same namespace, with listeners shaped like the VM's: processes named `tailscaled` on 100.64.0.5 and fd7a:115c:a1e0::5a34:ac62 (ports 443, 59917, 59343: the ports of the 2026-10-07 diagnosis; the processes are stand-ins), `sshd` on 0.0.0.0:22 and [::]:22, `node` on 0.0.0.0:8790. |
| `*/checkend.txt` | `openssl x509 -noout -checkend 432000` | **Recorded**: a certificate valid for 80 days, and one for 3 days. |
| `cert-handshake/selftest.out` | curl's TLS error | Text of curl's `(35)` message; **not recorded** from a Tailscale certificate. |
| `cert-expired/selftest.out` | curl's expired-certificate error | Text of curl's `(60)` message and its trailer, as curl prints them (the trailer is real, recorded with a wrong-host certificate); the first line is **written by hand** for "certificate has expired". |
| `cert-ratelimited/cert.out` | `tailscale cert` failing | The Let's Encrypt rate-limit sentence is from Let's Encrypt's documented error ("too many certificates (5) already issued for this exact set of identifiers in the last 168h0m0s, retry after ... UTC: see https://letsencrypt.org/docs/rate-limits/"); the date is 2099 so the test never expires, and the wrapper text is **written by hand**; what `tailscale cert` really prints for it is not recorded. |
| `healthy/journal.txt`, `policy-*/journal.txt` | `journalctl -u tailscaled --since -15min` | The `Drop: TCP{... > [fd7a:115c:a1e0::5a34:ac62]:59343} 80 no rules matched` shape is quoted from the diagnosis of 2026-10-07; the other lines and the addresses are **written by hand** (the addresses are the fixture peers'). |
| `ts-down/ts-status.fail` | `tailscale status` with tailscaled stopped | The CLI's message from memory of its source; **not recorded**. |
| `healthy/df.txt`, `disk-*/df.txt` | `df -Pm / /srv/fff` | Format **recorded** (`df -Pm`); sizes **edited**. |
| `healthy/getent.txt` | `getent ahosts <name>` | Format real; the addresses are documentation addresses (203.0.113.0/24, 2001:db8::/32). |
| `healthy/portal-show.txt`, `portal-loop/` | `systemctl show fff-portal.service -p NRestarts -p ActiveState -p Result` | Property names are systemd's; the values are **written by hand**. |
| `healthy/selftest.out`, `healthy/e2e.out` | the portal's `/api/health` | `{"ok":true,...}` as `server/index.ts` answers; the version and build values are made up. |
| `ntfy-down/`, `healthy/ntfy-health.out` | `GET /v1/health` of an ntfy server | `{"healthy":true}` is ntfy's documented answer; the failure is curl's `(6)` text. |
| `status-file.healthy.json`, `status-file.policy.json` | what the watch hands the portal | **Generated** by the test itself (`UPDATE_FIXTURES=1` rewrites them) with the times replaced by 2026-10-07T18:30:00Z and the host name by `ffbox`; `server/pathHealth.test.ts` parses the same files, so the shell and the portal agree on the format. |

What running on the VM can still show: the exact wording of `tailscale cert`'s ACME errors, of a stopped tailscaled, and
whether tailscaled's journal carries the `Drop:` lines by default (the diagnosis says it did on 2026-10-07). Replace a
fixture with the real thing when you have it.
