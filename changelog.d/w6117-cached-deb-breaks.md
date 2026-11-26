- **CI's Playwright browser install no longer breaks on a cached package whose Breaks names an older one** (w6117): run
  45851340689 restored 11 cached .debs on runner image ubuntu26/20261122.9, where `dpkg -i` refused libasound2-data
  1.2.15.3-1ubuntu1.2 (it Breaks libasound2t64 << that version, which the image has at ubuntu1.1) and left libasound2t64
  unconfigured; the network fallback's apt-get then refused with "Unmet dependencies" (exit 100) on both tries.
  `scripts/playwright-browsers.sh` now runs a second `dpkg -i` pass (which installs that set offline), shows dpkg's own
  errors instead of its log's last 20 lines, and has `apt-get -f install` repair anything still unconfigured before the
  network install.
