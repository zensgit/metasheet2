import { expect, test, type Locator, type Page } from '@playwright/test'

// 退回 (return) candidates in a real browser: the real ApprovalDetailView, real Router / Pinia /
// Element Plus (the dialog AND the select dropdown), driven through
// approval-return-candidates-harness.ts, which only swaps fixture state in once the dev-mode API has
// loaded. Which targets the 退回 dialog offers, and whether the 退回 button renders at all, is
// production code: `returnableNodes` in ApprovalDetailView.vue. The jsdom specs
// (tests/approval-detail-return-candidates.spec.ts) stub Element Plus with a native <select>; this
// lane reads the options Element Plus actually renders into its teleported dropdown.
//
// Graph (identity-consistent with the instance: template tpl_1, latestVersionId = pinned ver_1_1):
//   start → approval_1 → cc_1 → handler_1 → parallel_1 ⇉ {approval_p1, approval_p2} ⇉ join_1 → approval_2 → approval_3 → end
// Every fixture is a state the server can be in, and what the return path reads is in the wire's
// shape (see the harness header for the display-only values it simplifies): the
// main history holds approval_1, cc_1, handler_1, approval_p1, join_1, approval_2 and approval_3
// (a 退回 from approval_3 back to approval_2), so every exclusion rule has a visited key to drop;
// the handler and parallel scenarios carry the first pass that leads to their cursor.
//
//   scenario (harness)                | expectation                                | production rule pinned
//   ----------------------------------|--------------------------------------------|---------------------------------------------
//   server-list                       | 退回 shown; options exactly [approval_1]    | the DTO's `returnableNodeKeys` is the list
//   server-empty                      | no 退回 button                              | `[]` hides 退回 although the mirror would offer one
//   server-list-wins                  | 退回 shown; options exactly [approval_1]    | the server list wins over a DISAGREEING mirror
//                                     |                                            | with the graph present: after an admin forward
//                                     |                                            | jump history never held approval_1 (mirror: no
//                                     |                                            | candidates), the server's walker still lists it
//   client-mirror                     | 退回 shown; options exactly [approval_1]    | no server field → mirror: own graph, approval
//                                     |                                            | nodes only, outside parallel regions, upstream
//                                     |                                            | of the cursor, cursor itself excluded
//   handler-cursor                    | no 退回 button                              | a cursor AT a handler node hides 退回 (DTO type
//                                     |                                            | and own graph agree; history holds approval_1)
//   parallel-state                    | no 退回 button                              | a parallel frontier / fork cursor hides 退回
//   submit                            | request {action:'return',                  | the chosen option's KEY is what is sent
//                                     |   targetNodeKey:'approval_1'}              |
//   server-list & template=drifted    | options exactly [approval_1]               | the server list decides even with no own graph
//   client-mirror & template=drifted  | the legacy unfiltered list, /history order | no own graph (drift) → the pre-filter list
//   handler-cursor & template=drifted | no 退回 button                              | with no own graph, the DTO's `currentNodeType`
//                                     |                                            | alone hides 退回
//
// `server-list` alone cannot tell the server list from the mirror (with the graph in place both
// compute [approval_1]); `server-list-wins` and the drifted server-list row are the two that can.
//
// Every scenario first proves the action bar is there (the 转交 button: same `canDecide` /
// desktop gates as 退回), so a missing 退回 button can only mean an empty candidate list.

const HARNESS = '/verification/approval-return-candidates-harness.html'

// Node names of the harness graph. None occurs in the dev-mode template, so a label below also
// proves the view named its options from the harness graph.
const APPROVAL_1 = '部门经理初审'
// No graph of its own: every visited key but the cursor / start / end, first occurrence in the
// order the history was given (newest first): approval_3, join_1, approval_p1, handler_1, cc_1,
// approval_1. Rows of one server transaction tie on `occurred_at`, so this pins that the view keeps
// the order it is served, not an order the server guarantees among tied rows.
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
  await openHarness(page, query)
  await expect(page.getByTestId('approval-approve-button')).toBeVisible()
  await expect(page.getByTestId('approval-return-button')).toHaveCount(0)
}

test('server-list: the DTO\'s returnableNodeKeys is the 退回 option list, verbatim', async ({ page }) => {
  await expectReturnOptions(page, '?scenario=server-list', [APPROVAL_1], 'rc-server-list-1440.png')
})

test('server-empty: returnableNodeKeys [] hides 退回 although the client mirror would offer approval_1', async ({ page }) => {
  await expectNoReturnButton(page, '?scenario=server-empty')
})

test('server-list-wins: after an admin forward jump history never held approval_1, and the server list still offers it', async ({ page }) => {
  await expectReturnOptions(page, '?scenario=server-list-wins', [APPROVAL_1], 'rc-server-list-wins-1440.png')
})

test('client-mirror: without the server field only approval_1 survives (cc / handler / parallel-branch / downstream / cursor dropped)', async ({ page }) => {
  await expectReturnOptions(page, '?scenario=client-mirror', [APPROVAL_1], 'rc-client-mirror-1440.png')
})

test('handler-cursor: a cursor at handler_1 hides 退回 although history holds the upstream approval_1', async ({ page }) => {
  await expectNoReturnButton(page, '?scenario=handler-cursor')
})

test('parallel-state: a parallel frontier at the fork hides 退回', async ({ page }) => {
  await expectNoReturnButton(page, '?scenario=parallel-state')
  // The fixture really reached the page: the 并行中 badge names both branches from the harness graph.
  await expect(page.locator('.approval-detail__parallel-badge')).toHaveText('并行中 · 法务会签 / 合规会签')
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

test('template drifted: the server list still decides — exactly approval_1, where the mirror has no graph', async ({ page }) => {
  await expectReturnOptions(page, '?scenario=server-list&template=drifted', [APPROVAL_1], 'rc-drifted-server-list-1440.png')
})

test('template drifted, no server field: the legacy unfiltered list comes back in /history order', async ({ page }) => {
  await expectReturnOptions(page, '?scenario=client-mirror&template=drifted', LEGACY_UNFILTERED, 'rc-drifted-legacy-1440.png')
})

test('template drifted, handler cursor: with no own graph the DTO\'s currentNodeType alone hides 退回', async ({ page }) => {
  await expectNoReturnButton(page, '?scenario=handler-cursor&template=drifted')
})
