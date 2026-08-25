#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assessSchemaSnapshot,
  expectedSchemaSnapshot,
  fingerprint,
  renderAssessment,
  runSchemaContainment,
} from './multitable-recovery-schema-containment.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')

function expectedCopy() {
  return structuredClone(expectedSchemaSnapshot())
}

test('expected schema posture is exact: 9 disabled triggers, 6 functions, zero foreign_record_id FKs', () => {
  const expected = expectedCopy()
  assert.equal(expected.authorityTriggers.length, 9)
  assert.equal(expected.authorityFunctions.length, 6)
  assert.equal(expected.metaLinksForeignRecordFks.length, 0)
  assert.ok(
    expected.authorityTriggers.every((trigger) => trigger.enabled === 'D'),
  )

  const assessment = assessSchemaSnapshot(expected)
  assert.equal(assessment.ok, true)
  assert.match(renderAssessment(assessment), /^VERDICT: PASS -/m)
})

test('the ladder fingerprint table stays mechanically bound to disabled and armed helper postures', () => {
  const ladder = readFileSync(
    join(
      repoRoot,
      'docs/development/multitable-timemachine-o2-enablement-ladder-20260819.md',
    ),
    'utf8',
  )
  for (const state of ['disabled', 'armed']) {
    const expected = fingerprint(expectedSchemaSnapshot(state).authorityTriggers)
    assert.ok(
      ladder.includes(expected),
      `ladder must publish the exact ${state} trigger fingerprint ${expected}`,
    )
  }
})

test('the ladder marks the impossible v1 L2-L5 order as historical HOLD before presenting E1', () => {
  const ladder = readFileSync(
    join(
      repoRoot,
      'docs/development/multitable-timemachine-o2-enablement-ladder-20260819.md',
    ),
    'utf8',
  )
  assert.match(
    ladder,
    /\*\*执行勘误（承重）\*\*：[\s\S]*L2\+ 在 E1 获 exact-SHA ratify 前没有可执行顺序/,
    'the warning before the old ladder must fail closed instead of leaving two executable sequences',
  )
  const oldStart = ladder.indexOf('## 2. 冻结的 v1 阶梯记录')
  const oldEnd = ladder.indexOf('## 3.', oldStart)
  assert.ok(oldStart >= 0 && oldEnd > oldStart, 'the frozen v1 section must be bounded')
  const oldLadder = ladder.slice(oldStart, oldEnd)
  for (const rung of ['L2', 'L3', 'L4', 'L5']) {
    assert.match(
      oldLadder,
      new RegExp(`\\*\\*${rung} — HISTORICAL / HOLD`),
      `${rung} must not look executable in the frozen v1 section`,
    )
  }
  assert.match(
    ladder,
    /修正案 E1[\s\S]*Status: \*\*PROPOSED\*\*/,
    'the replacement sequence must remain explicitly unratified',
  )
})

test('any FK covering meta_links.foreign_record_id fails closed — NO ACTION and CASCADE both red', async () => {
  // Mutation shape mirrors what queryRecoverySchemaSnapshot returns for
  //   ALTER TABLE meta_links ADD CONSTRAINT <name>
  //     FOREIGN KEY (foreign_record_id) REFERENCES meta_records(id)
  //     ON DELETE NO ACTION NOT VALID          -> confdeltype 'a'
  // and the same with ON DELETE CASCADE       -> confdeltype 'c'.
  // The invariant is column-scoped and absolute: BOTH actions must turn the check red.
  const seededFks = [
    { constraint_name: 'meta_links_frid_noaction_fkey', on_delete_action: 'a' },
    { constraint_name: 'meta_links_frid_cascade_fkey', on_delete_action: 'c' },
  ]
  for (const seededFk of seededFks) {
    const snapshot = expectedCopy()
    snapshot.metaLinksForeignRecordFks = [seededFk]

    const assessment = assessSchemaSnapshot(snapshot)
    assert.equal(assessment.ok, false)
    const rendered = renderAssessment(assessment)
    assert.match(rendered, /meta-links-foreign-record-id-fk-absence: FAIL/)
    assert.ok(
      rendered.includes(`constraint="${seededFk.constraint_name}"`),
      'failure diagnostics must name the offending constraint',
    )
    assert.ok(
      rendered.includes(`on_delete_action='${seededFk.on_delete_action}'`),
      'failure diagnostics must show the ON DELETE action letter',
    )
    assert.match(rendered, /^VERDICT: FAIL -/m)
    assert.doesNotMatch(rendered, /VERDICT: PASS/)

    const result = await runSchemaContainment({
      env: { DATABASE_URL: 'postgresql://placeholder.invalid/scratch' },
      querySnapshot: async () => snapshot,
    })
    assert.equal(result.exitCode, 1)
    assert.doesNotMatch(result.output, /VERDICT: PASS/)
  }
})

test('disabled and armed helper postures each return only their exact workflow sentinel', async () => {
  const snapshot = expectedCopy()
  snapshot.metaLinksForeignRecordFks = []
  const disabled = await runSchemaContainment({
    env: { DATABASE_URL: 'postgresql://placeholder.invalid/scratch' },
    querySnapshot: async () => snapshot,
  })
  assert.equal(disabled.exitCode, 0)
  assert.match(disabled.output, /meta-links-foreign-record-id-fk-absence: PASS count=0\/0/)

  const armedSnapshot = structuredClone(expectedSchemaSnapshot('armed'))
  const armed = await runSchemaContainment({
    env: { DATABASE_URL: 'postgresql://placeholder.invalid/scratch' },
    querySnapshot: async () => armedSnapshot,
    expectedTriggerState: 'armed',
  })
  assert.equal(armed.exitCode, 0)
  assert.match(armed.output, /expected armed schema posture/)

  const wrongState = await runSchemaContainment({
    env: { DATABASE_URL: 'postgresql://placeholder.invalid/scratch' },
    querySnapshot: async () => snapshot,
    expectedTriggerState: 'armed',
  })
  assert.equal(wrongState.exitCode, 1)
  assert.match(wrongState.output, /recovery-authority-triggers: FAIL/)

  // The workflow greps its SCHEMA_PASS_LINE with `grep -qxF` (exact full line). Keep the helper's
  // PASS sentinel and the workflow constant in lockstep, or leg 2 fails at runtime despite exit 0.
  const workflow = readFileSync(
    join(
      repoRoot,
      '.github/workflows/multitable-recovery-flag-containment-check.yml',
    ),
    'utf8',
  )
  const disabledSentinel = workflow.match(/^\s*SCHEMA_PASS_LINE_DISABLED="(.+)"$/m)
  const armedSentinel = workflow.match(/^\s*SCHEMA_PASS_LINE_ARMED="(.+)"$/m)
  assert.ok(disabledSentinel, 'workflow must define SCHEMA_PASS_LINE_DISABLED')
  assert.ok(armedSentinel, 'workflow must define SCHEMA_PASS_LINE_ARMED')
  assert.ok(
    disabled.output.split('\n').includes(disabledSentinel[1]),
    'disabled helper PASS must contain the exact disabled sentinel',
  )
  assert.ok(
    armed.output.split('\n').includes(armedSentinel[1]),
    'armed helper PASS must contain the exact armed sentinel',
  )
})

test('workflow FLAGS pins exactly the six observed vars (five ladder rung flags + the retention conflict var), classified by both legs', () => {
  const workflow = readFileSync(
    join(repoRoot, '.github/workflows/multitable-recovery-flag-containment-check.yml'),
    'utf8',
  )
  // The remote heredoc declares FLAGS once; both the running-env leg and the next-restart leg invoke
  // the same classifier with that set. Pin the EXACT set so a silently dropped flag (e.g. deleting
  // MULTITABLE_ENABLE_WRITER_FENCE) cannot pass green — it must red this required (test 20.x) contract.
  // MULTITABLE_META_REVISION_RETENTION_ENABLED is the sixth OBSERVED var and NOT a rung flag: it is
  // never expected active, and it is required-inactive only at the postures that presuppose PIT reset
  // (see the per-posture behavior tests below). It MUST still be observed everywhere, because
  // PIT_RESET_RETENTION_BLOCKED() (packages/core-backend/src/routes/univer-meta.ts) refuses both
  // reset-preview and reset-execute with 409 RESET_RETENTION_CONFLICT while it is exactly '1'. Drop it
  // from FLAGS and `posture=l5-reset` can report PASS on an environment where reset cannot run at all.
  const flagsDecl = workflow.match(/^\s*FLAGS="([^"]+)"$/m)
  assert.ok(flagsDecl, 'workflow must declare FLAGS')
  const flags = flagsDecl[1].trim().split(/\s+/).sort()
  assert.deepEqual(
    flags,
    [
      'MULTITABLE_ENABLE_PIT_RESET',
      'MULTITABLE_ENABLE_SHEET_REVERT',
      'MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION',
      'MULTITABLE_ENABLE_WRITER_FENCE',
      'MULTITABLE_HISTORY_CONTIGUITY_STRICT',
      'MULTITABLE_META_REVISION_RETENTION_ENABLED',
    ],
    'the witness must observe exactly the five ladder rung flags (including transient trust-checkpoint activation) plus MULTITABLE_META_REVISION_RETENTION_ENABLED, the PIT-reset conflict var',
  )
  // RUNG_FLAGS is the closed-world set: a rung flag outside the posture's active set is required OFF.
  // Pin it by name too, and pin its relationship to FLAGS. Dropping a name from RUNG_FLAGS while
  // leaving it in FLAGS would silently demote that rung flag to "observed but unconstrained", i.e.
  // MULTITABLE_ENABLE_PIT_RESET=true would start PASSING posture=inert. That mutation must red HERE.
  const rungDecl = workflow.match(/^\s*RUNG_FLAGS="([^"]+)"$/m)
  assert.ok(rungDecl, 'workflow must declare RUNG_FLAGS')
  const rungFlags = rungDecl[1].trim().split(/\s+/).sort()
  assert.deepEqual(
    rungFlags,
    [
      'MULTITABLE_ENABLE_PIT_RESET',
      'MULTITABLE_ENABLE_SHEET_REVERT',
      'MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION',
      'MULTITABLE_ENABLE_WRITER_FENCE',
      'MULTITABLE_HISTORY_CONTIGUITY_STRICT',
    ],
    'RUNG_FLAGS must be exactly the five ladder rung flags of ladder §0 / §E1.2 — no more (that would over-constrain a decoupled var) and no fewer (that would un-constrain a rung flag)',
  )
  assert.deepEqual(
    flags.filter((flag) => !rungFlags.includes(flag)),
    ['MULTITABLE_META_REVISION_RETENTION_ENABLED'],
    'the only observed non-rung var is the retention conflict var; anything else observed-but-non-rung would be unconstrained at every posture by default',
  )
  const classifierCalls = [
    ...workflow.matchAll(/node -e "\$FLAG_CLASSIFIER_JS" (running|compose)[^\n]*\$FLAGS/g),
  ].map((match) => match[1])
  assert.deepEqual(
    classifierCalls.sort(),
    ['compose', 'running'],
    'both running and next-restart legs must classify the exact FLAGS set',
  )
})

