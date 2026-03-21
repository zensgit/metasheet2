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
        createBatch({ id: 'batch-b', rowCount: 7 }),
      ]),
      importBatchItems: ref([
        createItem({ id: 'item-a', batchId: 'batch-b' }),
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
    expect(container!.textContent).toContain('Current items: 1')
    expect(container!.textContent).toContain('Loaded items: 1')
  })

  it('keeps the summary visible even when no batches are loaded', async () => {
    const workflow: ImportBatchesBindings = {
      importBatchLoading: ref(false),
      importBatches: ref([]),
      importBatchItems: ref([]),
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
