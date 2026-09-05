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
//   C-08        a non-object entry, or one whose id/parent/bom/path field is itself an object, is
//               DROPPED, never mapped into a blank/garbage row (adversarial-review fix #6).
//   C-09        `path` is the server's `JSON.stringify(pathTokens)` wire shape, NOT a pre-joined
//               "A/B" string (fix #2): `missingComponentsOf` decodes it and joins with " / ", falls
//               back to the raw string when it isn't valid JSON, and truncates to 128 chars AFTER
//               joining rather than cutting the raw JSON off mid-token.
//   G-01/G-02   the CSV/formula-injection guard (stockPrepCsv.ts) is OPT-IN (`{ guardFormulas: true
//               }`, adversarial-review fix B3) and prefixes a leading =, +, -, @ or tab with an
//               apostrophe; a leading CR gets the same prefix AND is quote-wrapped (fix #5 — `\r` now
//               also triggers CSV quoting).
//   R-01        a plan WITH missing components renders the container, the bilingual summary
//               sentence, one row per item, and the on-screen "(+N 处)" parent badge only when
//               parentCount > 1.
//   R-02/R-02b  a plan with NO missing components (key absent, or a GENUINELY empty list) renders
//               nothing — not even an empty shell.
//   R-03        `truncated` renders its own HONEST notice (fix B2: never claims the export is "全量"
//               — the client holds at most 200 rows, so the export IS those same 200), and exporting
//               a truncated list produces exactly 201 lines (header + 200), never "all N".
//   M5-01/M5-02 a clamped-to-0 `distinctCount` never hides a non-empty `items` list (falls back to
//               `items.length` for the displayed count); an inconsistent `{distinctCount:5,items:[]}`
//               renders the count line but no empty table/actions (adversarial-review fix M5).
//   V-01        values-free carries past this feature too: the technical disclosure (step details)
//               never contains a component id, even on a run that DID surface one on screen.
//   X-01        复制 puts a TAB-separated block on the clipboard — 7-column header + rows, parent
//               column RAW (no on-screen badge text) — with the injection guard live (fix #8).
//   X-02        复制 falls back to selecting the table and changes its own label when the Clipboard
//               API is unavailable, rather than failing silently.
//   X-03        the copy button's transient label resets to idle 3s later (fix #9).
//   E-01        导出 CSV drives the REAL downloadCsvFile (Blob + anchor click, not mocked away) to a
//               file named `missing-components-{projectNo}-{YYYYMMDD}.csv`, 7 columns, guard live.
//   E-02        a project number containing filesystem-hostile characters is sanitized in the
//               downloaded filename (fix #9).
//   B1 line    the `-unavailable` hint line (fix #3) renders ONLY for `scope_denied` (actionable);
//               `server_unsupported` renders nothing.
//   B1-01/02/03/04/05 `createStockPreparationProjectSyncApi`'s dry run retries ONCE without
//               `includeMissingComponents` on exactly the two failures that mean "the flag itself was
//               refused" (400 TABLE_ACTION_REQUEST_INVALID, 403 OPERATOR_SCOPE_*) — merging this PR
//               alone (server-side W3a PR not yet merged) must not 400 every sync on main. Does NOT
//               retry an ordinary dry-run failure (B1-03), a SECOND failure of the retry itself
//               (B1-04 — exactly one retry, never a loop), or a 403 outside the OPERATOR_SCOPE_*
//               vocabulary (B1-05).
//
// Same mock/flush idiom as the sibling suite in this directory (StockPreparationUnconfirmableHold.
// spec.ts): useLocale/useAuth mocked via vi.hoisted state, and a single `setTimeout(0) → nextTick()`
// flush rather than a manual multi-tick loop (X-03's fake-timer test is the one deliberate exception —
// see its own comment).

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: ['integration:admin'] as string[],
  apiFetch: vi.fn(),
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

// Only the B1 describe block below actually exercises this — every other test injects a
// `StockPreparationProjectSyncApi` double straight into the panel and never reaches real `apiFetch`.
vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => h.apiFetch(...args),
}))

