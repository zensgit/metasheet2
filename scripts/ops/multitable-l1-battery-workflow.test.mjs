#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// Owner-review P1 fix (2026-08-21): the `Scrub credentials on deploy host` step
// (id: scrub-creds) added to .github/workflows/multitable-l1-battery.yml. The
// battery step's own in-script `rm -rf` (defense in depth, still present) is
// skipped entirely by a cancelled run, an SSH drop, a runner kill, or any
// remote-script failure before those lines run — this file proves the
// always()-gated backstop step actually closes that gap: it removes the
// CURRENT run's host + in-container credential dirs, sweeps both locations for
// STALE (>24h) leftovers from any earlier crashed run, verifies afterward that
// nothing remains, and fails the JOB (no continue-on-error) if verification
// finds residue. Modeled on multitable-recovery-schema-containment.test.mjs's
// extract-and-run-under-bash harness (PATH-shadowing docker stub, argv log).
//
// Scope note: always() survives cancellation but not a hard runner-VM kill —
// the stale sweep, not the always()-gate alone, is what closes THAT case.

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const workflowPath = join(repoRoot, '.github', 'workflows', 'multitable-l1-battery.yml')
const workflowText = readFileSync(workflowPath, 'utf8')

// ---------------------------------------------------------------------------
// Step-block / run-body / remote-heredoc extraction (mirrors
// multitable-recovery-schema-containment.test.mjs's extractLocalRunScript /
// extractRemoteScript pattern, generalized to name a step by its `- name:`
// line so it works for any of this workflow's now-THREE `<<'REMOTE'` blocks).
// ---------------------------------------------------------------------------

const SCRUB_STEP_NAME_LINE = '      - name: Scrub credentials on deploy host'
const BATTERY_STEP_NAME_LINE = '      - name: Run L1 battery on staging'
const RESIDUE_STEP_NAME_LINE = '      - name: Residue check — o2bat_% leftovers on staging'

function extractStepBlock(text, stepNameLine) {
  const lines = text.split('\n')
  const startIdx = lines.indexOf(stepNameLine)
  assert.ok(startIdx >= 0, `workflow must contain the step line: ${stepNameLine}`)
  let endIdx = lines.length
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^      - name:/.test(lines[i])) {
      endIdx = i
      break
    }
  }
  return lines.slice(startIdx, endIdx).join('\n') + '\n'
}

// De-indents a step's `run: |` block scalar body exactly as the Actions
// runner would receive it (10-space fixed indent stripped), same convention
// as the precedent's extractLocalRunScript/extractRemoteScript.
function extractRunBody(stepBlockText) {
  const lines = stepBlockText.split('\n')
  const runIdx = lines.findIndex((l) => /^        run: \|\s*$/.test(l))
  assert.ok(runIdx >= 0, 'step must have a `run: |` block')
  return (
    lines
      .slice(runIdx + 1)
      .map((l) => (l.startsWith('          ') ? l.slice(10) : l))
      .join('\n') + '\n'
  )
}

// Extracts the body between `<<'REMOTE'` and the bare `REMOTE` terminator
// from an ALREADY DE-INDENTED run body (extractRunBody output).
function extractRemoteHeredoc(runBodyText) {
  const lines = runBodyText.split('\n')
  const startIdx = lines.findIndex((l) => /<<'REMOTE'/.test(l))
  assert.ok(startIdx >= 0, "run body must open a remote heredoc with <<'REMOTE'")
  let endIdx = -1
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i] === 'REMOTE') {
      endIdx = i
      break
    }
  }
  assert.ok(endIdx > startIdx, "run body must close the remote heredoc with REMOTE")
  return lines.slice(startIdx + 1, endIdx).join('\n') + '\n'
}

const scrubBlock = extractStepBlock(workflowText, SCRUB_STEP_NAME_LINE)
const batteryBlock = extractStepBlock(workflowText, BATTERY_STEP_NAME_LINE)
const residueBlock = extractStepBlock(workflowText, RESIDUE_STEP_NAME_LINE)
const scrubRunBody = extractRunBody(scrubBlock)
const scrubRemoteBody = extractRemoteHeredoc(scrubRunBody)

// ---------------------------------------------------------------------------
// Pure structural-guard predicates over TEXT — reused by both the "against
// the real file" assertions and the "mutation-prove" tests below, so the two
// can never silently diverge into different definitions of the same guard.
// ---------------------------------------------------------------------------

function hasContinueOnError(stepBlockText) {
  return /^\s*continue-on-error:/m.test(stepBlockText)
}

function alwaysGuardPresent(stepBlockText) {
  const ifLine = stepBlockText.split('\n').find((l) => /^\s*if:/.test(l))
  return Boolean(ifLine && /\balways\(\)/.test(ifLine))
}

// The verify-after-scrub guard is only meaningful if EACH detection (host,
// container) is actually WIRED to `fail=1` on the very next line — a mutation
// that keeps the VERIFY-FAIL log line but neuters the `fail=1` into a no-op
// must red this, so the check ties the message to the assignment rather than
// checking either in isolation.
function verifyAfterScrubGuardPresent(remoteBodyText) {
  const hostWired = /VERIFY-FAIL: host secrets dir still present after rm -rf:[^\n]*"\s*\n\s*fail=1\b/.test(
    remoteBodyText,
  )
  const containerWired =
    /VERIFY-FAIL: in-container secrets dir verification did not return ABSENT[^\n]*"\s*\n\s*fail=1\b/.test(
      remoteBodyText,
    )
  const failCloses = /if \[\[ "\$fail" != "0" \]\]; then\s*\n\s*log "VERDICT: FAIL/.test(remoteBodyText)
  return hostWired && containerWired && failCloses
}

