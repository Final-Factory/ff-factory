# FF Factory (w6038): sourced by the hooks beside it, which every ffu slot's checkout runs (ffu-slot take sets the shared
# clone's core.hooksPath to this folder, in FF Factory's own code, which no worker writes). A worker's git write in a slot
# its session (FF_SESSION_ID) does not hold, or on a branch other than the one ffu-slot recorded for the slot, is refused,
# naming the slot, its holder and the holder's branch (w5681 merged into another worker's branch from a slot path a saved
# script named). The holder is read from `<slot>/holder`, which ffu-slot writes beside the checkout with slots.json
# (machine/ffuSlots.ts writeHolderFiles). Shell builtins only, no git or other program: a hook runs on every ref update.
#
# No check (exit 0): no FF_SESSION_ID (a person's shell, the daemon), a folder that is no slot checkout, or a slot with no
# holder file yet. FF Factory's own git (ffu-slot, ff-pr, the daemon) runs with core.hooksPath on server/gitHooks and never
# reaches this; ff-pr checks the same in machine/ffuSlots.ts slotWriteRefusal.

# ffu_slot_guard <what>: prints the refusal and returns 1, or returns 0.
ffu_slot_guard() {
  [ -n "${FF_SESSION_ID:-}" ] || return 0
  case "$PWD" in
    */ffu-sandboxes/slot*/ffu) ;;
    *) return 0 ;;
  esac
  _fsg_dir=${PWD%/ffu}
  [ -f "$_fsg_dir/holder" ] || return 0
  _fsg_slot=${_fsg_dir##*/}
  _fsg_holder=
  _fsg_branch=
  while read -r _fsg_k _fsg_v; do
    case $_fsg_k in
      holder) _fsg_holder=$_fsg_v ;;
      branch) _fsg_branch=$_fsg_v ;;
    esac
  done <"$_fsg_dir/holder"
  _fsg_on=${_fsg_branch:-origin/main, detached}
  _fsg_fix="Take your own slot and work there: eval \"\$(ffu-slot take --branch <your branch>)\" (ffu-slot where --branch <b> names the one you hold). A merge stopped here leaves its files merged: git merge --abort puts them back (w6038)."
  if [ "$_fsg_holder" != "$FF_SESSION_ID" ]; then
    if [ -n "$_fsg_holder" ]; then
      echo "ffu-slot: refused: $1 in ffu slot $_fsg_slot ($PWD), which session $_fsg_holder holds on branch $_fsg_on; you are session $FF_SESSION_ID. That is another worker's checkout. $_fsg_fix" >&2
    else
      echo "ffu-slot: refused: $1 in ffu slot $_fsg_slot ($PWD), which no session holds (released; last on branch $_fsg_on); you are session $FF_SESSION_ID. $_fsg_fix" >&2
    fi
    return 1
  fi
  [ -n "$_fsg_branch" ] || return 0
  # The checkout's branch, from its HEAD file (a worktree's .git file names its git folder).
  _fsg_cur=
  _fsg_g=.git
  if [ -f .git ]; then
    read -r _fsg_line <.git
    _fsg_g=${_fsg_line#gitdir: }
  fi
  if [ -f "$_fsg_g/HEAD" ]; then
    read -r _fsg_line <"$_fsg_g/HEAD"
    case $_fsg_line in
      "ref: refs/heads/"*) _fsg_cur=${_fsg_line#ref: refs/heads/} ;;
    esac
  fi
  # Detached (a rebase, or a branch another slot has checked out: push with HEAD:<branch>) is the recorded branch's own work.
  if [ -n "$_fsg_cur" ] && [ "$_fsg_cur" != "$_fsg_branch" ]; then
    echo "ffu-slot: refused: $1 on branch $_fsg_cur in ffu slot $_fsg_slot ($PWD): your session $FF_SESSION_ID holds this slot for branch $_fsg_branch, and ffu-slot recorded no other. Go back with git switch $_fsg_branch, or take a slot for $_fsg_cur: eval \"\$(ffu-slot take --branch $_fsg_cur)\" (w6038)." >&2
    return 1
  fi
  return 0
}
