- **Review videos in the chat start at once** (w1248, Ben: "these videos work but they take FOREVER to load"). The portal
  makes a web preview of each review-folder video (H.264, at most 1280 px on its long side, CRF 26, AAC 96k, index first
  with `+faststart`) when it is published, or on its first view, in `<topic>/.preview/`; the original is never touched.
  The inline player and the large view play the preview, and a **Full quality** link opens the original. On 3 real review
  clips the preview was 7 to 14% of the original (36.8 MB to 2.5 MB). Needs `ffmpeg` on the portal: the VM's guest
  `install.sh` installs it with the next update; without it every clip plays its original as before. Docs: review.md
  ("Web previews of videos"). Tests: `videoPreview.test.ts`, `e2e/video.spec.ts`.
