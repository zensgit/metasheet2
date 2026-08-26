import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// W0 L6-b CI two-point wiring contract. The exact-anchor authority suite is DATABASE_URL-gated and
// must have BOTH (1) a vitest.config.ts exclusion so the no-DB lane cannot skip-green it and (2) a
// whole-file entry in plugin-tests.yml's multitable real-DB step. Removing either point must fail CI.
const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(__dirname, '..', '..')
const FILES = [
  // Target-generation/floor comparator: DB-gated and required as one whole-file invocation too.
  'tests/integration/multitable-history-contiguity-strict-seq-realdb.test.ts',
  'tests/integration/multitable-exact-anchor-recovery-realdb.test.ts',
  'tests/integration/multitable-exact-anchor-recovery-plan-realdb.test.ts',
  // W0 L8 destructive-apply suite joins the same two-point contract: removing/relocating either its
  // vitest.config.ts exclusion or its whole-file plugin-tests.yml invocation must red this guard.
  'tests/integration/multitable-exact-anchor-apply-realdb.test.ts',
  // W2 route wiring is DB-gated too; keep its Express/auth/side-effect goldens impossible to skip-green.
  'tests/integration/multitable-exact-anchor-route-wiring-realdb.test.ts',
  // T8-1 route behavior, including Revert-vs-retention no-oracle ordering, is real-DB-only.
  'tests/integration/multitable-revert-pit-realdb.test.ts',
  // Closeout database guard: authority reader/writer leases.
  'tests/integration/multitable-recovery-authority-stability-realdb.test.ts',
  'tests/integration/multitable-recovery-lease-backoff-realdb.test.ts',
  'tests/integration/recovery-conflict-classifier-realdb.test.ts',
  // Closeout goldens added by the TM-closeout slices — must stay two-point wired (no manual-only goldens).
  'tests/integration/multitable-recovery-authority-unavailable-failclosed-realdb.test.ts',
  'tests/integration/multitable-recovery-foreign-fence-availability-realdb.test.ts',
  'tests/integration/multitable-automation-marker-anchor-realdb.test.ts',
]
const REAL_DB_STEP = 'Run multitable real-DB integration'

function maskCommentsAndStrings(src) {
  let out = ''
  let i = 0
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '/') {
      out += '  '
      i += 2
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      out += '  '
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < src.length) {
        out += '  '
        i += 2
      }
      continue
    }
    if (src[i] === "'" || src[i] === '"') {
      const quote = src[i]
      out += ' '
      i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          out += '  '
          i += 2
          continue
        }
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < src.length) {
        out += ' '
        i++
      }
      continue
    }
    out += src[i]
    i++
  }
  return out
}

function testExcludeEntries(src) {
  const masked = maskCommentsAndStrings(src)
  const testKey = /\btest\s*:\s*\{/.exec(masked)
  assert.ok(testKey, 'vitest config must contain a test object')
  const openBrace = masked.indexOf('{', testKey.index + testKey[0].length - 1)
  let depth = 1
  for (let i = openBrace + 1; i < masked.length && depth > 0; i++) {
    if (masked[i] === '{') depth++
    else if (masked[i] === '}') depth--
    else if (depth === 1) {
      const match = /^(exclude\s*:\s*\[)/.exec(masked.slice(i))
      if (!match) continue
      const arrayStart = i + match[1].length - 1
      let arrayDepth = 0
      for (let j = arrayStart; j < masked.length; j++) {
        if (masked[j] === '[') arrayDepth++
        else if (masked[j] === ']' && --arrayDepth === 0) {
          const body = src
            .slice(arrayStart + 1, j)
            .split('\n')
            .map((line) => line.replace(/\/\/.*$/, ''))
            .join('\n')
          return [...body.matchAll(/'([^']+)'|"([^"]+)"/g)].map(
            (entry) => entry[1] ?? entry[2],
          )
        }
      }
    }
  }
  return []
}

function namedStepBody(workflow, nameNeedle) {
  const lines = workflow.split('\n')
  let start = -1
  let indent = ''
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)- name:\s*(.*)$/)
    if (match && match[2].includes(nameNeedle)) {
      start = i
      indent = match[1]
      break
    }
  }
  assert.ok(
    start >= 0,
    `workflow step containing ${JSON.stringify(nameNeedle)} not found`,
  )
  const body = []
  for (let i = start + 1; i < lines.length; i++) {
    const match = lines[i].match(/^(\s*)- name:\s*/)
    if (match && match[1] === indent) break
    body.push(lines[i])
  }
  return body.join('\n')
}

