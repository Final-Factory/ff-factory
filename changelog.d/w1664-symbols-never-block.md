- **A symbol upload no longer slows or blocks a post, and a post whose answer came late answers posted** (w1664; lothsahn:
  "The patch notes uploaded to discord but the worker thought they didn't. … make sure … uploading symbols is fast,
  reliable, and doesn't block patch notes from uploading"). `file_ffbox_symbols` sends its parts on a sliding window of
  eight (it sent four and waited for all four: 271.8 KB/s measured for 45.0 MB), and the parts no longer count against the
  eight queries the views and posts may have waiting, so a post is never `busy` behind an upload. `post_as_max` asks again
  with the same key when FFBox's answer does not come (within 75 s of the daemon's 90): the key answers the post FFBox
  made, with its link, instead of "may have been posted". FFBox answers posts on a thread of its own (ffbox w1664).
  docs/ffbox.md, "Posting as Max" and "Symbols of an urgent-lane build".
