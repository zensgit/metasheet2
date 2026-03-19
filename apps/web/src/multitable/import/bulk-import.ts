import type { MultitableApiClient } from '../api/client'

export type BulkImportResult = {
  succeeded: number
  failed: number
  firstError: string | null
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
  const failed = settled.filter((item) => item.status === 'rejected')
  const firstError = failed[0] && failed[0].status === 'rejected'
    ? failed[0].reason?.message ?? String(failed[0].reason)
    : null
  return {
    succeeded: settled.length - failed.length,
    failed: failed.length,
    firstError,
  }
}
