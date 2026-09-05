import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// 缺件清单 (W3a) — the front-end half of the missing-components list: a dry run that hits even one
// BOM line whose part is absent from the materials table cannot write the project until every such
// row is resolved (server-side ruling, W3a §1: "一条缺件整个项目一行都写不进去"). This suite pins:
//
//   C-01..C-07  `missingComponentsOf()` clamps a malformed/oversized server payload at the API
//               boundary: a non-array `items` discards the WHOLE key, string fields are
//               String()-coerced and cut at 128 characters, `items` is capped at 200 even when the
//               server sends more, numeric fields fall back to 0, and `truncated` is true only for
//               the literal boolean `true`.
//   G-01/G-02   the CSV/formula-injection guard (stockPrepCsv.ts) prefixes a leading =, +, -, @, tab
//               or CR with an apostrophe, in both the CSV and the TSV cell escapers.
//   R-01        a plan WITH missing components renders the container, the bilingual summary
//               sentence, one row per item, and the "(+N 处)" parent badge only when parentCount > 1.
//   R-02        a plan with NO missing components (key absent, or distinctCount 0) renders nothing —
//               not even an empty shell.
//   R-03        `truncated` renders its own notice naming the REAL distinctCount, not "200".
//   V-01        values-free carries past this feature too: the technical disclosure (step details)
//               never contains a component id, even on a run that DID surface one on screen.
//   X-01        复制 puts a TAB-separated block on the clipboard — header + rows — with the injection
//               guard live in it.
//   X-02        复制 falls back to selecting the table and changes its own label when the Clipboard
//               API is unavailable, rather than failing silently.
//   E-01        导出 CSV drives the REAL downloadCsvFile (Blob + anchor click, not mocked away) to a
//               file named `missing-components-{projectNo}-{YYYYMMDD}.csv`, guard live in the file.
//
// Same mock/flush idiom as the sibling suite in this directory (StockPreparationUnconfirmableHold.
// spec.ts): useLocale/useAuth mocked via vi.hoisted state, and a single `setTimeout(0) → nextTick()`
// flush rather than a manual multi-tick loop.

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: ['integration:admin'] as string[],
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    getToken: () => 'session-token',
    clearToken: vi.fn(),
    getAccessSnapshot: () => ({ isAdmin: false, email: '' }),
    hasPermission: (permission: string) => h.permissions.includes(permission),
  }),
}))

import StockPreparationProjectSyncPanel from '../src/components/integration/stockPreparation/StockPreparationProjectSyncPanel.vue'
import {
  missingComponentsOf,
  type StockPreparationProjectSyncApi,
} from '../src/services/integration/stockPreparation/projectSync'
import { escapeCsvCell, escapeTsvCell } from '../src/services/integration/stockPreparation/stockPrepCsv'

const PROJECT_NO = 'P2026-777'

function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    componentSourceId: 'PN-0001',
    parentSourceId: 'ASM-100',
    bomId: 'BOM-1',
    path: 'ASM-100/PN-0001',
    depth: 2,
    occurrenceCount: 3,
    parentCount: 1,
    ...overrides,
  }
}

function planWithMissing(list: Record<string, unknown> | null, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'manual_confirm_required',
    canApply: true,
    dryRunToken: 'tok_held',
    counts: { add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 3 },
    ...(list ? { missingComponents: list } : {}),
    ...overrides,
  }
}

function api(overrides: Partial<StockPreparationProjectSyncApi> = {}): StockPreparationProjectSyncApi {
  return {
    dryRun: vi.fn().mockResolvedValue({ status: 'ready', canApply: true, dryRunToken: 'tok_x', counts: {} }),
    reconcile: vi.fn().mockResolvedValue({ counts: { created: 3, existing: 0, pending: 3 } }),
    apply: vi.fn().mockResolvedValue({
      status: 'succeeded',
      apply: { counts: { created: 0, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0 } },
    }),
    archive: vi.fn().mockResolvedValue({ status: 'created', persisted: true, created: { batch: 1, lines: 1, run: 1 } }),
    ...overrides,
  } as StockPreparationProjectSyncApi
}

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null

function q(root: HTMLElement, testid: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${testid}"]`)
}

function qa(root: HTMLElement, testid: string): HTMLElement[] {
  return Array.from(root.querySelectorAll(`[data-testid="${testid}"]`))
}

