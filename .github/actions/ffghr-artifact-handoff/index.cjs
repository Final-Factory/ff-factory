// Hand one artifact to the host instead of uploading it from here.
//
// WHY. actions/upload-artifact PUTs to productionresultssa*.blob.core.windows.net, and that is the
// only thing on the CI egress allowlist that needs blob storage at all. The entry is a regex over
// a 110-name Azure namespace, and eleven of those names were unregistered and claimable by anyone
// with a free account -- an allowlisted, unauthenticated way out of the fence. Moving the upload to
// the host removes the NEED for the entry rather than narrowing it.
//
// A NODE ACTION, NOT A `run:` STEP. The runner injects ACTIONS_RUNTIME_TOKEN and ACTIONS_RESULTS_URL
// into ACTION environments only (Runner.Worker/Handlers/NodeScriptActionHandler.cs); a shell step
// cannot see them. Local (`uses: ./...`), so it is never downloaded and needs no entry in the
// image's ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE.
//
// THE HOST DOES NOT TRUST THIS FILE. It validates repository_id out of the token's own claims
// against a configured list before uploading anything -- measured 2026-09-02, the credential
// carries repository_id, repository_owner_id and job_workflow_ref, so a token minted for someone
// else's repository is refused on inspection. Nothing here has to be trusted, and nothing here is.
//
// NEVER FATAL. Reporting has never been allowed to fail a build and does not start here: every
// exit path is 0, and a hand-off that does not happen costs an artifact, not a job.
const { execFileSync } = require('child_process')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const OUT = process.env.FFGHR_OUT || '/ffghr/out'
// Generous against a 15s supervisor poll plus a transfer, and short against a 90-minute job.
const WAIT_SECONDS = Number(process.env.FFGHR_ARTIFACT_WAIT || 180)
const name = process.env.INPUT_NAME || ''
const src = process.env.INPUT_PATH || ''
const log = (m) => console.log(`[artifact-handoff] ${m}`)

function main() {
  if (!fs.existsSync(OUT)) return log(`no host drop box at ${OUT}; nothing handed over`)
  if (!name) return log('no name given; nothing handed over')
  if (!src || !fs.existsSync(src)) return log(`no such path: ${src || '(unset)'}; nothing handed over`)

  const token = process.env.ACTIONS_RUNTIME_TOKEN
  const results = process.env.ACTIONS_RESULTS_URL
  if (!token || !results) return log('no runtime credential in this environment; nothing handed over')

  let claims
  try {
    claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
  } catch (e) {
    return log(`could not decode the runtime credential: ${e.message}`)
  }
  // The only run identity the token carries, and what CreateArtifact is addressed by.
  const scope = String(claims.scp || '').split(' ').find((s) => s.startsWith('Actions.Results:'))
  if (!scope) return log('the credential carries no Actions.Results scope; nothing handed over')
  const [, runBackendId, jobBackendId] = scope.split(':')

  // Zip with the CLI rather than in node: the image has it, and a hand-rolled zip writer is a
  // liability for no gain. -r from inside the directory so entry paths are relative to it, which
  // is what actions/upload-artifact produces and what the run page expects.
  const zip = path.join(OUT, 'artifact.zip')
  try {
    fs.rmSync(zip, { force: true })
    execFileSync('zip', ['-r', '-q', zip, '.'], { cwd: src, stdio: ['ignore', 'inherit', 'inherit'] })
  } catch (e) {
    return log(`could not archive ${src}: ${e.message}`)
  }
  const bytes = fs.statSync(zip).size
  const sha = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex')

  const auth = {
    results_url: results,
    token,
    workflow_run_backend_id: runBackendId,
    workflow_job_run_backend_id: jobBackendId,
    // What the host checks. Present for its convenience only -- it re-reads them from the token.
    repository_id: String(claims.repository_id || ''),
    repository_owner_id: String(claims.repository_owner_id || ''),
    job_workflow_ref: String(claims.job_workflow_ref || ''),
    run_id: String(claims.run_id || ''),
    artifact_name: name,
    zip: 'artifact.zip',
    size: bytes,
    sha256: sha,
  }
  fs.writeFileSync(path.join(OUT, 'artifact-auth.json'), JSON.stringify(auth, null, 2) + '\n')
  // Written LAST: the supervisor keys off this file, so it must not appear before the two it
  // describes are complete on disk.
  fs.rmSync(path.join(OUT, 'artifact.done'), { force: true })
  fs.writeFileSync(path.join(OUT, 'artifact.request'), `${name}\n`)
  log(`handed over "${name}": ${bytes} bytes, sha256 ${sha.slice(0, 12)}, repository_id ${auth.repository_id}`)

  // AND NOW WAIT, WHICH IS THE POINT OF THE STEP RATHER THAN AN OPTIMISATION.
  //
  // The Actions service will not create an artifact for a job that has finished. Measured, and the
  // message is unambiguous:
  //
  //     CreateArtifact failed: HTTP 403 {"code":"permission_denied","msg":"job is completed"}
  //
  // So the supervisor cannot do this at teardown; it does it from its in-job poll, and the job has
  // to still be running when it does. Holding this step open is what keeps the job alive. Same
  // idiom main.yml already uses for fetch.request / fetch.done.
  //
  // The poll is 15s, so this normally returns inside one interval. NEVER FATAL: if the answer
  // never comes we give up, say so, and let the job finish -- a missing artifact is not a failed
  // build, and the old upload step is the fallback until it is removed.
  const deadline = Date.now() + WAIT_SECONDS * 1000
  const donePath = path.join(OUT, 'artifact.done')
  while (Date.now() < deadline) {
    if (fs.existsSync(donePath)) {
      log(`the host answered after ${Math.round((Date.now() - (deadline - WAIT_SECONDS * 1000)) / 1000)}s`)
      return
    }
    execFileSync('sleep', ['2'])
  }
  log(`no answer from the host within ${WAIT_SECONDS}s; giving up and letting the job finish`)
}

try { main() } catch (e) { log(`unexpected: ${e && e.message}`) }
