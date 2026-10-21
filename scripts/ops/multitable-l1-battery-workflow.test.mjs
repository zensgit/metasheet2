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
// CURRENT run's host credential dir, sweeps for STALE (>24h) leftovers from any
// earlier crashed run, verifies afterward that nothing remains, and fails the
// JOB (no continue-on-error) if verification finds residue. Modeled on
// multitable-recovery-schema-containment.test.mjs's extract-and-run-under-bash
// harness (PATH-shadowing docker stub, argv log).
//
// Scope note: always() survives cancellation but not a hard runner-VM kill —
// the stale sweep, not the always()-gate alone, is what closes THAT case.
//
// ---------------------------------------------------------------------------
// SECOND owner-review P1 (2026-08-21), and the reason several cases below were
// REWRITTEN rather than extended:
//
// The battery step used to `docker cp` the staging admin email/password INTO the
// backend container (/tmp/o2bat-creds-<stamp>/), and this step's in-container
// scrub was gated on `docker ps`. A STOPPED container is absent from `docker ps`,
// so the scrub logged "nothing to scrub inside a dead container" and the step
// still printed `VERDICT: PASS` — while the credential sat in the container's
// WRITABLE LAYER, fully readable. Reproduced with real Docker:
//
//   $ docker cp password c:/tmp/o2bat-creds-ghREPROa1/password && docker stop c
//   $ docker ps --format '{{.Names}}' | grep -qxF c     # => absent
//   $ docker exec c cat /tmp/o2bat-creds-ghREPROa1/password
//     Error response from daemon: container ... is not running
//   $ docker cp c:/tmp/o2bat-creds-ghREPROa1/password - | tar -xO
//     s3cr3t-99                                          # 9 bytes, recovered
//
// The old `behavior (b) container down` case in this file PINNED that blind spot
// green: it asserted `VERDICT: PASS` and `doesNotMatch(/^exec /)` for exactly the
// state in which a copied-in secret survives. It has been replaced by cases that
// assert the NEW contract:
//
//   1. INGESTION: nothing is ever written into the container. Credentials are
//      piped to `docker exec -i` on stdin as a two-line KEY=<base64> blob and
//      exported in-process. Structurally gated by the MECHANISM, not by a path
//      literal: no `docker cp` anywhere in the workflow may have a
//      container-prefixed DESTINATION.
//   2. SCRUB: the in-container residue proof is state-INDEPENDENT. It uses
//      `docker cp` (which reads a non-running container's writable layer, where
//      `docker exec` refuses), behind a docker-daemon liveness control and an
//      /etc/hostname positive control, so an unreachable daemon or an unusable
//      probe FAILS instead of masquerading as "absent".
//   3. A container-down run may only PASS on a PROVEN enumeration of that
//      container's writable layer — never on a skip.
//
// `golden (real Docker)` at the bottom runs the SHIPPED scrub body against a real
// non-running container, in both the leaking and the clean shape.
// ---------------------------------------------------------------------------

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

test('battery provenance logging uses a defined shell builtin, never the scrub-only log helper', () => {
  assert.match(
    batteryBlock,
    /printf '%s\\n' "provenance: image=\$\{image_digest:-<unset>\} commit=\$\{build_commit:-<unset>\}"/,
  )
  assert.doesNotMatch(
    batteryBlock,
    /\blog "provenance:/,
    'the battery remote body does not define log(); using it loses the line with command-not-found',
  )
})
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
  // Re-pointed by the second owner-review P1 at the STATE-INDEPENDENT probe that
  // replaced the `docker ps`-gated `docker exec ... ABSENT/PRESENT` verification.
  // Deliberately NOT widened to "old wording OR new wording": an either/or predicate
  // would keep both mutation-prove tests below green while discriminating nothing.
  const containerWired =
    /VERIFY-FAIL: in-container credential path EXISTS in the writable layer:[^\n]*"\s*\n\s*fail=1\b/.test(
      remoteBodyText,
    )
  const failCloses = /if \[\[ "\$fail" != "0" \]\]; then\s*\n\s*log "VERDICT: FAIL/.test(remoteBodyText)
  return hostWired && containerWired && failCloses
}

// The two CONTROLS that make every in-container absence claim a positive result
// rather than error-absence. Each must be tied to a `fail=1` on the following line:
//   * docker daemon liveness — discriminates "no such container" (writable layer
//     destroyed with it ⇒ genuinely nothing) from "docker is broken" (⇒ unknown).
//   * `docker cp` positive control on a path that must exist — discriminates
//     "credential path absent" from "the probe cannot read this container at all".
function inContainerProbeControlsPresent(remoteBodyText) {
  const daemonControl =
    /docker version --format '\{\{\.Server\.Version\}\}' >\/dev\/null 2>&1/.test(remoteBodyText) &&
    /VERIFY-FAIL: docker daemon is unreachable[^\n]*"\s*\n\s*fail=1\b/.test(remoteBodyText)
  const cpControl =
    /docker cp "\$\{CONTAINER\}:\/etc\/hostname" - >\/dev\/null 2>&1/.test(remoteBodyText) &&
    /VERIFY-FAIL: docker cp cannot read container[^\n]*"\s*\n\s*fail=1\b/.test(remoteBodyText)
  return daemonControl && cpControl
}

// The container-down enumeration: a non-running container may only PASS on a
// PROVEN empty enumeration of its writable layer. Both the "probe failed" and the
// "residue found" arms must be wired to fail=1, and the count must come from a
// construct that always yields an integer (awk), never from `grep -c` — whose
// exit-1-on-zero-matches makes "no residue" and "the probe broke" identical.
function containerDownEnumerationGuardPresent(remoteBodyText) {
  const awkLine = remoteBodyText.split('\n').find((l) => /\|\s*awk '/.test(l) && /o2bat-creds-/.test(l))
  const usesAwkCounter = Boolean(
    awkLine && /docker cp "\$\{CONTAINER\}:\/tmp" -/.test(awkLine) && /tar -tf -/.test(awkLine) && /print n\+0/.test(awkLine),
  )
  const probeFailWired = /VERIFY-FAIL: could not enumerate in-container credential paths[^\n]*"\s*\n\s*fail=1\b/.test(
    remoteBodyText,
  )
  const residueWired =
    /VERIFY-FAIL: \$\{cenum_out\} in-container credential path\(s\) exist in non-running container[^\n]*"\s*\n\s*fail=1\b/.test(
      remoteBodyText,
    )
  return usesAwkCounter && probeFailWired && residueWired
}

