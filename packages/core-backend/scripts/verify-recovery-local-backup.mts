/** Test-only two-database backup-set recovery acceptance. Never targets DATABASE_URL. */
import assert from 'node:assert/strict'
import { fork, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Pool, PoolClient, QueryConfig } from 'pg'

import type {
  RecoveryArchiveRestoreJobQuery,
  RecoveryArchiveRestoreJobTransaction,
} from '../src/multitable/recovery-archive-restore-jobs'
import type { LocalCustodyReceipt } from '../src/multitable/recovery-local-custody-store'
import type { RecoveryArchiveLocalBackupFixture } from '../tests/utils/recovery-archive-local-backup-fixture'
import type {
  ArchiveProcessWorkerInput,
  ArchiveProcessWorkerMessage,
} from '../tests/utils/recovery-archive-process-worker'
const require = createRequire(import.meta.url)
const { createAndCaptureManualFixture } = require('./verify-recovery-local-manual-http.ts') as typeof import('./verify-recovery-local-manual-http')
const {
  assertDistinctDirectoryIdentities,
  assertOwnedPrivateDirectory,
  parseRecoveryLocalBackupCli,
  recoveryLocalBackupDatabaseNames,
  recoveryLocalBackupDatabaseUrl,
  recoveryLocalBackupPgEnv,
} = require('../tests/utils/recovery-local-backup-driver-safety.ts') as typeof import('../tests/utils/recovery-local-backup-driver-safety')

const repo = fileURLToPath(new URL('../../../', import.meta.url))
const workerPath = fileURLToPath(new URL('../tests/utils/recovery-archive-process-worker.ts', import.meta.url))
const manualTargetPath = fileURLToPath(new URL('./verify-recovery-local-manual-target.mts', import.meta.url))
const runToken = randomUUID().replaceAll('-', '').slice(0, 16)
const prefix = `tm_local_backup_${runToken}`
const args = parseRecoveryLocalBackupCli(process.argv.slice(2))
const names = recoveryLocalBackupDatabaseNames(runToken)
const sourceUrl = recoveryLocalBackupDatabaseUrl(args.adminUrl, names.source)
const targetUrl = recoveryLocalBackupDatabaseUrl(args.adminUrl, names.target)
const sourceAttachmentPath = join(args.workRoot, 'source', 'attachments')
const targetAttachmentPath = join(args.workRoot, 'target', 'attachments')
const recoverySecret = randomBytes(32)
const jwtSecret = randomBytes(48).toString('hex')
const children = new Set<ChildProcess>()
type OwnedDatabaseIdentity = { name: string; oid: string; owner: string; system_identifier: string }
const ownedDatabases = new Map<string, OwnedDatabaseIdentity>()
let workRootCreated = false
let sourceCreated = false
let targetCreated = false
let sourceRuntime: DatabaseRuntime | undefined
let targetRuntime: DatabaseRuntime | undefined

const inheritedEnvironment = process.env
const safeEnvironment: NodeJS.ProcessEnv = {}
for (const key of ['PATH', 'HOME', 'TMPDIR', 'SYSTEMROOT']) {
  if (inheritedEnvironment[key]) safeEnvironment[key] = inheritedEnvironment[key]
}
for (const key of Object.keys(process.env)) delete process.env[key]
// These flags exist only in this synthetic test process, never in service configuration.
Object.assign(process.env, safeEnvironment, {
  NODE_ENV: 'test', JWT_SECRET: jwtSecret,
  MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true',
  MULTITABLE_ENABLE_WRITER_FENCE: 'true',
  MULTITABLE_HISTORY_CONTIGUITY_STRICT: 'true',
  ATTACHMENT_PATH: sourceAttachmentPath,
})

type FileStoreProvider = Awaited<ReturnType<typeof import('../src/multitable/recovery-archive-file-store').createRecoveryArchiveFileStoreProvider>>
type LocalCustodySession = ReturnType<typeof import('../src/multitable/recovery-local-custody').createLocalCustodySession>
type LocalCustodyAdmission = ReturnType<LocalCustodySession['admitForArchive']>

let PgPool: typeof import('pg').Pool
let RECOVERY_ARCHIVE_V1_SECTION_NAMES: typeof import('../src/multitable/recovery-archive-contract').RECOVERY_ARCHIVE_V1_SECTION_NAMES
let createRecoveryArchiveFileStoreProvider: typeof import('../src/multitable/recovery-archive-file-store').createRecoveryArchiveFileStoreProvider
let provisionRecoveryArchiveFileRoot: typeof import('../src/multitable/recovery-archive-file-store').provisionRecoveryArchiveFileRoot
let loadRecoveryArchiveAuthorityInternal: typeof import('../src/multitable/recovery-archive-preview').loadRecoveryArchiveAuthorityInternal
let RecoveryArchivePreviewErrorClass: typeof import('../src/multitable/recovery-archive-preview').RecoveryArchivePreviewError
let readRecoveryArchiveCompleteSectionState: typeof import('../src/multitable/recovery-archive-reader').readRecoveryArchiveCompleteSectionState
let readRecoveryArchiveAttachmentBytes: typeof import('../src/multitable/recovery-archive-reader').readRecoveryArchiveAttachmentBytes
let RecoveryArchiveReaderErrorClass: typeof import('../src/multitable/recovery-archive-reader').RecoveryArchiveReaderError
let createLocalCustodyBackup: typeof import('../src/multitable/recovery-local-custody').createLocalCustodyBackup
let createLocalCustodySession: typeof import('../src/multitable/recovery-local-custody').createLocalCustodySession
let createLocalCustodyStore: typeof import('../src/multitable/recovery-local-custody-store').createLocalCustodyStore
let createRecoveryArchiveLocalBackupFixture: typeof import('../tests/utils/recovery-archive-local-backup-fixture').createRecoveryArchiveLocalBackupFixture
let recoveryLocalBackupArchivedValue: typeof import('../tests/utils/recovery-archive-local-backup-fixture').recoveryLocalBackupArchivedValue
let recoveryLocalBackupRecordCount: typeof import('../tests/utils/recovery-archive-local-backup-fixture').recoveryLocalBackupRecordCount

interface DatabaseRuntime {
  readonly pool: Pool
  readonly query: RecoveryArchiveRestoreJobQuery
  readonly transaction: RecoveryArchiveRestoreJobTransaction
  readonly depth: { currentTransactionDepth(): number }
  readonly nativePool: Pick<Pool, 'connect' | 'options'>
}

interface NonceTuple {
  readonly dek_fingerprint: string
  readonly nonce: string
  readonly generation_id: string
  readonly section_name: string
  readonly aead_algorithm: string
  readonly format_version: number
}

interface LiveRow {
  readonly id: string
  readonly data: Record<string, unknown>
  readonly version: number
}

