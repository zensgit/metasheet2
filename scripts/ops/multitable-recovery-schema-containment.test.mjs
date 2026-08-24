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

test('workflow FLAGS pins exactly the five ladder recovery flags, classified by both legs', () => {
  const workflow = readFileSync(
    join(repoRoot, '.github/workflows/multitable-recovery-flag-containment-check.yml'),
    'utf8',
  )
  // The remote heredoc declares FLAGS once; both the running-env leg and the next-restart leg invoke
  // the same classifier with that set. Pin the EXACT set so a silently dropped flag (e.g. deleting
  // MULTITABLE_ENABLE_WRITER_FENCE) cannot pass green — it must red this required (test 20.x) contract.
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
    ],
    'the witness must verdict exactly the five ladder flags, including transient trust-checkpoint activation',
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

const ALL_LADDER_FLAGS = [
  'MULTITABLE_ENABLE_SHEET_REVERT',
  'MULTITABLE_ENABLE_PIT_RESET',
  'MULTITABLE_HISTORY_CONTIGUITY_STRICT',
  'MULTITABLE_ENABLE_WRITER_FENCE',
  'MULTITABLE_ENABLE_TRUST_CHECKPOINT_ACTIVATION',
]

function flagSnapshot(activeFlags = [], overrides = {}) {
  const active = new Set(activeFlags)
  return ALL_LADDER_FLAGS.map((flag) => {
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
      ...ALL_LADDER_FLAGS,
    ],
    {
      env: {
        ...process.env,
        [activeFlag]: '\nTrUe\t',
        MULTITABLE_ENABLE_WRITER_FENCE: ' 1 ',
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
  })

  const compose = spawnSync(
    process.execPath,
    [
      '-e',
      flagClassifierScript[1],
      'compose',
      'metasheet-backend',
      ...ALL_LADDER_FLAGS,
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
      ...ALL_LADDER_FLAGS,
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

test('rung witness: every posture requires its exact trigger state and five-flag set', () => {
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
  assert.match(duplicateRow.stdout, /flag snapshot count=6, expected=5/)
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
