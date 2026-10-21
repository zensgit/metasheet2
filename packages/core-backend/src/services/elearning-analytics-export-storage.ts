import { createHash } from 'node:crypto'
import * as path from 'node:path'

import { StorageServiceImpl } from './StorageService'

export const ELEARNING_ANALYTICS_EXPORT_STORAGE_PREFIX = 'elearning-analytics-exports/' as const

export interface ElearningAnalyticsExportStorage {
  put(storageKey: string, content: Buffer): Promise<void>
  get(storageKey: string): Promise<Buffer>
  delete(storageKey: string): Promise<void>
}

export class ElearningAnalyticsExportStorageError extends Error {
  readonly code = 'unavailable'

  constructor() {
    super('unavailable')
    this.name = 'ElearningAnalyticsExportStorageError'
  }
}

function unavailable(): never {
  throw new ElearningAnalyticsExportStorageError()
}

function requireStorageKey(storageKey: string): string {
  if (
    typeof storageKey !== 'string'
    || !storageKey.startsWith(ELEARNING_ANALYTICS_EXPORT_STORAGE_PREFIX)
    || storageKey.includes('\0')
    || storageKey.includes('..')
  ) unavailable()
  return storageKey
}

export function deriveElearningAnalyticsExportStorageKey(input: {
  orgId: string
  exportId: string
}): string {
  const orgDigest = createHash('sha256').update(input.orgId, 'utf8').digest('hex').slice(0, 32)
  return `${ELEARNING_ANALYTICS_EXPORT_STORAGE_PREFIX}${orgDigest}/${input.exportId}.csv`
}

const unavailableStorages = new WeakSet<ElearningAnalyticsExportStorage>()

function unavailableStorage(): ElearningAnalyticsExportStorage {
  const storage: ElearningAnalyticsExportStorage = {
    put: async () => unavailable(),
    get: async () => unavailable(),
    delete: async () => unavailable(),
  }
  unavailableStorages.add(storage)
  return storage
}

/**
 * Phase A deliberately has no external object-store adapter, so a production
 * process has no export storage at all. This is the single predicate shared by
 * the storage factory and the availability read below.
 */
function hasNoExportStorageAdapter(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'production'
}

let processStorage: ElearningAnalyticsExportStorage | null = null

/**
 * Phase A deliberately has no external object-store adapter. Production fails
 * closed; development and tests use the existing contained local provider.
 */
export function getElearningAnalyticsExportStorage(
  env: NodeJS.ProcessEnv = process.env,
): ElearningAnalyticsExportStorage {
  if (processStorage) return processStorage
  if (hasNoExportStorageAdapter(env)) {
    processStorage = unavailableStorage()
    return processStorage
  }
  const service = StorageServiceImpl.createLocalService(
    path.resolve(process.cwd(), 'storage'),
  )
  processStorage = {
    async put(storageKey, content) {
      try {
        await service.uploadByKey(requireStorageKey(storageKey), content, 'text/csv; charset=utf-8')
      } catch {
        unavailable()
      }
    },
    async get(storageKey) {
      try {
        return await service.downloadByKey(requireStorageKey(storageKey))
      } catch {
        unavailable()
      }
    },
    async delete(storageKey) {
      try {
        await service.deleteByKey(requireStorageKey(storageKey))
      } catch {
        unavailable()
      }
    },
  }
  return processStorage
}

/**
 * Whether getElearningAnalyticsExportStorage() would hand out a working store.
 * Side-effect free: it never creates the process singleton. Once the singleton
 * exists it is authoritative, so this cannot disagree with what the export
 * worker will actually use.
 */
export function isElearningAnalyticsExportStorageAvailable(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (processStorage) return !unavailableStorages.has(processStorage)
  return !hasNoExportStorageAdapter(env)
}

/** Test seam: production code never swaps the process singleton. */
export function setElearningAnalyticsExportStorageForTest(
  storage: ElearningAnalyticsExportStorage | null,
): void {
  processStorage = storage
}
