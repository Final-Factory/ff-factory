#!/bin/bash
# w6542 diagnostic (temporary): what /proc/$!/winpid names right after `node ... &` and a second later, under Git Bash.
# $1: iterations, $2: CPU burners
n=${1:-30}; burn=${2:-0}
burners=()
for ((b = 0; b < burn; b++)); do node -e 'for(;;){}' & burners+=($!); done
pids=(); w0s=(); w1s=(); e0s=(); e1s=()
for ((i = 0; i < n; i++)); do
  node -e 'setTimeout(()=>{},120000)' &
  p=$!
  w0=$(cat "/proc/$p/winpid" 2>&1); e0=$(cat "/proc/$p/exename" 2>&1)
  sleep 1
  w1=$(cat "/proc/$p/winpid" 2>&1); e1=$(cat "/proc/$p/exename" 2>&1)
  pids+=("$p"); w0s+=("$w0"); w1s+=("$w1"); e0s+=("$e0"); e1s+=("$e1")
done
snap=$(powershell.exe -NoProfile -NonInteractive -Command 'Get-CimInstance Win32_Process | ForEach-Object { "{0},{1},{2}" -f $_.ProcessId, $_.ParentProcessId, $_.Name }')
look() { local r; r=$(printf '%s\n' "$snap" | tr -d '\r' | grep -E "^$1," | head -1); echo "${r:-gone}"; }
kids() { printf '%s\n' "$snap" | tr -d '\r' | grep -E "^[0-9]+,$1," | tr '\n' ' '; }
for ((i = 0; i < n; i++)); do
  echo "diag $i burn=$burn pid=${pids[i]} early=${w0s[i]} [$(look "${w0s[i]}")] kids[$(kids "${w0s[i]}")] exe0=${e0s[i]} | late=${w1s[i]} [$(look "${w1s[i]}")] exe1=${e1s[i]}"
done
kill "${pids[@]}" "${burners[@]}" 2>/dev/null
wait 2>/dev/null
exit 0