test('MODE + TARGET + POSTURE are validated against fixed choices BEFORE the ssh line', () => {
  const workflow = readFileSync(
    join(repoRoot, '.github/workflows/multitable-recovery-flag-containment-check.yml'),
    'utf8',
  )
  // The remote heredoc re-validates MODE/TARGET too, but that runs AFTER the value is already
  // interpolated onto the ssh command line — only the LOCAL `case` (before `ssh `) can stop an ssh-line
  // re-parse of a non-enum / space / metacharacter value. The behavior harness only extracts the remote
  // heredoc, so without this slice-and-assert, deleting the local pre-SSH guard passes green (P2). Slice
  // the run: portion up to the ssh invocation and require both fixed-choice guards to live there.
  const sshIdx = workflow.indexOf('ssh $ssh_opts "$DEPLOY_USER@$DEPLOY_HOST"')
  assert.ok(sshIdx > 0, 'workflow must invoke ssh to the deploy host')
  const preSsh = workflow.slice(0, sshIdx)
  assert.match(
    preSsh,
    /case\s+"\$MODE"\s+in\s*\n\s*predeploy-flags\|postdeploy-full\)/,
    'MODE must be validated against exactly {predeploy-flags,postdeploy-full} BEFORE it reaches the ssh command line',
  )
  assert.match(
    preSsh,
    /case\s+"\$TARGET"\s+in\s*\n\s*staging\|production\|both\)/,
    'TARGET must be validated against exactly {staging,production,both} BEFORE it reaches the ssh command line',
  )
  assert.match(
    preSsh,
    /case\s+"\$POSTURE"\s+in\s*\n\s*inert\|l1-armed\|l2-fence\|l2-checkpoint\|l3-strict\|l4-revert\|l5-reset\)/,
    'POSTURE must be validated against the exact rung set BEFORE it reaches the ssh command line',
  )
})

test('missing or unexpectedly enabled authority triggers fail closed', () => {
  const missing = expectedCopy()
  missing.authorityTriggers.pop()
  assert.equal(assessSchemaSnapshot(missing).ok, false)

  const enabled = expectedCopy()
  enabled.authorityTriggers[0].enabled = 'O'
  const enabledAssessment = assessSchemaSnapshot(enabled)
  assert.equal(enabledAssessment.ok, false)
  assert.match(
    renderAssessment(enabledAssessment),
    /recovery-authority-triggers: FAIL/,
  )
})

test('authority function-body drift changes the fingerprint and fails closed', () => {
  const drifted = expectedCopy()
  drifted.authorityFunctions[0].body = 'BEGIN RETURN; END;'
  const assessment = assessSchemaSnapshot(drifted)
  assert.equal(assessment.ok, false)
  assert.match(
    renderAssessment(assessment),
    /recovery-authority-functions: FAIL/,
  )
})

test('missing DATABASE_URL is non-PASS without exposing unrelated environment values', async () => {
  const result = await runSchemaContainment({
    env: {
      SECRET_TOKEN: 'do-not-print',
    },
  })
  assert.notEqual(result.exitCode, 0)
  assert.match(result.output, /^VERDICT: FAIL -/)
  assert.doesNotMatch(result.output, /do-not-print|SECRET_TOKEN/)
  assert.doesNotMatch(result.output, /VERDICT: PASS/)
})

test('database or catalog-permission failure is generic and never echoes URL/error data', async () => {
  const databaseUrl =
    'postgresql://sensitive-user:sensitive-pass@example.invalid/private-db'
  const result = await runSchemaContainment({
    env: { DATABASE_URL: databaseUrl },
    querySnapshot: async () => {
      throw new Error(`permission denied for secret_row via ${databaseUrl}`)
    },
  })
  assert.notEqual(result.exitCode, 0)
  assert.match(result.output, /^VERDICT: FAIL -/)
  assert.doesNotMatch(
    result.output,
    /sensitive-user|sensitive-pass|example\.invalid|private-db|secret_row|postgresql:\/\//,
  )
  assert.doesNotMatch(result.output, /VERDICT: PASS/)
})

test('invalid expected trigger state is an explicit configuration failure before any query', async () => {
  let queried = false
  const result = await runSchemaContainment({
    env: { DATABASE_URL: 'postgresql://placeholder.invalid/scratch' },
    expectedTriggerState: 'armed; echo unsafe',
    querySnapshot: async () => {
      queried = true
      return expectedCopy()
    },
  })
  assert.equal(result.exitCode, 2)
  assert.equal(queried, false)
  assert.match(result.output, /must be exactly disabled or armed/)
  assert.doesNotMatch(result.output, /observation unavailable|VERDICT: PASS/)
})

test('workflow requires the schema helper for every expected backend container and rejects missing PASS', () => {
  const workflow = readFileSync(
    join(
      repoRoot,
      '.github/workflows/multitable-recovery-flag-containment-check.yml',
    ),
    'utf8',
  )
  const loopStart = workflow.indexOf('for name in $EXPECTED_CONTAINERS; do')
  const loopEnd = workflow.indexOf('echo "== summary =="', loopStart)
  assert.ok(
    loopStart >= 0 && loopEnd > loopStart,
    'expected-container loop must exist',
  )
  const loop = workflow.slice(loopStart, loopEnd)

  assert.match(
    loop,
    /docker exec "\$name" node scripts\/ops\/multitable-recovery-schema-containment\.mjs/,
  )
  const helperSource = readFileSync(
    join(repoRoot, 'scripts/ops/multitable-recovery-schema-containment.mjs'),
  )
  const helperHash = createHash('sha256').update(helperSource).digest('hex')
  assert.match(
    workflow,
    new RegExp(`SCHEMA_HELPER_SHA256="${helperHash}"`),
    'workflow must pin the reviewed helper instead of trusting arbitrary code in the target image',
  )
  assert.match(loop, /helper_sha.*sha256sum/)
  assert.match(loop, /helper_sha.*SCHEMA_HELPER_SHA256/)
  assert.match(loop, /SCHEMA_PASS_LINE/)
  assert.match(loop, /schema containment helper failed/)
  assert.match(
    loop,
    /schema containment helper did not emit its exact PASS sentinel/,
  )
  const executableLoop = loop
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
  assert.doesNotMatch(executableLoop, /DATABASE_URL/)
})

// ---------------------------------------------------------------------------
// BEHAVIOR-LEVEL tests for the remote heredoc of
//   .github/workflows/multitable-recovery-flag-containment-check.yml
//
// These do NOT grep the workflow text (that would be a structural no-op a
// reviewer would rightly call vacuous). Instead we EXTRACT the remote heredoc
// script exactly as the deploy host would receive it (YAML `run: |` strips the
// 10-space block indent), stub `docker` with a PATH-shadowing script whose
// return values and call-log are driven by STUB_* env vars, and actually RUN
// the script under bash for each scenario — asserting exit code, verdict text,
// and whether the schema helper (`node …-schema-containment.mjs`) was invoked.
//
// The invariants under test are the two-mode split introduced by the workflow
// refactor:
//   * predeploy-flags runs Leg 1 (running env) + Leg 3 (compose config) and
//     SKIPS Leg 2 (the DB schema helper) entirely;
//   * postdeploy-full runs all three legs and cannot bypass Leg 2;
//   * a running/next-restart flag=true fails closed in BOTH modes;
//   * the two PASS sentinels are DISTINCT so a predeploy PASS can never be
//     read as a full-containment PASS.
// ---------------------------------------------------------------------------

const workflowPath = join(
  repoRoot,
  '.github/workflows/multitable-recovery-flag-containment-check.yml',
)
const workflowText = readFileSync(workflowPath, 'utf8')

// Reproduce what bash on the remote host receives: the body between `<<'REMOTE'`
// and the `REMOTE` terminator, with YAML's 10-space block indent removed.
function extractRemoteScript(text) {
  const lines = text.split('\n')
  const startIdx = lines.findIndex((line) => /<<'REMOTE'/.test(line))
  assert.ok(startIdx >= 0, "workflow must open the remote heredoc with <<'REMOTE'")
  let endIdx = -1
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (lines[i].replace(/\s+$/, '') === '          REMOTE') {
      endIdx = i
      break
    }
  }
  assert.ok(endIdx > startIdx, 'workflow must close the remote heredoc with REMOTE')
  return (
    lines
      .slice(startIdx + 1, endIdx)
      .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
      .join('\n') + '\n'
  )
}

// Pull the pinned helper fingerprint and PASS sentinel straight from the
// workflow so the happy-path stub stays in lockstep with the reviewed revision.
const schemaHelperSha = workflowText.match(
  /^\s*SCHEMA_HELPER_SHA256="([0-9a-f]+)"$/m,
)
assert.ok(schemaHelperSha, 'workflow must pin SCHEMA_HELPER_SHA256')
const schemaPassLineDisabled = workflowText.match(
  /^\s*SCHEMA_PASS_LINE_DISABLED="(.+)"$/m,
)
const schemaPassLineArmed = workflowText.match(
  /^\s*SCHEMA_PASS_LINE_ARMED="(.+)"$/m,
)
assert.ok(schemaPassLineDisabled, 'workflow must define SCHEMA_PASS_LINE_DISABLED')
assert.ok(schemaPassLineArmed, 'workflow must define SCHEMA_PASS_LINE_ARMED')

const flagClassifierScript = workflowText.match(
  /^\s*FLAG_CLASSIFIER_JS='(.+)'$/m,
)
assert.ok(flagClassifierScript, 'workflow must define FLAG_CLASSIFIER_JS')

// Every var the witness observes: the five ladder rung flags + the retention conflict var. Only the
// first five ever appear in a posture's expected-active set (ladder §E1.2), and only those five are
// closed-world required-inactive when absent from it. The sixth is required inactive at the postures
// that presuppose PIT reset (today: l5-reset alone) and UNCONSTRAINED at the rest.
const RETENTION_CONFLICT_VAR = 'MULTITABLE_META_REVISION_RETENTION_ENABLED'
const ALL_OBSERVED_VARS = [
  'MULTITABLE_ENABLE_SHEET_REVERT',
  'MULTITABLE_ENABLE_PIT_RESET',
  'MULTITABLE_HISTORY_CONTIGUITY_STRICT',
  'MULTITABLE_ENABLE_WRITER_FENCE',
  'MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION',
  RETENTION_CONFLICT_VAR,
]