// ---------------------------------------------------------------------------
// INGESTION mechanism gate. Asserting "the workflow no longer contains
// `docker cp ... :/tmp/o2bat-creds`" would be a path-literal check, and path
// literals do not converge — a future `docker cp "$f" "$CONTAINER:/tmp/anything"`
// walks straight past it (枚举陷阱不收敛). Gate the CLASS instead: enumerate every
// `docker cp` invocation in the whole workflow and require that NONE of them has a
// container-prefixed DESTINATION. The one legitimate survivor copies the
// (non-secret) evidence JSON OUT — container on the SOURCE side — so it passes.
// ---------------------------------------------------------------------------

// Several gates below must look at what the script DOES, not at what its comments
// SAY — and these comments deliberately quote the removed `docker cp … o2bat-creds`
// lines and the retired `docker ps` gate so the next reader knows what was wrong.
// A naive whole-text grep would therefore red on the explanation of the fix.
function stripShellComments(text) {
  return text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n')
}

// `docker cp` must be in COMMAND position to count as an invocation. A plain
// substring filter also swept up the step's own `log "... docker cp ..."` messages,
// whose words then parsed as operands — the census would have been auditing prose.
const CMD_POSITION_RE = /(?:^|[;&|(){}!]|\$\(|\b(?:if|then|else|elif|do|while|until)\b)\s*$/

function dockerCpInvocations(text) {
  const invocations = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('#')) continue
    for (let idx = line.indexOf('docker cp'); idx >= 0; idx = line.indexOf('docker cp', idx + 1)) {
      if (CMD_POSITION_RE.test(line.slice(0, idx))) {
        invocations.push(line)
        break
      }
    }
  }
  return invocations
}

// Positional operands of one `docker cp` invocation, flags removed.
//
// Do NOT simplify this to "operands[1] is the destination". `docker cp -a SRC DST`
// shifts the destination to index 2, and a gate that only inspected index 1 would
// look at SRC, find no `CONTAINER:` there, and wave the copy through — reintroducing
// the very defect by adding one flag. So the rule is positional-invariant instead:
// a `CONTAINER:`-prefixed operand may only ever appear at index 0 (the SOURCE).
// Mutation M2b (`docker cp -a …`) exists specifically to keep this honest.
function dockerCpOperands(line) {
  const after = line.slice(line.indexOf('docker cp') + 'docker cp'.length)
  // Truncate at the first `|` or `;`: the container-down enumeration pipes cp into
  // `tar | awk`, and the probes are written as `if docker cp … ; then`. Everything
  // past those separators belongs to a different command.
  const own = after.split('|')[0].split(';')[0]
  return own
    .trim()
    .split(/\s+/)
    .filter((tok) => tok !== '' && tok !== '\\')
    .filter((tok) => !tok.startsWith('>') && !tok.startsWith('2>') && !tok.startsWith('&>'))
    // Drop option flags, but KEEP a bare `-` — that is the stdout operand, not a flag.
    .filter((tok) => tok === '-' || !tok.startsWith('-'))
}

function containerPrefixedOperandIndexes(line) {
  return dockerCpOperands(line)
    .map((tok, i) => (/(\$\{?CONTAINER\}?):/.test(tok) ? i : -1))
    .filter((i) => i >= 0)
}