// ---------------------------------------------------------------------------
// 1. STRUCTURAL GUARDS — parse the YAML text.
// ---------------------------------------------------------------------------

// NIT (gate follow-up): the >24h stale sweep must also be VERIFIED — a failed sweep
// (rm under `set -uo pipefail` / `|| true`) that leaves stale dirs must red, not report PASS.
// Ties each "stale … remain after sweep" VERIFY-FAIL to a `fail=1` on the next line, host and
// container both, so neutering either reds this.
function staleSweepVerifiedGuardPresent(remoteBodyText) {
  const hostWired = /VERIFY-FAIL: \$\{host_stale_left\} stale \(>24h\) host credential dir\(s\) remain after sweep"\s*\n\s*fail=1\b/.test(
    remoteBodyText,
  )
  const containerWired =
    /VERIFY-FAIL: \$\{cstale_out\} stale \(>24h\) in-container credential dir\(s\) remain after sweep"\s*\n\s*fail=1\b/.test(
      remoteBodyText,
    )
  // the container count must be a positive-result assertion (fail-closed on non-integer):
  const containerFailClosed = /in-container stale-sweep verification did not return a count[^\n]*"\s*\n\s*fail=1\b/.test(
    remoteBodyText,
  )
  return hostWired && containerWired && containerFailClosed
}

test('structural: the >24h stale sweep is verified (remaining stale dirs red the job), host and container', () => {
  assert.ok(
    staleSweepVerifiedGuardPresent(scrubRemoteBody),
    'a failed stale sweep must fail the job, not silently report PASS — wire each "stale … remain" detection to fail=1, and fail-close the container count',
  )
})

test('structural: scrub-creds step exists with the expected id, placed after residue-check', () => {
  assert.match(scrubBlock, /^\s*id: scrub-creds\s*$/m)
  const residueIdx = workflowText.indexOf(RESIDUE_STEP_NAME_LINE)
  const scrubIdx = workflowText.indexOf(SCRUB_STEP_NAME_LINE)
  assert.ok(residueIdx >= 0 && scrubIdx > residueIdx, 'scrub-creds must be placed AFTER residue-check')
})

test('structural: scrub-creds if: contains always() (guard is present against the real file)', () => {
  assert.equal(alwaysGuardPresent(scrubBlock), true)
  // Also pin the full condition so a silent narrowing (e.g. dropping the
  // stage-creds outcome check) shows up as a text diff, not just a boolean.
  assert.match(
    scrubBlock,
    /if: always\(\) && steps\.ssh-setup\.outcome == 'success' && steps\.stage-creds\.outcome != 'skipped'/,
  )
})

test('structural: scrub-creds is NOT continue-on-error, while the battery step above IS', () => {
  assert.equal(hasContinueOnError(scrubBlock), false, 'scrub-creds must fail the job on scrub failure')
  assert.equal(hasContinueOnError(batteryBlock), true, 'battery step must remain continue-on-error: true so residue-check and scrub-creds always get their turn')
})

test('structural: env: wires the remote-secrets-dir OUTPUT, and the run: body never inline-interpolates a GH expression', () => {
  const envSection = scrubBlock.slice(scrubBlock.indexOf('env:'), scrubBlock.indexOf('run: |'))
  assert.match(
    envSection,
    /REMOTE_SECRETS_DIR: \$\{\{ steps\.stage-creds\.outputs\.remote_secrets_dir \}\}/,
    'env: must wire the stage-creds output',
  )
  assert.ok(
    !scrubRunBody.includes('${{'),
    'the run: body (including the remote heredoc) must never contain a literal `${{` — values must arrive as shell env vars, never spliced GH-expression text',
  )
})

test('structural: stale-sweep find patterns are present for BOTH host and in-container locations', () => {
  assert.ok(
    scrubBlock.includes("find /tmp -maxdepth 1 -name 'l1-battery-creds-*' -type d -mmin +1440 -exec rm -rf {} +"),
    'host stale sweep must use the exact specified find invocation',
  )
  assert.ok(
    scrubBlock.includes("find /tmp -maxdepth 1 -name 'o2bat-creds-*' -type d -mmin +1440 -exec rm -rf {} +"),
    'in-container stale sweep must use the exact specified find invocation',
  )
  // A non-destructive -print pass must exist for BOTH, ahead of the -exec rm -rf pass, so names are
  // logged (never contents) before removal.
  const hostPrintIdx = scrubBlock.indexOf("find /tmp -maxdepth 1 -name 'l1-battery-creds-*' -type d -mmin +1440 -print")
  const hostRmIdx = scrubBlock.indexOf("find /tmp -maxdepth 1 -name 'l1-battery-creds-*' -type d -mmin +1440 -exec rm -rf {} +")
  assert.ok(hostPrintIdx >= 0 && hostPrintIdx < hostRmIdx, 'host: -print pass must precede the -exec rm -rf pass')
  const containerPrintIdx = scrubBlock.indexOf("find /tmp -maxdepth 1 -name 'o2bat-creds-*' -type d -mmin +1440 -print")
  const containerRmIdx = scrubBlock.indexOf("find /tmp -maxdepth 1 -name 'o2bat-creds-*' -type d -mmin +1440 -exec rm -rf {} +")
  assert.ok(containerPrintIdx >= 0 && containerPrintIdx < containerRmIdx, 'container: -print pass must precede the -exec rm -rf pass')
})

