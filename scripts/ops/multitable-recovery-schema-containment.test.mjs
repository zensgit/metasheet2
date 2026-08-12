#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  assessSchemaSnapshot,
  expectedSchemaSnapshot,
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

test('with the FK removed the helper returns PASS with the exact workflow sentinel line', async () => {
  const snapshot = expectedCopy()
  snapshot.metaLinksForeignRecordFks = []
  const result = await runSchemaContainment({
    env: { DATABASE_URL: 'postgresql://placeholder.invalid/scratch' },
    querySnapshot: async () => snapshot,
  })
  assert.equal(result.exitCode, 0)
  assert.match(result.output, /meta-links-foreign-record-id-fk-absence: PASS count=0\/0/)

  // The workflow greps its SCHEMA_PASS_LINE with `grep -qxF` (exact full line). Keep the helper's
  // PASS sentinel and the workflow constant in lockstep, or leg 2 fails at runtime despite exit 0.
  const workflow = readFileSync(
    join(
      repoRoot,
      '.github/workflows/multitable-recovery-flag-containment-check.yml',
    ),
    'utf8',
  )
  const sentinel = workflow.match(/^\s*SCHEMA_PASS_LINE="(.+)"$/m)
  assert.ok(sentinel, 'workflow must define SCHEMA_PASS_LINE')
  assert.ok(
    result.output.split('\n').includes(sentinel[1]),
    'helper PASS output must contain the exact SCHEMA_PASS_LINE the workflow greps for',
  )
})

test('workflow FLAGS pins exactly the four default-inert recovery flags, consumed by both legs', () => {
  const workflow = readFileSync(
    join(repoRoot, '.github/workflows/multitable-recovery-flag-containment-check.yml'),
    'utf8',
  )
  // The remote heredoc declares FLAGS once; both the running-env leg and the next-restart leg iterate
  // `for f in $FLAGS`. Pin the EXACT set so a silently dropped flag (e.g. deleting
  // MULTITABLE_ENABLE_WRITER_FENCE) cannot pass green — it must red this required (test 20.x) contract.
  const flagsDecl = workflow.match(/^\s*FLAGS="([^"]+)"$/m)
  assert.ok(flagsDecl, 'workflow must declare FLAGS')
  const flags = flagsDecl[1].trim().split(/\s+/).sort()
  assert.deepEqual(
    flags,
    [
      'MULTITABLE_ENABLE_PIT_RESET',
      'MULTITABLE_ENABLE_SHEET_REVERT',
      'MULTITABLE_ENABLE_WRITER_FENCE',
      'MULTITABLE_HISTORY_CONTIGUITY_STRICT',
    ],
    'containment must verdict EXACTLY the four default-inert recovery flags: the two destructive execute gates (SHEET_REVERT/PIT_RESET) plus the two seam/fence consumers the closeout makes reachable (HISTORY_CONTIGUITY_STRICT/ENABLE_WRITER_FENCE)',
  )
  // Both legs must consume FLAGS or a flag is only half-checked. Assert exactly two `for f in $FLAGS`.
  const loopCount = (workflow.match(/for f in \$FLAGS/g) || []).length
  assert.equal(loopCount, 2, 'both the running-env and next-restart legs must iterate `for f in $FLAGS`')
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
const schemaPassLine = workflowText.match(/^\s*SCHEMA_PASS_LINE="(.+)"$/m)
assert.ok(schemaPassLine, 'workflow must define SCHEMA_PASS_LINE')

// A PATH-shadowing `docker`. Every invocation is appended to $STUB_LOG (so a
// test can assert whether `node …-schema-containment.mjs` ran), and each
// subcommand's output is driven by STUB_* env vars.
const DOCKER_STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
cmd="\${1:-}"; shift || true
case "$cmd" in
  compose)
    for a in "$@"; do [ "$a" = "version" ] && exit 0; done
    printf '%s\\n' "$STUB_COMPOSE_CONFIG"; exit 0 ;;
  ps)
    printf '%s\\n' "$STUB_PS_NAMES"; exit 0 ;;
  exec)
    shift
    sub="\${1:-}"; shift || true
    case "$sub" in
      env) printf '%s\\n' "$STUB_ENV"; exit 0 ;;
      sha256sum) printf '%s  %s\\n' "$STUB_HELPER_SHA" "\${1:-}"; exit 0 ;;
      node) printf '%s\\n' "$STUB_HELPER_OUT"; exit "\${STUB_HELPER_EXIT:-0}" ;;
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

