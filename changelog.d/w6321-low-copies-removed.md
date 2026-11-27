- **The daemon removes its old Low copies again, so a Low node copy can be made on Windows** (w6321, found by w6284 on
  LothDesktop). Node 22's unlink asks for FILE_WRITE_ATTRIBUTES as well as DELETE, which a read-only copy's access list
  (OWNER RIGHTS:(RX)) refuses, so a daemon on Node 22 could remove none of an earlier run's copies (EPERM, which was
  swallowed): all 20 names of LothDesktop's node and gh copies stayed taken and 22 old claude copies (about 8 GB) piled up.
  Measured on LothDesktop: Node 22.17.1 EPERM, Node 24.22.1 removes it. A copy Node cannot remove now goes through .NET's
  File.Delete (DELETE alone, given by the folder's delete-child right), all of them in one PowerShell call. After each copy
  is made, every older copy of claude, node and gh goes too, except this run's own copies of the other programs. Windows
  refuses to remove a copy a live process runs (measured), so one still running is kept, said with its error (once per
  daemon run for an old one), and tried again after the next copy is made. A copy is still never taken over (w5838).
  Tests: `lowIntegrity.test.ts`.
- **Review fix (w6325):** the File.Delete call lists each path once and goes in batches of at most 20 (and at most about
  21,000 characters of command line), so a backlog of any size fits; a batch whose call fails keeps only its own copies,
  said with that call's real error, and the others still go. The log no longer guesses "still running?". PowerShell
  quoting doubles the curly single quotes too. Measured with Node 22.17.1: 120 read-only copies Node could not remove
  (EPERM) all went in 2.1 s.
