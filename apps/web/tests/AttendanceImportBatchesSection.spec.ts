import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App, type Ref, ref } from 'vue'
import AttendanceImportBatchesSection from '../src/views/attendance/AttendanceImportBatchesSection.vue'
import type {
  AttendanceImportBatch,
  AttendanceImportItem,
} from '../src/views/attendance/useAttendanceAdminImportBatches'

type MaybePromise<T> = T | Promise<T>

interface ImportBatchesBindings {
  importBatchLoading: Ref<boolean>
  importBatches: Ref<AttendanceImportBatch[]>
  importBatchItems: Ref<AttendanceImportItem[]>
  importBatchSelectedId: Ref<string>
  importBatchSnapshot: Ref<Record<string, any> | null>
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
    expect(container!.textContent).toContain('Operator notes')
    expect(container!.textContent).toContain('Mapping viewer')
    expect(container!.textContent).toContain('employeeNo')
  })

  it('filters and inspects the loaded batch in triage mode', async () => {
    const workflow: ImportBatchesBindings = {
      importBatchLoading: ref(false),
      importBatches: ref([createBatch({ id: 'batch-a', rowCount: 2 })]),
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

  it('keeps the summary visible even when no batches are loaded', async () => {
    const workflow: ImportBatchesBindings = {
      importBatchLoading: ref(false),
      importBatches: ref([]),
      importBatchItems: ref([]),
      importBatchSelectedId: ref(''),
      importBatchSnapshot: ref(null),
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
