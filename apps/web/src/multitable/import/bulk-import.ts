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

export async function bulkImportRecords(params: {
  client: MultitableApiClient
  sheetId?: string
  viewId?: string
  records: Array<Record<string, unknown>>
}): Promise<BulkImportResult> {
  const { client, sheetId, viewId, records } = params
  const settled = await Promise.allSettled(
    records.map((data) => client.createRecord({ sheetId, viewId, data })),
  )
  const isRetryableError = (error: unknown) => {
    const status = typeof error === 'object' && error && 'status' in error ? (error as { status?: number }).status : undefined
    return status === undefined || status >= 500 || status === 409 || status === 429
  }
  const failures = settled.flatMap((item, index) => {
    if (item.status !== 'rejected') return []
    const reason = item.reason as { message?: string; status?: number; code?: string } | undefined
    return [{
      index,
      message: reason?.message ?? String(item.reason),
      status: reason?.status,
      code: reason?.code,
      retryable: isRetryableError(item.reason),
    }]
  })
  const firstError = failures[0]
    ? failures[0].message
    : null
  return {
    attempted: settled.length,
    succeeded: settled.length - failures.length,
    failed: failures.length,
    firstError,
    failures,
  }
}