function flagSnapshot(activeFlags = [], overrides = {}) {
  const active = new Set(activeFlags)
  return ALL_OBSERVED_VARS.map((flag) => {
    const state = overrides[flag] ?? (active.has(flag) ? 'true' : 'unset')
    return `${flag}\t${state}`
  }).join('\n')
}

// A PATH-shadowing `docker`. Every invocation is appended to $STUB_LOG (so a
// test can assert whether `node …-schema-containment.mjs` ran), and each
// subcommand's output is driven by STUB_* env vars.
const DOCKER_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
cmd="\${1:-}"; shift || true
case "$cmd" in
  compose)
    for a in "$@"; do [ "$a" = "version" ] && exit 0; done
    printf '%s\\n' "$STUB_COMPOSE_CONFIG_JSON"
    printf '%s' "\${STUB_COMPOSE_STDERR:-}" >&2
    exit "\${STUB_COMPOSE_EXIT:-0}" ;;
  ps)
    printf '%s\\n' "$STUB_PS_NAMES"; exit 0 ;;
  exec)
    if [ "\${1:-}" = "-i" ]; then shift; fi
    container="\${1:-}"; shift || true
    sub="\${1:-}"; shift || true
    case "$sub" in
      sha256sum) printf '%s  %s\\n' "$STUB_HELPER_SHA" "\${1:-}"; exit 0 ;;
      node)
        if [ "\${1:-}" = "-e" ]; then
          shift
          classifier="\${1:-}"; shift || true
          classifier_mode="\${1:-}"
          case "$classifier_mode" in
            running) printf '%s\\n' "$STUB_RUNNING_FLAG_SNAPSHOT"; exit 0 ;;
            compose) cat >/dev/null; printf '%s\\n' "$STUB_COMPOSE_FLAG_SNAPSHOT"; exit 0 ;;
            running-allowlist) printf '%s\\n' "$STUB_RUNNING_ALLOWLIST_PROBE"; exit "\${STUB_RUNNING_ALLOWLIST_EXIT:-0}" ;;
            compose-allowlist) cat >/dev/null; printf '%s\\n' "$STUB_COMPOSE_ALLOWLIST_PROBE"; exit "\${STUB_COMPOSE_ALLOWLIST_EXIT:-0}" ;;
            *) echo "stub: unknown classifier mode: $classifier_mode" >&2; exit 97 ;;
          esac
        fi
        printf '%s\\n' "$STUB_HELPER_OUT"; exit "\${STUB_HELPER_EXIT:-0}" ;;
      *) echo "stub: unknown exec sub: $sub" >&2; exit 99 ;;
    esac ;;
  inspect)
    fmt="$*"
    if printf '%s' "$fmt" | grep -q 'config_files'; then printf '%s\\n' "$STUB_CONFIG_FILES"
    elif printf '%s' "$fmt" | grep -q 'working_dir'; then printf '%s\\n' "$STUB_WORKING_DIR"
    else printf '\\n'; fi
    exit 0 ;;
  version) exit 0 ;;
  *) echo "stub: unknown docker cmd: $cmd" >&2; exit 98 ;;
