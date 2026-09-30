import { expect, test, type Page } from '@playwright/test'
import { CENTER_EN, CENTER_ZH } from '../src/views/approval/approvalCenterLabels'
import { DETAIL_EN, DETAIL_ZH } from '../src/views/approval/approvalDetailLabels'
import {
  MEMBER_ACTION_DIALOG_GRAMMAR,
  MEMBER_ACTION_DIALOG_GRAMMAR_EN,
  type MemberActionVerb,
} from '../src/approvals/memberActionDialogGrammar'

// ---------------------------------------------------------------------------
// O-8 / slice F8-1 — the approval member surface follows the shell locale, real Chromium
// (2026-09-30).
//
// The jsdom render scans pin "no CJK in English" per view. This lane checks the runtime switch on a
// real mounted page (real Router, Pinia, Element Plus, dialogs teleported to <body>): the harness
// starts in English and flips through the SAME `useLocale().setLocale` the app shell calls.
//
// For the approval center (「我发起的」 tab with a 催办 row) and for the detail page with each of the
// five member-action dialogs open, the page is snapshotted item by item — every visible text line
// plus every visible placeholder / aria-label / title attribute — in English, after a switch to
// zh-CN, and after switching back. Asserted:
//   * the English snapshot has no CJK (fixtures are ASCII, so every hit would be chrome);
//   * the zh-CN snapshot shows the zh-CN copy of named items (page title, tab labels, search
//     placeholder, 催办 label, dialog title / confirm label) — so the switch really re-rendered;
//   * switching back restores the English snapshot exactly, item for item.
// ---------------------------------------------------------------------------

const HARNESS = '/verification/approval-shell-locale-switch-harness.html'
const CJK = /[　-〿一-鿿＀-￯]/
const ROW_ID = 'apv_f81_row'
const DETAIL_ID = 'apv_f81_detail'

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

function listRow(id: string, title: string): Record<string, unknown> {
  return {
    id,
    sourceSystem: 'platform',
    title,
    status: 'pending',
    templateId: null,
    templateVersionId: null,
    requestNo: `AP-${id}`,
    requester: { id: 'user_current', name: 'Current User' },
    currentStep: 1,
    totalSteps: 2,
    currentNodeKey: 'approval_1',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    assignments: [],
  }
}

function detailDto(): Record<string, unknown> {
  return {
    ...listRow(DETAIL_ID, 'Travel claim'),
    requester: { id: 'user_requester', name: 'Requester One' },
    formSnapshot: { reason: 'Conference' },
    formSchema: null,
    policy: { rejectCommentRequired: true, allowRevoke: true, sourceOfTruth: 'platform' },
    nodeOperations: {
      allowTransfer: true,
      allowAddSign: true,
      allowReduceSign: true,
      allowReturn: true,
      commentRequired: 'reject_only',
    },
    assignments: [
      { id: 'asgn_current', type: 'user', assigneeId: 'user_current', sourceStep: 1, nodeKey: 'approval_1', isActive: true, metadata: { assigneeName: 'Current User' } },
      { id: 'asgn_added', type: 'user', assigneeId: 'user_added', sourceStep: 1, nodeKey: 'approval_1', isActive: true, metadata: { addSign: true, assigneeName: 'Added Approver' } },
    ],
  }
}

async function openHarness(page: Page, path: string): Promise<void> {
  // ONE handler for the whole API surface (same discipline as the other approval harness specs).
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const p = url.pathname
    if (p === '/api/approvals' && request.method() === 'GET') {
      return route.fulfill(json({ data: [listRow(ROW_ID, 'Laptop purchase')], total: 1 }))
    }
    if (p === '/api/approvals/pending-count') return route.fulfill(json({ count: 1, unreadCount: 1 }))
    if (p === '/api/approval-templates') return route.fulfill(json({ data: [], total: 0 }))
    if (/^\/api\/approvals\/[^/]+\/history$/.test(p)) {
      // One earlier approval step, so the timeline has a history row and 退回 has a target node.
      const items = [{
        id: 'hist_1',
        action: 'approve',
        actorId: 'user_ada',
        actorName: 'Ada Example',
        comment: 'Looks fine',
        fromStatus: 'pending',
        toStatus: 'pending',
        occurredAt: '2026-09-01T11:00:00.000Z',
        metadata: { nodeKey: 'approval_0' },
      }]
      return route.fulfill(json({ ok: true, data: { items, page: 1, pageSize: 20, total: items.length } }))
    }
    if (p === `/api/approvals/${DETAIL_ID}` && request.method() === 'GET') return route.fulfill(json(detailDto()))
    if (p === '/api/plugins') return route.fulfill(json({ plugins: [] }))
    return route.fulfill(json({ ok: true, data: {} }))
  })
  await page.goto(`${HARNESS}?path=${encodeURIComponent(path)}`)
  await page.waitForFunction(() => window.__F81_LOCALE_READY__ === true)
}