// Clean defaults are padded well clear of the `-lt 5` plausibility gates in
// legs 1 and 3 so a future edit can't silently turn a clean run into an
// "implausibly small" FAIL. No default value normalizes to true/1.
const CLEAN_ENV = [
  'PATH=/usr/local/bin:/usr/bin:/bin',
  'HOME=/root',
  'HOSTNAME=metasheet-backend',
  'NODE_ENV=production',
  'LANG=C.UTF-8',
  'PWD=/app',
  'TERM=xterm',
  'SHLVL=1',
].join('\n')
const CLEAN_COMPOSE = [
  'services:',
  '  backend:',
  '    image: metasheet-backend:latest',
  '    restart: unless-stopped',
  '    environment:',
  '      NODE_ENV: "production"',
  '      PORT: "3000"',
  '      TZ: "UTC"',
].join('\n')

let containmentLogSeq = 0
function runRemote({ target, mode, stub = {} }) {
  const logPath = join(containmentStubBase, `log-${containmentLogSeq++}.txt`)
  writeFileSync(logPath, '')
  const env = {
    ...process.env,
    PATH: `${containmentBinDir}:${process.env.PATH}`,
    STUB_LOG: logPath,
    TARGET: target,
    MODE: mode,
    STUB_PS_NAMES: 'metasheet-backend',
    STUB_ENV: CLEAN_ENV,
    STUB_HELPER_SHA: schemaHelperSha[1],
    STUB_HELPER_OUT: schemaPassLine[1],
    STUB_HELPER_EXIT: '0',
    STUB_CONFIG_FILES: '/app/docker-compose.app.yml',
    STUB_WORKING_DIR: '/app',
    STUB_COMPOSE_CONFIG: CLEAN_COMPOSE,
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
  assert.ok(
    log.includes('exec metasheet-backend env'),
    'Leg 1 (running env) must run',
  )
  assert.match(
    log,
    /compose -f \/app\/docker-compose\.app\.yml --project-directory \/app config/,
    'Leg 3 (next-restart compose config) must run',
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
      STUB_ENV: `${CLEAN_ENV}\nMULTITABLE_ENABLE_PIT_RESET=true`,
    },
  })
  assert.equal(status, 1)
  // Pin the RUNNING leg specifically (not just any breach).
  assert.match(stdout, /\[running\] MULTITABLE_ENABLE_PIT_RESET=true/)
  assert.match(stdout, /CONTAINMENT BREACH/)
  assert.match(stdout, /VERDICT: FAIL/)
  assert.doesNotMatch(stdout, NO_CONTAINMENT_PASS)
})

test('containment behavior 4: predeploy-flags catches a next-restart compose flag=true → FAIL (exit 1)', () => {
  const { status, stdout } = runRemote({
    target: 'production',
    mode: 'predeploy-flags',
    stub: {
      STUB_COMPOSE_CONFIG: `${CLEAN_COMPOSE}\n      MULTITABLE_ENABLE_WRITER_FENCE: "true"`,
    },
  })
  assert.equal(status, 1)
  // Pin the NEXT-RESTART (compose) leg specifically.
  assert.match(stdout, /\[next-restart\] MULTITABLE_ENABLE_WRITER_FENCE=true/)
  assert.match(stdout, /CONTAINMENT BREACH \(next restart/)
  assert.match(stdout, /VERDICT: FAIL/)
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

test('containment behavior 7: postdeploy-full still fails on a running-env flag=true (Leg 1 load-bearing in full, exit 1)', () => {
  const { status, stdout, log } = runRemote({
    target: 'production',
    mode: 'postdeploy-full',
    stub: {
      STUB_ENV: `${CLEAN_ENV}\nMULTITABLE_ENABLE_WRITER_FENCE=1`,
    },
  })
  assert.equal(status, 1)
  assert.match(stdout, /\[running\] MULTITABLE_ENABLE_WRITER_FENCE=1/)
  assert.match(stdout, /CONTAINMENT BREACH/)
  assert.match(stdout, /VERDICT: FAIL/)
  assert.doesNotMatch(stdout, NO_CONTAINMENT_PASS)
  // The helper still ran (full mode) — proving the FAIL is Leg 1, not a skip.
  assert.ok(
    log.includes(HELPER_CALL),
    'full mode runs the helper; the FAIL here originates in Leg 1, not a helper skip',
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