esac
`

const HELPER_CALL = 'node scripts/ops/multitable-recovery-schema-containment.mjs'
const HELPER_SHA_READ =
  'sha256sum scripts/ops/multitable-recovery-schema-containment.mjs'

const containmentStubBase = mkdtempSync(join(tmpdir(), 'ct-behavior-'))
const containmentBinDir = join(containmentStubBase, 'bin')
mkdirSync(containmentBinDir, { recursive: true })
writeFileSync(join(containmentBinDir, 'docker'), DOCKER_STUB)
chmodSync(join(containmentBinDir, 'docker'), 0o755)
const remoteScriptPath = join(containmentStubBase, 'remote.sh')
writeFileSync(remoteScriptPath, extractRemoteScript(workflowText))

// The checkpoint-allowlist non-vacuity probe (P2, 2026-08-25). It runs on BOTH legs, but only for a
// posture whose expected-active set contains MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION — today
// exactly `l2-checkpoint`. Its contract line is `<VAR>\t<state>\t<count>` with state ∈
// {designated, empty, unset}; the designated sheet IDS are never emitted.
const CHECKPOINT_ALLOWLIST_VAR = 'MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST'
function allowlistProbe(state, count) {
  return `${CHECKPOINT_ALLOWLIST_VAR}\t${state}\t${count}`
}
// Default = the honest L2-C state: one designated canary sheet. Every posture other than
// l2-checkpoint never reaches the probe at all.
const DESIGNATED_ALLOWLIST_PROBE = allowlistProbe('designated', 1)

const CLEAN_FLAG_SNAPSHOT = flagSnapshot()
const CLEAN_COMPOSE_CONFIG = JSON.stringify({
  services: {
    backend: {
      container_name: 'metasheet-backend',
      environment: {},
    },
    stagingBackend: {
      container_name: 'metasheet-staging-backend',
      environment: {},
    },
  },
})

let containmentLogSeq = 0
function runRemote({ target, mode, posture = 'inert', stub = {} }) {
  const logPath = join(containmentStubBase, `log-${containmentLogSeq++}.txt`)
  writeFileSync(logPath, '')
  const env = {
    ...process.env,
    PATH: `${containmentBinDir}:${process.env.PATH}`,
    STUB_LOG: logPath,
    TARGET: target,
    MODE: mode,
    POSTURE: posture,
    STUB_PS_NAMES: 'metasheet-backend',
    STUB_RUNNING_FLAG_SNAPSHOT: CLEAN_FLAG_SNAPSHOT,
    STUB_COMPOSE_FLAG_SNAPSHOT: CLEAN_FLAG_SNAPSHOT,
    STUB_RUNNING_ALLOWLIST_PROBE: DESIGNATED_ALLOWLIST_PROBE,
    STUB_COMPOSE_ALLOWLIST_PROBE: DESIGNATED_ALLOWLIST_PROBE,
    STUB_RUNNING_ALLOWLIST_EXIT: '0',
    STUB_COMPOSE_ALLOWLIST_EXIT: '0',
    STUB_HELPER_SHA: schemaHelperSha[1],
    STUB_HELPER_OUT:
      posture === 'inert' ? schemaPassLineDisabled[1] : schemaPassLineArmed[1],
    STUB_HELPER_EXIT: '0',
    STUB_CONFIG_FILES: '/app/docker-compose.app.yml',
    STUB_WORKING_DIR: '/app',
    STUB_COMPOSE_CONFIG_JSON: CLEAN_COMPOSE_CONFIG,
    STUB_COMPOSE_STDERR: '',
    STUB_COMPOSE_EXIT: '0',
    ...stub,
  }
  const result = spawnSync('bash', [remoteScriptPath], { env, encoding: 'utf8' })
  assert.equal(
    result.error,
    undefined,
    `bash must spawn cleanly: ${result.error && result.error.message}`,
  )
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    log: readFileSync(logPath, 'utf8'),
  }
}

function parseFlagSnapshot(output) {
  return Object.fromEntries(
    output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t')),
  )
}

test('embedded flag classifier uses application-equivalent trim semantics for running and Compose values', () => {
  const activeFlag = 'MULTITABLE_ENABLE_PIT_RESET'
  const running = spawnSync(
    process.execPath,
    [
      '-e',
      flagClassifierScript[1],
      'running',
      '_',
      ...ALL_OBSERVED_VARS,
    ],
    {
      env: {
        ...process.env,
        [activeFlag]: '\nTrUe\t',
        MULTITABLE_ENABLE_WRITER_FENCE: ' 1 ',
        // The retention var's activation literal is EXACTLY '1' (global-history-flag-manifest.mjs:
        // activationValue '1', not 'true'), and '1' is precisely what PIT_RESET_RETENTION_BLOCKED()
        // refuses reset on. The classifier must therefore surface it as its own `one` state — never
        // fold it into `true` (which would make the retention breach unnameable) and never into
        // `inactive` (which would make it invisible).
        [RETENTION_CONFLICT_VAR]: ' 1 ',
      },
      encoding: 'utf8',
    },
  )
  assert.equal(running.status, 0, running.stderr)
  assert.deepEqual(parseFlagSnapshot(running.stdout), {
    MULTITABLE_ENABLE_SHEET_REVERT: 'unset',
    MULTITABLE_ENABLE_PIT_RESET: 'true',
    MULTITABLE_HISTORY_CONTIGUITY_STRICT: 'unset',
    MULTITABLE_ENABLE_WRITER_FENCE: 'one',
    MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION: 'unset',
    [RETENTION_CONFLICT_VAR]: 'one',
  })

  const compose = spawnSync(
    process.execPath,
    [
      '-e',
      flagClassifierScript[1],
      'compose',
      'metasheet-backend',
      ...ALL_OBSERVED_VARS,
    ],
    {
      input: JSON.stringify({
        services: {
          backend: {
            container_name: 'metasheet-backend',
            environment: {
              [activeFlag]: '\nTrUe\t',
              MULTITABLE_ENABLE_WRITER_FENCE: false,
            },
          },
        },
      }),
      encoding: 'utf8',
    },
  )
  assert.equal(compose.status, 0, compose.stderr)
  assert.equal(parseFlagSnapshot(compose.stdout)[activeFlag], 'true')
  assert.equal(
    parseFlagSnapshot(compose.stdout).MULTITABLE_ENABLE_WRITER_FENCE,
    'inactive',
  )

  const ambiguous = spawnSync(
    process.execPath,
    [
      '-e',
      flagClassifierScript[1],
      'compose',
      'metasheet-backend',
      ...ALL_OBSERVED_VARS,
    ],
    {
      input: JSON.stringify({
        services: {
          a: { container_name: 'metasheet-backend', environment: {} },
          b: { container_name: 'metasheet-backend', environment: {} },
        },
      }),
      encoding: 'utf8',
    },
  )
  assert.equal(
    ambiguous.status,
    3,
    'zero or duplicate service identity must fail closed rather than classify an arbitrary service',
  )
})

// ── LOCAL pre-SSH segment behaviour harness ─────────────────────────────────────────────────────
// The remote heredoc re-validates MODE/TARGET, but the only guard that can stop a bad value from
// being re-parsed on the ssh command line is the LOCAL `case` that runs BEFORE `ssh`. A structural
// "the case exists" assertion does NOT prove fail-closed: weakening the default-branch `exit 1` to a
// no-op (`:`) leaves the case textually intact while letting an illegal value fall through to ssh.
// So execute the whole `run:` block (up to the ssh line) with a PATH-shadowing `ssh` stub and assert:
// illegal MODE/TARGET/POSTURE → non-zero exit AND ssh NEVER invoked; all legal → ssh reached.
function extractLocalRunScript(text) {
  const lines = text.split('\n')
  const runIdx = lines.findIndex((line) => /^        run: \|\s*$/.test(line))
  assert.ok(runIdx >= 0, 'workflow step must have a `run: |` block')
  let endIdx = lines.length
  for (let i = runIdx + 1; i < lines.length; i++) {
    if (/^      - name:/.test(lines[i])) {
      endIdx = i
      break
    }
  }
  return (
    lines
      .slice(runIdx + 1, endIdx)
      .map((line) => (line.startsWith('          ') ? line.slice(10) : line))
      .join('\n') + '\n'
  )
}

// A PATH-shadowing `ssh` that records that it was reached (drains the heredoc on stdin so bash never
// blocks) and exits 0 — so a test can assert whether the local validation let control reach ssh.
const SSH_STUB = `#!/usr/bin/env bash
printf 'ssh %s\\n' "$*" >> "$STUB_LOG"
cat >/dev/null 2>&1 || true
exit 0
`
writeFileSync(join(containmentBinDir, 'ssh'), SSH_STUB)
chmodSync(join(containmentBinDir, 'ssh'), 0o755)
const localScriptPath = join(containmentStubBase, 'local.sh')
writeFileSync(localScriptPath, extractLocalRunScript(workflowText))

function runLocal({ target, mode, posture = 'inert' }) {
  const logPath = join(containmentStubBase, `local-log-${containmentLogSeq++}.txt`)
  writeFileSync(logPath, '')
  // Fresh HOME so the script's `~/.ssh/{known_hosts,deploy_key}` writes never touch the real home.
  const fakeHome = mkdtempSync(join(tmpdir(), 'ct-home-'))
  const env = {
    ...process.env,
    PATH: `${containmentBinDir}:${process.env.PATH}`,
    HOME: fakeHome,
    STUB_LOG: logPath,
    TARGET: target,
    MODE: mode,
    POSTURE: posture,
    DEPLOY_HOST: 'deploy.invalid',
    DEPLOY_USER: 'deployer',
    DEPLOY_SSH_KEY_B64: Buffer.from('dummy-deploy-key').toString('base64'),
    DEPLOY_KNOWN_HOSTS: 'deploy.invalid ssh-ed25519 AAAAdummyknownhostentry',
  }
  try {
    const result = spawnSync('bash', [localScriptPath], {
      env,
      cwd: containmentStubBase,
      encoding: 'utf8',
    })
    assert.equal(
      result.error,
      undefined,
      `bash must spawn cleanly: ${result.error && result.error.message}`,
    )
    const log = readFileSync(logPath, 'utf8')
    return {
      status: result.status,
      sshCalled: /^ssh /m.test(log),
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    }
  } finally {
    // The per-run fake HOME (holding the script's ~/.ssh writes) is not reused; remove it so
    // repeated runs don't accumulate ct-home-* dirs under the system tmpdir.
    rmSync(fakeHome, { recursive: true, force: true })
  }
}

test('containment local pre-SSH validation FAILS CLOSED for illegal MODE/TARGET/POSTURE', () => {
  // Both legal → local validation passes and control reaches the ssh invocation.
  const ok = runLocal({ target: 'staging', mode: 'predeploy-flags' })
  assert.equal(
    ok.status,
    0,
    `legal MODE+TARGET must pass local validation and reach ssh (stderr: ${ok.stderr})`,
  )
  assert.ok(ok.sshCalled, 'legal MODE+TARGET must reach the ssh invocation')

  // Illegal MODE → non-zero exit AND ssh never called. Weakening the default-branch `exit 1` to a
  // no-op (`:`) would let this value fall through to ssh — this assertion is what reds that mutation.
  const badMode = runLocal({ target: 'staging', mode: 'garbage; touch pwned' })
  assert.notEqual(badMode.status, 0, 'illegal MODE must exit non-zero before ssh')
  assert.equal(
    badMode.sshCalled,
    false,
    'illegal MODE must NEVER reach ssh (the pre-SSH case must fail closed, not just exist)',
  )

  // Illegal TARGET → non-zero exit AND ssh never called.
  const badTarget = runLocal({ target: 'garbage; touch pwned', mode: 'predeploy-flags' })
  assert.notEqual(badTarget.status, 0, 'illegal TARGET must exit non-zero before ssh')
  assert.equal(
    badTarget.sshCalled,
    false,
    'illegal TARGET must NEVER reach ssh (the pre-SSH case must fail closed, not just exist)',
  )

  const badPosture = runLocal({
    target: 'staging',
    mode: 'predeploy-flags',
    posture: 'l1-armed; touch pwned',
  })
  assert.notEqual(badPosture.status, 0, 'illegal POSTURE must exit non-zero before ssh')
  assert.equal(
    badPosture.sshCalled,
    false,
    'illegal POSTURE must NEVER reach ssh',
  )
})

// A containment PASS *verdict* is always mode-tagged: `PASS (predeploy-flags)`
// or `PASS (postdeploy-full)`. The DB helper emits its own `VERDICT: PASS -`
// line (echoed prefixed with `schema:` in full mode), so FAIL scenarios must
// assert on the mode-tagged form, never on a bare /VERDICT: PASS/.
const NO_CONTAINMENT_PASS = /VERDICT: PASS \((?:predeploy-flags|postdeploy-full)\)/

test('containment behavior 1: predeploy-flags + all clean → PASS, helper NOT invoked, both flag legs run', () => {
  const { status, stdout, log } = runRemote({
    target: 'production',
    mode: 'predeploy-flags',
  })
  assert.equal(status, 0)
  assert.match(stdout, /VERDICT: PASS \(predeploy-flags\)/)
  assert.doesNotMatch(stdout, /VERDICT: PASS \(postdeploy-full\)/)
  // Leg 2 must be skipped ENTIRELY: neither the fingerprint read nor the helper
  // execution may appear in the docker call-log.
  assert.ok(
    !log.includes(HELPER_CALL),
    'predeploy-flags must NOT invoke the schema helper (Leg 2 skipped)',
  )
  assert.ok(
    !log.includes(HELPER_SHA_READ),
    'predeploy-flags must NOT even read the helper fingerprint',
  )
  // Both flag legs must have run.
  assert.match(
    log,
    /exec metasheet-backend node -e .* running _ MULTITABLE_ENABLE_SHEET_REVERT/,
    'Leg 1 must classify the running Node environment',
  )
  assert.match(
    log,
    /compose -f \/app\/docker-compose\.app\.yml --project-directory \/app config --format json/,
    'Leg 3 must render next-restart Compose JSON',
  )
  assert.match(
    log,
    /exec -i metasheet-backend node -e .* compose metasheet-backend MULTITABLE_ENABLE_SHEET_REVERT/,
    'Leg 3 must classify the rendered Compose service environment',
  )
})

test('containment behavior 2: postdeploy-full + all clean → PASS, helper IS invoked', () => {
  const { status, stdout, log } = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
  })
  assert.equal(status, 0)
  assert.match(stdout, /VERDICT: PASS \(postdeploy-full\)/)
  assert.doesNotMatch(stdout, /VERDICT: PASS \(predeploy-flags\)/)
  assert.ok(
    log.includes(HELPER_CALL),
    'postdeploy-full must invoke the schema helper (Leg 2)',
  )
})

test('containment behavior 3: predeploy-flags catches a running-env flag=true → FAIL (exit 1)', () => {
  const { status, stdout } = runRemote({
    target: 'production',
    mode: 'predeploy-flags',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: flagSnapshot([
        'MULTITABLE_ENABLE_PIT_RESET',
      ]),
    },
  })
  assert.equal(status, 1)
  // Pin the RUNNING leg specifically (not just any breach).
  assert.match(stdout, /\[running\] MULTITABLE_ENABLE_PIT_RESET=true/)
  assert.match(stdout, /POSTURE MISMATCH/)
  assert.match(stdout, /VERDICT: FAIL/)
  assert.doesNotMatch(stdout, NO_CONTAINMENT_PASS)
})

test('containment behavior 4: predeploy-flags catches a next-restart compose flag=true → FAIL (exit 1)', () => {
  const { status, stdout } = runRemote({
    target: 'production',
    mode: 'predeploy-flags',
    stub: {
      STUB_COMPOSE_FLAG_SNAPSHOT: flagSnapshot([
        'MULTITABLE_ENABLE_WRITER_FENCE',
      ]),
    },
  })
  assert.equal(status, 1)
  // Pin the NEXT-RESTART (compose) leg specifically.
  assert.match(stdout, /\[next-restart\] MULTITABLE_ENABLE_WRITER_FENCE=true/)
  assert.match(stdout, /POSTURE MISMATCH/)
  assert.match(stdout, /VERDICT: FAIL/)
  assert.doesNotMatch(stdout, NO_CONTAINMENT_PASS)
})

test('containment behavior 4b: Compose render failure is fail-closed without leaking raw stderr values', () => {
  const rawSentinel = 'RAW_FLAG_SENTINEL_8f03'
  const { status, stdout, stderr } = runRemote({
    target: 'production',
    mode: 'predeploy-flags',
    stub: {
      STUB_COMPOSE_EXIT: '1',
      STUB_COMPOSE_STDERR: `invalid interpolation near ${rawSentinel}`,
    },
  })
  assert.equal(status, 1)
  assert.match(stdout, /docker compose config --format json.*failed/)
  assert.match(stdout, /compose-config-stderr: suppressed/)
  assert.doesNotMatch(`${stdout}\n${stderr}`, new RegExp(rawSentinel))
  assert.doesNotMatch(stdout, NO_CONTAINMENT_PASS)
})

test('containment behavior 5: full cannot bypass the helper (wrong fingerprint → FAIL), yet predeploy skips it (same fingerprint → PASS)', () => {
  const wrongFingerprint = { STUB_HELPER_SHA: '0'.repeat(64) }

  // postdeploy-full: the pinned-fingerprint gate is the only exit from Leg 2 —
  // a mismatched helper fails closed.
  const full = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    stub: wrongFingerprint,
  })
  assert.equal(full.status, 1)
  assert.match(full.stdout, /schema containment helper is missing or differs/)
  assert.match(full.stdout, /VERDICT: FAIL/)
  assert.doesNotMatch(full.stdout, NO_CONTAINMENT_PASS)

  // predeploy-flags: Leg 2 is skipped, so the very same wrong fingerprint is
  // never read and cannot fail the run.
  const pre = runRemote({
    target: 'production',
    mode: 'predeploy-flags',
    stub: wrongFingerprint,
  })
  assert.equal(pre.status, 0)
  assert.match(pre.stdout, /VERDICT: PASS \(predeploy-flags\)/)
  assert.ok(
    !pre.log.includes(HELPER_SHA_READ),
    'predeploy-flags must not read the helper fingerprint, so a wrong one cannot fail it',
  )
})

test('containment behavior 6: an unexpected MODE fails closed inside the heredoc (exit 2)', () => {
  const { status, stdout, log } = runRemote({
    target: 'production',
    mode: 'garbage',
  })
  assert.equal(status, 2)
  assert.match(stdout, /unexpected mode 'garbage'/)
  assert.doesNotMatch(stdout, NO_CONTAINMENT_PASS)
  // Mode is re-validated before any observation runs — no docker call at all.
  assert.equal(log.trim(), '', 'bad mode must fail before any docker invocation')
})

test('containment behavior 6b: an unexpected POSTURE fails closed before any observation', () => {
  const { status, stdout, log } = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    posture: 'garbage',
  })
  assert.equal(status, 2)
  assert.match(stdout, /unexpected posture 'garbage'/)
  assert.doesNotMatch(stdout, NO_CONTAINMENT_PASS)
  assert.equal(log.trim(), '', 'bad posture must fail before any docker invocation')
})

test('containment behavior 7: postdeploy-full still fails on a running-env flag=true (Leg 1 load-bearing in full, exit 1)', () => {
  const { status, stdout, log } = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: flagSnapshot([], {
        MULTITABLE_ENABLE_WRITER_FENCE: 'one',
      }),
    },
  })
  assert.equal(status, 1)
  assert.match(stdout, /\[running\] MULTITABLE_ENABLE_WRITER_FENCE=one/)
  assert.match(stdout, /POSTURE MISMATCH/)
  assert.match(stdout, /VERDICT: FAIL/)
  assert.doesNotMatch(stdout, NO_CONTAINMENT_PASS)
  // The helper still ran (full mode) — proving the FAIL is Leg 1, not a skip.
  assert.ok(
    log.includes(HELPER_CALL),
    'full mode runs the helper; the FAIL here originates in Leg 1, not a helper skip',
  )
})

const POSTURE_FLAGS = {
  inert: [],
  'l1-armed': [],
  'l2-fence': ['MULTITABLE_ENABLE_WRITER_FENCE'],
  'l2-checkpoint': [
    'MULTITABLE_ENABLE_WRITER_FENCE',
    'MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION',
  ],
  'l3-strict': [
    'MULTITABLE_ENABLE_WRITER_FENCE',
    'MULTITABLE_HISTORY_CONTIGUITY_STRICT',
  ],
  'l4-revert': [
    'MULTITABLE_ENABLE_WRITER_FENCE',
    'MULTITABLE_HISTORY_CONTIGUITY_STRICT',
    'MULTITABLE_ENABLE_SHEET_REVERT',
  ],
  'l5-reset': [
    'MULTITABLE_ENABLE_WRITER_FENCE',
    'MULTITABLE_HISTORY_CONTIGUITY_STRICT',
    'MULTITABLE_ENABLE_SHEET_REVERT',
    'MULTITABLE_ENABLE_PIT_RESET',
  ],
}

test('rung witness: every posture requires its exact trigger state and six-var observation', () => {
  for (const [posture, activeFlags] of Object.entries(POSTURE_FLAGS)) {
    const result = runRemote({
      target: 'production',
      mode: 'postdeploy-full',
      posture,
      stub: {
        STUB_RUNNING_FLAG_SNAPSHOT: flagSnapshot(activeFlags),
        STUB_COMPOSE_FLAG_SNAPSHOT: flagSnapshot(activeFlags),
      },
    })
    assert.equal(
      result.status,
      0,
      `${posture} must PASS its exact posture:\n${result.stdout}\n${result.stderr}`,
    )
    assert.match(result.stdout, new RegExp(`PASS \\(postdeploy-full\\).*'${posture}'`))
    assert.match(
      result.log,
      new RegExp(
        `--expected-trigger-state=${posture === 'inert' ? 'disabled' : 'armed'}`,
      ),
    )
  }
})

test('rung witness: representative missing and extra flags fail each ladder boundary', () => {
  const mutations = [
    {
      posture: 'l2-fence',
      flags: [
        'MULTITABLE_ENABLE_WRITER_FENCE',
        'MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION',
      ],
      expected: /MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION=true — UNEXPECTED ACTIVE/,
    },
    {
      posture: 'l2-checkpoint',
      flags: ['MULTITABLE_ENABLE_WRITER_FENCE'],
      expected:
        /MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION: expected ACTIVE\(true\), observed state=unset/,
    },
    {
      posture: 'l3-strict',
      flags: ['MULTITABLE_HISTORY_CONTIGUITY_STRICT'],
      expected:
        /MULTITABLE_ENABLE_WRITER_FENCE: expected ACTIVE\(true\), observed state=unset/,
    },
    {
      posture: 'l4-revert',
      flags: [
        'MULTITABLE_ENABLE_WRITER_FENCE',
        'MULTITABLE_ENABLE_SHEET_REVERT',
      ],
      expected:
        /MULTITABLE_HISTORY_CONTIGUITY_STRICT: expected ACTIVE\(true\), observed state=unset/,
    },
    {
      posture: 'l5-reset',
      flags: [
        'MULTITABLE_ENABLE_WRITER_FENCE',
        'MULTITABLE_HISTORY_CONTIGUITY_STRICT',
        'MULTITABLE_ENABLE_SHEET_REVERT',
      ],
      expected:
        /MULTITABLE_ENABLE_PIT_RESET: expected ACTIVE\(true\), observed state=unset/,
    },
  ]

  for (const { posture, flags, expected } of mutations) {
    const result = runRemote({
      target: 'production',
      mode: 'postdeploy-full',
      posture,
      stub: {
        STUB_RUNNING_FLAG_SNAPSHOT: flagSnapshot(flags),
        STUB_COMPOSE_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS[posture]),
      },
    })
    assert.equal(result.status, 1, `${posture} mutation must fail`)
    assert.match(result.stdout, expected)
    assert.doesNotMatch(result.stdout, NO_CONTAINMENT_PASS)
  }
})

// ── The sixth observed var: MULTITABLE_META_REVISION_RETENTION_ENABLED ────────────────────────────
// packages/core-backend/src/routes/univer-meta.ts#PIT_RESET_RETENTION_BLOCKED refuses BOTH
// reset-preview and reset-execute with 409 RESET_RETENTION_CONFLICT while this var is exactly '1' —
// unconditionally, before any anchor/trust/authority check. A witness that does not observe it can
// report `posture=l5-reset` PASS on an environment where Reset-to-T cannot run at all: a vacuous
// green on the exact rung that posture exists to witness.
//
// But the expectation is POSTURE-SCOPED, not blanket. The ladder
// (docs/development/multitable-timemachine-o2-enablement-ladder-20260819.md) defines exactly FIVE
// rung flags (§0) and its §E1.2 matrix has one row per posture naming only those five; retention
// appears in NO row. §4 registers retention-era recovery as DECOUPLED from this ladder
// ("retention 后恢复 … 与本阶梯无耦合，另立设计锁") — a separate owner line with its own design lock.
// So:
//   • l5-reset is the ONLY posture that presupposes PIT reset actually working (the only §E1.2 row
//     with MULTITABLE_ENABLE_PIT_RESET ON; §E1.1 step 5 defines the rung as a reset canary drill).
//     There, retention='1' makes the drill structurally impossible ⇒ required INACTIVE.
//   • Everywhere else retention is UNCONSTRAINED: observed and printed, never verdicted. Requiring it
//     OFF at inert/l1…l4 would fail an independent, legitimate retention deployment for a breach of
//     nothing — a posture witness reporting a breach that isn't one.
// The flag manifest models the same reset-scoped coupling: `conflictsWith:
// ['MULTITABLE_META_REVISION_RETENTION_ENABLED']` sits on the MULTITABLE_ENABLE_PIT_RESET key, rule
// id `pit-reset-intent-with-retention-on` (scripts/ops/global-history-flag-manifest.mjs).
//
// The tests below never hand-build the observation. They ask the workflow's OWN `FLAGS=` declaration
// which vars it observes and run the workflow's OWN embedded classifier over a real environment. A
// witness that stops observing the var therefore produces the SHORTER (pre-fix) snapshot for the very
// same environment — which is what these assertions red on, rather than a fixture we chose.
function observedVarsFromWorkflow() {
  const flagsDecl = workflowText.match(/^\s*FLAGS="([^"]+)"$/m)
  assert.ok(flagsDecl, 'workflow must declare FLAGS')
  return flagsDecl[1].trim().split(/\s+/)
}

