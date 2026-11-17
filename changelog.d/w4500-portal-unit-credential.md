- **The portal unit loses its invalid `SetCredential=fff-vault-key:` line** (w4500): systemd rejects an empty credential
  value, so every daemon-reload logged `fff-portal.service:40: Invalid syntax, ignoring: fff-vault-key:` and the line never
  applied. The vault key still comes from `LoadCredential=fff-vault-key:/etc/fff/vault.key`, as it always did; the guest
  installer makes the key before it installs the unit. `fff-units.test.sh` fails on an empty `SetCredential=`, and
  `lint.sh --units` now fails when `systemd-analyze verify` ignores any unit line (it exited 0 on them). Needs a portal deploy.
