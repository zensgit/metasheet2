import type { MultitableApiClient } from '../api/client'

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

function createAbortError() {
  const error = new Error('Import cancelled') as Error & { name: string }
  error.name = 'AbortError'
  return error
}

function ensureNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError()
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError())
  }
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      globalThis.clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(createAbortError())
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
}) {
  const { client, sheetId, viewId, data, maxRetryAttempts, retryBaseDelayMs, maxRetryDelayMs, sleepFn, jitterFn, signal } = params
  let attempt = 0
  while (true) {
    try {
      ensureNotAborted(signal)
      return await client.createRecord({ sheetId, viewId, data }, { signal })
    } catch (error) {
      if (!isRetryableError(error) || attempt >= maxRetryAttempts) {
        throw error
      }
      ensureNotAborted(signal)
      await sleepFn(retryDelayMs({ error, attempt, retryBaseDelayMs, maxRetryDelayMs, jitterFn }))
      ensureNotAborted(signal)
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
}) {
  const {
    records,
    rowIndexes,
    primaryFieldId,
    primaryFieldName = primaryFieldId,
    existingKeys = [],
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
        message: `Skipped duplicate row because ${primaryFieldName} already exists: ${String(rawKey).trim()}`,
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
    sleepFn = (ms) => sleep(ms, params.signal),
    jitterFn = applyRetryJitter,
    signal,
  } = params
  const settled: PromiseSettledResult<unknown>[] = []
  const chunkSize = Math.max(1, Math.floor(concurrency))
  for (let offset = 0; offset < records.length; offset += chunkSize) {
    ensureNotAborted(signal)
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
      })),
    )
    if (signal?.aborted || chunkSettled.some((item) => item.status === 'rejected' && isAbortError(item.reason))) {
      throw createAbortError()
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