function classifyRealEnv(overrides) {
  const observed = observedVarsFromWorkflow()
  const env = { ...process.env }
  for (const key of new Set([...observed, ...ALL_OBSERVED_VARS])) delete env[key]
  Object.assign(env, overrides)
  const result = spawnSync(
    process.execPath,
    ['-e', flagClassifierScript[1], 'running', '_', ...observed],
    { env, encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.replace(/\n+$/, '')
}

// THE per-posture retention expectation table, written out for all seven postures rather than derived
// — a derivation would just restate whatever the workflow does. `required-inactive` is claimed for
// exactly the postures whose §E1.2 row turns MULTITABLE_ENABLE_PIT_RESET ON.
const RETENTION_EXPECTATION = {
  inert: 'unconstrained',
  'l1-armed': 'unconstrained',
  'l2-fence': 'unconstrained',
  'l2-checkpoint': 'unconstrained',
  'l3-strict': 'unconstrained',
  'l4-revert': 'unconstrained',
  'l5-reset': 'required-inactive',
}

assert.deepEqual(
  Object.keys(RETENTION_EXPECTATION).sort(),
  Object.keys(POSTURE_FLAGS).sort(),
  'the retention expectation table must cover every posture the witness accepts — a new rung must not default into either verdict silently',
)

// The l5-reset rung's exact active set (ladder §E1.2) PLUS retention at its activation literal '1'.
// This is a state an operator can reach by following the ladder while a separate owner line has
// retention on: every rung flag is correct, and reset is still structurally impossible.
const L5_RESET_ENV_WITH_RETENTION = {
  MULTITABLE_ENABLE_WRITER_FENCE: 'true',
  MULTITABLE_HISTORY_CONTIGUITY_STRICT: 'true',
  MULTITABLE_ENABLE_SHEET_REVERT: 'true',
  MULTITABLE_ENABLE_PIT_RESET: 'true',
  [RETENTION_CONFLICT_VAR]: '1',
}

test("rung witness: posture=l5-reset with retention='1' is a FAIL, not a PASS (the vacuous-green counterexample)", () => {
  const snapshot = classifyRealEnv(L5_RESET_ENV_WITH_RETENTION)
  // Guard the guard: if the witness does not even observe the var, the rest of this test would be
  // asserting on an observation that cannot exist.
  assert.match(
    snapshot,
    new RegExp(`^${RETENTION_CONFLICT_VAR}\\tone$`, 'm'),
    `the witness must observe ${RETENTION_CONFLICT_VAR}; without a row for it the l5-reset verdict is blind to 409 RESET_RETENTION_CONFLICT`,
  )

  const result = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    posture: 'l5-reset',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: snapshot,
      STUB_COMPOSE_FLAG_SNAPSHOT: snapshot,
    },
  })
  assert.equal(
    result.status,
    1,
    `l5-reset with retention active must FAIL; PIT reset refuses 409 RESET_RETENTION_CONFLICT in this state:\n${result.stdout}`,
  )
  // The FAIL must be the retention breach itself, on BOTH legs — not some other mismatch and not
  // "expected ACTIVE(true), observed state=one", which is what a posture that wrongly lists the var
  // in its EXPECTED_ACTIVE_FLAGS would print.
  assert.match(
    result.stdout,
    new RegExp(`\\[running\\] ${RETENTION_CONFLICT_VAR}=one — UNEXPECTED ACTIVE`),
    `l5-reset/running must red as an UNEXPECTED ACTIVE retention breach:\n${result.stdout}`,
  )
  assert.match(
    result.stdout,
    new RegExp(`\\[next-restart\\] ${RETENTION_CONFLICT_VAR}=one — UNEXPECTED ACTIVE`),
    `l5-reset/next-restart must red as an UNEXPECTED ACTIVE retention breach:\n${result.stdout}`,
  )
  assert.doesNotMatch(result.stdout, NO_CONTAINMENT_PASS)
})

