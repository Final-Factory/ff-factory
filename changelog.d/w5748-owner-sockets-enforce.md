- **Linux read fence `on` now waits until no fenced run can reach the owner's secrets over a socket** (w5748). A run in
  `on` mode also denies the session bus (the Secret Service, where a desktop Linux gh login is kept), GNOME keyring's
  sockets and the ssh and gpg agents (`--deny-unix`, Landlock ABI 9, Linux 7.1). Read rules take effect only once the
  probe finds every one refused. While one answers, `on` logs why and runs start without read rules (a warn, never a
  lockout), so a kernel below 7.1 is never enforced. `read-fence-off` takes it all off live.
