- Owner secrets, enforce (w5749): on macOS and Linux the read fence's owner rules now also close `~/.netrc`, git's stored
  credentials, gh's other config folders and Linux flatpak and snap browsers. They act only with the read fence `on`; in
  `warn` the probe lists them among what `on` would close. Windows is unchanged (a person's decision).
