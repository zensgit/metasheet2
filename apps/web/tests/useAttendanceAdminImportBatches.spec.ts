import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import {
  buildImportBatchRollbackNotes,
  buildImportBatchRollbackConfirmationMessage,
  buildImportBatchRetryGuidance,
  buildImportBatchActionHints,
  classifyImportBatchItem,
  estimateImportBatchRollbackImpact,
  matchesImportBatchIssueFilter,
  resolveImportBatchSeverity,
  summarizeImportBatchIssueBuckets,
  summarizeImportBatchIssueClusters,
  type AttendanceImportBatch,
  summarizeImportBatchItems,
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
  it('keeps batch reads, exports and rollback in the batch organization', async () => {
    const batchOrg = 'qa-batch-org'
    const calls: Array<{ url: URL; init?: RequestInit }> = []
    const apiFetch = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://local.test')
      calls.push({ url, init })
      if (url.pathname === '/api/attendance/import/batches') {
        return jsonResponse(200, { ok: true, data: { items: [createBatch({ orgId: batchOrg })] } })
      }
      if (url.pathname === '/api/auth/me') return jsonResponse(200, {
        success: true, data: { user: { tenantId: batchOrg } },
      })
      // The real rollback route ignores body/query and uses the authenticated session.
      const requestedOrg = init?.method === 'POST' ? batchOrg : url.searchParams.get('orgId')
      if (requestedOrg !== batchOrg) return jsonResponse(404, { ok: false })
      if (url.pathname.endsWith('/export.csv')) return textResponse(200, 'batchId\nbatch-1\n')
      return jsonResponse(200, { ok: true, data: { items: [createItem()], total: 1 } })
    })
    const downloadCsv = vi.fn()
    const batches = useAttendanceAdminImportBatches({ apiFetch, tr, downloadCsv, confirm: () => true })
    await batches.loadImportBatches({ orgId: 'qa-selector-org' })
    await batches.loadImportBatchItems('batch-1')
    expect(batches.importBatchItems.value).toEqual([createItem()])
    await batches.loadFullImportBatchImpact('batch-1')
    expect(batches.importBatchImpactReport.value?.itemCount).toBe(1)
    await batches.exportImportBatchItemsCsv(false)
    expect(downloadCsv).toHaveBeenCalledOnce()
    await batches.rollbackImportBatch('batch-1', { orgId: 'qa-selector-org' })
    const scoped = calls.filter(({ url }) => url.pathname.startsWith('/api/attendance/import/')
      && url.pathname !== '/api/attendance/import/batches')
    expect(scoped).toHaveLength(4)
    for (const { url, init } of scoped) {
      if (init?.method === 'POST') expect(init.body).toBeUndefined()
      else expect(url.searchParams.get('orgId')).toBe(batchOrg)
    }
    expect(batches.importStatusMessage.value).toBe('Import batch rolled back.')
  })

  it.each([
    { name: 'different session', status: 200, payload: { success: true, data: { user: { tenantId: 'qa-other' } } } },
    { name: 'unknown session', status: 200, payload: { success: true, data: { user: {} } } },
    { name: 'expired session', status: 401, payload: { success: false } },
  ])('refuses rollback before POST for $name', async ({ status, payload }) => {
    const apiFetch = vi.fn(async (input: string) => {
      if (input === '/api/auth/me') return jsonResponse(status, payload)
      return jsonResponse(200, { ok: true, data: { items: [] } })
    })
    const batches = useAttendanceAdminImportBatches({ apiFetch, tr, confirm: () => true })
    batches.importBatches.value = [createBatch({ orgId: 'qa-batch' })]
    await batches.rollbackImportBatch('batch-1', { orgId: 'qa-other' })
    expect(apiFetch).toHaveBeenCalledOnce()
    expect(apiFetch).toHaveBeenCalledWith('/api/auth/me', { suppressUnauthorizedRedirect: true })
    expect(batches.importStatusKind.value).toBe('error')
    expect(batches.importStatusMessage.value).toBe('Switch to the batch organization before rollback.')
  })

  it('pins the export fallback organization across pages when the list selection changes', async () => {
    let batches: ReturnType<typeof useAttendanceAdminImportBatches>
    const pages: URL[] = []
    const downloadCsv = vi.fn()
    const apiFetch = vi.fn(async (input: string) => {
      const url = new URL(input, 'http://local.test')
      if (url.pathname === '/api/attendance/import/batches') {
        return jsonResponse(200, { ok: true, data: { items: [] } })
      }
      if (url.pathname.endsWith('/export.csv')) {
        expect(url.searchParams.get('orgId')).toBe('qa-first')
        return textResponse(404, '')
      }
      pages.push(url)
      if (pages.length === 1) await batches.loadImportBatches({ orgId: 'qa-second' })
      return jsonResponse(200, { ok: true, data: {
        items: [createItem({ id: `item-${pages.length}` })], total: 2,
      } })
    })
    batches = useAttendanceAdminImportBatches({ apiFetch, tr, downloadCsv, fallbackPageSize: 1 })
    await batches.loadImportBatches({ orgId: 'qa-first' })
    batches.importBatchSelectedId.value = 'batch-1'
    await batches.exportImportBatchItemsCsv(false)
    expect(pages.map(url => [url.searchParams.get('orgId'), url.searchParams.get('page')]))
      .toEqual([['qa-first', '1'], ['qa-first', '2']])
    expect(downloadCsv).toHaveBeenCalledOnce()
  })

  it('does not download or report success when the scoped batch request is denied', async () => {
    const apiFetch = vi.fn(async (_input: string) => jsonResponse(403, { ok: false }))
    const downloadCsv = vi.fn()
    const batches = useAttendanceAdminImportBatches({ apiFetch, tr, downloadCsv })
    batches.importBatches.value = [createBatch({ orgId: 'qa-denied' })]
    batches.importBatchSelectedId.value = 'batch-1'
    await batches.exportImportBatchItemsCsv(false)
    expect(apiFetch).toHaveBeenCalledOnce()
    expect(String(apiFetch.mock.calls[0]?.[0])).toContain('orgId=qa-denied')
    expect(downloadCsv).not.toHaveBeenCalled()
    expect(batches.importStatusKind.value).toBe('error')
  })

  it('classifies batch items and summarizes anomaly impact', () => {
    const items = [
      createItem({
        id: 'item-1',
        batchId: 'batch-a',
        recordId: 'record-1',
        previewSnapshot: {
          metrics: {
            status: 'normal',
            workMinutes: 480,
          },
        },
      }),
      createItem({
        id: 'item-2',
        batchId: 'batch-a',
        userId: 'user-2',
        recordId: null,
        previewSnapshot: {
          metrics: {
            status: 'late',
            workMinutes: 480,
            lateMinutes: 12,
          },
          warnings: ['late arrival'],
        },
      }),
    ]

    const summary = summarizeImportBatchItems(items)
    expect(summary).toMatchObject({
      totalItems: 2,
      anomalyItems: 1,
      warningItems: 1,
      missingRecordItems: 1,
      lateItems: 1,
      normalItems: 1,
    })
    expect(classifyImportBatchItem(items[1]!).isAnomaly).toBe(true)
    expect(classifyImportBatchItem(items[0]!).isAnomaly).toBe(false)
  })

  it('builds issue clusters, filters, and operator hints from batch items', () => {
    const items = [
      createItem({
        id: 'item-1',
        recordId: 'record-1',
        previewSnapshot: {
          metrics: {
            status: 'normal',
            workMinutes: 480,
          },
        },
      }),
      createItem({
        id: 'item-2',
        userId: 'user-2',
        recordId: null,
        previewSnapshot: {
          metrics: {
            status: 'late',
            workMinutes: 480,
            lateMinutes: 12,
          },
          warnings: ['late arrival'],
        },
      }),
    ]

    const warningAnalysis = classifyImportBatchItem(items[1]!)
    expect(resolveImportBatchSeverity(warningAnalysis)).toBe('critical')
    expect(matchesImportBatchIssueFilter(warningAnalysis, 'missingRecord')).toBe(true)
    expect(matchesImportBatchIssueFilter(warningAnalysis, 'warnings')).toBe(true)
    expect(matchesImportBatchIssueFilter(warningAnalysis, 'late')).toBe(true)
    expect(matchesImportBatchIssueFilter(warningAnalysis, 'clean')).toBe(false)

    expect(summarizeImportBatchIssueBuckets(items)).toEqual(
      expect.arrayContaining([
        { filter: 'all', count: 2 },
        { filter: 'anomalies', count: 1 },
        { filter: 'missingRecord', count: 1 },
        { filter: 'warnings', count: 1 },
        { filter: 'late', count: 1 },
        { filter: 'clean', count: 1 },
      ]),
    )
    expect(summarizeImportBatchIssueClusters(items)).toEqual(
      expect.arrayContaining([
        { key: 'missingRecord', count: 1, severity: 'critical' },
        { key: 'warnings', count: 1, severity: 'warning' },
        { key: 'late', count: 1, severity: 'review' },
      ]),
    )
    expect(buildImportBatchActionHints(summarizeImportBatchItems(items), tr)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('missing-record rows first'),
        expect.stringContaining('Export warnings'),
      ]),
    )
  })

  it('estimates rollback impact from loaded batch items', () => {
    const batch = createBatch({ id: 'batch-a', rowCount: 5 })
    const items = [
      createItem({
        id: 'item-1',
        batchId: 'batch-a',
        recordId: 'record-1',
        previewSnapshot: {
          metrics: {
            status: 'normal',
            workMinutes: 480,
          },
        },
      }),
      createItem({
        id: 'item-2',
        batchId: 'batch-a',
        userId: 'user-2',
        recordId: null,
        previewSnapshot: {
          metrics: {
            status: 'late',
            workMinutes: 420,
            lateMinutes: 18,
          },
          warnings: ['missing mapping'],
        },
      }),
    ]

    const estimate = estimateImportBatchRollbackImpact(batch, items)

    expect(estimate).toMatchObject({
      loadedItems: 2,
      totalBatchRows: 5,
      estimatedCommittedRows: 1,
      previewOnlyRows: 1,
      flaggedRows: 1,
      warningRows: 1,
      policyReviewRows: 1,
      isPartial: true,
      coveragePercent: 40,
    })
    expect(buildImportBatchRollbackNotes(estimate, tr)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Estimate is based on 2 of 5'),
        expect.stringContaining('do not show committed records yet'),
        expect.stringContaining('emitted warnings during preview'),
        expect.stringContaining('policy-sensitive'),
      ]),
    )
  })

  it('builds rollback confirmation details from an impact estimate', () => {
    const batch = createBatch({ id: 'batch-a', rowCount: 5 })
    const message = buildImportBatchRollbackConfirmationMessage(
      batch,
      {
        loadedItems: 5,
        totalBatchRows: 5,
        estimatedCommittedRows: 4,
        previewOnlyRows: 1,
        flaggedRows: 2,
        warningRows: 1,
        policyReviewRows: 1,
        coveragePercent: 100,
        isPartial: false,
      },
      'full',
      tr,
    )

    expect(message).toContain('Rollback batch batch-a?')
    expect(message).toContain('Impact basis: Full batch')
    expect(message).toContain('Coverage: 5 / 5 (100%)')
    expect(message).toContain('Estimated committed rows: 4')
    expect(message).toContain('Preview-only rows: 1')
    expect(message).toContain('This confirmation is based on exact full-batch impact.')
    expect(message).toContain('Continue rollback?')
  })

  it('builds targeted retry guidance from batch source, warnings, and policy-sensitive rows', () => {
    const batch = createBatch({
      id: 'batch-a',
      source: 'api',
      meta: {
        engine: 'bulk',
        chunkConfig: {
          itemsChunkSize: 100,
          recordsChunkSize: 50,
        },
      },
    })
    const items = [
      createItem({
        id: 'item-1',
        batchId: 'batch-a',
        recordId: null,
        previewSnapshot: {
          metrics: {
            status: 'late',
            workMinutes: 450,
            lateMinutes: 18,
          },
          warnings: ['missing mapping'],
        },
      }),
      createItem({
        id: 'item-2',
        batchId: 'batch-a',
        recordId: 'record-2',
        previewSnapshot: {
          metrics: {
            status: 'normal',
            workMinutes: 480,
          },
        },
      }),
    ]

    const summary = summarizeImportBatchItems(items)
    const estimate = estimateImportBatchRollbackImpact(batch, items)
    const steps = buildImportBatchRetryGuidance(batch, summary, estimate, tr)

    expect(steps.map((step) => step.actionLabel)).toEqual(
      expect.arrayContaining([
        'Repair mapping',
        'Retry preview',
        'Tune policy',
        'Fix upstream payload',
        'Keep chunk profile',
      ]),
    )
    expect(steps.some((step) => step.detail.includes('100/50'))).toBe(true)
  })

  it('loads batches and items', async () => {
    const apiFetch = vi.fn(async (input: string) => {
      if (input === '/api/attendance/import/batches?orgId=org-1') {
        return jsonResponse(200, {
          ok: true,
          data: { items: [createBatch({ id: 'batch-a' })] },
        })
      }
      if (input === '/api/attendance/import/batches/batch-a/items?orgId=org-1') {
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

  it('loads exact full-batch impact through paginated item fetch', async () => {
    const apiFetch = vi.fn(async (input: string) => {
      const url = String(input)
      if (url === '/api/attendance/import/batches?orgId=org-1') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              createBatch({
                id: 'batch-a',
                rowCount: 3,
                source: 'csv',
                meta: {
                  engine: 'bulk',
                },
              }),
            ],
          },
        })
      }
      if (url === '/api/attendance/import/batches/batch-a/items?page=1&pageSize=200&orgId=org-1') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              createItem({
                id: 'item-1',
                batchId: 'batch-a',
                recordId: 'record-1',
                previewSnapshot: {
                  metrics: {
                    status: 'normal',
                    workMinutes: 480,
                  },
                },
              }),
              createItem({
                id: 'item-2',
                batchId: 'batch-a',
                recordId: null,
                previewSnapshot: {
                  metrics: {
                    status: 'late',
                    workMinutes: 450,
                    lateMinutes: 18,
                  },
                  warnings: ['late arrival'],
                },
              }),
            ],
            total: 3,
          },
        })
      }
      if (url === '/api/attendance/import/batches/batch-a/items?page=2&pageSize=200&orgId=org-1') {
        return jsonResponse(200, {
          ok: true,
          data: {
            items: [
              createItem({
                id: 'item-3',
                batchId: 'batch-a',
                recordId: 'record-3',
                previewSnapshot: {
                  metrics: {
                    status: 'normal',
                    workMinutes: 470,
                  },
                },
              }),
            ],
            total: 3,
          },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })
    const batches = useAttendanceAdminImportBatches({ apiFetch, tr })

    await batches.loadImportBatches({ orgId: 'org-1' })
    await batches.loadFullImportBatchImpact('batch-a')

    expect(batches.importBatchImpactReport.value).toMatchObject({
      batchId: 'batch-a',
      mode: 'full',
      itemCount: 3,
      summary: {
        totalItems: 3,
        anomalyItems: 1,
        warningItems: 1,
        missingRecordItems: 1,
      },
      estimate: {
        totalBatchRows: 3,
        coveragePercent: 100,
        isPartial: false,
      },
    })
    expect(batches.importStatusMessage.value).toBe('Full-batch impact loaded.')
  })

  it('clears the selected batch details after rollback when that batch is open', async () => {
    const confirm = vi.fn(() => true)
    const apiFetch = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input)
      if (url === '/api/auth/me') return jsonResponse(200, {
        success: true, data: { user: { tenantId: 'org-1' } },
      })
      if (url === '/api/attendance/import/batches?orgId=org-1') {
        return jsonResponse(200, {
          ok: true,
          data: { items: [createBatch({ id: 'batch-a' })] },
        })
      }
      if (url === '/api/attendance/import/batches/batch-a/items?orgId=org-1') {
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

    await batches.rollbackImportBatch('batch-a', { confirmMessage: 'Rollback batch-a with exact impact?' })

    expect(confirm).toHaveBeenCalledWith('Rollback batch-a with exact impact?')
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
      // Response.text() strips the backend BOM, so the composable re-adds it
      // before download (review #3776 P2-1) — the BOM here IS the regression lock.
      '\ufeffbatchId,itemId\nbatch-a,item-1',
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
    expect(String(csvText).startsWith('\ufeff'), 'fallback export carries the Excel BOM').toBe(true)
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