test("rung witness (anti-overreach): an active-retention host still PASSES posture=l1-armed, with the var observed", () => {
  // The ladder decouples retention (§4); l1-armed presupposes nothing about reset. An org running a
  // legitimate, separately-owned retention deployment must be able to witness this rung. A blanket
  // "not in EXPECTED_ACTIVE ⇒ must be inactive everywhere" rule fails them here for a breach of
  // nothing — this test is the guard against re-introducing it.
  const snapshot = classifyRealEnv({ [RETENTION_CONFLICT_VAR]: '1' })
  assert.match(
    snapshot,
    new RegExp(`^${RETENTION_CONFLICT_VAR}\\tone$`, 'm'),
    'the fixture must actually have retention active, or this test proves nothing',
  )

  const result = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    posture: 'l1-armed',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: snapshot,
      STUB_COMPOSE_FLAG_SNAPSHOT: snapshot,
    },
  })
  assert.equal(
    result.status,
    0,
    `l1-armed does not presuppose PIT reset, so an active retention deployment must not fail it:\n${result.stdout}`,
  )
  // Positive assertion, not merely "did not fail": the exact PASS sentinel must be present…
  assert.match(
    result.stdout,
    /VERDICT: PASS \(postdeploy-full\) — exact ladder posture 'l1-armed'/,
  )
  // …and the var must still have been OBSERVED and reported. That distinguishes "observed but not
  // asserted" from "silently dropped from the witness".
  assert.match(
    result.stdout,
    new RegExp(
      `\\[running\\] ${RETENTION_CONFLICT_VAR}=one — OBSERVED, NOT CONSTRAINED at posture 'l1-armed'`,
    ),
    `the running leg must still report the retention state at l1-armed:\n${result.stdout}`,
  )
  assert.match(
    result.stdout,
    new RegExp(
      `\\[next-restart\\] ${RETENTION_CONFLICT_VAR}=one — OBSERVED, NOT CONSTRAINED at posture 'l1-armed'`,
    ),
    `the next-restart leg must still report the retention state at l1-armed:\n${result.stdout}`,
  )
})

test("rung witness: at l5-reset retention='true' reds too — the documented operator-intent choice, not an accident", () => {
  // The workflow comment, this PR, and the manifest all state that `true` is a documented SILENT
  // NO-OP for this var (its activationValue is exactly '1'), and that redding on it anyway is a
  // deliberate fail-closed choice about operator INTENT — enabling retention on a rung that requires
  // it off. An asserted invariant nobody tests is a bug in waiting, so drive it.
  const snapshot = classifyRealEnv({
    ...L5_RESET_ENV_WITH_RETENTION,
    [RETENTION_CONFLICT_VAR]: 'true',
  })
  assert.match(
    snapshot,
    new RegExp(`^${RETENTION_CONFLICT_VAR}\\ttrue$`, 'm'),
    "the classifier must surface 'true' as its own state, distinct from the reset-blocking 'one'",
  )

  const result = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    posture: 'l5-reset',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: snapshot,
      STUB_COMPOSE_FLAG_SNAPSHOT: snapshot,
    },
  })
  assert.equal(
    result.status,
    1,
    `l5-reset must red on retention='true' as operator intent, not only on the '1' literal:\n${result.stdout}`,
  )
  assert.match(
    result.stdout,
    new RegExp(`\\[running\\] ${RETENTION_CONFLICT_VAR}=true — UNEXPECTED ACTIVE`),
    `${result.stdout}`,
  )
  assert.doesNotMatch(result.stdout, NO_CONTAINMENT_PASS)

  // Symmetric anti-overreach: the same 'true' must NOT fail a posture that does not presuppose reset.
  const unconstrained = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    posture: 'l1-armed',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: classifyRealEnv({ [RETENTION_CONFLICT_VAR]: 'true' }),
      STUB_COMPOSE_FLAG_SNAPSHOT: classifyRealEnv({ [RETENTION_CONFLICT_VAR]: 'true' }),
    },
  })
  assert.equal(unconstrained.status, 0, unconstrained.stdout)
  assert.match(
    unconstrained.stdout,
    new RegExp(
      `\\[running\\] ${RETENTION_CONFLICT_VAR}=true — OBSERVED, NOT CONSTRAINED at posture 'l1-armed'`,
    ),
    `${unconstrained.stdout}`,
  )
})

test('rung witness: retention is asserted-inactive ONLY at reset-presupposing postures, on both legs', () => {
  for (const [posture, activeFlags] of Object.entries(POSTURE_FLAGS)) {
    const expectation = RETENTION_EXPECTATION[posture]
    const breachedSnapshot = classifyRealEnv({
      ...Object.fromEntries(activeFlags.map((flag) => [flag, 'true'])),
      [RETENTION_CONFLICT_VAR]: '1',
    })
    const cleanSnapshot = flagSnapshot(activeFlags)

    // Table integrity: `required-inactive` is claimed exactly where the rung turns PIT reset ON.
    assert.equal(
      expectation === 'required-inactive',
      activeFlags.includes('MULTITABLE_ENABLE_PIT_RESET'),
      `${posture}: retention may be asserted only where the ladder presupposes PIT reset (§E1.2 row) — expectation table and rung matrix disagree`,
    )

    for (const leg of ['STUB_RUNNING_FLAG_SNAPSHOT', 'STUB_COMPOSE_FLAG_SNAPSHOT']) {
      const result = runRemote({
        target: 'production',
        mode: 'postdeploy-full',
        posture,
        stub: {
          STUB_RUNNING_FLAG_SNAPSHOT: cleanSnapshot,
          STUB_COMPOSE_FLAG_SNAPSHOT: cleanSnapshot,
          [leg]: breachedSnapshot,
        },
      })
      const context = leg === 'STUB_RUNNING_FLAG_SNAPSHOT' ? 'running' : 'next-restart'

      if (expectation === 'required-inactive') {
        assert.equal(
          result.status,
          1,
          `${posture}/${context}: retention='1' must fail a rung that presupposes reset:\n${result.stdout}`,
        )
        assert.match(
          result.stdout,
          new RegExp(`\\[${context}\\] ${RETENTION_CONFLICT_VAR}=one — UNEXPECTED ACTIVE`),
          `${posture}/${context}: retention='1' must red as UNEXPECTED ACTIVE — a posture that lists it in EXPECTED_ACTIVE_FLAGS prints "expected ACTIVE(true), observed state=one" instead:\n${result.stdout}`,
        )
        assert.doesNotMatch(result.stdout, NO_CONTAINMENT_PASS)
      } else {
        assert.equal(
          result.status,
          0,
          `${posture}/${context}: the ladder decouples retention (§4) and this rung does not presuppose reset, so retention='1' must NOT fail it:\n${result.stdout}`,
        )
        assert.match(
          result.stdout,
          new RegExp(`VERDICT: PASS \\(postdeploy-full\\) — exact ladder posture '${posture}'`),
          `${posture}/${context}: must emit its exact PASS sentinel:\n${result.stdout}`,
        )
        assert.match(
          result.stdout,
          new RegExp(
            `\\[${context}\\] ${RETENTION_CONFLICT_VAR}=one — OBSERVED, NOT CONSTRAINED at posture '${posture}'`,
          ),
          `${posture}/${context}: unconstrained must still mean OBSERVED — the state has to appear in the report:\n${result.stdout}`,
        )
        // Unconstrained never leaks into the rung flags: every one of the five is still verdicted.
        // Named one-by-one (not a `MULTITABLE_ENABLE_\w+` wildcard — that would silently miss
        // MULTITABLE_HISTORY_CONTIGUITY_STRICT and, with the `=<state>` suffix, match nothing at all).
        for (const rungFlag of ALL_OBSERVED_VARS.filter((v) => v !== RETENTION_CONFLICT_VAR)) {
          assert.doesNotMatch(
            result.stdout,
            new RegExp(`\\[${context}\\] ${rungFlag}=\\w+ — OBSERVED, NOT CONSTRAINED`),
            `${posture}/${context}: ${rungFlag} is a rung flag and may never reach the unconstrained branch:\n${result.stdout}`,
          )
        }
      }

      // Implementation-derived per-posture contract: read what the remote script itself echoes rather
      // than re-parsing the YAML case block. No posture may list the retention var as expected-ACTIVE,
      // and the required-inactive set must match this table exactly.
      const echoed = result.stdout.match(
        /^posture='[^']*' expected_trigger_state='[^']*' expected_active_flags='([^']*)' expected_inactive_non_rung_vars='([^']*)'$/m,
      )
      assert.ok(echoed, `${posture}: the remote script must echo its resolved rung contract`)
      assert.ok(
        !echoed[1].includes(RETENTION_CONFLICT_VAR),
        `${posture} must never expect ${RETENTION_CONFLICT_VAR} ACTIVE (echoed: ${echoed[1]})`,
      )
      const echoedInactive = echoed[2] === '<none>' ? '' : echoed[2]
      assert.equal(
        echoedInactive.split(/\s+/).filter(Boolean).includes(RETENTION_CONFLICT_VAR),
        expectation === 'required-inactive',
        `${posture}: the echoed required-inactive set must match the expectation table (echoed: ${echoed[2]}, expected: ${expectation})`,
      )
    }
  }

  // The retention guard lives in Legs 1/3, so it is NOT coupled to the schema leg: predeploy-flags
  // (which skips Leg 2 entirely) must still red on the same breach, with the helper never invoked.
  const predeploy = runRemote({
    target: 'production',
    mode: 'predeploy-flags',
    posture: 'l5-reset',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: classifyRealEnv(L5_RESET_ENV_WITH_RETENTION),
      STUB_COMPOSE_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l5-reset']),
    },
  })
  assert.equal(predeploy.status, 1, predeploy.stdout)
  assert.match(
    predeploy.stdout,
    new RegExp(`\\[running\\] ${RETENTION_CONFLICT_VAR}=one — UNEXPECTED ACTIVE`),
  )
  assert.doesNotMatch(predeploy.stdout, NO_CONTAINMENT_PASS)
  assert.ok(
    !predeploy.log.includes(HELPER_CALL),
    'the retention guard must be Leg 1/3 — it cannot depend on the schema helper running',
  )

  // Mirror image in predeploy-flags mode: the anti-overreach case must PASS there too, with its own
  // distinct sentinel, so the decoupling is not accidentally mode-specific.
  const predeployUnconstrained = runRemote({
    target: 'production',
    mode: 'predeploy-flags',
    posture: 'l4-revert',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: classifyRealEnv({
        ...Object.fromEntries(
          POSTURE_FLAGS['l4-revert'].map((flag) => [flag, 'true']),
        ),
        [RETENTION_CONFLICT_VAR]: '1',
      }),
      STUB_COMPOSE_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l4-revert']),
    },
  })
  assert.equal(predeployUnconstrained.status, 0, predeployUnconstrained.stdout)
  assert.match(
    predeployUnconstrained.stdout,
    /VERDICT: PASS \(predeploy-flags\) — exact ladder posture 'l4-revert'/,
  )
})

