import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// Q3c — StockPreparationSnapshotDiffView.vue's client-side, values-free "导出对账摘要" (export
// reconciliation summary) CSV button. Mirrors the mocking idiom of StockPreparationSnapshotDiffView.spec.ts
// (vi.hoisted holder + mocked locale + mocked service module) and the real-Blob/anchor-click CSV-export
// pattern StockPreparationMissingComponents.spec.ts (E-01/E-02) uses for downloadCsvFile — NOT mocked
// away, so this proves the actual CSV bytes, not just that a function was called.
//
// Covers: the export button issues no new GET; the CSV's `changeCount` section carries the full
// ten-entry vocabulary (Q3a's two-key gap — componentCodeChanged/materialChanged — closed); held/ready
// counts and the per-change-type diffId list appear only once the row-detail drill-down has been
// opened; and the values-free contract (no planted material/quantity/drawing-number value ever reaches
// the exported bytes). The mutation this spec is built to catch: dropping `componentCodeChanged` back
// out of the vocabulary — see the last test in this file.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  listBatches: vi.fn(),
  getDiff: vi.fn(),
  listRows: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/services/integration/stockPreparation/bomSnapshotDiff', () => ({
  listStockPreparationSnapshotBatches: h.listBatches,
  getStockPreparationSnapshotDiff: h.getDiff,
  listStockPreparationSnapshotDiffRows: h.listRows,
}))

import StockPreparationSnapshotDiffView from '../src/components/integration/stockPreparation/StockPreparationSnapshotDiffView.vue'
import type {
  StockPreparationSnapshotBatchListResult,
  StockPreparationSnapshotDiffSummary,
} from '../src/services/integration/stockPreparation/bomSnapshotDiff'

// Planted business values on the mocked rows — the export must contain NONE of them (values-free).
const PLANTED_DRAWING_NO = 'DWG-77213-B'
const PLANTED_MATERIAL_CODE = 'MAT-Q4471'
const PLANTED_QUANTITY = '84031'
const FORBIDDEN = [PLANTED_DRAWING_NO, PLANTED_MATERIAL_CODE, PLANTED_QUANTITY]

function batchList(): StockPreparationSnapshotBatchListResult {
  return {
    projectId: 'proj-alpha',
    batchCount: 2,
    batches: [
      { snapshotBatchId: 'batch-v2', snapshotVersion: 2, snapshotStatus: 'active', syncRunId: 'sync-run-2', lineCount: 5, createdAtPresent: true, incomplete: false },
      { snapshotBatchId: 'batch-v1', snapshotVersion: 1, snapshotStatus: 'superseded', syncRunId: 'sync-run-1', lineCount: 5, createdAtPresent: true, incomplete: false },
    ],
  } as unknown as StockPreparationSnapshotBatchListResult
}

function diffSummary(): StockPreparationSnapshotDiffSummary {
  return {
    snapshotBatchId: 'batch-v2',
    baseSnapshotBatchId: 'batch-v1',
    changeCounts: {
      added: 1,
      removed: 1,
      quantityChanged: 1,
      unitChanged: 0,
      versionChanged: 0,
      pathChanged: 0,
      missingChildBom: 0,
      fingerprintChanged: 2,
      componentCodeChanged: 1,
      materialChanged: 1,
    },
    blockingExceptionCount: 0,
  }
}

function diffRowsResult(): unknown {
  return {
    snapshotBatchId: 'batch-v2',
    baseSnapshotBatchId: 'batch-v1',
    rowCount: 3,
    heldRowCount: 2,
    rows: [
      {
        diffId: 'stockprep_diff_0000000000000001',
        diffType: 'changed',
        reviewStatus: 'held',
        changeTypes: ['component_code_changed', 'source_fingerprint_changed'],
        rowCount: 1,
        keyFingerprint: 'sha16:0123456789abcdef',
        // Planted extras — must never reach the exported CSV.
        drawingNo: PLANTED_DRAWING_NO,
        materialCode: PLANTED_MATERIAL_CODE,
        quantity: PLANTED_QUANTITY,
      },
      {
        diffId: 'stockprep_diff_0000000000000002',
        diffType: 'changed',
        reviewStatus: 'held',
        changeTypes: ['material_changed'],
        rowCount: 1,
        keyFingerprint: 'sha16:99aabbccddeeff00',
      },
      {
        diffId: 'stockprep_diff_0000000000000003',
        diffType: 'added',
        reviewStatus: 'ready',
        changeTypes: [],
        rowCount: 1,
        keyFingerprint: null,
      },
    ],
  }
}

