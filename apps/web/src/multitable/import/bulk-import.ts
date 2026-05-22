import type { MultitableApiClient } from '../api/client'
import { duplicateRowSkipped, importCancelled } from '../utils/meta-import-labels'

export type BulkImportFailure = {
  index: number
  message: string
  status?: number
  code?: string
  retryable: boolean
}

export type BulkImportResult = {
  attempted: number
  succeeded: number
  failed: number
  firstError: string | null
  failures: BulkImportFailure[]
}

export type BulkImportSkippedRow = {
  index: number
  rowIndex: number
  fieldId: string
  key: string
  message: string
  skipped: true
}

type BulkImportError = {
  message?: string
  status?: number
  code?: string
  retryAfterMs?: number
}

const DEFAULT_CONCURRENCY = 10
const DEFAULT_MAX_RETRY_ATTEMPTS = 1
const DEFAULT_RETRY_BASE_DELAY_MS = 500
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000

function createAbortError(isZh = false) {
  const error = new Error(importCancelled(isZh)) as Error & { name: string }
  error.name = 'AbortError'
  return error
}

function ensureNotAborted(signal?: AbortSignal, isZh = false) {
  if (signal?.aborted) throw createAbortError(isZh)
}

function sleep(ms: number, signal?: AbortSignal, isZh = false): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError(isZh))
  }
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      globalThis.clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(createAbortError(isZh))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function applyRetryJitter(delayMs: number) {
  const ratio = 0.5 + Math.random()
  return Math.max(0, Math.round(delayMs * ratio))
}

function normalizeDuplicateKey(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized || null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim().toLowerCase()
  }
  return null
}

function isRetryableError(error: unknown) {
  if (typeof error === 'object' && error && 'name' in error && (error as { name?: string }).name === 'AbortError') {
    return false
  }
  const status = typeof error === 'object' && error && 'status' in error ? (error as { status?: number }).status : undefined
  return status === undefined || status >= 500 || status === 409 || status === 429
}

function isAbortError(error: unknown) {
  return typeof error === 'object' && error && 'name' in error && (error as { name?: string }).name === 'AbortError'
}

function retryDelayMs(params: {
  error: unknown
  attempt: number
  retryBaseDelayMs: number
  maxRetryDelayMs: number
  jitterFn: (delayMs: number) => number
}) {
  const { error, attempt, retryBaseDelayMs, maxRetryDelayMs, jitterFn } = params
  const retryAfterMs = typeof error === 'object' && error && 'retryAfterMs' in error
    ? (error as { retryAfterMs?: number }).retryAfterMs
    : undefined
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0) {
    return Math.min(retryAfterMs, maxRetryDelayMs)
  }
  return Math.min(jitterFn(retryBaseDelayMs * (2 ** attempt)), maxRetryDelayMs)
}

async function createRecordWithRetry(params: {
  client: MultitableApiClient
  sheetId?: string
  viewId?: string
  data: Record<string, unknown>
  maxRetryAttempts: number
  retryBaseDelayMs: number
  maxRetryDelayMs: number
  sleepFn: (ms: number) => Promise<void>
  jitterFn: (delayMs: number) => number
  signal?: AbortSignal
  isZh?: boolean
}) {
  const { client, sheetId, viewId, data, maxRetryAttempts, retryBaseDelayMs, maxRetryDelayMs, sleepFn, jitterFn, signal, isZh = false } = params
  let attempt = 0
  while (true) {
    try {
      ensureNotAborted(signal, isZh)
      return await client.createRecord({ sheetId, viewId, data }, { signal })
    } catch (error) {
      if (!isRetryableError(error) || attempt >= maxRetryAttempts) {
        throw error
      }
      ensureNotAborted(signal, isZh)
      await sleepFn(retryDelayMs({ error, attempt, retryBaseDelayMs, maxRetryDelayMs, jitterFn }))
      ensureNotAborted(signal, isZh)
      attempt += 1
    }
  }
}