async function loadRuntimeDependencies(): Promise<void> {
  const [pg, contract, fileStore, preview, reader, custody, custodyStore, fixture] = await Promise.all([
    require('pg'),
    require('../src/multitable/recovery-archive-contract.ts'),
    require('../src/multitable/recovery-archive-file-store.ts'),
    require('../src/multitable/recovery-archive-preview.ts'),
    require('../src/multitable/recovery-archive-reader.ts'),
    require('../src/multitable/recovery-local-custody.ts'),
    require('../src/multitable/recovery-local-custody-store.ts'),
    require('../tests/utils/recovery-archive-local-backup-fixture.ts'),
  ])
  PgPool = pg.Pool
  RECOVERY_ARCHIVE_V1_SECTION_NAMES = contract.RECOVERY_ARCHIVE_V1_SECTION_NAMES
  createRecoveryArchiveFileStoreProvider = fileStore.createRecoveryArchiveFileStoreProvider
  provisionRecoveryArchiveFileRoot = fileStore.provisionRecoveryArchiveFileRoot
  loadRecoveryArchiveAuthorityInternal = preview.loadRecoveryArchiveAuthorityInternal
  RecoveryArchivePreviewErrorClass = preview.RecoveryArchivePreviewError
  readRecoveryArchiveCompleteSectionState = reader.readRecoveryArchiveCompleteSectionState
  readRecoveryArchiveAttachmentBytes = reader.readRecoveryArchiveAttachmentBytes
  RecoveryArchiveReaderErrorClass = reader.RecoveryArchiveReaderError
  createLocalCustodyBackup = custody.createLocalCustodyBackup
  createLocalCustodySession = custody.createLocalCustodySession
  createLocalCustodyStore = custodyStore.createLocalCustodyStore
  createRecoveryArchiveLocalBackupFixture = fixture.createRecoveryArchiveLocalBackupFixture
  recoveryLocalBackupArchivedValue = fixture.recoveryLocalBackupArchivedValue
  recoveryLocalBackupRecordCount = fixture.recoveryLocalBackupRecordCount
}