function noContainerPrefixedCpDestination(text) {
  return dockerCpInvocations(text).every((line) => containerPrefixedOperandIndexes(line).every((i) => i === 0))
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

test('structural: current-run probe targets exactly the RUN_STAMP-derived container path the battery step also stamps', () => {
  const runStampLine = 'run_stamp="gh${GITHUB_RUN_ID}a${GITHUB_RUN_ATTEMPT}"'
  assert.ok(scrubBlock.includes(runStampLine), 'scrub-creds must construct RUN_STAMP identically to the battery step')
  assert.ok(batteryBlock.includes(runStampLine), 'battery step must construct run_stamp identically (sanity: precedent unchanged)')
  assert.ok(scrubRemoteBody.includes('container_creds_dir="/tmp/o2bat-creds-${RUN_STAMP}"'))
})

// ---------------------------------------------------------------------------
// P1 (2026-08-21, second owner review) — INGESTION: no secret may be written
// into the container at all.
// ---------------------------------------------------------------------------

test('structural: NO docker cp anywhere in the workflow has a container-prefixed DESTINATION (the class, not one path literal)', () => {
  const invocations = dockerCpInvocations(workflowText)
  // Positive control on the census itself: an empty enumeration would make the
  // assertion below vacuously true (空grep可能是路径没读到).
  assert.ok(invocations.length > 0, 'sanity: the workflow must still contain at least one `docker cp` for this census to mean anything')
  // Pin the census SIZE. The command-position filter is what keeps `log "... docker cp
  // ..."` prose out of the operand parser; if it ever over-tightens to zero real
  // invocations, or loosens to sweep prose back in, this count moves and reds.
  assert.equal(
    invocations.length,
    4,
    `expected exactly 4 docker cp invocations (evidence-out, /etc/hostname control, creds probe, /tmp enumeration): ${JSON.stringify(invocations, null, 2)}`,
  )
  assert.ok(
    !invocations.some((l) => l.startsWith('log ')),
    'a `log "..."` line merely MENTIONING docker cp is prose, not an invocation — it must not enter the operand census',
  )
  const offenders = invocations.filter((line) => containerPrefixedOperandIndexes(line).some((i) => i !== 0))
  assert.deepEqual(
    offenders,
    [],
    'a docker cp INTO the container writes to its writable layer, which survives a stop/kill — credentials must reach the container on stdin only',
  )
  assert.equal(noContainerPrefixedCpDestination(workflowText), true)
  // Every real invocation must parse to at least two operands; a parser that silently
  // returned [] would make the positional rule vacuously true for every line.
  for (const line of invocations) {
    assert.ok(
      dockerCpOperands(line).length >= 2,
      `operand parse must find src+dst for: ${line} (got ${JSON.stringify(dockerCpOperands(line))})`,
    )
  }
  // Discriminating control for the FLAG hole: the same predicate must reject a
  // flag-shifted copy INTO the container, which an `operands[1]`-only rule would pass.
  assert.equal(
    noContainerPrefixedCpDestination('docker cp -a "${REMOTE_SECRETS_DIR}/password" "${CONTAINER}:/tmp/x/password"'),
    false,
    'the gate must reject a container-prefixed destination even when a flag shifts its position',
  )
  assert.equal(
    noContainerPrefixedCpDestination('docker cp "${CONTAINER}:/tmp/evidence.json" "${OUTPUT_DIR}/evidence.json"'),
    true,
    'sanity: a container-prefixed SOURCE must still be allowed (otherwise the gate would be trivially unsatisfiable)',
  )
  // And the legitimate survivor must still be there, container on the SOURCE side:
  // if it silently disappeared, the census above would pass for the wrong reason.
  assert.ok(
    invocations.some((line) => /^docker cp "\$\{CONTAINER\}:\$\{evidence_in_container\}"/.test(line)),
    'the evidence JSON must still be copied OUT of the container (container on the source side)',
  )
})

test('structural: the battery step ingests credentials on STDIN (docker exec -i + KEY=<base64> blob), and constructs no in-container credential path at all', () => {
  assert.match(
    batteryBlock,
    /\}\s*\|\s*docker exec -i "\$CONTAINER" sh -c '/,
    'the credential blob must be piped into `docker exec -i` — without -i the container-side `read` gets EOF',
  )
  // The blob is assembled from redirections/builtins only: no secret may appear as
  // an argv token on the deploy host either (that would sit in its own `ps` output).
  assert.match(batteryBlock, /printf 'BATTERY_ADMIN_EMAIL_B64='/)
  assert.match(batteryBlock, /base64 < "\$\{REMOTE_SECRETS_DIR\}\/email" \| tr -d '\\n'/)
  assert.match(batteryBlock, /printf '\\nBATTERY_ADMIN_PASSWORD_B64='/)
  assert.match(batteryBlock, /base64 < "\$\{REMOTE_SECRETS_DIR\}\/password" \| tr -d '\\n'/)
  // Container-side: read from stdin, decode, export in-process, and hand the battery
  // a /dev/null stdin so it can never read the credential stream itself.
  // Both reads must be CHECKED. Left bare, a short stream aborts under `set -e` with a
  // bare exit 1 and no message: still fail-closed, but undiagnosable on a credential
  // path. Verified behaviourally against a real container (see the fix's report,
  // e2e-ingestion.sh §5: empty stream ⇒ rc=90 with a named reason).
  assert.match(batteryBlock, /if ! IFS= read -r line_email; then/)
  assert.match(batteryBlock, /if ! IFS= read -r line_password; then/)
  assert.match(batteryBlock, /credential stream ended before the email line/)
  // The `|| true` inside each decode substitution is load-bearing for the same reason:
  // `set -e` is inherited by the substitution subshell, so without it a failed
  // `base64 -d` kills the wrapper before it can reach the explicit refusal below.
  assert.match(batteryBlock, /base64 -d 2>\/dev\/null \|\| true; printf X\)"/)
  assert.equal(
    (batteryBlock.match(/base64 -d 2>\/dev\/null \|\| true; printf X\)"/g) || []).length,
    2,
    'both the email and the password decode must be fail-soft-then-refuse, not just one',
  )
  assert.match(batteryBlock, /export BATTERY_ADMIN_EMAIL BATTERY_ADMIN_PASSWORD/)
  assert.match(
    batteryBlock,
    /exec node scripts\/ops\/multitable-l1-battery\.mjs --out "\$2" <\/dev\/null/,
    'the battery must be exec-ed with stdin closed off from the credential stream',
  )
  // Fail-closed on a broken transport: an empty decode must refuse, not run with an
  // empty password («不是错误X»≠结果断言 — assert the refusal, not merely its absence).
  assert.match(batteryBlock, /credential decode produced an empty value - refusing to run/)
  // And no in-container credential PATH may be constructed here any more. Compared
  // against the EXECUTABLE text: the comments deliberately quote the removed `docker
  // cp … o2bat-creds` lines so a future reader can see what the bug was.
  const batteryExecutable = stripShellComments(batteryBlock)
  assert.doesNotMatch(
    batteryExecutable,
    /o2bat-creds/,
    'the battery step must not name an in-container credential path at all — nothing creates one',
  )
  // Positive control on the comment-stripping itself: an over-eager stripper that
  // returned (nearly) nothing would make the assertion above vacuously true
  // (空grep可能是路径没读到).
  assert.match(batteryExecutable, /docker exec -i "\$CONTAINER"/, 'sanity: stripping comments must leave the executable ingestion line intact')
  assert.ok(
    batteryBlock.includes('o2bat-creds'),
    'sanity: the comments MUST still quote the removed cp lines — otherwise this test is comparing against a text that never had them',
  )
})

// ---------------------------------------------------------------------------
// P1 (2026-08-21, second owner review) — SCRUB: the in-container proof must be
// state-independent, positive-controlled, and never gated on `docker ps`.
// ---------------------------------------------------------------------------

test('structural: the in-container residue proof is NOT gated on `docker ps` (that gate is what made a stopped container report PASS)', () => {
  const scrubExecutable = stripShellComments(scrubRemoteBody)
  assert.match(scrubExecutable, /container_creds_dir="\/tmp\/o2bat-creds-\$\{RUN_STAMP\}"/, 'sanity: comment-stripping must leave the executable body intact')
  assert.doesNotMatch(
    scrubExecutable,
    /docker ps\b/,
    "`docker ps` omits a STOPPED container whose writable layer is still readable — the scrub must branch on `docker inspect .State.Status`, not on membership of `docker ps`",
  )
  assert.match(
    scrubRemoteBody,
    /docker inspect --type container -f '\{\{\.State\.Status\}\}' "\$CONTAINER"/,
    'container state must come from docker inspect, which sees non-running containers',
  )
  assert.match(
    scrubRemoteBody,
    /docker cp "\$\{CONTAINER\}:\$\{container_creds_dir\}" - >\/dev\/null 2>&1/,
    'the credential-path probe must use `docker cp`, the one primitive that reads a non-running container',
  )
  assert.doesNotMatch(
    scrubExecutable,
    /nothing to scrub inside a dead container/,
    'the blind-spot log line (and the PASS it accompanied) must be gone',
  )
})

test('structural: both in-container absence CONTROLS are present and wired to fail=1 (daemon liveness + docker cp positive control)', () => {
  assert.equal(inContainerProbeControlsPresent(scrubRemoteBody), true)
})

test('structural: a NON-RUNNING container may only PASS on a proven enumeration (awk counter, both arms wired to fail=1)', () => {
  assert.equal(containerDownEnumerationGuardPresent(scrubRemoteBody), true)
  assert.doesNotMatch(
    scrubRemoteBody,
    /grep -c '\^\(\\\.\/\)\?tmp\/o2bat-creds-/,
    '`grep -c` exits 1 on zero matches, collapsing "no residue" and "the probe failed" into one string',
  )
})

test('structural: every container-down VERDICT: PASS states a proven fact, never a skip', () => {
  const passLines = scrubRemoteBody
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('log "VERDICT: PASS'))
  assert.equal(passLines.length, 3, `expected one PASS wording per container state (absent / running / not-running): ${JSON.stringify(passLines)}`)
  const notRunning = passLines.find((l) => l.includes('not running'))
  assert.ok(notRunning, 'there must be a distinct PASS wording for the container-not-running case')
  assert.match(
    notRunning,
    /ENUMERATED via docker cp/,
    'the container-down PASS must cite the writable-layer enumeration that backs it, not merely note the container was down',
  )
  const absent = passLines.find((l) => l.includes('does not exist'))
  assert.ok(absent && /writable layer is gone/.test(absent), 'the container-absent PASS must say why nothing can persist')
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
  version)
    # Daemon-liveness control. STUB_DAEMON_DOWN=1 reproduces "docker is broken",
    # which must NOT be readable as "no in-container credential".
    if [[ "\${STUB_DAEMON_DOWN:-0}" == "1" ]]; then
      echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock." >&2
      exit 1
    fi
    printf '%s\\n' "\${STUB_DAEMON_VERSION:-29.5.3}"
    exit 0 ;;
  inspect)
    # Two forms: existence (\`inspect --type container NAME\`) and state
    # (\`inspect --type container -f '{{.State.Status}}' NAME\`).
    if [[ "\${STUB_CONTAINER_EXISTS:-1}" != "1" ]]; then
      echo "Error: No such container: metasheet-staging-backend" >&2
      exit 1
    fi
    if [[ "$*" == *"-f"* ]]; then
      if [[ "\${STUB_STATE_PROBE_EMPTY:-0}" == "1" ]]; then
        exit 0
      fi
      printf '%s\\n' "\${STUB_CONTAINER_STATE:-running}"
    else
      printf '%s\\n' "[]"
    fi
    exit 0 ;;
  cp)
    # \`docker cp SRC DST\`. Only container-SOURCE forms are reachable from the
    # scrub body; a container-DESTINATION form would be the very regression the
    # ingestion gate forbids, so the stub refuses it loudly rather than pretending.
    src="\${1:-}"
    dst="\${2:-}"
    case "$dst" in
      *:*)
        echo "stub: refusing a docker cp INTO a container (destination '$dst') — the workflow must never do this" >&2
        exit 94 ;;
    esac
    case "$src" in
      *:/etc/hostname)
        if [[ "\${STUB_CP_CONTROL_FAIL:-0}" == "1" ]]; then
          echo "Error response from daemon: could not read /etc/hostname" >&2
          exit 1
        fi
        printf 'tar-bytes-for-etc-hostname\\n'
        exit 0 ;;
      *:/tmp/o2bat-creds-*)
        if [[ "\${STUB_CONTAINER_CREDS_PRESENT:-0}" == "1" ]]; then
          printf 'tar-bytes-for-creds-dir\\n'
          exit 0
        fi
        echo "Error: No such container:path" >&2
        exit 1 ;;
      *:/tmp)
        # The container-down enumeration stream. STUB_CONTAINER_TMP_TAR names a REAL
        # tar file whose member names stand in for the container /tmp; the workflow
        # pipes this through \`tar -tf -\` and an awk counter, so the parsing under
        # test is the real one, not a mocked count.
        if [[ "\${STUB_CP_TMP_FAIL:-0}" == "1" ]]; then
          echo "Error response from daemon: cannot read /tmp" >&2
          exit 1
        fi
        cat "\${STUB_CONTAINER_TMP_TAR:-/dev/null}"
        exit 0 ;;
      *)
        echo "stub: unrecognized docker cp source: $src" >&2
        exit 95 ;;
    esac ;;
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
            # The OLD exec-based ABSENT/PRESENT verification. It cannot run against a
            # stopped container at all, which is exactly why it was replaced by the
            # state-independent docker cp probe. If the workflow ever issues it again,
            # fail loudly here rather than answering it.
            echo "stub: the exec-based ABSENT/PRESENT probe is retired — a stopped container cannot answer it" >&2
            exit 93 ;;
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
    // Default world: docker daemon up, the container exists and is RUNNING, the cp
    // positive control works, and no credential path exists (the post-fix normal).
    STUB_DAEMON_DOWN: '0',
    STUB_CONTAINER_EXISTS: '1',
    STUB_CONTAINER_STATE: 'running',
    STUB_CP_CONTROL_FAIL: '0',
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

