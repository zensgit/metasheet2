import { expect, test, type Page } from '@playwright/test'

// ---------------------------------------------------------------------------
// Instance consistency, real Chromium (2026-09-06).
//
// The jsdom specs pin the rule; this lane pins it against the real network timing it exists for.
// The outgoing instance's detail response is DELAYED, the incoming one answers immediately, and the
// harness performs a params-only navigation in between — the exact ordering that used to leave one
// instance on screen while the route (and therefore every action) had already moved to another.
//
// Asserted from DOM/network evidence:
//   * the outgoing instance NEVER renders once the incoming one is displayed — sampled repeatedly
//     across the whole window in which its delayed response lands;
//   * the action the reader then takes is posted for the instance ON SCREEN;
//   * the action controls are unavailable while the incoming instance is still loading.
//
// Positive controls against a vacuous pass: both detail endpoints must actually have been
// intercepted (the harness disables the in-process fixture path, so a request that never reached
// the network would mean the delay was never applied), and the delayed response must have been
// delivered before the "never rendered" claim is made.
// ---------------------------------------------------------------------------

const HARNESS = '/verification/approval-instance-consistency-race-harness.html'
const SLOW_ID = 'apv_race_a'
const FAST_ID = 'apv_race_b'
const SLOW_TITLE = '慢响应实例'
const FAST_TITLE = '快响应实例'
const SLOW_RESPONSE_MS = 1500

interface Interception {
  detailRequests: string[]
  detailResponses: string[]
  actionRequests: Array<{ id: string; body: string }>
}

function instanceDto(id: string, title: string, status = 'pending'): Record<string, unknown> {
  return {
    id,
    sourceSystem: 'platform',
    title,
    status,
    templateId: null,
    templateVersionId: null,
    requestNo: `AP-${id}`,
    requester: { id: 'user_requester', name: '发起人' },
    currentStep: 1,
    totalSteps: 2,
    currentNodeKey: 'approval_1',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    formSnapshot: { fld_reason: title },
    formSchema: null,
    policy: { rejectCommentRequired: false, allowRevoke: true, sourceOfTruth: 'platform' },
    nodeOperations: {
      allowTransfer: false,
      allowAddSign: false,
      allowReduceSign: false,
      allowReturn: false,
      commentRequired: 'never',
    },
    assignments: [
      {
        id: `asgn_${id}`,
        type: 'user',
        assigneeId: 'user_current',
        sourceStep: 1,
        nodeKey: 'approval_1',
        isActive: true,
        metadata: { assigneeName: '当前审批人' },
      },
    ],
  }
}

function json(body: unknown) {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(body) }
}

async function openHarness(page: Page): Promise<Interception> {
  const seen: Interception = { detailRequests: [], detailResponses: [], actionRequests: [] }

  // ONE handler for the whole API surface: Playwright resolves overlapping routes by registration
  // order, and a single dispatcher keeps the delayed detail response from being shadowed.
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname

    const action = /^\/api\/approvals\/([^/]+)\/actions$/.exec(path)
    if (action) {
      seen.actionRequests.push({ id: action[1], body: request.postData() ?? '' })
      const title = action[1] === FAST_ID ? FAST_TITLE : SLOW_TITLE
      return route.fulfill(json(instanceDto(action[1], title, 'approved')))
    }

    if (/^\/api\/approvals\/[^/]+\/history$/.test(path)) {
      return route.fulfill(json({ ok: true, data: { items: [], page: 1, pageSize: 20, total: 0 } }))
    }

    const detail = /^\/api\/approvals\/([^/]+)$/.exec(path)
    if (detail && request.method() === 'GET') {
      const id = detail[1]
      seen.detailRequests.push(id)
      if (id === SLOW_ID) await new Promise((resolve) => setTimeout(resolve, SLOW_RESPONSE_MS))
      seen.detailResponses.push(id)
      return route.fulfill(json(instanceDto(id, id === FAST_ID ? FAST_TITLE : SLOW_TITLE)))
    }

    if (path === '/api/plugins') return route.fulfill(json({ plugins: [] }))
    return route.fulfill(json({ ok: true, data: {} }))
  })

  await page.goto(HARNESS)
  await page.waitForFunction(() => window.__P0B_READY__ === true)
  return seen
}

test.describe('approval detail — instance consistency', () => {
  test('a slow outgoing instance never renders once the incoming one is displayed, and the action posts the displayed id', async ({ page }) => {
    const seen = await openHarness(page)

    // The slow instance has not arrived: the page is in its loading state and offers no action.
    await expect(page.getByTestId('detail-skeleton')).toBeVisible()
    await expect(page.getByTestId('approval-approve-button')).toHaveCount(0)

    // Params-only navigation while the first request is still outstanding.
    await page.evaluate((id) => window.__P0B_NAVIGATE__!(id), FAST_ID)

    await expect(page.getByText(FAST_TITLE).first()).toBeVisible()
    const approve = page.getByTestId('approval-approve-button')
    await expect(approve).toBeEnabled()

    // Sample the whole window in which the delayed response for the outgoing instance lands.
    const sightings: string[] = []
    const deadline = Date.now() + SLOW_RESPONSE_MS + 1500
    while (Date.now() < deadline) {
      const text = (await page.locator('body').textContent()) ?? ''
      if (text.includes(SLOW_TITLE)) sightings.push(text.slice(0, 120))
      await page.waitForTimeout(50)
    }

    // Positive controls: the delay was really applied to a real request, and the delayed response
    // really was delivered — otherwise "never rendered" would be a claim about nothing.
    expect(seen.detailRequests).toContain(SLOW_ID)
    expect(seen.detailRequests).toContain(FAST_ID)
    expect(seen.detailResponses).toContain(SLOW_ID)
    expect(sightings).toEqual([])
    await expect(page.getByText(FAST_TITLE).first()).toBeVisible()

    // The action follows what the reader is looking at.
    await approve.click()
    await page.getByTestId('approval-action-dialog-confirm').click()

    await expect.poll(() => seen.actionRequests.length).toBe(1)
    expect(seen.actionRequests[0].id).toBe(FAST_ID)
    expect(JSON.parse(seen.actionRequests[0].body).action).toBe('approve')
  })

  test('no action is offered while the incoming instance is still loading', async ({ page }) => {
    const seen = await openHarness(page)

    await expect(page.getByText(SLOW_TITLE).first()).toBeVisible()
    await expect(page.getByTestId('approval-approve-button')).toBeEnabled()

    // Navigate BACK onto the slow instance (a fresh delayed request) and check the window in
    // between: no action control is offered for an instance the page is not displaying yet.
    await page.evaluate((id) => window.__P0B_NAVIGATE__!(id), FAST_ID)
    await expect(page.getByText(FAST_TITLE).first()).toBeVisible()
    await page.evaluate((id) => window.__P0B_NAVIGATE__!(id), SLOW_ID)

    await expect(page.getByTestId('detail-skeleton')).toBeVisible()
    await expect(page.getByTestId('approval-approve-button')).toHaveCount(0)
    expect(seen.actionRequests).toEqual([])

    // Positive control: once the instance is actually displayed, the same control is back.
    await expect(page.getByText(SLOW_TITLE).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('approval-approve-button')).toBeEnabled()
  })
})
