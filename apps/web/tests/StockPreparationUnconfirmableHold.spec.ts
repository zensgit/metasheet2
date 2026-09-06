import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, ref, type App as VueApp, type Component } from 'vue'

// 缺件行不该邀请操作员走进死胡同 — the confirmation queue's unconfirmable rows.
//
// THE PROBLEM THIS CLOSES (observed 2026-09-04 against the customer's own PLM, project
// `1-20232045`): a BOM line pointing at a part absent from the source parts library holds its rows
// as `missing_component`. Reconcile ledgers them, they appear in this queue as `pending`, and the
// page offered the same "我来决定…" button and the same three actions it offers a duplicate group.
// Every one of them fails: the confirm endpoint implements exactly one conflict type
// (`FIRST_CUT_CONFLICT_TYPE = 'duplicate_expanded_key'` in
// plugins/plugin-integration-core/lib/stock-preparation-confirmation-decisions.cjs) and answers 409
// `CONFIRMATION_DECISION_ACTION_CONFLICT_MISMATCH` for everything else — with a message that reads
// like "wrong option, pick another one" when NO option on this page will ever work. A second,
// structural wall sits behind the first: the readback that turns a confirmed decision into a
// planner policy only consumes duplicate-group candidates, so an anonymous-family row could not
// release its hold even if the runtime check let it through.
//
// The only way out is repairing the source data, after which the next sync closes the entry by
// itself. So the row must SAY that rather than offer three buttons that all fail.
//
// Guards:
//   U-01 an unconfirmable row's decide button is DISABLED (the invitation is withdrawn)
//   U-02 the row says WHY, and says what would actually work — naming the source system, not support
//   U-03 clicking it anyway opens no form (defence in depth: a test/AT harness can click a disabled
//        button, and `selectRow` is the only thing standing between that and a doomed submit)
//   U-04 a CONFIRMABLE row is untouched — button enabled, no hint, form opens
//   U-05 an unknown future conflict type degrades to the conservative branch: still disabled, still
//        explained, never silently confirmable

const h = vi.hoisted(() => ({
  locale: 'zh-CN' as string,
  permissions: [] as string[],
  roles: [] as string[],
  apiFetch: vi.fn(),
}))

vi.mock('../src/composables/useLocale', () => ({
  useLocale: () => ({
    locale: ref(h.locale),
    isZh: ref(h.locale === 'zh-CN'),
    setLocale: vi.fn(),
  }),
}))

function realHasPermission(required: string): boolean {
  const normalized = String(required || '').trim()
  if (!normalized) return true
  if (h.roles.includes('admin') || h.permissions.includes('*:*') || h.permissions.includes('admin:all')) return true
  if (h.permissions.includes(normalized)) return true
  const [resource, action] = normalized.split(':')
  if (!resource || !action) return false
  return h.permissions.includes(`${resource}:*`) || h.permissions.includes(`*:${action}`)
}

vi.mock('../src/composables/useAuth', () => ({
  useAuth: () => ({
    hasPermission: (required: string) => realHasPermission(required),
    permissions: ref(h.permissions),
    roles: ref(h.roles),
  }),
}))

vi.mock('../src/utils/api', () => ({
  apiFetch: (...args: unknown[]) => h.apiFetch(...args),
}))

const StockPreparationConfirmationQueueView = (
  await import('../src/components/integration/stockPreparation/StockPreparationConfirmationQueueView.vue')
).default

const STOCK_PREP_READ = 'stock-prep:read'
const STOCK_PREP_OPERATE = 'stock-prep:operate'
const QUEUE_URL = '/api/integration/stock-preparation/confirmation-decisions'
const SCOPE = { tenantId: 'default', workspaceId: 'default' }

let app: VueApp<Element> | null = null
let container: HTMLDivElement | null = null

function row(conflictType: string, decisionId = 'decision_1') {
  return {
    decisionId,
    conflictType,
    status: 'pending',
    resolutionAction: null,
    inputFingerprint: 'sha16:0123456789abcdef',
    sourceRevisionPresent: true,
    confirmedByPresent: false,
    confirmedAtPresent: false,
    notesPresent: false,
    resolvedValuePresent: false,
    resolvedAuxValuePresent: false,
  }
}