// Builds a REAL tar whose member names stand in for a container's /tmp, so the
// container-down enumeration is exercised through the workflow's actual
// `tar -tf - | awk` pipeline rather than a mocked integer.
function makeContainerTmpTar(entryNames) {
  const root = mkdtempSync(join(tmpdir(), 'l1-scrub-ctmp-'))
  mkdirSync(join(root, 'tmp'))
  for (const name of entryNames) {
    mkdirSync(join(root, 'tmp', name), { recursive: true })
    writeFileSync(join(root, 'tmp', name, 'password'), 'not-a-real-secret')
  }
  const tarPath = join(root, 'tmp.tar')
  const r = spawnSync('tar', ['-cf', tarPath, '-C', root, 'tmp'], { encoding: 'utf8' })
  assert.equal(r.status, 0, `tar fixture must build: ${r.stderr}`)
  // Positive control on the fixture itself: an unreadable or empty tar would make
  // "zero credential paths found" true for the wrong reason.
  const listed = spawnSync('tar', ['-tf', tarPath], { encoding: 'utf8' })
  assert.equal(listed.status, 0, 'fixture tar must be listable')
  for (const name of entryNames) {
    assert.match(listed.stdout, new RegExp(`tmp/${name}`), `fixture tar must actually contain tmp/${name}`)
  }
  return tarPath
}