async function main(): Promise<Record<string, unknown>> {
  await loadRuntimeDependencies()
  let admin: Pool | undefined
  let result: Record<string, unknown> | undefined
  let primaryError: unknown
  try {
    assert.equal(process.env.NODE_ENV, 'test')
    assert.equal(RECOVERY_ARCHIVE_V1_SECTION_NAMES.length, 10)
    await assertPathMissing(args.workRoot)
    await mkdir(args.workRoot, { mode: 0o700 })
    workRootCreated = true
    await assertOwnedPrivateDirectory(args.workRoot)

    const admittedPgdata = await assertOwnedPrivateDirectory(args.pgdata)
    const canonicalPgdata = admittedPgdata.realPath
    admin = new PgPool({ connectionString: args.adminUrl.href, max: 1, application_name: `${prefix}_admin`, connectionTimeoutMillis: 1000 })
    const server = await admin.query(
      `SELECT current_database() AS database_name,
              current_user AS owner,
              pg_catalog.current_setting('data_directory') AS data_directory`,
    )
    const serverRow = server.rows[0] as { database_name: string; owner: string; data_directory: string }
    assert.equal(serverRow.database_name, 'postgres', 'RECOVERY_LOCAL_BACKUP_ADMIN_DATABASE_REFUSED')
    assert.equal(await realpath(serverRow.data_directory), canonicalPgdata, 'RECOVERY_LOCAL_BACKUP_PGDATA_MISMATCH')
    assert.equal(await databaseCount(admin, [names.source, names.target]), 0, 'RECOVERY_LOCAL_BACKUP_DATABASE_ALREADY_EXISTS')

    await createOwnedDatabase(admin, names.source, serverRow.owner)
    sourceCreated = true
    await createOwnedDatabase(admin, names.target, serverRow.owner)
    targetCreated = true
    await assertDatabaseOwner(admin, names.source, serverRow.owner)
    await assertDatabaseOwner(admin, names.target, serverRow.owner)

    const emptyTarget = createDatabaseRuntime(targetUrl, `${prefix}_empty_target`)
    try {
      assert.equal(await userTableCount(emptyTarget.query), 0, 'RECOVERY_LOCAL_BACKUP_TARGET_NOT_EMPTY')
    } finally {
      await emptyTarget.pool.end()
    }

    runChecked('pnpm', ['--filter', '@metasheet/core-backend', 'migrate'], {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: sourceUrl.href,
    }, 'RECOVERY_LOCAL_BACKUP_MIGRATION_FAILED', 240_000)

    sourceRuntime = createDatabaseRuntime(sourceUrl, `${prefix}_source_fixture`)
    const sourceDatabaseIdentity = await databaseIdentity(sourceRuntime.query)
    assert.equal(sourceDatabaseIdentity.name, names.source)
    const sourceRoot = join(args.workRoot, 'source')
    const sourceArchive = join(sourceRoot, 'archive')
    const sourceCustody = join(sourceRoot, 'custody')
    await mkdir(sourceArchive, { recursive: true, mode: 0o700 })
    await mkdir(sourceCustody, { mode: 0o700 })
    const sourceArchiveIdentity = await assertOwnedPrivateDirectory(sourceArchive)
    const sourceCustodyIdentity = await assertOwnedPrivateDirectory(sourceCustody)
    assertDistinctDirectoryIdentities(sourceArchiveIdentity, sourceCustodyIdentity)

    const custodyId = randomUUID()
    const storeId = randomUUID()
    await provisionRecoveryArchiveFileRoot({
      basePath: sourceArchive,
      storeId,
      transactionDepth: sourceRuntime.depth,
    })
    const sourceProvider = await createRecoveryArchiveFileStoreProvider({
      basePath: sourceArchive,
      storeId,
      maxObjectBytes: 16 * 1024 * 1024,
      transactionDepth: sourceRuntime.depth,
    })
    const sourceCustodyStore = await createLocalCustodyStore({
      archivePath: sourceArchive,
      custodyPath: sourceCustody,
      custodyId,
      transactionDepth: sourceRuntime.depth,
    })
    const initialBackup = createLocalCustodyBackup({
      custodyId,
      recoverySecret,
      transactionDepth: sourceRuntime.depth,
    })
    await sourceCustodyStore.putBackup(randomUUID(), initialBackup)
    const sourceSession = createLocalCustodySession(sourceRuntime.depth)
    sourceSession.unlock({ custodyId, recoverySecret, backup: initialBackup })
    const sourceAdmission = sourceSession.admitForArchive(custodyId)
    const rotatedReceipt = await sourceCustodyStore.putBackup(
      randomUUID(),
      sourceSession.exportRotatedBackup(recoverySecret),
    )
    const expiresAt = '2099-12-31T00:00:00.000Z'
    const fixture = await createRecoveryArchiveLocalBackupFixture({
      prefix,
      query: sourceRuntime.query,
      transaction: sourceRuntime.transaction,
      transactionDepth: sourceRuntime.depth,
      objectStore: sourceProvider,
      keyCustody: sourceAdmission,
      expiresAt,
      expectedNonceSections: RECOVERY_ARCHIVE_V1_SECTION_NAMES,
    })
    const manual = await createAndCaptureManualFixture({
      runtime: sourceRuntime, workspaceId: fixture.fixture.workspaceId, prefix,
      attachmentPath: sourceAttachmentPath,
      archive: { keyCustody: sourceAdmission, objectStore: sourceProvider, transactionDepth: sourceRuntime.depth },
      keyId: sourceAdmission.keyId,
    })
    assert.notEqual(manual.generationId, fixture.fixture.generationId)
    const sourceCapturedAuthority = await loadAuthority(sourceRuntime, {
      workspaceId: fixture.fixture.workspaceId, baseId: manual.baseId,
      sheetId: manual.sheetId, generationId: manual.generationId,
    })
    assert.deepEqual((await sourceRuntime.query(
      'SELECT count(*)::int AS count FROM public.meta_recovery_archives WHERE sheet_id=$1',
      [manual.sheetId],
    )).rows[0] as { count: number }, { count: 1 })
    const manualSourceNonces = await readNonceTuples(sourceRuntime.query, manual.generationId)
    const { recoveryArchiveAttachmentNonceIdentity } = require('../src/multitable/recovery-archive-attachment-crypto.ts') as typeof import('../src/multitable/recovery-archive-attachment-crypto')
    const expectedManualNonceIdentities = [...RECOVERY_ARCHIVE_V1_SECTION_NAMES,
      recoveryArchiveAttachmentNonceIdentity(manual.attachmentId)].sort()
    assert.deepEqual(manualSourceNonces.map(row => row.section_name), expectedManualNonceIdentities)
    assert.equal(manualSourceNonces.length, 11)
    assert.deepEqual(sourceCapturedAuthority.attachmentObjects?.map(object => object.attachmentId), [manual.attachmentId])
    assert.equal(sourceCapturedAuthority.attachmentObjects![0].binding.generationId, manual.generationId)
    assert.equal((await readLiveRows(sourceRuntime.query, manual.sheetId)).length, 5001)
    sourceSession.lock()
    assert.equal(sourceSession.isUnlocked(), false)

    const sourceNonces = await readNonceTuples(sourceRuntime.query, fixture.fixture.generationId)
    assert.deepEqual(sourceNonces.map((row) => row.section_name), [...RECOVERY_ARCHIVE_V1_SECTION_NAMES].sort())
    assert.equal(sourceNonces.length, 10)
    const sourceLiveRows = await readLiveRows(sourceRuntime.query, fixture.fixture.sheetId)
    assert.equal(sourceLiveRows.length, recoveryLocalBackupRecordCount())
    assertExactLiveRows(sourceLiveRows, fixture.recordIds, fixture.fieldId, 'live', 2)
    const expectedRestoredRows = fixture.recordIds.map((id, index) => Object.freeze({
      id,
      data: Object.freeze({ [fixture.fieldId]: recoveryLocalBackupArchivedValue(index) }),
      version: 3,
    }))
    const sourceLiveHash = hashRows(sourceLiveRows)

    await sourceRuntime.pool.end()
    sourceRuntime = undefined
    await assertBackendCount(admin, names.source, 0)

    const dumpPath = join(args.workRoot, 'source.dump')
    runChecked('pg_dump', [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      `--file=${dumpPath}`,
    ], { ...process.env, ...recoveryLocalBackupPgEnv(sourceUrl) }, 'RECOVERY_LOCAL_BACKUP_DUMP_FAILED', 240_000)
    assert.ok((await stat(dumpPath)).size > 0, 'RECOVERY_LOCAL_BACKUP_DUMP_EMPTY')
    await assertBackendCount(admin, names.source, 0)

    runChecked('pg_restore', [
      '--exit-on-error',
      '--single-transaction',
      '--no-owner',
      '--no-privileges',
      `--dbname=${names.target}`,
      dumpPath,
    ], { ...process.env, ...recoveryLocalBackupPgEnv(targetUrl) }, 'RECOVERY_LOCAL_BACKUP_RESTORE_FAILED', 240_000)

    const targetRoot = join(args.workRoot, 'target')
    const targetArchive = join(targetRoot, 'archive')
    const targetCustody = join(targetRoot, 'custody')
    await mkdir(targetRoot, { mode: 0o700 })
    await cp(sourceArchive, targetArchive, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
    await cp(sourceCustody, targetCustody, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true })
    const targetArchiveIdentity = await assertOwnedPrivateDirectory(targetArchive)
    const targetCustodyIdentity = await assertOwnedPrivateDirectory(targetCustody)
    assertDistinctDirectoryIdentities(targetArchiveIdentity, targetCustodyIdentity)
    assertDistinctDirectoryIdentities(sourceArchiveIdentity, targetArchiveIdentity)
    assertDistinctDirectoryIdentities(sourceCustodyIdentity, targetCustodyIdentity)
    assert.equal((await readFile(join(targetArchive, '.metasheet-archive-root'), 'utf8')), storeId)
    await assertReceiptRetained(sourceCustody, targetCustody, custodyId, rotatedReceipt)

    await dropOwnedDatabase(admin, names.source)
    sourceCreated = false
    await rm(sourceRoot, { recursive: true, force: false })
    await assertSourceUnavailable(admin, sourceUrl, names.source, sourceArchive, sourceCustody)

    targetRuntime = createDatabaseRuntime(targetUrl, `${prefix}_target_parent`)
    const targetDatabaseIdentity = await databaseIdentity(targetRuntime.query)
    assert.equal(targetDatabaseIdentity.name, names.target)
    assert.notEqual(targetDatabaseIdentity.oid, sourceDatabaseIdentity.oid)
    const targetNonces = await readNonceTuples(targetRuntime.query, fixture.fixture.generationId)
    assert.deepEqual(targetNonces, sourceNonces)
    assert.deepEqual(targetNonces.map((row) => row.section_name), [...RECOVERY_ARCHIVE_V1_SECTION_NAMES].sort())
    const importedRows = await readLiveRows(targetRuntime.query, fixture.fixture.sheetId)
    assert.equal(hashRows(importedRows), sourceLiveHash)

    const targetProvider = await createRecoveryArchiveFileStoreProvider({
      basePath: targetArchive,
      storeId,
      maxObjectBytes: 16 * 1024 * 1024,
      transactionDepth: targetRuntime.depth,
    })
    const targetCustodyStore = await createLocalCustodyStore({
      archivePath: targetArchive,
      custodyPath: targetCustody,
      custodyId,
      transactionDepth: targetRuntime.depth,
    })
    const copiedBackup = await targetCustodyStore.readBackup(rotatedReceipt)
    const targetSession = createLocalCustodySession(targetRuntime.depth)
    targetSession.unlock({ custodyId, recoverySecret, backup: copiedBackup })
    const targetAdmission = targetSession.admitForArchive(custodyId)
    assert.notEqual(targetAdmission.keyId, fixture.archivedKeyId)
    const capturedAuthority = await loadAuthority(targetRuntime, {
      workspaceId: fixture.fixture.workspaceId,
      baseId: manual.baseId,
      sheetId: manual.sheetId,
      generationId: manual.generationId,
    })
    assert.deepEqual(capturedAuthority.selectedBinding, sourceCapturedAuthority.selectedBinding)
    assert.deepEqual(capturedAuthority.manifestObject, sourceCapturedAuthority.manifestObject)
    assert.deepEqual(capturedAuthority.sectionObjects, sourceCapturedAuthority.sectionObjects)
    assert.deepEqual(capturedAuthority.attachmentObjects, sourceCapturedAuthority.attachmentObjects)
    assert.deepEqual(await readNonceTuples(targetRuntime.query, manual.generationId), manualSourceNonces)
    assert.deepEqual((await targetRuntime.query(
      'SELECT count(*)::int AS count FROM public.meta_recovery_archives WHERE sheet_id=$1',
      [manual.sheetId],
    )).rows[0] as { count: number }, { count: 1 })
    const capturedState = await readRecoveryArchiveCompleteSectionState({
      query: targetRuntime.query,
      selectedBinding: capturedAuthority.selectedBinding,
      manifestObject: capturedAuthority.manifestObject,
      sectionObjects: capturedAuthority.sectionObjects,
      attachmentObjects: capturedAuthority.attachmentObjects,
      keyCustody: targetAdmission,
      objectStore: targetProvider,
      transactionDepth: targetRuntime.depth,
    })
    assert.equal(capturedState.records.size, 5001)
    assert.deepEqual([...capturedState.records.keys()].sort(), [...manual.recordIds].sort())
    const capturedData = capturedState.records.get(manual.recordId)?.data
    assert.deepEqual(Object.keys(capturedData ?? {}).sort(), [manual.fieldId, manual.attachmentFieldId].sort())
    assert.equal(capturedData?.[manual.fieldId], 'captured')
    assert.deepEqual(capturedData?.[manual.attachmentFieldId], [manual.attachmentId])
    assert.deepEqual(readRecoveryArchiveAttachmentBytes(capturedState, manual.attachmentId).bytes, manual.attachmentBytes)
    const manualRowsBeforeRefusals = await readLiveRows(targetRuntime.query, manual.sheetId)
    const manualEffectsBeforeRefusals = (await targetRuntime.query(
      `SELECT (SELECT count(*)::int FROM public.meta_record_revisions WHERE sheet_id=$1) AS revisions,
              (SELECT count(*)::int FROM public.meta_recovery_archive_jobs WHERE sheet_id=$1) AS jobs`,
      [manual.sheetId],
    )).rows
    const capturedAttachmentObject = capturedAuthority.attachmentObjects?.find(item => item.attachmentId === manual.attachmentId)?.binding
    assert.ok(capturedAttachmentObject)
    const attachmentObjectPath = join(targetArchive,
      `${capturedAttachmentObject.generationId}-${capturedAttachmentObject.objectId}.object`)
    const missingAttachmentObjectPath = `${attachmentObjectPath}.missing`
    await rename(attachmentObjectPath, missingAttachmentObjectPath)
    try {
      await assert.rejects(readRecoveryArchiveCompleteSectionState({
        query: targetRuntime.query, selectedBinding: capturedAuthority.selectedBinding,
        manifestObject: capturedAuthority.manifestObject, sectionObjects: capturedAuthority.sectionObjects,
        attachmentObjects: capturedAuthority.attachmentObjects,
        keyCustody: targetAdmission, objectStore: targetProvider, transactionDepth: targetRuntime.depth,
      }), (error: unknown) => error instanceof RecoveryArchiveReaderErrorClass
        && error.code === 'RECOVERY_ARCHIVE_READER_OBJECT_STORE_FAILED')
    } finally {
      await rename(missingAttachmentObjectPath, attachmentObjectPath)
    }
    assert.deepEqual(await readLiveRows(targetRuntime.query, manual.sheetId), manualRowsBeforeRefusals)
    assert.deepEqual((await targetRuntime.query(
      `SELECT (SELECT count(*)::int FROM public.meta_record_revisions WHERE sheet_id=$1) AS revisions,
              (SELECT count(*)::int FROM public.meta_recovery_archive_jobs WHERE sheet_id=$1) AS jobs`,
      [manual.sheetId],
    )).rows, manualEffectsBeforeRefusals)
    await assertPathMissing(targetAttachmentPath)

    await runFailClosedNegatives({
      runtime: targetRuntime,
      provider: targetProvider,
      keyCustody: targetAdmission,
      fixture,
      archivePath: targetArchive,
      custodyPath: targetCustody,
      custodyId,
      storeId,
      receipt: rotatedReceipt,
      recoverySecret,
      sourceLiveHash,
    })

    const authority = await loadAuthority(targetRuntime, fixture.fixture)
    const opened = await readRecoveryArchiveCompleteSectionState({
      query: targetRuntime.query,
      selectedBinding: authority.selectedBinding,
      manifestObject: authority.manifestObject,
      sectionObjects: authority.sectionObjects,
      keyCustody: targetAdmission,
      objectStore: targetProvider,
      transactionDepth: targetRuntime.depth,
    })
    assert.equal(opened.records.size, recoveryLocalBackupRecordCount())
    assert.deepEqual(Object.keys(opened).sort(), [...RECOVERY_ARCHIVE_V1_SECTION_NAMES].sort())
    targetSession.lock()

    const localWorkerInput: NonNullable<ArchiveProcessWorkerInput['local']> = {
      archivePath: targetArchive,
      custodyPath: targetCustody,
      custodyId,
      storeId,
      receipt: rotatedReceipt,
      recoverySecret,
    }
    const completed = await runWorker({
      phase: 'finish',
      keyId: fixture.archivedKeyId,
      keyMaterial: { dek: randomBytes(32), wrappedDek: randomBytes(48) },
      jobId: fixture.jobId,
      expectedDatabaseName: names.target,
      local: localWorkerInput,
    }, targetUrl)
    assert.equal(completed.kind, 'done')
    if (completed.kind !== 'done') throw new Error('RECOVERY_LOCAL_BACKUP_WORKER_RESULT_INVALID')
    console.log(JSON.stringify({ phase: 'worker', outcome: completed.outcome, state: completed.terminal.state }))
    assert.deepEqual(completed.outcome, { kind: 'completed', swept: 0, chunks: 2 })
    assert.deepEqual(completed.terminal, { state: 'done', completedCount: '5001' })
    assert.deepEqual(completed.lifecycle, ['started', 'drained'])

    const drained = await runWorker({
      phase: 'drain',
      drainTicks: 158,
      keyId: fixture.archivedKeyId,
      keyMaterial: { dek: randomBytes(32), wrappedDek: randomBytes(48) },
      jobId: fixture.jobId,
      expectedDatabaseName: names.target,
      local: localWorkerInput,
    }, targetUrl)
    assert.equal(drained.kind, 'drained')
    if (drained.kind !== 'drained') throw new Error('RECOVERY_LOCAL_BACKUP_DRAIN_RESULT_INVALID')
    assert.equal(drained.attempts, recoveryLocalBackupRecordCount())
    assert.equal(drained.completed, recoveryLocalBackupRecordCount())
    assert.deepEqual(drained.lifecycle, ['started', 'drained'])

    const restoredRows = await readLiveRows(targetRuntime.query, fixture.fixture.sheetId)
    assert.deepEqual(restoredRows, expectedRestoredRows)
    const terminal = await targetRuntime.query(
      `SELECT job.state, job.completed_count::text AS completed_count,
              sheet.recovery_writer_state,
              (SELECT count(*)::int FROM public.meta_record_revisions revision
                WHERE revision.sheet_id=job.sheet_id AND revision.source='restore') AS restore_events,
              (SELECT count(*)::int FROM public.meta_recovery_archive_derived_effects effect
                WHERE effect.job_id=job.id) AS effects,
              (SELECT count(*)::int FROM public.meta_recovery_archive_derived_effects effect
                WHERE effect.job_id=job.id AND effect.completed_at IS NOT NULL) AS completed_effects
         FROM public.meta_recovery_archive_jobs job
         JOIN public.meta_sheets sheet ON sheet.id=job.sheet_id
        WHERE job.id=$1::uuid`,
      [fixture.jobId],
    )
    assert.deepEqual(terminal.rows, [{
      state: 'done',
      completed_count: '5001',
      recovery_writer_state: null,
      restore_events: 5001,
      effects: 5001,
      completed_effects: 5001,
    }])
    assert.equal(await exactOnceRecordCount(targetRuntime.query, fixture.fixture.sheetId), recoveryLocalBackupRecordCount())

    await assertPathMissing(targetAttachmentPath)
    const rollbackTableCount = await runManualTargetChild({
      databaseName: names.target,
      local: {
        archivePath: targetArchive, custodyPath: targetCustody, custodyId, storeId,
        receipt: rotatedReceipt, recoverySecret: Uint8Array.from(recoverySecret),
      },
      identity: { sheetId: manual.sheetId, actorId: manual.actorId },
      password: manual.password,
      generationId: manual.generationId,
      recordId: manual.recordId,
      recordIds: manual.recordIds,
      fieldId: manual.fieldId,
      attachmentFieldId: manual.attachmentFieldId,
      attachmentId: manual.attachmentId,
      attachmentBytes: Uint8Array.from(manual.attachmentBytes),
    }, targetUrl)

    assert.deepEqual(await readNonceTuples(targetRuntime.query, manual.generationId), manualSourceNonces)
    const finalNonces = await readNonceTuples(targetRuntime.query, fixture.fixture.generationId)
    assert.deepEqual(finalNonces, sourceNonces)
    result = {
      result: 'PASS',
      fixture: 'synthetic-owned-two-database-backup-set',
      records: recoveryLocalBackupRecordCount(),
      nonceSections: finalNonces.length,
      receiptRetained: true,
      storeIdRetained: true,
      sourceUnavailableBeforeWorker: true,
      targetDatabaseIdentityDistinct: true,
      manualCapturedArchive: {
        sameGenerationImportedAndRestored: true,
        records: 5001,
        nonceSections: 10,
        attachmentNonceReservations: 1,
        totalNonceReservations: 11,
        operations: 'sync-attachment-selected-fields-then-async-scalar-whole-sheet',
        chunkCommittedCounts: [5000, 1],
        sameJobLeaseTakeover: true,
        higherWorkerFenceSameBlockFence: true,
        staleWorkerCasWrites: 0,
        aggregateMembers: 2,
        exactOnceScalarRestoreRevisions: 5001,
        separateSyncAttachmentRestoreRevisions: 1,
        derivedEffectsDrained: 5001,
        separateOfficialDrainProcess: true,
        drainDidNotRepeatRestore: true,
        attachmentBytesRecovered: true,
        sourceUnavailableBeforeRestore: true,
        freshTargetProcess: true,
        officialTargetLauncher: true,
        lockedUntilOperatorUnlock: true,
        gracefulStopWithNoListener: true,
        flagOffRollbackHttpParity: true,
        flagOffRollbackNoWrites: true,
        flagOffFreshProcesses: 2,
        flagOffComparedTables: rollbackTableCount,
      },
      writerBlockReleased: true,
      derivedEffectsDrained: recoveryLocalBackupRecordCount(),
    }
  } catch (error) {
    primaryError = error
  }

  const cleanupFailures: string[] = []
  for (const child of [...children]) {
    try {
      await stopChild(child)
    } catch {
      cleanupFailures.push('worker')
    }
  }
  for (const runtime of [sourceRuntime, targetRuntime]) {
    if (!runtime) continue
    try {
      await runtime.pool.end()
    } catch {
      cleanupFailures.push('pool')
    }
  }
  sourceRuntime = undefined
  targetRuntime = undefined
  if (admin && cleanupFailures.length === 0) {
    if (sourceCreated) {
      try {
        await dropOwnedDatabase(admin, names.source)
        sourceCreated = false
      } catch {
        cleanupFailures.push('source_database')
      }
    }
    if (targetCreated) {
      try {
        await dropOwnedDatabase(admin, names.target)
        targetCreated = false
      } catch {
        cleanupFailures.push('target_database')
      }
    }
  }
  if (workRootCreated && cleanupFailures.length === 0) {
    try {
      await rm(args.workRoot, { recursive: true, force: true })
      workRootCreated = false
    } catch {
      cleanupFailures.push('work_root')
    }
  }
  recoverySecret.fill(0)

  let residue: { databases: number; backends: number; paths: number; workers: number } | undefined
  try {
    residue = {
      databases: admin ? await databaseCount(admin, [names.source, names.target]) : Number(sourceCreated || targetCreated),
      backends: admin ? await backendCount(admin, [names.source, names.target]) : Number(sourceCreated || targetCreated),
      paths: await existingPathCount([args.workRoot]),
      workers: [...children].filter((child) => child.exitCode === null && child.signalCode === null).length,
    }
  } catch {
    cleanupFailures.push('census')
  }
  if (admin) {
    try {
      await admin.end()
    } catch {
      cleanupFailures.push('admin_pool')
    }
  }
  if (!residue || Object.values(residue).some((count) => count !== 0)) {
    cleanupFailures.push('residue')
  }
  if (cleanupFailures.length > 0) throw new Error('RECOVERY_LOCAL_BACKUP_CLEANUP_FAILED')
  if (primaryError) throw primaryError
  if (!result) throw new Error('RECOVERY_LOCAL_BACKUP_RESULT_MISSING')
  return result
}