/** Settle the microtask queue AND the fetch/plan promise chain, exactly as the sibling suite does. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => nextTick()).then(() => undefined)
}

function mountPanel(apiDouble: StockPreparationProjectSyncApi): HTMLDivElement {
  app = createApp(StockPreparationProjectSyncPanel as Component, { api: apiDouble })
  app.mount(container!)
  return container!
}

/** Type a project number, press run, settle. The one path every DOM test in this file drives. */
async function runWithDryRun(dryRun: Record<string, unknown>): Promise<HTMLDivElement> {
  const root = mountPanel(api({ dryRun: vi.fn().mockResolvedValue(dryRun) }))
  const input = q(root, 'stock-prep-project-sync-project-no') as HTMLInputElement
  input.value = PROJECT_NO
  input.dispatchEvent(new Event('input'))
  await nextTick()
  ;(q(root, 'stock-prep-project-sync-run') as HTMLButtonElement).click()
  await flush()
  return root
}

// =============================================================================================
// C-01..C-07 — missingComponentsOf() clamp, no DOM
// =============================================================================================

describe('missingComponentsOf — strict clamp at the API boundary', () => {
  it('C-01: no missingComponents key, or a nullish plan, → null', () => {
    expect(missingComponentsOf({})).toBeNull()
    expect(missingComponentsOf(null)).toBeNull()
    expect(missingComponentsOf(undefined)).toBeNull()
  })

  it('C-02: missingComponents that is not a plain object (a string, a number, an array) → null', () => {
    expect(missingComponentsOf({ missingComponents: 'oops' })).toBeNull()
    expect(missingComponentsOf({ missingComponents: 42 })).toBeNull()
    expect(missingComponentsOf({ missingComponents: [] })).toBeNull()
  })

  it('C-03: a non-array `items` discards the WHOLE key, not just the items list', () => {
    const result = missingComponentsOf({
      missingComponents: { distinctCount: 5, probeCount: 9, truncated: false, items: 'not-an-array' },
    })
    expect(result).toBeNull()
  })

  it('C-04: string fields are String()-coerced and cut at exactly 128 characters', () => {
    const longId = 'X'.repeat(200)
    const result = missingComponentsOf({
      missingComponents: {
        distinctCount: 1,
        probeCount: 1,
        truncated: false,
        items: [rawItem({ componentSourceId: longId, parentSourceId: 999 })],
      },
    })
    expect(result?.items[0].componentSourceId).toBe('X'.repeat(128))
    expect(result?.items[0].componentSourceId.length).toBe(128)
    // A non-string field is String()-coerced too, not dropped.
    expect(result?.items[0].parentSourceId).toBe('999')
  })

  it('C-05: items are capped at 200 even when the server sends more, and the real totals survive', () => {
    const items = Array.from({ length: 250 }, (_, i) => rawItem({ componentSourceId: `PN-${i}` }))
    const result = missingComponentsOf({
      missingComponents: { distinctCount: 250, probeCount: 400, truncated: true, items },
    })
    expect(result?.items.length).toBe(200)
    expect(result?.items[0].componentSourceId).toBe('PN-0')
    expect(result?.items[199].componentSourceId).toBe('PN-199')
    // distinctCount/probeCount are the server's real totals, not recomputed from the capped array.
    expect(result?.distinctCount).toBe(250)
    expect(result?.probeCount).toBe(400)
  })

  it('C-06: non-numeric/absent numeric fields clamp to 0', () => {
    const result = missingComponentsOf({
      missingComponents: {
        distinctCount: 'lots',
        probeCount: null,
        truncated: false,
        items: [rawItem({ depth: 'deep', occurrenceCount: undefined, parentCount: Number.NaN })],
      },
    })
    expect(result?.distinctCount).toBe(0)
    expect(result?.probeCount).toBe(0)
    expect(result?.items[0].depth).toBe(0)
    expect(result?.items[0].occurrenceCount).toBe(0)
    expect(result?.items[0].parentCount).toBe(0)
  })

  it('C-07: `truncated` is true ONLY for the literal boolean true', () => {
    const truthyString = missingComponentsOf({
      missingComponents: { distinctCount: 1, probeCount: 1, truncated: 'true', items: [rawItem()] },
    })
    expect(truthyString?.truncated).toBe(false)
    const realTrue = missingComponentsOf({
      missingComponents: { distinctCount: 1, probeCount: 1, truncated: true, items: [rawItem()] },
    })
    expect(realTrue?.truncated).toBe(true)
  })
})