import StockPreparationProjectSyncPanel from '../src/components/integration/stockPreparation/StockPreparationProjectSyncPanel.vue'
import {
  createStockPreparationProjectSyncApi,
  missingComponentsOf,
  runStockPreparationProjectSync,
  type StockPreparationProjectSyncApi,
} from '../src/services/integration/stockPreparation/projectSync'
import { escapeCsvCell, escapeTsvCell } from '../src/services/integration/stockPreparation/stockPrepCsv'

const PROJECT_NO = 'P2026-777'

/**
 * `path` defaults to the SERVER'S actual wire shape (fix #2): `JSON.stringify(pathTokens)`, e.g.
 * `["ASM-100","PN-0001"]` — NOT a pre-joined `A/B` string. `missingComponentsOf` decodes this into
 * `'ASM-100 / PN-0001'` (see `formatMissingComponentPath` / C-09 below); every assertion in this file
 * that checks a rendered/exported path value checks the JOINED form, never the raw JSON.
 */
function rawItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    componentSourceId: 'PN-0001',
    parentSourceId: 'ASM-100',
    bomId: 'BOM-1',
    path: JSON.stringify(['ASM-100', 'PN-0001']),
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
// C-01..C-08 — missingComponentsOf() clamp, no DOM
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

  it('C-08: a non-object entry, or one whose string field is itself an object, is DROPPED — never a blank row', () => {
    const result = missingComponentsOf({
      missingComponents: {
        distinctCount: 4,
        probeCount: 4,
        truncated: false,
        items: [null, 3, 'x', { componentSourceId: {} }],
      },
    })
    // 0 rows: `null`/`3`/`"x"` are not objects at all, and `{componentSourceId:{}}` IS an object but
    // its id field is itself an object — `String({})` would have produced "[object Object]", a
    // rendering artifact, not the customer's data, so the whole entry is discarded rather than kept
    // with a garbage id.
    expect(result?.items.length).toBe(0)
  })

  it('C-09 (fix #2): path is JSON.parse\'d and joined with " / " when it decodes to an array; falls back to the raw string otherwise; truncates to 128 AFTER joining, not mid-JSON', () => {
    // The server's actual wire shape: JSON.stringify(pathTokens), not a pre-joined "A/B" string.
    const arrayPath = JSON.stringify(['ASM-100', 'PN-0001'])
    const decoded = missingComponentsOf({
      missingComponents: { distinctCount: 1, probeCount: 1, truncated: false, items: [rawItem({ path: arrayPath })] },
    })
    expect(decoded?.items[0].path).toBe('ASM-100 / PN-0001')

    // Not valid JSON at all — falls back to the raw string, unparsed, rather than going blank.
    const fallback = missingComponentsOf({
      missingComponents: { distinctCount: 1, probeCount: 1, truncated: false, items: [rawItem({ path: 'not-json-at-all' })] },
    })
    expect(fallback?.items[0].path).toBe('not-json-at-all')

    // Valid JSON that decodes to something OTHER than an array (e.g. a bare string) also falls back
    // to the raw (still-JSON) text rather than being force-unwrapped.
    const nonArrayJson = missingComponentsOf({
      missingComponents: { distinctCount: 1, probeCount: 1, truncated: false, items: [rawItem({ path: '"just-a-string"' })] },
    })
    expect(nonArrayJson?.items[0].path).toBe('"just-a-string"')

    // A path array whose JSON-STRING form is well over 128 chars must still decode/join correctly —
    // truncating the RAW JSON at char 128 first would cut it mid-token and either break JSON.parse or
    // hand back a stray fragment. The cap applies to the JOINED text instead.
    const longTokens = Array.from({ length: 20 }, (_, i) => `PART-${i}-${'X'.repeat(10)}`)
    const longArrayPath = JSON.stringify(longTokens)
    expect(longArrayPath.length).toBeGreaterThan(128)
    const longResult = missingComponentsOf({
      missingComponents: { distinctCount: 1, probeCount: 1, truncated: false, items: [rawItem({ path: longArrayPath })] },
    })
    const expectedJoined = longTokens.join(' / ')
    expect(expectedJoined.length).toBeGreaterThan(128) // the joined text itself still needs the cap
    expect(longResult?.items[0].path).toBe(expectedJoined.slice(0, 128))
    expect(longResult?.items[0].path.length).toBe(128)
  })
})

