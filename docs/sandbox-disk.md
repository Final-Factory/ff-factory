# Sandbox disk size: where it goes and how to shrink it (w1576)

lothsahn, 2026-10-19: "Can you have a worker look into how we can drastically shrink the size of a workspace? There are
a ton of files in the workspace and I don't know if they're all actually needed or used."

**TL;DR:** A game sandbox on LothDesktop takes 24 to 33 GB, and almost none of it is shared on disk. The drive is a ReFS
Dev Drive, so identical bytes could be stored once, but they are not: of the 174 GB the sandboxes, the Library seed, the
player slots and `tmp` hold on disk, **134 GB is byte-identical copies of files stored elsewhere on the same drive**
(measured). Re-sharing those copies as block clones is the drastic cut: it brings a sandbox to its own changes, about 4
to 10 GB, without deleting anything a worker uses. Windows' own ReFS deduplication does that with no code, and it is
present on LothDesktop, but it needs an administrator and Microsoft documents it for Windows Server and Azure Local, not
Windows 11. The rest (leaving proof videos and FMOD source audio out of sandboxes, trimming build caches on release,
deleting unused assets) is worth 1 to 8 GB a sandbox each.

Measured on LothDesktop on 2026-10-19 between 21:50 and 22:40 UTC, read-only, while workers ran. Sizes are GiB
(2^30 bytes), written GB. "Measured" means a number from the tools below. "Sourced" means a vendor doc. "Estimate" means
my own inference.

## How it was measured

- **Logical sizes:** a walk of every file under `V:\ffw\sandboxes\slot{1,2,3,5,6}`, `V:\ffw\seed`, `V:\ffw\players` and
  `V:\ffw\tmp`.
- **Real disk use:** every file's cluster map (`FSCTL_GET_RETRIEVAL_POINTERS`, 1,058,255 extents, 4 KiB clusters). A
  cluster two files point at is a block clone, stored once. The union of all clusters is the real use. A root's
  *exclusive* GB is the clusters no other root points at, which is what deleting that root would free.
- **Duplicates:** every file of 64 KiB or more, grouped by size and then by a BLAKE2b hash. "Duplicate bytes" counts
  every copy after the first. It is a lower bound for what block-level dedup finds.
- **Copy-engine test:** a test of whether `Copy-Item` and `robocopy` block-clone on V: today. Both do: three copies of
  one file share every cluster (measured).
- **Not measured:**
  - The root's own clone, `V:\ffw\repo`. It is protected from workers. Its `.git/lfs` store holds at least one more copy
    of the 8.5 GB of LFS files.
  - BEAST. This worker had no route there.
- **Scripts:** in the w1576 worker's temp folder (`Phys.cs`, `dups.py`). They are not kept, and can be rewritten from
  the bullets above.

## Where a sandbox's disk goes

The drive: 300 GB, 105 to 107 GB free during the study (measured). The roots below hold 174.3 GB on disk (measured).
The other ~18 GB in use is the root's clone, `nightly` and the system (estimate: used minus measured).

| Root | Logical GB | Exclusive on disk GB | Byte-identical to a copy elsewhere GB |
|---|---|---|---|
| slot1 | 23.8 | 21.6 | 10.0 (the first copy of the tracked tree was counted here) |
| slot2 | 32.8 | 30.8 | 22.5 |
| slot3 | 25.0 | 22.7 | 21.0 |
| slot5 | 26.2 | 22.9 | 22.6 |
| slot6 | 28.1 | 25.9 | 22.1 |
| seed (`V:\ffw\seed\Library`) | 10.1 | 10.1 | 0.2 |
| players (12 slots) | 22.4 | 6.9 | 17.2 |
| tmp (8 worker folders) | 30.7 | 21.6 | 18.1 |
| **All** | **199** | **174.3 on disk (union)** | **133.7** |

Inside one sandbox (slot2 and slot3, logical GB; every row is exclusive to its sandbox unless noted; all measured):

