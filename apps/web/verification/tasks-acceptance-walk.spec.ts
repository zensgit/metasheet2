import { expect, test, type Locator, type Page } from '@playwright/test'
import { recordLabel } from '../src/multitable/utils/meta-record-labels'
import { TASKS_ZH } from '../src/tasks/labels'
import {
  ASSIGNEE_TASK_ACCESS_REQUIRED_BODY,
  WALK_NO_ACCESS_USER_ID,
  WALK_ORG_ID,
  WALK_RECORD_TITLE,
  WALK_TASK_ID,
  walkSessionBody,
  walkTaskDetailBody,
} from './tasks-acceptance-walk-fixtures'

/**
 * Task usability package 1 — the acceptance walk's first two items, in a real browser
 * (playwright.tasks-verification.config.ts; harness: tasks-acceptance-walk-harness.html/.ts).
 *
 *  1. The 派发任务 dialog at 390 and 360 wide: the dialog's box inside the viewport with a 16px
 *     gutter on each side, the due date above the due time, and its controls reachable. A 1280
 *     control keeps the desktop layout, also inside the viewport. Red if the dialog's
 *     `@media (max-width: 480px)` block is removed (the dialog keeps its 420px minimum and spills
 *     past both edges; the due row stays a row); the 1280 control is red if that block is applied
 *     at every width. The page-scroll check only covers the page behind the dialog: the dialog sits
 *     in a fixed overlay, which the page's scroll width does not count, so the dialog's own box is
 *     what is compared with the viewport.
 *  2. A create that names an assignee without task access, from the dialog, and an assignee add on
 *     the task detail page: the server's 422 ASSIGNEE_TASK_ACCESS_REQUIRED shows that code's own
 *     message. The dialog is red if the code leaves CREATE_TASK_VALIDATION_CODES (tasks/tasksApi.ts),
 *     classifyDispatchFailure (tasks/recordTaskDispatch.ts) or the dialog's FAILURE_MESSAGES; the
 *     detail page is red if it leaves TASKS_CODE_KEYS (tasks/labels.ts). The detail page shows it
 *     below the add-assignee form, in the same section.
 *
 * The expected strings are read from the label tables themselves (both files import nothing), by
 * key, not through the lookups under test: `codeMessage` is not called here, so a missing
 * TASKS_CODE_KEYS entry cannot make both sides fall back to the same generic copy.
 *
 * Every `/api/**` request is answered here, in the shapes the server sends. A request
 * nothing here answers gets a 404 and is recorded; each test ends by asserting there was none, and
 * no uncaught page error either.
 */

const HARNESS = '/verification/tasks-acceptance-walk-harness.html'

// dispatch.errorAssigneeTaskAccess (multitable/utils/meta-record-labels.ts), zh.
const DIALOG_ACCESS_MESSAGE = recordLabel('dispatch.errorAssigneeTaskAccess', true)
// codeAssigneeTaskAccessRequired (tasks/labels.ts), zh.
const DETAIL_ACCESS_MESSAGE = TASKS_ZH.codeAssigneeTaskAccessRequired

interface ApiCall {
  method: string
  path: string
  body: string | null
}

interface WalkApi {
  calls: ApiCall[]
  unmocked: string[]
  pageErrors: string[]
  sent(method: string, path: string): ApiCall[]
}

function json(status: number, body: unknown) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) }
}

/** Answers every `/api/**` request of the page. Installed before the page loads. */
async function installApi(page: Page): Promise<WalkApi> {
  const calls: ApiCall[] = []
  const unmocked: string[] = []
  const detailPath = `/api/tasks/${WALK_TASK_ID}`
  await page.route(/^https?:\/\/[^\/]+\/api\//, async (route) => {
    const request = route.request()
    const { pathname } = new URL(request.url())
    const method = request.method()
    calls.push({ method, path: pathname, body: request.postData() })
    if (method === 'GET' && pathname === '/api/auth/me') return route.fulfill(json(200, walkSessionBody()))
    if (method === 'GET' && pathname === '/api/tasks/context') return route.fulfill(json(200, { orgId: WALK_ORG_ID }))
    if (method === 'GET' && pathname === '/api/task-lists') return route.fulfill(json(200, { items: [], total: 0 }))
    if (method === 'GET' && pathname === detailPath) return route.fulfill(json(200, walkTaskDetailBody()))
    if (method === 'GET' && pathname === `${detailPath}/comments`) return route.fulfill(json(200, { items: [], total: 0 }))
    if (method === 'POST' && pathname === `${detailPath}/assignees`) {
      return route.fulfill(json(422, ASSIGNEE_TASK_ACCESS_REQUIRED_BODY))
    }
    if (method === 'POST' && pathname === '/api/tasks') return route.fulfill(json(422, ASSIGNEE_TASK_ACCESS_REQUIRED_BODY))
    unmocked.push(`${method} ${pathname}`)
    return route.fulfill(json(404, { error: { code: 'VERIFY_UNMOCKED_ROUTE' } }))
  })
  return {
    calls,
    unmocked,
    pageErrors: [],
    sent: (method, path) => calls.filter((call) => call.method === method && call.path === path),
  }
}

