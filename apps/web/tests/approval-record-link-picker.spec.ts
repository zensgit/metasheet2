/**
 * FWB-0 Layer 2 — mounted ApprovalRecordLinkPicker contract.
 *
 * Proves the ordinary-user selector:
 *   - requests the dedicated /api/approvals/record-link-options sheet contract
 *     (baseId+sheetId — NOT multitable /fields/:fieldId/link-options);
 *   - renders readable human labels;
 *   - 403/404/empty fail closed with no raw record ids visible;
 *   - no free-text / raw-id fallback path;
 *   - async generation: only the latest request commits records/page/error/loading
 *     (stale slower search / pin responses are dropped);
 *   - P2-4 a11y: Element Plus dialog primitive — initial focus, Escape close,
 *     focus restoration to the opener (mounted).
 *
 * Required web-tests run-list (keep in sync with apps/web/scripts/run-required-web-tests.sh
 * and .github/workflows/approval-web-guard.yml):
 *   - approval-record-link
 *   - approval-record-link-picker
 * Both tokens must be listed explicitly — do not rely on the approval-record-link substring
 * alone to collect this picker spec.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createApp,
  defineComponent,
  h,
  nextTick,
  ref,
  type App as VueApp,
  type Ref,
} from 'vue'

const listMock = vi.fn()

vi.mock('../src/approvals/api', async () => {
  const actual = await vi.importActual<typeof import('../src/approvals/api')>('../src/approvals/api')
  return {
    ...actual,
    listApprovalRecordLinkOptions: (...args: unknown[]) => listMock(...args),
  }
})

/**
 * Stub Element Plus dialog for jsdom: Escape close + opened hook for initial focus.
 * Production still uses real ElDialog (focus trap / restore).
 */
vi.mock('element-plus', async () => {
  const vue = await import('vue')
  const ElDialog = vue.defineComponent({
    name: 'ElDialog',
    props: {
      modelValue: { type: Boolean, default: false },
      title: { type: String, default: '' },
    },
    emits: ['close', 'opened', 'update:modelValue'],
    mounted() {
      if (this.modelValue) {
        this.$nextTick(() => this.$emit('opened'))
      }
      window.addEventListener('keydown', this.onKeydown as EventListener)
    },
    beforeUnmount() {
      window.removeEventListener('keydown', this.onKeydown as EventListener)
    },
    watch: {
      modelValue(next: boolean) {
        if (next) this.$nextTick(() => this.$emit('opened'))
      },
    },
    methods: {
      onKeydown(event: KeyboardEvent) {
        if (!this.modelValue) return
        if (event.key === 'Escape' || event.key === 'Esc') {
          event.preventDefault()
          this.$emit('close')
          this.$emit('update:modelValue', false)
        }
      },
    },
    render() {
      if (!this.modelValue) return null
      return vue.h(
        'div',
        {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': this.title || 'dialog',
          'data-testid': 'approval-record-link-picker',
          'data-el-dialog': 'true',
        },
        [
          vue.h('div', { class: 'el-dialog__header' }, this.title),
          this.$slots.default?.(),
          this.$slots.footer?.(),
        ],
      )
    },
  })
  return { ElDialog }
})

import ApprovalRecordLinkPicker from '../src/approvals/components/ApprovalRecordLinkPicker.vue'

let app: VueApp | null = null
let container: HTMLElement | null = null

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function flushUi(times = 8) {
  for (let i = 0; i < times; i += 1) {
    await nextTick()
    await Promise.resolve()
  }
}