// =============================================================================================
// G-01/G-02 — the CSV/TSV formula-injection guard, opt-in, no DOM
// =============================================================================================

describe('CSV/TSV formula-injection guard (stockPrepCsv.ts) — opt-in, default off (B3)', () => {
  it('G-01: with the guard ON, a leading =, +, -, @ or tab gets an apostrophe prefix in a CSV cell', () => {
    for (const prefix of ['=', '+', '-', '@', '\t']) {
      expect(escapeCsvCell(`${prefix}cmd`, { guardFormulas: true })).toBe(`'${prefix}cmd`)
    }
    expect(escapeCsvCell('PN-0001', { guardFormulas: true })).toBe('PN-0001')
  })

  it('G-01b: a leading CR gets the apostrophe prefix AND is quote-wrapped (fix #5: CR now also triggers CSV quoting)', () => {
    expect(escapeCsvCell('\rcmd', { guardFormulas: true })).toBe('"\'\rcmd"')
  })

  it('G-01c: with the guard OFF (default — no options), nothing is prefixed, even for a formula-shaped cell', () => {
    expect(escapeCsvCell('=cmd')).toBe('=cmd')
    expect(escapeCsvCell('-1')).toBe('-1')
  })

  it('G-02: the same guard applies to TSV cells (opt-in), and embedded tabs/newlines become spaces regardless', () => {
    expect(escapeTsvCell('=cmd', { guardFormulas: true })).toBe("'=cmd")
    expect(escapeTsvCell('=cmd')).toBe('=cmd') // guard OFF by default
    expect(escapeTsvCell('a\tb\r\nc')).toBe('a b  c')
  })
})

