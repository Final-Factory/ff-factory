#!/usr/bin/env bash
# `fffctl disk-usage` (w2267; lothsahn: "What's taking up so much disk space on fff-portal?"), against a fixture /srv/fff and
# /var/log; no root and no VM: run by lint.sh. What it checks:
#   the sections are there: the du at depth 3, data/'s children with their files' count and dates, each release with its
#   node_modules and the CURRENT and PREVIOUS marks, the portal account's .claude, the big files, the logs;
#   auth.log's and syslog's lines (plain and .gz rotations) are counted per day by the program that wrote them, with the
#   PAM sessions by service and sudo by who ran it and the command's path;
#   it prints no file's text: secrets in a transcript, a Claude Code transcript, a log line and a sudo command's
#   arguments never show;
#   it writes nothing (the fixture tree is the same before and after) and takes no option.
set -o errexit -o nounset -o pipefail
cd "$(dirname "$0")/../../.."
G=deploy/vm/guest
fail() { echo "FAIL: $*"; exit 1; }
matches() { grep "$@" >/dev/null; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

oat="sk-ant-oat01-$(printf 'A%.0s' {1..60})"
ghp="ghp_$(printf 'b%.0s' {1..36})"
root=$tmp/srv/fff
mkdir -p "$root/data/transcripts" "$root/data/attachments" "$root/app/releases/r1/node_modules/x" "$root/app/releases/r2/web/node_modules/y" \
  "$root/app/repo.git" "$root/home/.claude/projects/-srv-fff-a" "$root/agents/w1" "$tmp/log"
echo "{\"text\": \"$oat\"}" >"$root/data/transcripts/a.jsonl"
echo "token $ghp" >"$root/home/.claude/projects/-srv-fff-a/s.jsonl"
head -c 300000 /dev/zero >"$root/app/releases/r1/node_modules/x/big.bin"
head -c 100000 /dev/zero >"$root/app/releases/r2/web/node_modules/y/big.bin"
touch -d '2026-09-01 12:00' "$root/data/attachments/old.zip"
touch -d '2026-10-20 12:00' "$root/data/attachments/new.zip"
touch -d '2026-10-01 00:00' "$root/app/releases/r1"
touch -d '2026-10-02 00:00' "$root/app/releases/r2"
ln -s "$root/app/releases/r2" "$root/app/current"
ln -s "$root/app/releases/r1" "$root/app/previous"
{
  for i in 1 2 3; do echo "2026-10-12T05:0$i:00.000000+00:00 fff-portal sudo:  fff-ops : PWD=/srv/fff-ops ; USER=root ; COMMAND=/usr/local/lib/fff/fff-ops-priv vault add --value $oat"; done
  for i in 1 2 3 4 5; do
    echo "2026-10-12T06:0$i:00.000000+00:00 fff-portal runuser: pam_unix(runuser:session): session opened for user fff(uid=999) by (uid=0)"
    echo "2026-10-12T06:0$i:01.000000+00:00 fff-portal runuser: pam_unix(runuser:session): session closed for user fff"
  done
  echo "2026-10-13T07:00:00.000000+00:00 fff-portal sshd[123]: Accepted publickey for fffadmin from 100.64.0.1 port 5 ssh2: $ghp"
} >"$tmp/log/auth.log"
echo "2026-10-05T01:00:00.000000+00:00 fff-portal CRON[9]: pam_unix(cron:session): session opened for user root(uid=0) by (uid=0)" | gzip >"$tmp/log/auth.log.2.gz"
printf '%s\n' "2026-10-12T05:00:00.000000+00:00 fff-portal node[77]: $oat" "2026-10-12T05:00:01.000000+00:00 fff-portal node[77]: hello" \
  "Oct 13 05:00:02 fff-portal systemd[1]: Started x." >"$tmp/log/syslog"
cat >"$tmp/fff.conf" <<EOF
FFF_ROOT=$root
FFF_USER=fff-no-such-user-w2267
RELEASES_KEEP_EXTRA=1
EOF

snap() { find "$tmp/srv" "$tmp/log" "$tmp/fff.conf" -printf '%p %s %T@ %m\n' | sort; }
before=$(snap)
ctl() { FFF_TEST_NOROOT=1 FFF_LIB=$G FFF_CONF=$tmp/fff.conf FFF_LOG_DIR=$tmp/log bash $G/fffctl disk-usage "$@" 2>&1; }
rc=0
out=$(ctl) || rc=$?
[ "$rc" -eq 0 ] || fail "disk-usage exited $rc: $out"
[ "$(snap)" = "$before" ] || fail "disk-usage changed the tree: $(diff <(echo "$before") <(snap) || true)"
for s in "$oat" "$ghp" 'vault add' 'Accepted publickey' 'hello' 'Started x'; do
  if printf '%s' "$out" | matches -F -- "$s"; then fail "disk-usage printed a file's text ($s): $out"; fi
done
echo "ok: disk-usage writes nothing and prints no file's text (transcripts, .claude, log lines, sudo arguments)"

want() { printf '%s' "$out" | matches -E -- "$1" || fail "disk-usage: no line matching '$1' in: $out"; }
want "^== $root: du -xh --max-depth=3"
want "$root/data/attachments  \(files 2, oldest 2026-09-01, newest 2026-10-20\)"
want "$root/app/releases/r2 CURRENT  \(node_modules [0-9.]+K, built 2026-10-02"
want "$root/app/releases/r1 PREVIOUS  \(node_modules [0-9.]+K, built 2026-10-01"
want "RELEASES_KEEP_EXTRA=1"
want "repo.git: .*$root/app/repo.git"
want "\.claude\), each child"
want "$root/home/.claude/projects/-srv-fff-a"
echo "ok: disk-usage lists the depth-3 du, data/'s children with dates, the releases with node_modules and marks, .claude"

want "^ +2026-10-05 +1 lines +CRON 1"
want "^ +2026-10-12 +13 lines +runuser 10  sudo 3"
want "^ +2026-10-13 +1 lines +sshd 1"
want "^ +5  pam_unix\(runuser:session\) session opened"
want "^ +1  pam_unix\(cron:session\) session opened"
want "^ +3  fff-ops -> /usr/local/lib/fff/fff-ops-priv$"
want "^ +2026-10-12 +2 lines +node 2"
want "^ +Oct 13 +1 lines +systemd 1"
echo "ok: auth.log (with its .gz rotation) and syslog are counted per day by program, PAM sessions by service, sudo by who and path"

rc=0
out=$(ctl extra) || rc=$?
[ "$rc" -ne 0 ] || fail "disk-usage extra was not refused: $out"
echo "ok: disk-usage takes no option"