test('rung witness: the five rung flags stay closed-world — unconstrained never reaches them', () => {
  // Guard for the new three-way branch: if a rung flag ever fell through to "observed, not
  // constrained", MULTITABLE_ENABLE_PIT_RESET=true would start PASSING posture=inert. Drive every
  // rung flag active at posture=inert (which expects none of them) and require each to red.
  for (const rungFlag of ALL_OBSERVED_VARS.filter((v) => v !== RETENTION_CONFLICT_VAR)) {
    const snapshot = classifyRealEnv({ [rungFlag]: 'true' })
    const result = runRemote({
      target: 'production',
      mode: 'postdeploy-full',
      posture: 'inert',
      stub: {
        STUB_RUNNING_FLAG_SNAPSHOT: snapshot,
        STUB_COMPOSE_FLAG_SNAPSHOT: snapshot,
      },
    })
    assert.equal(
      result.status,
      1,
      `${rungFlag}=true must fail posture=inert — rung flags are closed-world, never unconstrained:\n${result.stdout}`,
    )
    assert.match(
      result.stdout,
      new RegExp(`\\[running\\] ${rungFlag}=true — UNEXPECTED ACTIVE`),
      `${rungFlag} must red as UNEXPECTED ACTIVE, not be reported as unconstrained:\n${result.stdout}`,
    )
    assert.doesNotMatch(
      result.stdout,
      new RegExp(`${rungFlag}=true — OBSERVED, NOT CONSTRAINED`),
    )
    assert.doesNotMatch(result.stdout, NO_CONTAINMENT_PASS)
  }
})

test('rung witness: an observation missing the retention row is BROKEN, never a PASS', () => {
  // The pre-fix witness classified five vars, so its snapshot had no row for the retention var at
  // all. Such a snapshot must not be read as "retention is fine" — nothing-observed is not evidence.
  const fiveRowSnapshot = flagSnapshot(POSTURE_FLAGS['l5-reset'])
    .split('\n')
    .filter((line) => !line.startsWith(`${RETENTION_CONFLICT_VAR}\t`))
    .join('\n')
  assert.equal(fiveRowSnapshot.split('\n').length, 5)

  const result = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    posture: 'l5-reset',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: fiveRowSnapshot,
      STUB_COMPOSE_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l5-reset']),
    },
  })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /flag snapshot count=5, expected=6/)
  assert.doesNotMatch(result.stdout, NO_CONTAINMENT_PASS)
})

test('rung witness: wrong trigger state and malformed classifier output fail closed', () => {
  const wrongTriggerState = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    posture: 'l1-armed',
    stub: { STUB_HELPER_OUT: schemaPassLineDisabled[1] },
  })
  assert.equal(wrongTriggerState.status, 1)
  assert.match(wrongTriggerState.stdout, /did not emit its exact PASS sentinel/)

  const duplicateRow = runRemote({
    target: 'production',
    mode: 'predeploy-flags',
    posture: 'inert',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: `${flagSnapshot()}\nMULTITABLE_ENABLE_WRITER_FENCE\ttrue`,
    },
  })
  assert.equal(duplicateRow.status, 1)
  assert.match(duplicateRow.stdout, /flag snapshot count=7, expected=6/)
})

test('target=both observes both exact containers and runs the full helper twice', () => {
  const result = runRemote({
    target: 'both',
    mode: 'postdeploy-full',
    posture: 'l1-armed',
    stub: {
      STUB_PS_NAMES: 'metasheet-backend\nmetasheet-staging-backend',
    },
  })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  assert.match(result.stdout, /-- container: metasheet-backend/)
  assert.match(result.stdout, /-- container: metasheet-staging-backend/)
  assert.match(result.stdout, /containers expected: 2/)
  assert.equal(
    result.log.split(HELPER_CALL).length - 1,
    2,
    'postdeploy-full target=both must invoke the schema helper once per expected container',
  )
})

test('containment structure: the two mode PASS sentinels are DISTINCT (a predeploy PASS can never read as a full PASS)', () => {
  const passSentinels = [
    ...workflowText.matchAll(/echo "(VERDICT: PASS \([^)]*\)[^"]*)"/g),
  ].map((match) => match[1])
  assert.equal(
    passSentinels.length,
    2,
    'exactly two mode-tagged PASS sentinels (predeploy-flags + postdeploy-full)',
  )
  assert.notEqual(
    passSentinels[0],
    passSentinels[1],
    'a predeploy PASS sentinel must never be identical to the full PASS sentinel',
  )
  const joined = passSentinels.join('\n')
  assert.match(joined, /PASS \(predeploy-flags\)/)
  assert.match(joined, /PASS \(postdeploy-full\)/)
  // The distinction must be substantive: full asserts the schema WAS verified,
  // predeploy explicitly states it was NOT.
  assert.ok(
    passSentinels.some((line) => /database recovery schema matches/.test(line)),
    'the full PASS sentinel must state the DB schema was verified',
  )
  assert.ok(
    passSentinels.some((line) =>
      /database recovery schema NOT verified/i.test(line),
    ),
    'the predeploy PASS sentinel must state the DB schema was NOT verified',
  )
})

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// P2 (2026-08-25) — the l2-checkpoint posture must not PASS vacuously.
//
// Trust-checkpoint activation refuses EVERY sheet while MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST
// is unset or empty (the fail-closed default introduced with the DB-fresh activation authority).
// The posture witness enumerated only the five rung FLAGS, so `posture=l2-checkpoint` could report
// PASS on a host where minting the canary checkpoint — the one thing that rung exists to do — was
// structurally impossible. Same vacuous-green shape #5155 fixes for the retention conflict var.
//
// The requirement is DERIVED from the rung contract (`flag_expected_active
// MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION`), not from a hardcoded posture name, so the matrix
// below is the honest per-posture coverage: empty allowlist FAILS exactly the postures that turn
// activation on, and leaves every other rung PASSing.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const EMPTY_ALLOWLIST_PROBE = allowlistProbe('empty', 0)
const UNSET_ALLOWLIST_PROBE = allowlistProbe('unset', 0)

function posturesExpectingActivation() {
  return Object.entries(POSTURE_FLAGS)
    .filter(([, flags]) => flags.includes('MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION'))
    .map(([posture]) => posture)
}

test('non-vacuity matrix: an EMPTY allowlist fails exactly the postures that turn activation on', () => {
  const requiring = posturesExpectingActivation()
  // Sanity: the derivation must actually select something, or the whole matrix below is vacuous.
  assert.deepEqual(requiring, ['l2-checkpoint'])

  for (const [posture, activeFlags] of Object.entries(POSTURE_FLAGS)) {
    const result = runRemote({
      target: 'production',
      mode: 'postdeploy-full',
      posture,
      stub: {
        STUB_RUNNING_FLAG_SNAPSHOT: flagSnapshot(activeFlags),
        STUB_COMPOSE_FLAG_SNAPSHOT: flagSnapshot(activeFlags),
        STUB_RUNNING_ALLOWLIST_PROBE: EMPTY_ALLOWLIST_PROBE,
        STUB_COMPOSE_ALLOWLIST_PROBE: EMPTY_ALLOWLIST_PROBE,
      },
    })
    if (requiring.includes(posture)) {
      assert.equal(
        result.status,
        1,
        `${posture} presupposes reachable activation — an empty allowlist must FAIL it:\n${result.stdout}`,
      )
      assert.match(result.stdout, /NOT DESIGNATED/)
      assert.match(result.stdout, /cannot be witnessed non-vacuously/)
      assert.doesNotMatch(result.stdout, NO_CONTAINMENT_PASS)
    } else {
      // The rungs where activation is OFF presuppose a checkpoint ROW, which this env var cannot
      // witness; demanding it there would false-red an operator following ladder §E1.1 step 2/3
      // (which removes the activation flag and returns to posture=l2-fence).
      assert.equal(
        result.status,
        0,
        `${posture} does not turn activation on — the allowlist must not be demanded:\n${result.stdout}`,
      )
      assert.doesNotMatch(result.stdout, /NOT DESIGNATED/)
      assert.doesNotMatch(result.stdout, new RegExp(CHECKPOINT_ALLOWLIST_VAR))
    }
  }
})