async function flushUi(cycles = 4): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('StockPreparationSnapshotDiffView — Q3c 导出对账摘要 (values-free CSV export)', () => {
  let app: VueApp<Element> | null = null
  let container: HTMLDivElement | null = null
  const OriginalBlob = Blob
  let createObjectURLMock: ReturnType<typeof vi.fn>
  let revokeObjectURLMock: ReturnType<typeof vi.fn>
  let clickedAnchors: Array<{ href: string; download: string }>
  let createdBlobParts: string[]

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.listBatches.mockReset()
    h.getDiff.mockReset()
    h.listRows.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)

    createObjectURLMock = vi.fn(() => 'blob:diff-summary')
    revokeObjectURLMock = vi.fn()
    clickedAnchors = []
    createdBlobParts = []
    globalThis.Blob = class TestBlob extends OriginalBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        createdBlobParts = Array.isArray(parts) ? parts.map((part) => String(part)) : []
        super(parts, options)
      }
    } as typeof Blob
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURLMock })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURLMock })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
      clickedAnchors.push({ href: this.href, download: this.download })
    })
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    globalThis.Blob = OriginalBlob
    vi.restoreAllMocks()
  })

  function mountView(): HTMLDivElement {
    app = createApp(StockPreparationSnapshotDiffView as Component, { projectId: 'proj-alpha' })
    app.mount(container!)
    return container!
  }

  async function selectBatchAndAwaitDiff(root: HTMLDivElement): Promise<void> {
    ;(root.querySelector('[data-testid="stock-prep-snapshot-batch-select"]') as HTMLButtonElement).click()
    await flushUi()
  }

  function clickExport(root: HTMLDivElement): void {
    ;(root.querySelector('[data-testid="stock-prep-snapshot-diff-export"]') as HTMLButtonElement).click()
  }

  function csvText(): string {
    return createdBlobParts.join('')
  }

  it('exports header + batch/summary/changeCount rows WITHOUT opening row detail, and issues no extra GET', async () => {
    h.listBatches.mockResolvedValue(batchList())
    h.getDiff.mockResolvedValue(diffSummary())
    const root = mountView()
    await flushUi()
    await selectBatchAndAwaitDiff(root)

    expect(h.listRows).not.toHaveBeenCalled() // row detail never opened

    clickExport(root)
    await flushUi()

    expect(h.listRows).not.toHaveBeenCalled() // export itself triggers no GET either
    expect(createObjectURLMock).toHaveBeenCalledTimes(1)
    expect(clickedAnchors.length).toBe(1)
    expect(clickedAnchors[0].download).toMatch(/^stock-prep-diff-summary-batch-v2-\d{8}\.csv$/)

    const text = csvText()
    const lines = text.replace(/^﻿/, '').split('\n')
    expect(lines[0]).toBe('section,key,value')

    // Batch pair (id + version) for both sides.
    expect(text).toContain('batch,currentSnapshotBatchId,batch-v2')
    expect(text).toContain('batch,currentSnapshotVersion,2')
    expect(text).toContain('batch,baseSnapshotBatchId,batch-v1')
    expect(text).toContain('batch,baseSnapshotVersion,1')

    // Held/ready are blank — row detail was never loaded.
    expect(text).toContain('summary,readyRowCount,\n')
    expect(text).toContain('summary,heldRowCount,\n')

    // Full ten-entry changeCount vocabulary, including the two Q3a/Q3c additions.
    expect(text).toContain('changeCount,added,1')
    expect(text).toContain('changeCount,removed,1')
    expect(text).toContain('changeCount,quantityChanged,1')
    expect(text).toContain('changeCount,unitChanged,0')
    expect(text).toContain('changeCount,versionChanged,0')
    expect(text).toContain('changeCount,pathChanged,0')
    expect(text).toContain('changeCount,missingChildBom,0')
    expect(text).toContain('changeCount,fingerprintChanged,2')
    expect(text).toContain('changeCount,componentCodeChanged,1')
    expect(text).toContain('changeCount,materialChanged,1')

    // No rowId section at all — nothing to list yet.
    expect(text).not.toContain('rowId,')

    // Values-free: no planted business value anywhere in the export.
    for (const forbidden of FORBIDDEN) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('adds held/ready counts and the per-change-type diffId list once row detail is loaded', async () => {
    h.listBatches.mockResolvedValue(batchList())
    h.getDiff.mockResolvedValue(diffSummary())
    h.listRows.mockResolvedValue(diffRowsResult())
    const root = mountView()
    await flushUi()
    await selectBatchAndAwaitDiff(root)

    ;(root.querySelector('[data-testid="stock-prep-snapshot-diff-rows-toggle"]') as HTMLButtonElement).click()
    await flushUi()
    expect(root.querySelector('[data-testid="stock-prep-snapshot-diff-rows"]')).not.toBeNull()

    clickExport(root)
    await flushUi()

    const text = csvText()
    expect(text).toContain('summary,readyRowCount,1') // rowCount 3 - heldRowCount 2
    expect(text).toContain('summary,heldRowCount,2')

    // One rowId line per (changeType, diffId) pair — row 1 carries TWO change types, so it appears twice.
    expect(text).toContain('rowId,component_code_changed,stockprep_diff_0000000000000001')
    expect(text).toContain('rowId,source_fingerprint_changed,stockprep_diff_0000000000000001')
    expect(text).toContain('rowId,material_changed,stockprep_diff_0000000000000002')
    // The added row has no changeTypes at all — it contributes no rowId line.
    expect(text).not.toContain('stockprep_diff_0000000000000003')

    const rowIdLineCount = text.split('\n').filter((line) => line.startsWith('rowId,')).length
    expect(rowIdLineCount).toBe(3) // two for row 1, one for row 2, none for row 3

    for (const forbidden of FORBIDDEN) {
      expect(text).not.toContain(forbidden)
    }
  })

  // MUTATION CHECK: if `componentCodeChanged` is dropped back out of the plain-language vocabulary
  // (STOCK_PREP_DIFF_KIND_PLAIN in plainLanguage.ts), `changeCountEntries` in the view still renders it
  // by its RAW key — the export line changes shape (`componentCodeChanged` label falls back to the raw
  // key, same key column) except when the entry is dropped from the fixed list entirely, which is the
  // real regression this asserts against: the exact `changeCount,componentCodeChanged,<n>` line must
  // be present, and removing that entry from the view's whitelist array is exactly what turns this red.
  it('fails if componentCodeChanged/materialChanged are missing from the exported changeCount vocabulary', async () => {
    h.listBatches.mockResolvedValue(batchList())
    h.getDiff.mockResolvedValue(diffSummary())
    const root = mountView()
    await flushUi()
    await selectBatchAndAwaitDiff(root)

    clickExport(root)
    await flushUi()

    const text = csvText()
    const changeCountKeys = text
      .split('\n')
      .filter((line) => line.startsWith('changeCount,'))
      .map((line) => line.split(',')[1])
    expect(changeCountKeys).toEqual([
      'added', 'removed', 'quantityChanged', 'unitChanged', 'versionChanged',
      'pathChanged', 'missingChildBom', 'fingerprintChanged', 'componentCodeChanged', 'materialChanged',
    ])
  })
})
