- **The portal VM's installer pins its apt signing keys by fingerprint** (w5530, finding 22 of the w5452 security audit).
  `install.sh` downloaded the NodeSource, GitHub CLI and Tailscale repository keys and trusted them as served. Each key now
  goes to a temp file, is checked against the vendor's pinned fingerprint (`verify_key_fprs` in lib.sh; GitHub's two come
  from its docs, NodeSource and Tailscale publish none so theirs were read from the vendor's key URL) and only then written
  to its own keyring (`signed-by=`, as before). A mismatch, an extra key or a non-key aborts with the key found; a keyring
  already on the VM is checked the same way on a rerun. The Claude Code installer line is unchanged. Test:
  `fff-apt-keys.test.sh` (run by lint.sh).
