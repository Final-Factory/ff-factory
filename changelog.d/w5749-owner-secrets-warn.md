- Owner secrets, warn stage (w5749): on macOS and Linux the read fence's probe now names the owner secrets it does not
  close yet (`~/.netrc`, git's stored credentials, gh's other config folders, Linux flatpak and snap browsers) that exist on
  the machine. Nothing new is refused; a separate enforce PR closes them. docs/worker-fence.md records why no env or
  wrapper route closes the gh login, `~/.ssh` or the browsers on Windows.