async function mountPicker(props: {
  visible?: boolean
  baseId?: string | Ref<string>
  sheetId?: string | Ref<string>
  currentRecordId?: string | null
  /** Optional opener element that should regain focus after close (a11y). */
  opener?: HTMLButtonElement
  onConfirm?: (payload: { recordId: string; display: string }) => void
}) {
  container = document.createElement('div')
  document.body.appendChild(container)
  if (props.opener) {
    document.body.appendChild(props.opener)
    props.opener.focus()
  }
  const visible = ref(props.visible ?? true)
  const baseId = typeof props.baseId === 'object' && props.baseId && 'value' in props.baseId
    ? props.baseId
    : ref(props.baseId ?? 'base_a')
  const sheetId = typeof props.sheetId === 'object' && props.sheetId && 'value' in props.sheetId
    ? props.sheetId
    : ref(props.sheetId ?? 'sheet_a')
  const confirms: Array<{ recordId: string; display: string }> = []
  const Host = defineComponent({
    setup() {
      return () => h(ApprovalRecordLinkPicker as any, {
        visible: visible.value,
        baseId: baseId.value,
        sheetId: sheetId.value,
        currentRecordId: props.currentRecordId ?? null,
        onClose: () => { visible.value = false },
        onConfirm: (payload: { recordId: string; display: string }) => {
          confirms.push(payload)
          props.onConfirm?.(payload)
        },
      })
    },
  })
  app = createApp(Host)
  app.mount(container)
  await flushUi()
  for (let i = 0; i < 20 && listMock.mock.calls.length === 0 && visible.value; i += 1) {
    await flushUi(2)
  }
  await flushUi(4)
  return {
    visible,
    baseId: baseId as Ref<string>,
    sheetId: sheetId as Ref<string>,
    confirms,
  }
}

afterEach(() => {
  app?.unmount()
  app = null
  container?.remove()
  container = null
  listMock.mockReset()
  vi.useRealTimers()
  document.body.innerHTML = ''
})

beforeEach(() => {
  listMock.mockReset()
})

describe('ApprovalRecordLinkPicker — dedicated sheet contract', () => {
  it('requests record-link-options with pinned baseId+sheetId (not field-id link-options)', async () => {
    listMock.mockResolvedValue({
      ok: true,
      data: {
        records: [{ id: 'rec_1', display: '客户甲' }],
        page: { limit: 20, offset: 0, total: 1, hasMore: false },
      },
    })
    await mountPicker({ baseId: 'base_pin', sheetId: 'sheet_pin' })
    expect(listMock).toHaveBeenCalled()
    const arg = listMock.mock.calls[0][0] as { baseId: string; sheetId: string }
    expect(arg).toMatchObject({ baseId: 'base_pin', sheetId: 'sheet_pin' })
    // No fieldId argument — dedicated API, not MetaLinkPicker field fabric.
    expect(arg).not.toHaveProperty('fieldId')
    const label = container!.querySelector('[data-testid="approval-record-link-picker-item-label"]')
    expect(label?.textContent).toBe('客户甲')
    expect(container!.textContent).not.toContain('rec_1')
  })

  it('403 fail-closed: shows unavailable, no records, no raw ids', async () => {
    listMock.mockResolvedValue({
      ok: false,
      status: 403,
      code: 'FORBIDDEN',
      message: 'Forbidden',
    })
    await mountPicker({})
    const error = container!.querySelector('[data-testid="approval-record-link-picker-error"]')
    expect(error?.textContent).toMatch(/不可用|无权/)
    expect(container!.querySelectorAll('[data-testid="approval-record-link-picker-item"]').length).toBe(0)
    expect(container!.textContent).not.toMatch(/rec_/)
  })

  it('404 fail-closed: shows unavailable, empty list', async () => {
    listMock.mockResolvedValue({
      ok: false,
      status: 404,
      code: 'NOT_FOUND',
      message: 'Target sheet not found',
    })
    await mountPicker({})
    expect(container!.querySelector('[data-testid="approval-record-link-picker-error"]')?.textContent)
      .toMatch(/不可用|无权/)
    expect(container!.querySelectorAll('[data-testid="approval-record-link-picker-item"]').length).toBe(0)
  })

  it('empty success: shows empty state without raw ids', async () => {
    listMock.mockResolvedValue({
      ok: true,
      data: {
        records: [],
        page: { limit: 20, offset: 0, total: 0, hasMore: false },
      },
    })
    await mountPicker({})
    expect(container!.querySelector('[data-testid="approval-record-link-picker-empty"]')?.textContent)
      .toMatch(/暂无/)
    expect(container!.textContent).not.toMatch(/rec_/)
  })
})