function routeFetch(rows: unknown[]) {
  h.apiFetch.mockImplementation(async (url: string) => {
    if (String(url).includes(QUEUE_URL)) {
      return new Response(
        JSON.stringify({
          ok: true,
          data: { rowCount: rows.length, byStatus: {}, byResolutionAction: {}, parkedCount: 0, rows },
        }),
        { status: 200 },
      )
    }
    return new Response('{"ok":true,"data":{}}', { status: 200 })
  })
}

function mountView(): HTMLDivElement {
  app = createApp(StockPreparationConfirmationQueueView as Component, { scope: SCOPE })
  app.mount(container!)
  return container!
}

function q(root: HTMLElement, testid: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${testid}"]`)
}

/** Settle the microtask queue AND the fetch promise, exactly as the sibling suites do. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => nextTick()).then(() => undefined)
}

/** Load the queue the way the operator does: type a project number, press refresh. */
async function loadQueueWith(rows: unknown[]): Promise<HTMLDivElement> {
  routeFetch(rows)
  const root = mountView()
  await flush()
  const input = q(root, 'stock-prep-confirmation-project-input') as HTMLInputElement
  input.value = '1-20232045'
  input.dispatchEvent(new Event('input'))
  await nextTick()
  ;(q(root, 'stock-prep-confirmation-queue-refresh') as HTMLButtonElement).click()
  await flush()
  return root
}

describe('缺件行不该邀请操作员走进死胡同 — unconfirmable holds in the confirmation queue', () => {
  beforeEach(() => {
    h.locale = 'zh-CN'
    h.permissions = [STOCK_PREP_READ, STOCK_PREP_OPERATE]
    h.roles = []
    h.apiFetch.mockReset()
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    app?.unmount()
    app = null
    container?.remove()
    container = null
  })

  it('U-01/U-02: a missing_component row disables the decide button and says what WOULD work', async () => {
    const root = await loadQueueWith([row('missing_component')])

    const button = q(root, 'stock-prep-confirmation-select') as HTMLButtonElement | null
    expect(button, 'the decide button still renders — the row is not hidden').not.toBeNull()
    expect(button!.disabled, 'a row the server will refuse must not invite a decision').toBe(true)

    const hint = q(root, 'stock-prep-confirmation-unconfirmable-hint')
    expect(hint, 'a disabled control without a reason sends the operator to support').not.toBeNull()
    // The remedy names the SOURCE SYSTEM and the fact that the next sync closes it — the two things
    // an operator cannot guess from a disabled button.
    expect(hint!.textContent).toContain('源系统')
    expect(hint!.textContent).toContain('下次同步')
  })

  it('U-03: clicking the refused row anyway opens no decision form', async () => {
    const root = await loadQueueWith([row('missing_component')])

    ;(q(root, 'stock-prep-confirmation-select') as HTMLButtonElement).click()
    await flush()

    expect(
      q(root, 'stock-prep-confirmation-form'),
      'selectRow must refuse the row too — a disabled button is clickable from a harness',
    ).toBeNull()
  })

  it('U-04: a duplicate_expanded_key row is untouched — enabled, unexplained, and it opens the form', async () => {
    const root = await loadQueueWith([row('duplicate_expanded_key')])

    const button = q(root, 'stock-prep-confirmation-select') as HTMLButtonElement
    expect(button.disabled, 'the one conflict type the server implements stays actionable').toBe(false)
    expect(
      q(root, 'stock-prep-confirmation-unconfirmable-hint'),
      'no dead-end notice on a row that is not a dead end',
    ).toBeNull()

    button.click()
    await flush()
    expect(q(root, 'stock-prep-confirmation-form')).not.toBeNull()
  })

  it('U-05: an unknown conflict type degrades to refused-and-explained, never to confirmable', async () => {
    const root = await loadQueueWith([row('some_future_conflict_type')])

    expect((q(root, 'stock-prep-confirmation-select') as HTMLButtonElement).disabled).toBe(true)
    expect(q(root, 'stock-prep-confirmation-unconfirmable-hint')).not.toBeNull()
  })
})
