import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createRecoveryArchiveWorkerCallbacks } from '../routes/univer-meta'
import type { RecoveryArchiveApplicationComposition, RecoveryArchiveApplicationDatabaseRuntime } from './recovery-archive-application'
import { createRecoveryArchiveFileStoreProvider } from './recovery-archive-file-store'
import { isRecoveryArchiveRestoreWorkerEnabled } from './recovery-archive-restore-worker'
import { createLocalCustodySession } from './recovery-local-custody'
import { createLocalCustodyStore, type LocalCustodyReceipt } from './recovery-local-custody-store'
import { snapshotRecoveryArchiveManualPolicy, type RecoveryArchiveManualAdmissionPolicy } from './recovery-archive-manual-admission'

export interface RecoveryLocalStartupConfig {
  archivePath: string
  custodyPath: string
  custodyId: string
  storeId: string
  maxObjectBytes: number
  receipt: LocalCustodyReceipt
  auditedReplayHorizonMs: number
  asyncResumeHorizonMs: number
  workerIntervalMs: number
  leaseMs: number
  replayHorizonMs: number
  sweepLimit: number
  maxChunksPerRun: number
  manualCapture?: RecoveryArchiveManualAdmissionPolicy
}

const REFUSED = 'RECOVERY_LOCAL_STARTUP_REFUSED'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const CONFIG_KEYS = ['archivePath', 'custodyPath', 'custodyId', 'storeId', 'maxObjectBytes', 'receipt',
  'auditedReplayHorizonMs', 'asyncResumeHorizonMs', 'workerIntervalMs', 'leaseMs',
  'replayHorizonMs', 'sweepLimit', 'maxChunksPerRun'].sort()
function refuse(): never { throw new Error(REFUSED) }
function closed(value: unknown, keys: string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(','))
}

export function parseRecoveryLocalStartupConfig(value: unknown): Readonly<RecoveryLocalStartupConfig> {
  const withManual = Boolean(value && typeof value === 'object' && Object.hasOwn(value, 'manualCapture'))
  if (!closed(value, withManual ? [...CONFIG_KEYS, 'manualCapture'] : CONFIG_KEYS)) refuse()
  let manualCapture: Readonly<RecoveryArchiveManualAdmissionPolicy> | undefined
  if (withManual) {
    try { manualCapture = snapshotRecoveryArchiveManualPolicy(value.manualCapture as RecoveryArchiveManualAdmissionPolicy) }
    catch { refuse() }
  }
  for (const key of ['archivePath', 'custodyPath'] as const) {
    if (typeof value[key] !== 'string' || !path.isAbsolute(value[key])) refuse()
  }
  for (const key of ['custodyId', 'storeId'] as const) {
    if (typeof value[key] !== 'string' || !UUID.test(value[key])) refuse()
  }
  for (const key of ['maxObjectBytes', 'auditedReplayHorizonMs', 'asyncResumeHorizonMs', 'workerIntervalMs',
    'leaseMs', 'replayHorizonMs', 'sweepLimit', 'maxChunksPerRun'] as const) {
    const minimum = key === 'auditedReplayHorizonMs' || key === 'replayHorizonMs' ? 0 : 1
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < minimum) refuse()
  }
  if ((value.workerIntervalMs as number) > 2_147_483_647) refuse()
  if (!closed(value.receipt, ['backupId', 'sha256', 'size'])
    || typeof value.receipt.backupId !== 'string' || !UUID.test(value.receipt.backupId)
    || typeof value.receipt.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.receipt.sha256)
    || !Number.isSafeInteger(value.receipt.size) || (value.receipt.size as number) < 1
    || (value.receipt.size as number) > 16_384) refuse()
  return Object.freeze({ ...value, receipt: Object.freeze({ ...value.receipt }),
    ...(manualCapture ? { manualCapture } : {}) }) as unknown as Readonly<RecoveryLocalStartupConfig>
}

/** Operator-owned, nonsecret configuration; never provisions or repairs storage. */
export async function readRecoveryLocalStartupConfig(filename: string): Promise<Readonly<RecoveryLocalStartupConfig>> {
  try {
    if (!path.isAbsolute(filename) || !process.getuid) refuse()
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0
        || stat.size < 1 || stat.size > 8192) refuse()
      const bytes = Buffer.alloc(8193)
      let length = 0
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length !== stat.size || length > 8192) refuse()
      return parseRecoveryLocalStartupConfig(JSON.parse(bytes.subarray(0, length).toString('utf8')))
    } finally { await handle.close() }
  } catch { refuse() }
}

/** One attempt per launcher. Until it returns, no archive router or worker may be constructed. */
export async function prepareRecoveryLocalStartup(input: {
  env: Readonly<Record<string, string | undefined>>
  configPath: string
  signal: AbortSignal
  readSecret: (signal: AbortSignal) => Promise<Buffer>
  resolveDatabase: () => RecoveryArchiveApplicationDatabaseRuntime
  resolveAttachmentStorage: () => NonNullable<RecoveryArchiveApplicationComposition['attachmentStorage']>
}): Promise<Readonly<{
  composition: RecoveryArchiveApplicationComposition
  releaseCustody: () => void
}> | undefined> {
  if (!isRecoveryArchiveRestoreWorkerEnabled(input.env)) return undefined
  let session: ReturnType<typeof createLocalCustodySession> | undefined
  let secret: Buffer | undefined
  const check = () => { if (input.signal.aborted) refuse() }
  try {
    check()
    const config = await readRecoveryLocalStartupConfig(input.configPath)
    check()
    const database = input.resolveDatabase()
    const transactionDepth = database.transactionDepthProbe
    session = createLocalCustodySession(transactionDepth)
    const store = await createLocalCustodyStore({ ...config, transactionDepth })
    const objectStore = await createRecoveryArchiveFileStoreProvider({
      basePath: config.archivePath, storeId: config.storeId,
      maxObjectBytes: config.maxObjectBytes, transactionDepth,
    })
    check()
    secret = await input.readSecret(input.signal)
    check()
    if (!Buffer.isBuffer(secret) || secret.length !== 32) refuse()
    // Re-read after the operator wait: revalidate root identities and the immutable receipt.
    const backup = await store.readBackup(config.receipt)
    check()
    session.unlock({ custodyId: config.custodyId, backup, recoverySecret: secret })
    const keyCustody = session.admitForArchive(config.custodyId)
    const attachmentStorage = input.resolveAttachmentStorage()
    check()
    const composition: RecoveryArchiveApplicationComposition = Object.freeze({
      keyCustody, objectStore, attachmentStorage,
      auditedReplayHorizonMs: config.auditedReplayHorizonMs,
      asyncResumeHorizonMs: config.asyncResumeHorizonMs,
      workerIntervalMs: config.workerIntervalMs,
      ...(config.manualCapture ? { manualCapture: config.manualCapture } : {}),
      worker: Object.freeze({
        ...createRecoveryArchiveWorkerCallbacks(database),
        leaseMs: config.leaseMs, replayHorizonMs: config.replayHorizonMs,
        sweepLimit: config.sweepLimit, maxChunksPerRun: config.maxChunksPerRun,
        workerOwnerId: `local-${randomUUID()}`,
      }),
    })
    const ownedSession = session
    return Object.freeze({ composition, releaseCustody: () => ownedSession.lock() })
  } catch {
    session?.lock()
    refuse()
  } finally {
    if (Buffer.isBuffer(secret)) secret.fill(0)
  }
}