async function runFailClosedNegatives(input: {
  readonly runtime: DatabaseRuntime
  readonly provider: FileStoreProvider
  readonly keyCustody: LocalCustodyAdmission
  readonly fixture: RecoveryArchiveLocalBackupFixture
  readonly archivePath: string
  readonly custodyPath: string
  readonly custodyId: string
  readonly storeId: string
  readonly receipt: LocalCustodyReceipt
  readonly recoverySecret: Uint8Array
  readonly sourceLiveHash: string
}): Promise<void> {
  const liveHash = async () => hashRows(await readLiveRows(input.runtime.query, input.fixture.fixture.sheetId))
  const writeSignature = async () => (await input.runtime.query(
    `SELECT to_jsonb(job) AS job, sheet.recovery_writer_state,
            (SELECT count(*)::int FROM public.meta_record_revisions WHERE sheet_id=job.sheet_id) AS revisions,
            (SELECT count(*)::int FROM public.meta_recovery_archive_derived_effects WHERE job_id=job.id) AS effects
       FROM public.meta_recovery_archive_jobs job JOIN public.meta_sheets sheet ON sheet.id=job.sheet_id
      WHERE job.id=$1::uuid`, [input.fixture.jobId],
  )).rows
  const beforeWrites = await writeSignature()
  const unchanged = async () => {
    assert.equal(await liveHash(), input.sourceLiveHash, 'RECOVERY_LOCAL_BACKUP_NEGATIVE_MUTATED_ROWS')
    assert.deepEqual(await writeSignature(), beforeWrites, 'RECOVERY_LOCAL_BACKUP_NEGATIVE_MUTATED_JOB')
  }

  const catalogClient = await input.runtime.pool.connect()
  try {
    await catalogClient.query('BEGIN')
    await assert.rejects(
      loadRecoveryArchiveAuthorityInternal(
        async (work) => work(catalogClient.query.bind(catalogClient)),
        authorityInput({ ...input.fixture.fixture, generationId: randomUUID() }),
      ),
      (error: unknown) => error instanceof RecoveryArchivePreviewErrorClass && error.code === 'RECOVERY_ARCHIVE_PREVIEW_NOT_FOUND',
    )
  } finally {
    await catalogClient.query('ROLLBACK').catch(() => {})
    catalogClient.release()
  }
  await unchanged()

  const authority = await loadAuthority(input.runtime, input.fixture.fixture)
  const readerInput = {
    query: input.runtime.query,
    selectedBinding: authority.selectedBinding,
    manifestObject: authority.manifestObject,
    sectionObjects: authority.sectionObjects,
    keyCustody: input.keyCustody,
    objectStore: input.provider,
    transactionDepth: input.runtime.depth,
  }

  const wrongSecretSession = createLocalCustodySession(input.runtime.depth)
  const wrongSecret = randomBytes(32)
  try {
    await assert.rejects(async () => wrongSecretSession.unlock({
      custodyId: input.custodyId,
      recoverySecret: wrongSecret,
      backup: await createLocalCustodyStore({
        archivePath: input.archivePath,
        custodyPath: input.custodyPath,
        custodyId: input.custodyId,
        transactionDepth: input.runtime.depth,
      }).then((store) => store.readBackup(input.receipt)),
    }), /RECOVERY_LOCAL_CUSTODY_REFUSED/)
  } finally {
    wrongSecret.fill(0)
  }
  await unchanged()

  const missingKeySession = createLocalCustodySession(input.runtime.depth)
  const unrelatedBackup = createLocalCustodyBackup({
    custodyId: input.custodyId,
    recoverySecret: input.recoverySecret,
    transactionDepth: input.runtime.depth,
  })
  missingKeySession.unlock({ custodyId: input.custodyId, recoverySecret: input.recoverySecret, backup: unrelatedBackup })
  const missingKeyAdmission = missingKeySession.admitForArchive(input.custodyId)
  await assert.rejects(
    readRecoveryArchiveCompleteSectionState({ ...readerInput, keyCustody: missingKeyAdmission }),
    (error: unknown) => error instanceof RecoveryArchiveReaderErrorClass && error.code === 'RECOVERY_ARCHIVE_READER_KEY_CUSTODY_FAILED',
  )
  missingKeySession.lock()
  await unchanged()

  await assert.rejects(
    createRecoveryArchiveFileStoreProvider({
      basePath: input.archivePath,
      storeId: randomUUID(),
      maxObjectBytes: 16 * 1024 * 1024,
      transactionDepth: input.runtime.depth,
    }),
    (error: unknown) => readCode(error) === 'RECOVERY_ARCHIVE_OBJECT_STORE_PROVIDER_FAILED',
  )
  await unchanged()

  const packagePath = join(input.custodyPath, `${input.custodyId}-${input.receipt.backupId}.custody`)
  const receiptStore = await createLocalCustodyStore({
    archivePath: input.archivePath,
    custodyPath: input.custodyPath,
    custodyId: input.custodyId,
    transactionDepth: input.runtime.depth,
  })
  await assert.rejects(receiptStore.readBackup({ ...input.receipt, sha256: '0'.repeat(64) }), /RECOVERY_LOCAL_CUSTODY_STORE_REFUSED/)
  await assert.rejects(receiptStore.readBackup({ ...input.receipt, size: input.receipt.size + 1 }), /RECOVERY_LOCAL_CUSTODY_STORE_REFUSED/)
  await unchanged()
  const packageBytes = await readFile(packagePath)
  const hiddenPackage = `${packagePath}.missing`
  await rename(packagePath, hiddenPackage)
  try {
    const store = await createLocalCustodyStore({
      archivePath: input.archivePath,
      custodyPath: input.custodyPath,
      custodyId: input.custodyId,
      transactionDepth: input.runtime.depth,
    })
    await assert.rejects(store.readBackup(input.receipt), /RECOVERY_LOCAL_CUSTODY_STORE_REFUSED/)
  } finally {
    await rename(hiddenPackage, packagePath)
  }
  await unchanged()

  const tamperedPackage = Buffer.from(packageBytes)
  tamperedPackage[tamperedPackage.length - 1] ^= 1
  await writeFile(packagePath, tamperedPackage, { mode: 0o600 })
  try {
    const store = await createLocalCustodyStore({
      archivePath: input.archivePath,
      custodyPath: input.custodyPath,
      custodyId: input.custodyId,
      transactionDepth: input.runtime.depth,
    })
    await assert.rejects(store.readBackup(input.receipt), /RECOVERY_LOCAL_CUSTODY_STORE_REFUSED/)
  } finally {
    await writeFile(packagePath, packageBytes, { mode: 0o600 })
  }
  await unchanged()

  const missingObject = authority.sectionObjects[0]
  assert.ok(missingObject)
  const objectPath = join(input.archivePath, `${missingObject.generationId}-${missingObject.objectId}.object`)
  const hiddenObject = `${objectPath}.missing`
  await rename(objectPath, hiddenObject)
  try {
    await assert.rejects(
      readRecoveryArchiveCompleteSectionState(readerInput),
      (error: unknown) => error instanceof RecoveryArchiveReaderErrorClass && error.code === 'RECOVERY_ARCHIVE_READER_OBJECT_STORE_FAILED',
    )
  } finally {
    await rename(hiddenObject, objectPath)
  }
  await unchanged()
}

