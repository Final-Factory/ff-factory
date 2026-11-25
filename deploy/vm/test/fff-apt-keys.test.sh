#!/usr/bin/env bash
# The portal VM's apt signing keys are trusted by fingerprint only (w5530, security audit finding 22): lib.sh's
# verify_key_fprs, which install.sh runs on every key it downloads (and on a keyring already there), against throwaway keys.
# What it checks: the pinned fingerprint passes (armored, binary, a keyring of two keys with both pinned); a WRONG
# fingerprint aborts and names the key found; a keyring with one key not on the list aborts; a file with no key and a
# missing file abort; and install.sh pins all three vendors' fingerprints and still has the Claude installer line untouched.
# Needs gpg; no root, no network.
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
G=deploy/vm/guest
fail() { echo "FAIL: $*"; exit 1; }
command -v gpg >/dev/null || { echo "SKIP: no gpg"; exit 0; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export GNUPGHOME=$tmp/gnupg
mkdir "$GNUPGHOME" && chmod 700 "$GNUPGHOME" 2>/dev/null || true
# shellcheck source=../guest/lib.sh
. "$G/lib.sh"

mk() { # NAME: a throwaway key, its fingerprint in $tmp/NAME.fpr, binary and armored public parts
  gpg --batch --quiet --passphrase '' --quick-generate-key "$1 <$1@example.invalid>" rsa2048 sign never 2>/dev/null
  gpg --batch --list-keys --with-colons "$1@example.invalid" | awk -F: '$1 == "fpr" { print $10; exit }' >"$tmp/$1.fpr"
  gpg --batch --export "$1@example.invalid" >"$tmp/$1.gpg"
  gpg --batch --export --armor "$1@example.invalid" >"$tmp/$1.asc"
}
mk vendor
mk other
v=$(cat "$tmp/vendor.fpr")
o=$(cat "$tmp/other.fpr")
[ "${#v}" = 40 ] && [ "$v" != "$o" ] || fail "fixture keys: $v $o"
cat "$tmp/vendor.gpg" "$tmp/other.gpg" >"$tmp/both.gpg"

# ok VERB FILE FPR...: runs verify_key_fprs in a subshell (die exits) and returns its status; its log goes to $tmp/out
run() { (verify_key_fprs "$@") >"$tmp/out" 2>&1; }

run "$tmp/vendor.gpg" "$v" || fail "the pinned fingerprint was refused (binary)"
run "$tmp/vendor.asc" "$v" || fail "the pinned fingerprint was refused (armored)"
run "$tmp/both.gpg" "$o" "$v" || fail "a two-key keyring with both keys pinned was refused"
run "$tmp/vendor.gpg" 0000000000000000000000000000000000000000 "$v" || fail "one of several pinned fingerprints was refused"

if run "$tmp/vendor.gpg" "$o"; then fail "a WRONG fingerprint was accepted"; fi
matches "apt key check FAILED" "$tmp/out" || fail "the wrong-fingerprint failure is not loud: $(cat "$tmp/out")"
matches "$v" "$tmp/out" || fail "the failure does not name the key found"
if run "$tmp/both.gpg" "$v"; then fail "a keyring with an unpinned extra key was accepted"; fi
printf 'not a key\n' >"$tmp/junk"
if run "$tmp/junk" "$v"; then fail "a file with no key was accepted"; fi
matches "no readable OpenPGP key" "$tmp/out" || fail "no-key message missing: $(cat "$tmp/out")"
if run "$tmp/missing.gpg" "$v"; then fail "a missing file was accepted"; fi
# a key whose uid claims to be the vendor's, but another fingerprint, is refused: the pin is the fingerprint, not the name
if run "$tmp/other.gpg" "$v"; then fail "a look-alike key was accepted"; fi

# install.sh: every apt key goes through key(), which pins; the three real fingerprints are the ones checked; the Claude
# installer line is exactly as it was.
for fpr in 6F71F525282841EEDAF851B42F59B5F99B1BE0B4 2596A99EAAB33821893C0A79458CA832957F5868 \
  2C6106201985B60E6C7AC87323F3D4EA75716059 7F38BBB59D064DBCB3D84D725612B36462313325; do
  matches -F "$fpr" "$G/install.sh" || fail "install.sh does not pin $fpr"
done
n=$(grep -c '^key ' "$G/install.sh" || true)
[ "$n" = 3 ] || fail "expected 3 key lines in install.sh, found $n"
if grep '^key ' "$G/install.sh" | matches -v '"\$FPR_\|"\${FPR_'; then fail "a key line in install.sh has no pinned fingerprint"; fi
matches -F "as_fff bash -c 'cd ~ && curl -fsSL https://claude.ai/install.sh | bash'" "$G/install.sh" || fail "the Claude installer line changed"
echo "fff-apt-keys: ok"