export function skipDuplicateImportRows(params: {
  records: Array<Record<string, unknown>>
  rowIndexes: number[]
  primaryFieldId: string
  primaryFieldName?: string
  existingKeys?: Iterable<string>
  isZh?: boolean
}) {
  const {
    records,
    rowIndexes,
    primaryFieldId,
    primaryFieldName = primaryFieldId,
    existingKeys = [],
    isZh = false,
  } = params

  const keptRecords: Array<Record<string, unknown>> = []
  const keptRowIndexes: number[] = []
  const skippedRows: BulkImportSkippedRow[] = []
  const seenKeys = new Set<string>()

  for (const existingKey of existingKeys) {
    const normalized = normalizeDuplicateKey(existingKey)
    if (normalized) seenKeys.add(normalized)
  }

  records.forEach((record, index) => {
    const rowIndex = rowIndexes[index] ?? index
    const rawKey = record[primaryFieldId]
    const normalizedKey = normalizeDuplicateKey(rawKey)
    if (!normalizedKey) {
      keptRecords.push(record)
      keptRowIndexes.push(rowIndex)
      return
    }
    if (seenKeys.has(normalizedKey)) {
      skippedRows.push({
        index,
        rowIndex,
        fieldId: primaryFieldId,
        key: normalizedKey,
        skipped: true,
        message: duplicateRowSkipped(primaryFieldName, rawKey, isZh),
      })
      return
    }
    seenKeys.add(normalizedKey)
    keptRecords.push(record)
    keptRowIndexes.push(rowIndex)
  })

  return {
    records: keptRecords,
    rowIndexes: keptRowIndexes,
    skippedRows,
  }
}

export async function bulkImportRecords(params: {
  client: MultitableApiClient
  sheetId?: string
  viewId?: string
  records: Array<Record<string, unknown>>
  concurrency?: number
  maxRetryAttempts?: number
  retryBaseDelayMs?: number
  maxRetryDelayMs?: number
  sleepFn?: (ms: number) => Promise<void>
  jitterFn?: (delayMs: number) => number
  signal?: AbortSignal
  isZh?: boolean
}): Promise<BulkImportResult> {
  const {
    client,
    sheetId,
    viewId,
    records,
    concurrency = DEFAULT_CONCURRENCY,
    maxRetryAttempts = DEFAULT_MAX_RETRY_ATTEMPTS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
    sleepFn = (ms) => sleep(ms, params.signal, params.isZh ?? false),
    jitterFn = applyRetryJitter,
    signal,
    isZh = false,
  } = params
  const settled: PromiseSettledResult<unknown>[] = []
  const chunkSize = Math.max(1, Math.floor(concurrency))
  for (let offset = 0; offset < records.length; offset += chunkSize) {
    ensureNotAborted(signal, isZh)
    const chunk = records.slice(offset, offset + chunkSize)
    const chunkSettled = await Promise.allSettled(
      chunk.map((data) => createRecordWithRetry({
        client,
        sheetId,
        viewId,
        data,
        maxRetryAttempts,
        retryBaseDelayMs,
        maxRetryDelayMs,
        sleepFn,
        jitterFn,
        signal,
        isZh,
      })),
    )
    if (signal?.aborted || chunkSettled.some((item) => item.status === 'rejected' && isAbortError(item.reason))) {
      throw createAbortError(isZh)
    }
    settled.push(...chunkSettled)
  }
  const failures = settled.flatMap((item, index) => {
    if (item.status !== 'rejected') return []
    const reason = item.reason as BulkImportError | undefined
    return [{
      index,
      message: reason?.message ?? String(item.reason),
      status: reason?.status,
      code: reason?.code,
      retryable: isRetryableError(item.reason),
    }]
  })
  const firstError = failures[0] ? failures[0].message : null
  return {
    attempted: settled.length,
    succeeded: settled.length - failures.length,
    failed: failures.length,
    firstError,
    failures,
  }
}
