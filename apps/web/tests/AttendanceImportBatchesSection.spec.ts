import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App, type Ref, ref } from 'vue'
import AttendanceImportBatchesSection from '../src/views/attendance/AttendanceImportBatchesSection.vue'
import type {
  AttendanceImportBatch,
  AttendanceImportBatchImpactReport,
  AttendanceImportItem,
} from '../src/views/attendance/useAttendanceAdminImportBatches'

type MaybePromise<T> = T | Promise<T>

interface ImportBatchesBindings {
  importBatchLoading: Ref<boolean>
  importBatches: Ref<AttendanceImportBatch[]>
  importBatchImpactLoading: Ref<boolean>
  importBatchImpactReport: Ref<AttendanceImportBatchImpactReport | null>
  importBatchItems: Ref<AttendanceImportItem[]>
  importBatchSelectedId: Ref<string>
  importBatchSnapshot: Ref<Record<string, any> | null>
  loadFullImportBatchImpact: (batchId: string) => MaybePromise<void>
  reloadImportBatches: () => MaybePromise<void>
  loadImportBatchItems: (batchId: string) => MaybePromise<void>
  rollbackImportBatch: (batchId: string) => MaybePromise<void>
  exportImportBatchItemsCsv: (onlyAnomalies: boolean) => MaybePromise<void>
  toggleImportBatchSnapshot: (item: AttendanceImportItem) => void
}

