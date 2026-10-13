# Review media: publish_review

**TL;DR:** a worker anywhere, on this host or on a machine (LothDesktop, the Macs), puts stills, clips and notes for a
review into one folder on the portal's computer with the `publish_review` tool. The files travel over FF Factory's own
link, so no machine needs ssh, scp or a share to BEAST. The tool answers the paths written, and a report with those
paths shows the images inline for the orchestrator and the person.

(w309, asked by Lothsahn: "do the permanent fix that doesn't involve SSHing into other machines". Workers on
LothDesktop and the Macs could not copy proofs into `F:\ffsb\_review\<topic>\`, because ssh from those machines to BEAST
is refused.)

## The tool

`publish_review {topic, files, note?}`: `mcp__sandbox__publish_review` in a host sandbox, `mcp__machine__publish_review`
on a machine and in a machine's sandbox.

- `topic`: a short folder name ("w283-enemy-attacks"). Letters, digits, `.`, `_` and `-` are kept; anything else becomes
  `-`, and leading dots and dashes go, so a topic is always one folder directly under the root (`../../x` becomes `x`;
  `..`, empty and Windows device names are refused).
- `files`: paths on the worker's computer, absolute or relative to its working folder. Each keeps its base name, made
  safe the same way, with its extension in lower case.
- `note`: written beside the files as `note.md` (who published it and when, the words, the file names).

It answers, for example:

```
Published 2 file(s) on BEAST:
- F:\ffsb\_review\w283-enemy-attacks\attack.mp4 (9.0 MB, sha256 3f2a…)
- F:\ffsb\_review\w283-enemy-attacks\shot.png (39 KB, sha256 77c1…)
Put these paths in your report as they are; an image shows inline as ![what it shows](F:\ffsb\_review\w283-enemy-attacks\shot.png). They are on BEAST, not on this computer.
```

The page serves any file under the review root as an image or video for every session (`imageRoots` in
`server/index.ts`), so the inline image works in a machine worker's own transcript and in the orchestrator's relay.

## Rules

| Rule | Where |
|---|---|
| The root is `review.root` in config.json, default `<sandboxRoot>/_review` (`F:\ffsb\_review` on BEAST). | `server/index.ts` |
| Types: `.png .jpg .jpeg .gif .webp .bmp .svg .mp4 .webm .mov .m4v .mkv .avi .md .txt .json .zip`, by extension. Anything else is refused (415). | `REVIEW_TYPES`, `reviewName` |
| Caps: `review.maxFileMB` (200) per file, `review.maxCallMB` (500) per call, `review.maxFiles` (40) per call. Checked before a byte moves (413). | `ReviewStore.check` |
| Nothing is overwritten: a name already in the topic is written as `name-2.ext`, `name-3.ext`, …, with an exclusive create (a hard link, or a copy with `COPYFILE_EXCL`), so two publishers racing cannot clobber each other. Other topics are never touched. | `ReviewStore.place` |
| Files are bytes only: never opened, unpacked or run. | |

## How a machine's files travel

1. The daemon (`machine/review.ts`) reads each file, takes its size and SHA-256, and calls the portal's `publish_review`
   over the existing rpc with the names, sizes and hashes only.
2. The portal (`Agents.reviewPlan`, `ReviewStore.plan`) checks topic, names, types and caps, writes the note, and answers
   one upload id per file (`rv_` and 24 hex digits), bound to that machine.
3. The daemon sends each file to `PUT /machine/review/<uploadId>?offset=N` with its own machine token, in 8 MB chunks
   (the portal takes at most 16 MB per request). A chunk that would pass the announced size is cut back (413); a wrong
   offset answers 409 with where to resume; after a dropped connection the daemon asks `GET` the same URL and resumes.
4. With the last byte the portal checks the SHA-256, links the file into its topic and answers the path. A mismatch
   drops the upload (422) and the worker publishes again.

Another machine's token, or none, gets 404 or 401. An upload left unfinished for a day is dropped; uploads in progress
do not survive a portal restart (the daemon gets 404 and the worker publishes again). A worker on this host gets a
plain copy (`ReviewStore.publishLocal`).

A file in the review folder can go on to a worker as an attachment: an orchestrator or the dispatcher calls
`attach_review_file` with its path and passes the id it answers with `attachments: [id]`
([attachments.md](attachments.md#agents-files)).

## Web previews of videos

**TL;DR:** the chat plays a small copy of each review video, and a **Full quality** link opens the original (w1248, Ben:
"these videos work but they take FOREVER to load"; earlier: "sometimes I might need a really high-fidelity video, but most
of the time I don't").

Workers' clips are 60 fps captures at 4 to 20 Mbit/s, and half of them have their index (`moov`) at the end of the file,
so a browser must fetch the end before it can play (measured on 40 review clips, w1248). The portal (`server/videoPreview.ts`)
makes a preview of every review-folder `.mp4`, `.m4v` and `.webm`:

| What | Where |
|---|---|
| H.264 at most 1280 px on its long side (never upscaled), CRF 26, `veryfast`, AAC 96k, `-movflags +faststart`. 7 to 14% of the original on 3 real clips, 5 to 11 s to make on 2 cores. | `previewArgs` |
| Written to `<topic>/.preview/<name>.mp4` (`clip.mp4` → `.preview/clip.mp4.mp4`) through a `.part` file. The original is never opened for writing. | `previewPathOf`, `VideoPreviews.make` |
| Made when the file is published (`ReviewStore.onPublished`), or on its first view. One encode at a time, at nice 10, ended after 10 minutes. A failed encode is not tried again until the portal restarts. | `VideoPreviews.ensure` |
| Retention: a preview lives in its original's topic folder and goes with it; one whose original is gone is removed with the next encode in that topic, and one older than its original is made again. | `VideoPreviews.prune`, `ready` |
| `GET /api/image?…&preview=1` on a review video sends the preview, with HTTP ranges (206) like any video; it waits up to 30 s for one being made, then sends the original. No ffmpeg (`FF_FFMPEG`, else `ffmpeg` on PATH), or not a review file: the original. | `server/index.ts` `/api/image` |
| The page: the inline player and the large view ask for `&preview=1`; on a player error they fall back to the original once. **Full quality** in the caption, and the large view's open and download buttons, are the original. | `web/src/components/Images.tsx` `PreviewVideo`, `FullQualityLink` |

The VM's guest `install.sh` installs `ffmpeg` (every portal update runs it).