async function openHarness(page: Page, width: number, height: number, surface: 'dispatch' | 'detail'): Promise<WalkApi> {
  await page.setViewportSize({ width, height })
  const api = await installApi(page)
  page.on('pageerror', (error) => api.pageErrors.push(error.message))
  await page.goto(`${HARNESS}?surface=${surface}`)
  await page.waitForFunction(() => window.__TASKS_WALK_READY__ === true || typeof window.__TASKS_WALK_ERROR__ === 'string')
  expect(await page.evaluate(() => window.__TASKS_WALK_ERROR__ ?? null), 'harness start').toBeNull()
  return api
}

function expectClean(api: WalkApi): void {
  expect(api.unmocked, 'requests nothing here answers').toEqual([])
  expect(api.pageErrors, 'uncaught page errors').toEqual([])
}

async function openDispatchDialog(page: Page): Promise<Locator> {
  await page.getByTestId('record-inspector-menu').click()
  const entry = page.getByTestId('record-inspector-dispatch-task')
  await expect(entry).toBeVisible()
  await entry.click()
  const dialog = page.getByTestId('record-task-dispatch-dialog')
  await expect(dialog).toBeVisible()
  // The prefill ran: the record's title and the person field's assignee are in the form.
  await expect(page.getByTestId('record-task-dispatch-title')).toHaveValue(WALK_RECORD_TITLE)
  await expect(page.locator(`[data-testid="record-task-dispatch-assignees"] [data-assignee-id="${WALK_NO_ACCESS_USER_ID}"]`)).toHaveCount(1)
  return dialog
}

async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const found = await locator.boundingBox()
  expect(found, 'element has a layout box').not.toBeNull()
  return found!
}

/** The page behind the dialog does not scroll sideways. It says nothing about the dialog itself: the
 *  dialog is in a fixed overlay, which `scrollWidth` does not count (see `expectInsideViewport`). */
async function expectNoPageHorizontalScroll(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
}

/** The dialog's own box lies within [0, innerWidth]. */
async function expectInsideViewport(page: Page, modal: { x: number; width: number }): Promise<void> {
  const innerWidth = await page.evaluate(() => window.innerWidth)
  expect(modal.x, 'dialog left edge inside the viewport').toBeGreaterThanOrEqual(0)
  expect(modal.x + modal.width, 'dialog right edge inside the viewport').toBeLessThanOrEqual(innerWidth)
}

/** The control is on screen once scrolled to, and inside the viewport's width. */
async function expectReachable(page: Page, testId: string, width: number): Promise<void> {
  const control = page.getByTestId(testId)
  await control.scrollIntoViewIfNeeded()
  await expect(control).toBeVisible()
  const rect = await box(control)
  expect(rect.x, `${testId} left edge`).toBeGreaterThanOrEqual(0)
  expect(rect.x + rect.width, `${testId} right edge`).toBeLessThanOrEqual(width)
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 360, height: 740 },
]) {
  test(`派发任务 dialog fits a ${viewport.width}px screen: inside the viewport with 16px gutters, due date above due time`, async ({ page }) => {
    const api = await openHarness(page, viewport.width, viewport.height, 'dispatch')
    const dialog = await openDispatchDialog(page)

    await expectNoPageHorizontalScroll(page)
    const modal = await box(dialog)
    await expectInsideViewport(page, modal)
    expect(Math.abs(modal.x - 16), 'left gutter').toBeLessThanOrEqual(1)
    expect(Math.abs(viewport.width - modal.x - modal.width - 16), 'right gutter').toBeLessThanOrEqual(1)
    expect(await dialog.locator('.meta-dispatch__body').evaluate((el) => el.scrollWidth <= el.clientWidth), 'no sideways scroll inside the dialog body').toBe(true)

    const date = await box(page.getByTestId('record-task-dispatch-due-date'))
    const time = await box(page.getByTestId('record-task-dispatch-due-time'))
    expect(time.y, 'due time starts below the due date').toBeGreaterThanOrEqual(date.y + date.height - 0.5)

    for (const testId of ['record-task-dispatch-title', 'record-task-dispatch-assignee-input', 'record-task-dispatch-submit']) {
      await expectReachable(page, testId, viewport.width)
    }

    await page.getByTestId('record-task-dispatch-title').scrollIntoViewIfNeeded()
    await page.screenshot({ path: `verification-output/tu-dispatch-${viewport.width}.png`, fullPage: false })
    expectClean(api)
  })
}

