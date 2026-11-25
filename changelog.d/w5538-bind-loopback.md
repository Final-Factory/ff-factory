- **The portal's bind address now defaults to 127.0.0.1** (w5538, finding 30 of the w5452 security audit). `config.json`'s
  `host` defaulted to `0.0.0.0`, so a portal run on a PC served the dashboard, password included, over plain HTTP to its LAN.
  Tailscale serve and Funnel, the machines and FFBox's connector all reach the portal through `127.0.0.1` or the public URL, so
  loopback is enough. The portal VM keeps `"host": "0.0.0.0"` (its host's health check calls the VM's address; the VM's
  firewall limits who reaches it): its config template sets it explicitly, the live config is untouched, and `install.sh` warns
  about a kept config with no `host`. `config.example.json` is loopback. Docs: portal-bind-address.md. Tests: config.test.ts.
