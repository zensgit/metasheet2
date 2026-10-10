import { expect, test, type Locator, type Page } from '@playwright/test'

// 退回 (return) candidates in a real browser: the real ApprovalDetailView, real Router / Pinia /
// Element Plus (the dialog AND the select dropdown), driven through
// approval-return-candidates-harness.ts, which only swaps fixture state in once the dev-mode API has
// loaded. Which targets the 退回 dialog offers, and whether the 退回 button renders at all, is
// production code: `returnableNodes` in ApprovalDetailView.vue — the DTO's `returnableNodeKeys` when
// it carries the field, else the legacy list (no client-side filter since G-4). The jsdom specs
// (tests/approval-detail-return-candidates.spec.ts) stub Element Plus with a native <select>; this
// lane reads the options Element Plus actually renders into its teleported dropdown.
//
// Graph (identity-consistent with the instance: template tpl_1, latestVersionId = pinned ver_1_1):
//   start → approval_1 → cc_1 → handler_1 → parallel_1 ⇉ {approval_p1, approval_p2} ⇉ join_1 → approval_2 → approval_3 → end
// Every fixture is a state a server can be in: the #6293 server for the scenarios that carry
// `returnableNodeKeys`, a server before #6293 for the field-less one, `legacy` (the harness header
// says which is which). What the return path reads is in the wire's shape (the harness header lists
// the display-only values it simplifies).
// The main history holds approval_1, cc_1, handler_1, approval_p1, join_1, approval_2 and approval_3
// (a 退回 from approval_3 back to approval_2), so the legacy list carries a visited key of every
// kind the server's walker leaves out (cc, handler, parallel branch, past the cursor); server-empty
// carries the first pass that leads to its handler_1 cursor plus the viewer's 评论 there.
//
//   scenario (harness)                | expectation                                | production rule pinned
//   ----------------------------------|--------------------------------------------|---------------------------------------------
//   server-list                       | 退回 shown; options exactly [approval_1]    | the DTO's `returnableNodeKeys` is the list
//   server-empty & template=drifted   | no 退回 button                              | `[]` hides 退回 where the legacy list would
//                                     |                                            | offer cc_1 / approval_1 (a #6293 action
//                                     |                                            | response at handler_1: rule (b) sends [])
//   server-list-wins                  | 退回 shown; options exactly [approval_1]    | the server list wins over history: after an
//                                     |                                            | admin forward jump history never held
//                                     |                                            | approval_1 (legacy list: no candidates), the
//                                     |                                            | server's walker still lists it
//   legacy                            | the legacy list, /history order            | no server field → every visited key but the
//                                     |                                            | cursor / start, with the own graph loaded: no
//                                     |                                            | client-side filter (the owner-approved
//                                     |                                            | fallback, 缺省回退 legacy)
//   submit                            | request {action:'return',                  | the chosen option's KEY is what is sent
//                                     |   targetNodeKey:'approval_1'}              |
//   server-list & template=drifted    | options exactly [approval_1]               | the server list decides with no own graph
//
// Every server-list row disagrees with the legacy list its own fixture would get without the field
// (six options for the main history, cc_1 / approval_1 for server-empty's, none for
// server-list-wins'), so a view that ignored the server's list fails each of them; server-empty is
// the one where `[]`, as opposed to an absent field, decides. `legacy` fails if a client-side filter
// is put back (the own graph is loaded, and under it only approval_1 is legal). The drifted rows
// predate G-4, when the client mirror judged by the graph; they now pin only that the server's list
// decides with no own graph in the store.
//
// Every scenario first proves the action bar is there (the 转交 button: same `canDecide` /
// desktop gates as 退回, and a verb the server accepts at a handler cursor too), so a missing 退回
// button can only mean an empty candidate list. 通过 is deliberately NOT a control: at a handler
// cursor the server refuses approve (APPROVAL_HANDLER_ACTION_NOT_ALLOWED) while the view still
// renders the button, so asserting it would pin that gap rather than the action bar.

const HARNESS = '/verification/approval-return-candidates-harness.html'

// Node names of the harness graph. None occurs in the dev-mode template, so a label below also
// proves the view named its options from the harness graph.
const APPROVAL_1 = '部门经理初审'
// The legacy list (no server field): every visited key but the cursor / start / end, first
// occurrence in the order the history was given (newest first): approval_3, join_1, approval_p1,
// handler_1, cc_1, approval_1. Rows of one server transaction tie on `occurred_at`, so this pins
// that the view keeps the order it is served, not an order the server guarantees among tied rows.
const LEGACY_UNFILTERED = ['总经理终审', '会签结果抄送', '法务会签', '资料补正办理', '抄送人事', APPROVAL_1]