test('派发任务 dialog keeps its desktop layout at 1280px: at least 420px wide, due date and time side by side', async ({ page }) => {
  const api = await openHarness(page, 1280, 800, 'dispatch')
  const dialog = await openDispatchDialog(page)

  await expectNoPageHorizontalScroll(page)
  const modal = await box(dialog)
  await expectInsideViewport(page, modal)
  expect(modal.width, 'desktop minimum width').toBeGreaterThanOrEqual(420)
  expect(modal.width, 'desktop maximum width').toBeLessThanOrEqual(540)

  const date = await box(page.getByTestId('record-task-dispatch-due-date'))
  const time = await box(page.getByTestId('record-task-dispatch-due-time'))
  expect(time.x, 'due time to the right of the due date').toBeGreaterThanOrEqual(date.x + date.width - 0.5)
  expect(Math.abs(time.y - date.y), 'due date and time on one line').toBeLessThan(2)

  await page.screenshot({ path: 'verification-output/tu-dispatch-1280.png', fullPage: false })
  expectClean(api)
})

test('派发任务 naming an assignee without task access shows the task-access message (390px)', async ({ page }) => {
  const api = await openHarness(page, 390, 844, 'dispatch')
  await openDispatchDialog(page)

  await page.getByTestId('record-task-dispatch-due-date').fill('2031-05-06')
  await page.getByTestId('record-task-dispatch-submit').click()

  const error = page.getByTestId('record-task-dispatch-error')
  await expect(error).toBeVisible()
  expect(DIALOG_ACCESS_MESSAGE, 'the task-access copy, not the generic one').not.toBe(recordLabel('dispatch.errorFailed', true))
  await expect(error).toHaveText(DIALOG_ACCESS_MESSAGE)
  await expect(error).toHaveAttribute('role', 'alert')
  // Still the form, not a created task.
  await expect(page.getByTestId('record-task-dispatch-success')).toHaveCount(0)
  await expect(page.getByTestId('record-task-dispatch-submit')).toBeEnabled()

  const creates = api.sent('POST', '/api/tasks')
  expect(creates, 'one create request').toHaveLength(1)
  expect(JSON.parse(creates[0].body ?? '{}')).toMatchObject({ title: WALK_RECORD_TITLE, assignees: [WALK_NO_ACCESS_USER_ID] })
  // A failed create writes no source line.
  expect(api.calls.filter((call) => call.method === 'PATCH')).toEqual([])

  await error.scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'verification-output/tu-dispatch-access-390.png', fullPage: false })
  expectClean(api)
})

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
]) {
  test(`task detail: adding an assignee without task access shows the task-access message below the assignee form (${viewport.width}px)`, async ({ page }) => {
    const api = await openHarness(page, viewport.width, viewport.height, 'detail')
    const input = page.getByTestId('tasks-detail-add-assignee-input')
    await expect(input).toBeVisible()

    await input.fill(WALK_NO_ACCESS_USER_ID)
    await page.getByTestId('tasks-detail-add-assignee-submit').click()

    const error = page.getByTestId('tasks-detail-membership-error')
    await expect(error).toBeVisible()
    expect(DETAIL_ACCESS_MESSAGE, 'the task-access copy, not the generic one').not.toBe(TASKS_ZH.actionFailed)
    await expect(error).toHaveText(DETAIL_ACCESS_MESSAGE)
    await expect(error).toHaveAttribute('role', 'alert')
    await expect(page.getByTestId('tasks-action-error')).toHaveCount(0)
    // Below the add-assignee form, in the same section (the completion-mode switch sits between them).
    const form = page.getByTestId('tasks-detail-add-assignee-form')
    expect(
      await error.evaluate((el) => {
        const formEl = document.querySelector('[data-testid="tasks-detail-add-assignee-form"]')
        return Boolean(formEl && formEl.parentElement === el.parentElement
          && (formEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))
      }),
      'the message follows the add-assignee form in the same section',
    ).toBe(true)
    const formBox = await box(form)
    const errorBox = await box(error)
    expect(errorBox.y, 'the message starts below the add-assignee form').toBeGreaterThanOrEqual(formBox.y + formBox.height - 0.5)
    // The typed id stays, so it can be corrected.
    await expect(input).toHaveValue(WALK_NO_ACCESS_USER_ID)

    const adds = api.sent('POST', `/api/tasks/${WALK_TASK_ID}/assignees`)
    expect(adds, 'one assignee add request').toHaveLength(1)
    expect(JSON.parse(adds[0].body ?? '{}')).toEqual({ userId: WALK_NO_ACCESS_USER_ID })

    await error.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `verification-output/tu-detail-access-${viewport.width}.png`, fullPage: false })
    expectClean(api)
  })
}