async function setLocale(page: Page, locale: 'en' | 'zh-CN'): Promise<void> {
  await page.evaluate((next) => window.__F81_SET_LOCALE__!(next), locale)
}

/** Every visible text line, then every visible placeholder / aria-label / title, in DOM order. */
async function snapshot(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const lines = document.body.innerText.split('\n').map((line) => line.trim()).filter(Boolean)
    const attrs: string[] = []
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if ((el as HTMLElement).getClientRects().length === 0) continue
      for (const name of ['placeholder', 'aria-label', 'title']) {
        const value = el.getAttribute(name)
        if (value) attrs.push(`@${name}=${value}`)
      }
    }
    return [...lines, ...attrs]
  })
}

function cjkItems(items: string[]): string[] {
  return items.filter((item) => CJK.test(item))
}

test.describe('approval member surface — runtime en / zh-CN switch', () => {
  test('approval center with a 催办 row: English, zh-CN, then English restored item by item', async ({ page }) => {
    await openHarness(page, '/approvals')
    await expect(page.getByText('Laptop purchase').first()).toBeVisible()
    await page.getByRole('tab', { name: CENTER_EN.tabMine }).click()
    const urge = page.getByTestId(`approval-urge-${ROW_ID}`)
    await expect(urge).toBeVisible()
    await expect(urge).toHaveText('Remind')

    const en = await snapshot(page)
    expect(cjkItems(en)).toEqual([])
    expect(en).toContain(CENTER_EN.title)
    expect(en).toContain(`@placeholder=${CENTER_EN.searchPlaceholder}`)

    await setLocale(page, 'zh-CN')
    await expect(page.getByText(CENTER_ZH.title, { exact: true })).toBeVisible()
    await expect(urge).toHaveText('催办')
    const zh = await snapshot(page)
    for (const item of [CENTER_ZH.title, CENTER_ZH.tabPending, CENTER_ZH.tabMine, `@placeholder=${CENTER_ZH.searchPlaceholder}`]) {
      expect(zh, `zh-CN snapshot shows ${item}`).toContain(item)
    }
    expect(zh).not.toContain(CENTER_EN.title)

    await setLocale(page, 'en')
    await expect(page.getByText(CENTER_EN.title, { exact: true })).toBeVisible()
    await expect(urge).toHaveText('Remind')
    expect(await snapshot(page)).toEqual(en)
  })

  // `button`: the DETAIL_EN / DETAIL_ZH key of the verb's action-bar button label.
  const VERBS: Array<{ verb: MemberActionVerb; trigger: string; button: keyof typeof DETAIL_EN }> = [
    { verb: 'transfer', trigger: 'approval-transfer-button', button: 'transfer' },
    { verb: 'add_sign', trigger: 'approval-add-sign-button', button: 'addSign' },
    { verb: 'reduce_sign', trigger: 'approval-reduce-sign-button', button: 'reduceSign' },
    { verb: 'return', trigger: 'approval-return-button', button: 'return' },
    { verb: 'comment', trigger: 'approval-comment-button', button: 'comment' },
  ]

  for (const { verb, trigger, button } of VERBS) {
    test(`detail page with the ${verb} dialog open: English, zh-CN, then English restored item by item`, async ({ page }) => {
      const enCopy = MEMBER_ACTION_DIALOG_GRAMMAR_EN[verb]
      const zhCopy = MEMBER_ACTION_DIALOG_GRAMMAR[verb]
      await openHarness(page, `/approvals/${DETAIL_ID}`)
      await expect(page.getByText('Travel claim').first()).toBeVisible()
      await page.getByTestId(trigger).click()
      await expect(page.getByRole('dialog', { name: enCopy.dialogTitle })).toBeVisible()

      const en = await snapshot(page)
      // The quick-phrase chips of the comment dialog stay zh-CN in this slice (they are inserted
      // into the comment text; left to the owner) — the only CJK allowed, by exact value.
      const allowed = verb === 'comment' ? ['已阅', '请尽快处理'] : []
      expect(cjkItems(en)).toEqual(allowed)
      expect(en).toContain(enCopy.confirmLabel)
      expect(en, 'English action-bar label').toContain(DETAIL_EN[button])

      await setLocale(page, 'zh-CN')
      await expect(page.getByRole('dialog', { name: zhCopy.dialogTitle })).toBeVisible()
      const zh = await snapshot(page)
      expect(zh, 'zh-CN confirm label').toContain(zhCopy.confirmLabel)
      expect(zh, 'zh-CN action-bar label').toContain(DETAIL_ZH[button])
      expect(zh).not.toContain(enCopy.confirmLabel)

      await setLocale(page, 'en')
      await expect(page.getByRole('dialog', { name: enCopy.dialogTitle })).toBeVisible()
      expect(await snapshot(page)).toEqual(en)
    })
  }
})
