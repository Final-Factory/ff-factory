- **steam_upload action status with no job answers the latest job when none runs** (w5694): it looked only for a running job, so
  on BEAST a status asked a second after a login check ended answered "No Steam job". `SteamJobs.latestOn` now gives the running
  job, else the computer's latest of any action. Test: `server/steamUpload.test.ts`, "status with no job finds the running check".