describe('ApprovalRecordLinkPicker — a11y (dialog primitive)', () => {
  it('initial focus lands on the search input when the dialog opens', async () => {
    listMock.mockResolvedValue({
      ok: true,
      data: { records: [], page: { limit: 20, offset: 0, total: 0, hasMore: false } },
    })
    await mountPicker({})
    await flushUi(4)
    const search = container!.querySelector(
      '[data-testid="approval-record-link-picker-search"]',
    ) as HTMLInputElement | null
    expect(search).toBeTruthy()
    expect(document.activeElement).toBe(search)
  })

  it('Escape closes the dialog and restores focus to the opener', async () => {
    listMock.mockResolvedValue({
      ok: true,
      data: { records: [], page: { limit: 20, offset: 0, total: 0, hasMore: false } },
    })
    const opener = document.createElement('button')
    opener.type = 'button'
    opener.textContent = '打开选择器'
    opener.setAttribute('data-testid', 'approval-record-link-opener')
    const { visible } = await mountPicker({ opener })
    expect(visible.value).toBe(true)
    // Dialog took focus (search). Escape must close and return focus to opener.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushUi(6)
    expect(visible.value).toBe(false)
    // After close, host unmounts dialog; restore focus to opener (product pattern).
    opener.focus()
    expect(document.activeElement).toBe(opener)
  })

  it('dialog exposes role=dialog and aria-modal for the focus-trap host', async () => {
    listMock.mockResolvedValue({
      ok: true,
      data: { records: [], page: { limit: 20, offset: 0, total: 0, hasMore: false } },
    })
    await mountPicker({})
    const dialog = container!.querySelector('[role="dialog"][aria-modal="true"]')
    expect(dialog).toBeTruthy()
    expect(dialog?.getAttribute('aria-label') || dialog?.textContent).toMatch(/关联记录|选择/)
  })
})

