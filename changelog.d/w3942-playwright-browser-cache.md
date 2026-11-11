- **CI installs the Playwright browsers and their Ubuntu packages from a cache, with no apt call** (w3942, asked by
  lothsahn): on 2026-11-11 Azure's mirror and archive.ubuntu.com both hung (run 43057579193 on #939), so both 4-minute tries
  of `playwright install --with-deps` failed in Chromium and WebKit before any test ran. `scripts/playwright-browsers.sh`
  now installs the cached browsers and `.debs` (keyed on the runner image, the Playwright version and the browsers) with
  `dpkg -i`, and goes to the network only on a miss, with w1758's two tries. `playwright-cache.yml` fills main's entries
  every day, so pull requests hit them; `scripts/playwright-browsers.test.ts` runs the script against a hung `apt-get`.