// =============================================================================================
// R-01..M5-02, V-01 — rendering
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

  it('R-01: renders the container, the bilingual summary, one row per item, and the on-screen parentCount badge', async () => {
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
    // parentCount === 4 → the ON-SCREEN badge on the second row (export/copy do NOT carry this — see X-01).
    expect(rows[1].textContent).toContain('(+4 处)')
  })

  it('R-02: no missingComponents key at all → the container does not render', async () => {
    const root = await runWithDryRun(planWithMissing(null))
    expect(q(root, 'stock-prep-project-sync-missing-components')).toBeNull()
  })

  it('R-02b: distinctCount 0 AND an empty items list (genuinely empty) → the container does not render', async () => {
    const root = await runWithDryRun(planWithMissing({ distinctCount: 0, probeCount: 0, truncated: false, items: [] }))
    expect(q(root, 'stock-prep-project-sync-missing-components')).toBeNull()
  })

  it('M5-01: a garbage-clamped distinctCount (0) does not hide a non-empty items list; the count falls back to items.length', async () => {
    const list = {
      distinctCount: 'lots', // missingComponentsOf clamps this to 0 via intOf
      probeCount: 5,
      truncated: false,
      items: [rawItem({ componentSourceId: 'PN-9001' }), rawItem({ componentSourceId: 'PN-9002' })],
    }
    const root = await runWithDryRun(planWithMissing(list))

    const box = q(root, 'stock-prep-project-sync-missing-components')
    expect(box, 'items are present even though distinctCount clamped to 0 — must still render').not.toBeNull()
    expect(box!.textContent).toContain('缺件 2 种')
    expect(qa(root, 'stock-prep-project-sync-missing-components-row').length).toBe(2)
  })

  it('M5-02: {distinctCount:5, items:[]} renders the count line but NOT an empty table or dead buttons', async () => {
    const root = await runWithDryRun(planWithMissing({ distinctCount: 5, probeCount: 5, truncated: false, items: [] }))

    const box = q(root, 'stock-prep-project-sync-missing-components')
    expect(box, 'distinctCount > 0 alone is enough to render the disclosure').not.toBeNull()
    expect(box!.textContent).toContain('缺件 5 种')
    // ...but there is nothing to list or act on.
    expect(qa(root, 'stock-prep-project-sync-missing-components-row').length).toBe(0)
    expect(q(root, 'stock-prep-project-sync-missing-components-copy')).toBeNull()
    expect(q(root, 'stock-prep-project-sync-missing-components-export')).toBeNull()
  })

  it('R-03 (B2): truncated renders an HONEST notice, and exporting it yields exactly 201 lines (header + 200), never "全量"', async () => {
    // Self-contained Blob/URL/anchor mocking (not shared with the E-01 describe below) so this test
    // can stay under the plain rendering describe while still driving the real export.
    const OriginalBlob = Blob
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    let createdBlobParts: string[] = []
    globalThis.Blob = class TestBlob extends OriginalBlob {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        createdBlobParts = Array.isArray(parts) ? parts.map((part) => String(part)) : []
        super(parts, options)
      }
    } as typeof Blob
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:r03') })
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    try {
      const items = Array.from({ length: 205 }, (_, i) => rawItem({ componentSourceId: `PN-${i}` }))
      const root = await runWithDryRun(planWithMissing({ distinctCount: 205, probeCount: 500, truncated: true, items }))

      const notice = q(root, 'stock-prep-project-sync-missing-components-truncated')
      expect(notice).not.toBeNull()
      expect(notice!.textContent).toContain('200')
      expect(notice!.textContent).toContain('205')
      // The design's original wording claimed the export was "全量" (the full list) — it is not; the
      // client holds at most 200 rows, and the export is exactly those 200.
      expect(notice!.textContent).not.toContain('全量')

      ;(q(root, 'stock-prep-project-sync-missing-components-export') as HTMLButtonElement).click()
      await flush()

      const csvText = createdBlobParts.join('')
      const lines = csvText.replace(/^\ufeff/, '').split('\n')
      expect(lines.length).toBe(201) // header + 200 rows — NEVER "all 205"
    } finally {
      globalThis.Blob = OriginalBlob
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL })
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL })
      clickSpy.mockRestore()
    }
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

  it('B1 line (fix #3): scope_denied renders the -unavailable hint line', async () => {
    const readyCounts = { add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }
    // scope_denied is ACTIONABLE (wrong account/tenant) — the line renders.
    const root = await runWithDryRun(
      planWithMissing(null, { status: 'ready', counts: readyCounts, missingComponentsUnavailableReason: 'scope_denied' }),
    )
    const hint = q(root, 'stock-prep-project-sync-missing-components-unavailable')
    expect(hint, 'scope_denied must render the hint line').not.toBeNull()
    expect(hint!.textContent).toContain('操作员权限')
    // The missing-components disclosure itself must NOT render — there is nothing to show.
    expect(q(root, 'stock-prep-project-sync-missing-components')).toBeNull()
  })

  it('B1 line (fix #3): server_unsupported renders NOTHING (no -unavailable hint)', async () => {
    const readyCounts = { add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }
    // server_unsupported is a DEPLOYMENT-VERSION fact, not something an operator can act on — silent.
    const root = await runWithDryRun(
      planWithMissing(null, { status: 'ready', counts: readyCounts, missingComponentsUnavailableReason: 'server_unsupported' }),
    )
    expect(
      q(root, 'stock-prep-project-sync-missing-components-unavailable'),
      'server_unsupported must render NOTHING',
    ).toBeNull()
  })
})

