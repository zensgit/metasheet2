/** Test-only real-process local recovery startup acceptance. */
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createConnection, createServer as createNetServer } from 'node:net'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hash } from 'bcryptjs'
import { Pool } from 'pg'

import type { RecoveryArchiveApplicationDatabaseRuntime } from '../src/multitable/recovery-archive-application'
import type {
  RecoveryArchiveRestoreJobQuery,
  RecoveryArchiveRestoreJobTransaction,
} from '../src/multitable/recovery-archive-restore-jobs'
import type { RecoveryArchiveDurableFixture } from '../tests/utils/recovery-archive-durable-fixture'
const require = createRequire(import.meta.url)
const {
  assertDistinctDirectoryIdentities,
  assertOwnedPrivateDirectory,
} = require('../tests/utils/recovery-local-backup-driver-safety.ts') as typeof import('../tests/utils/recovery-local-backup-driver-safety')

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const backend = resolve(repo, 'packages/core-backend')
const output = resolve(repo, 'artifacts/recovery-local-startup')
const evidencePath = resolve(output, 'evidence.json')
const runToken = randomUUID().replaceAll('-', '').slice(0, 16)
const databaseName = `tm_recovery_startup_${runToken}`
const workRoot = `/private/tmp/tm-recovery-local-startup-run-${runToken}`
const recoverySecret = randomBytes(32)
const jwtSecret = randomBytes(48).toString('hex')
const password = randomBytes(24).toString('hex')
const children = new Set<ChildProcess>()
const cases: string[] = []
const cleanupErrors: string[] = []
const sourcePaths = [
  'packages/core-backend/scripts/verify-recovery-local-startup.mts',
  'packages/core-backend/scripts/start-recovery-local.mts',
  'packages/core-backend/scripts/tsconfig.recovery-archive-acceptance.json',
  'packages/core-backend/src/index.ts',
  'packages/core-backend/src/multitable/recovery-archive-application.ts',
  'packages/core-backend/src/routes/univer-meta.ts',
  'packages/core-backend/src/multitable/recovery-local-startup.ts',
  'packages/core-backend/src/multitable/recovery-local-operator-input.ts',
  'packages/core-backend/src/multitable/recovery-local-custody.ts',
  'packages/core-backend/src/multitable/recovery-local-custody-store.ts',
  'packages/core-backend/scripts/verify-recovery-archive-server.mts',
  'packages/core-backend/tests/utils/recovery-archive-verified-fixture.ts',
  'packages/core-backend/tests/utils/recovery-archive-durable-fixture.ts',
  'packages/core-backend/tests/utils/recovery-local-backup-driver-safety.ts',
] as const

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [
  path,
  createHash('sha256').update(await readFile(resolve(repo, path))).digest('hex'),
])))
const dirtyDiffHash = () => createHash('sha256')
  .update(execFileSync('git', ['diff', '--binary', 'HEAD'], { cwd: repo }))
  .digest('hex')

await mkdir(output, { recursive: true })
const initialSourceHashes = await sourceHashes()
const initialDiffHash = dirtyDiffHash()
const evidence: Record<string, unknown> = {
  schemaVersion: 1,
  result: 'RUNNING',
  sourceHead: git('rev-parse', 'HEAD'),
  sourceTree: git('rev-parse', 'HEAD^{tree}'),
  sourceHashes: initialSourceHashes,
  dirtyDiffSha256: initialDiffHash,
  launcher: 'node --import tsx scripts/start-recovery-local.mts',
  fixture: 'synthetic local custody and encrypted archive',
  cases,
}
await writeEvidence()

const rawAdminUrl = process.env.TM_ARCHIVE_TEST_ADMIN_URL ?? ''
const rawPgdata = process.env.TM_ARCHIVE_TEST_PGDATA ?? ''
const testMode = process.env.NODE_ENV === 'test'
const inheritedEnvironment = process.env
const safeEnvironment: NodeJS.ProcessEnv = {}
for (const key of ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT']) {
  if (inheritedEnvironment[key]) safeEnvironment[key] = inheritedEnvironment[key]
}
for (const key of Object.keys(process.env)) delete process.env[key]

