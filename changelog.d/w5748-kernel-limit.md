- **Linux read fence stays warn-only until Ubuntu's normal kernel reaches 7.1** (w5748, lothsahn's call): no kernel
  upgrade by hand. Below Landlock ABI 9 a fenced run can still reach the Secret Service, keyring and agent sockets, so
  `on` keeps no read rules there; docs/worker-fence.md, "Known limits", says what turning it on still needs.
