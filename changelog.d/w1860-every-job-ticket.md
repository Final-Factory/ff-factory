- A sandbox editor holds its shared bench ticket for as long as it runs (it was let go once the editor's bridge came
  up), and takes a new one when it loses it; the guard refuses an editor opened straight from the shell; a census test
  lists every place FF Factory starts a Unity or a game player with the ticket it holds (w1860).
- `unity-slot run` no longer runs without a bench ticket when its helper fails or the queue refuses it: it stops before
  the command, exit 77 for an exclusive ticket on a machine that takes no timed runs (w1861), 69 otherwise; the guard
  lets a granted worker reopen a person's own editor on the main clone (w936) (w1860).