test('non-vacuity: the false-PASS counterexample — l2-checkpoint with no designated canary is FAIL, unset and empty alike', () => {
  for (const probe of [EMPTY_ALLOWLIST_PROBE, UNSET_ALLOWLIST_PROBE]) {
    const result = runRemote({
      target: 'production',
      mode: 'postdeploy-full',
      posture: 'l2-checkpoint',
      stub: {
        STUB_RUNNING_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l2-checkpoint']),
        STUB_COMPOSE_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l2-checkpoint']),
        STUB_RUNNING_ALLOWLIST_PROBE: probe,
        STUB_COMPOSE_ALLOWLIST_PROBE: probe,
      },
    })
    assert.equal(result.status, 1, `probe=${probe} must fail l2-checkpoint:\n${result.stdout}`)
    assert.match(result.stdout, /VERDICT: FAIL/)
    assert.doesNotMatch(result.stdout, NO_CONTAINMENT_PASS)
    // Every rung flag was correct — the ONLY reason for the FAIL is the missing designation, so this
    // is a discriminating counterexample, not a snapshot that failed for an unrelated reason.
    assert.doesNotMatch(result.stdout, /POSTURE MISMATCH\n.*expected ACTIVE/)
    assert.match(result.stdout, /MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION=true — ACTIVE AS EXPECTED/)
  }

  // Positive control on the same posture: a DESIGNATED canary passes, so the FAIL above is the
  // designation and nothing else.
  const designated = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    posture: 'l2-checkpoint',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l2-checkpoint']),
      STUB_COMPOSE_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l2-checkpoint']),
    },
  })
  assert.equal(designated.status, 0, designated.stdout)
  assert.match(designated.stdout, /\[running\] MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST: DESIGNATED \(entries=1\)/)
  assert.match(designated.stdout, /\[next-restart\] MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST: DESIGNATED \(entries=1\)/)
})

test('non-vacuity: the NEXT-RESTART leg is load-bearing on its own (a running-only designation disappears on the next compose up)', () => {
  const result = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    posture: 'l2-checkpoint',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l2-checkpoint']),
      STUB_COMPOSE_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l2-checkpoint']),
      STUB_RUNNING_ALLOWLIST_PROBE: DESIGNATED_ALLOWLIST_PROBE,
      STUB_COMPOSE_ALLOWLIST_PROBE: UNSET_ALLOWLIST_PROBE,
    },
  })
  assert.equal(result.status, 1, result.stdout)
  assert.match(result.stdout, /\[next-restart\] MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST: NOT DESIGNATED/)
  assert.match(result.stdout, /\[running\] MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST: DESIGNATED/)
  assert.doesNotMatch(result.stdout, NO_CONTAINMENT_PASS)
})

test('non-vacuity: a BROKEN allowlist probe fails closed, never "the requirement did not apply"', () => {
  // `set -uo pipefail` carries no `-e`, so a non-zero probe must be handled explicitly.
  const runningBroken = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    posture: 'l2-checkpoint',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l2-checkpoint']),
      STUB_COMPOSE_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l2-checkpoint']),
      STUB_RUNNING_ALLOWLIST_EXIT: '3',
    },
  })
  assert.equal(runningBroken.status, 1, runningBroken.stdout)
  assert.match(runningBroken.stdout, /cannot classify MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST in the running environment/)
  assert.doesNotMatch(runningBroken.stdout, NO_CONTAINMENT_PASS)

  const composeBroken = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    posture: 'l2-checkpoint',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l2-checkpoint']),
      STUB_COMPOSE_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l2-checkpoint']),
      STUB_COMPOSE_ALLOWLIST_EXIT: '4',
    },
  })
  assert.equal(composeBroken.status, 1, composeBroken.stdout)
  assert.match(composeBroken.stdout, /cannot classify MULTITABLE_TRUST_CHECKPOINT_SHEET_ALLOWLIST in the rendered Compose environment/)

  // Malformed / duplicated / unknown-state rows are observation failures too — never a silent pass.
  const duplicated = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    posture: 'l2-checkpoint',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l2-checkpoint']),
      STUB_COMPOSE_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l2-checkpoint']),
      STUB_RUNNING_ALLOWLIST_PROBE: `${DESIGNATED_ALLOWLIST_PROBE}\n${DESIGNATED_ALLOWLIST_PROBE}`,
    },
  })
  assert.equal(duplicated.status, 1, duplicated.stdout)
  assert.match(duplicated.stdout, /probe returned 2 rows, expected exactly 1 \(observation broken\)/)

  const unknownState = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    posture: 'l2-checkpoint',
    stub: {
      STUB_RUNNING_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l2-checkpoint']),
      STUB_COMPOSE_FLAG_SNAPSHOT: flagSnapshot(POSTURE_FLAGS['l2-checkpoint']),
      STUB_RUNNING_ALLOWLIST_PROBE: allowlistProbe('probably-fine', 0),
    },
  })
  assert.equal(unknownState.status, 1, unknownState.stdout)
  assert.match(unknownState.stdout, /probe returned unknown state='probably-fine' \(observation broken\)/)
})

test('non-vacuity: the embedded allowlist classifier witnesses PRESENCE only — designated sheet ids are never emitted', () => {
  const allowlistClassifier = workflowText.match(/^\s*ALLOWLIST_CLASSIFIER_JS='(.+)'$/m)
  assert.ok(allowlistClassifier, 'workflow must define ALLOWLIST_CLASSIFIER_JS')

  const secretIds = 'shtCanaryZZZ-do-not-print-1,shtCanaryZZZ-do-not-print-2'
  const running = spawnSync(
    process.execPath,
    ['-e', allowlistClassifier[1], 'running-allowlist', '_', CHECKPOINT_ALLOWLIST_VAR],
    {
      encoding: 'utf8',
      env: { ...process.env, [CHECKPOINT_ALLOWLIST_VAR]: secretIds },
    },
  )
  assert.equal(running.status, 0, running.stderr)
  assert.equal(running.stdout, `${CHECKPOINT_ALLOWLIST_VAR}\tdesignated\t2\n`)
  for (const id of secretIds.split(',')) {
    assert.doesNotMatch(running.stdout, new RegExp(id))
    assert.doesNotMatch(running.stderr, new RegExp(id))
  }

  // Compose leg: same presence-only contract, source = the rendered compose service environment.
  const compose = spawnSync(
    process.execPath,
    ['-e', allowlistClassifier[1], 'compose-allowlist', 'metasheet-backend', CHECKPOINT_ALLOWLIST_VAR],
    {
      encoding: 'utf8',
      input: JSON.stringify({
        services: {
          backend: {
            container_name: 'metasheet-backend',
            environment: { [CHECKPOINT_ALLOWLIST_VAR]: secretIds },
          },
        },
      }),
      env: { ...process.env, [CHECKPOINT_ALLOWLIST_VAR]: '' },
    },
  )
  assert.equal(compose.status, 0, compose.stderr)
  assert.equal(compose.stdout, `${CHECKPOINT_ALLOWLIST_VAR}\tdesignated\t2\n`)
  assert.doesNotMatch(compose.stdout, /do-not-print/)

  // Entry semantics are the in-process parser's, verbatim (split ',', trim, drop empties):
  // every fail-closed spelling counts 0, and a blank entry never inflates the count.
  const cases = [
    [undefined, 'unset', '0'],
    ['', 'empty', '0'],
    ['   ', 'empty', '0'],
    [',', 'empty', '0'],
    [' , , ', 'empty', '0'],
    ['shtA', 'designated', '1'],
    [' shtA , shtB ', 'designated', '2'],
    ['shtA,,shtB', 'designated', '2'],
  ]
  for (const [raw, expectedState, expectedCount] of cases) {
    const env = { ...process.env }
    if (raw === undefined) delete env[CHECKPOINT_ALLOWLIST_VAR]
    else env[CHECKPOINT_ALLOWLIST_VAR] = raw
    const probe = spawnSync(
      process.execPath,
      ['-e', allowlistClassifier[1], 'running-allowlist', '_', CHECKPOINT_ALLOWLIST_VAR],
      { encoding: 'utf8', env },
    )
    assert.equal(probe.status, 0, probe.stderr)
    assert.equal(
      probe.stdout,
      `${CHECKPOINT_ALLOWLIST_VAR}\t${expectedState}\t${expectedCount}\n`,
      `raw=${JSON.stringify(raw)}`,
    )
  }

  // An unknown mode is a hard exit, never a silent "nothing observed".
  const badMode = spawnSync(
    process.execPath,
    ['-e', allowlistClassifier[1], 'running', '_', CHECKPOINT_ALLOWLIST_VAR],
    { encoding: 'utf8', env: process.env },
  )
  assert.equal(badMode.status, 2)
})

test('non-vacuity: the probe is wired into BOTH legs and gated on the rung contract, not on a posture name', () => {
  // Static contract. Deleting either call site, or replacing the derivation with a posture-name
  // comparison, must red this required lane — the behavior tests above cannot see a call that was
  // moved out of a leg, only one that changed its verdict.
  const calls = [
    ...workflowText.matchAll(
      /node -e "\$ALLOWLIST_CLASSIFIER_JS" (running-allowlist|compose-allowlist)[^\n]*"\$CHECKPOINT_ALLOWLIST_VAR"/g,
    ),
  ].map((match) => match[1])
  assert.deepEqual(
    calls.sort(),
    ['compose-allowlist', 'running-allowlist'],
    'the allowlist probe must run on BOTH the running-env leg and the next-restart leg',
  )
  // Each call site is guarded by the DERIVED condition.
  const guards = [
    ...workflowText.matchAll(
      /if flag_expected_active MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION; then/g,
    ),
  ]
  assert.equal(
    guards.length,
    2,
    'both probe call sites must derive the requirement from the posture expected-active set',
  )
  // And the classifier must be a SEPARATE constant: folding it into FLAG_CLASSIFIER_JS would make
  // the five-flag ACTIVE/INACTIVE contract answer a question about a list-valued variable.
  assert.notEqual(
    workflowText.match(/^\s*ALLOWLIST_CLASSIFIER_JS='(.+)'$/m)[1],
    flagClassifierScript[1],
  )
})