async function loadAuthority(runtime: DatabaseRuntime, fixture: {
  workspaceId: string
  baseId: string
  sheetId: string
  generationId: string
}) {
  return loadRecoveryArchiveAuthorityInternal(runtime.transaction, authorityInput(fixture))
}

function authorityInput(fixture: { workspaceId: string; baseId: string; sheetId: string; generationId: string }) {
  return {
    workspaceId: fixture.workspaceId,
    baseId: fixture.baseId,
    sheetId: fixture.sheetId,
    generationId: fixture.generationId,
    recheckAuthority: async () => true,
  }
}

function createDatabaseRuntime(url: URL, applicationName: string): DatabaseRuntime {
  const pool = new PgPool({ connectionString: url.href, max: 4, application_name: applicationName, connectionTimeoutMillis: 1000 })
  let transactionDepth = 0
  async function connectTracked(): Promise<PoolClient> {
    const client = await pool.connect()
    let active = false, released = false
    return new Proxy(client, { get(target, property) {
      if (property === 'query') return async (input: string | QueryConfig, values?: unknown[]) => {
        const sql = typeof input === 'string' ? input : input.text
        const result = typeof input === 'string' ? await target.query(input, values) : await target.query(input)
        if (/^BEGIN\b/i.test(sql) && !active) { active = true; transactionDepth++ }
        if (/^(COMMIT|ROLLBACK)\b/i.test(sql) && active) { active = false; transactionDepth-- }
        return result
      }
      if (property === 'release') return (discard?: boolean) => {
        assert.equal(released, false, 'RECOVERY_LOCAL_BACKUP_DOUBLE_RELEASE')
        released = true
        const discardClient = discard === true || active
        if (active) { active = false; transactionDepth-- }
        target.release(discardClient)
      }
      const value: unknown = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  }
  const nativePool = { options: pool.options, connect: connectTracked as Pool['connect'] }
  const query: RecoveryArchiveRestoreJobQuery = async (text, values) => pool.query(text, values)
  const transaction: RecoveryArchiveRestoreJobTransaction = async (work) => {
    const client = await connectTracked()
    try {
      await client.query('BEGIN')
      const result = await work(async (text, values) => client.query(text, values))
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }
  return {
    pool,
    query,
    transaction,
    depth: { currentTransactionDepth: () => transactionDepth },
    nativePool,
  }
}

async function runManualTargetChild(input: {
  readonly databaseName: string
  readonly local: {
    readonly archivePath: string
    readonly custodyPath: string
    readonly custodyId: string
    readonly storeId: string
    readonly receipt: LocalCustodyReceipt
    readonly recoverySecret: Uint8Array
  }
  readonly identity: { readonly sheetId: string; readonly actorId: string }
  readonly password: string
  readonly generationId: string
  readonly recordId: string
  readonly recordIds: readonly string[]
  readonly fieldId: string
  readonly attachmentFieldId: string
  readonly attachmentId: string
  readonly attachmentBytes: Uint8Array
}, targetDatabaseUrl: URL): Promise<number> {
  assert.equal(input.local.archivePath.startsWith(`${args.workRoot}/target/`), true)
  assert.equal(input.local.custodyPath.startsWith(`${args.workRoot}/target/`), true)
  const child = fork(manualTargetPath, [], {
    execArgv: ['--require', require.resolve('tsx/cjs')],
    serialization: 'advanced',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: 'test',
      DATABASE_URL: targetDatabaseUrl.href,
      ATTACHMENT_PATH: targetAttachmentPath,
      JWT_SECRET: jwtSecret,
      MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true',
      MULTITABLE_ENABLE_WRITER_FENCE: 'true',
      MULTITABLE_HISTORY_CONTIGUITY_STRICT: 'true',
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  children.add(child)
  try {
    return await new Promise<number>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('RECOVERY_LOCAL_BACKUP_MANUAL_TARGET_TIMEOUT')), 600_000)
      const finish = (work: () => void) => {
        clearTimeout(timer)
        work()
      }
      child.once('error', () => finish(() => reject(new Error('RECOVERY_LOCAL_BACKUP_MANUAL_TARGET_SPAWN_FAILED'))))
      child.once('exit', () => finish(() => reject(new Error('RECOVERY_LOCAL_BACKUP_MANUAL_TARGET_EXITED_WITHOUT_RESULT'))))
      child.on('message', (message: { kind?: string; code?: string; frames?: string[]; rollbackTableCount?: number }) => {
        if (message.kind === 'manual-target-done') {
          finish(() => Number.isSafeInteger(message.rollbackTableCount) && (message.rollbackTableCount ?? 0) >= 6
            ? resolvePromise(message.rollbackTableCount!)
            : reject(new Error('RECOVERY_LOCAL_ROLLBACK_RESULT_INVALID')))
        }
        else if (message.kind === 'manual-target-error') {
          if (message.frames?.length) console.log(JSON.stringify({ phase: 'manual-target', frames: message.frames }))
          finish(() => reject(new Error(message.code ?? 'RECOVERY_LOCAL_BACKUP_MANUAL_TARGET_FAILED')))
        }
      })
      child.send(input, (error) => {
        if (error) finish(() => reject(new Error('RECOVERY_LOCAL_BACKUP_MANUAL_TARGET_SEND_FAILED')))
      })
    })
  } finally {
    try {
      await waitForChildExit(child)
      children.delete(child)
    } finally {
      input.local.recoverySecret.fill(0)
    }
  }
}

async function runWorker(
  input: Omit<ArchiveProcessWorkerInput, 'applicationName'>,
  targetDatabaseUrl: URL,
): Promise<ArchiveProcessWorkerMessage> {
  assert.equal(input.local?.archivePath.startsWith(`${args.workRoot}/target/`), true)
  assert.equal(input.local?.custodyPath.startsWith(`${args.workRoot}/target/`), true)
  const applicationName = `${prefix}_worker_${randomUUID().replaceAll('-', '')}`
  const child = fork(workerPath, [], {
    execArgv: ['--require', require.resolve('tsx/cjs')],
    serialization: 'advanced',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      NODE_ENV: 'test',
      DATABASE_URL: targetDatabaseUrl.href,
      JWT_SECRET: jwtSecret,
      METASHEET_REAL_DB_TEST_STEP: '1',
      METASHEET_ARCHIVE_PROCESS_FIXTURE: '1',
      MULTITABLE_RECOVERY_ARCHIVE_ENABLED: 'true',
      MULTITABLE_ENABLE_WRITER_FENCE: 'true',
      MULTITABLE_HISTORY_CONTIGUITY_STRICT: 'true',
    },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  children.add(child)
  try {
    return await new Promise<ArchiveProcessWorkerMessage>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error('RECOVERY_LOCAL_BACKUP_WORKER_TIMEOUT')), 180_000)
      const finish = (work: () => void) => {
        clearTimeout(timer)
        work()
      }
      child.once('error', () => finish(() => reject(new Error('RECOVERY_LOCAL_BACKUP_WORKER_SPAWN_FAILED'))))
      child.once('exit', () => finish(() => reject(new Error('RECOVERY_LOCAL_BACKUP_WORKER_EXITED_WITHOUT_RESULT'))))
      child.on('message', (message: ArchiveProcessWorkerMessage) => {
        if (message.kind === 'read-object') {
          finish(() => reject(new Error('RECOVERY_LOCAL_BACKUP_PARENT_OBJECT_RPC_REFUSED')))
        } else if (message.kind === 'error') {
          if (/^(?:RECOVERY_ARCHIVE_[A-Z_]+|archive_process_[a-z_]+)$/.test(message.code)) {
            console.log(JSON.stringify({ phase: input.phase, workerCode: message.code }))
          }
          finish(() => reject(new Error(message.code)))
        } else {
          finish(() => resolvePromise(message))
        }
      })
      child.send({ ...input, applicationName }, (error) => {
        if (error) finish(() => reject(new Error('RECOVERY_LOCAL_BACKUP_WORKER_SEND_FAILED')))
      })
    })
  } finally {
    await waitForChildExit(child)
    children.delete(child)
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  await waitForChildExit(child)
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolvePromise, reject) => {
      const onExit = () => { clearTimeout(timer); resolvePromise() }
      const timer = setTimeout(() => {
        child.removeListener('exit', onExit)
        reject(new Error('RECOVERY_LOCAL_BACKUP_WORKER_STOP_FAILED'))
      }, 10_000)
      child.once('exit', onExit)
    })
  }
  assert.deepEqual({ code: child.exitCode, signal: child.signalCode }, { code: 0, signal: null }, 'RECOVERY_LOCAL_BACKUP_WORKER_STOP_FAILED')
}