| Part | slot2 | slot3 | Needed for | Regenerable |
|---|---|---|---|---|
| Tracked tree: Assets | 5.8 | 5.8 | everything | from git |
| Tracked tree: specs/ (2.4 GB of it mp4, 2.5 GB under `*/proofs/`) | 3.1 | 3.1 | nothing at run time | from git |
| Tracked tree: FMODProject/ | 1.0 | 1.0 | `Build/Desktop` banks (0.06) and `Narration` (a test reads it) | from git |
| Library/Artifacts | 6.6 | 5.9 | the editor | by reimport (slow) |
| Library/EntitySceneBundles | 3.2 | 3.5 | player builds | by a build |
| Library/PlayerDataCache | 2.9 | 1.4 (shared with other slots) | player builds | by a build |
| Library/BurstCache | 2.8 | 0 | player builds | by a build |
| Library/PackageCache | 2.0 | 2.0 | the editor | from the package cache |
| Library/Bee | 1.7 | 1.2 | incremental script compiles | by a full compile |
| Library/ShaderCache, BuildCache, Search, the rest | 1.6 | 0.9 | the editor and builds | yes |
| Builds/ | 1.8 | 0 | the worker's last builds | by a build |
| Temp/, obj/, Logs/ | ~0 | ~0 (slot5's Temp: 1.3) | the running editor | yes |

What the tables say:

1. **The tracked tree is about 10 GB, and every sandbox holds its own copy.** `git worktree` and Git LFS write full
   copies. 8.5 GB of the 10 is LFS (measured: `git lfs ls-files`, 5,023 files). The five copies share nothing on disk
   (measured).
2. **The Libraries were meant to be block clones of the seed, and they are not.** slot3 holds 9,684 of the seed's
   10,076 artifact files, with the same names, sizes and modification times, and 41,725 of its 42,325 PackageCache files.
   Yet slot3 shares 0.06 GB with the seed on disk, and the five sandboxes share almost nothing with each other.
   - FF Factory's design says the Library is cloned from the seed at provision and at the Dev Drive move
     (`machine/sandboxes.ts:433-448`, `server/proc.ts:188-206`, `docs/worker-install.md` steps 3-4 of the move). The
     copy engine clones today (measured, above).
   - So the copies made when these sandboxes were created on 2026-10-11 (Library folders created 23:21 to 23:35, the
     seed at 22:47) were either full copies, or were later rewritten in place with the same contents. I could not tell
     which without the daemon's own log, which workers cannot read.
3. **Sandboxes grow past the seed.** A sandbox Library holds 24,000 to 25,000 artifact files against the seed's 10,076.
   Its build caches (EntitySceneBundles, PlayerDataCache, BurstCache, Bee, Builds) add 4 to 12 GB once the worker
   builds a player. Whether Artifacts keeps stale entries, and how to reclaim them, is w1575's question.
4. **Player slots** copy the same build into 12 folders. They share part of it (6.9 GB exclusive of 22.4), and 17.2 GB is
   still duplicate. `players\slot4-0` and `slot4-1` (1.85 GB each) are named after slot4, which w1575 deleted; I did not check who holds them.

## Options

Each option is per sandbox unless it says "drive".

| # | Option | Saves | Cost | Risk | Where |
|---|---|---|---|---|---|
| A1 | **Turn on ReFS deduplication on V:** (`Enable-ReFSDedup -Volume V: -Type Dedup`, then a nightly `Set-ReFSDedupSchedule` with a duration cap) | Drive: up to the 133.7 GB of whole-file duplicates and more at block level (lower bound, measured). Per sandbox: 21 to 23 GB, leaving each at its own 4 to 10 GB. | One admin step. A first job reads the whole drive once (an hour or more, estimate), then incremental runs. Savings decay as files are rewritten until the next run. | Microsoft documents it for Windows Server 2025 and Azure Local (sourced). On Windows 11 the cmdlets and `ReFsDedupSvc` exist on LothDesktop (measured, build 26300), but client support is undocumented (guess: works). It cannot run alongside Windows Data Deduplication. Disabling it leaves data deduped (sourced). Try it on a scratch ReFS VHDX first. | Machine setting; FF Factory's SYSTEM helper (`ffsb-helper`) could own the schedule |
| A2 | **FF Factory re-clone pass** (no admin): for each file in a released sandbox that matches the seed or another sandbox by size and hash, share its extents (`FSCTL_DUPLICATE_EXTENTS_TO_FILE`), in place | The whole-file share of A1: about 21 GB per sandbox (measured duplicates) | Code in the daemon. One read of the sandboxes per pass (minutes). | Low if it runs only on released sandboxes and files not open. Any write unshares a file again, which is safe. | FF Factory daemon |
| A3 | **Fix provisioning so a new sandbox shares from the start.** Check the clone share after `copyTree` and say so when it is near 0. Clone LFS files from the clone's `.git/lfs/objects` after checkout. | Library: about 7 GB (Artifacts 5.2, PackageCache 1.9, measured). Tracked tree: up to 8.5 GB (LFS, measured). | Seconds per provision. | Low | FF Factory (`machine/sandboxes.ts`) |
| B | **Leave proof media out of sandboxes**: a sparse checkout without `specs/**/*.{mp4,png,jpg,gif,webm}`, and new proofs go to `publish_review` instead of the repo | 3.1 GB (measured) | An agent that wants an old proof fetches it on demand. | Low. Needs per-worktree sparse checkout (`extensions.worktreeConfig`); merges and `ff-pr` are unaffected. | FF Factory provisioning; the "no proof media in git" rule goes in the game repo |
| C | **Leave FMOD source audio out of sandboxes**: sparse `!FMODProject/**/Assets/Soundtrack/`, `!…/Production/` | 0.9 GB (measured) | None at run time. Unity reads banks from `FMODProject/finalfactory-fmod/Build` (`Assets/Plugins/FMOD/Resources/FMODStudioSettings.asset:217-220`). | Low to medium. The FMOD integration's source-project features (event browser) may warn. Keep `Narration`: `Assets/Tests/Objectives/NarrationClipsTest.cs:113` hashes a file there. | FF Factory provisioning |
| D | **Trim player-build caches on release** (EntitySceneBundles, PlayerDataCache, Builds older than the newest; today only BuildCache and BurstCache are trimmed, `server/cleanup.ts:202`, `server/cacheTrim.ts`) | 4 to 8 GB in a sandbox that built a player (measured) | The next player build in that sandbox is a full one (minutes, estimate). | Low: all regenerable | FF Factory clean-up |
| E | **Drop the Library of a sandbox idle for days**, re-clone it from the seed when the sandbox is next used | 17 to 21 GB per idle sandbox today, only its own changes after A | Import of what changed since the seed (minutes, estimate), unless A3 makes the re-clone near free | Low; it is the existing remove-and-provision path | FF Factory pool |
| F | **Refresh the seed from master** (weekly, or after a release), so new sandboxes start close to master | Shrinks what a new sandbox imports and owns; little on its own with A | One import in a spare sandbox | Low | FF Factory pool |
| G | **Unity Accelerator (cache server)** | 0 GB of disk (estimate): the Accelerator stores import results and serves them to editors (sourced: Unity's Accelerator manual), and each editor keeps what it downloads in its own `Library/Artifacts`. It saves import time, which makes E cheaper. | A service to run. | Low | Machine; game repo settings |
| H | **Fewer sandboxes** | About 25 GB per sandbox today, about 4 to 10 GB after A | Less parallel work | None | FF Factory pool size |
| I | **Delete unused assets from the repo** | Up to 3.6 GB of Assets that no scene, prefab, Resources folder or code name reaches (measured GUID scan, transitive), of which: Audio/Music 0.87 (wavs that duplicate the FMOD source), GabrielAguiarProductions 1.2, Art 0.8 (two PSDs of 115 and 99 MB), ExternalAssets 0.46; raw art (`.psd` 0.57, `.blend` 0.22, `.blend1` backups 0.20, `.rar` 0.05) | A build and a playtest per batch | Medium. A GUID scan misses loads by computed path, Addressables labels, shaders by name and editor tools. Changes the game repo. | Game repo, lothsahn's decision |
| J | **Player slots share their build** (copy into a slot with a block-clone copy) | Drive: up to 17 GB (measured duplicates) | None | Low | Game repo `scripts/nightly/player_slots.py` |

Sparse checkout of other folders gains little: everything else tracked is under 0.1 GB. Partial clone (`--filter`)
saves little here (estimate): the worktrees already share one clone's objects, and the big files are LFS.

## Recommendation

In this order, by GB saved per unit of risk:

1. **A1 on LothDesktop as a trial** (lothsahn's decision: an admin step on a machine).
   - First, a ten-minute test on a small scratch ReFS VHDX shows whether Windows 11 runs it.
   - Then V:, with a nightly schedule capped at 2 hours.
   - Measure `Get-ReFSDedupStatus` and V: free space before and after.
   - Expected: 80 to 130 GB back on the drive (estimate from the 133.7 GB measured duplicates, less what is rewritten
     between runs).
   - If Windows 11 refuses it, do A2 instead: the same files shared by FF Factory's own code, with no admin.
2. **A3**, so a new sandbox starts shared and the daemon says when a copy did not clone. This is the fault the study
   found: the seed design is right, but today's Libraries do not share it.
3. **B and C** in FF Factory's provisioning: 4 GB a sandbox at almost no cost. Add a game-repo rule that proof media go
   through `publish_review`, not into `specs/`.
4. **D**, then **E**, in FF Factory's clean-up, once A has made a re-clone cheap.
5. **I** only as a separate, reviewed game-repo change. It is worth 1 to 3.6 GB a sandbox and carries the most risk.

G is not a disk saving. H is the fallback if A fails. J is small and can go with the next `player_slots.py` change.

The unused-asset candidate lists (GUID scan, raw art, duplicates, specs by folder) were written to the w1576 worker's
temp folder and published as FF Factory attachment `att_p0hdy2lymi80` (`w1576-sandbox-disk-data.zip`), not kept in this repo.
