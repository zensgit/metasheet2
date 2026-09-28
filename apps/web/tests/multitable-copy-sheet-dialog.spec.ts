/**
 * 复制数据表（含数据）S1 — frontend contract (ADR docs/development/multitable-copy-sheet-with-data-adr-20260926.md).
 *
 * Two layers, both against the ADR's wire contract (the S1 backend is built in parallel):
 *   A. MultitableApiClient: URL + request body of `…/copy/dry-run` and `…/copy`, the `Idempotent-Replayed`
 *      header, the single provenance adapter (readSheetCopiedFrom), and the refusal shape (CopySheetError
 *      carries code + ADR extras, NEVER the server's message).
 *   B. MetaCopySheetDialog: default name, withData toggle -> request body, fixed S1 controls, disclosure
 *      lines, every ADR refusal code -> its zh sentence (no cell values, no raw enums, no counts on the
 *      403), busy state, success emit.
 *
 * Values-free probe: every refusal body below carries a sentinel cell value in its `message`
 * (`机密值-4242` / `SECRET-4242`); the DOM must never contain it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive, type App } from 'vue'
import MetaCopySheetDialog from '../src/multitable/components/MetaCopySheetDialog.vue'
import {
  MultitableApiClient,
  buildCopySheetError,
  buildCopySheetRequestBody,
  isCopySheetError,
  readSheetCopiedFrom,
} from '../src/multitable/api/client'
import type { CopySheetDryRunResult, CopySheetInput, CopySheetResult } from '../src/multitable/types'
import { useLocale } from '../src/composables/useLocale'

const SENTINEL_ZH = '机密值-4242'
const SENTINEL_EN = 'SECRET-4242'
const leakyMessage = `value ${SENTINEL_EN} (${SENTINEL_ZH}) is not an allowed option`

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

async function flush(cycles = 6): Promise<void> {
  for (let i = 0; i < cycles; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

describe('MultitableApiClient — copy sheet wire (ADR §7.1 / §8)', () => {
  it('dry-run POSTs the ADR body to /sheets/:id/copy/dry-run and normalizes the disclosures', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      data: {
        rowCount: 1239,
        fieldCount: 55,
        overLimit: false,
        rowLimit: 2000,
        disclosures: [
          { fieldId: 'fld_att', reason: 'ATTACHMENT_BLANKED' },
          { fieldId: 'fld_mirror', code: 'MIRROR_NOT_BUILT' },
          { code: 'VIEW_FILTER_LEAF_DROPPED', viewId: 'view_a', count: 2 },
          { fieldId: '', reason: 'ATTACHMENT_BLANKED' },
          'junk',
        ],
        autoNumberRenumberedRows: 7,
      },
    }))
    const client = new MultitableApiClient({ fetchFn })
    const result = await client.dryRunCopySheet('sheet/orders', { name: '  订单 副本  ', withData: true, permissionMode: 'inherit' })

    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('/api/multitable/sheets/sheet%2Forders/copy/dry-run')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ name: '订单 副本', withData: true, permissionMode: 'inherit' })
    expect(result).toEqual<CopySheetDryRunResult>({
      rowCount: 1239,
      fieldCount: 55,
      overLimit: false,
      rowLimit: 2000,
      fieldDisclosures: [
        { fieldId: 'fld_att', reason: 'ATTACHMENT_BLANKED' },
        { fieldId: 'fld_mirror', reason: 'MIRROR_NOT_BUILT' },
      ],
      viewFilterLeavesDropped: [{ viewId: 'view_a', count: 2 }],
      autoNumberRenumberedRows: 7,
    })
  })

  // Exact route bodies of backend PR #6112 (routes/multitable-copy-sheet.ts @ 2b95e1f70): `buildSuccessBody`
  // + post-commit `formulaRecompute`, the dry-run's `{ summary: plan.summary }`, and `fail()`'s
  // `{ code, message, details? }` with the service's CopySheetError details.
  const ROUTE_SUMMARY = {
    sourceSheetId: 'sheet_orders', sourceName: '订单', baseId: 'base_ops', targetName: '订单 副本',
    copiedFromKind: 'user', rowCount: 10, fieldCount: 5, builtFieldCount: 4, viewCount: 2,
    disclosures: [{ fieldId: 'fld_m', code: 'MIRROR_NOT_BUILT' }],
    droppedViewFilterLeaves: [{ viewId: 'view_b', count: 1 }],
    autoNumberRenumberedRows: 3, nullCellsOmitted: 6,
    permissionRowCount: 3, fieldPermissionRowCount: 2, viewPermissionRowCount: 1, recordPermissionRowCount: 4,
    rowLevelReadEnabled: false, conditionalRuleCount: 0,
    notCopied: ['automations', 'comments'], limits: { maxRows: 2000, maxFields: 500 },
  }

  it('copy POSTs to /sheets/:id/copy and reads the route 201: sheet, Idempotent-Replayed, formulaRecompute, summary', async () => {
    const body = {
      ok: true,
      data: {
        sheet: { id: 'sheet_copy', baseId: 'base_ops', name: '订单 副本', copiedFrom: { kind: 'user', at: null, sheetId: 'sheet_orders' } },
        summary: ROUTE_SUMMARY,
        batchId: 'batch_1',
        formulaRecompute: { attempted: 10, recomputed: 8, failed: true, errorCode: 'BULK_RECOMPUTE_FAILED' },
      },
    }
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse(201, body, { 'Idempotent-Replayed': 'true' }))
      .mockResolvedValueOnce(jsonResponse(201, { ok: true, data: { ...body.data, formulaRecompute: undefined } }))
    const client = new MultitableApiClient({ fetchFn })

    const replay = await client.copySheet('sheet_orders', { name: '订单 副本', withData: false, permissionMode: 'inherit' })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('/api/multitable/sheets/sheet_orders/copy')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ name: '订单 副本', withData: false, permissionMode: 'inherit' })
    expect(replay.replayed).toBe(true)
    expect(replay.sheet).toMatchObject({ id: 'sheet_copy', baseId: 'base_ops', name: '订单 副本' })
    expect(replay.formulaRecompute).toEqual({ attempted: 10, recomputed: 8, failed: true, errorCode: 'BULK_RECOMPUTE_FAILED' })
    // columns = builtFieldCount (the mirror is not built); grants = table 3 + field 2 + view 1 + record 4,
    // so 「10 条授权（含 4 条记录级）」 really contains the record-level ones (ADR §3).
    expect(replay.summary).toEqual({ rowCount: 10, fieldCount: 4, permissionRowCount: 10, recordPermissionRowCount: 4 })

    const fresh = await client.copySheet('sheet_orders', { withData: true, permissionMode: 'inherit' })
    expect(fresh.replayed).toBe(false)
    expect(fresh.formulaRecompute).toBeNull()
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toEqual({ withData: true, permissionMode: 'inherit' })
  })

  it('reads the route dry-run 200 `{ summary: CopySheetPlanSummary }`', async () => {
    const client = new MultitableApiClient({ fetchFn: vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, data: { summary: ROUTE_SUMMARY } })) })
    expect(await client.dryRunCopySheet('s', { withData: true, permissionMode: 'inherit' })).toEqual<CopySheetDryRunResult>({
      rowCount: 10,
      fieldCount: 5,
      overLimit: false,
      rowLimit: 2000,
      fieldDisclosures: [{ fieldId: 'fld_m', reason: 'MIRROR_NOT_BUILT' }],
      viewFilterLeavesDropped: [{ viewId: 'view_b', count: 1 }],
      autoNumberRenumberedRows: 3,
    })
  })

  it('reads the route refusals: nested details, the outer code wins, and no extras outside their own code', () => {
    // Row failure: fail(422, 'COPY_ROW_VALIDATION_FAILED', { rowIndex, fieldId, code: <record code> }).
    const row = buildCopySheetError(422, { ok: false, error: { code: 'COPY_ROW_VALIDATION_FAILED', message: 'x', details: { rowIndex: 7, fieldId: 'fld_qty', code: 'VALIDATION_ERROR' } } }, true)
    expect(row).toMatchObject({ code: 'COPY_ROW_VALIDATION_FAILED', rowIndex: 7, fieldId: 'fld_qty' })
    const permissionRow = buildCopySheetError(500, { ok: false, error: { code: 'COPY_ROW_VALIDATION_FAILED', details: { rowIndex: 0, fieldId: null, code: 'RECORD_PERMISSION' } } }, true)
    expect(permissionRow).toMatchObject({ code: 'COPY_ROW_VALIDATION_FAILED', rowIndex: 0 })
    expect(permissionRow.fieldId).toBeUndefined()

    const fields = buildCopySheetError(413, { ok: false, error: { code: 'COPY_TOO_MANY_FIELDS', details: { fieldCount: 612, limit: 500 } } }, true)
    expect(fields).toMatchObject({ code: 'COPY_TOO_MANY_FIELDS', fieldCount: 612, limit: 500 })
    expect(fields.rowCount).toBeUndefined()
    const rows = buildCopySheetError(413, { ok: false, error: { code: 'COPY_TOO_LARGE', details: { rowCount: 2400, limit: 2000 } } }, true)
    expect(rows).toMatchObject({ code: 'COPY_TOO_LARGE', rowCount: 2400, limit: 2000 })

    const structural = buildCopySheetError(422, { ok: false, error: { code: 'COPY_LINK_TARGET_NOT_LIVE', details: { fieldId: 'fld_link' } } }, true)
    expect(structural).toMatchObject({ code: 'COPY_LINK_TARGET_NOT_LIVE', fieldId: 'fld_link' })
    // view-level structural refusal (copy-sheet-service forwards `{ viewId }` from CopySheetRemapError)
    const viewLevel = buildCopySheetError(422, { ok: false, error: { code: 'COPY_UNMAPPED_FIELD_REF', details: { viewId: 'view_1' } } }, true)
    expect(viewLevel).toMatchObject({ code: 'COPY_UNMAPPED_FIELD_REF', viewId: 'view_1' })
    expect(viewLevel.fieldId).toBeUndefined()
    // viewId never rides on a 403, on a non-structural code, or on a non-422 status
    expect(buildCopySheetError(403, { ok: false, error: { code: 'COPY_UNMAPPED_FIELD_REF', details: { viewId: 'view_1' } } }, true).viewId).toBeUndefined()
    expect(buildCopySheetError(422, { ok: false, error: { code: 'COPY_SOURCE_SYSTEM_SHEET', details: { viewId: 'view_1' } } }, true).viewId).toBeUndefined()
    expect(buildCopySheetError(422, { ok: false, error: { code: 'COPY_ROW_VALIDATION_FAILED', details: { rowIndex: 1, viewId: 'view_1' } } }, true).viewId).toBeUndefined()

    // A non-COPY code carrying row-shaped extras is NOT promoted to a row failure, and a 403 carries nothing.
    const other = buildCopySheetError(422, { ok: false, error: { code: 'VALIDATION_ERROR', details: { rowIndex: 7, fieldId: 'fld_qty' } } }, true)
    expect(other.code).toBe('VALIDATION_ERROR')
    expect([other.rowIndex, other.fieldId]).toEqual([undefined, undefined])
    const gate = buildCopySheetError(403, { ok: false, error: { code: 'COPY_SOURCE_NOT_FULLY_READABLE', details: { rowIndex: 2, fieldId: 'fld_hidden', fieldCount: 3, rowCount: 4, limit: 9 } } }, true)
    expect([gate.rowIndex, gate.fieldId, gate.fieldCount, gate.rowCount, gate.limit]).toEqual([undefined, undefined, undefined, undefined, undefined])
    const gateStructural = buildCopySheetError(403, { ok: false, error: { code: 'COPY_UNMAPPED_FIELD_REF', details: { fieldId: 'fld_hidden' } } }, true)
    expect(gateStructural.fieldId).toBeUndefined()
  })

  it('a 201 whose data has no `sheet` object is a broken answer and throws (the route always sends one)', async () => {
    const client = new MultitableApiClient({
      fetchFn: vi.fn().mockResolvedValue(jsonResponse(201, { ok: true, data: { sheetId: 'sheet_new', baseId: 'base_ops', name: 'x', summary: ROUTE_SUMMARY } })),
    })
    await expect(client.copySheet('s', { withData: true, permissionMode: 'inherit' })).rejects.toThrow('Invalid copy sheet response')
  })

  it('pins permissionMode to "inherit" and withData to strict-boolean whatever the caller passes', () => {
    const rogue = { withData: 'yes', permissionMode: 'private', name: '   ' } as unknown as CopySheetInput
    expect(buildCopySheetRequestBody(rogue)).toEqual({ withData: false, permissionMode: 'inherit' })
  })

  it('refusals become CopySheetError with code + ADR extras, and the server message is dropped', async () => {
    const fetchFn = vi.fn()
      // A misbehaving backend attaching counts / a column id to the gate refusal: none may survive.
      .mockResolvedValueOnce(jsonResponse(403, {
        ok: false,
        error: { code: 'COPY_SOURCE_NOT_FULLY_READABLE', message: leakyMessage, rowCount: 99, limit: 2000, fieldId: 'fld_hidden', rowIndex: 3 },
      }))
      .mockResolvedValueOnce(jsonResponse(422, {
        ok: false,
        error: { code: 'COPY_ROW_VALIDATION_FAILED', message: leakyMessage, details: { firstFailure: { rowIndex: 4, fieldId: 'fld_qty', code: 'VALIDATION_ERROR' } } },
      }))
      .mockResolvedValueOnce(jsonResponse(413, { ok: false, error: { code: 'COPY_TOO_LARGE', message: leakyMessage, rowCount: 2400, limit: 2000 } }))
    const client = new MultitableApiClient({ fetchFn, isZh: true })

    const gate = await client.dryRunCopySheet('s', { withData: true, permissionMode: 'inherit' }).catch((e) => e)
    expect(isCopySheetError(gate)).toBe(true)
    expect(gate).toMatchObject({ status: 403, code: 'COPY_SOURCE_NOT_FULLY_READABLE' })
    expect(gate.rowCount).toBeUndefined()
    expect(gate.limit).toBeUndefined()
    expect(gate.fieldId).toBeUndefined()
    expect(gate.rowIndex).toBeUndefined()

    const row = await client.copySheet('s', { withData: true, permissionMode: 'inherit' }).catch((e) => e)
    expect(row).toMatchObject({ status: 422, code: 'COPY_ROW_VALIDATION_FAILED', rowIndex: 4, fieldId: 'fld_qty' })

    const size = await client.copySheet('s', { withData: true, permissionMode: 'inherit' }).catch((e) => e)
    expect(size).toMatchObject({ status: 413, code: 'COPY_TOO_LARGE', rowCount: 2400, limit: 2000 })

    for (const err of [gate, row, size]) {
      expect(err.message).not.toContain(SENTINEL_EN)
      expect(err.message).not.toContain(SENTINEL_ZH)
    }
  })

  it('readSheetCopiedFrom is the single provenance adapter and fails closed', () => {
    expect(readSheetCopiedFrom({ id: 's' })).toBeNull()
    expect(readSheetCopiedFrom({ id: 's', copiedFrom: null })).toBeNull()
    expect(readSheetCopiedFrom({ id: 's', copiedFrom: 'plugin-managed' })).toBeNull()
    expect(readSheetCopiedFrom({ id: 's', copiedFrom: { kind: '  ' } })).toBeNull()
    expect(readSheetCopiedFrom(null)).toBeNull()
    expect(readSheetCopiedFrom({ id: 's', copiedFrom: { kind: 'user', at: '2026-09-27T00:00:00Z' } }))
      .toEqual({ kind: 'user', pluginManaged: false, at: '2026-09-27T00:00:00Z' })
    expect(readSheetCopiedFrom({ id: 's', copiedFrom: { kind: 'plugin-managed' } }))
      .toEqual({ kind: 'plugin-managed', pluginManaged: true, at: null })
  })
})

// ---------------------------------------------------------------------------------------------------

const FIELDS = [
  { id: 'fld_title', name: '标题' },
  { id: 'fld_att', name: '图纸' },
  { id: 'fld_qty', name: '数量' },
  { id: 'fld_mirror', name: '镜像' },
  { id: 'fld_lookup', name: '供应商名称' },
  { id: 'fld_btn', name: '推送' },
  { id: 'fld_self', name: '父项' },
]
const VIEWS = [{ id: 'view_a', name: '按录入先后' }]

function dryRunOk(overrides: Partial<CopySheetDryRunResult> = {}): CopySheetDryRunResult {
  return {
    rowCount: 1239,
    fieldCount: 7,
    overLimit: false,
    rowLimit: 2000,
    fieldDisclosures: [],
    viewFilterLeavesDropped: [],
    autoNumberRenumberedRows: 0,
    ...overrides,
  }
}

function copyOk(): CopySheetResult {
  return {
    sheet: { id: 'sheet_copy', baseId: 'base_ops', name: '订单 副本' },
    replayed: false,
    formulaRecompute: null,
    summary: { rowCount: 1239, fieldCount: 7, permissionRowCount: 3, recordPermissionRowCount: 0 },
  }
}

function copyErr(status: number, error: Record<string, unknown>) {
  return buildCopySheetError(status, { ok: false, error: { message: leakyMessage, ...error } }, true)
}

type Mounted = { app: App<Element>; container: HTMLDivElement }

describe('MetaCopySheetDialog', () => {
  let mounted: Mounted | null = null
  let client: { dryRunCopySheet: ReturnType<typeof vi.fn>; copySheet: ReturnType<typeof vi.fn> }
  let onCopied: ReturnType<typeof vi.fn>
  let onClose: ReturnType<typeof vi.fn>
  let state: { visible: boolean; sheetId: string; sheetName: string; baseName: string }

  beforeEach(() => {
    useLocale().setLocale('zh-CN')
    client = { dryRunCopySheet: vi.fn().mockResolvedValue(dryRunOk()), copySheet: vi.fn().mockResolvedValue(copyOk()) }
    onCopied = vi.fn()
    onClose = vi.fn()
    state = reactive({ visible: true, sheetId: 'sheet_orders', sheetName: '订单', baseName: '备料' })
  })

  afterEach(() => {
    if (mounted) {
      mounted.app.unmount()
      mounted.container.remove()
    }
    mounted = null
    useLocale().setLocale('en')
    vi.clearAllMocks()
  })

  async function mount(): Promise<void> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const app = createApp({
      setup: () => () => h(MetaCopySheetDialog, {
        ...state,
        fields: FIELDS,
        views: VIEWS,
        client,
        onCopied,
        onClose,
      }),
    })
    app.mount(container)
    mounted = { app, container }
    await flush()
  }

  const q = <T extends Element = HTMLElement>(id: string) => document.body.querySelector(`[data-testid="${id}"]`) as T | null
  const submitButton = () => q<HTMLButtonElement>('copy-sheet-submit')!
  const errorText = () => q('copy-sheet-error')?.textContent?.trim() ?? ''

  it('opens with the ADR defaults: name 「<源表名> 副本」, source read-only, Base + permission fixed and disabled', async () => {
    await mount()
    expect(q('copy-sheet-dialog')).not.toBeNull()
    expect(q<HTMLInputElement>('copy-sheet-name')!.value).toBe('订单 副本')
    const source = q<HTMLInputElement>('copy-sheet-source')!
    expect(source.value).toBe('订单')
    expect(source.readOnly).toBe(true)
    const base = q<HTMLSelectElement>('copy-sheet-target-base')!
    expect(base.disabled).toBe(true)
    expect(base.textContent).toContain('备料')
    const permission = q<HTMLSelectElement>('copy-sheet-permission-mode')!
    expect(permission.disabled).toBe(true)
    expect(permission.textContent?.trim()).toBe('与源表相同')
    expect(permission.value).toBe('inherit')
    const withData = q<HTMLInputElement>('copy-sheet-with-data')!
    expect(withData.checked).toBe(true)
    expect(q('copy-sheet-with-data-label')!.textContent).toBe('包含数据（共 1239 行）')
    // one zero-write probe, WITH data, inherit
    expect(client.dryRunCopySheet).toHaveBeenCalledTimes(1)
    // probed WITHOUT a name: the route refuses a mangled name, and the plan does not depend on it
    expect(client.dryRunCopySheet).toHaveBeenCalledWith('sheet_orders', { withData: true, permissionMode: 'inherit' })
  })

  it('en default name is "<name> copy"', async () => {
    useLocale().setLocale('en')
    state.sheetName = 'Orders'
    await mount()
    expect(q<HTMLInputElement>('copy-sheet-name')!.value).toBe('Orders copy')
    expect(q('copy-sheet-with-data-label')!.textContent).toBe('Include data (1239 rows)')
  })

  it('submits { name, withData: true, permissionMode: inherit } by default and emits copied', async () => {
    await mount()
    submitButton().click()
    await flush()
    expect(client.copySheet).toHaveBeenCalledTimes(1)
    expect(client.copySheet).toHaveBeenCalledWith('sheet_orders', { name: '订单 副本', withData: true, permissionMode: 'inherit' })
    expect(onCopied).toHaveBeenCalledTimes(1)
    expect(onCopied.mock.calls[0][0]).toEqual(copyOk())
  })

  it('unticking 「包含数据」 sends withData: false; an edited name is sent trimmed', async () => {
    await mount()
    const withData = q<HTMLInputElement>('copy-sheet-with-data')!
    withData.click()
    await flush()
    expect(withData.checked).toBe(false)
    const name = q<HTMLInputElement>('copy-sheet-name')!
    name.value = '  备料快照  '
    name.dispatchEvent(new Event('input'))
    await flush()
    submitButton().click()
    await flush()
    expect(client.copySheet).toHaveBeenCalledWith('sheet_orders', { name: '备料快照', withData: false, permissionMode: 'inherit' })
  })

  it('an empty name is reported locally and nothing is sent', async () => {
    await mount()
    const name = q<HTMLInputElement>('copy-sheet-name')!
    name.value = '   '
    name.dispatchEvent(new Event('input'))
    await flush()
    submitButton().click()
    await flush()
    expect(client.copySheet).not.toHaveBeenCalled()
    expect(errorText()).toBe('请输入新数据表名称。')
  })

  it('renders every dry-run disclosure by column NAME (grouped by reason), never a raw reason code', async () => {
    client.dryRunCopySheet.mockResolvedValue(dryRunOk({
      fieldDisclosures: [
        { fieldId: 'fld_att', reason: 'ATTACHMENT_BLANKED' },
        { fieldId: 'fld_self', reason: 'SELF_LINK_BLANKED' },
        { fieldId: 'fld_mirror', reason: 'MIRROR_NOT_BUILT' },
        { fieldId: 'fld_lookup', reason: 'DEPENDS_ON_BLANKED_COLUMN' },
        { fieldId: 'fld_btn', reason: 'BUTTON_DISABLED' },
        { fieldId: 'fld_gone', reason: 'PROPERTY_HIDDEN_BLANKED' },
        { fieldId: 'fld_title', reason: 'SOME_FUTURE_REASON' },
      ],
      viewFilterLeavesDropped: [{ viewId: 'view_a', count: 2 }],
      autoNumberRenumberedRows: 37,
    }))
    await mount()
    const items = Array.from(q('copy-sheet-disclosures')!.querySelectorAll('li'))
    const byKind = Object.fromEntries(items.map((li) => [li.getAttribute('data-disclosure'), li.textContent]))
    expect(byKind.ATTACHMENT_BLANKED).toBe('附件列 「图纸」：列会保留，附件不复制（副本中为空）')
    expect(byKind.SELF_LINK_BLANKED).toBe('关联本表的列 「父项」：列会保留，值为空')
    expect(byKind.MIRROR_NOT_BUILT).toBe('双向关联的镜像列 「镜像」：不会创建')
    expect(byKind.DEPENDS_ON_BLANKED_COLUMN).toBe('依赖上述列的列 「供应商名称」：保留并实时计算，结果可能为空')
    expect(byKind.BUTTON_DISABLED).toBe('按钮列 「推送」：保留按钮，按钮动作不复制')
    expect(byKind.PROPERTY_HIDDEN_BLANKED).toBe('已隐藏的列 「（未列出的列）」：列会保留（仍隐藏），值为空')
    expect(byKind.SOME_FUTURE_REASON).toBe('列 「标题」：复制后会有差异')
    // per auto-number COLUMN per row on the backend -> 「处编号」, never 「行」 (review FE-3)
    expect(byKind.AUTO_NUMBER_RENUMBERED).toBe('自动编号列会重新编号：共 37 处编号将发生变化')
    expect(byKind.VIEW_FILTER_LEAF_DROPPED).toBe('视图「按录入先后」：将移除 2 个筛选条件')
    const dialogText = q('copy-sheet-dialog')!.textContent ?? ''
    expect(dialogText).not.toMatch(/[A-Z]+_[A-Z_]+/)
    expect(dialogText).not.toContain('fld_')
    expect(q('copy-sheet-not-copied')!.textContent).toContain('自动化、评论、订阅、表单分享、记录锁定、修订历史')
  })

  // Structural disclosures a sheet over the row cap still has (the #6112 fix skips the record read, not the plan).
  const STRUCTURAL = {
    fieldDisclosures: [
      { fieldId: 'fld_mirror', reason: 'MIRROR_NOT_BUILT' },
      { fieldId: 'fld_btn', reason: 'BUTTON_DISABLED' },
    ],
    viewFilterLeavesDropped: [{ viewId: 'view_a', count: 2 }],
  }
  const kinds = () => Array.from(q('copy-sheet-disclosures')?.querySelectorAll('li') ?? []).map((li) => li.getAttribute('data-disclosure'))

  it('over the row cap (#6112 fix: 200 + summary.overLimit): OVER_LIMIT AND the structural disclosures render; submit only for structure', async () => {
    client.dryRunCopySheet.mockResolvedValue(dryRunOk({ rowCount: 2400, overLimit: true, rowLimit: 2000, ...STRUCTURAL }))
    await mount()
    const items = Array.from(q('copy-sheet-disclosures')!.querySelectorAll('li'))
    expect(items.find((li) => li.getAttribute('data-disclosure') === 'OVER_LIMIT')?.textContent)
      .toBe('数据行数超出单次复制上限（2000 行）。可取消勾选「包含数据」只复制结构。')
    expect(kinds()).toEqual(['OVER_LIMIT', 'MIRROR_NOT_BUILT', 'BUTTON_DISABLED', 'VIEW_FILTER_LEAF_DROPPED'])
    expect(items.find((li) => li.getAttribute('data-disclosure') === 'MIRROR_NOT_BUILT')?.textContent).toBe('双向关联的镜像列 「镜像」：不会创建')
    expect(items.find((li) => li.getAttribute('data-disclosure') === 'BUTTON_DISABLED')?.textContent).toBe('按钮列 「推送」：保留按钮，按钮动作不复制')
    expect(items.find((li) => li.getAttribute('data-disclosure') === 'VIEW_FILTER_LEAF_DROPPED')?.textContent).toBe('视图「按录入先后」：将移除 2 个筛选条件')
    expect(q('copy-sheet-with-data-label')!.textContent).toBe('包含数据（共 2400 行）')
    expect(errorText()).toBe('')
    expect(submitButton().disabled).toBe(true)
    q<HTMLInputElement>('copy-sheet-with-data')!.click()
    await flush()
    // structure only: the over-limit line goes, the structural disclosures stay
    expect(kinds()).toEqual(['MIRROR_NOT_BUILT', 'BUTTON_DISABLED', 'VIEW_FILTER_LEAF_DROPPED'])
    expect(submitButton().disabled).toBe(false)
    submitButton().click()
    await flush()
    expect(client.dryRunCopySheet).toHaveBeenCalledTimes(1) // the new shape needs no re-probe
    expect(client.copySheet).toHaveBeenCalledWith('sheet_orders', { name: '订单 副本', withData: false, permissionMode: 'inherit' })
  })

  it('over the row cap with a placeholder rowCount (records not read): the label shows no N rather than 「共 0 行」', async () => {
    for (const placeholder of [0, 2000]) {
      client.dryRunCopySheet.mockResolvedValueOnce(dryRunOk({ rowCount: placeholder, overLimit: true, rowLimit: 2000, ...STRUCTURAL }))
      await mount()
      expect(q('copy-sheet-with-data-label')!.textContent).toBe('包含数据')
      expect(kinds()).toEqual(['OVER_LIMIT', 'MIRROR_NOT_BUILT', 'BUTTON_DISABLED', 'VIEW_FILTER_LEAF_DROPPED'])
      mounted!.app.unmount()
      mounted!.container.remove()
      mounted = null
    }
  })

  it('over the row cap (older backend: 413 on the probe): ONE structure-only re-probe, its disclosures render before a structure-only submit', async () => {
    const reprobe = deferred<CopySheetDryRunResult>()
    client.dryRunCopySheet
      .mockRejectedValueOnce(copyErr(413, { code: 'COPY_TOO_LARGE', details: { rowCount: 2400, limit: 2000 } }))
      .mockReturnValueOnce(reprobe.promise)
    await mount()
    expect(client.dryRunCopySheet).toHaveBeenCalledTimes(2)
    expect(client.dryRunCopySheet.mock.calls[1]).toEqual(['sheet_orders', { withData: false, permissionMode: 'inherit' }])
    // re-probe still pending: structure-only submit must not be possible yet
    q<HTMLInputElement>('copy-sheet-with-data')!.click()
    await flush()
    expect(submitButton().disabled).toBe(true)
    q<HTMLInputElement>('copy-sheet-with-data')!.click()
    await flush()
    reprobe.resolve(dryRunOk({ rowCount: 0, ...STRUCTURAL }))
    await flush()
    // same screen as the new backend shape: OVER_LIMIT line (not an error) + the structural disclosures
    expect(kinds()).toEqual(['OVER_LIMIT', 'MIRROR_NOT_BUILT', 'BUTTON_DISABLED', 'VIEW_FILTER_LEAF_DROPPED'])
    expect(q('copy-sheet-with-data-label')!.textContent).toBe('包含数据（共 2400 行）')
    expect(errorText()).toBe('')
    expect(submitButton().disabled).toBe(true)
    q<HTMLInputElement>('copy-sheet-with-data')!.click()
    await flush()
    expect(kinds()).toEqual(['MIRROR_NOT_BUILT', 'BUTTON_DISABLED', 'VIEW_FILTER_LEAF_DROPPED'])
    expect(submitButton().disabled).toBe(false)
    submitButton().click()
    await flush()
    expect(client.copySheet).toHaveBeenCalledWith('sheet_orders', { name: '订单 副本', withData: false, permissionMode: 'inherit' })
  })

  it('auto-number row rule (422, data-only): rule sentence while data is included; structure-only re-probe; lifts after untick', async () => {
    client.dryRunCopySheet
      .mockRejectedValueOnce(copyErr(422, { code: 'COPY_SOURCE_RULE_ON_RENUMBERED_FIELD', details: { fieldId: 'fld_title' } }))
      .mockResolvedValueOnce(dryRunOk({ rowCount: 0, ...STRUCTURAL }))
    await mount()
    expect(client.dryRunCopySheet.mock.calls[1]).toEqual(['sheet_orders', { withData: false, permissionMode: 'inherit' }])
    expect(errorText()).toBe('「标题」列：这张表的行级可见规则用到了自动编号列，而复制会重新编号，可能改变哪些行被隐藏，已拒绝。可取消勾选「包含数据」只复制结构。')
    expect(kinds()).toEqual(['MIRROR_NOT_BUILT', 'BUTTON_DISABLED', 'VIEW_FILTER_LEAF_DROPPED'])
    expect(q('copy-sheet-with-data-label')!.textContent).toBe('包含数据')
    expect(submitButton().disabled).toBe(true)
    q<HTMLInputElement>('copy-sheet-with-data')!.click()
    await flush()
    expect(errorText()).toBe('')
    expect(submitButton().disabled).toBe(false)
  })

  it('a data-only refusal whose structure-only re-probe also fails keeps EVERY submit blocked (disclosures never skipped)', async () => {
    client.dryRunCopySheet
      .mockRejectedValueOnce(copyErr(413, { code: 'COPY_TOO_LARGE', details: { rowCount: 2400, limit: 2000 } }))
      .mockRejectedValueOnce(new TypeError('network down'))
    await mount()
    expect(errorText()).toBe('预检未完成，暂时不能复制（未做任何修改）。请关闭后重新打开再试。')
    expect(submitButton().disabled).toBe(true)
    q<HTMLInputElement>('copy-sheet-with-data')!.click()
    await flush()
    expect(submitButton().disabled).toBe(true)
    expect(client.dryRunCopySheet).toHaveBeenCalledTimes(2)
  })

  it('a probe that failed in transport / 5xx blocks submit (nothing could be disclosed) and says the pre-check failed', async () => {
    for (const failure of [new TypeError('network down'), copyErr(500, { code: 'INTERNAL_ERROR' }), copyErr(503, { code: 'DB_NOT_READY' })]) {
      client.dryRunCopySheet.mockRejectedValueOnce(failure)
      await mount()
      expect(errorText()).toBe('预检未完成，暂时不能复制（未做任何修改）。请关闭后重新打开再试。')
      expect(submitButton().disabled).toBe(true)
      q<HTMLInputElement>('copy-sheet-with-data')!.click()
      await flush()
      expect(submitButton().disabled).toBe(true)
      mounted!.app.unmount()
      mounted!.container.remove()
      mounted = null
    }
    expect(client.dryRunCopySheet).toHaveBeenCalledTimes(3) // no re-probe for non-data-only failures
    expect(client.copySheet).not.toHaveBeenCalled()
  })

  it('a 403 gate refusal on the dry-run: zh sentence, NO count anywhere, submit blocked', async () => {
    client.dryRunCopySheet.mockRejectedValue(copyErr(403, { code: 'COPY_SOURCE_NOT_FULLY_READABLE', rowCount: 99, limit: 2000 }))
    await mount()
    expect(errorText()).toBe('你对这张数据表没有完整的读取权限（有列、行或公式结果对你不可见），不能复制。请联系表管理员。')
    expect(errorText()).not.toMatch(/\d/)
    expect(q('copy-sheet-with-data-label')!.textContent).toBe('包含数据')
    expect(q('copy-sheet-disclosures')).toBeNull()
    expect(client.dryRunCopySheet).toHaveBeenCalledTimes(1) // a gate refusal is never re-probed
    expect(submitButton().disabled).toBe(true)
    const dialogText = q('copy-sheet-dialog')!.textContent ?? ''
    expect(dialogText).not.toContain(SENTINEL_ZH)
    expect(dialogText).not.toContain(SENTINEL_EN)
  })

  it('dry-run COPY_TOO_MANY_FIELDS / structural 422: blocks even for a structure-only copy', async () => {
    for (const refusal of [
      { status: 413, error: { code: 'COPY_TOO_MANY_FIELDS', fieldCount: 612, limit: 500 } },
      { status: 422, error: { code: 'COPY_UNMAPPED_FIELD_REF', fieldId: 'fld_title' } },
    ]) {
      client.dryRunCopySheet.mockRejectedValue(copyErr(refusal.status, refusal.error))
      await mount()
      q<HTMLInputElement>('copy-sheet-with-data')!.click()
      await flush()
      expect(submitButton().disabled).toBe(true)
      mounted!.app.unmount()
      mounted!.container.remove()
      mounted = null
    }
    expect(client.copySheet).not.toHaveBeenCalled()
  })

  const SUBMIT_REFUSALS: Array<{ code: string; status: number; extra?: Record<string, unknown>; zh: string }> = [
    { code: 'COPY_SOURCE_NOT_FULLY_READABLE', status: 403, zh: '你对这张数据表没有完整的读取权限（有列、行或公式结果对你不可见），不能复制。请联系表管理员。' },
    { code: 'COPY_UNMAPPED_FIELD_REF', status: 422, zh: '有列的设置引用了复制暂时无法对应的列，未做任何复制。请联系管理员。' },
    { code: 'COPY_SOURCE_RULE_UNBUILDABLE', status: 422, zh: '这张表的行级可见规则用到了副本无法创建的列（如双向关联的镜像列）。复制会放宽行的可见范围，已拒绝。' },
    { code: 'COPY_SOURCE_RULE_ON_RENUMBERED_FIELD', status: 422, zh: '这张表的行级可见规则用到了自动编号列，而复制会重新编号，可能改变哪些行被隐藏，已拒绝。可取消勾选「包含数据」只复制结构。' },
    { code: 'COPY_PERMISSION_PARITY_FAILED', status: 500, zh: '副本的权限无法与源数据表逐条对应（可能在复制期间被修改），已整体回滚，未创建任何数据表。请重试。' },
    { code: 'COPY_SOURCE_CHANGED', status: 409, zh: '复制期间源数据表被修改，已整体回滚，未创建任何数据表。请重试。' },
    { code: 'COPY_TOO_LARGE', status: 413, extra: { rowCount: 2400, limit: 2000 }, zh: '数据超出单次复制上限（共 2400 行，上限 2000 行）。可取消勾选「包含数据」只复制结构。' },
    { code: 'COPY_TOO_LARGE', status: 413, extra: { fieldCount: 612, limit: 500 }, zh: '这张数据表超出单次复制上限（行数或列数过多）。' },
    { code: 'COPY_ROW_VALIDATION_FAILED', status: 422, extra: { details: { firstFailure: { rowIndex: 4, fieldId: 'fld_qty', code: 'VALIDATION_ERROR' } } }, zh: '第 5 行（按创建顺序）的「数量」列未通过校验，复制已整体取消，未创建任何数据表。' },
    { code: 'COPY_ROW_VALIDATION_FAILED', status: 422, extra: { rowIndex: 0, fieldId: 'fld_unknown' }, zh: '第 1 行（按创建顺序）的某一列未通过校验，复制已整体取消，未创建任何数据表。' },
    // the route's real nesting: fail(422, code, { rowIndex, fieldId, code: <record code> }) -> error.details
    { code: 'COPY_ROW_VALIDATION_FAILED', status: 422, extra: { details: { rowIndex: 2, fieldId: 'fld_qty', code: 'VALIDATION_ERROR' } }, zh: '第 3 行（按创建顺序）的「数量」列未通过校验，复制已整体取消，未创建任何数据表。' },
    { code: 'NAME_INVALID_CHARACTERS', status: 400, zh: '新数据表名称包含无法使用的字符，请重新输入名称后重试。' },
    { code: 'COPY_TOO_MANY_FIELDS', status: 413, extra: { fieldCount: 612, limit: 500 }, zh: '这张数据表的列数超出单次复制上限（共 612 列，上限 500 列）。' },
    { code: 'COPY_UNMAPPED_FIELD_REF', status: 422, extra: { fieldId: 'fld_lookup' }, zh: '「供应商名称」列的设置引用了复制暂时无法对应的列，未做任何复制。请联系管理员。' },
    // review FE-4: view-level refusals name the view (details.viewId), with the column when both are sent
    { code: 'COPY_UNMAPPED_FIELD_REF', status: 422, extra: { details: { viewId: 'view_a' } }, zh: '视图「按录入先后」的设置引用了复制暂时无法对应的列，未做任何复制。请联系管理员。' },
    { code: 'COPY_UNMAPPED_FIELD_REF', status: 422, extra: { details: { viewId: 'view_a', fieldId: 'fld_qty' } }, zh: '视图「按录入先后」中「数量」列的设置引用了复制暂时无法对应的列，未做任何复制。请联系管理员。' },
    { code: 'COPY_UNMAPPED_FIELD_REF', status: 422, extra: { details: { viewId: 'view_unlisted' } }, zh: '某个视图的设置引用了复制暂时无法对应的列，未做任何复制。请联系管理员。' },
    { code: 'COPY_LINK_TARGET_NOT_LIVE', status: 422, extra: { details: { viewId: 'view_a', fieldId: 'fld_self' } }, zh: '视图「按录入先后」、「父项」列：有关联列指向的数据表已不存在，未做任何复制。请先修正或删除该关联列。' },
    { code: 'COPY_LINK_TARGET_NOT_LIVE', status: 422, extra: { fieldId: 'fld_self' }, zh: '「父项」列：有关联列指向的数据表已不存在，未做任何复制。请先修正或删除该关联列。' },
    { code: 'COPY_UNSUPPORTED_FIELD_TYPE', status: 422, extra: { fieldId: 'fld_gone' }, zh: '有列的类型暂不支持复制，未做任何复制。' },
    { code: 'NOT_FOUND', status: 404, zh: '源数据表不存在或已被删除。' },
    { code: 'COPY_SOURCE_SYSTEM_SHEET', status: 422, zh: '系统数据表不能复制。' },
    { code: 'SHEET_NOT_LIVE', status: 404, zh: '源数据表不存在或已被删除。' },
    { code: 'FORBIDDEN', status: 403, zh: '你没有在当前工作区新建数据表的权限。' },
    { code: 'RECOVERY_IN_PROGRESS', status: 409, zh: '数据表正被其他操作占用，请稍后重试。' },
    { code: 'SOMETHING_NEW', status: 500, zh: '复制失败，请稍后重试。' },
  ]

  for (const refusal of SUBMIT_REFUSALS) {
    it(`copy refusal ${refusal.code} (${refusal.status}${refusal.extra ? ', with extras' : ''}) -> its zh sentence, values-free`, async () => {
      client.copySheet.mockRejectedValue(copyErr(refusal.status, { code: refusal.code, ...(refusal.extra ?? {}) }))
      await mount()
      submitButton().click()
      await flush()
      expect(onCopied).not.toHaveBeenCalled()
      expect(errorText()).toBe(refusal.zh)
      const dialogText = q('copy-sheet-dialog')!.textContent ?? ''
      expect(dialogText).not.toContain(SENTINEL_ZH)
      expect(dialogText).not.toContain(SENTINEL_EN)
      expect(errorText()).not.toMatch(/[A-Z]+_[A-Z_]+/)
      expect(errorText()).not.toContain('fld_')
      if (refusal.status === 403) expect(errorText()).not.toMatch(/\d/)
    })
  }

  it('a source whose own name is mangled still gets its probe: count + disclosures shown, and a name refusal clears on edit', async () => {
    // The probe carries no name, so a mangled source name cannot 400 it; only the copy's own name can,
    // and only on submit — where editing the name retracts that refusal (other refusals would stay).
    state.sheetName = '订单�'
    client.copySheet
      .mockRejectedValueOnce(copyErr(400, { code: 'NAME_INVALID_CHARACTERS' }))
      .mockResolvedValueOnce(copyOk())
    await mount()
    expect(client.dryRunCopySheet.mock.calls[0][1]).not.toHaveProperty('name')
    expect(q('copy-sheet-with-data-label')!.textContent).toBe('包含数据（共 1239 行）')
    submitButton().click()
    await flush()
    expect(errorText()).toBe('新数据表名称包含无法使用的字符，请重新输入名称后重试。')
    const name = q<HTMLInputElement>('copy-sheet-name')!
    name.value = '订单 副本'
    name.dispatchEvent(new Event('input'))
    await flush()
    expect(q('copy-sheet-error')).toBeNull()
    submitButton().click()
    await flush()
    expect(client.copySheet).toHaveBeenLastCalledWith('sheet_orders', { name: '订单 副本', withData: true, permissionMode: 'inherit' })
    expect(onCopied).toHaveBeenCalledTimes(1)
  })

  it('en: a view-level COPY_UNMAPPED_FIELD_REF names the view and the column', async () => {
    useLocale().setLocale('en')
    client.copySheet.mockRejectedValueOnce(copyErr(422, { code: 'COPY_UNMAPPED_FIELD_REF', details: { viewId: 'view_a', fieldId: 'fld_qty' } }))
    await mount()
    submitButton().click()
    await flush()
    expect(errorText()).toBe('The settings of column “数量” in view “按录入先后” reference a column the copy can\'t map yet, so nothing was copied. Contact an administrator.')
    expect(errorText()).not.toContain('view_a')
    expect(errorText()).not.toContain('fld_')
  })

  it('editing the name does NOT retract a non-name refusal', async () => {
    client.copySheet.mockRejectedValueOnce(copyErr(409, { code: 'COPY_SOURCE_CHANGED' }))
    await mount()
    submitButton().click()
    await flush()
    expect(errorText()).toBe('复制期间源数据表被修改，已整体回滚，未创建任何数据表。请重试。')
    const name = q<HTMLInputElement>('copy-sheet-name')!
    name.value = '别的名字'
    name.dispatchEvent(new Event('input'))
    await flush()
    expect(errorText()).toBe('复制期间源数据表被修改，已整体回滚，未创建任何数据表。请重试。')
  })

  it('a non-CopySheetError (network) shows the generic line, never its message', async () => {
    client.copySheet.mockRejectedValue(new TypeError(`fetch failed ${SENTINEL_EN}`))
    await mount()
    submitButton().click()
    await flush()
    expect(errorText()).toBe('复制失败，请稍后重试。')
  })

  it('busy state: probe pending blocks submit; copy pending disables the form and sends only one request', async () => {
    const probe = deferred<CopySheetDryRunResult>()
    client.dryRunCopySheet.mockReturnValue(probe.promise)
    const copy = deferred<CopySheetResult>()
    client.copySheet.mockReturnValue(copy.promise)
    await mount()
    expect(q('copy-sheet-dry-run-loading')!.textContent).toBe('正在预检复制内容…')
    expect(submitButton().disabled).toBe(true)
    probe.resolve(dryRunOk())
    await flush()
    expect(q('copy-sheet-dry-run-loading')).toBeNull()
    expect(submitButton().disabled).toBe(false)

    submitButton().click()
    await flush()
    expect(submitButton().disabled).toBe(true)
    expect(submitButton().textContent?.trim()).toBe('正在复制…')
    expect(q<HTMLInputElement>('copy-sheet-name')!.disabled).toBe(true)
    expect(q<HTMLInputElement>('copy-sheet-with-data')!.disabled).toBe(true)
    expect(q<HTMLButtonElement>('copy-sheet-cancel')!.disabled).toBe(true)
    submitButton().click()
    await flush()
    expect(client.copySheet).toHaveBeenCalledTimes(1)
    // the overlay (backdrop) click is the one close path still live mid-copy: it must not close
    ;(document.body.querySelector('.meta-copy-sheet-overlay') as HTMLElement).click()
    await flush()
    expect(onClose).not.toHaveBeenCalled()

    copy.resolve(copyOk())
    await flush()
    expect(onCopied).toHaveBeenCalledTimes(1)
    ;(document.body.querySelector('.meta-copy-sheet-overlay') as HTMLElement).click()
    await flush()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a probe that settles after close + re-open cannot overwrite the fresh probe', async () => {
    const stale = deferred<CopySheetDryRunResult>()
    client.dryRunCopySheet.mockReturnValueOnce(stale.promise)
    await mount()
    state.visible = false
    await flush()
    client.dryRunCopySheet.mockResolvedValueOnce(dryRunOk({ rowCount: 8 }))
    state.visible = true
    await flush()
    expect(client.dryRunCopySheet).toHaveBeenCalledTimes(2)
    expect(q('copy-sheet-with-data-label')!.textContent).toBe('包含数据（共 8 行）')
    stale.resolve(dryRunOk({ rowCount: 5 }))
    await flush()
    expect(q('copy-sheet-with-data-label')!.textContent).toBe('包含数据（共 8 行）')
  })

  it('cancel emits close', async () => {
    await mount()
    q<HTMLButtonElement>('copy-sheet-cancel')!.click()
    await flush()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