test('structural: verify-after-scrub guard is present against the real file (host + container, both wired to fail=1)', () => {
  assert.equal(verifyAfterScrubGuardPresent(scrubRemoteBody), true)
})

test('structural: current-run removal targets exactly the RUN_STAMP-derived container path the battery step also uses', () => {
  const runStampLine = 'run_stamp="gh${GITHUB_RUN_ID}a${GITHUB_RUN_ATTEMPT}"'
  assert.ok(scrubBlock.includes(runStampLine), 'scrub-creds must construct RUN_STAMP identically to the battery step')
  assert.ok(batteryBlock.includes(runStampLine), 'battery step must construct run_stamp identically (sanity: precedent unchanged)')
  assert.ok(scrubRemoteBody.includes('container_creds_dir="/tmp/o2bat-creds-${RUN_STAMP}"'))
})

test('structural: scrub-creds ssh_opts is byte-identical to the residue-check step\'s ssh_opts (same pinned pattern)', () => {
  function sshOptsLine(text) {
    const m = text.match(/^\s*ssh_opts="([^"]+)"$/m)
    assert.ok(m, 'step must define ssh_opts')
    return m[1]
  }
  const scrubOpts = sshOptsLine(scrubBlock)
  const residueOpts = sshOptsLine(residueBlock)
  assert.equal(scrubOpts, residueOpts)
  assert.match(scrubOpts, /-o StrictHostKeyChecking=yes/)
  assert.match(scrubOpts, /UserKnownHostsFile=\$HOME\/\.ssh\/known_hosts/)
})

test('structural: no executable StrictHostKeyChecking=no anywhere in the workflow (comments-only occurrences are fine)', () => {
  const insecureExecutableLines = workflowText
    .split('\n')
    .filter((line) => line.includes('StrictHostKeyChecking=no') && !line.trimStart().startsWith('#'))
  assert.deepEqual(insecureExecutableLines, [])
})

test('structural: the header GUARD RAILS block documents the credential lifecycle and that scrub failure fails the job', () => {
  const header = workflowText.slice(0, workflowText.indexOf('\non:\n'))
  assert.match(header, /Credential lifecycle \(staged → used → scrubbed\)/)
  assert.match(header, /scrub-creds/)
  assert.match(header, /FAILS THE JOB/)
})

// ---------------------------------------------------------------------------
// 2. FAILURE INJECTION — extract the REMOTE bash body and actually run it.
// ---------------------------------------------------------------------------

const stubBase = mkdtempSync(join(tmpdir(), 'l1-scrub-behavior-'))
const binDir = join(stubBase, 'bin')
mkdirSync(binDir)

// PATH-shadowing `docker`: records full argv to $STUB_DOCKER_LOG, then answers
// deterministically from STUB_* env vars — NOT a real container, so `rm`
// sub-invocations are recorded but have no filesystem effect; the verify
// probe (`sh -c 'if [ -d "$1" ] ... echo PRESENT/ABSENT'`) answers directly
// from STUB_CONTAINER_CREDS_PRESENT so verification is independently
// controllable from whatever `rm` calls were made.
const DOCKER_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_DOCKER_LOG"
cmd="\${1:-}"; shift || true
case "$cmd" in
  ps)
    printf '%s\\n' "\${STUB_PS_NAMES:-}"
    exit 0 ;;
  exec)
    shift || true
    sub="\${1:-}"
    case "$sub" in
      rm)
        exit 0 ;;
      sh)
        shift || true
        shift || true
        inline="\${1:-}"
        case "$inline" in
          *'echo PRESENT'*)
            if [[ "\${STUB_CONTAINER_VERIFY_EXEC_FAIL:-0}" == "1" ]]; then
              exit 7
            fi
            if [[ "\${STUB_CONTAINER_CREDS_PRESENT:-0}" == "1" ]]; then
              echo PRESENT
            else
              echo ABSENT
            fi
            exit 0 ;;
          *'-print'*)
            printf '%s\\n' "\${STUB_CONTAINER_STALE_PRINT:-}"
            exit 0 ;;
          *'-exec rm -rf'*)
            exit 0 ;;
          *' | wc -l'*)
            # the stale-sweep-REMAINING count query (NIT verify). Default 0 = none remain
            # (happy path / post-sweep). STUB_CONTAINER_STALE_COUNT overrides for the
            # failure-injection case; STUB_CONTAINER_STALE_COUNT_NONINT makes it emit a
            # non-integer to exercise the fail-closed branch.
            if [[ "\${STUB_CONTAINER_STALE_COUNT_NONINT:-0}" == "1" ]]; then
              printf '%s\n' "not-a-number"
            else
              printf '%s\n' "\${STUB_CONTAINER_STALE_COUNT:-0}"
            fi
            exit 0 ;;
          *)
            echo "stub: unrecognized docker exec sh -c script: $inline" >&2
            exit 96 ;;
        esac ;;
      *)
        echo "stub: unknown docker exec sub: $sub" >&2
        exit 98 ;;
    esac ;;
  *)
    echo "stub: unknown docker cmd: $cmd" >&2
    exit 99 ;;
