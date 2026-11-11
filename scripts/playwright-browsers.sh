#!/usr/bin/env bash
# CI's browser install (ci.yml's e2e job and playwright-cache.yml, w3942): this job's Playwright browsers and the Ubuntu
# packages they need, from the cache when it has them, so the common path makes no apt call at all.
#
# The Ubuntu archive hangs often enough to fail jobs: 3 WebKit jobs on 2026-10-22 sat in apt-get until the job's
# 20-minute limit (w1758), and on 2026-11-11 (run 43057579193, w3939's PR #939) both Azure's mirror and archive.ubuntu.com
# hung, so both 4-minute tries failed in Chromium and in WebKit. A retry on another mirror cannot fix a hung archive; not
# asking it can. The cache (keyed on the runner image, the Playwright version and the browsers, in ci.yml) holds
# ~/.cache/ms-playwright and the .debs apt fetched for them on that same image, which `dpkg -i` installs offline.
#
# HIT=true: install the cached .debs with dpkg and check the browsers with `playwright install` (both offline). If either
# fails, fall through to the network path below. HIT anything else: the network path, `playwright install --with-deps`,
# in tries of TRY_SECONDS; a try cut off has its apt-get ended (it holds dpkg's lock) and the second goes to kernel.org's
# Ubuntu mirror, then Ubuntu's own archive (the runner's mirror list). On 2026-11-11 the runners reached neither Azure's
# mirror nor archive.ubuntu.com for 20 minutes and more (runs 43057579193 and 43060498565: each file "Ign" after 20 s)
# while both answered from elsewhere, so a miss needs a mirror on other hosts to fill the cache at all. After a network install
# the fetched .debs are kept in DEBS and `save=true` goes to GITHUB_OUTPUT, so the job saves the cache.
#
# Env: BROWSERS (e.g. "chromium" or "chromium webkit"), HIT (the cache restore's cache-hit).
# Overridable for scripts/playwright-browsers.test.ts: TRY_SECONDS, DEBS, APT_ARCHIVES, APT_CONF, APT_MIRRORS.
set -uo pipefail

: "${BROWSERS:?BROWSERS names the browsers to install}"
HIT=${HIT:-false}
TRY_SECONDS=${TRY_SECONDS:-240}
DEBS=${DEBS:-$HOME/.cache/playwright-debs}
APT_ARCHIVES=${APT_ARCHIVES:-/var/cache/apt/archives}
APT_CONF=${APT_CONF:-/etc/apt/apt.conf.d/99-ff-keep-debs}
APT_MIRRORS=${APT_MIRRORS:-/etc/apt/apt-mirrors.txt}
FALLBACK_MIRROR=http://mirrors.edge.kernel.org/ubuntu/
OUT=${GITHUB_OUTPUT:-/dev/null}

# `playwright-browsers.sh key`: the cache key and the browsers, as GITHUB_OUTPUT lines. ImageOS and ImageVersion are GitHub's
# own variables on its runners; without them (not a GitHub runner) the key matches nothing and nothing is saved.
if [ "${1:-}" = key ]; then
  pw=$(node -p "require('./package-lock.json').packages['node_modules/@playwright/test'].version")
  echo "key=playwright-v1-${ImageOS:-none}-${ImageVersion:-none}-${pw}-${BROWSERS// /-}"
  echo "browsers=$BROWSERS"
  exit 0
fi

if [ "$HIT" = true ]; then
  ok=true
  shopt -s nullglob
  debs=("$DEBS"/*.deb)
  shopt -u nullglob
  if [ ${#debs[@]} -gt 0 ]; then
    echo "Installing ${#debs[@]} cached packages with dpkg (no apt, no network)."
    timeout 300 sudo dpkg -i "${debs[@]}" >"$DEBS.log" 2>&1 || ok=false
  fi
  # Every package Playwright would ask apt for is now installed (its --dry-run only prints the apt command).
  if $ok; then
    missing=$(timeout 60 npx playwright install-deps --dry-run $BROWSERS 2>/dev/null | grep -o 'no-install-recommends[^"&;]*' |
      head -1 | cut -d' ' -f2- | tr ' ' '\n' | while read -r p; do
        [ -z "$p" ] || dpkg-query -W -f='${Status}\n' "$p" 2>/dev/null | grep -q 'ok installed' || echo "$p"
      done)
    if [ -n "$missing" ]; then echo "Not installed after the cached packages: $(echo $missing)"; ok=false; fi
  fi
  # `playwright install` without --with-deps downloads nothing when the cached browsers are there.
  if $ok && timeout 120 npx playwright install $BROWSERS; then
    echo "::notice::$BROWSERS and ${#debs[@]} system packages came from the cache: no apt call."
    exit 0
  fi
  echo "::warning::The cached browsers or packages did not install; installing from the network instead."
  tail -20 "$DEBS.log" 2>/dev/null || true
  sudo dpkg --configure -a || true
fi

# Keep what apt fetches: an empty archive now holds exactly this install's .debs afterwards.
sudo find "$APT_ARCHIVES" -maxdepth 1 -name '*.deb' -delete 2>/dev/null || true
echo 'APT::Keep-Downloaded-Packages "true";' | sudo tee "$APT_CONF" >/dev/null || true

for try in 1 2; do
  if timeout "$TRY_SECONDS" npx playwright install --with-deps $BROWSERS; then
    mkdir -p "$DEBS"
    find "$APT_ARCHIVES" -maxdepth 1 -name '*.deb' -exec cp {} "$DEBS"/ \;
    echo "Kept $(find "$DEBS" -maxdepth 1 -name '*.deb' | wc -l) packages for the cache."
    [ -z "${ImageVersion:-}" ] || echo "save=true" >> "$OUT"
    exit 0
  fi
  echo "::warning::The browser install (try $try) did not finish in $TRY_SECONDS seconds: the Ubuntu mirror is slow or hung."
  sudo pkill -x apt-get || true
  for _ in $(seq 30); do sudo fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock >/dev/null 2>&1 || break; sleep 2; done
  sudo dpkg --configure -a || true
  # kernel.org's mirror first, off Canonical's and Azure's hosts, then Ubuntu's own archive: apt moves to the next mirror
  # in this list when a file fails on one.
  printf '%s\n' "$FALLBACK_MIRROR" http://archive.ubuntu.com/ubuntu/ | sudo tee "$APT_MIRRORS" >/dev/null || true
done
exit 1
