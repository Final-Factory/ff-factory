# Privacy guards (w17)

Ben, 2026-11-14: "add some security measures to prevent people from snooping in people's computers or invading anyone
privacy. this should apply to all factories".

## What a member does on the portal

shared/actAccess.ts, docs/identity.md "What a member acts on". Ben, 2026-11-14: "you can see the other persons transcripts
you just cant interact with it". Everyone signed in reads every session, transcript, request and file. A member changes
only their own orchestrator and the workers of the requests they are on: a message, a rename, a delete, a stop or an
answer to anyone else's answers 403. This is on in every factory, Final Factory included, and no setting turns it off.

`config.privacyGuards` turns the worker guard below on or off. Unset, it is on for every factory but Final Factory, whose
owners decide (`privacyGuardsOn`, server/config.ts).

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
