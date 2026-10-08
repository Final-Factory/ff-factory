# shellcheck shell=bash
# The path from the internet through Funnel to the portal (w681): what fff-vm watch checks, repairs where that is safe, and
# reports, on top of its hang detection. Sourced by fff-vm (installed next to lib.sh, which fff-vm has sourced), never run.
#
# One pass per fff-vm-watch.timer run, a line in the journal for every layer: "path L<id> <name>: <verdict>: <evidence>".
# The layers, in order; the first failing one of 2 to 8 stops that part of the pass (the rest are "skip"):
#   ssh   the host can reach the VM over ssh (this script's way in)
#   1     the portal answers in the VM (fff-vm watch's own check, recorded here)
#   2     tailscaled runs and is online, with no health warning        repair: restart tailscaled (30 min apart)
#   3     the node is tagged and has the funnel and https capabilities   (an admin's: logged)
#   4     tailscale serve routes https://<dns>:443 / to the portal, Funnel on   repair: tailscale funnel --bg
#   5     the HTTPS certificate works (curl in the VM)                  repair: tailscale cert (not before ACME's retry time)
#   6     the VM's firewall accepts the ports tailscaled listens on     (verified only: install.sh is the fix)
#   7     the tailnet policy does not drop Funnel servers' traffic      (an admin's: logged, urgent alert)
#   8     Funnel servers connect at all                                  repair: restart tailscaled, check again in 5 min
#   9     the portal answers from outside, through Funnel (curl on this host): the final pass or fail, always run
#   disk  clock  loop  ntfy   other single points of failure: the VM's disk, its clock, the portal service restarting in a
#                             loop, and the alert channel itself
# A layer is a problem after PW_FAILS_BEFORE_ALERT failing passes in a row; one alert an hour per problem (ntfy), and an
# alert when a repair did not fix it. Layers 2 to 8 reach the banner only while layer 9 fails too (a layer that fails while
# the portal answers from outside is a warning). The state goes to the portal (PW_HEALTH_FILE in the VM, no secrets),
# which shows the banner. Never: a VM reset for a Tailscale failure, a change to the tailnet policy or to the VM's firewall.

# The defaults of fff-vm.conf.example (load_conf reads that file and then the operator's), so a host that got this file
# before the example is still complete. Documented there.
: "${PW_CHECKS:=on}" "${PW_EXPECT_FUNNEL:=1}" "${PW_EXPECT_TAG:=tag:fff-portal}" "${PW_FAILS_BEFORE_ALERT:=2}"
: "${PW_TS_RESTART_MIN:=30}" "${PW_FUNNEL_STALE_MIN:=30}" "${PW_DISK_WARN_MB:=2048}" "${PW_DISK_FAIL_MB:=512}"
: "${PW_CLOCK_SKEW_SEC:=60}" "${PW_HEALTH_FILE:=/run/fff/path-health.json}"

PL_IDS="ssh 1 2 3 4 5 6 7 8 9 disk clock loop ntfy"
PL_POLICY_MSG="the tailnet policy drops Funnel traffic: a tailnet admin must grant tag:ingress (or *) → tag:fff-portal"
# The VM's marker of a running migrate dry run (fffctl migrate --dry-run-copy): its Funnel is off on purpose.
PL_DRYRUN_MARKER=${PL_DRYRUN_MARKER:-/srv/fff/migrate/dry-run.json}

# ---------------------------------------------------------------- names, who acts
pl_name() {
  case $1 in
    ssh) echo "host-to-VM ssh" ;;
    1) echo "portal in the VM" ;;
    2) echo "tailscaled" ;;
    3) echo "node identity" ;;
    4) echo "Serve/Funnel route" ;;
    5) echo "certificate" ;;
    6) echo "VM firewall" ;;
    7) echo "tailnet policy" ;;
    8) echo "Funnel servers" ;;
    9) echo "end to end" ;;
    disk) echo "VM disk" ;;
    clock) echo "VM clock" ;;
    loop) echo "portal restarts" ;;
    ntfy) echo "alert channel" ;;
    *) echo "layer $1" ;;
  esac
}
# Who must act when the watch cannot fix it.
pl_who() {
  case $1 in
    ssh) echo "ops: sshd in the VM or the host's key (sudo virsh console $VM_NAME)" ;;
    1) echo "ops: sudo fff-vm ssh sudo fffctl status" ;;
    2) echo "ops: sudo fff-vm ssh sudo journalctl -u tailscaled; a removed or expired node needs a tailnet admin (fffctl tailscale-join)" ;;
    3) echo "tailnet admin: tag this node ${PW_EXPECT_TAG} and give that tag the funnel attribute (nodeAttrs), HTTPS on for the tailnet" ;;
    4) echo "ops: sudo fff-vm ssh sudo tailscale funnel --bg http://127.0.0.1:$PORTAL_PORT (Funnel must be allowed for this node: tailnet admin)" ;;
    5) echo "ops, or a tailnet admin: HTTPS certificates on for the tailnet; Let's Encrypt's rate limit passes by itself" ;;
    6) echo "ops: re-run the guest install in the VM (sudo fffctl update): its firewall accepts TCP 22 and 443 from tailscale0 and nothing broader" ;;
    7) echo "tailnet admin: grant tag:ingress → tag:fff-portal in the tailnet policy" ;;
    8) echo "tailnet admin or ops: Tailscale sends no Funnel traffic to this node; the admin console shows the node's Funnel and health" ;;
    9) echo "ops: every layer inside the VM passes but the outside path fails; check Tailscale's status page and the Funnel name's DNS" ;;
    disk) echo "ops: free disk space in the VM (sudo fff-vm ssh df -h)" ;;
    clock) echo "ops: the VM's clock is off and its time sync did not fix it (sudo fff-vm ssh timedatectl)" ;;
    loop) echo "ops: sudo fff-vm ssh sudo fffctl logs; the last update may need sudo fffctl rollback" ;;
    ntfy) echo "ops: this host cannot reach the ntfy server, so alerts do not arrive (the journal has them)" ;;
    *) echo "ops: sudo fff-vm watch status" ;;
  esac
}