function runChecked(
  command: string,
  commandArgs: readonly string[],
  env: NodeJS.ProcessEnv,
  errorCode: string,
  timeout: number,
): void {
  const result = spawnSync(command, [...commandArgs], {
    cwd: repo,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  })
  if (result.status !== 0) throw new Error(errorCode)
}

async function createOwnedDatabase(admin: Pool, name: string, owner: string): Promise<void> {
  assert.ok(name === names.source || name === names.target, 'RECOVERY_LOCAL_BACKUP_DATABASE_NAME_REFUSED')
  assert.equal(ownedDatabases.has(name), false, 'RECOVERY_LOCAL_BACKUP_DATABASE_ALREADY_REGISTERED')
  const cluster = await admin.query<{ system_identifier: string }>('SELECT system_identifier::text FROM pg_control_system()')
  assert.equal(cluster.rows.length, 1, 'RECOVERY_LOCAL_BACKUP_CLUSTER_IDENTITY_REFUSED')
  await admin.query(`CREATE DATABASE ${quoteIdentifier(name)} OWNER ${quoteIdentifier(owner)}`)
  if (name === names.source) sourceCreated = true
  if (name === names.target) targetCreated = true
  const identity = await admin.query<OwnedDatabaseIdentity>(
    `SELECT d.datname AS name,d.oid::text AS oid,pg_catalog.pg_get_userbyid(d.datdba) AS owner,
      c.system_identifier::text AS system_identifier
      FROM pg_catalog.pg_database d CROSS JOIN pg_control_system() c WHERE d.datname=$1`, [name],
  )
  const row = identity.rows[0]
  if (identity.rows.length !== 1 || !row || row.name !== name || row.owner !== owner || row.system_identifier !== cluster.rows[0]!.system_identifier) throw new Error('RECOVERY_LOCAL_BACKUP_DATABASE_IDENTITY_REFUSED')
  ownedDatabases.set(name, row)
  await admin.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(name)} FROM PUBLIC`)
}

async function dropOwnedDatabase(admin: Pool, name: string): Promise<void> {
  const registered = ownedDatabases.get(name)
  assert.ok(registered && (name === names.source || name === names.target), 'RECOVERY_LOCAL_BACKUP_DATABASE_IDENTITY_REFUSED')
  const identity = await admin.query<OwnedDatabaseIdentity>(
    `SELECT d.datname AS name,d.oid::text AS oid,pg_catalog.pg_get_userbyid(d.datdba) AS owner,
      c.system_identifier::text AS system_identifier
      FROM pg_catalog.pg_database d CROSS JOIN pg_control_system() c WHERE d.datname=$1`, [name],
  )
  assert.deepEqual(identity.rows, [registered], 'RECOVERY_LOCAL_BACKUP_DATABASE_IDENTITY_REFUSED')
  await assertBackendCount(admin, name, 0)
  await admin.query(`DROP DATABASE ${quoteIdentifier(name)}`)
  assert.deepEqual((await admin.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname=$1', [name])).rows, [], 'RECOVERY_LOCAL_BACKUP_DATABASE_DROP_UNCONFIRMED')
  ownedDatabases.delete(name)
}

async function assertDatabaseOwner(admin: Pool, name: string, owner: string): Promise<void> {
  const result = await admin.query(
    `SELECT pg_catalog.pg_get_userbyid(datdba) AS owner,
            datallowconn,
            pg_catalog.has_database_privilege('public', datname, 'CONNECT') AS public_connect
       FROM pg_catalog.pg_database WHERE datname=$1`,
    [name],
  )
  assert.deepEqual(result.rows, [{ owner, datallowconn: true, public_connect: false }])
}

async function databaseIdentity(query: RecoveryArchiveRestoreJobQuery): Promise<{ name: string; oid: string }> {
  const result = await query(
    `SELECT current_database() AS name, oid::text
       FROM pg_catalog.pg_database WHERE datname=current_database()`,
  )
  const row = result.rows[0] as { name?: unknown; oid?: unknown } | undefined
  assert.equal(typeof row?.name, 'string')
  assert.equal(typeof row?.oid, 'string')
  return { name: row.name as string, oid: row.oid as string }
}

async function readNonceTuples(query: RecoveryArchiveRestoreJobQuery, generationId: string): Promise<NonceTuple[]> {
  const result = await query(
    `SELECT dek_fingerprint, nonce, generation_id::text, section_name, aead_algorithm, format_version
       FROM public.meta_recovery_archive_nonce_reservations
      WHERE generation_id=$1::uuid
      ORDER BY section_name`,
    [generationId],
  )
  return result.rows as NonceTuple[]
}

async function readLiveRows(query: RecoveryArchiveRestoreJobQuery, sheetId: string): Promise<LiveRow[]> {
  const result = await query(
    `SELECT id, data, version FROM public.meta_records WHERE sheet_id=$1 ORDER BY id`,
    [sheetId],
  )
  return result.rows as LiveRow[]
}

function assertExactLiveRows(
  rows: readonly LiveRow[],
  recordIds: readonly string[],
  fieldId: string,
  valuePrefix: 'live' | 'archived',
  version: number,
): void {
  assert.equal(rows.length, recordIds.length)
  for (let index = 0; index < recordIds.length; index += 1) {
    assert.deepEqual(rows[index], {
      id: recordIds[index],
      data: { [fieldId]: `${valuePrefix}-${String(index).padStart(5, '0')}` },
      version,
    })
  }
}

function hashRows(rows: readonly LiveRow[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}

async function exactOnceRecordCount(query: RecoveryArchiveRestoreJobQuery, sheetId: string): Promise<number> {
  const result = await query(
    `SELECT count(*)::int AS count
       FROM (
         SELECT record_id
           FROM public.meta_record_revisions
          WHERE sheet_id=$1 AND source='restore'
          GROUP BY record_id
         HAVING count(*)=1
       ) exact_once`,
    [sheetId],
  )
  return (result.rows[0] as { count: number }).count
}

async function assertReceiptRetained(
  sourceCustody: string,
  targetCustody: string,
  custodyId: string,
  receipt: LocalCustodyReceipt,
): Promise<void> {
  const filename = `${custodyId}-${receipt.backupId}.custody`
  const source = await readFile(join(sourceCustody, filename))
  const target = await readFile(join(targetCustody, filename))
  assert.equal(source.length, receipt.size)
  assert.equal(createHash('sha256').update(source).digest('hex'), receipt.sha256)
  assert.deepEqual(target, source)
}

async function assertSourceUnavailable(
  admin: Pool,
  sourceDatabaseUrl: URL,
  sourceDatabaseName: string,
  sourceArchive: string,
  sourceCustody: string,
): Promise<void> {
  assert.equal(await databaseCount(admin, [sourceDatabaseName]), 0)
  for (const path of [sourceArchive, sourceCustody]) await assertPathMissing(path)
  const sourceProbe = new PgPool({ connectionString: sourceDatabaseUrl.href, max: 1, connectionTimeoutMillis: 1_000 })
  try {
    await assert.rejects(
      sourceProbe.query('SELECT 1'),
      (error: unknown) => readCode(error) === '3D000',
    )
  } finally {
    await sourceProbe.end().catch(() => {})
  }
}

async function userTableCount(query: RecoveryArchiveRestoreJobQuery): Promise<number> {
  const result = await query(
    `SELECT count(*)::int AS count
       FROM pg_catalog.pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
  )
  return (result.rows[0] as { count: number }).count
}