let admin: Pool | undefined
let databasePool: Pool | undefined
let databaseCreated = false
let ownedDatabase: { oid: string; owner: string } | undefined
let workRootCreated = false
let port = 0
let failureStage = 'ADMISSION'

try {
  assert.equal(testMode, true, 'RECOVERY_LOCAL_STARTUP_TEST_MODE_REQUIRED')
  const adminUrl = admitAdminUrl(rawAdminUrl)
  const admittedPgdata = await admitPgdata(rawPgdata)
  const databaseUrl = new URL(adminUrl.href)
  databaseUrl.pathname = `/${databaseName}`
  const applicationConfigPath = join(workRoot, 'application-config.json')
  const recoveryConfigPath = join(workRoot, 'recovery-config.json')
  const archivePath = join(workRoot, 'archive')
  const custodyPath = join(workRoot, 'custody')

  await assertMissing(workRoot)
  await mkdir(workRoot, { mode: 0o700 })
  workRootCreated = true
  await mkdir(archivePath, { mode: 0o700 })
  await mkdir(custodyPath, { mode: 0o700 })
  const workIdentity = await assertOwnedPrivateDirectory(workRoot)
  const archiveIdentity = await assertOwnedPrivateDirectory(archivePath)
  const custodyIdentity = await assertOwnedPrivateDirectory(custodyPath)
  assertDistinctDirectoryIdentities(workIdentity, archiveIdentity)
  assertDistinctDirectoryIdentities(workIdentity, custodyIdentity)
  assertDistinctDirectoryIdentities(archiveIdentity, custodyIdentity)
  await writeFile(applicationConfigPath, '{}\n', { flag: 'wx', mode: 0o600 })
  assert.equal((await stat(applicationConfigPath)).mode & 0o077, 0)

  failureStage = 'ADMIN_AUTHORITY'
  admin = new Pool({
    connectionString: adminUrl.href,
    max: 1,
    application_name: 'tm_recovery_startup_admin',
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  })
  const server = await admin.query(
    'SELECT current_database() AS database_name, current_user AS owner',
  )
  assert.deepEqual(server.rows, [{
    database_name: 'postgres',
    owner: 'tm_actor_owner',
  }])
  const shownDataDirectory = await admin.query('SHOW data_directory')
  assert.deepEqual(shownDataDirectory.rows, [{ data_directory: admittedPgdata }])
  assert.equal(await realpath(String(shownDataDirectory.rows[0].data_directory)), admittedPgdata)
  assert.equal(await databaseCount(admin, databaseName), 0)

  await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} OWNER ${quoteIdentifier('tm_actor_owner')}`)
  databaseCreated = true
  await admin.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(databaseName)} FROM PUBLIC`)
  const identity = await admin.query(
    `SELECT oid::text, pg_catalog.pg_get_userbyid(datdba) AS owner
       FROM pg_catalog.pg_database WHERE datname=$1`,
    [databaseName],
  )
  assert.deepEqual(identity.rows.length, 1)
  ownedDatabase = identity.rows[0] as { oid: string; owner: string }
  assert.match(ownedDatabase.oid, /^[1-9][0-9]*$/)
  assert.equal(ownedDatabase.owner, 'tm_actor_owner')

  const runtimeEnvironment: NodeJS.ProcessEnv = {
    ...safeEnvironment,
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl.href,
    JWT_SECRET: jwtSecret,
    CONFIG_FILE: applicationConfigPath,
    SECRET_PROVIDER: 'env',
    CACHE_TYPE: 'memory',
    SKIP_PLUGINS: 'true',
    DISABLE_WORKFLOW: 'true',
    DISABLE_EVENT_BUS: 'true',
    APPROVAL_PROJECTION_SWEEP_DISABLED: '1',
    APPROVAL_SLA_SCHEDULER_DISABLED: '1',
    WEBHOOK_RETRY_SCHEDULER_DISABLED: '1',
    MULTITABLE_AI_LEDGER_RETENTION_DISABLED: '1',
    DINGTALK_GROUP_DELIVERY_RETENTION_DISABLED: '1',
    DINGTALK_DELIVERY_RETENTION_DISABLED: '1',
    MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true',
    MULTITABLE_ENABLE_WRITER_FENCE: 'true',
    MULTITABLE_HISTORY_CONTIGUITY_STRICT: 'true',
    METASHEET_ENV_DIR: workRoot,
  }
  Object.assign(process.env, runtimeEnvironment)

  failureStage = 'MIGRATIONS'
  for (const phase of ['fresh', 'replay']) {
    const migrated = spawnSync('pnpm', ['--filter', '@metasheet/core-backend', 'migrate'], {
      cwd: repo,
      env: runtimeEnvironment,
      stdio: 'ignore',
      timeout: 240_000,
    })
    assert.equal(migrated.status, 0, `MIGRATION_${phase.toUpperCase()}_FAILED`)
  }
  evidence.migrationPasses = 2

  failureStage = 'FIXTURE'
  databasePool = new Pool({
    connectionString: databaseUrl.href,
    max: 4,
    application_name: 'tm_recovery_startup_fixture',
    connectionTimeoutMillis: 10_000,
    query_timeout: 120_000,
  })
  let transactionDepth = 0
  const query: RecoveryArchiveRestoreJobQuery = async (text, values) => databasePool!.query(text, values)
  const transaction: RecoveryArchiveRestoreJobTransaction = async (work) => {
    const client = await databasePool!.connect()
    try {
      await client.query('BEGIN')
      transactionDepth += 1
      const result = await work(async (text, values) => client.query(text, values))
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      transactionDepth -= 1
      client.release()
    }
  }
  const transactionDepthProbe = { currentTransactionDepth: () => transactionDepth }
  const runtime: RecoveryArchiveApplicationDatabaseRuntime = { query, transaction, transactionDepthProbe }
  const {
    createRecoveryArchiveFileStoreProvider,
    provisionRecoveryArchiveFileRoot,
  } = require('../src/multitable/recovery-archive-file-store.ts') as typeof import('../src/multitable/recovery-archive-file-store')
  const {
    createLocalCustodyBackup,
    createLocalCustodySession,
  } = require('../src/multitable/recovery-local-custody.ts') as typeof import('../src/multitable/recovery-local-custody')
  const { createLocalCustodyStore } = require('../src/multitable/recovery-local-custody-store.ts') as typeof import('../src/multitable/recovery-local-custody-store')
  const { createRecoveryArchiveDurableFixture } = require('../tests/utils/recovery-archive-durable-fixture.ts') as typeof import('../tests/utils/recovery-archive-durable-fixture')
  const { seedVerifiedArchive } = require('../tests/utils/recovery-archive-verified-fixture.ts') as typeof import('../tests/utils/recovery-archive-verified-fixture')
  const { RECOVERY_ARCHIVE_V1_SECTION_NAMES } = require('../src/multitable/recovery-archive-contract.ts') as typeof import('../src/multitable/recovery-archive-contract')
  const { RECOVERY_AUTHORITY_TRIGGERS } = require('../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks.ts') as typeof import('../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks')

  for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
    await query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
  }
  const custodyId = randomUUID()
  const storeId = randomUUID()
  await provisionRecoveryArchiveFileRoot({ basePath: archivePath, storeId, transactionDepth: transactionDepthProbe })
  const objectStore = await createRecoveryArchiveFileStoreProvider({
    basePath: archivePath,
    storeId,
    maxObjectBytes: 16 * 1024 * 1024,
    transactionDepth: transactionDepthProbe,
  })
  const custodyStore = await createLocalCustodyStore({
    archivePath,
    custodyPath,
    custodyId,
    transactionDepth: transactionDepthProbe,
  })
  const initialBackup = createLocalCustodyBackup({ custodyId, recoverySecret, transactionDepth: transactionDepthProbe })
  await custodyStore.putBackup(randomUUID(), initialBackup)
  const custodySession = createLocalCustodySession(transactionDepthProbe)
  custodySession.unlock({ custodyId, backup: initialBackup, recoverySecret })
  initialBackup.fill(0)
  const keyCustody = custodySession.admitForArchive(custodyId)
  let durable: RecoveryArchiveDurableFixture | undefined
  let fieldId = ''
  let recordIds: string[] = []
  const fixture = await seedVerifiedArchive({
    prefix: `tm_local_startup_${runToken}`,
    ...runtime,
    label: 'http_restore',
    keyId: keyCustody.keyId,
    materialize: async (candidate) => {
      fieldId = `fld_${candidate.sheetId}_value`
      recordIds = Array.from({ length: 5001 }, (_, index) =>
        `${candidate.sheetId}_record_${String(index).padStart(5, '0')}`,
      )
      const archive = await query(
        `SELECT created_at, expires_at FROM public.meta_recovery_archives
          WHERE generation_id=$1::uuid`,
        [candidate.generationId],
      )
      const archiveRow = archive.rows[0] as { created_at: Date | string; expires_at: Date | string }
      durable = await createRecoveryArchiveDurableFixture({
        binding: {
          archive_generation_id: candidate.generationId,
          workspace_id: candidate.workspaceId,
          base_id: candidate.baseId,
          sheet_id: candidate.sheetId,
          anchor_operation_id: candidate.anchorOperationId,
          anchor_seq: candidate.anchorSeq,
          checkpoint_id: candidate.checkpointId,
          created_at: new Date(archiveRow.created_at).toISOString(),
          expires_at: new Date(archiveRow.expires_at).toISOString(),
          source_vector_hash: candidate.sourceVectorHash,
        },
        keyId: candidate.keyId,
        keyCustody,
        objectStore,
        transactionDepth: transactionDepthProbe,
        objectExpiresAt: new Date(archiveRow.expires_at).toISOString(),
        reserveNonces: async (reservations) => transaction(async (transactionQuery) => {
          assert.deepEqual(
            reservations.map((reservation) => reservation.sectionName),
            [...RECOVERY_ARCHIVE_V1_SECTION_NAMES],
          )
          for (const reservation of reservations) {
            await transactionQuery(
              'SELECT meta_recovery_archive_reserve_nonce($1,$2,$3::uuid,$4,$5,$6::integer)',
              [
                reservation.dekFingerprint,
                reservation.nonceHex,
                reservation.generationId,
                reservation.sectionName,
                reservation.aeadAlgorithm,
                reservation.formatVersion,
              ],
            )
          }
        }),
        sectionRows: {
          schema: [{ field_id: fieldId, name: 'Synthetic value', type: 'string', property: {}, order: 1 }],
          records: recordIds.map((recordId, index) => ({
            record_id: recordId,
            exists: true,
            version: 1,
            data: { [fieldId]: `archived-${String(index).padStart(5, '0')}` },
          })),
          links: [],
          field_value_tombstones: [],
          link_tombstones: [],
          auto_number: [],
          attachments_index: [],
          permission_evidence: [],
          views_config: [],
        },
      })
      return durable
    },
  })
  assert.ok(durable)
  assert.equal(recordIds.length, 5001)
  const rotatedBackup = custodySession.exportRotatedBackup(recoverySecret)
  const receipt = await custodyStore.putBackup(randomUUID(), rotatedBackup)
  rotatedBackup.fill(0)
  custodySession.lock()
  assert.equal(custodySession.isUnlocked(), false)

  await query(
    `INSERT INTO users (
       id,email,name,password_hash,role,permissions,is_active,activation_status,
       local_password_set,must_change_password
     ) VALUES ($1,$2,'Local startup tester',$3,'admin',$4::jsonb,true,'activated',true,false)`,
    [
      fixture.actorId,
      `${fixture.actorId}@example.test`,
      await hash(password, 10),
      JSON.stringify(['multitable:read', 'multitable:write', 'multitable:share', 'multitable:manage-schema']),
    ],
  )
  await query('UPDATE meta_bases SET owner_id=$2 WHERE id=$1', [fixture.baseId, fixture.actorId])
  await query(
    `INSERT INTO meta_fields (id,sheet_id,name,type,property,"order")
     VALUES ($1,$2,'Synthetic value','string','{}',1)`,
    [fieldId, fixture.sheetId],
  )
  await query(
    `INSERT INTO meta_records (id,sheet_id,data,version,created_by,modified_by)
     SELECT $1::text || pg_catalog.lpad(candidate.index::text,5,'0'),
            $2,
            pg_catalog.jsonb_build_object($3::text,'live-' || pg_catalog.lpad(candidate.index::text,5,'0')),
            2,$4,$4
       FROM pg_catalog.generate_series(0,5000) AS candidate(index)`,
    [`${fixture.sheetId}_record_`, fixture.sheetId, fieldId, fixture.actorId],
  )
  await writeFile(recoveryConfigPath, `${JSON.stringify({
    archivePath,
    custodyPath,
    custodyId,
    storeId,
    maxObjectBytes: 16 * 1024 * 1024,
    receipt,
    auditedReplayHorizonMs: 60_000,
    asyncResumeHorizonMs: 600_000,
    workerIntervalMs: 10,
    leaseMs: 60_000,
    replayHorizonMs: 60_000,
    sweepLimit: 100,
    maxChunksPerRun: 20,
  })}\n`, { flag: 'wx', mode: 0o600 })
  assert.equal((await stat(recoveryConfigPath)).mode & 0o077, 0)
  port = await reserveLoopbackPort()
  const childEnvironment: NodeJS.ProcessEnv = {
    ...runtimeEnvironment,
    HOST: '127.0.0.1',
    PORT: String(port),
    NODE_OPTIONS: childSocketGuard(databaseUrl.port),
  }
  assert.deepEqual(
    Object.keys(childEnvironment).filter((key) => (
      key.includes('SECRET') && !['JWT_SECRET', 'SECRET_PROVIDER'].includes(key)
    )),
    [],
  )

  failureStage = 'WRONG_SECRET'
  const wrongSecretProcess = launch(recoveryConfigPath, childEnvironment)
  await wrongSecretProcess.locked
  await assertNoListener(port)
  const wrongSecret = randomBytes(32)
  try {
    await writePipeSecret(wrongSecretProcess.child, wrongSecret)
  } finally {
    wrongSecret.fill(0)
  }
  const refused = await waitForExit(wrongSecretProcess.child, 30_000)
  assert.equal(refused.code, 1)
  assert.equal(refused.signal, null)
  await assertNoListener(port)
  cases.push('wrong secret refused before listener')

  failureStage = 'HTTP_RESTORE'
  const restoreProcess = launch(recoveryConfigPath, childEnvironment)
  await restoreProcess.locked
  await assertNoListener(port)
  cases.push('pre-unlock process has no listener')
  await writePipeSecret(restoreProcess.child, recoverySecret)
  await waitForListener(port, 120_000)
  const origin = `http://127.0.0.1:${port}`
  const request = async (path: string, expected: number, token?: string, body?: unknown) => {
    const response = await fetch(`${origin}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(120_000),
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const json = await response.json()
    assert.equal(response.status, expected, `HTTP_STATUS_${expected}_REQUIRED`)
    assert.ok(json && typeof json === 'object' && !Array.isArray(json))
    return json as Record<string, unknown>
  }
  const data = (json: Record<string, unknown>) => {
    assert.ok(json.data && typeof json.data === 'object' && !Array.isArray(json.data))
    return json.data as Record<string, unknown>
  }
  const login = async () => {
    const loggedIn = data(await request('/auth/login', 200, undefined, {
      email: `${fixture.actorId}@example.test`,
      password,
    }))
    assert.equal(typeof loggedIn.token, 'string')
    return loggedIn.token as string
  }
  const token = await login()
  const archiveRoute = `/multitable/sheets/${fixture.sheetId}/recovery-archive`
  await request(`${archiveRoute}/catalog`, 401)
  const catalog = data(await request(`${archiveRoute}/catalog`, 200, token))
  assert.ok(Array.isArray(catalog.entries))
  assert.ok(catalog.entries.some((entry) => (
    entry && typeof entry === 'object' && (entry as Record<string, unknown>).generationId === fixture.generationId
  )))
  const preview = data(await request(`${archiveRoute}/preview`, 200, token, {
    generationId: fixture.generationId,
    mode: 'revert',
    scope: { kind: 'whole_sheet' },
  }))
  assert.equal(preview.executable, true)
  assert.equal(preview.executionKind, 'async')
  assert.equal(typeof preview.previewIdentity, 'string')
  const accepted = data(await request(`${archiveRoute}/jobs/accept`, 202, token, {
    previewIdentity: preview.previewIdentity,
  }))
  assert.equal(typeof accepted.jobId, 'string')
  let snapshot = accepted
  const completionDeadline = Date.now() + 300_000
  while (snapshot.state !== 'done' && Date.now() < completionDeadline) {
    assert.ok(['planned', 'applying'].includes(String(snapshot.state)))
    await delay(250)
    snapshot = data(await request(`${archiveRoute}/jobs/${accepted.jobId}`, 200, token))
  }
  assert.equal(snapshot.state, 'done')
  assert.equal(Number(snapshot.completedCount), 5001)
  const restored = await query(
    'SELECT id,data,version FROM public.meta_records WHERE sheet_id=$1 ORDER BY id',
    [fixture.sheetId],
  )
  assert.equal(restored.rows.length, 5001)
  for (let index = 0; index < recordIds.length; index += 1) {
    assert.deepEqual(restored.rows[index], {
      id: recordIds[index],
      data: { [fieldId]: `archived-${String(index).padStart(5, '0')}` },
      version: 3,
    })
  }
  cases.push('canonical authenticated HTTP restore completed all 5001 rows')
  const firstStop = await stopChild(restoreProcess.child, true)
  assert.equal(firstStop.code, 0)
  await assertNoListener(port)

  failureStage = 'RESTART_UNLOCK'
  const restartProcess = launch(recoveryConfigPath, childEnvironment)
  await restartProcess.locked
  await delay(250)
  await assertNoListener(port)
  cases.push('restart remains locked without a new FD3 delivery')
  await writePipeSecret(restartProcess.child, recoverySecret)
  await waitForListener(port, 120_000)
  const restartToken = await login()
  const restartedJob = data(await request(`${archiveRoute}/jobs/${accepted.jobId}`, 200, restartToken))
  assert.equal(restartedJob.state, 'done')
  assert.equal(Number(restartedJob.completedCount), 5001)
  const secondStop = await stopChild(restartProcess.child, true)
  assert.equal(secondStop.code, 0)
  await assertNoListener(port)
  cases.push('restart required a fresh FD3 pipe delivery and preserved terminal restore state')

  assert.equal(git('rev-parse', 'HEAD'), evidence.sourceHead)
  assert.deepEqual(await sourceHashes(), initialSourceHashes)
  assert.equal(dirtyDiffHash(), initialDiffHash)
  evidence.restoredCount = 5001
  evidence.result = 'PASS'
} catch {
  evidence.result = 'FAIL'
  evidence.failureStage = failureStage
}

for (const child of [...children]) {
  try {
    await stopChild(child, false)
  } catch {
    cleanupErrors.push('child')
  }
}
if (databasePool) {
  try {
    await bounded(databasePool.end(), 15_000, 'DATABASE_POOL_CLOSE_TIMEOUT')
  } catch {
    cleanupErrors.push('database_pool')
  }
  databasePool = undefined
}
if (admin && databaseCreated) {
  try {
    await dropOwnedDatabase(admin, databaseName, ownedDatabase)
    databaseCreated = false
  } catch {
    cleanupErrors.push('database_drop')
  }
}
if (workRootCreated) {
  try {
    await rm(workRoot, { recursive: true, force: true })
    workRootCreated = false
  } catch {
    cleanupErrors.push('work_root')
  }
}
let databaseResidue = Number(databaseCreated)
let backendResidue = Number(databaseCreated)
if (admin) {
  try {
    databaseResidue = await databaseCount(admin, databaseName)
    backendResidue = await backendCount(admin, databaseName)
  } catch {
    cleanupErrors.push('database_census')
  }
  try {
    await bounded(admin.end(), 15_000, 'ADMIN_POOL_CLOSE_TIMEOUT')
  } catch {
    cleanupErrors.push('admin_pool')
  }
}
const pathResidue = await pathCount(workRoot).catch(() => {
  cleanupErrors.push('path_census')
  return 1
})
const processResidue = [...children].filter((child) => child.exitCode === null && child.signalCode === null).length
recoverySecret.fill(0)
evidence.cleanup = {
  databaseResidue,
  backendResidue,
  pathResidue,
  processResidue,
  errors: cleanupErrors,
}
if (databaseResidue || backendResidue || pathResidue || processResidue || cleanupErrors.length) {
  evidence.result = 'FAIL'
}
await writeEvidence()
assert.equal(evidence.result, 'PASS', 'RECOVERY_LOCAL_STARTUP_ACCEPTANCE_FAILED')
console.log(`RECOVERY_LOCAL_STARTUP_PASS ${cases.length}`)

function admitAdminUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('RECOVERY_LOCAL_STARTUP_ADMIN_REFUSED')
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || url.hostname !== '127.0.0.1'
    || !url.port
    || ['5432', '5433', '5435'].includes(url.port)
    || url.pathname !== '/postgres'
    || decodeURIComponent(url.username) !== 'tm_actor_owner'
    || url.hash
    || [...url.searchParams].length) {
    throw new Error('RECOVERY_LOCAL_STARTUP_ADMIN_REFUSED')
  }
  return new URL(url.href)
}

async function admitPgdata(value: string): Promise<string> {
  if (!/^\/private\/tmp\/tm-recovery-actor-authority-pg-[a-z0-9-]+$/.test(value)) {
    throw new Error('RECOVERY_LOCAL_STARTUP_PGDATA_REFUSED')
  }
  const canonical = await realpath(value)
  if (canonical !== value) throw new Error('RECOVERY_LOCAL_STARTUP_PGDATA_REFUSED')
  return canonical
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('RECOVERY_LOCAL_STARTUP_DATABASE_REFUSED')
  return `"${value.replaceAll('"', '""')}"`
}

async function databaseCount(pool: Pool, name: string): Promise<number> {
  return Number((await pool.query(
    'SELECT count(*)::int AS count FROM pg_catalog.pg_database WHERE datname=$1',
    [name],
  )).rows[0].count)
}

async function backendCount(pool: Pool, name: string): Promise<number> {
  return Number((await pool.query(
    'SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE datname=$1',
    [name],
  )).rows[0].count)
}

async function dropOwnedDatabase(
  pool: Pool,
  name: string,
  expected: { oid: string; owner: string } | undefined,
): Promise<void> {
  const current = await pool.query(
    `SELECT oid::text, pg_catalog.pg_get_userbyid(datdba) AS owner
       FROM pg_catalog.pg_database WHERE datname=$1`,
    [name],
  )
  assert.deepEqual(current.rows, expected ? [expected] : [])
  if (!expected || expected.owner !== 'tm_actor_owner') throw new Error('RECOVERY_LOCAL_STARTUP_DATABASE_REFUSED')
  await pool.query(
    `SELECT pg_catalog.pg_terminate_backend(pid)
       FROM pg_catalog.pg_stat_activity
      WHERE datname=$1 AND pid <> pg_catalog.pg_backend_pid()`,
    [name],
  )
  await pool.query(`DROP DATABASE ${quoteIdentifier(name)}`)
  assert.equal(await databaseCount(pool, name), 0)
  assert.equal(await backendCount(pool, name), 0)
}

function launch(configPath: string, env: NodeJS.ProcessEnv): {
  child: ChildProcess
  locked: Promise<void>
} {
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    'scripts/start-recovery-local.mts',
    configPath,
  ], {
    cwd: backend,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  child.once('exit', () => children.delete(child))
  let output = ''
  let lockedResolved = false
  let resolveLocked!: () => void
  let rejectLocked!: (error: Error) => void
  const locked = new Promise<void>((resolvePromise, reject) => {
    resolveLocked = resolvePromise
    rejectLocked = reject
  })
  const timer = setTimeout(() => {
    if (!lockedResolved) rejectLocked(new Error('RECOVERY_LOCAL_STARTUP_LOCK_TIMEOUT'))
  }, 120_000)
  const consume = (chunk: Buffer | string) => {
    output = `${output}${chunk.toString()}`.slice(-16_384)
    if (!lockedResolved && output.includes('RECOVERY_LOCAL_CUSTODY_LOCKED')) {
      lockedResolved = true
      clearTimeout(timer)
      resolveLocked()
    }
  }
  child.stdout?.on('data', consume)
  child.stderr?.on('data', consume)
  child.once('error', () => {
    if (!lockedResolved) {
      lockedResolved = true
      clearTimeout(timer)
      rejectLocked(new Error('RECOVERY_LOCAL_STARTUP_SPAWN_FAILED'))
    }
  })
  child.once('exit', () => {
    if (!lockedResolved) {
      lockedResolved = true
      clearTimeout(timer)
      rejectLocked(new Error('RECOVERY_LOCAL_STARTUP_EXITED_BEFORE_LOCK'))
    }
  })
  return { child, locked }
}

function childSocketGuard(databasePort: string): string {
  if (!/^[1-9][0-9]{0,4}$/.test(databasePort)) {
    throw new Error('RECOVERY_LOCAL_STARTUP_NETWORK_GUARD_REFUSED')
  }
  const source = `
    import { Socket } from 'node:net';
    const allowedPort = ${Number(databasePort)};
    const allowedHosts = new Set(['127.0.0.1', '::1', 'localhost']);
    const originalConnect = Socket.prototype.connect;
    Socket.prototype.connect = new Proxy(originalConnect, {
      apply(target, receiver, args) {
        const first = Array.isArray(args[0]) ? args[0][0] : args[0];
        const options = typeof first === 'object' && first !== null
          ? first
          : { port: first, host: args[1] };
        if (options.path || !allowedHosts.has(options.host ?? 'localhost')
          || Number(options.port) !== allowedPort) {
          throw new Error('RECOVERY_LOCAL_STARTUP_UNAPPROVED_SOCKET');
        }
        return Reflect.apply(target, receiver, args);
      },
    });
  `
  return `--import=data:text/javascript,${encodeURIComponent(source)}`
}

async function writePipeSecret(child: ChildProcess, secret: Uint8Array): Promise<void> {
  const pipe = child.stdio[3]
  if (!pipe || typeof (pipe as NodeJS.WritableStream).end !== 'function') {
    throw new Error('RECOVERY_LOCAL_STARTUP_PIPE_MISSING')
  }
  const payload = Buffer.from(secret)
  const writable = pipe as NodeJS.WritableStream
  try {
    await new Promise<void>((resolvePromise, reject) => {
      writable.once('error', reject)
      writable.end(payload, resolvePromise)
    })
  } finally {
    payload.fill(0)
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  return bounded(new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolvePromise({ code, signal }))
  }), timeoutMs, 'RECOVERY_LOCAL_STARTUP_CHILD_EXIT_TIMEOUT')
}

