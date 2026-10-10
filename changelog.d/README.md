# Changelog notes

One file per change, named for the request or topic (`w907-ci-conflict-wake.md`), holding the same bullet you would have put
under **[Unreleased]** in [CHANGELOG.md](../CHANGELOG.md). `npm run release` folds every `*.md` here (this README aside) into
the new version's notes, in file-name order, and removes them in the release commit.

Why not CHANGELOG.md itself (w907): every pull request added its bullet at the same spot, so each merge to `main` left the
others conflicting (#283, #287, #291 and #292 on 2026-10-10), and GitHub runs no CI on a conflicted pull request. A file of
your own cannot conflict. (A `.gitattributes` `merge=union` was the other option: GitHub's mergeability check does not run
merge drivers, so the pull request would still show a conflict and get no CI.)
