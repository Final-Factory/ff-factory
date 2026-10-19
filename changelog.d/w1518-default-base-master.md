- **The portal's config.json now names `origin/master` as its base** (w1518; lothsahn: "Yes, set defaultBase to
  origin/master now"). On its first start after this deploy, the portal turns a `defaultBase` that names the retired
  `develop` into the trunk in config.json itself (`origin/develop` → `origin/master`), in the same write that takes out
  retired keys (`pruneRetiredConfig`, was `pruneRetiredKeys`), and keeps the file as it was as config.json.prev. So
  the w1517 startup line goes away, and the base clone /srv/fff/base stops going back to develop's last commit every
  15 minutes. A dry run's config is left as it is. Any other base stays as the person set it.