# ---------------------------------------------------------------- small helpers
# sget KEY [DEFAULT]: the watch state's value (state_get prints nothing for a missing key).
sget() { local v; v=$(state_get "$1"); echo "${v:-${2:-}}"; }
iso() { date -u -d "@${1:-0}" +%FT%TZ; }
# shq STR: STR as one single-quoted word for a remote sh.
shq() { local s=${1//\'/\'\\\'\'}; printf "'%s'" "$s"; }
# pl_clean TEXT: one line, no secrets (auth keys, login links, node keys, key= values), at most 600 characters.
pl_clean() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | sed -E 's#tskey-[A-Za-z0-9_-]+#[auth key removed]#g; s#https?://login\.tailscale\.com/a/[A-Za-z0-9]+#[login link removed]#g; s#(nodekey|privkey|mkey|dmkey):[0-9a-f]+#\1:[removed]#g; s#((authkey|token|key|secret)=)[^ &"]+#\1[removed]#gI' | tr -s ' ' | cut -c1-600
}
# gx CMD: CMD (sh syntax) in the guest as root over ssh; stderr is the caller's to merge (2>&1 in CMD).
gx() { ssh_guest "sudo -n timeout ${GX_TIMEOUT:-40} sh -c $(shq "$1")"; }

# pl_set ID VERDICT EVIDENCE: record a layer's result (state + one journal line). Verdicts: ok warn fail skip.
pl_set() {
  local id=$1 v=$2 ev t prev fails alerted
  ev=$(pl_clean "$3")
  t=$(now)
  prev=$(sget "L${id}_verdict" none)
  [ "$prev" = "$v" ] || state_set "L${id}_since" "$t"
  if [ "$v" = fail ]; then fails=$(($(sget "L${id}_fails" 0) + 1)); else fails=0; fi
  state_set "L${id}_fails" "$fails"
  state_set "L${id}_verdict" "$v"
  state_set "L${id}_at" "$t"
  state_set "L${id}_line" "$ev"
  log "path L$id $(pl_name "$id"): $v: $ev"
  alerted=$(sget "L${id}_alert")
  if [ "$prev" = fail ] && [ "$v" != fail ] && [ -n "$alerted" ]; then
    notify "fff-vm: portal path OK again" "$(pl_name "$id") passes again: $ev"
    state_set "L${id}_alert" ""
  fi
}
# pl_skip WHY ID...: the layers that were not checked.
pl_skip() { local id why=$1; shift; for id in "$@"; do pl_set "$id" skip "$why"; done; }
# pl_alert ID TITLE MESSAGE [PRIORITY]: an ntfy alert, one an hour per layer.
pl_alert() {
  local id=$1
  [ $(($(now) - $(sget "L${id}_alert" 0))) -gt 3600 ] || return 0
  notify "$2" "$3" "${4:-high}"
  state_set "L${id}_alert" "$(now)"
}
# Repairs are logged before and after, and the last one is kept for the status and the banner.
pl_repair_start() { log "path L$1 repair: before: $(pl_clean "$3"); running: $2"; }
pl_repair_end() { # ID COMMAND fixed|"not fixed" EVIDENCE
  local ev
  ev=$(pl_clean "$4")
  state_set "L$1_repair" "$(iso "$(now)") $2: $3: $ev"
  log "path L$1 repair: after: $3: $ev"
  if [ "$3" != fixed ]; then
    pl_alert "$1" "fff-vm: repair did not fix: $(pl_name "$1")" "$2 ran, $(pl_name "$1") still fails: $ev. $(pl_who "$1")"
  fi
}
# At most one tailscaled restart in PW_TS_RESTART_MIN minutes and three in 6 hours; never a VM reset for a Tailscale failure.
pl_ts_restart_ok() {
  local recent="" t n=0
  for t in $(sget ts_restarts); do [ $(($(now) - t)) -lt 21600 ] && recent+=" $t" && n=$((n + 1)); done
  [ "$n" -lt 3 ] || return 1
  [ $(($(now) - $(sget ts_restart_at 0))) -ge $((PW_TS_RESTART_MIN * 60)) ]
}
pl_ts_restart_mark() {
  local recent="" t
  for t in $(sget ts_restarts); do [ $(($(now) - t)) -lt 21600 ] && recent+=" $t"; done
  state_set ts_restarts "${recent# } $(now)"
  state_set ts_restart_at "$(now)"
}
# pl_dry_run: the VM runs a migrate dry run, whose Funnel is off on purpose.
pl_dry_run() { gx "[ -e $PL_DRYRUN_MARKER ] || systemctl show -p Environment fff-portal.service 2>/dev/null | grep -q FFSB_DRY_RUN=1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- the firewall check
# What tailscale0 may reach in this VM, by install.sh (w683): ssh and 443, nothing else. Funnel's servers and tailscale serve
# talk to tailscaled, whose netstack takes them off the wire before the kernel (tailscaled source, wgengine/netstack
# shouldProcessInbound), so no rule is needed for them, nor for tailscaled's random peer API port.
PW_FW_ALLOWED="22 443"
# fw_scan RULES: FW_PORTS is the TCP ports the accept rules for tailscale0 (RULES) name, from PW_FW_ALLOWED; FW_BROAD is each
# rule that accepts more: a port outside it, no port at all, or another protocol.
FW_PORTS="" FW_BROAD=""
fw_scan() {
  local rule spec e out allowed
  FW_PORTS="" FW_BROAD=""
  while IFS= read -r rule; do
    [[ $rule == *'iifname "tailscale0"'* && $rule == *accept* ]] || continue
    out=$(tr -s ' \t' ' ' <<<"${rule%% comment *}")
    allowed=1
    if [[ $rule =~ tcp\ dport\ (\{[^\}]*\}|[0-9-]+) ]]; then
      spec=${BASH_REMATCH[1]}
      for e in ${spec//[\{\},]/ }; do
        if [[ " $PW_FW_ALLOWED " == *" $e "* ]]; then FW_PORTS+=" $e"; else allowed=0; fi
      done
    else
      allowed=0
    fi
    [ "$allowed" = 1 ] || FW_BROAD+="${FW_BROAD:+; }${out# }"
  done <<<"$1"
}

# ---------------------------------------------------------------- the layers
# ssh: the way into the VM. Its repair goes through the guest agent (root, no ssh needed).
pl_check_ssh() {
  local out rc fails
  out=$(ssh_guest true 2>&1) && rc=0 || rc=$?
  if [ "$rc" = 0 ]; then pl_set ssh ok "ssh $VM_ADMIN_USER@$NET_VM_IP answers"; return 0; fi
  fails=$(($(sget Lssh_fails 0) + 1))
  if [ "$fails" -ge "$PW_FAILS_BEFORE_ALERT" ] && [ $(($(now) - $(sget ssh_repair_at 0))) -ge 1800 ] && agent_ok; then
    pl_repair_start ssh "systemctl restart ssh (through the guest agent)" "ssh failed (exit $rc): $(pl_clean "$out")"
    state_set ssh_repair_at "$(now)"
    guest_exec 30 /bin/systemctl restart ssh.service >/dev/null 2>&1 || true
    sleep 3
    if out=$(ssh_guest true 2>&1); then
      pl_repair_end ssh "systemctl restart ssh" fixed "ssh answers again"
      pl_set ssh ok "ssh $VM_ADMIN_USER@$NET_VM_IP answers (after a restart of sshd)"
      return 0
    fi
    pl_repair_end ssh "systemctl restart ssh" "not fixed" "ssh still fails: $(pl_clean "$out")"
  fi
  pl_set ssh fail "ssh $VM_ADMIN_USER@$NET_VM_IP failed (exit $rc): $out"
  return 1
}

# pl_read_status: tailscale status --json into TS, the evidence into EV; fails unless it is Running, online and healthy.
# Not run in a $(...): it sets the globals the other layers read.
# HARD=1: tailscaled does not answer, is not Running or is offline (a restart is the cure); 0: it runs and reports a health
# warning (a restart would only cut its connections for a warning that may be harmless).
TS="" EV="" HARD=0
SELF4="" SELF6="" DNS=""
pl_read_status() {
  local out rc active st on health ver
  HARD=1
  out=$(gx 'tailscale status --json 2>&1') && rc=0 || rc=$?
  if [ "$rc" -ne 0 ] || ! jq -e 'type == "object"' >/dev/null 2>&1 <<<"$out"; then
    active=$(gx 'systemctl is-active tailscaled 2>&1' || true)
    TS=""
    EV="tailscale status failed (exit $rc; systemd says tailscaled is ${active:-unknown}): ${out:0:240}"
    return 1
  fi
  TS=$out
  DNS=$(jq -r '(.Self.DNSName // "") | rtrimstr(".")' <<<"$TS")
  [[ $DNS =~ ^[A-Za-z0-9.-]+$ ]] || DNS=""
  SELF4=$(jq -r '[.Self.TailscaleIPs[]? | select(test("^[0-9.]+$"))] | first // ""' <<<"$TS")
  SELF6=$(jq -r '[.Self.TailscaleIPs[]? | select(test(":"))] | first // ""' <<<"$TS")
  [ -z "$DNS" ] || state_set path_dns "$DNS"
  st=$(jq -r '.BackendState // "?"' <<<"$TS")
  on=$(jq -r '.Self.Online // false' <<<"$TS")
  health=$(jq -r '(.Health // []) | join(" | ")' <<<"$TS")
  ver=$(jq -r '(.Version // "?") | split("-")[0]' <<<"$TS")
  if [ "$st" = Running ] && [ "$on" = true ]; then HARD=0; fi
  if [ "$st" = Running ] && [ "$on" = true ] && [ -z "$health" ]; then
    EV="BackendState=Running Online=true Health=none (tailscale $ver)"
    return 0
  fi
  EV="BackendState=$st Online=$on Health=[${health:-none}]"
  return 1
}

path_l2() {
  local fails n why fixed=0 want=0
  if pl_read_status; then state_set L2_restarted ""; pl_set 2 ok "$EV"; return 0; fi
  fails=$(($(sget L2_fails 0) + 1))
  # A health warning alone is restarted for once, and only while the outside probe fails too.
  if [ "$HARD" = 1 ]; then want=1; elif [ -z "$(sget L2_restarted)" ] && [ "$(sget L9_verdict)" = fail ]; then want=1; fi
  if [ "$want" = 1 ] && [ "$fails" -ge "$PW_FAILS_BEFORE_ALERT" ] && pl_ts_restart_ok; then
    state_set L2_restarted 1
    why=$EV
    pl_repair_start 2 "systemctl restart tailscaled" "$why"
    pl_ts_restart_mark
    gx 'systemctl restart tailscaled 2>&1' >/dev/null || true
    for n in 1 2 3 4 5 6; do sleep 5; if pl_read_status; then fixed=1; break; fi; done
    if [ "$fixed" = 1 ]; then
      pl_repair_end 2 "systemctl restart tailscaled" fixed "$EV"
      pl_set 2 ok "$EV (after a restart of tailscaled)"
      return 0
    fi
    pl_repair_end 2 "systemctl restart tailscaled" "not fixed" "$EV"
  fi
  pl_set 2 fail "$EV"
  return 1
}

path_l3() {
  local tags cap ok=1 ev
  tags=$(jq -r '(.Self.Tags // []) | join(",")' <<<"$TS")
  cap=$(jq -r '((.Self.CapMap // {}) | has("funnel") and has("https")) or (((.Self.Capabilities // []) | index("funnel")) != null and ((.Self.Capabilities // []) | index("https")) != null)' <<<"$TS")
  ev="tags=[${tags:-none}] funnel+https capabilities=$([ "$cap" = true ] && echo yes || echo NO)"
  jq -e --arg t "$PW_EXPECT_TAG" '(.Self.Tags // []) | index($t) != null' >/dev/null <<<"$TS" || ok=0
  [ "$cap" = true ] || ok=0
  if [ "$ok" = 1 ]; then pl_set 3 ok "$ev"; return 0; fi
  pl_set 3 fail "$ev; this node needs tag $PW_EXPECT_TAG and the funnel and https capabilities (tailnet policy: tagOwners, nodeAttrs; HTTPS on in the admin console)"
  return 1
}

path_l4() {
  local out proxy fn want="http://127.0.0.1:$PORTAL_PORT" key="$DNS:443" ev rc
  if [ -z "$DNS" ]; then pl_set 4 fail "the node has no DNS name (MagicDNS or HTTPS off for the tailnet?)"; return 1; fi
  read_route() {
    out=$(gx 'tailscale serve status --json 2>&1') && rc=0 || rc=$?
    proxy=$(jq -r --arg k "$key" '.Web[$k].Handlers["/"].Proxy // ""' 2>/dev/null <<<"$out" || true)
    fn=$(jq -r --arg k "$key" '.AllowFunnel[$k] // false' 2>/dev/null <<<"$out" || echo false)
    ev="$key / → ${proxy:-no route}, AllowFunnel=${fn:-false}"
    [ "$proxy" = "$want" ] && [ "$fn" = true ]
  }
  if read_route; then pl_set 4 ok "$ev"; return 0; fi
  if [ "$rc" -ne 0 ]; then ev="tailscale serve status failed (exit $rc): ${out:0:200}"; fi
  if [ $(($(now) - $(sget route_repair_at 0))) -ge 600 ]; then
    state_set route_repair_at "$(now)"
    pl_repair_start 4 "tailscale funnel --bg $want" "$ev"
    out=$(GX_TIMEOUT=60 gx "tailscale funnel --bg $(shq "$want") 2>&1") && rc=0 || rc=$?
    if read_route; then
      pl_repair_end 4 "tailscale funnel --bg $want" fixed "$ev"
      pl_set 4 ok "$ev (after tailscale funnel --bg)"
      return 0
    fi
    pl_repair_end 4 "tailscale funnel --bg $want" "not fixed" "$ev; the command said (exit $rc): ${out:0:240}"
    ev="$ev; tailscale funnel --bg said (exit $rc): ${out:0:200}"
  fi
  pl_set 4 fail "$ev"
  return 1
}

# The ACME retry time in tailscale cert's error ("retry after 2026-10-12 12:00:00 UTC"), as a UNIX time; nothing if none.
cert_retry_epoch() {
  local ts
  ts=$(grep -oiE 'retry after [0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9:]+( UTC|Z)?' <<<"$1" | head -n 1 | sed -E 's/^retry after //I' || true)
  [ -n "$ts" ] || return 0
  date -u -d "${ts%Z}" +%s 2>/dev/null || true
}

path_l5() {
  local out rc ev cout exp retry t
  # tailscale cert into a private temp folder (the copy is not wanted: tailscaled keeps its own, which serve uses), then gone.
  cert_cmd() { echo "d=\$(mktemp -d) && cd \"\$d\" && umask 077 && tailscale cert --cert-file c.crt --key-file c.key $(shq "$DNS") 2>&1; r=\$?; cd /; rm -rf \"\$d\"; exit \$r"; }
  [ -n "$SELF4" ] || { pl_set 5 fail "no Tailscale IPv4 address to test the certificate against"; return 1; }
  selftest() {
    out=$(gx "curl -fsS -m 20 --resolve $(shq "$DNS:443:$SELF4") $(shq "https://$DNS/api/health") 2>&1") && rc=0 || rc=$?
    [ "$rc" = 0 ] && grep -E '"ok" *: *true' >/dev/null <<<"$out"
  }
  if selftest; then
    # works: expiring within 5 days is renewed ahead of time (tailscale cert is a no-op while the cached one is good)
    exp=$(gx "echo | openssl s_client -connect $(shq "$SELF4:443") -servername $(shq "$DNS") 2>/dev/null | openssl x509 -noout -checkend 432000 2>&1" || true)
    if [[ $exp == *"will expire"* ]]; then
      ev="https://$DNS answers from inside the VM, but its certificate expires within 5 days"
      if [ $(($(now) - $(sget cert_renew_at 0))) -ge 21600 ]; then
        state_set cert_renew_at "$(now)"
        pl_repair_start 5 "tailscale cert $DNS" "$ev"
        out=$(GX_TIMEOUT=90 gx "$(cert_cmd)") && rc=0 || rc=$?
        if [ "$rc" = 0 ]; then pl_repair_end 5 "tailscale cert $DNS" fixed "renewed"; else pl_repair_end 5 "tailscale cert $DNS" "not fixed" "exit $rc: ${out:0:240}"; fi
      fi
      pl_set 5 warn "$ev"
      return 0
    fi
    pl_set 5 ok "https://$DNS/api/health answers from inside the VM (certificate valid)"
    return 0
  fi
  ev="https://$DNS/api/health from inside the VM failed (curl exit $rc): ${out:0:240}"
  retry=$(sget cert_retry_after 0)
  if [ "$(now)" -lt "$retry" ]; then
    pl_set 5 fail "$ev; Let's Encrypt asked to wait: not retrying tailscale cert before $(iso "$retry")"
    return 1
  fi
  if [ $(($(now) - $(sget cert_repair_at 0))) -ge 1800 ]; then
    state_set cert_repair_at "$(now)"
    pl_repair_start 5 "tailscale cert $DNS" "$ev"
    cout=$(GX_TIMEOUT=90 gx "$(cert_cmd)") && rc=0 || rc=$?
    if [ "$rc" = 0 ]; then
      for t in 1 2 3; do selftest && break; sleep 5; done || true
      if selftest; then
        pl_repair_end 5 "tailscale cert $DNS" fixed "https answers again"
        pl_set 5 ok "https://$DNS/api/health answers from inside the VM (after tailscale cert)"
        return 0
      fi
      pl_repair_end 5 "tailscale cert $DNS" "not fixed" "the certificate was fetched, but https still fails: ${out:0:240}"
      ev="$ev; tailscale cert succeeded but https still fails"
    else
      retry=$(cert_retry_epoch "$cout")
      [ -z "$retry" ] || state_set cert_retry_after "$retry"
      pl_repair_end 5 "tailscale cert $DNS" "not fixed" "tailscale cert (exit $rc) said: ${cout:0:300}${retry:+ [no retry before $(iso "$retry")]}"
      ev="$ev; tailscale cert (exit $rc) said: ${cout:0:300}"
    fi
  fi
  pl_set 5 fail "$ev"
  return 1
}

path_l6() {
  local ssout nftout rules sshd="" kernel="" mine
  ssout=$(gx 'ss -ltnpH 2>&1') || true
  nftout=$(gx 'nft list chain inet fff_guest input 2>&1') || true
  if ! grep -F 'chain input' >/dev/null <<<"$nftout"; then
    pl_set 6 fail "cannot read the VM's firewall chain (nft list chain inet fff_guest input): ${nftout:0:240}"
    return 1
  fi
  rules=$(grep -F 'iifname "tailscale0"' <<<"$nftout" || true)
  fw_scan "$rules"
  # Processes other than tailscaled listening where the tailnet's packets can land: every address, or the node's own.
  kernel=$(awk -v a4="$SELF4" -v a6="$SELF6" '
    /users:/ && !/"tailscaled"/ {
      la = $4; port = la; sub(/.*:/, "", port); addr = la; sub(/:[0-9]+$/, "", addr); gsub(/[][]/, "", addr)
      if (addr == "0.0.0.0" || addr == "*" || addr == "::" || (a4 != "" && addr == a4) || (a6 != "" && addr == a6)) {
        name = $0; sub(/.*\(\("/, "", name); sub(/".*/, "", name); print port "(" name ")"
      }
    }' <<<"$ssout" | sort -un | tr '\n' ' ')
  kernel=${kernel% }
  mine=" $(tr -d '\n' <<<"$FW_PORTS") "
  [[ $kernel == *'22('* ]] && sshd=1
  if [ -n "$FW_BROAD" ]; then
    pl_set 6 fail "tailscale0 accepts more than ssh (22) and 443: ${FW_BROAD}. install.sh allows only those two: Funnel and tailscale serve are tailscaled's own and reach it before the kernel, so they need no rule. Re-run the guest install to load the narrow rules"
    return 1
  fi
  if [ -n "$sshd" ] && [[ $mine != *" 22 "* ]]; then
    pl_set 6 fail "sshd listens on 22 but tailscale0 does not accept 22 (accepted:${FW_PORTS:- none}): nobody can ssh in over the tailnet. Re-run the guest install"
    return 1
  fi
  pl_set 6 ok "tailscale0 accepts only TCP${FW_PORTS:- none} (Funnel and serve are tailscaled's own and need no rule); processes reachable by address: [${kernel:-none}]"
  return 0
}

path_l7() {
  local ingress out n=0 sample="" line src total=0
  ingress=$(jq -r '[.Peer[]? | select(((.Tags // []) | index("tag:ingress")) != null) | .TailscaleIPs[]?] | .[]' <<<"$TS")
  out=$(gx "journalctl -u tailscaled --since -15min --no-pager 2>&1 | grep 'Drop:.*no rules matched' | tail -n 300 || true") || true
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    total=$((total + 1))
    if [[ $line =~ Drop:\ [A-Za-z0-9]+\{\[?([0-9a-fA-F:.]+)\]?:[0-9]+\ \> ]]; then
      src=${BASH_REMATCH[1]}
      if grep -qxF "$src" <<<"$ingress"; then n=$((n + 1)); sample=$line; fi
    fi
  done <<<"$out"
  if [ "$n" -gt 0 ]; then
    pl_set 7 fail "$PL_POLICY_MSG. $n line(s) in 15 min, last: $sample"
    return 1
  fi
  pl_set 7 ok "no Funnel server (tag:ingress) traffic dropped by the packet filter in 15 min (${total} other Drop line(s))"
  return 0
}

path_l8() {
  local stats peers newest rx age restarted_at restarted_ago ev
  stats=$(jq -r '
    def epoch: if (. == null) or startswith("0001") then 0 else (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) end;
    [.Peer[]? | select(((.Tags // []) | index("tag:ingress")) != null)] as $p
    | "\($p | length) \([$p[] | (.LastHandshake | epoch)] | max // 0) \([$p[] | .RxBytes // 0] | add // 0)"' <<<"$TS" 2>&1) || true
  read -r peers newest rx <<<"$stats"
  if ! [[ ${peers:-x} =~ ^[0-9]+$ ]]; then pl_set 8 fail "could not read the Funnel servers from tailscale status: ${stats:0:200}"; return 1; fi
  if [ "$newest" -gt 0 ]; then age=$((($(now) - newest) / 60)); ev="$peers Funnel server peer(s), newest handshake $age min ago, $rx bytes received in total"
  else age=999999; ev="$peers Funnel server peer(s), no handshake yet, $rx bytes received in total"; fi
  if [ "$peers" = 0 ]; then
    pl_set 8 fail "tailscale status lists no Funnel server (tag:ingress) peers: Funnel is not provisioned for this node"
    return 1
  fi
  # The outside probe (layer 9) goes through a Funnel server every minute, so while it passes handshakes are fresh; only
  # when it failed in the pass before (it runs after this one), and no server has connected for a while, is Tailscale
  # itself not sending anything.
  if [ "$age" -le "$PW_FUNNEL_STALE_MIN" ] || [ "$(sget L9_verdict)" != fail ]; then
    state_set L8_restarted ""
    pl_set 8 ok "$ev"
    return 0
  fi
  restarted_at=$(sget L8_restart_at 0)
  restarted_ago=$(($(now) - restarted_at))
  if [ -n "$(sget L8_restarted)" ] && [ "$restarted_ago" -lt 300 ]; then
    pl_set 8 warn "$ev; tailscaled was restarted $restarted_ago s ago, checking again after 5 min"
    return 0
  fi
  if [ -z "$(sget L8_restarted)" ] && pl_ts_restart_ok; then
    pl_repair_start 8 "systemctl restart tailscaled" "$ev; no Funnel server has connected for $age min although layers 1 to 7 pass"
    pl_ts_restart_mark
    state_set L8_restart_at "$(now)"
    state_set L8_restarted 1
    gx 'systemctl restart tailscaled 2>&1' >/dev/null || true
    state_set "L8_repair" "$(iso "$(now)") systemctl restart tailscaled: restarted, checking again after 5 min"
    log "path L8 repair: after: restarted tailscaled once; checking again after 5 min"
    pl_set 8 warn "$ev; restarted tailscaled once, checking again after 5 min"
    return 0
  fi
  pl_set 8 fail "$ev; no Funnel server has connected for $age min although layers 1 to 7 pass: Tailscale stopped sending traffic to this node$([ -n "$(sget L8_restarted)" ] && echo " (the restart of tailscaled $((restarted_ago / 60)) min ago did not bring it back)")"
  return 1
}

# 9: from this host, which is not on the tailnet: out through the internet and back in through Funnel.
pl_e2e() {
  local dns url out rc ips ip good=0 bad="" n=0 res ev
  dns=${DNS:-$(sget path_dns)}
  if [ -z "$dns" ]; then pl_set 9 skip "the node's Funnel name is not known yet (layer 2 never read it)"; return 0; fi
  url="https://$dns/api/health"
  out=$(curl -fsS -m 10 "$url" 2>&1) && rc=0 || rc=$?
  if [ "$rc" = 0 ] && grep -E '"ok" *: *true' >/dev/null <<<"$out"; then
    pl_set 9 ok "$url answers ok:true from outside ($(hostname -s), through Funnel)"
    return 0
  fi
  ev="$url from outside failed (curl exit $rc): ${out:0:200}"
  if ! curl -sS -m 8 -o /dev/null https://login.tailscale.com/ >/dev/null 2>&1; then
    pl_set 9 warn "$ev; this host has no internet either (login.tailscale.com does not answer), so nothing can be said about Funnel"
    return 0
  fi
  ips=$(getent ahosts "$dns" 2>/dev/null | awk '{print $1}' | sort -u || true)
  while read -r ip; do
    [ -n "$ip" ] || continue
    n=$((n + 1))
    res="$ip"
    [[ $ip == *:* ]] && res="[$ip]"
    if curl -fsS -m 10 --resolve "$dns:443:$res" "$url" 2>/dev/null | grep -E '"ok" *: *true' >/dev/null; then good=$((good + 1)); else bad+=" $ip"; fi
  done <<<"$ips"
  pl_set 9 fail "$ev; $good of $n Funnel server address(es) from DNS answer$([ -n "$bad" ] && echo ", failing:${bad}")"
  return 1
}

# ---------------------------------------------------------------- other single points of failure
pl_disk() {
  local out mb pct min=999999999 max=0 line v ev
  read_disk() {
    out=$(gx 'df -Pm / /srv/fff 2>&1 | tail -n +2') || true
    min=999999999; max=0
    while read -r _ _ _ mb pct _; do
      [[ ${mb:-x} =~ ^[0-9]+$ ]] || continue
      pct=${pct%\%}
      [ "$mb" -ge "$min" ] || min=$mb
      [ "${pct:-0}" -le "$max" ] || max=${pct:-0}
    done <<<"$out"
    [ "$min" != 999999999 ]
  }
  if ! read_disk; then pl_set disk warn "could not read df in the VM: ${out:0:200}"; return 0; fi
  v=ok
  [ "$min" -ge "$PW_DISK_WARN_MB" ] && [ "$max" -lt 90 ] || v=warn
  [ "$min" -ge "$PW_DISK_FAIL_MB" ] && [ "$max" -lt 97 ] || v=fail
  ev="$min MB free at the fullest of / and /srv/fff, $max% used"
  if [ "$v" != ok ] && [ $(($(now) - $(sget disk_repair_at 0))) -ge 21600 ]; then
    state_set disk_repair_at "$(now)"
    pl_repair_start disk "journalctl --vacuum-size=200M; apt-get clean" "$ev"
    gx 'journalctl --vacuum-size=200M 2>&1; apt-get clean 2>&1' >/dev/null || true
    if read_disk; then
      line="$min MB free, $max% used"
      v=ok; [ "$min" -ge "$PW_DISK_WARN_MB" ] && [ "$max" -lt 90 ] || v=warn; [ "$min" -ge "$PW_DISK_FAIL_MB" ] && [ "$max" -lt 97 ] || v=fail
      if [ "$v" = ok ]; then pl_repair_end disk "journal vacuum, apt clean" fixed "$line"; else pl_repair_end disk "journal vacuum, apt clean" "not fixed" "$line"; fi
      ev="$line (after a journal vacuum and apt-get clean)"
    fi
  fi
  pl_set disk "$v" "$ev"
  return 0
}

pl_clock() {
  local t0 t1 g skew out
  measure() {
    t0=$(now); g=$(gx 'date +%s'); t1=$(now)
    [[ ${g:-x} =~ ^[0-9]+$ ]] || return 1
    skew=$((g - (t0 + t1) / 2))
  }
  if ! measure; then pl_set clock warn "could not read the VM's clock"; return 0; fi
  if [ "${skew#-}" -le "$PW_CLOCK_SKEW_SEC" ]; then pl_set clock ok "the VM's clock is ${skew}s off this host's"; return 0; fi
  if [ $(($(now) - $(sget clock_repair_at 0))) -ge 1800 ]; then
    state_set clock_repair_at "$(now)"
    pl_repair_start clock "restart the VM's time sync" "the VM's clock is ${skew}s off this host's"
    out=$(gx 'systemctl restart systemd-timesyncd 2>&1 || systemctl restart chrony 2>&1 || systemctl restart chronyd 2>&1' || true)
    sleep 10
    if measure && [ "${skew#-}" -le "$PW_CLOCK_SKEW_SEC" ]; then
      pl_repair_end clock "time sync restart" fixed "the clock is ${skew}s off"
      pl_set clock ok "the VM's clock is ${skew}s off this host's (after restarting its time sync)"
      return 0
    fi
    pl_repair_end clock "time sync restart" "not fixed" "still ${skew:-?}s off${out:+ ($(pl_clean "$out"))}"
  fi
  pl_set clock fail "the VM's clock is ${skew}s off this host's: certificates fail past a few minutes of skew"
  return 0
}

# The portal service restarting in a loop: systemd restarts it for ever (Restart=always), so only the count tells.
pl_loop() {
  local out nr kept="" base="" e n delta act
  out=$(gx 'systemctl show fff-portal.service -p NRestarts -p ActiveState -p Result 2>&1') || true
  nr=$(sed -n 's/^NRestarts=//p' <<<"$out")
  act=$(sed -n 's/^ActiveState=//p' <<<"$out")
  if ! [[ ${nr:-x} =~ ^[0-9]+$ ]]; then pl_set loop warn "could not read NRestarts of fff-portal.service: ${out:0:160}"; return 0; fi
  for e in $(sget loop_hist); do [ $(($(now) - ${e%%:*})) -lt 900 ] && kept+=" $e"; done
  kept+=" $(now):$nr"
  state_set loop_hist "${kept# }"
  for e in $kept; do n=${e#*:}; if [ -z "$base" ] || [ "$n" -lt "$base" ]; then base=$n; fi; done
  delta=$((nr - base))
  if [ "$delta" -ge 5 ]; then
    pl_set loop fail "fff-portal.service restarted $delta times in the last 15 min (now ${act:-?}, $nr in all since it was last reset): it crash-loops"
  else
    pl_set loop ok "fff-portal.service restarted $delta time(s) in the last 15 min (${act:-?})"
  fi
  return 0
}

# The alert channel: when ntfy cannot be reached, alerts only reach the journal and the banner.
pl_ntfy() {
  local base out
  if [ ! -r "${NTFY_URL_FILE:-}" ]; then pl_set ntfy warn "no ntfy URL file ($NTFY_URL_FILE): alerts only reach the journal and the banner"; return 0; fi
  base=$(head -n 1 "$NTFY_URL_FILE" | sed -E 's#^(https?://[^/]+).*#\1#')
  if out=$(curl -fsS -m 8 "$base/v1/health" 2>&1) && grep -E '"healthy" *: *true' >/dev/null <<<"$out"; then
    pl_set ntfy ok "${base#*//} reports healthy"
  else
    pl_set ntfy fail "the ntfy server ${base#*//} does not answer /v1/health from this host (${out:0:120}): alerts do not arrive"
  fi
  return 0
}

# ---------------------------------------------------------------- the pass
# pl_confirmed ID: the layer has failed PW_FAILS_BEFORE_ALERT passes in a row (ntfy: 5).
pl_confirmed() {
  local need=$PW_FAILS_BEFORE_ALERT
  [ "$1" != ntfy ] || need=5
  [ "$(sget "L$1_verdict")" = fail ] && [ "$(sget "L$1_fails" 0)" -ge "$need" ]
}

# path_summary: PATH_PROBLEMS (banner), alerts for them.
PATH_PROBLEMS=""
path_summary() {
  local first="" id
  PATH_PROBLEMS=""
  pl_confirmed ssh && PATH_PROBLEMS+=" ssh"
  for id in 2 3 4 5 6 7 8; do if pl_confirmed "$id"; then first=$id; break; fi; done
  if pl_confirmed 9; then
    [ -z "$first" ] || PATH_PROBLEMS+=" $first"
    PATH_PROBLEMS+=" 9"
  fi
  for id in disk clock loop ntfy; do pl_confirmed "$id" && PATH_PROBLEMS+=" $id"; done
  PATH_PROBLEMS=${PATH_PROBLEMS# }
  for id in $PATH_PROBLEMS; do
    # The outside probe fails because of the layer before it: one alert for the incident, from that layer.
    if [ "$id" = 9 ] && [ -n "$first" ]; then continue; fi
    if [ "$id" = 7 ]; then
      pl_alert 7 "fff-vm: URGENT: Funnel is blocked by the tailnet policy" "$(sget L7_line). Who: $(pl_who 7). The portal is not reachable from outside." urgent
    elif [ "$id" = "$first" ]; then
      pl_alert "$id" "fff-vm: portal path: $(pl_name "$id") fails" "$(sget "L${id}_line"). Who: $(pl_who "$id"). The portal is not reachable from outside."
    else
      pl_alert "$id" "fff-vm: portal path: $(pl_name "$id") fails" "$(sget "L${id}_line"). Who: $(pl_who "$id")"
    fi
  done
}

# path_json: the state for the portal's banner; no secrets (pl_clean ran on every line).
path_json() {
  local id rows="" v who
  for id in $PL_IDS; do
    v=$(sget "L${id}_verdict" none)
    who=""
    [ "$v" != fail ] || who=$(pl_who "$id")
    rows+=$(printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$(pl_name "$id")" "$v" "$(iso "$(sget "L${id}_since" "$(now)")")" "$(iso "$(sget "L${id}_at" "$(now)")")" "$(sget "L${id}_line")" "$who" "$(sget "L${id}_repair")")
    rows+=$'\n'
  done
  jq -n --arg rows "$rows" --arg problems "$PATH_PROBLEMS" --arg now "$(iso "$(now)")" --arg host "$(hostname -s)" --arg dns "$(sget path_dns)" '
    ($rows | split("\n") | map(select(length > 0) | split("\t") | {id: .[0], name: .[1], verdict: .[2], since: .[3], checkedAt: .[4], line: .[5], who: .[6], repair: .[7]})) as $layers
    | ($problems | split(" ") | map(select(length > 0))) as $p
    | {schema: 1, updatedAt: $now, host: $host, dns: $dns, ok: ($p | length == 0),
       problems: [$layers[] | select(.id as $i | $p | index($i) != null)],
       warnings: [$layers[] | select(.verdict == "warn" or (.verdict == "fail" and (.id as $i | $p | index($i) == null)))],
       layers: $layers}'
}

# path_publish: the state into the VM for the portal to read (root-owned, world-readable, replaced whole).
path_publish() {
  local json dir
  json=$(path_json) || { log "path: could not build the portal's status"; return 0; }
  dir=$(dirname "$PW_HEALTH_FILE")
  printf '%s\n' "$json" | ssh_guest "sudo -n sh -c $(shq "install -d -m 0755 $dir && cat >$PW_HEALTH_FILE.new && chmod 0644 $PW_HEALTH_FILE.new && mv -f $PW_HEALTH_FILE.new $PW_HEALTH_FILE")" >/dev/null 2>&1 ||
    log "path: could not hand the status to the portal ($PW_HEALTH_FILE in the VM)"
  return 0
}

# pl_chain: layers 2 to 8 in order; the first failing one stops the rest (each later one is recorded as skipped).
pl_chain() {
  local stop="" off="" id
  for id in 2 3 4 5 6 7 8; do
    if [ -n "$stop" ]; then pl_set "$id" skip "not checked: layer $stop failed"; continue; fi
    if [ "$id" -ge 4 ]; then
      if [ "$PW_EXPECT_FUNNEL" != 1 ]; then pl_set "$id" skip "Funnel is not expected (PW_EXPECT_FUNNEL=$PW_EXPECT_FUNNEL)"; continue; fi
      if [ -z "$off" ] && pl_dry_run; then off="a migrate dry run is in place in the VM: its Funnel is off on purpose"; fi
      if [ -n "$off" ]; then pl_set "$id" skip "$off"; continue; fi
    fi
    "path_l$id" || stop=$id
  done
  PW_OFF=$off
}

# path_watch PORTAL(yes|no): one pass. Never fails fff-vm watch.
PW_OFF=""
path_watch() {
  local portal=$1
  [ "$PW_CHECKS" = on ] || return 0
  exec 9>"$FFF_VM_RUN/path.lock"
  flock -n 9 || { log "path: another pass is running"; return 0; }
  TS="" DNS="" SELF4="" SELF6="" PW_OFF=""
  if [ "$portal" = yes ]; then
    pl_set 1 ok "http://$NET_VM_IP:$PORTAL_PORT/api/health answers"
  else
    pl_set 1 fail "http://$NET_VM_IP:$PORTAL_PORT/api/health does not answer (fff-vm watch alerts and resets on its own rules)"
  fi
  if ! pl_check_ssh; then
    pl_skip "not checked: ssh to the VM fails" 2 3 4 5 6 7 8 disk clock loop
  else
    pl_disk; pl_clock; pl_loop
    if [ "$portal" = yes ]; then
      pl_chain
    else
      # fff-vm watch alerts and resets on its own rules; the layers below say nothing the portal being down does not.
      pl_skip "not checked: the portal does not answer (layer 1)" 2 3 4 5 6 7 8
    fi
  fi
  if [ "$PW_EXPECT_FUNNEL" != 1 ]; then
    pl_set 9 skip "Funnel is not expected (PW_EXPECT_FUNNEL=$PW_EXPECT_FUNNEL)"
  elif [ -n "$PW_OFF" ]; then
    pl_set 9 skip "$PW_OFF"
  elif [ "$portal" != yes ]; then
    pl_set 9 skip "not checked: the portal does not answer (layer 1)"
  else
    pl_e2e || true
  fi
  pl_ntfy
  path_summary
  path_publish
  return 0
}

# ---------------------------------------------------------------- fff-vm watch status
# path_summary_line: one line for fff-vm status.
path_summary_line() {
  local id v bad="" never=1
  for id in $PL_IDS; do
    v=$(sget "L${id}_verdict" none)
    [ "$v" = none ] || never=0
    if [ "$v" = fail ]; then bad+=" $id"; fi
  done
  if [ "$never" = 1 ]; then echo "not checked yet (fff-vm watch)"; elif [ -n "$bad" ]; then echo "FAILING layer(s):$bad (sudo fff-vm watch status)"; else echo "every layer passes or is skipped (sudo fff-vm watch status)"; fi
}
cmd_watch_status() {
  local id v at since line
  echo "Portal path (internet → Funnel → portal), the last result of every layer; the journal has one line per layer per pass (journalctl -u fff-vm-watch):"
  printf '  %-6s %-22s %-5s %-9s %s\n' layer name state checked evidence
  for id in $PL_IDS; do
    v=$(sget "L${id}_verdict" none)
    at=$(sget "L${id}_at" 0)
    since=$(sget "L${id}_since" 0)
    line=$(sget "L${id}_line")
    printf '  %-6s %-22s %-5s %-9s %s\n' "$id" "$(pl_name "$id")" "$v" "$([ "$at" = 0 ] && echo never || echo "$((($(now) - at) / 60))m ago")" "$line"
    if [ "$v" = fail ] || [ "$v" = warn ]; then printf '  %-6s since %s%s\n' "" "$(iso "$since")" "$([ "$v" = fail ] && echo "; who: $(pl_who "$id")")"; fi
    [ -z "$(sget "L${id}_repair")" ] || printf '  %-6s last repair: %s\n' "" "$(sget "L${id}_repair")"
  done
  echo "  maintenance: $(in_maintenance && echo yes || echo no)"
}