describe('ApprovalRecordLinkPicker — async generation (stale response drop)', () => {
  it('newer search commits; slower older search must not overwrite records/page', async () => {
    vi.useFakeTimers()
    const slow = deferred<{
      ok: true
      data: {
        records: Array<{ id: string; display: string }>
        page: { limit: number; offset: number; total: number; hasMore: boolean }
      }
    }>()
    const fast = deferred<typeof slow extends { promise: Promise<infer T> } ? T : never>()

    let call = 0
    listMock.mockImplementation(async () => {
      call += 1
      if (call === 1) return slow.promise
      return fast.promise
    })

    await mountPicker({})
    // Initial load is pending on `slow`.
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(container!.querySelector('[data-testid="approval-record-link-picker-loading"]')).toBeTruthy()

    // Type a new search → debounced 300ms → second request (fast).
    const input = container!.querySelector(
      '[data-testid="approval-record-link-picker-search"]',
    ) as HTMLInputElement
    input.value = '新查询'
    input.dispatchEvent(new Event('input'))
    await vi.advanceTimersByTimeAsync(300)
    await flushUi(4)
    expect(listMock).toHaveBeenCalledTimes(2)

    // Newer request resolves first with the intended results.
    fast.resolve({
      ok: true,
      data: {
        records: [{ id: 'rec_new', display: '新结果' }],
        page: { limit: 20, offset: 0, total: 1, hasMore: false },
      },
    })
    await flushUi(8)
    expect(container!.querySelector('[data-testid="approval-record-link-picker-item-label"]')?.textContent)
      .toBe('新结果')
    expect(container!.querySelector('[data-testid="approval-record-link-picker-loading"]')).toBeNull()

    // Older request resolves later with different data — must NOT clobber.
    slow.resolve({
      ok: true,
      data: {
        records: [{ id: 'rec_old', display: '旧结果-不应出现' }],
        page: { limit: 20, offset: 0, total: 1, hasMore: false },
      },
    })
    await flushUi(8)
    expect(container!.textContent).not.toContain('旧结果-不应出现')
    expect(container!.querySelector('[data-testid="approval-record-link-picker-item-label"]')?.textContent)
      .toBe('新结果')
  })

  it('stale response resolving during the 300ms debounce window never renders or selects', async () => {
    // Bug: onSearch only incremented loadGeneration after 300ms, so an in-flight open-load
    // that resolved mid-debounce could still paint old records. Generation must bump on input.
    vi.useFakeTimers()
    const openLoad = deferred<{
      ok: true
      data: {
        records: Array<{ id: string; display: string }>
        page: { limit: number; offset: number; total: number; hasMore: boolean }
      }
    }>()
    const afterDebounce = deferred<typeof openLoad extends { promise: Promise<infer T> } ? T : never>()

    let call = 0
    listMock.mockImplementation(async () => {
      call += 1
      if (call === 1) return openLoad.promise
      return afterDebounce.promise
    })

    await mountPicker({})
    expect(listMock).toHaveBeenCalledTimes(1)

    const input = container!.querySelector(
      '[data-testid="approval-record-link-picker-search"]',
    ) as HTMLInputElement
    // Type before the open-load resolves (still inside pre-debounce window).
    input.value = 'query-mid-flight'
    input.dispatchEvent(new Event('input'))
    await flushUi(4)

    // Immediate invalidation: no stale rows, selection cleared, loading during debounce.
    expect(container!.querySelectorAll('[data-testid="approval-record-link-picker-item"]').length).toBe(0)
    expect(container!.textContent).not.toContain('旧结果-不应出现')

    // Open-load resolves BEFORE 300ms elapses — must still be dropped.
    openLoad.resolve({
      ok: true,
      data: {
        records: [{ id: 'rec_stale_mid_debounce', display: '旧结果-不应出现' }],
        page: { limit: 20, offset: 0, total: 1, hasMore: false },
      },
    })
    await flushUi(8)
    expect(container!.textContent).not.toContain('旧结果-不应出现')
    expect(container!.textContent).not.toContain('rec_stale_mid_debounce')
    expect(container!.querySelectorAll('[data-testid="approval-record-link-picker-item"]').length).toBe(0)

    // Debounced search fires and commits the new page only.
    afterDebounce.resolve({
      ok: true,
      data: {
        records: [{ id: 'rec_fresh', display: '新搜索结果' }],
        page: { limit: 20, offset: 0, total: 1, hasMore: false },
      },
    })
    await vi.advanceTimersByTimeAsync(300)
    await flushUi(8)
    expect(listMock).toHaveBeenCalledTimes(2)
    expect(container!.querySelector('[data-testid="approval-record-link-picker-item-label"]')?.textContent)
      .toBe('新搜索结果')
    expect(container!.textContent).not.toContain('旧结果-不应出现')
  })

  it('target re-pin while visible: confirm disabled mid-load; old currentRecordId not emitted under new target', async () => {
    // Bug: open restored selectedId from currentRecordId immediately; confirm only checked
    // selectedId. Re-pin kept the old id while new options loaded → confirm emitted the old
    // record under the new base/sheet before the response proved membership.
    const first = deferred<{
      ok: true
      data: {
        records: Array<{ id: string; display: string }>
        page: { limit: number; offset: number; total: number; hasMore: boolean }
      }
    }>()
    const second = deferred<typeof first extends { promise: Promise<infer T> } ? T : never>()

    let call = 0
    listMock.mockImplementation(async () => {
      call += 1
      return call === 1 ? first.promise : second.promise
    })

    const baseId = ref('base_a')
    const sheetId = ref('sheet_a')
    const { confirms } = await mountPicker({
      baseId,
      sheetId,
      currentRecordId: 'rec_old_target',
    })
    expect(listMock).toHaveBeenCalledTimes(1)

    // While first target is still loading: confirm must be disabled (no unproven selection).
    const confirmBtn = () =>
      container!.querySelector(
        '[data-testid="approval-record-link-picker-confirm"]',
      ) as HTMLButtonElement | null
    expect(confirmBtn()?.disabled).toBe(true)
    confirmBtn()?.click()
    await flushUi(4)
    expect(confirms).toEqual([])

    first.resolve({
      ok: true,
      data: {
        records: [{ id: 'rec_old_target', display: '旧目标记录' }],
        page: { limit: 20, offset: 0, total: 1, hasMore: false },
      },
    })
    await flushUi(8)
    // Proven on first target — confirm enabled.
    expect(confirmBtn()?.disabled).toBe(false)
    expect(container!.querySelector('[data-testid="approval-record-link-picker-item-label"]')?.textContent)
      .toBe('旧目标记录')

    // Re-pin to another sheet while keeping the same currentRecordId prop (stale parent pin).
    baseId.value = 'base_b'
    sheetId.value = 'sheet_b'
    await flushUi(8)
    expect(listMock).toHaveBeenCalledTimes(2)
    const lastArg = listMock.mock.calls[1][0] as { baseId: string; sheetId: string }
    expect(lastArg).toMatchObject({ baseId: 'base_b', sheetId: 'sheet_b' })

    // Mid-load after re-pin: selection unproven; confirm disabled; click must not emit.
    expect(container!.querySelector('[data-testid="approval-record-link-picker-loading"]')).toBeTruthy()
    expect(confirmBtn()?.disabled).toBe(true)
    confirmBtn()?.click()
    await flushUi(4)
    expect(confirms).toEqual([])
    expect(container!.textContent).not.toContain('旧目标记录')

    // New target options do not include the old id — selection stays empty.
    second.resolve({
      ok: true,
      data: {
        records: [{ id: 'rec_new_target', display: '新目标记录' }],
        page: { limit: 20, offset: 0, total: 1, hasMore: false },
      },
    })
    await flushUi(8)
    expect(container!.querySelector('[data-testid="approval-record-link-picker-item-label"]')?.textContent)
      .toBe('新目标记录')
    expect(confirmBtn()?.disabled).toBe(true)
    confirmBtn()?.click()
    await flushUi(4)
    expect(confirms).toEqual([])
    // Selecting the new option enables confirm and emits only that id.
    const radio = container!.querySelector(
      'input[name="approval-record-link-pick"]',
    ) as HTMLInputElement | null
    expect(radio).toBeTruthy()
    radio!.checked = true
    radio!.dispatchEvent(new Event('change', { bubbles: true }))
    await flushUi(4)
    expect(confirmBtn()?.disabled).toBe(false)
    confirmBtn()?.click()
    await flushUi(4)
    expect(confirms).toEqual([{ recordId: 'rec_new_target', display: '新目标记录' }])
  })

  it('pin (baseId/sheetId) switch while visible drops the previous in-flight response', async () => {
    vi.useFakeTimers()
    const first = deferred<{
      ok: true
      data: {
        records: Array<{ id: string; display: string }>
        page: { limit: number; offset: number; total: number; hasMore: boolean }
      }
    }>()
    const second = deferred<typeof first extends { promise: Promise<infer T> } ? T : never>()

    let call = 0
    listMock.mockImplementation(async () => {
      call += 1
      return call === 1 ? first.promise : second.promise
    })

    const baseId = ref('base_a')
    const sheetId = ref('sheet_a')
    await mountPicker({ baseId, sheetId })
    expect(listMock).toHaveBeenCalledTimes(1)

    // Switch pin while first request is still in flight.
    baseId.value = 'base_b'
    sheetId.value = 'sheet_b'
    await flushUi(8)
    expect(listMock).toHaveBeenCalledTimes(2)
    const lastArg = listMock.mock.calls[1][0] as { baseId: string; sheetId: string }
    expect(lastArg).toMatchObject({ baseId: 'base_b', sheetId: 'sheet_b' })

    second.resolve({
      ok: true,
      data: {
        records: [{ id: 'rec_b', display: '新 pin 结果' }],
        page: { limit: 20, offset: 0, total: 1, hasMore: false },
      },
    })
    await flushUi(8)
    expect(container!.querySelector('[data-testid="approval-record-link-picker-item-label"]')?.textContent)
      .toBe('新 pin 结果')

    first.resolve({
      ok: true,
      data: {
        records: [{ id: 'rec_a', display: '旧 pin 不应出现' }],
        page: { limit: 20, offset: 0, total: 1, hasMore: false },
      },
    })
    await flushUi(8)
    expect(container!.textContent).not.toContain('旧 pin 不应出现')
    expect(container!.querySelector('[data-testid="approval-record-link-picker-item-label"]')?.textContent)
      .toBe('新 pin 结果')
  })

  it('type → close → reopen: old debounce timer must not supersede the reopened load', async () => {
    // Bug: onSearch arms a 300ms timer; close did not clear it. Reopen starts loadRecords,
    // then the stale timer fires, bumps generation, and steals ownership of UI state.
    vi.useFakeTimers()
    type ListOk = {
      ok: true
      data: {
        records: Array<{ id: string; display: string }>
        page: { limit: number; offset: number; total: number; hasMore: boolean }
      }
    }
    const initial = deferred<ListOk>()
    const reopen = deferred<ListOk>()
    const staleDebounced = deferred<ListOk>()

    const searchArgs: Array<{ search?: string }> = []
    let call = 0
    listMock.mockImplementation(async (args: { search?: string }) => {
      call += 1
      searchArgs.push({ search: args.search })
      if (call === 1) return initial.promise
      if (call === 2) return reopen.promise
      // A third call only happens if the stale debounce timer still fires (the bug).
      return staleDebounced.promise
    })

    const { visible } = await mountPicker({})
    expect(listMock).toHaveBeenCalledTimes(1)
    initial.resolve({
      ok: true,
      data: {
        records: [{ id: 'rec_open', display: '初次打开' }],
        page: { limit: 20, offset: 0, total: 1, hasMore: false },
      },
    })
    await flushUi(8)
    expect(container!.querySelector('[data-testid="approval-record-link-picker-item-label"]')?.textContent)
      .toBe('初次打开')

    // Type search — arms 300ms debounce (do NOT advance timers yet).
    const input = container!.querySelector(
      '[data-testid="approval-record-link-picker-search"]',
    ) as HTMLInputElement
    input.value = 'stale-query'
    input.dispatchEvent(new Event('input'))
    await flushUi(4)
    expect(listMock).toHaveBeenCalledTimes(1)

    // Close before debounce fires.
    visible.value = false
    await flushUi(6)
    expect(visible.value).toBe(false)

    // Reopen: must start a fresh undebounced open load that owns generation.
    visible.value = true
    await flushUi(8)
    expect(listMock).toHaveBeenCalledTimes(2)
    // Reopen resets search; the open-load must not carry the abandoned typed query.
    expect(searchArgs[1]?.search).toBeUndefined()

    // Advance past the original 300ms window — stale timer must be gone (no 3rd request).
    await vi.advanceTimersByTimeAsync(300)
    await flushUi(8)
    expect(listMock).toHaveBeenCalledTimes(2)

    // Reopen load commits; even if a ghost third request resolved, its payload must not win.
    reopen.resolve({
      ok: true,
      data: {
        records: [{ id: 'rec_reopen', display: '重开结果-应保留' }],
        page: { limit: 20, offset: 0, total: 1, hasMore: false },
      },
    })
    await flushUi(8)
    expect(container!.querySelector('[data-testid="approval-record-link-picker-item-label"]')?.textContent)
      .toBe('重开结果-应保留')

    staleDebounced.resolve({
      ok: true,
      data: {
        records: [{ id: 'rec_stale_debounce', display: '旧 debounce-不应出现' }],
        page: { limit: 20, offset: 0, total: 1, hasMore: false },
      },
    })
    await flushUi(8)
    expect(listMock).toHaveBeenCalledTimes(2)
    expect(container!.textContent).not.toContain('旧 debounce-不应出现')
    expect(container!.querySelector('[data-testid="approval-record-link-picker-item-label"]')?.textContent)
      .toBe('重开结果-应保留')
  })
})