function flushUi(): Promise<void> {
  return Promise.resolve()
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

describe('AttendanceImportBatchesSection', () => {
  let app: App<Element> | null = null
  let container: HTMLDivElement | null = null

  const tr = (en: string, _zh: string) => en
  const resolveRuleSetName = (ruleSetId?: string | null) => ruleSetId || '--'
  const formatStatus = (value: string) => value
  const formatDateTime = (value: string | null | undefined) => value ?? '--'
  const formatJson = (value: unknown) => JSON.stringify(value, null, 2)

  function getLoadedBatchRowCount(): number {
    return container!.querySelectorAll('.attendance__table-wrapper')[1]?.querySelectorAll('tbody tr').length ?? 0
  }

  function getBatchRowCount(): number {
    return container!.querySelectorAll('.attendance__table-wrapper')[0]?.querySelectorAll('tbody tr').length ?? 0
  }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    vi.clearAllMocks()
  })

  it('shows batch and item counts in the admin summary', async () => {
    const workflow: ImportBatchesBindings = {
      importBatchLoading: ref(false),
      importBatches: ref([
        createBatch({ id: 'batch-a', rowCount: 3 }),
        createBatch({
          id: 'batch-b',
          rowCount: 7,
          mapping: {
            employeeNo: 'userId',
            checkInTime: 'occurredAt',
          },
        }),
      ]),
      importBatchImpactLoading: ref(false),
      importBatchImpactReport: ref(null),
      importBatchSelectedId: ref('batch-b'),
      importBatchItems: ref([
        createItem({ id: 'item-a', batchId: 'batch-b' }),
        createItem({
          id: 'item-b',
          batchId: 'batch-b',
          userId: 'user-2',
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
      ]),
      importBatchSnapshot: ref(null),
      loadFullImportBatchImpact: vi.fn(),
      reloadImportBatches: vi.fn(),
      loadImportBatchItems: vi.fn(),
      rollbackImportBatch: vi.fn(),
      exportImportBatchItemsCsv: vi.fn(),
      toggleImportBatchSnapshot: vi.fn(),
    }

    app = createApp(AttendanceImportBatchesSection, {
      tr,
      workflow,
      resolveRuleSetName,
      formatStatus,
      formatDateTime,
      formatJson,
    })
    app.mount(container!)
    await flushUi()

    expect(container!.textContent).toContain('Batches loaded: 2')
    expect(container!.textContent).toContain('Rows total: 10')
    expect(container!.textContent).toContain('Current items: 2')
    expect(container!.textContent).toContain('Loaded rows2')
    expect(container!.textContent).toContain('Anomalies1')
    expect(container!.textContent).toContain('Warnings1')
    expect(container!.textContent).toContain('Loaded items: 2')
    expect(container!.textContent).toContain('Flags')
    expect(container!.textContent).toContain('late 15')
    expect(container!.textContent).toContain('Selected batch')
    expect(container!.textContent).toContain('Rollback impact estimate')
    expect(container!.textContent).toContain('Coverage: 2 / 7')
    expect(container!.textContent).toContain('Source: Loaded items')
    expect(container!.textContent).toContain('Load exact impact')
    expect(container!.textContent).toContain('Est. committed rows')
    expect(container!.textContent).toContain('Rollback notes')
    expect(container!.textContent).toContain('Estimate is based on 2 of 7 row(s)')
    expect(container!.textContent).toContain('Retry guidance')
    expect(container!.textContent).toContain('Repair mapping and identity merge first')
    expect(container!.textContent).toContain('Prefer rollback over direct import retry')
    expect(container!.textContent).toContain('Operator notes')
    expect(container!.textContent).toContain('Mapping viewer')
    expect(container!.textContent).toContain('employeeNo')
    expect(container!.textContent).toContain('View mode: Batch inbox')
    expect(container!.textContent).toContain('Active filters: All batches')
  })

  it('filters and inspects the loaded batch in triage mode', async () => {
    const workflow: ImportBatchesBindings = {
      importBatchLoading: ref(false),
      importBatches: ref([createBatch({ id: 'batch-a', rowCount: 2 })]),
      importBatchImpactLoading: ref(false),
      importBatchImpactReport: ref(null),
      importBatchSelectedId: ref('batch-a'),
      importBatchItems: ref([
        createItem({
          id: 'item-a',
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
          id: 'item-b',
          batchId: 'batch-a',
          userId: 'user-2',
          recordId: null,
          previewSnapshot: {
            metrics: {
              status: 'late',
              workMinutes: 480,
              lateMinutes: 12,
            },
            policy: {
              warnings: ['missing window'],
              ruleSetId: 'rule-set-1',
            },
            engine: {
              mode: 'bulk',
              warnings: ['chunk retry'],
            },
            warnings: ['late arrival'],
          },
        }),
      ]),
      importBatchSnapshot: ref(null),
      loadFullImportBatchImpact: vi.fn(),
      reloadImportBatches: vi.fn(),
      loadImportBatchItems: vi.fn(),
      rollbackImportBatch: vi.fn(),
      exportImportBatchItemsCsv: vi.fn(),
      toggleImportBatchSnapshot: vi.fn(),
    }

    app = createApp(AttendanceImportBatchesSection, {
      tr,
      workflow,
      resolveRuleSetName,
      formatStatus,
      formatDateTime,
      formatJson,
    })
    app.mount(container!)
    await flushUi()

      expect(container!.textContent).toContain('View mode: All items')
      expect(getLoadedBatchRowCount()).toBe(2)

    const anomalyButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Anomalies'),
    ) as HTMLButtonElement | undefined
    expect(anomalyButton).toBeTruthy()
    anomalyButton!.click()
    await flushUi()

    expect(container!.textContent).toContain('View mode: Anomalies')
    expect(getLoadedBatchRowCount()).toBe(1)
    expect(container!.textContent).toContain('missing record')

    const detailButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Details'),
    ) as HTMLButtonElement | undefined
    expect(detailButton).toBeTruthy()
    detailButton!.click()
    await flushUi()

    expect(container!.textContent).toContain('Selected item detail')
    expect(container!.textContent).toContain('Critical')
    expect(container!.textContent).toContain('Warnings were emitted during preview')
    expect(container!.textContent).toContain('Recommended next steps')
    expect(container!.textContent).toContain('Policy diagnostics')
    expect(container!.textContent).toContain('Engine diagnostics')
    expect(container!.textContent).toContain('Snapshot actions')
    expect(container!.textContent).toContain('Copy snapshot JSON')
  })

  it('loads exact batch impact and refreshes retry guidance', async () => {
    const impactReport = ref<AttendanceImportBatchImpactReport | null>(null)
    const loadFullImportBatchImpact = vi.fn(async (batchId: string) => {
      impactReport.value = {
        batchId,
        mode: 'full',
        itemCount: 4,
        summary: {
          totalItems: 4,
          anomalyItems: 2,
          warningItems: 1,
          missingRecordItems: 0,
          lateItems: 1,
          earlyLeaveItems: 0,
          leaveItems: 0,
          overtimeItems: 0,
          normalItems: 2,
        },
        estimate: {
          loadedItems: 4,
          totalBatchRows: 4,
          estimatedCommittedRows: 4,
          previewOnlyRows: 0,
          flaggedRows: 2,
          warningRows: 1,
          policyReviewRows: 1,
          coveragePercent: 100,
          isPartial: false,
        },
        issueBuckets: [
          { filter: 'all', count: 4 },
          { filter: 'anomalies', count: 2 },
          { filter: 'warnings', count: 1 },
          { filter: 'late', count: 1 },
          { filter: 'clean', count: 2 },
        ],
      }
    })
    const workflow: ImportBatchesBindings = {
      importBatchLoading: ref(false),
      importBatches: ref([
        createBatch({
          id: 'batch-api',
          rowCount: 4,
          status: 'rolled_back',
          source: 'api',
          createdBy: 'ops-9',
          meta: {
            engine: 'standard',
          },
        }),
      ]),
      importBatchImpactLoading: ref(false),
      importBatchImpactReport: impactReport,
      importBatchSelectedId: ref('batch-api'),
      importBatchItems: ref([
        createItem({
          id: 'item-a',
          batchId: 'batch-api',
          recordId: null,
          previewSnapshot: {
            metrics: {
              status: 'late',
              workMinutes: 450,
              lateMinutes: 10,
            },
            warnings: ['missing identity'],
          },
        }),
      ]),
      importBatchSnapshot: ref(null),
      loadFullImportBatchImpact,
      reloadImportBatches: vi.fn(),
      loadImportBatchItems: vi.fn(),
      rollbackImportBatch: vi.fn(),
      exportImportBatchItemsCsv: vi.fn(),
      toggleImportBatchSnapshot: vi.fn(),
    }

    app = createApp(AttendanceImportBatchesSection, {
      tr,
      workflow,
      resolveRuleSetName,
      formatStatus,
      formatDateTime,
      formatJson,
    })
    app.mount(container!)
    await flushUi()

    const exactImpactButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Load exact impact'),
    ) as HTMLButtonElement | undefined
    expect(exactImpactButton).toBeTruthy()
    exactImpactButton!.click()
    await flushUi()

    expect(loadFullImportBatchImpact).toHaveBeenCalledWith('batch-api')
    expect(container!.textContent).toContain('Source: Full batch')
    expect(container!.textContent).toContain('Coverage: 4 / 4')
    expect(container!.textContent).toContain('Refresh exact impact')
    expect(container!.textContent).toContain('Fix upstream payload')
    expect(container!.textContent).toContain('Patch the upstream API producer before retry')
  })

  it('filters the batch inbox by search, status, engine, and source', async () => {
    const workflow: ImportBatchesBindings = {
      importBatchLoading: ref(false),
      importBatches: ref([
        createBatch({
          id: 'batch-alpha',
          rowCount: 3,
          status: 'completed',
          source: 'csv',
          createdBy: 'ops-1',
          createdAt: '2026-03-18T09:00:00.000Z',
          meta: {
            engine: 'bulk',
          },
        }),
        createBatch({
          id: 'batch-archive',
          rowCount: 5,
          status: 'completed',
          source: 'csv',
          createdBy: 'ops-0',
          createdAt: '2026-02-10T09:00:00.000Z',
          meta: {
            engine: 'bulk',
          },
        }),
        createBatch({
          id: 'batch-beta',
          rowCount: 4,
          status: 'rolled_back',
          source: 'api',
          createdBy: 'ops-2',
          createdAt: '2026-03-21T09:00:00.000Z',
          meta: {
            engine: 'standard',
          },
        }),
      ]),
      importBatchImpactLoading: ref(false),
      importBatchImpactReport: ref(null),
      importBatchSelectedId: ref('batch-alpha'),
      importBatchItems: ref([]),
      importBatchSnapshot: ref(null),
      loadFullImportBatchImpact: vi.fn(),
      reloadImportBatches: vi.fn(),
      loadImportBatchItems: vi.fn(),
      rollbackImportBatch: vi.fn(),
      exportImportBatchItemsCsv: vi.fn(),
      toggleImportBatchSnapshot: vi.fn(),
    }

    app = createApp(AttendanceImportBatchesSection, {
      tr,
      workflow,
      resolveRuleSetName,
      formatStatus,
      formatDateTime,
      formatJson,
      clock: () => new Date('2026-03-21T12:00:00.000Z'),
    })
    app.mount(container!)
    await flushUi()

    expect(getBatchRowCount()).toBe(3)
    expect(container!.textContent).toContain('Active filters: All batches')
    expect(container!.textContent).toContain('Time slice: All time')

    const last7Button = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Last 7 days'),
    ) as HTMLButtonElement | undefined
    expect(last7Button).toBeTruthy()
    last7Button!.click()
    await flushUi()

    expect(container!.textContent).toContain('Time slice: Last 7 days')
    expect(getBatchRowCount()).toBe(2)

    const searchInput = container!.querySelector('#attendance-import-batch-inbox-search') as HTMLInputElement | null
    expect(searchInput).toBeTruthy()
    searchInput!.value = 'ops-2'
    searchInput!.dispatchEvent(new Event('input'))
    await flushUi()

    expect(getBatchRowCount()).toBe(1)
    expect(container!.textContent).toContain('Search: ops-2')

    const statusFilter = container!.querySelector('#attendance-import-batch-status-filter') as HTMLSelectElement | null
    expect(statusFilter).toBeTruthy()
    statusFilter!.value = 'rolled_back'
    statusFilter!.dispatchEvent(new Event('change'))
    await flushUi()

    expect(container!.textContent).toContain('Active filters: status rolled_back')

    const engineFilter = container!.querySelector('#attendance-import-batch-engine-filter') as HTMLSelectElement | null
    expect(engineFilter).toBeTruthy()
    engineFilter!.value = 'standard'
    engineFilter!.dispatchEvent(new Event('change'))
    await flushUi()

    expect(container!.textContent).toContain('engine standard')

    const sourceFilter = container!.querySelector('#attendance-import-batch-source-filter') as HTMLSelectElement | null
    expect(sourceFilter).toBeTruthy()
    sourceFilter!.value = 'api'
    sourceFilter!.dispatchEvent(new Event('change'))
    await flushUi()

    expect(container!.textContent).toContain('source api')
    expect(container!.textContent).toContain('Visible batches: 1')
    expect(container!.textContent).toContain('Visible rows: 4')

    const creatorFilter = container!.querySelector('#attendance-import-batch-creator-filter') as HTMLSelectElement | null
    expect(creatorFilter).toBeTruthy()
    creatorFilter!.value = 'ops-2'
    creatorFilter!.dispatchEvent(new Event('change'))
    await flushUi()

    expect(container!.textContent).toContain('creator ops-2')

    const createdFrom = container!.querySelector('#attendance-import-batch-created-from') as HTMLInputElement | null
    expect(createdFrom).toBeTruthy()
    createdFrom!.value = '2026-03-20'
    createdFrom!.dispatchEvent(new Event('input'))
    await flushUi()

    expect(container!.textContent).toContain('Time slice: Custom')
    expect(container!.textContent).toContain('created 2026-03-20 to 2026-03-21')
    expect(getBatchRowCount()).toBe(1)

    const createdTo = container!.querySelector('#attendance-import-batch-created-to') as HTMLInputElement | null
    expect(createdTo).toBeTruthy()
    createdTo!.value = '2026-03-19'
    createdTo!.dispatchEvent(new Event('input'))
    await flushUi()

    expect(getBatchRowCount()).toBe(0)
    expect(container!.textContent).toContain('No batches match the current inbox filters.')

    const resetButton = Array.from(container!.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Reset batch filters'),
    ) as HTMLButtonElement | undefined
    expect(resetButton).toBeTruthy()
    resetButton!.click()
    await flushUi()

    expect(getBatchRowCount()).toBe(3)
    expect(container!.textContent).toContain('Active filters: All batches')
  })

  it('keeps the summary visible even when no batches are loaded', async () => {
    const workflow: ImportBatchesBindings = {
      importBatchLoading: ref(false),
      importBatches: ref([]),
      importBatchImpactLoading: ref(false),
      importBatchImpactReport: ref(null),
      importBatchItems: ref([]),
      importBatchSelectedId: ref(''),
      importBatchSnapshot: ref(null),
      loadFullImportBatchImpact: vi.fn(),
      reloadImportBatches: vi.fn(),
      loadImportBatchItems: vi.fn(),
      rollbackImportBatch: vi.fn(),
      exportImportBatchItemsCsv: vi.fn(),
      toggleImportBatchSnapshot: vi.fn(),
    }

    app = createApp(AttendanceImportBatchesSection, {
      tr,
      workflow,
      resolveRuleSetName,
      formatStatus,
      formatDateTime,
      formatJson,
    })
    app.mount(container!)
    await flushUi()

    expect(container!.textContent).toContain('Batches loaded: 0')
    expect(container!.textContent).toContain('No import batches.')
  })
})