// =============================================================================================
// G-01/G-02 — the CSV/TSV formula-injection guard, no DOM
// =============================================================================================

describe('CSV/TSV formula-injection guard (stockPrepCsv.ts)', () => {
  it('G-01: a leading =, +, -, @, tab or CR gets an apostrophe prefix in a CSV cell', () => {
    for (const prefix of ['=', '+', '-', '@', '\t', '\r']) {
      expect(escapeCsvCell(`${prefix}cmd`)).toBe(`'${prefix}cmd`)
    }
    expect(escapeCsvCell('PN-0001')).toBe('PN-0001')
  })

  it('G-02: the same guard applies to TSV cells, and embedded tabs/newlines become spaces', () => {
    expect(escapeTsvCell('=cmd')).toBe("'=cmd")
    expect(escapeTsvCell('a\tb\r\nc')).toBe('a b  c')
  })
})

// =============================================================================================
// R-01..V-01 — rendering
// =============================================================================================

describe('StockPreparationProjectSyncPanel — 缺件清单 rendering', () => {
  beforeEach(() => {
    h.locale = 'zh-CN'
    h.permissions = ['integration:admin']
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

  it('R-01: renders the container, the bilingual summary, one row per item, and the parentCount badge', async () => {
    const list = {
      distinctCount: 2,
      probeCount: 5,
      truncated: false,
      items: [
        rawItem({ componentSourceId: 'PN-1001', parentSourceId: 'ASM-A', bomId: 'BOM-9', depth: 2, occurrenceCount: 3, parentCount: 1 }),
        rawItem({ componentSourceId: 'PN-2002', parentSourceId: 'ASM-B', bomId: 'BOM-9', depth: 1, occurrenceCount: 2, parentCount: 4 }),
      ],
    }
    const root = await runWithDryRun(planWithMissing(list))

    const box = q(root, 'stock-prep-project-sync-missing-components')
    expect(box, 'the disclosure renders when the plan hit missing components').not.toBeNull()
    expect(box!.textContent).toContain('缺件 2 种')
    expect(box!.textContent).toContain('共 5 处引用')
    expect(box!.textContent).toContain('整个项目在补齐前一行都写不进去')

    const rows = qa(root, 'stock-prep-project-sync-missing-components-row')
    expect(rows.length).toBe(2)
    expect(rows[0].textContent).toContain('PN-1001')
    expect(rows[0].textContent).toContain('ASM-A')
    // parentCount === 1 → no badge on the first row.
    expect(rows[0].textContent).not.toContain('+')
    expect(rows[1].textContent).toContain('PN-2002')
    // parentCount === 4 → the badge on the second row.
    expect(rows[1].textContent).toContain('(+4 处)')
  })

  it('R-02: no missingComponents key at all → the container does not render', async () => {
    const root = await runWithDryRun(planWithMissing(null))
    expect(q(root, 'stock-prep-project-sync-missing-components')).toBeNull()
  })

  it('R-02b: distinctCount 0 → the container does not render even though the key is present', async () => {
    const root = await runWithDryRun(planWithMissing({ distinctCount: 0, probeCount: 0, truncated: false, items: [] }))
    expect(q(root, 'stock-prep-project-sync-missing-components')).toBeNull()
  })

  it('R-03: truncated renders its own notice naming the REAL distinctCount, not "200"', async () => {
    const items = Array.from({ length: 3 }, (_, i) => rawItem({ componentSourceId: `PN-${i}` }))
    const root = await runWithDryRun(planWithMissing({ distinctCount: 240, probeCount: 500, truncated: true, items }))
    const notice = q(root, 'stock-prep-project-sync-missing-components-truncated')
    expect(notice).not.toBeNull()
    expect(notice!.textContent).toContain('200')
    expect(notice!.textContent).toContain('240')
  })

  it('V-01: values-free survives this feature too — a component id never reaches the technical disclosure', async () => {
    const list = {
      distinctCount: 1,
      probeCount: 1,
      truncated: false,
      items: [rawItem({ componentSourceId: 'PLANTED-SECRET-PN-9911' })],
    }
    const root = await runWithDryRun(planWithMissing(list))
    // It DOES appear on screen — in the missing-components block, which is the point of this feature.
    expect(q(root, 'stock-prep-project-sync-missing-components')!.textContent).toContain('PLANTED-SECRET-PN-9911')
    // It must NOT appear in the step details / technical disclosure, which is the values-free surface.
    const tech = q(root, 'stock-prep-project-sync-tech')
    expect(tech!.textContent).not.toContain('PLANTED-SECRET-PN-9911')
  })
})

// =============================================================================================
// X-01/X-02 — 复制 (clipboard)
// =============================================================================================

describe('StockPreparationProjectSyncPanel — 缺件清单复制', () => {
  beforeEach(() => {
    h.locale = 'zh-CN'
    h.permissions = ['integration:admin']
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    if (app) app.unmount()
    if (container) container.remove()
    app = null
    container = null
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    vi.clearAllMocks()
  })

  it('X-01: 复制 puts a TAB-separated block on the clipboard — header + rows — guard live', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    const list = {
      distinctCount: 1,
      probeCount: 1,
      truncated: false,
      items: [rawItem({ componentSourceId: '=cmd|A1', parentSourceId: 'ASM-A', bomId: 'BOM-1', depth: 1, occurrenceCount: 1, parentCount: 1 })],
    }
    const root = await runWithDryRun(planWithMissing(list))

    ;(q(root, 'stock-prep-project-sync-missing-components-copy') as HTMLButtonElement).click()
    await flush()

    expect(writeText).toHaveBeenCalledTimes(1)
    const tsv = writeText.mock.calls[0][0] as string
    const lines = tsv.split('\n')
    expect(lines[0].split('\t')).toEqual(['零件号', '父件', '所在 BOM', '层级', '次数'])
    // The injection guard is LIVE in the copied text, not only in the CSV export path.
    expect(lines[1].split('\t')[0]).toBe("'=cmd|A1")

    const button = q(root, 'stock-prep-project-sync-missing-components-copy') as HTMLButtonElement
    expect(button.textContent).toContain('已复制')
  })

  it('X-02: clipboard unavailable → falls back to selecting the table and changes its own label', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const list = { distinctCount: 1, probeCount: 1, truncated: false, items: [rawItem()] }
    const root = await runWithDryRun(planWithMissing(list))

    const button = q(root, 'stock-prep-project-sync-missing-components-copy') as HTMLButtonElement
    expect(() => button.click()).not.toThrow()
    await flush()

    expect(button.textContent).toContain('请按 Ctrl/Cmd+C')
  })
})

