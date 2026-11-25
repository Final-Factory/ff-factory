#!/usr/bin/env bash
# install.sh's check of a kept config's "host" (w5538, docs/portal-bind-address.md): lib.sh's config_host_state says "set"
# for a config that names host (any value), "missing" for valid JSON without one (the only case where the portal falls back
# to 127.0.0.1), and "unreadable: ..." for no file, broken JSON, a non-object or no jq, so a jq failure is never reported
# as a missing host. Also checks install.sh calls it and warns differently on the two cases. No root, no network.
# shellcheck disable=SC2016 # the grep patterns name install.sh's own $variables literally
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
G=deploy/vm/guest
fail() { echo "FAIL: $*"; exit 1; }
command -v jq >/dev/null || { echo "SKIP: no jq"; exit 0; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# shellcheck source=../guest/lib.sh
. "$G/lib.sh"

expect() { # FILE WANT
  local got
  got=$(config_host_state "$1")
  [ "$got" = "$2" ] || fail "$1: got '$got', want '$2'"
}

printf '{"host": "0.0.0.0", "port": 8790}\n' >"$tmp/set.json"
printf '{"host": "127.0.0.1"}\n' >"$tmp/loop.json"
printf '{"port": 8790}\n' >"$tmp/missing.json"
printf '{"port": 8790,\n' >"$tmp/broken.json"
printf '[1, 2]\n' >"$tmp/array.json"

expect "$tmp/set.json" set
expect "$tmp/loop.json" set
expect "$tmp/missing.json" missing
expect "$tmp/broken.json" 'unreadable: not valid JSON'
expect "$tmp/array.json" 'unreadable: not an object'
expect "$tmp/none.json" 'unreadable: no readable file'
# No jq on PATH: a PATH holding only the shell tools the function itself needs.
mkdir "$tmp/bin"
got=$(PATH=$tmp/bin config_host_state "$tmp/set.json")
[ "$got" = 'unreadable: jq is not installed' ] || fail "no jq: got '$got'"

grep -q 'config_host_state "$FFF_ROOT/config/config.json"' "$G/install.sh" || fail "install.sh does not call config_host_state"
grep -q 'could not check \\"host\\"' "$G/install.sh" || fail "install.sh has no separate warning for an unreadable config"
echo "fff-config-host: ok"
