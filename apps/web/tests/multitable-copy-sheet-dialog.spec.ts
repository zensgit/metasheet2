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

  it('copy POSTs to /sheets/:id/copy and reads Idempotent-Replayed, formulaRecompute and the new sheet', async () => {
    const body = {
      ok: true,
      data: {
        sheet: { id: 'sheet_copy', baseId: 'base_ops', name: 'Orders copy', copiedFrom: { kind: 'user', at: '2026-09-27T00:00:00Z' } },
        formulaRecompute: { attempted: 3, recomputed: 2, failed: true, errorCode: 'BULK_RECOMPUTE_FAILED' },
        rowCount: 10,
        fieldCount: 4,
        permissionRowCount: 3,
        recordPermissionRowCount: 1,
      },
    }
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse(201, body, { 'Idempotent-Replayed': 'true' }))
      .mockResolvedValueOnce(jsonResponse(201, body))
    const client = new MultitableApiClient({ fetchFn })

    const replay = await client.copySheet('sheet_orders', { name: 'Orders copy', withData: false, permissionMode: 'inherit' })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('/api/multitable/sheets/sheet_orders/copy')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ name: 'Orders copy', withData: false, permissionMode: 'inherit' })
    expect(replay.replayed).toBe(true)
    expect(replay.sheet).toMatchObject({ id: 'sheet_copy', baseId: 'base_ops', name: 'Orders copy' })
    expect(replay.formulaRecompute).toEqual({ attempted: 3, recomputed: 2, failed: true, errorCode: 'BULK_RECOMPUTE_FAILED' })
    expect(replay.summary).toEqual({ rowCount: 10, fieldCount: 4, permissionRowCount: 3, recordPermissionRowCount: 1 })

    const fresh = await client.copySheet('sheet_orders', { withData: true, permissionMode: 'inherit' })
    expect(fresh.replayed).toBe(false)
    expect(JSON.parse(fetchFn.mock.calls[1][1].body)).toEqual({ withData: true, permissionMode: 'inherit' })
  })

  it('reads the backend branch shapes: CopySheetPlanSummary (nested under summary) and the flat CopySheetResult', async () => {
    // Shapes of copy-sheet-service.ts on feat/multitable-copy-sheet-s1 (CopySheetPlanSummary / CopySheetResult).
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(jsonResponse(200, {
        ok: true,
        data: {
          summary: {
            rowCount: 12, fieldCount: 5, builtFieldCount: 4,
            disclosures: [{ fieldId: 'fld_m', code: 'MIRROR_NOT_BUILT' }],
            droppedViewFilterLeaves: [{ viewId: 'view_b', count: 1 }],
            autoNumberRenumberedRows: 3,
            limits: { maxRows: 2000, maxFields: 500 },
            notCopied: ['automations'],
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse(201, {
        ok: true,
        data: {
          sheetId: 'sheet_new', baseId: 'base_ops', name: '订单 副本',
          summary: { rowCount: 12, fieldCount: 5, builtFieldCount: 4, permissionRowCount: 2, recordPermissionRowCount: 1 },
        },
      }))
    const client = new MultitableApiClient({ fetchFn })
    expect(await client.dryRunCopySheet('s', { withData: true, permissionMode: 'inherit' })).toEqual<CopySheetDryRunResult>({
      rowCount: 12,
      fieldCount: 5,
      overLimit: false,
      rowLimit: 2000,
      fieldDisclosures: [{ fieldId: 'fld_m', reason: 'MIRROR_NOT_BUILT' }],
      viewFilterLeavesDropped: [{ viewId: 'view_b', count: 1 }],
      autoNumberRenumberedRows: 3,
    })
    const result = await client.copySheet('s', { withData: true, permissionMode: 'inherit' })
    expect(result.sheet).toEqual({ id: 'sheet_new', baseId: 'base_ops', name: '订单 副本' })
    expect(result.summary).toEqual({ rowCount: 12, fieldCount: 4, permissionRowCount: 2, recordPermissionRowCount: 1 })
  })

  it('backend error details: flat-spread row failure, field cap, structural column id — and none of them on a 403', () => {
    // The service's row failure is { rowIndex, fieldId, code: <record code> } and its route doc says
    // `{ code, ...details }`: the inner code can overwrite the outer one. Still read as the row failure.
    const collided = buildCopySheetError(422, { ok: false, error: { code: 'VALIDATION_ERROR', rowIndex: 7, fieldId: 'fld_qty', message: leakyMessage } }, true)
    expect(collided).toMatchObject({ code: 'COPY_ROW_VALIDATION_FAILED', rowIndex: 7, fieldId: 'fld_qty' })
    const permissionRow = buildCopySheetError(500, { ok: false, error: { code: 'RECORD_PERMISSION', rowIndex: 0, fieldId: null } }, true)
    expect(permissionRow).toMatchObject({ code: 'COPY_ROW_VALIDATION_FAILED', rowIndex: 0 })
    expect(permissionRow.fieldId).toBeUndefined()

    const fields = buildCopySheetError(413, { ok: false, error: { code: 'COPY_TOO_MANY_FIELDS', fieldCount: 612, limit: 500 } }, true)
    expect(fields).toMatchObject({ code: 'COPY_TOO_MANY_FIELDS', fieldCount: 612, limit: 500 })
    expect(fields.rowCount).toBeUndefined()

    const structural = buildCopySheetError(422, { ok: false, error: { code: 'COPY_LINK_TARGET_NOT_LIVE', details: { fieldId: 'fld_link' } } }, true)
    expect(structural).toMatchObject({ code: 'COPY_LINK_TARGET_NOT_LIVE', fieldId: 'fld_link' })

    const gate = buildCopySheetError(403, { ok: false, error: { code: 'VALIDATION_ERROR', rowIndex: 2, fieldId: 'fld_hidden', fieldCount: 3, limit: 9 } }, true)
    expect(gate.code).toBe('VALIDATION_ERROR')
    expect([gate.rowIndex, gate.fieldId, gate.fieldCount, gate.rowCount, gate.limit]).toEqual([undefined, undefined, undefined, undefined, undefined])
    const gateStructural = buildCopySheetError(403, { ok: false, error: { code: 'COPY_UNMAPPED_FIELD_REF', fieldId: 'fld_hidden' } }, true)
    expect(gateStructural.fieldId).toBeUndefined()
  })

  it('a 201 without sheet.id is a broken answer and throws (never a phantom navigation)', async () => {
    const client = new MultitableApiClient({ fetchFn: vi.fn().mockResolvedValue(jsonResponse(201, { ok: true, data: {} })) })
    await expect(client.copySheet('sheet_orders', { withData: true, permissionMode: 'inherit' })).rejects.toThrow('Invalid copy sheet response')
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
    expect(client.dryRunCopySheet).toHaveBeenCalledWith('sheet_orders', { name: '订单 副本', withData: true, permissionMode: 'inherit' })
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
    expect(byKind.AUTO_NUMBER_RENUMBERED).toBe('自动编号列会重新编号：37 行的编号将发生变化')
    expect(byKind.VIEW_FILTER_LEAF_DROPPED).toBe('视图「按录入先后」：将移除 2 个筛选条件')
    const dialogText = q('copy-sheet-dialog')!.textContent ?? ''
    expect(dialogText).not.toMatch(/[A-Z]+_[A-Z_]+/)
    expect(dialogText).not.toContain('fld_')
    expect(q('copy-sheet-not-copied')!.textContent).toContain('自动化、评论、订阅、表单分享、记录锁定、修订历史')
  })

  it('over the row cap: disclosed, submit blocked while data is included, allowed for structure only', async () => {
    client.dryRunCopySheet.mockResolvedValue(dryRunOk({ rowCount: 2400, overLimit: true, rowLimit: 2000 }))
    await mount()
    const items = Array.from(q('copy-sheet-disclosures')!.querySelectorAll('li'))
    expect(items.find((li) => li.getAttribute('data-disclosure') === 'OVER_LIMIT')?.textContent)
      .toBe('数据行数超出单次复制上限（2000 行）。可取消勾选「包含数据」只复制结构。')
    expect(submitButton().disabled).toBe(true)
    q<HTMLInputElement>('copy-sheet-with-data')!.click()
    await flush()
    expect(submitButton().disabled).toBe(false)
    submitButton().click()
    await flush()
    expect(client.copySheet).toHaveBeenCalledWith('sheet_orders', { name: '订单 副本', withData: false, permissionMode: 'inherit' })
  })

  it('a 403 gate refusal on the dry-run: zh sentence, NO count anywhere, submit blocked', async () => {
    client.dryRunCopySheet.mockRejectedValue(copyErr(403, { code: 'COPY_SOURCE_NOT_FULLY_READABLE', rowCount: 99, limit: 2000 }))
    await mount()
    expect(errorText()).toBe('你对这张数据表没有完整的读取权限（有列、行或公式结果对你不可见），不能复制。请联系表管理员。')
    expect(errorText()).not.toMatch(/\d/)
    expect(q('copy-sheet-with-data-label')!.textContent).toBe('包含数据')
    expect(q('copy-sheet-disclosures')).toBeNull()
    expect(submitButton().disabled).toBe(true)
    const dialogText = q('copy-sheet-dialog')!.textContent ?? ''
    expect(dialogText).not.toContain(SENTINEL_ZH)
    expect(dialogText).not.toContain(SENTINEL_EN)
  })

  // The probe always runs WITH data, so a refusal that exists only because rows are included must stop
  // blocking once 「包含数据」 is unticked (its own sentence tells the user to do exactly that).
  for (const dataOnly of [
    { code: 'COPY_TOO_LARGE', status: 413, extra: { rowCount: 2400, limit: 2000 } },
    { code: 'COPY_SOURCE_RULE_ON_RENUMBERED_FIELD', status: 422, extra: { fieldId: 'fld_title' } },
  ]) {
    it(`dry-run ${dataOnly.code}: blocks while data is included, lifts for a structure-only copy`, async () => {
      client.dryRunCopySheet.mockRejectedValue(copyErr(dataOnly.status, { code: dataOnly.code, ...dataOnly.extra }))
      await mount()
      expect(errorText()).toContain('可取消勾选「包含数据」只复制结构')
      expect(submitButton().disabled).toBe(true)
      q<HTMLInputElement>('copy-sheet-with-data')!.click()
      await flush()
      expect(submitButton().disabled).toBe(false)
      submitButton().click()
      await flush()
      expect(client.copySheet).toHaveBeenCalledWith('sheet_orders', { name: '订单 副本', withData: false, permissionMode: 'inherit' })
    })
  }

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
    // backend flat spread `{ code, ...details }` where the inner record code overwrote the outer one
    { code: 'VALIDATION_ERROR', status: 422, extra: { rowIndex: 2, fieldId: 'fld_qty' }, zh: '第 3 行（按创建顺序）的「数量」列未通过校验，复制已整体取消，未创建任何数据表。' },
    { code: 'COPY_TOO_MANY_FIELDS', status: 413, extra: { fieldCount: 612, limit: 500 }, zh: '这张数据表的列数超出单次复制上限（共 612 列，上限 500 列）。' },
    { code: 'COPY_UNMAPPED_FIELD_REF', status: 422, extra: { fieldId: 'fld_lookup' }, zh: '「供应商名称」列：有列的设置引用了复制暂时无法对应的列，未做任何复制。请联系管理员。' },
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
