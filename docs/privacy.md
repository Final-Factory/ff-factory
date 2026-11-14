# Privacy guards (w17)

Ben, 2026-11-14: "add some security measures to prevent people from snooping in people's computers or invading anyone
privacy. this should apply to all factories".

`config.privacyGuards` turns both guards below on or off. Unset, they are on for every factory but Final Factory, whose
owners decide (`privacyGuardsOn`, server/config.ts).

An owner's orchestrator changes it on a running portal with set_app_config `privacyGuards` (true, false, or null for the
default). The old config.json is kept as config.json.prev, and the change applies at once: the portal's reads at once, and
new workers from their next launch.

## What a member reads on the portal

server/readAccess.ts, docs/identity.md "What a member reads". An owner reads everything. A member reads their own
orchestrator and the workers, reports, attachments and review media of the requests they are on. The routes that change a
session take the same check.

## What a worker may do on a computer

server/privacyGuard.ts, called from the worker guard (server/guard.ts) when the portal sends `guard.privacy`. A daemon older
than this ignores the field, so a computer is covered once its daemon is updated. The guard refuses:

- **a whole-desktop capture**: `screencapture` without `-l <window>` or `-R <region>`, ffmpeg `avfoundation`, `gdigrab -i
  desktop`, `ddagrab`, `CopyFromScreen` of the whole screen, and the like. A capture of one window (`-l`, `gdigrab -i
  title=...`), a region, or the editor's own capture tools still works;
- **camera, microphone and clipboard**: capture devices, `imagesnap`, `pbpaste`, `Get-Clipboard`, and the like;
- **a person's own files**: Desktop, Documents, Downloads, Pictures, cloud drives, mail, messages, browser and chat
  profiles, keychains and password managers, credential folders (`.ssh`, `.gnupg`, `.aws`, `gh`), and shell history.
  This covers the Read, Grep, Glob and LS tools and paths a command names, including `~`, `$HOME`, `%USERPROFILE%` and a
  climb such as `../../Desktop`. Another user's home folder and another factory's install folder on the same computer are
  refused too;
- **remote access to another computer**: `ssh`, `scp`, `sftp`, `rsync` over ssh, remote desktop and VNC. Git over ssh to
  a code forge still works;
- **a server on every network interface**: `python -m http.server` without `--bind 127.0.0.1`, `0.0.0.0`, `nc -l`, and
  the like. A server on 127.0.0.1 still works.

Folders a worker works in are never refused here: its sandbox, temp folder, the worker install, the skills, its Claude
config, and protected and granted folders.

Like the rest of the worker guard, this is a seatbelt over the commands an agent writes, not a security boundary: a
script file can still do what its command line does not show. The boundary would be a separate operating-system account
for workers (a question for each factory's owners, w17's report).