esac
`
writeFileSync(join(binDir, 'docker'), DOCKER_STUB)
chmodSync(join(binDir, 'docker'), 0o755)

// PATH-shadowing `rm`: records argv, then either performs the REAL removal
// (default — needed so the stale-sweep positive control and the "verify
// passes" happy path are proven against real fs state) or, when
// STUB_RM_NOOP=1, silently no-ops (used to manufacture a host-side
// verification-failure case without relying on a real race).
const RM_STUB = `#!/usr/bin/env bash
printf 'rm %s\\n' "$*" >> "$STUB_RM_LOG"
if [[ "\${STUB_RM_NOOP:-0}" == "1" ]]; then
  exit 0
fi
exec /bin/rm "$@"
`
writeFileSync(join(binDir, 'rm'), RM_STUB)
chmodSync(join(binDir, 'rm'), 0o755)

// PATH-shadowing `find`: a TRANSPARENT pass-through to the real `find` binary,
// with exactly one behavioral addition — when the first non-option argument is
// literally `/tmp`, it adds `-L` before delegating. This exists ONLY to defeat a
// macOS/BSD-find-specific quirk that has nothing to do with the workflow's own
// correctness: on macOS `/tmp` is a symlink to `/private/tmp`, and BSD find does
// NOT follow a top-level symlink argument by default, so
// `find /tmp -maxdepth 1 -name '<pattern>' -type d` (the EXACT, unmodified
// invocation this workflow ships) silently finds NOTHING on macOS regardless of
// whether a matching directory exists — a platform artifact of the local test
// runner, not of the production target (ubuntu-latest, where /tmp is a plain
// directory and GNU find has no such caveat). Rather than skip the case locally
// or rewrite the shipped script to use `-L` (which would test something the
// workflow does NOT do), this shim makes local runs see what ubuntu-latest
// already sees, so the SAME test proves real mtime-based selectivity on both
// platforms with no skip anywhere.
const REAL_FIND = ['/usr/bin/find', '/bin/find'].find((p) => existsSync(p))
assert.ok(REAL_FIND, 'a real `find` binary must exist at /usr/bin/find or /bin/find to build the transparent shim')
const FIND_STUB = `#!/usr/bin/env bash
if [[ "\${1:-}" == "/tmp" ]]; then
  shift
  exec ${REAL_FIND} -L /tmp "$@"
