import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import {
  type AttendanceImportBatch,
  type AttendanceImportItem,
  useAttendanceAdminImportBatches,
} from '../src/views/attendance/useAttendanceAdminImportBatches'

const tr = (en: string, _zh: string) => en

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response
}

function textResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('not json')
    },
    text: async () => body,
  } as unknown as Response
}

function createBatch(overrides: Partial<AttendanceImportBatch> = {}): AttendanceImportBatch {
  return {
    id: 'batch-1',
    rowCount: 2,
    status: 'completed',
    meta: null,
    ...overrides,
  }
}

function createItem(overrides: Partial<AttendanceImportItem> = {}): AttendanceImportItem {
  return {
    id: 'item-1',
    batchId: 'batch-1',
    userId: 'user-1',
    workDate: '2026-03-11',
    recordId: 'record-1',
    previewSnapshot: null,
    ...overrides,
  }
}

describe('useAttendanceAdminImportBatches', () => {
  it('loads batches and items', async () => {
    const apiFetch = vi.fn(async (input: string) => {
      if (input === '/api/attendance/import/batches?orgId=org-1') {
        return jsonResponse(200, {
          ok: true,
          data: { items: [createBatch({ id: 'batch-a' })] },
        })
      }
      if (input === '/api/attendance/import/batches/batch-a/items') {
        return jsonResponse(200, {
          ok: true,
          data: { items: [createItem({ id: 'item-a', batchId: 'batch-a' })] },
        })
      }
      throw new Error(`Unexpected request: ${input}`)
    })
    const batches = useAttendanceAdminImportBatches({ apiFetch, tr })

    await batches.loadImportBatches({ orgId: 'org-1' })
    await batches.loadImportBatchItems('batch-a')

    expect(batches.importBatches.value.map((item) => item.id)).toEqual(['batch-a'])
    expect(batches.importBatchSelectedId.value).toBe('batch-a')
    expect(batches.importBatchItems.value.map((item) => item.id)).toEqual(['item-a'])
  })

  it('clears the selected batch details after rollback when that batch is open', async () => {
    const confirm = vi.fn(() => true)
    const apiFetch = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/attendance/import/batches?orgId=org-1') {
        return jsonResponse(200, {
          ok: true,
          data: { items: [createBatch({ id: 'batch-a' })] },
        })
      }
      if (url === '/api/attendance/import/batches/batch-a/items') {
        return jsonResponse(200, {
          ok: true,
          data: { items: [createItem({ id: 'item-a', batchId: 'batch-a', previewSnapshot: { foo: 'bar' } })] },
        })
      }
      if (url === '/api/attendance/import/rollback/batch-a' && init?.method === 'POST') {
        return jsonResponse(200, { ok: true, data: {} })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const batches = useAttendanceAdminImportBatches({ apiFetch, confirm, tr })

    await batches.loadImportBatches({ orgId: 'org-1' })
    await batches.loadImportBatchItems('batch-a')
    batches.toggleImportBatchSnapshot(batches.importBatchItems.value[0]!)

    await batches.rollbackImportBatch('batch-a')

    expect(confirm).toHaveBeenCalledWith('Rollback this import batch?')
    expect(batches.importBatchSelectedId.value).toBe('')
    expect(batches.importBatchItems.value).toEqual([])
    expect(batches.importBatchSnapshot.value).toBeNull()
    expect(batches.importStatusMessage.value).toBe('Import batch rolled back.')
  })

  it('exports CSV via the server endpoint first', async () => {
    const downloadCsv = vi.fn()
    const apiFetch = vi.fn(async (input: string) => {
      const url = String(input)
      if (url === '/api/attendance/import/batches/batch-a/export.csv?type=all') {
        return textResponse(200, 'batchId,itemId\nbatch-a,item-1')
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const batches = useAttendanceAdminImportBatches({
      apiFetch,
      clock: () => new Date('2026-03-12T00:00:00.000Z'),
      downloadCsv,
      tr,
    })
    batches.importBatchSelectedId.value = 'batch-a'

    await batches.exportImportBatchItemsCsv(false)

    expect(downloadCsv).toHaveBeenCalledWith(
      'attendance-import-batch-a-all-2026-03-12.csv',
      'batchId,itemId\nbatch-a,item-1',
    )
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(batches.importStatusMessage.value).toBe('CSV exported.')
  })

  it('falls back to paginated item fetch when the server export endpoint is unavailable', async () => {
    const downloadCsv = vi.fn()
    const apiFetch = vi.fn(async (input: string) => {
      const url = String(input)
      if (url === '/api/attendance/import/batches/batch-a/export.csv?type=anomalies') {
        return textResponse(404, 'missing')
      }
      if (url === '/api/attendance/import/batches/batch-a/items?page=1&pageSize=200') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              createItem({
                id: 'item-2',
                batchId: 'batch-a',
                userId: 'user-2',
                workDate: '2026-03-12',
                recordId: null,
                previewSnapshot: {
                  metrics: {
                    status: 'late',
                    workMinutes: 480,
                    lateMinutes: 15,
                  },
                  warnings: ['late arrival'],
                },
              }),
            ],
            total: 2,
          },
        })
      }
      if (url === '/api/attendance/import/batches/batch-a/items?page=2&pageSize=200') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              createItem({
                id: 'item-1',
                batchId: 'batch-a',
                userId: 'user-1',
                workDate: '2026-03-11',
                recordId: 'record-1',
                previewSnapshot: {
                  metrics: {
                    status: 'normal',
                    workMinutes: 480,
                  },
                },
              }),
            ],
            total: 2,
          },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const batches = useAttendanceAdminImportBatches({
      apiFetch,
      clock: () => new Date('2026-03-12T00:00:00.000Z'),
      downloadCsv,
      tr,
    })
    batches.importBatchSelectedId.value = 'batch-a'

    await batches.exportImportBatchItemsCsv(true)

    expect(downloadCsv).toHaveBeenCalledTimes(1)
    const [filename, csvText] = downloadCsv.mock.calls[0]!
    expect(filename).toBe('attendance-import-batch-a-anomalies-2026-03-12.csv')
    expect(csvText).toContain('batchId,itemId,workDate,userId,recordId,status,workMinutes,lateMinutes,earlyLeaveMinutes,leaveMinutes,overtimeMinutes,warnings')
    expect(csvText).toContain('batch-a,item-2,2026-03-12,user-2,,late,480,15,0,0,0,late arrival')
    expect(csvText).not.toContain('item-1')
    expect(batches.importStatusMessage.value).toBe('CSV exported (1/2).')
  })

  it('marks admin forbidden on 403 responses', async () => {
    const adminForbidden = ref(false)
    const apiFetch = vi.fn(async () => jsonResponse(403, {
      ok: false,
      error: { message: 'denied' },
    }))
    const batches = useAttendanceAdminImportBatches({ adminForbidden, apiFetch, tr })

    await batches.loadImportBatches({ orgId: 'org-1' })

    expect(adminForbidden.value).toBe(true)
  })
})