async function databaseCount(admin: Pool, databaseNames: readonly string[]): Promise<number> {
  const result = await admin.query(
    'SELECT count(*)::int AS count FROM pg_catalog.pg_database WHERE datname=ANY($1::text[])',
    [databaseNames],
  )
  return (result.rows[0] as { count: number }).count
}

async function backendCount(admin: Pool, databaseNames: readonly string[]): Promise<number> {
  const result = await admin.query(
    'SELECT count(*)::int AS count FROM pg_catalog.pg_stat_activity WHERE datname=ANY($1::text[])',
    [databaseNames],
  )
  return (result.rows[0] as { count: number }).count
}

async function assertBackendCount(admin: Pool, databaseName: string, expected: number): Promise<void> {
  assert.equal(await backendCount(admin, [databaseName]), expected, 'RECOVERY_LOCAL_BACKUP_BACKEND_RESIDUE')
}

async function existingPathCount(paths: readonly string[]): Promise<number> {
  let count = 0
  for (const path of paths) {
    try {
      await lstat(path)
      count += 1
    } catch (error) {
      if (readCode(error) !== 'ENOENT') throw error
    }
  }
  return count
}

async function assertPathMissing(path: string): Promise<void> {
  await assert.rejects(access(path, constants.F_OK), (error: unknown) => readCode(error) === 'ENOENT')
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error('RECOVERY_LOCAL_BACKUP_DATABASE_NAME_REFUSED')
  return `"${value}"`
}

function readCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

try {
  console.log(JSON.stringify(await main()))
} catch (error) {
  const code = error instanceof Error && /^RECOVERY_[A-Z0-9_]+$/.test(error.message)
    ? error.message : 'RECOVERY_LOCAL_BACKUP_ACCEPTANCE_FAILED'
  const line = error instanceof Error ? error.stack?.match(/verify-recovery-local-backup\.mts:(\d+):/)?.[1] : undefined
  const sqlState = error && typeof error === 'object' && 'code' in error
    && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : undefined
  const frames = error instanceof Error ? [...(error.stack ?? '').matchAll(/\/((?:recovery-[a-z-]+|verify-recovery-local-manual-http)\.ts):(\d+):/g)]
    .map((match) => `${match[1]}:${match[2]}`) : []
  console.error(JSON.stringify({ result: 'FAIL', code, line, sqlState, frames }))
  process.exitCode = 1
}