function stepHasEnvKey(stepBody, key) {
  const lines = stepBody.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const env = /^(\s*)env:\s*$/.exec(lines[i])
    if (!env) continue
    const envIndent = env[1].length
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*(?:#.*)?$/.test(lines[j])) continue
      const indent = lines[j].match(/^(\s*)/)[1].length
      if (indent <= envIndent) break
      if (new RegExp(`^\\s*${key}:\\s*\\S`).test(lines[j])) return true
    }
  }
  return false
}

function wholeFileVitestArgs(stepBody) {
  return stepBody.split('\n').flatMap((line) => {
    if (/^\s*#/.test(line)) return []
    const match = line.match(
      /^\s+(tests\/integration\/\S+\.(?:test|spec)\.[tj]sx?)\s*(?:\\)?\s*$/,
    )
    return match ? [match[1]] : []
  })
}

for (const file of FILES) {
  test(`vitest.config.ts excludes ${file} from the no-DB job`, () => {
    const config = readFileSync(
      join(repoRoot, 'packages/core-backend/vitest.config.ts'),
      'utf8',
    )
    assert.ok(
      testExcludeEntries(config).includes(file),
      `test.exclude must contain the exact entry ${file}`,
    )
  })

  test(`plugin-tests.yml runs ${file} as a whole file with real Postgres`, () => {
    const workflow = readFileSync(
      join(repoRoot, '.github/workflows/plugin-tests.yml'),
      'utf8',
    )
    const step = namedStepBody(workflow, REAL_DB_STEP)
    assert.ok(
      stepHasEnvKey(step, 'DATABASE_URL'),
      `${REAL_DB_STEP} must define DATABASE_URL`,
    )
    assert.ok(
      stepHasEnvKey(step, 'METASHEET_REAL_DB_TEST_STEP'),
      `${REAL_DB_STEP} must set the fail-not-skip marker`,
    )
    assert.match(
      step,
      /\bvitest\b[^\n]*--config\s+vitest\.integration\.config\.ts\b/,
    )
    assert.ok(
      wholeFileVitestArgs(step).includes(file),
      `${REAL_DB_STEP} must run ${file} as a whole-file argument`,
    )
  })
}

test('placement parsers reject comment-only and wrong-step decoys', () => {
  const file = FILES[1]
  const configDecoy = `export default defineConfig({ test: { // '${file}'\nexclude: ['other.test.ts'] } })`
  assert.equal(testExcludeEntries(configDecoy).includes(file), false)

  const workflowDecoy = [
    'steps:',
    `  # ${file}`,
    '  - name: Run some other integration',
    '    env:',
    '      DATABASE_URL: postgresql://example',
    '      METASHEET_REAL_DB_TEST_STEP: 1',
    '    run: |',
    '      pnpm exec vitest --config vitest.integration.config.ts run \\',
    `        ${file} \\`,
    `  - name: ${REAL_DB_STEP}`,
    '    run: echo no-db',
  ].join('\n')
  const realStep = namedStepBody(workflowDecoy, REAL_DB_STEP)
  assert.equal(stepHasEnvKey(realStep, 'DATABASE_URL'), false)
  assert.equal(wholeFileVitestArgs(realStep).includes(file), false)
})

function assertAuthorityWriterWaiterContract(source) {
  const start = source.indexOf('// Both production writers must be blocked')
  const end = source.indexOf('// Membership writers have no sheet-row prerequisite', start)
  assert.ok(start >= 0 && end > start, 'authority-writer waiter contract block must exist')
  const block = source.slice(start, end)

  assert.match(
    block,
    /query LIKE 'SELECT 1 FROM meta_sheets WHERE id = \$1 FOR UPDATE%'/,
    'waiter probe must recognize the exact-anchor branch FOR UPDATE writer',
  )
  assert.match(
    block,
    /query LIKE 'SELECT id FROM meta_sheets WHERE id = \$1 FOR SHARE%'/,
    'waiter probe must recognize the main authority helper FOR SHARE writer',
  )
  assert.match(
    block,
    /expect\(authorityWaiters\)\.toBeGreaterThanOrEqual\(2\)/,
    'the golden must still require both independent authority writers to park',
  )
  assert.doesNotMatch(
    block,
    /expect\(authorityWaiters\)\.toBeGreaterThanOrEqual\(1\)/,
    'weakening the dual-writer guarantee to one waiter is forbidden',
  )
}

test('authority waiter matcher covers FOR UPDATE and FOR SHARE while preserving the >=2 guarantee', () => {
  const routeTest = readFileSync(
    join(
      repoRoot,
      'packages/core-backend/tests/integration/multitable-exact-anchor-route-wiring-realdb.test.ts',
    ),
    'utf8',
  )
  assertAuthorityWriterWaiterContract(routeTest)
})

test('authority waiter contract rejects the tempting >=1 weakening', () => {
  const routeTest = readFileSync(
    join(
      repoRoot,
      'packages/core-backend/tests/integration/multitable-exact-anchor-route-wiring-realdb.test.ts',
    ),
    'utf8',
  )
  const weakened = routeTest.replace(
    'expect(authorityWaiters).toBeGreaterThanOrEqual(2)',
    'expect(authorityWaiters).toBeGreaterThanOrEqual(1)',
  )
  assert.throws(
    () => assertAuthorityWriterWaiterContract(weakened),
    /both independent authority writers|weakening the dual-writer guarantee/,
  )
})

const TIME_MACHINE_REPLAY_MIGRATIONS = [
  'zzzz20260708090000_create_meta_tombstone_tables',
  'zzzz20260709100000_add_delete_revision_id_to_meta_records_trash',
  'zzzz20260711000000_add_meta_record_revisions_restored_from_version',
  'zzzz20260713150000_create_meta_record_version_markers',
  'zzzz20260715160000_add_meta_record_chain_seq',
  'zzzz20260715170000_add_meta_sheet_recovery_writer_state',
  'zzzz20260715180000_create_meta_history_trust_checkpoints',
  'zzzz20260715210000_create_meta_record_history_operations',
  'zzzz20260719120000_create_meta_recovery_token_burns',
  'zzzz20260721121000_add_recovery_authority_locks',
  'zzzz20260728120000_correct_recovery_authority_locks',
  'zzzz20260821120000_recovery_authority_functions_fix_search_path',
  'zzzz20260826120000_create_meta_recovery_archive_catalog',
]
const TIME_MACHINE_REPLAY_VERIFIER =
  'tests/integration/multitable-timemachine-migration-replay-realdb.verify.ts'
const TIME_MACHINE_REPLAY_FAILURE_ENV = 'TIME_MACHINE_REPLAY_INJECT_DOWN_FAILURE_AFTER'
const TIME_MACHINE_REPLAY_FAILURE_MIGRATION =
  'zzzz20260715170000_add_meta_sheet_recovery_writer_state'
const MIGRATION_REPLAY_EXCLUDE =
  '008_plugin_infrastructure.sql,048_create_event_bus_tables.sql,049_create_bpmn_workflow_tables.sql,042a_core_model_views.sql,20250924140000_create_gantt_tables.ts,zzzz20260114110000_create_user_orgs_table.ts'

function migrationReplayContract(workflow, verifier) {
  const step = namedStepBody(workflow, 'prove Time Machine down/up replay')
  assert.ok(stepHasEnvKey(step, 'DATABASE_URL'), 'migration replay step must define DATABASE_URL')

  const stepLines = step.split('\n')
  const runLine = stepLines.findIndex((line) => /^\s*run:\s*\|\s*$/.test(line))
  assert.ok(runLine >= 0, 'migration replay step must have a block run command')
  const commands = stepLines
    .slice(runLine + 1)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  assert.deepEqual(
    commands,
    [
      'pnpm -F @metasheet/core-backend db:migrate',
      'pnpm -F @metasheet/core-backend db:migrate',
      `pnpm -F @metasheet/core-backend exec tsx ${TIME_MACHINE_REPLAY_VERIFIER}`,
      'pnpm -F @metasheet/core-backend db:migrate',
    ],
    'workflow must run normal migrate twice, the direct down/up verifier, then a ledger no-op pass',
  )

  const failureStep = namedStepBody(workflow, 'Prove injected Time Machine down failure cleanup')
  assert.ok(stepHasEnvKey(failureStep, 'DATABASE_URL'), 'failure cleanup step must define DATABASE_URL')
  assert.ok(
    stepHasEnvKey(failureStep, TIME_MACHINE_REPLAY_FAILURE_ENV),
    'failure cleanup step must arm the deterministic down failure',
  )
  assert.match(
    failureStep,
    new RegExp(`${TIME_MACHINE_REPLAY_FAILURE_ENV}:\\s*${TIME_MACHINE_REPLAY_FAILURE_MIGRATION}`),
    'required CI must inject after the pinned middle migration',
  )
  const verifierCommand = `pnpm -F @metasheet/core-backend exec tsx ${TIME_MACHINE_REPLAY_VERIFIER}`
  const recoveryCommand = `env -u ${TIME_MACHINE_REPLAY_FAILURE_ENV} ${verifierCommand}`
  assert.ok(
    failureStep.includes(`if ${verifierCommand}; then`),
    'required CI must require the armed verifier to fail',
  )
  assert.ok(
    failureStep.includes(recoveryCommand),
    'required CI must explicitly unarm the failure injection before proving recovery',
  )
  assert.equal(
    failureStep.split(verifierCommand).length - 1,
    2,
    'failure cleanup step must run exactly one injected verifier and one unarmed recovery verifier',
  )
  assert.ok(
    failureStep.indexOf(`if ${verifierCommand}; then`) < failureStep.indexOf(recoveryCommand),
    'required CI must run the injected verifier before the unarmed recovery verifier',
  )

  const excludeValues = [...workflow.matchAll(/^\s*MIGRATION_EXCLUDE:\s*(\S+)\s*$/gm)].map(
    (match) => match[1],
  )
  assert.deepEqual(
    excludeValues,
    [MIGRATION_REPLAY_EXCLUDE, MIGRATION_REPLAY_EXCLUDE],
    'migration replay and db:list must use the same exact exclusion set',
  )

  const migrationBlock = verifier.match(
    /const MIGRATIONS: NamedMigration\[\] = \[([\s\S]*?)^\]/m,
  )?.[1]
  assert.ok(migrationBlock, 'verifier must declare the explicit migration sequence')
  const names = [...migrationBlock.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual(
    names,
    TIME_MACHINE_REPLAY_MIGRATIONS,
    'verifier must exercise the exact 13 Time Machine migrations in causal order',
  )
  assert.match(verifier, /for \(const migration of \[\.\.\.MIGRATIONS\]\.reverse\(\)\)/)
  assert.match(verifier, /for \(const migration of MIGRATIONS\)/)
  assert.match(verifier, /database_url_required/)
  assert.match(verifier, /await assertOwnedSurfaceAbsent\(db\)/)
  assert.match(verifier, /changedKeys\.length === 0/)
  assert.match(
    verifier,
    /downed\.add\(migration\.name\)\s+await migration\.module\.down\(db\)/,
    'verifier must mark the current migration for recovery before down() can partially fail',
  )
  assert.match(
    verifier,
    /TIME_MACHINE_REPLAY_INJECT_DOWN_FAILURE_AFTER[\s\S]*injected_down_failure/,
    'verifier must retain a deterministic verifier-only down failure injection',
  )
  assert.match(verifier, /sequence_row\.seqcache::text/, 'sequence fingerprint must include cache_size')
  assert.doesNotMatch(verifier, /\b(last_value|is_called)\b/, 'runtime sequence state must stay excluded')
  assert.doesNotMatch(verifier, /error\.message/, 'failure output must not expose database error messages')
  for (const index of [
    'uq_meta_records_trash_delete_revision',
    'idx_meta_record_version_markers_sheet_record',
    'idx_meta_record_revisions_sheet_record_seq',
    'idx_meta_record_version_markers_sheet_record_seq',
    'idx_meta_record_revisions_operation',
    'idx_meta_record_version_markers_operation',
  ]) {
    assert.match(verifier, new RegExp(`'${index}'`), `verifier must check owned index ${index}`)
  }
  for (const constraint of [
    'chk_meta_sheets_recovery_writer_state',
    'uq_meta_record_version_markers_sheet_record_version',
    'fk_mrr_operation',
    'fk_mrvm_operation',
  ]) {
    assert.match(verifier, new RegExp(`'${constraint}'`), `verifier must check owned constraint ${constraint}`)
  }
}

test('required CI pins the Time Machine migration down/up replay contract', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/migration-replay.yml'), 'utf8')
  const verifier = readFileSync(
    join(repoRoot, 'packages/core-backend', TIME_MACHINE_REPLAY_VERIFIER),
    'utf8',
  )
  migrationReplayContract(workflow, verifier)
})

test('migration replay contract rejects removal of the direct verifier', () => {
  const workflow = readFileSync(
    join(repoRoot, '.github/workflows/migration-replay.yml'),
    'utf8',
  ).replace(`pnpm -F @metasheet/core-backend exec tsx ${TIME_MACHINE_REPLAY_VERIFIER}`, 'true')
  const verifier = readFileSync(
    join(repoRoot, 'packages/core-backend', TIME_MACHINE_REPLAY_VERIFIER),
    'utf8',
  )
  assert.throws(() => migrationReplayContract(workflow, verifier), /direct down\/up verifier/)
})

test('migration replay contract rejects migration-set or exclusion drift', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/migration-replay.yml'), 'utf8')
  const verifier = readFileSync(
    join(repoRoot, 'packages/core-backend', TIME_MACHINE_REPLAY_VERIFIER),
    'utf8',
  )
  const driftedMigration = verifier.replace(
    "name: 'zzzz20260715180000_create_meta_history_trust_checkpoints'",
    "name: 'zzzz20260715180000_omitted_trust_checkpoint'",
  )
  assert.throws(
    () => migrationReplayContract(workflow, driftedMigration),
    /exact 13 Time Machine migrations/,
  )

  const missingArchiveCatalog = verifier.replace(
    "  {\n    name: 'zzzz20260826120000_create_meta_recovery_archive_catalog',\n    module: recoveryArchiveCatalog,\n  },\n",
    '',
  )
  assert.notEqual(missingArchiveCatalog, verifier, 'archive-catalog removal mutation must apply')
  assert.throws(
    () => migrationReplayContract(workflow, missingArchiveCatalog),
    /exact 13 Time Machine migrations/,
  )

  const driftedExclude = workflow.replace(
    `MIGRATION_EXCLUDE: ${MIGRATION_REPLAY_EXCLUDE}`,
    `MIGRATION_EXCLUDE: ${MIGRATION_REPLAY_EXCLUDE},unexpected.ts`,
  )
  assert.throws(() => migrationReplayContract(driftedExclude, verifier), /same exact exclusion set/)
})