async function stopChild(child: ChildProcess, requireGraceful: boolean): Promise<{
  code: number | null
  signal: NodeJS.Signals | null
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode }
  }
  child.kill('SIGTERM')
  try {
    const result = await waitForExit(child, 30_000)
    if (requireGraceful) assert.deepEqual(result, { code: 0, signal: null })
    return result
  } catch (error) {
    child.kill('SIGKILL')
    await waitForExit(child, 5_000).catch(() => {})
    throw error
  }
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createNetServer()
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const selected = address.port
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()))
  return selected
}

async function canConnect(portNumber: number): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port: portNumber })
    const finish = (connected: boolean) => {
      socket.destroy()
      resolvePromise(connected)
    }
    socket.setTimeout(500, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function assertNoListener(portNumber: number): Promise<void> {
  assert.equal(await canConnect(portNumber), false, 'RECOVERY_LOCAL_STARTUP_LISTENER_MUST_BE_CLOSED')
}

async function waitForListener(portNumber: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await canConnect(portNumber)) return
    await delay(100)
  }
  throw new Error('RECOVERY_LOCAL_STARTUP_LISTENER_TIMEOUT')
}

async function assertMissing(path: string): Promise<void> {
  try {
    await stat(path)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  throw new Error('RECOVERY_LOCAL_STARTUP_PATH_EXISTS')
}

async function pathCount(path: string): Promise<number> {
  try {
    await stat(path)
    return 1
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return 0
    throw error
  }
}

function bounded<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolvePromise(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds))
}

async function writeEvidence(): Promise<void> {
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
}