// =============================================================================================
// X-01/X-02 — 复制 (clipboard); X-03 uses fake timers for the 3s auto-reset (fix #9)
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

  it('X-01: 复制 puts a TAB-separated 7-column block on the clipboard — RAW parent id, no on-screen badge — guard live', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

    const list = {
      distinctCount: 1,
      probeCount: 1,
      truncated: false,
      items: [rawItem({
        componentSourceId: '=cmd|A1',
        parentSourceId: 'ASM-A',
        bomId: 'BOM-1',
        path: JSON.stringify(['ASM-A', '=cmd|A1']), // server's actual wire shape — see rawItem()'s comment
        depth: 1,
        occurrenceCount: 1,
        parentCount: 3, // > 1 — would show the "(+3 处)" badge ON SCREEN; must NOT appear in the copy.
      })],
    }
    const root = await runWithDryRun(planWithMissing(list))

    ;(q(root, 'stock-prep-project-sync-missing-components-copy') as HTMLButtonElement).click()
    await flush()

    expect(writeText).toHaveBeenCalledTimes(1)
    const tsv = writeText.mock.calls[0][0] as string
    const lines = tsv.split('\n')
    expect(lines[0].split('\t')).toEqual(['零件号', '父件', '所在 BOM', '层级', '次数', '涉及父件数', '路径'])
    const cells = lines[1].split('\t')
    // The injection guard is LIVE in the copied text, not only in the CSV export path.
    expect(cells[0]).toBe("'=cmd|A1")
    // Parent column is the RAW id — no badge text, no "处" anywhere in the row.
    expect(cells[1]).toBe('ASM-A')
    expect(cells[2]).toBe('BOM-1')
    expect(cells[3]).toBe('1')
    expect(cells[4]).toBe('1')
    expect(cells[5]).toBe('3') // parentCount as its OWN column
    // path is JSON.parse'd and joined with ' / ' — never the raw ["ASM-A","=cmd|A1"] JSON text.
    expect(cells[6]).toBe('ASM-A / =cmd|A1')
    expect(tsv).not.toContain('处')

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

  it('X-03 (fix #9): the copy button label resets to idle 3 seconds later', async () => {
    // Fake timers ONLY for this test (restored in `finally`) — the shared `flush()` helper relies on
    // a REAL `setTimeout(0)` to drain the run's promise chain, so it is not used here. Vue's own
    // scheduler and the mocked API's resolved promises are plain microtasks, which fake timers do not
    // affect, so plain `await Promise.resolve()` / `await nextTick()` cycles flush them regardless.
    vi.useFakeTimers()
    try {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })

      const root = mountPanel(api({
        dryRun: vi.fn().mockResolvedValue(planWithMissing({
          distinctCount: 1, probeCount: 1, truncated: false, items: [rawItem()],
        })),
      }))
      const input = q(root, 'stock-prep-project-sync-project-no') as HTMLInputElement
      input.value = PROJECT_NO
      input.dispatchEvent(new Event('input'))
      await nextTick()
      ;(q(root, 'stock-prep-project-sync-run') as HTMLButtonElement).click()
      for (let i = 0; i < 8; i += 1) { await Promise.resolve(); await nextTick() }

      const button = q(root, 'stock-prep-project-sync-missing-components-copy') as HTMLButtonElement
      button.click()
      for (let i = 0; i < 8; i += 1) { await Promise.resolve(); await nextTick() }
      expect(button.textContent).toContain('已复制')

      await vi.advanceTimersByTimeAsync(2999)
      await nextTick()
      expect(button.textContent, 'still shows "已复制" a moment before 3s').toContain('已复制')

      await vi.advanceTimersByTimeAsync(1)
      await nextTick()
      expect(button.textContent, 'reset to the idle "复制" label at 3s').not.toContain('已复制')
      expect(button.textContent).toContain('复制')
    } finally {
      vi.useRealTimers()
    }
  })
})

// =============================================================================================
// E-01/E-02 — 导出 CSV, driving the REAL downloadCsvFile (Blob captured, anchor click spied — not
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

  it('E-01: downloads missing-components-{projectNo}-{YYYYMMDD}.csv, 7 columns, RAW parent id, guard live', async () => {
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
    expect(csvText).toContain('零件号,父件,所在 BOM,层级,次数,涉及父件数,路径')
    // The injection guard fired on the exported file too.
    expect(csvText).toContain("'=cmd|A1")
    // Full row check: RAW parent id (no badge), plus the parentCount/path columns the table hides.
    // path is the DECODED/JOINED form (fix #2) — the default fixture's raw wire value is
    // `["ASM-100","PN-0001"]`, which becomes "ASM-100 / PN-0001", never the raw JSON text.
    expect(csvText).toContain("'=cmd|A1,ASM-A,BOM-1,2,3,1,ASM-100 / PN-0001")
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(1)
  })

  it('E-02 (fix #9): a project number with filesystem-hostile characters is sanitized in the filename', async () => {
    const root = mountPanel(api({
      dryRun: vi.fn().mockResolvedValue(planWithMissing({
        distinctCount: 1, probeCount: 1, truncated: false, items: [rawItem()],
      })),
    }))
    const dirtyProjectNo = 'P/2026:007?"<>|*'
    const input = q(root, 'stock-prep-project-sync-project-no') as HTMLInputElement
    input.value = dirtyProjectNo
    input.dispatchEvent(new Event('input'))
    await nextTick()
    ;(q(root, 'stock-prep-project-sync-run') as HTMLButtonElement).click()
    await flush()

    ;(q(root, 'stock-prep-project-sync-missing-components-export') as HTMLButtonElement).click()
    await flush()

    expect(clickedAnchors.length).toBe(1)
    const filename = clickedAnchors[0].download
    expect(filename).not.toMatch(/[\\/:*?"<>|]/)
    // 'P/2026:007?"<>|*' → each of / : ? " < > | * becomes its own '_' (6 of them run together after "007").
    expect(filename).toMatch(/^missing-components-P_2026_007_{6}-\d{8}\.csv$/)
  })
})