test('behavior (a) normal (container RUNNING and clean): host dir removed, in-container absence PROVEN (no container rm needed), exit 0', () => {
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
    // Daemon-liveness control, then the state probe, then the positive-controlled
    // credential-path probe — all three by argv, not merely by the stdout they produced.
    assert.match(r.dockerLog, /^version --format \{\{\.Server\.Version\}\}$/m)
    assert.match(r.dockerLog, /^inspect --type container -f \{\{\.State\.Status\}\} metasheet-staging-backend$/m)
    assert.match(r.dockerLog, /^cp metasheet-staging-backend:\/etc\/hostname -$/m, 'the cp positive control must be invoked')
    assert.match(
      r.dockerLog,
      /^cp metasheet-staging-backend:\/tmp\/o2bat-creds-ghANORMALa1 -$/m,
      'the credential-path probe must be invoked with the exact expected path argv',
    )
    // Nothing creates an in-container credential path any more, so the happy path must
    // NOT issue a removal — the absence is asserted, not manufactured by a cleanup.
    assert.doesNotMatch(r.dockerLog, /^exec metasheet-staging-backend rm -rf \/tmp\/o2bat-creds-/m)
    assert.match(r.stdout, /in-container credential path absent, PROVEN by positive-controlled docker cp/)
    assert.match(r.stdout, /VERDICT: PASS — current-run credentials scrubbed on host; no in-container credential path exists/)
    assert.equal(existsSync(fixture), false, 'fixture dir must be actually removed from disk (real rm, not just logged)')
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// (b) THE OWNER-REVIEW P1 CASE. This test previously asserted `VERDICT: PASS`
// and `doesNotMatch(/^exec /)` for a stopped container — i.e. it green-stamped
// "container down ⇒ PASS" while a `docker cp`'d secret was still sitting in that
// container's writable layer. It now asserts the replacement contract: the
// stopped container's layer is ENUMERATED, and the PASS is backed by that
// enumeration. See (b-leak) below for the case that must FAIL.
// ---------------------------------------------------------------------------

test('behavior (b) container STOPPED and clean: absence is PROVEN via docker cp (not skipped), exit 0', () => {
  const fixture = makeHostSecretsFixture()
  const tmpTar = makeContainerTmpTar(['some-unrelated-scratch'])
  try {
    const r = runScrubRemote({
      REMOTE_SECRETS_DIR: fixture,
      RUN_STAMP: 'ghBDOWNa1',
      STUB_CONTAINER_STATE: 'exited', // the exact state that used to be skipped
      STUB_CONTAINER_CREDS_PRESENT: '0',
      STUB_CONTAINER_TMP_TAR: tmpTar,
    })
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.ok(r.rmLog.includes(fixture), 'host removal must still happen when the container is down')

    // The load-bearing difference from the old test: a stopped container is NOT
    // skipped. Both probes must actually have been issued against it.
    assert.match(r.dockerLog, /^cp metasheet-staging-backend:\/etc\/hostname -$/m, 'positive control must run even for a stopped container')
    assert.match(
      r.dockerLog,
      /^cp metasheet-staging-backend:\/tmp\/o2bat-creds-ghBDOWNa1 -$/m,
      'the credential-path probe must run against the STOPPED container — this is the assertion the old test lacked',
    )
    assert.match(r.dockerLog, /^cp metasheet-staging-backend:\/tmp -$/m, 'the writable-layer enumeration must run for a non-running container')

    // `docker exec` genuinely cannot work here, so it must not be attempted — but that
    // is now a consequence, not the reason PASS is granted.
    assert.doesNotMatch(r.dockerLog, /^exec /m, 'no `docker exec` may be attempted against a container that is not running')

    assert.match(r.stdout, /in-container credential path absent, PROVEN by positive-controlled docker cp/)
    assert.match(r.stdout, /no o2bat-creds-\* path exists anywhere in non-running container 'metasheet-staging-backend' \/tmp/)
    assert.match(
      r.stdout,
      /VERDICT: PASS — current-run credentials scrubbed on host; container 'metasheet-staging-backend' is exited \(not running\) and its writable layer was ENUMERATED via docker cp/,
    )
    // The retired blind-spot wording must not come back.
    assert.doesNotMatch(r.stdout, /nothing to scrub inside a dead container/)
    assert.equal(existsSync(fixture), false)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})

test('behavior (b-leak) container STOPPED with a credential path in its writable layer: must FAIL, never PASS', () => {
  // The exact shape the owner proved with real Docker. Under the OLD `docker ps` gate
  // this run exited 0 and printed VERDICT: PASS.
  const r = runScrubRemote({
    REMOTE_SECRETS_DIR: '',
    RUN_STAMP: 'ghBLEAKa1',
    STUB_CONTAINER_STATE: 'exited',
    STUB_CONTAINER_CREDS_PRESENT: '1', // docker cp reads it back out of the stopped layer
  })
  assert.notEqual(r.status, 0, `a credential surviving in a stopped container must fail the job; stdout: ${r.stdout}`)
  assert.match(r.stdout, /VERIFY-FAIL: in-container credential path EXISTS in the writable layer: \/tmp\/o2bat-creds-ghBLEAKa1/)
  assert.match(r.stdout, /container is exited \(not running\) — the path cannot be removed without starting it; failing rather than reporting PASS/)
  assert.match(r.stdout, /VERDICT: FAIL/)
  assert.doesNotMatch(r.stdout, /VERDICT: PASS/)
  // The probe must genuinely have been issued (argv), not merely inferred from stdout.
  assert.match(r.dockerLog, /^cp metasheet-staging-backend:\/tmp\/o2bat-creds-ghBLEAKa1 -$/m)
})

test('behavior (b-leak-running) RUNNING container with a credential path: removal is attempted AND the job still fails', () => {
  const r = runScrubRemote({
    REMOTE_SECRETS_DIR: '',
    RUN_STAMP: 'ghBLEAKRUNa1',
    STUB_CONTAINER_STATE: 'running',
    STUB_CONTAINER_CREDS_PRESENT: '1',
  })
  assert.notEqual(r.status, 0, 'a successful cleanup must not hide the fact that a credential was written into the container')
  assert.match(r.dockerLog, /^exec metasheet-staging-backend rm -rf \/tmp\/o2bat-creds-ghBLEAKRUNa1$/m, 'remediation must be attempted while the container can still be reached')
  assert.match(r.stdout, /the job still FAILS so the regression is not hidden by a successful cleanup/)
  assert.match(r.stdout, /VERDICT: FAIL/)
  assert.doesNotMatch(r.stdout, /VERDICT: PASS/)
})

test('behavior (b-absent) container does not exist: PASS, and the PASS names the fact that makes it provable', () => {
  const r = runScrubRemote({
    REMOTE_SECRETS_DIR: '',
    RUN_STAMP: 'ghBABSENTa1',
    STUB_CONTAINER_EXISTS: '0',
  })
  assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
  // Discriminated by the daemon control: the daemon answered, and it says no such
  // container — so the writable layer went with it.
  assert.match(r.dockerLog, /^version --format \{\{\.Server\.Version\}\}$/m, 'the daemon control must run BEFORE any absence claim')
  assert.match(r.stdout, /does not exist \(docker daemon reachable, no such container\) — its writable layer was destroyed with it/)
  assert.match(r.stdout, /VERDICT: PASS —[^\n]*does not exist, so its writable layer is gone/)
  assert.doesNotMatch(r.dockerLog, /^cp metasheet-staging-backend:/m, 'no cp probe is possible against a container that does not exist')
})

test('behavior (b-daemon-down) docker daemon unreachable: absence CANNOT be asserted → FAIL (not a silent PASS)', () => {
  // Without the daemon control, `docker inspect` failing is indistinguishable from
  // "no such container", and the step would report the (b-absent) PASS above while
  // knowing nothing at all — the same error-absence shape as the retired `docker ps` gate.
  const r = runScrubRemote({
    REMOTE_SECRETS_DIR: '',
    RUN_STAMP: 'ghBDAEMONa1',
    STUB_DAEMON_DOWN: '1',
  })
  assert.notEqual(r.status, 0, 'an unknowable container state must never be reported as PASS')
  assert.match(r.stdout, /VERIFY-FAIL: docker daemon is unreachable on the deploy host — in-container credential absence CANNOT be asserted/)
  assert.match(r.stdout, /VERDICT: FAIL/)
  assert.doesNotMatch(r.stdout, /VERDICT: PASS/)
  assert.doesNotMatch(r.stdout, /does not exist/, 'a dead daemon must not be misreported as "no such container"')
})

test('behavior (b-cp-control-fail) the docker cp positive control fails: probe unusable → FAIL', () => {
  // If the control path cannot be read, the credential-path probe returning "absent"
  // means nothing: it would fail for the same unrelated reason. Fail-closed.
  const r = runScrubRemote({
    REMOTE_SECRETS_DIR: '',
    RUN_STAMP: 'ghBCTLa1',
    STUB_CONTAINER_STATE: 'exited',
    STUB_CP_CONTROL_FAIL: '1',
    STUB_CONTAINER_CREDS_PRESENT: '0', // the creds probe WOULD report absent — that must not be trusted
  })
  assert.notEqual(r.status, 0, 'an unusable probe must not be read as proof of absence')
  assert.match(r.stdout, /VERIFY-FAIL: docker cp cannot read container 'metasheet-staging-backend' \(state=exited\) even for a control path that must exist/)
  assert.match(r.stdout, /VERDICT: FAIL/)
  assert.doesNotMatch(r.stdout, /VERDICT: PASS/)
  assert.doesNotMatch(r.stdout, /PROVEN by positive-controlled docker cp/)
})

test('behavior (b-stale-down) a legacy o2bat-creds-* dir in a STOPPED container is found by the enumeration and fails the job', () => {
  // A pre-fix run could have stranded one. `docker exec` cannot reach it and `docker cp`
  // cannot delete it, so the only honest outcome is FAIL with an operator instruction.
  const tmpTar = makeContainerTmpTar(['o2bat-creds-ghOLDRUNa1', 'unrelated-scratch'])
  const r = runScrubRemote({
    REMOTE_SECRETS_DIR: '',
    RUN_STAMP: 'ghBSTALEa1',
    STUB_CONTAINER_STATE: 'exited',
    STUB_CONTAINER_CREDS_PRESENT: '0', // the CURRENT run is clean; the legacy one is not
    STUB_CONTAINER_TMP_TAR: tmpTar,
  })
  assert.notEqual(r.status, 0, `a stranded legacy credential dir in a stopped container must fail the job; stdout: ${r.stdout}`)
  assert.match(r.stdout, /VERIFY-FAIL: 1 in-container credential path\(s\) exist in non-running container 'metasheet-staging-backend' and cannot be removed without starting it/)
  assert.match(r.stdout, /VERDICT: FAIL/)
  assert.doesNotMatch(r.stdout, /VERDICT: PASS/)
})

test('behavior (b-enum-fail) the container-down enumeration itself fails: FAIL, not a silent zero', () => {
  // `grep -c` would have returned 1 here AND for a genuinely empty container; the awk
  // counter plus pipefail keeps "the probe broke" distinguishable from "nothing found".
  const r = runScrubRemote({
    REMOTE_SECRETS_DIR: '',
    RUN_STAMP: 'ghBENUMa1',
    STUB_CONTAINER_STATE: 'exited',
    STUB_CONTAINER_CREDS_PRESENT: '0',
    STUB_CP_TMP_FAIL: '1',
  })
  assert.notEqual(r.status, 0, 'a failed enumeration must not be read as "zero credential paths"')
  assert.match(r.stdout, /VERIFY-FAIL: could not enumerate in-container credential paths in non-running container 'metasheet-staging-backend'/)
  assert.match(r.stdout, /VERDICT: FAIL/)
  assert.doesNotMatch(r.stdout, /VERDICT: PASS/)
})

test('behavior (b-state-empty) the container exists but its state probe returns nothing: FAIL', () => {
  const r = runScrubRemote({
    REMOTE_SECRETS_DIR: '',
    RUN_STAMP: 'ghBSTATEa1',
    STUB_STATE_PROBE_EMPTY: '1',
    STUB_CONTAINER_CREDS_PRESENT: '0',
    STUB_CONTAINER_TMP_TAR: makeContainerTmpTar([]),
  })
  assert.notEqual(r.status, 0, 'an unknown container state must not be reported as PASS')
  assert.match(r.stdout, /VERIFY-FAIL: container 'metasheet-staging-backend' exists but its state probe returned nothing/)
  assert.match(r.stdout, /VERDICT: FAIL/)
  assert.doesNotMatch(r.stdout, /VERDICT: PASS/)
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

// NOTE (2026-08-21, second owner-review P1): the former `behavior (c-container-present)`
// and `behavior (c-container-execfail)` cases exercised the `docker exec ... echo
// PRESENT/ABSENT` verification, which was retired because it cannot run at all against a
// stopped container — the state the P1 was about. Their coverage moved to, and was
// strengthened by, `(b-leak)` / `(b-leak-running)` (residue detected in either state) and
// `(b-cp-control-fail)` / `(b-daemon-down)` (an unusable probe fails closed instead of
// reading as "absent"). The stub answers that retired probe with a loud error, so a
// silent reintroduction reds rather than being quietly served.

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
      STUB_CONTAINER_EXISTS: '0', // no container at all — isolate the HOST path
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
      STUB_CONTAINER_EXISTS: '0', // keep this case focused on the host sweep only
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
  // Re-pointed (2026-08-21) at the state-independent docker-cp probe that replaced the
  // retired `docker exec ... ABSENT/PRESENT` verification.
  const containerFailRe = /(VERIFY-FAIL: in-container credential path EXISTS in the writable layer:[^\n]*"\n\s*)fail=1\b/
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

// ---------------------------------------------------------------------------
// 5. GOLDEN — the SHIPPED scrub body against a REAL, NON-RUNNING container.
//
// Everything above stubs `docker`. That proves the script's control flow, but it
// cannot prove the fact the whole fix rests on: that a container which is absent
// from `docker ps` still hands its writable layer to `docker cp` while refusing
// `docker exec`. If that were false, the new probe would be theatre. So this
// section drives the real docker daemon.
//
// REGISTRY-FREE BY CONSTRUCTION. The container is built from a rootfs this test
// tars up and `docker import`s, so the golden pulls NOTHING. That matters: this
// file runs in `observation-kit contract`, a REQUIRED check on main, and a
// required check must not be able to go red because Docker Hub had a bad minute.
//
// SCOPE, stated precisely: the container reaches state `created` (an empty rootfs
// has no binary to run, so it can never reach `exited` without a base image). The
// scrub branches on `!= running`, so `created` exercises the SAME branch, and the
// three properties under test — absent from `docker ps`, `docker exec` refuses,
// `docker cp` reads and writes the layer — hold identically. The `exited` state
// itself was reproduced manually against a real alpine container; that evidence is
// in the fix's report, not here, because reproducing it needs a pullable image.
// ---------------------------------------------------------------------------

function dockerSkipReason() {
  // OPT-IN, not opt-out: the real-Docker goldens run ONLY when L1_BATTERY_DOCKER_GOLDENS=1 is set.
  // The obs-kit `contract` lane (REQUIRED, no path filter, runs on every PR) does NOT set it, so
  // this file stays hermetic there — a docker daemon hiccup on an unrelated PR can never red the
  // required check (the gate's disclosed P2). The dedicated non-required lane
  // .github/workflows/multitable-l1-battery-docker-goldens.yml sets it and runs the real proof.
  // Not-set is a LOUD skip (below), never a silent one, so the coverage move is visible.
  if (process.env.L1_BATTERY_DOCKER_GOLDENS !== '1') {
    return 'L1_BATTERY_DOCKER_GOLDENS != 1 (goldens run only in the dedicated docker lane, not the hermetic required contract lane)'
  }
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' })
  if (probe.error) return `docker CLI not usable: ${probe.error.message}`
  if (probe.status !== 0) return `docker daemon not reachable (exit ${probe.status}): ${(probe.stderr || '').trim()}`
  return null
}

const DOCKER_SKIP = dockerSkipReason()
if (DOCKER_SKIP) {
  // Loud, not silent: a skipped golden is a coverage hole and must say so in the run
  // output rather than blending into a green summary (被触发≠被验证).
  console.error(
    `[golden] REAL-DOCKER GOLDEN SKIPPED — ${DOCKER_SKIP}. The stubbed cases above still ran; the real-container proof did NOT.`,
  )
}

const realDockerPath = (() => {
  const w = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' })
  return (w.stdout || '').trim()
})()

// Transparent PATH shim, same idea as the `find` shim above: it rewrites ONLY the
// hard-coded production container name in argv to this test's throwaway container,
// then delegates to the REAL docker binary. Nothing about the workflow's own docker
// usage is simulated — the daemon answers every call.
const goldenBinDir = join(stubBase, 'golden-bin')
mkdirSync(goldenBinDir, { recursive: true })
writeFileSync(
  join(goldenBinDir, 'docker'),
  `#!/usr/bin/env bash
args=()
for a in "$@"; do
  args+=("\${a//metasheet-staging-backend/$GOLDEN_CONTAINER}")
done
exec "$GOLDEN_REAL_DOCKER" "\${args[@]}"
`,
)
chmodSync(join(goldenBinDir, 'docker'), 0o755)
// Reuse the same transparent `find` shim the stubbed cases use, so the host-side
// stale sweep behaves on macOS exactly as it does on ubuntu-latest.
writeFileSync(join(goldenBinDir, 'find'), FIND_STUB)
chmodSync(join(goldenBinDir, 'find'), 0o755)

let goldenSeq = 0

// Builds a registry-free image, creates a NEVER-STARTED container from it, hands it
// to `fn`, and always tears both down.
function withGoldenContainer(fn) {
  const id = `${process.pid}-${goldenSeq++}`
  const image = `o2bat-golden-${id}:test`
  const container = `o2bat-golden-${id}`
  const rootfs = mkdtempSync(join(tmpdir(), 'l1-golden-rootfs-'))
  mkdirSync(join(rootfs, 'tmp'))
  mkdirSync(join(rootfs, 'etc'))
  writeFileSync(join(rootfs, 'tmp', '.keep'), '')
  // /etc/hostname is the workflow's cp positive control. Docker normally injects it,
  // but baking it into the imported rootfs removes any dependence on that behaviour.
  writeFileSync(join(rootfs, 'etc', 'hostname'), 'o2bat-golden\n')

  const imported = spawnSync('bash', ['-c', `tar -cf - -C '${rootfs}' . | docker import - '${image}'`], {
    encoding: 'utf8',
  })
  assert.equal(imported.status, 0, `docker import must succeed (registry-free): ${imported.stderr}`)
  try {
    const created = spawnSync('docker', ['create', '--name', container, image, '/nonexistent'], { encoding: 'utf8' })
    assert.equal(created.status, 0, `docker create must succeed: ${created.stderr}`)
    try {
      fn({ container, image })
    } finally {
      spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8' })
    }
  } finally {
    spawnSync('docker', ['rmi', '-f', image], { encoding: 'utf8' })
    rmSync(rootfs, { recursive: true, force: true })
  }
}

function runScrubRemoteAgainstRealDocker(container, runStamp) {
  const result = spawnSync('bash', [remoteScriptPath], {
    env: {
      PATH: `${goldenBinDir}:/usr/bin:/bin:/usr/local/bin`,
      GOLDEN_CONTAINER: container,
      GOLDEN_REAL_DOCKER: realDockerPath,
      REMOTE_SECRETS_DIR: '',
      RUN_STAMP: runStamp,
    },
    encoding: 'utf8',
  })
  assert.equal(result.error, undefined, `bash must spawn cleanly: ${result.error && result.error.message}`)
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' }
}

test(
  'golden (real Docker): a container absent from `docker ps` refuses `docker exec` but still yields its writable layer to `docker cp` — the fact the whole fix rests on',
  { skip: DOCKER_SKIP ?? false },
  () => {
    withGoldenContainer(({ container }) => {
      const state = spawnSync('docker', ['inspect', '--type', 'container', '-f', '{{.State.Status}}', container], {
        encoding: 'utf8',
      })
      assert.equal(state.status, 0)
      assert.notEqual(state.stdout.trim(), 'running', 'the golden container must NOT be running')

      // 1. The retired gate cannot see it.
      const ps = spawnSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' })
      assert.equal(ps.status, 0)
      assert.ok(
        !ps.stdout.split('\n').some((n) => n.trim() === container),
        'a non-running container is ABSENT from `docker ps` — which is exactly why the old ps-gated scrub skipped it',
      )

      // 2. `docker exec` — the primitive the old scrub used — genuinely cannot reach it.
      const exec = spawnSync('docker', ['exec', container, 'true'], { encoding: 'utf8' })
      assert.notEqual(exec.status, 0, '`docker exec` must refuse a non-running container')

      // 3. `docker cp` — the primitive the new scrub uses — reads it fine. Positive
      //    control first, then the reproduction of the leak itself.
      const control = spawnSync('docker', ['cp', `${container}:/etc/hostname`, '-'], { encoding: 'buffer' })
      assert.equal(control.status, 0, 'the cp positive control must read back from a non-running container')
      assert.ok(control.stdout.length > 0, 'the control must return actual tar bytes, not an empty stream')

      // THE ORIGINAL LEAK, reproduced end-to-end: stage a credential exactly the way the
      // OLD workflow did (docker cp INTO the container), then read it back out of the
      // never-running container's writable layer.
      const hostCreds = mkdtempSync(join(tmpdir(), 'l1-golden-creds-'))
      try {
        writeFileSync(join(hostCreds, 'password'), 's3cr3t-99')
        const cpIn = spawnSync('docker', ['cp', hostCreds, `${container}:/tmp/o2bat-creds-ghGOLDENLEAKa1`], {
          encoding: 'utf8',
        })
        assert.equal(
          cpIn.status,
          0,
          `the OLD ingestion (docker cp INTO the container) must succeed for this reproduction: ${cpIn.stderr}`,
        )

        const recovered = spawnSync(
          'bash',
          ['-c', `docker cp '${container}:/tmp/o2bat-creds-ghGOLDENLEAKa1/password' - | tar -xO`],
          { encoding: 'utf8' },
        )
        assert.equal(
          recovered.status,
          0,
          'reading the credential back out of a NON-RUNNING container must succeed — that is the vulnerability',
        )
        assert.equal(
          recovered.stdout,
          's3cr3t-99',
          'the credential survives in the writable layer of a container that `docker ps` cannot see and `docker exec` cannot enter',
        )
      } finally {
        rmSync(hostCreds, { recursive: true, force: true })
      }
    })
  },
)

test(
  'golden (real Docker): the SHIPPED scrub body FAILS on a non-running container that holds a credential (the old body reported PASS here)',
  { skip: DOCKER_SKIP ?? false },
  () => {
    withGoldenContainer(({ container }) => {
      const hostCreds = mkdtempSync(join(tmpdir(), 'l1-golden-creds-'))
      try {
        writeFileSync(join(hostCreds, 'password'), 's3cr3t-99')
        const cpIn = spawnSync('docker', ['cp', hostCreds, `${container}:/tmp/o2bat-creds-ghGOLDENLEAKa1`], {
          encoding: 'utf8',
        })
        assert.equal(cpIn.status, 0, `fixture: cp INTO the container must succeed: ${cpIn.stderr}`)

        const r = runScrubRemoteAgainstRealDocker(container, 'ghGOLDENLEAKa1')
        assert.notEqual(r.status, 0, `the shipped scrub must FAIL here; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
        assert.match(
          r.stdout,
          /VERIFY-FAIL: in-container credential path EXISTS in the writable layer: \/tmp\/o2bat-creds-ghGOLDENLEAKa1/,
        )
        assert.match(r.stdout, /the path cannot be removed without starting it; failing rather than reporting PASS/)
        assert.match(r.stdout, /VERDICT: FAIL/)
        assert.doesNotMatch(r.stdout, /VERDICT: PASS/)
        // Proof that the probes ran against the real daemon, not a lucky default.
        assert.match(r.stdout, /docker cp probe usable against 'metasheet-staging-backend' \(state=created\)/)
      } finally {
        rmSync(hostCreds, { recursive: true, force: true })
      }
    })
  },
)

test(
  'golden (real Docker): the SHIPPED scrub body PASSES on a clean non-running container, and the PASS is backed by a real enumeration of its layer',
  { skip: DOCKER_SKIP ?? false },
  () => {
    withGoldenContainer(({ container }) => {
      // Nothing was ever written in — the post-fix steady state, because stdin-only
      // ingestion never creates an in-container credential path.
      const r = runScrubRemoteAgainstRealDocker(container, 'ghGOLDENCLEANa1')
      assert.equal(r.status, 0, `the shipped scrub must PASS here; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`)
      assert.match(
        r.stdout,
        /in-container credential path absent, PROVEN by positive-controlled docker cp \(valid for a non-running container too\): \/tmp\/o2bat-creds-ghGOLDENCLEANa1/,
      )
      assert.match(
        r.stdout,
        /no o2bat-creds-\* path exists anywhere in non-running container 'metasheet-staging-backend' \/tmp — enumerated from its writable layer via docker cp \+ tar/,
      )
      assert.match(r.stdout, /VERDICT: PASS —[^\n]*is created \(not running\) and its writable layer was ENUMERATED via docker cp/)
      assert.doesNotMatch(r.stdout, /VERIFY-FAIL/)

      // Independence control: this PASS must come from a real EMPTY enumeration, not from
      // the enumeration silently failing. Re-run the same probe by hand and confirm the
      // daemon really does return a listable /tmp for this container.
      const enumerated = spawnSync('bash', ['-c', `docker cp '${container}:/tmp' - | tar -tf -`], { encoding: 'utf8' })
      assert.equal(enumerated.status, 0, 'the /tmp enumeration must genuinely succeed against a non-running container')
      assert.match(
        enumerated.stdout,
        /tmp\//,
        'the enumeration must return real member names (an empty stream would make "zero credential paths" vacuous)',
      )
      assert.doesNotMatch(enumerated.stdout, /o2bat-creds-/)
    })
  },
)
