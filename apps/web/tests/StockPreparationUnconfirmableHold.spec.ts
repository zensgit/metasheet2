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
//   U-06 a KNOWN conflict type's hint actually says what is wrong (2026-09-10 field report (b))
//   B-01..B-06 the 「全部不可确认」 banner: when it appears, what it counts, and the two ways a row
//        fails to be 「still waiting on a person」 (settled status / no decisionId)

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
    // `workbenchAccess.ts` decides on the SNAPSHOT rather than on the expanding probe, so this
    // double has to carry it or every stock-prep predicate reads an empty principal.
    getAccessSnapshot: () => ({ isAdmin: h.roles.includes('admin'), email: '', roles: h.roles, permissions: h.permissions }),
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

/**
 * `status` and a nullable `decisionId` are parameters, not constants, because the banner's whole
 * scope is 「still waiting on a human」: `queue.rows` carries confirmed/superseded rows too whenever
 * the status filter is set to 全部, and a row with no decisionId cannot be acted on at all. A helper
 * that could only make `pending` rows with ids is a helper that cannot observe either rule.
 */
function row(conflictType: string, decisionId: string | null = 'decision_1', status = 'pending') {
  return {
    decisionId,
    conflictType,
    status,
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
    const hint = q(root, 'stock-prep-confirmation-unconfirmable-hint')
    expect(hint).not.toBeNull()
    // The CONSERVATIVE branch, verbatim: an unmapped type may not be described, only refused and
    // routed. If a future edit made the mapped shape ("这条在这一页处理不了:…") the default, this page
    // would be inventing a diagnosis for a code it has never seen.
    expect(hint!.textContent).toContain('这一类目前还不能在这一页确认')
    expect(hint!.textContent).not.toContain('这条在这一页处理不了')
  })

  // U-06 (2026-09-10 field report (b)): the six rows the materials admin was looking at were
  // SOURCE_VALUE_NOT_A_STRING, and the row hint said only 「这一类目前还不能在这一页确认」 — true, and
  // useless: it never said WHAT was wrong with the row. U-05 above pins that the conservative
  // sentence is still what an UNKNOWN type gets; this pins that a KNOWN one is actually described,
  // in the same words the 「什么情况」 column uses, plus the remedy that closes it.
  it('U-06: a KNOWN conflict type is described in the row hint, in words, not just refused', async () => {
    const root = await loadQueueWith([row('SOURCE_VALUE_NOT_A_STRING')])

    const hint = q(root, 'stock-prep-confirmation-unconfirmable-hint')
    expect(hint, 'the row is still refused, so the hint must still be there').not.toBeNull()
    expect(hint!.textContent, 'the plain sentence for THIS conflict type').toContain('源值不是文本')
    expect(hint!.textContent, 'and what would actually close it').toContain('源系统')
    // The raw enum stays out of the sentence (it is on the 什么情况 cell's title instead).
    expect(hint!.textContent).not.toContain('SOURCE_VALUE_NOT_A_STRING')
  })

  // 顶部一句话 (2026-09-10 field report): six SOURCE_VALUE_NOT_A_STRING rows, all pending, all
  // unconfirmable, and nothing on the page said so as a WHOLE — an operator had to open each row to
  // learn the same fact six times. values-free: names counts and points at the per-row column, never
  // a cell's content.
  it('B-01: EVERY pending row unconfirmable shows the values-free "next step" banner', async () => {
    const root = await loadQueueWith([
      row('SOURCE_VALUE_NOT_A_STRING', 'decision_1'),
      row('SOURCE_VALUE_NOT_A_STRING', 'decision_2'),
      row('missing_component', 'decision_3'),
    ])

    const banner = q(root, 'stock-prep-confirmation-all-unconfirmable-banner')
    expect(banner, 'all three pending rows are unconfirmable — the banner must say so').not.toBeNull()
    expect(banner!.textContent).toContain('3')
    expect(banner!.textContent).toContain('源数据')
    expect(banner!.textContent).toContain('什么情况')
  })

  it('B-02: ONE confirmable row among the pending set suppresses the banner', async () => {
    const root = await loadQueueWith([
      row('SOURCE_VALUE_NOT_A_STRING', 'decision_1'),
      row('duplicate_expanded_key', 'decision_2'),
    ])

    expect(
      q(root, 'stock-prep-confirmation-all-unconfirmable-banner'),
      'a confirmable row is on screen — its own controls are the more useful thing here',
    ).toBeNull()
  })

  it('B-03: an empty queue (nothing pending) shows no banner — there is nothing to say', async () => {
    const root = await loadQueueWith([])

    expect(q(root, 'stock-prep-confirmation-all-unconfirmable-banner')).toBeNull()
  })

  // B-04..B-06 pin the banner's SCOPE, which B-01..B-03 could not observe because every row they
  // build is `pending` with an id. The queue's status filter defaults to 全部, so `queue.rows`
  // routinely holds confirmed/superseded rows next to the pending ones — and 「都不能在这里确认」 is a
  // claim about the rows still waiting on a person, nothing else.
  it('B-04: a CONFIRMED confirmable row neither hides the banner nor is counted by it', async () => {
    const root = await loadQueueWith([
      row('SOURCE_VALUE_NOT_A_STRING', 'decision_1'),
      row('SOURCE_VALUE_NOT_A_STRING', 'decision_2'),
      // Already handled — and of the one type this page CAN confirm. If the banner looked at every
      // row instead of the pending ones, this single row would silence it and the operator would be
      // back to opening two dead-end rows to learn why nothing works.
      row('duplicate_expanded_key', 'decision_3', 'confirmed'),
    ])

    const banner = q(root, 'stock-prep-confirmation-all-unconfirmable-banner')
    expect(banner, 'both rows still waiting are unconfirmable — a settled row does not change that').not.toBeNull()
    expect(banner!.textContent, 'the count is the rows still waiting, not every row on screen').toContain('这 2 条')
    expect(banner!.textContent).not.toContain('这 3 条')
  })

  it('B-05: a queue with rows but NOTHING pending shows no banner', async () => {
    const root = await loadQueueWith([
      row('SOURCE_VALUE_NOT_A_STRING', 'decision_1', 'confirmed'),
      row('missing_component', 'decision_2', 'superseded'),
    ])

    expect(
      q(root, 'stock-prep-confirmation-all-unconfirmable-banner'),
      'nobody is waiting on anything here — 「这 2 条目前都不能确认」 would be a false alarm',
    ).toBeNull()
  })

  it('B-06: a pending row with no decisionId is not counted — it is not a row anyone can act on', async () => {
    const root = await loadQueueWith([
      row('SOURCE_VALUE_NOT_A_STRING', 'decision_1'),
      row('SOURCE_VALUE_NOT_A_STRING', 'decision_2'),
      row('SOURCE_VALUE_NOT_A_STRING', null),
    ])

    const banner = q(root, 'stock-prep-confirmation-all-unconfirmable-banner')
    expect(banner).not.toBeNull()
    expect(banner!.textContent, 'a row without an id is not one of "these N rows"').toContain('这 2 条')
    expect(banner!.textContent).not.toContain('这 3 条')
  })
})