async function openHarness(page: Page, query: string): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 960 })
  await page.route('**/api/plugins', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ plugins: [] }),
  }))
  await page.route('**/api/approvals/directory/resolve?**', (route) => {
    const ids = new URL(route.request().url()).searchParams.get('userIds')?.split(',') ?? []
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ users: ids.map((id) => ({ id, name: `姓名-${id}` })) }),
    })
  })
  await page.route('**/api/approvals/directory/users?**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ users: [] }),
  }))
  await page.goto(`${HARNESS}${query}`)
  await page.waitForFunction(() => window.__RC_READY__ === true || typeof window.__RC_ERROR__ === 'string')
  expect(await page.evaluate(() => window.__RC_ERROR__ ?? null)).toBeNull()
  // Positive control for every scenario (see the header): the member action bar rendered.
  await expect(page.getByTestId('approval-transfer-button')).toBeVisible()
}

async function openReturnDialog(page: Page): Promise<Locator> {
  const trigger = page.getByTestId('approval-return-button')
  await expect(trigger).toBeVisible()
  await trigger.click()
  const dialog = page.getByTestId('approval-return-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('dialog', { name: '退回审批' })).toBeVisible()
  // Nothing is chosen on open, so the confirm waits for a target.
  await expect(page.getByTestId('approval-return-submit')).toBeDisabled()
  return dialog
}

/** Opens the real Element Plus select and returns the options its dropdown actually rendered. */
async function openTargetOptions(page: Page, dialog: Locator): Promise<Locator> {
  const combobox = dialog.getByRole('combobox', { name: '选择退回目标节点' })
  await combobox.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " el-select__wrapper ")]').click()
  const options = page.locator('.el-select-dropdown:visible [role="option"]')
  await expect(options.first()).toBeVisible()
  return options
}

async function expectReturnOptions(page: Page, query: string, expected: string[], screenshot: string): Promise<void> {
  await openHarness(page, query)
  const dialog = await openReturnDialog(page)
  const options = await openTargetOptions(page, dialog)
  // Exact, ordered: the array form fails on any extra, missing or reordered option.
  await expect(options).toHaveText(expected)
  await expect(page.locator('.el-select-dropdown:visible [role="option"].is-disabled')).toHaveCount(0)
  await page.screenshot({ path: `verification-output/${screenshot}`, fullPage: false })
}

async function expectNoReturnButton(page: Page, query: string): Promise<void> {
  // The positive control is `openHarness`'s 转交 assertion, not 通过 (see the header).
  await openHarness(page, query)
  await expect(page.getByTestId('approval-return-button')).toHaveCount(0)
}

test('server-list: the DTO\'s returnableNodeKeys is the 退回 option list, verbatim', async ({ page }) => {
  await expectReturnOptions(page, '?scenario=server-list', [APPROVAL_1], 'rc-server-list-1440.png')
})

test('server-empty (template drifted): [] at a handler cursor hides 退回 where the legacy list would offer 抄送人事 / 部门经理初审', async ({ page }) => {
  await expectNoReturnButton(page, '?scenario=server-empty&template=drifted')
})

test('server-list-wins: after an admin forward jump history never held approval_1, and the server list still offers it', async ({ page }) => {
  await expectReturnOptions(page, '?scenario=server-list-wins', [APPROVAL_1], 'rc-server-list-wins-1440.png')
})

test('legacy: without the server field (a server before #6293) the legacy list comes back in /history order, own graph loaded', async ({ page }) => {
  await expectReturnOptions(page, '?scenario=legacy', LEGACY_UNFILTERED, 'rc-legacy-1440.png')
})

test('submit: choosing the offered target sends a return to approval_1 (recorded, no HTTP)', async ({ page }) => {
  await openHarness(page, '?scenario=submit')
  const dialog = await openReturnDialog(page)
  const options = await openTargetOptions(page, dialog)
  await expect(options).toHaveText([APPROVAL_1])
  await options.filter({ hasText: APPROVAL_1 }).click()
  await expect(page.locator('.el-select-dropdown:visible')).toHaveCount(0)

  const confirm = page.getByTestId('approval-return-submit')
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(page.getByRole('dialog', { name: '退回审批' })).toBeHidden()
  await expect(page.locator('.el-message--success')).toContainText('已退回审批')

  const requests = await page.evaluate(() => window.__RC_ACTION_REQUESTS__ ?? [])
  expect(requests).toEqual([
    { id: 'apv_5', req: { action: 'return', targetNodeKey: 'approval_1' } },
  ])
})

test('template drifted: the server list still decides — exactly approval_1, with no own graph in the store', async ({ page }) => {
  await expectReturnOptions(page, '?scenario=server-list&template=drifted', [APPROVAL_1], 'rc-drifted-server-list-1440.png')
})