test('migration replay contract rejects recovery, fingerprint, and values-free output drift', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/migration-replay.yml'), 'utf8')
  const verifier = readFileSync(
    join(repoRoot, 'packages/core-backend', TIME_MACHINE_REPLAY_VERIFIER),
    'utf8',
  )

  const unmarkedCurrentMigration = verifier.replace(
    '      downed.add(migration.name)\n      await migration.module.down(db)',
    '      await migration.module.down(db)\n      downed.add(migration.name)',
  )
  assert.throws(() => migrationReplayContract(workflow, unmarkedCurrentMigration), /mark the current migration/)

  const missingCacheSize = verifier.replace('sequence_row.seqcache::text', 'sequence_row.seqcycle::text')
  assert.throws(() => migrationReplayContract(workflow, missingCacheSize), /include cache_size/)

  const leakedDatabaseMessage = verifier.replace(
    "return `Time Machine migration replay FAIL phase=${phase} code=unexpected_database_error category=database count=0`",
    'return error.message',
  )
  assert.throws(() => migrationReplayContract(workflow, leakedDatabaseMessage), /must not expose database error messages/)
})

test('migration replay contract rejects an unarmed or skip-green failure-cleanup proof', () => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/migration-replay.yml'), 'utf8')
  const verifier = readFileSync(
    join(repoRoot, 'packages/core-backend', TIME_MACHINE_REPLAY_VERIFIER),
    'utf8',
  )
  const verifierCommand = `pnpm -F @metasheet/core-backend exec tsx ${TIME_MACHINE_REPLAY_VERIFIER}`
  const recoveryCommand = `env -u ${TIME_MACHINE_REPLAY_FAILURE_ENV} ${verifierCommand}`

  const unarmed = workflow.replace(
    `${TIME_MACHINE_REPLAY_FAILURE_ENV}: ${TIME_MACHINE_REPLAY_FAILURE_MIGRATION}`,
    `${TIME_MACHINE_REPLAY_FAILURE_ENV}_REMOVED: ${TIME_MACHINE_REPLAY_FAILURE_MIGRATION}`,
  )
  assert.throws(() => migrationReplayContract(unarmed, verifier), /arm the deterministic down failure/)

  const skipGreen = workflow.replace(`if pnpm -F @metasheet/core-backend exec tsx ${TIME_MACHINE_REPLAY_VERIFIER}; then`, 'true')
  assert.throws(() => migrationReplayContract(skipGreen, verifier), /require the armed verifier to fail/)

  const noRecovery = workflow.replace(
    `          env -u ${TIME_MACHINE_REPLAY_FAILURE_ENV} pnpm -F @metasheet/core-backend exec tsx ${TIME_MACHINE_REPLAY_VERIFIER}\n\n      - name: List migrations`,
    '      - name: List migrations',
  )
  assert.throws(() => migrationReplayContract(noRecovery, verifier), /explicitly unarm the failure injection/)

  const stillArmedRecovery = workflow.replace(
    `env -u ${TIME_MACHINE_REPLAY_FAILURE_ENV} pnpm`,
    'pnpm',
  )
  assert.throws(
    () => migrationReplayContract(stillArmedRecovery, verifier),
    /explicitly unarm the failure injection/,
  )

  const reversedOrder = workflow
    .replace(`          if ${verifierCommand}; then`, '          __INJECTED_VERIFIER__')
    .replace(`          ${recoveryCommand}`, `          if ${verifierCommand}; then`)
    .replace('          __INJECTED_VERIFIER__', `          ${recoveryCommand}`)
  assert.throws(
    () => migrationReplayContract(reversedOrder, verifier),
    /run the injected verifier before the unarmed recovery verifier/,
  )
})