// =============================================================================================
// E-01 — 导出 CSV, driving the REAL downloadCsvFile (Blob captured, anchor click spied — not
// mocked away), the same pattern userManagementView.spec.ts uses for its own CSV/MD downloads.
// =============================================================================================

describe('StockPreparationProjectSyncPanel — 缺件清单导出 CSV', () => {
  const OriginalBlob = Blob
  let createObjectURLMock: ReturnType<typeof vi.fn>
  let revokeObjectURLMock: ReturnType<typeof vi.fn>
  let clickedAnchors: Array<{ href: string; download: string }>
  let createdBlobParts: string[]

  beforeEach(() => {
    h.locale = 'zh-CN'
    h.permissions = ['integration:admin']
    container = document.createElement('div')
    document.body.appendChild(container)

    createObjectURLMock = vi.fn(() => 'blob:missing-components')
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

  it('E-01: downloads missing-components-{projectNo}-{YYYYMMDD}.csv, guard live in the file', async () => {
    const list = {
      distinctCount: 1,
      probeCount: 1,
      truncated: false,
      items: [rawItem({ componentSourceId: '=cmd|A1', parentSourceId: 'ASM-A' })],
    }
    const root = await runWithDryRun(planWithMissing(list))

    ;(q(root, 'stock-prep-project-sync-missing-components-export') as HTMLButtonElement).click()
    await flush()

    expect(createObjectURLMock).toHaveBeenCalledTimes(1)
    expect(clickedAnchors.length).toBe(1)
    expect(clickedAnchors[0].download).toMatch(new RegExp(`^missing-components-${PROJECT_NO}-\\d{8}\\.csv$`))

    const csvText = createdBlobParts.join('')
    expect(csvText).toContain('零件号,父件,所在 BOM,层级,次数')
    // The injection guard fired on the exported file too.
    expect(csvText).toContain("'=cmd|A1")
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(1)
  })
})