// =============================================================================================
// B1 — dry-run flag fallback: merging THIS PR alone (server-side W3a PR not merged yet, or this
// caller's operator-scope check refused) must not sink the sync. `createStockPreparationProjectSyncApi`
// retries the SAME dry-run once, without `includeMissingComponents`, for exactly two reasons — and
// the whole 4-step run completes normally afterward. Drives the REAL wire-level api (apiFetch mocked
// at the module boundary, not the injected `StockPreparationProjectSyncApi` double the rest of this
// file uses) because the retry logic lives inside `createStockPreparationProjectSyncApi`'s `dryRun`.
// =============================================================================================

describe('createStockPreparationProjectSyncApi — dry-run flag fallback (B1)', () => {
  beforeEach(() => {
    h.apiFetch.mockReset()
  })

  function bodyOf(call: unknown[]): Record<string, unknown> {
    const init = call[1] as RequestInit | undefined
    return JSON.parse(String(init?.body ?? '{}'))
  }

  /** Wires apiFetch: dry-run answers come from `dryRunResponses` in order; apply/mvp-persist succeed trivially. */
  function wireApi(dryRunResponses: Response[]): unknown[][] {
    const calls: unknown[][] = []
    let dryRunCallIndex = 0
    h.apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push([url, init])
      const route = String(url)
      if (route.includes('/dry-run')) {
        const response = dryRunResponses[Math.min(dryRunCallIndex, dryRunResponses.length - 1)]
        dryRunCallIndex += 1
        return response
      }
      if (route.includes('/apply')) {
        return new Response(JSON.stringify({
          ok: true,
          data: { status: 'succeeded', apply: { counts: { created: 0, updated: 0, inactive: 0, skipped: 0, held: 0, failed: 0 } } },
        }), { status: 200 })
      }
      if (route.includes('/mvp-persist')) {
        return new Response(JSON.stringify({
          ok: true,
          data: { status: 'created', persisted: true, created: { batch: 1, lines: 1, run: 1 } },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 })
    })
    return calls
  }

  it('B1-01: 400 TABLE_ACTION_REQUEST_INVALID retries once without the flag → server_unsupported, all 4 steps complete', async () => {
    const calls = wireApi([
      new Response(JSON.stringify({ ok: false, error: { code: 'TABLE_ACTION_REQUEST_INVALID' } }), { status: 400 }),
      new Response(JSON.stringify({ ok: true, data: { status: 'ready', canApply: true, dryRunToken: 'tok', counts: {} } }), { status: 200 }),
    ])
    const apiClient = createStockPreparationProjectSyncApi({})
    const report = await runStockPreparationProjectSync(apiClient, 'P1')

    const dryRunCalls = calls.filter((call) => String(call[0]).includes('/dry-run'))
    expect(dryRunCalls.length).toBe(2)
    expect(bodyOf(dryRunCalls[0]).includeMissingComponents).toBe(true)
    // The SECOND request body carries NO flag at all.
    expect(bodyOf(dryRunCalls[1]).includeMissingComponents).toBeUndefined()

    expect(report.missingComponents).toBeNull()
    expect(report.missingComponentsUnavailableReason).toBe('server_unsupported')
    // 四步照常 — the add-on feature failing never sinks the sync itself.
    expect(report.steps.length).toBe(4)
    expect(report.pass).toBe(true)
    expect(report.steps[0].status).toBe('ok')
  })

  it('B1-02: 403 OPERATOR_SCOPE_* retries once without the flag → scope_denied, all 4 steps complete', async () => {
    const calls = wireApi([
      new Response(JSON.stringify({ ok: false, error: { code: 'OPERATOR_SCOPE_TENANT_REQUIRED' } }), { status: 403 }),
      new Response(JSON.stringify({ ok: true, data: { status: 'ready', canApply: true, dryRunToken: 'tok', counts: {} } }), { status: 200 }),
    ])
    const apiClient = createStockPreparationProjectSyncApi({})
    const report = await runStockPreparationProjectSync(apiClient, 'P1')

    const dryRunCalls = calls.filter((call) => String(call[0]).includes('/dry-run'))
    expect(dryRunCalls.length).toBe(2)
    expect(bodyOf(dryRunCalls[1]).includeMissingComponents).toBeUndefined()

    expect(report.missingComponents).toBeNull()
    expect(report.missingComponentsUnavailableReason).toBe('scope_denied')
    expect(report.steps.length).toBe(4)
    expect(report.pass).toBe(true)
  })

  it('B1-03: an ORDINARY dry-run failure (not a flag-support problem) is NOT retried and surfaces normally', async () => {
    const calls = wireApi([
      new Response(JSON.stringify({ ok: false, error: { code: 'TABLE_ACTION_SOURCE_NOT_ACTIVE' } }), { status: 404 }),
    ])
    const apiClient = createStockPreparationProjectSyncApi({})
    const report = await runStockPreparationProjectSync(apiClient, 'P1')

    const dryRunCalls = calls.filter((call) => String(call[0]).includes('/dry-run'))
    expect(dryRunCalls.length, 'no silent retry for a REAL failure').toBe(1)
    expect(report.pass).toBe(false)
    expect(report.missingComponentsUnavailableReason).toBeNull()
  })

  it('B1-04: a SECOND dry-run failure (still 400) is NOT retried again — exactly one retry, no loop', async () => {
    const calls = wireApi([
      new Response(JSON.stringify({ ok: false, error: { code: 'TABLE_ACTION_REQUEST_INVALID' } }), { status: 400 }),
      new Response(JSON.stringify({ ok: false, error: { code: 'TABLE_ACTION_REQUEST_INVALID' } }), { status: 400 }),
      // A THIRD response — if the implementation looped, it would be consumed here. It must never be
      // reached: the dry-run-calls count below is what actually proves that, regardless of what this
      // response says.
      new Response(JSON.stringify({ ok: true, data: { status: 'ready', canApply: true, dryRunToken: 'tok', counts: {} } }), { status: 200 }),
    ])
    const apiClient = createStockPreparationProjectSyncApi({})
    const report = await runStockPreparationProjectSync(apiClient, 'P1')

    const dryRunCalls = calls.filter((call) => String(call[0]).includes('/dry-run'))
    expect(dryRunCalls.length, 'exactly one retry, never a third call').toBe(2)
    // The retry's OWN failure surfaces as a real failure — it does not silently succeed by falling
    // through to whatever the (never-reached) third mock response would have said.
    expect(report.pass).toBe(false)
    expect(report.steps[0].status).toBe('fail')
    expect(report.missingComponentsUnavailableReason).toBeNull()
  })

  it('B1-05: a 403 that is NOT an OPERATOR_SCOPE_* code (e.g. a plain FORBIDDEN) is not retried', async () => {
    const calls = wireApi([
      new Response(JSON.stringify({ ok: false, error: { code: 'FORBIDDEN' } }), { status: 403 }),
    ])
    const apiClient = createStockPreparationProjectSyncApi({})
    const report = await runStockPreparationProjectSync(apiClient, 'P1')

    const dryRunCalls = calls.filter((call) => String(call[0]).includes('/dry-run'))
    expect(dryRunCalls.length, 'no retry for a 403 outside the OPERATOR_SCOPE_* vocabulary').toBe(1)
    expect(report.pass).toBe(false)
    expect(report.missingComponentsUnavailableReason).toBeNull()
  })
})