fi
exec ${REAL_FIND} "$@"
`
writeFileSync(join(binDir, 'find'), FIND_STUB)
chmodSync(join(binDir, 'find'), 0o755)

const remoteScriptPath = join(stubBase, 'scrub-remote.sh')
writeFileSync(remoteScriptPath, scrubRemoteBody)

let runSeq = 0
function runScrubRemote(envOverrides = {}) {
  const id = runSeq++
  const dockerLog = join(stubBase, `docker-log-${id}.txt`)
  const rmLog = join(stubBase, `rm-log-${id}.txt`)
  writeFileSync(dockerLog, '')
  writeFileSync(rmLog, '')
  const env = {
    PATH: `${binDir}:/usr/bin:/bin`,
    STUB_DOCKER_LOG: dockerLog,
    STUB_RM_LOG: rmLog,
    // Every case must supply REMOTE_SECRETS_DIR and RUN_STAMP: both are
    // referenced under `set -u` in the remote body (RUN_STAMP unguarded), so
    // an unset one aborts the script before any assertion-relevant line runs.
    REMOTE_SECRETS_DIR: '',
    RUN_STAMP: 'ghTESTa1',
    STUB_PS_NAMES: 'metasheet-staging-backend',
    STUB_CONTAINER_CREDS_PRESENT: '0',
    ...envOverrides,
  }
  const result = spawnSync('bash', [remoteScriptPath], { env, encoding: 'utf8' })
  assert.equal(result.error, undefined, `bash must spawn cleanly: ${result.error && result.error.message}`)
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    dockerLog: readFileSync(dockerLog, 'utf8'),
    rmLog: readFileSync(rmLog, 'utf8'),
  }
}

function makeHostSecretsFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'l1-scrub-fixture-'))
  writeFileSync(join(dir, 'email'), 'admin@example.invalid')
  writeFileSync(join(dir, 'password'), 'not-a-real-secret')
  return dir
}

test('behavior (a) normal: both rms invoked, verification passes, exit 0', () => {
  const fixture = makeHostSecretsFixture()
  try {
    const r = runScrubRemote({
      REMOTE_SECRETS_DIR: fixture,
      RUN_STAMP: 'ghANORMALa1',
      STUB_PS_NAMES: 'metasheet-staging-backend',
      STUB_CONTAINER_CREDS_PRESENT: '0',
    })
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.ok(r.rmLog.includes(fixture), `host rm must be invoked on the fixture dir: ${r.rmLog}`)
    assert.match(r.dockerLog, /^ps --format/m)
    assert.match(r.dockerLog, /^exec metasheet-staging-backend rm -rf \/tmp\/o2bat-creds-ghANORMALa1$/m)
    assert.match(
      r.dockerLog,
      /^exec metasheet-staging-backend sh -c if \[ -d "\$1" \]; then echo PRESENT; else echo ABSENT; fi sh \/tmp\/o2bat-creds-ghANORMALa1$/m,
      'container verify probe must be invoked with the exact expected path argv',
    )
    assert.match(r.stdout, /VERDICT: PASS — current-run credentials scrubbed on host and in container/)
    assert.equal(existsSync(fixture), false, 'fixture dir must be actually removed from disk (real rm, not just logged)')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('behavior (b) container down: host dir still removed, container scrub skipped with a log line, exit 0', () => {
  const fixture = makeHostSecretsFixture()
  try {
    const r = runScrubRemote({
      REMOTE_SECRETS_DIR: fixture,
      RUN_STAMP: 'ghBDOWNa1',
      STUB_PS_NAMES: '', // docker ps prints nothing → container not running
    })
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.ok(r.rmLog.includes(fixture), 'host removal must still happen when the container is down')
    assert.doesNotMatch(r.dockerLog, /^exec /m, 'no `docker exec` may be attempted against a container that is not running')
    assert.match(r.stdout, /container 'metasheet-staging-backend' is not running — nothing to scrub inside a dead container/)
    assert.match(r.stdout, /VERDICT: PASS — current-run credentials scrubbed on host \(container not running\)/)
    assert.equal(existsSync(fixture), false)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('behavior (c-host) verification failure: rm silently no-ops on the host dir → verify catches it → exit nonzero', () => {
  const fixture = makeHostSecretsFixture()
  try {
    const r = runScrubRemote({
      REMOTE_SECRETS_DIR: fixture,
      RUN_STAMP: 'ghCHOSTa1',
      STUB_RM_NOOP: '1', // simulates an rm that "succeeds" without actually removing anything
      STUB_CONTAINER_CREDS_PRESENT: '0',
    })
    assert.notEqual(r.status, 0, 'a directory that survives rm must fail the step, not silently pass')
    assert.ok(r.rmLog.includes(fixture), 'rm must still have been ATTEMPTED (argv proves the call happened)')
    assert.match(r.stdout, /VERIFY-FAIL: host secrets dir still present after rm -rf/)
    assert.match(r.stdout, /VERDICT: FAIL/)
    assert.doesNotMatch(r.stdout, /VERDICT: PASS/)
    assert.equal(existsSync(fixture), true, 'positive control: the fixture genuinely still exists (the no-op rm really did nothing)')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('behavior (c-container-present) verification failure: container verify probe reports PRESENT → exit nonzero', () => {
  const r = runScrubRemote({
    REMOTE_SECRETS_DIR: '',
    RUN_STAMP: 'ghCCONTa1',
    STUB_CONTAINER_CREDS_PRESENT: '1', // simulates docker exec rm having silently not worked
  })
  assert.notEqual(r.status, 0)
  assert.match(r.stdout, /VERIFY-FAIL: in-container secrets dir verification did not return ABSENT \(got 'PRESENT'\)/)
  assert.match(r.stdout, /VERDICT: FAIL/)
  assert.doesNotMatch(r.stdout, /VERDICT: PASS/)
  // The verify probe must actually have been invoked (argv, not just the stdout it produced).
  assert.match(
    r.dockerLog,
    /^exec metasheet-staging-backend sh -c if \[ -d "\$1" \]; then echo PRESENT; else echo ABSENT; fi sh \/tmp\/o2bat-creds-ghCCONTa1$/m,
  )
})

test('behavior (c-container-execfail) verification failure: the verify docker exec itself errors (empty output) → treated as FAIL, not PASS', () => {
  // This is the exact fail-open shape a naive `docker exec ... test -d` (error-absence
  // check) would miss: the exec fails for a reason unrelated to directory absence, and
  // `... || true` turns that into an empty string. The positive-result assertion in the
  // workflow (require literally "ABSENT") must treat "empty" as failure, not success.
  const r = runScrubRemote({
    REMOTE_SECRETS_DIR: '',
    RUN_STAMP: 'ghCEXECFAILa1',
    STUB_CONTAINER_VERIFY_EXEC_FAIL: '1',
  })
  assert.notEqual(r.status, 0, 'an unverifiable (exec-failed) container check must never be read as a pass')
  assert.match(r.stdout, /VERIFY-FAIL: in-container secrets dir verification did not return ABSENT \(got '<empty>'\)/)
  assert.match(r.stdout, /VERDICT: FAIL/)
  assert.doesNotMatch(r.stdout, /VERDICT: PASS/)
  // The verify probe must actually have been invoked and made to fail by the shim (argv,
  // not just the empty-string effect it had on stdout).
  assert.match(
    r.dockerLog,
    /^exec metasheet-staging-backend sh -c if \[ -d "\$1" \]; then echo PRESENT; else echo ABSENT; fi sh \/tmp\/o2bat-creds-ghCEXECFAILa1$/m,
  )
})

test('behavior (d-container) stale sweep: in-container stale dirs are printed by name and the removal call is issued', () => {
  const r = runScrubRemote({
    REMOTE_SECRETS_DIR: '',
    RUN_STAMP: 'ghDCONTa1',
    STUB_CONTAINER_STALE_PRINT: '/tmp/o2bat-creds-oldrun1\n/tmp/o2bat-creds-oldrun2',
    STUB_CONTAINER_CREDS_PRESENT: '0',
  })
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
  assert.match(r.stdout, /removing stale in-container dir: \/tmp\/o2bat-creds-oldrun1/)
  assert.match(r.stdout, /removing stale in-container dir: \/tmp\/o2bat-creds-oldrun2/)
  assert.match(
    r.dockerLog,
    /^exec metasheet-staging-backend sh -c find \/tmp -maxdepth 1 -name 'o2bat-creds-\*' -type d -mmin \+1440 -print$/m,
  )
  assert.match(
    r.dockerLog,
    /^exec metasheet-staging-backend sh -c find \/tmp -maxdepth 1 -name 'o2bat-creds-\*' -type d -mmin \+1440 -exec rm -rf \{\} \+$/m,
  )
})

test('behavior (e-container-stale-remains) NIT: a container stale dir surviving the sweep fails the job', () => {
  // The load-bearing proof of the NIT fix: if the in-container >24h sweep leaves a dir behind
  // (rm failed / permissions / daemon flake), the post-sweep count is non-zero and the step must
  // FAIL — not report PASS. Without the added verification this run was exit 0.
  const r = runScrubRemote({
    REMOTE_SECRETS_DIR: '',
    RUN_STAMP: 'ghECONTa1',
    STUB_CONTAINER_CREDS_PRESENT: '0',
    STUB_CONTAINER_STALE_COUNT: '2', // two stale dirs remain after the sweep
  })
  assert.notEqual(r.status, 0, `a surviving container stale dir must fail the job; stdout: ${r.stdout}`)
  assert.match(r.stdout, /VERIFY-FAIL: 2 stale \(>24h\) in-container credential dir\(s\) remain after sweep/)
})

test('behavior (f-container-stale-nonint) NIT: a non-integer stale count is treated as verification failure (fail-closed)', () => {
  const r = runScrubRemote({
    REMOTE_SECRETS_DIR: '',
    RUN_STAMP: 'ghFCONTa1',
    STUB_CONTAINER_CREDS_PRESENT: '0',
    STUB_CONTAINER_STALE_COUNT_NONINT: '1', // docker exec yields a non-count (flake) → must NOT pass
  })
  assert.notEqual(r.status, 0, `a non-integer container stale count must fail the job, not silently pass; stdout: ${r.stdout}`)
  assert.match(r.stdout, /VERIFY-FAIL: in-container stale-sweep verification did not return a count/)
})

test('behavior (g-host-stale-remains) NIT: a host stale dir surviving the sweep fails the job', () => {
  // Manufacture a REAL >24h host dir and make rm a no-op so the sweep cannot remove it; the
  // post-sweep host count is then non-zero and the step must FAIL.
  const staleDir = join('/tmp', `l1-battery-creds-staleproof-${process.pid}-${Date.now()}`)
  mkdirSync(staleDir, { recursive: true })
  // set mtime to 48h ago so -mmin +1440 selects it (seconds, matching the d-host fixture)
  const twoDaysAgo = Date.now() / 1000 - 2 * 86400
  utimesSync(staleDir, twoDaysAgo, twoDaysAgo)
  try {
    const r = runScrubRemote({
      REMOTE_SECRETS_DIR: '',
      RUN_STAMP: 'ghGHOSTa1',
      STUB_PS_NAMES: '', // container down — isolate the host path
      STUB_RM_NOOP: '1', // the sweep's rm cannot actually remove the stale dir
    })
    assert.notEqual(r.status, 0, `a surviving host stale dir must fail the job; stdout: ${r.stdout}`)
    assert.match(r.stdout, /VERIFY-FAIL: [0-9]+ stale \(>24h\) host credential dir\(s\) remain after sweep/)
  } finally {
    rmSync(staleDir, { recursive: true, force: true })
  }
})

// ---- (d-host) stale sweep — real filesystem ----
//
// Runs through the SAME PATH-shadowed `find` used by every other case above (which
// transparently defeats the macOS /tmp-symlink quirk — see its definition/comment
// above), so this proves real mtime-based selectivity unconditionally, with no skip,
// on both macOS (local) and ubuntu-latest (CI).
test('behavior (d-host) stale sweep: only the >24h-old host fixture is printed and removed; the fresh one survives', () => {
  const uniq = `${process.pid}-${Date.now()}`
  const staleDir = join('/tmp', `l1-battery-creds-wftest-${uniq}-stale`)
  const freshDir = join('/tmp', `l1-battery-creds-wftest-${uniq}-fresh`)
  mkdirSync(staleDir)
  mkdirSync(freshDir)
  const twoDaysAgo = Date.now() / 1000 - 2 * 86400
  utimesSync(staleDir, twoDaysAgo, twoDaysAgo)
  try {
    // Positive control: the SAME shimmed find (sans -mmin) must see BOTH fixtures before
    // we assert anything about time-based selectivity — otherwise "fresh survives" would
    // be indistinguishable from "find can't see either of them".
    const control = spawnSync(
      'bash',
      ['-c', `find /tmp -maxdepth 1 -name 'l1-battery-creds-wftest-${uniq}-*' -type d`],
      { env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` }, encoding: 'utf8' },
    )
    const controlNames = (control.stdout || '').split('\n').filter(Boolean)
    assert.equal(controlNames.length, 2, `positive control must see both fixtures: ${JSON.stringify(controlNames)}`)

    const r = runScrubRemote({
      REMOTE_SECRETS_DIR: '',
      RUN_STAMP: 'ghDHOSTa1',
      STUB_PS_NAMES: '', // keep this case focused on the host sweep only
    })
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.match(r.stdout, new RegExp(`removing stale host dir: ${staleDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.doesNotMatch(r.stdout, new RegExp(freshDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal(existsSync(staleDir), false, 'the >24h-old fixture must actually be removed from disk')
    assert.equal(existsSync(freshDir), true, 'the fresh fixture must survive (selectivity, not a blanket sweep)')
  } finally {
    rmSync(staleDir, { recursive: true, force: true })
    rmSync(freshDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. MUTATION-PROVE the structural guards — in-memory string mutation only
// (this repo has zero precedent for in-place mutation of a committed file
// inside an automated test, and every guard here is a pure function over
// text; see the manual on-disk cp-backup verification pass in the PR/report
// for the additional real-file mutation+restore evidence).
// ---------------------------------------------------------------------------

test('mutation-prove: always() guard reds when removed, and ONLY that guard reds (verify-after-scrub is unaffected)', () => {
  assert.equal(alwaysGuardPresent(scrubBlock), true, 'sanity: guard holds against the real, unmutated block')
  assert.equal(verifyAfterScrubGuardPresent(scrubRemoteBody), true, 'sanity: the other guard also holds beforehand')

  const mutatedBlock = scrubBlock.replace(
    "if: always() && steps.ssh-setup.outcome == 'success' && steps.stage-creds.outcome != 'skipped'",
    "if: steps.ssh-setup.outcome == 'success' && steps.stage-creds.outcome != 'skipped'",
  )
  assert.notEqual(mutatedBlock, scrubBlock, 'mutation must actually change the text')
  assert.equal(alwaysGuardPresent(mutatedBlock), false, 'removing always() must red the always() guard')

  // Independence: this mutation touches only the `if:` line, nowhere near the remote
  // heredoc body, so the verify-after-scrub predicate (evaluated on the untouched remote
  // body) must still hold — proving the two guards are not accidentally coupled.
  assert.equal(verifyAfterScrubGuardPresent(scrubRemoteBody), true)
})

test('mutation-prove: verify-after-scrub guard reds when a fail=1 wire is neutered, and ONLY that guard reds (always() is unaffected)', () => {
  assert.equal(verifyAfterScrubGuardPresent(scrubRemoteBody), true, 'sanity: guard holds against the real, unmutated body')
  assert.equal(alwaysGuardPresent(scrubBlock), true, 'sanity: the other guard also holds beforehand')

  // Neuter the HOST branch's fail=1 into a no-op while leaving its log line intact — a
  // check that merely greps for the VERIFY-FAIL string (ignoring whether it's wired to
  // fail=1) would NOT catch this; the tied regex must. Match indentation-tolerantly (via
  // regex) rather than a hand-typed literal, so this test doesn't itself bit-rot on a
  // future reflow of the step's indentation.
  const hostFailRe = /(VERIFY-FAIL: host secrets dir still present after rm -rf: \$\{REMOTE_SECRETS_DIR\}"\n\s*)fail=1\b/
  assert.match(scrubRemoteBody, hostFailRe, 'sanity: the host fail=1 wire must exist in the real text to be mutated')
  const mutatedRemoteBody = scrubRemoteBody.replace(hostFailRe, '$1:')
  assert.notEqual(mutatedRemoteBody, scrubRemoteBody, 'mutation must actually change the text')
  assert.equal(verifyAfterScrubGuardPresent(mutatedRemoteBody), false, 'neutering fail=1 must red the verify-after-scrub guard')

  assert.equal(alwaysGuardPresent(scrubBlock), true, 'the if: line (a different part of the block) must be unaffected')
})

test('mutation-prove: neutering the CONTAINER branch\'s fail=1 also reds the guard independently of the host branch', () => {
  const containerFailRe = /(VERIFY-FAIL: in-container secrets dir verification did not return ABSENT[^\n]*"\n\s*)fail=1\b/
  assert.match(scrubRemoteBody, containerFailRe, 'sanity: the container fail=1 wire must exist in the real text to be mutated')
  const mutatedRemoteBody = scrubRemoteBody.replace(containerFailRe, '$1:')
  assert.notEqual(mutatedRemoteBody, scrubRemoteBody, 'mutation must actually change the text')
  assert.equal(verifyAfterScrubGuardPresent(mutatedRemoteBody), false)
})

// ---------------------------------------------------------------------------
// 4. LOCAL RUN-BODY PROPAGATION — the FULL `run: |` block (not just the remote
// heredoc), stubbing `ssh` itself. This is the load-bearing link the failure-
// injection tests above do NOT cover: they run the remote body directly under
// bash, bypassing `ssh $ssh_opts ... <<'REMOTE' | tee ...` entirely. A remote
// script that correctly exits 1 is worthless if `set -euo pipefail` /
// `${PIPESTATUS[...]}` handling in the LOCAL half doesn't carry that exit code
// through the `| tee` pipe to the step's own exit status — that is exactly the
// class of bug 源码文本断言≠行为断言 warns about. The `ssh` stub below drains
// its heredoc stdin (bash never blocks) and exits with a caller-controlled
// code, standing in for "the remote script would have exited N".
// ---------------------------------------------------------------------------

const SSH_PROPAGATION_STUB = `#!/usr/bin/env bash
printf 'ssh %s\\n' "$*" >> "$STUB_SSH_LOG"
cat >/dev/null 2>&1 || true
if [[ -n "\${STUB_SSH_STDOUT:-}" ]]; then
  printf '%s\\n' "$STUB_SSH_STDOUT"
fi
exit "\${STUB_SSH_EXIT:-0}"
`
writeFileSync(join(binDir, 'ssh'), SSH_PROPAGATION_STUB)
chmodSync(join(binDir, 'ssh'), 0o755)

const scrubLocalScriptPath = join(stubBase, 'scrub-local.sh')
writeFileSync(scrubLocalScriptPath, scrubRunBody)

let localRunSeq = 0
function runScrubLocal(envOverrides = {}) {
  const id = localRunSeq++
  const sshLog = join(stubBase, `ssh-log-${id}.txt`)
  writeFileSync(sshLog, '')
  const cwd = mkdtempSync(join(tmpdir(), 'l1-scrub-local-cwd-'))
  const fakeHome = mkdtempSync(join(tmpdir(), 'l1-scrub-local-home-'))
  const env = {
    PATH: `${binDir}:/usr/bin:/bin`,
    HOME: fakeHome,
    STUB_SSH_LOG: sshLog,
    GITHUB_RUN_ID: '999',
    GITHUB_RUN_ATTEMPT: '1',
    DEPLOY_HOST: 'deploy.invalid',
    DEPLOY_USER: 'deployer',
    REMOTE_SECRETS_DIR: '/tmp/l1-battery-creds-999-1',
    ...envOverrides,
  }
  const result = spawnSync('bash', [scrubLocalScriptPath], { env, cwd, encoding: 'utf8' })
  assert.equal(result.error, undefined, `bash must spawn cleanly: ${result.error && result.error.message}`)
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    sshLog: readFileSync(sshLog, 'utf8'),
    scrubLog: (() => {
      try {
        return readFileSync(join(cwd, 'output', 'l1-battery', 'scrub.log'), 'utf8')
      } catch {
        return ''
      }
    })(),
  }
}

test('local run-body: ssh reached with the exact pinned StrictHostKeyChecking=yes options, REMOTE_SECRETS_DIR/RUN_STAMP passed as VAR=value argv (not baked into the heredoc)', () => {
  const r = runScrubLocal({ STUB_SSH_EXIT: '0', STUB_SSH_STDOUT: '[scrub] VERDICT: PASS — current-run credentials scrubbed on host and in container; stale (>24h) sweep completed' })
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
  assert.match(r.sshLog, /-o StrictHostKeyChecking=yes/)
  assert.doesNotMatch(r.sshLog, /StrictHostKeyChecking=no/)
  assert.match(r.sshLog, /REMOTE_SECRETS_DIR=\/tmp\/l1-battery-creds-999-1/)
  assert.match(r.sshLog, /RUN_STAMP=gh999a1/)
  assert.match(r.scrubLog, /VERDICT: PASS/, 'the tee target file must capture the remote stdout')
})

test('local run-body: a remote (simulated ssh) exit 1 PROPAGATES through `| tee` to the step exit code (this is the actual mechanism "scrub failure fails the job" relies on)', () => {
  const r = runScrubLocal({ STUB_SSH_EXIT: '1', STUB_SSH_STDOUT: '[scrub] VERDICT: FAIL — credential residue remains after scrub; a stranded credential file is worse than a red job' })
  assert.notEqual(r.status, 0, 'set -euo pipefail (pipefail) must carry the ssh exit code through the `| tee` pipe to the step')
  assert.match(r.scrubLog, /VERDICT: FAIL/, 'the failing remote output must still have reached the tee log before the step aborts')
})

test('local run-body mutation-prove: dropping `pipefail` from `set -euo pipefail` lets a remote failure hide behind `tee`\'s own exit 0', () => {
  // `tee` (the LAST command in the pipe) exits 0 as long as it can write its file, so
  // WITHOUT pipefail, `$?` after `ssh ... | tee ...` reflects tee, not ssh — a remote
  // exit 1 would be silently swallowed. This is the actual failure mode
  // "set -euo pipefail" defends against; assert it structurally on the real block AND
  // prove behaviorally that removing it flips the propagation test above from red to green.
  assert.match(scrubRunBody, /^set -euo pipefail$/m, 'sanity: the real run body sets pipefail')
  const mutatedRunBody = scrubRunBody.replace(/^set -euo pipefail$/m, 'set -eu')
  assert.notEqual(mutatedRunBody, scrubRunBody, 'mutation must actually change the text')

  const mutatedScriptPath = join(stubBase, 'scrub-local-mutated-nopipefail.sh')
  writeFileSync(mutatedScriptPath, mutatedRunBody)
  const sshLog = join(stubBase, 'ssh-log-mutated.txt')
  writeFileSync(sshLog, '')
  const cwd = mkdtempSync(join(tmpdir(), 'l1-scrub-local-mut-cwd-'))
  const fakeHome = mkdtempSync(join(tmpdir(), 'l1-scrub-local-mut-home-'))
  const result = spawnSync('bash', [mutatedScriptPath], {
    env: {
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: fakeHome,
      STUB_SSH_LOG: sshLog,
      STUB_SSH_EXIT: '1',
      STUB_SSH_STDOUT: '[scrub] VERDICT: FAIL — credential residue remains after scrub',
      GITHUB_RUN_ID: '999',
      GITHUB_RUN_ATTEMPT: '1',
      DEPLOY_HOST: 'deploy.invalid',
      DEPLOY_USER: 'deployer',
      REMOTE_SECRETS_DIR: '/tmp/l1-battery-creds-999-1',
    },
    cwd,
    encoding: 'utf8',
  })
  assert.equal(result.error, undefined)
  assert.equal(
    result.status,
    0,
    'without pipefail, a remote exit 1 is masked by `tee`\'s own exit 0 — this IS the bug pipefail exists to prevent, reproduced here to prove the real script needs it',
  )
})
