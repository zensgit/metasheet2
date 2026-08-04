import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const GROUP_ID = '2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f'
const OTHER_ORG_GROUP_ID = '9c4d2b1a-7e6f-4a3b-8c5d-1e2f3a4b5c6d'
const RETURN_TO = '/attendance?tab=admin&section=attendance-admin-groups'
const ASSIGNMENTS_ROUTE = `/attendance/admin/groups/${GROUP_ID}/schedule`
  + `?surface=assignments&returnTo=${encodeURIComponent(RETURN_TO)}`
const EVIDENCE_DIR = path.resolve(
  process.cwd(),
  '../../docs/development/assets/attendance-r2-20260804',
)

type RequestFact = { method: string; pathname: string }

const group = {
  id: GROUP_ID,
  orgId: 'org-a',
  name: 'Authorized Operations',
  code: 'authorized-operations',
  timezone: 'Asia/Shanghai',
  ruleSetId: 'rule-set-1',
  attendanceType: 'fixed_shift',
  description: 'Synthetic browser-verification group',
  memberCount: 1,
}

function json(route: Route, payload: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  })
}

async function installSession(context: BrowserContext): Promise<void> {
  const payload = btoa(JSON.stringify({
    sub: 'browser-admin',
    tenantId: 'org-a',
    roles: ['admin'],
    permissions: ['*:*', 'attendance:admin'],
  }))
  await context.addInitScript(({ token }) => {
    localStorage.setItem('auth_token', token)
    localStorage.setItem('jwt', token)
    localStorage.setItem('tenantId', 'org-a')
    localStorage.setItem('workspaceId', 'org-a')
    localStorage.setItem('metasheet_locale', 'en')
  }, { token: `eyJhbGciOiJub25lIn0.${payload}.signature` })
}

async function installApiStubs(
  page: Page,
  requests: RequestFact[],
  options: { groupStatus?: number } = {},
): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) {
      return route.continue()
    }
    requests.push({ method: request.method(), pathname: url.pathname })

    if (url.pathname === '/api/auth/me') {
      return json(route, {
        ok: true,
        data: {
          user: {
            id: 'browser-admin',
            tenantId: 'org-a',
            roles: ['admin'],
            permissions: ['*:*', 'attendance:admin'],
            features: {
              attendance: true,
              attendanceAdmin: true,
              attendanceImport: true,
              workflow: false,
              plm: false,
              mode: 'attendance',
            },
          },
        },
      })
    }
    if (url.pathname === '/api/plugins') {
      return json(route, [{ name: 'plugin-attendance', status: 'active' }])
    }
    if (url.pathname === `/api/attendance/groups/${GROUP_ID}`) {
      const status = options.groupStatus ?? 200
      return json(route, status === 200 ? { ok: true, data: group } : { ok: false }, status)
    }
    if (url.pathname === `/api/attendance/groups/${OTHER_ORG_GROUP_ID}`) {
      return json(route, { ok: false, error: { code: 'FORBIDDEN' } }, 403)
    }
    if (url.pathname === `/api/attendance/groups/${GROUP_ID}/members`) {
      return json(route, {
        ok: true,
        data: { items: [{ id: 'member-1', groupId: GROUP_ID, userId: 'user-1' }], total: 1 },
      })
    }
    if (url.pathname === `/api/attendance/groups/${GROUP_ID}/managers`) {
      return json(route, { ok: true, data: { items: [], total: 0 } })
    }
    if (url.pathname === '/api/attendance/groups') {
      return json(route, { ok: true, data: { items: [group], total: 1, page: 1, pageSize: 200 } })
    }
    if (url.pathname === '/api/attendance/shifts') {
      return json(route, {
        ok: true,
        data: {
          items: [{
            id: 'shift-1',
            orgId: 'org-a',
            name: 'Day Shift',
            workStartTime: '09:00',
            workEndTime: '18:00',
            workingDays: [1, 2, 3, 4, 5],
          }],
          total: 1,
        },
      })
    }
    if (url.pathname === '/api/attendance/rule-sets') {
      return json(route, {
        ok: true,
        data: { items: [{ id: 'rule-set-1', name: 'Operations Rules', version: 1, isDefault: true }], total: 1 },
      })
    }
    if (url.pathname === '/api/attendance/settings') {
      return json(route, { ok: true, data: {} })
    }
    return json(route, { ok: true, data: { items: [], total: 0 } })
  })
}

async function assertReadyAssignments(page: Page): Promise<void> {
  await expect(page.locator('[data-attendance-group-context="ready"]')).toBeVisible()
  const breadcrumb = page.locator('.attendance-group-context__breadcrumb')
  await expect(breadcrumb).toBeVisible()
  await expect(breadcrumb).toHaveText('Authorized Operations/Schedule')
  await expect(page.locator('[data-attendance-group-workflow-step="schedule"]')).toHaveAttribute('aria-current', 'step')
  await expect(page.locator('#attendance-admin-assignments')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/attendance/admin/groups/${GROUP_ID}/schedule\\?`))
}

test.beforeAll(() => {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
})

test('desktop drawer navigation survives Back, Forward, and refresh', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await installSession(context)
  const page = await context.newPage()
  const requests: RequestFact[] = []
  await installApiStubs(page, requests)

  await page.goto(RETURN_TO)
  await page.locator('[data-attendance-group-workflow-step="policies"]').click()
  await expect(page.locator('[data-attendance-group-summaries]')).toBeVisible()
  await page.locator('[data-attendance-group-summary-action="open-work-time-drawer"]').click()
  await expect(page.locator('[data-attendance-group-work-time-drawer]')).toBeVisible()
  await page.locator('[data-attendance-group-work-time-assignments-open]').click()
  await assertReadyAssignments(page)
  await page.evaluate(() => window.scrollTo(0, 0))
  await expect(page.locator('.attendance-group-context__breadcrumb')).toBeVisible()

  await page.screenshot({
    path: path.join(EVIDENCE_DIR, 'r2-desktop-assignments-1440x900.png'),
    fullPage: true,
  })

  await page.goBack()
  await expect(page).toHaveURL(new RegExp('/attendance\\?tab=admin&section=attendance-admin-groups$'))
  await expect(page.locator('[data-attendance-group-list]')).toBeVisible()
  await expect(page.locator('[data-attendance-group-workflow-step="basics"]')).toHaveAttribute('aria-current', 'step')

  await page.goForward()
  await assertReadyAssignments(page)
  await page.reload()
  await assertReadyAssignments(page)

  const writes = requests.filter(({ method, pathname }) => !(
    method === 'GET'
    || (method === 'POST' && pathname === '/api/attendance-admin/users/batch/resolve')
  ))
  expect(writes).toEqual([])
  await context.close()
})

test('narrow touch keeps the route intact and blocks all group probes', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  })
  await installSession(context)
  const page = await context.newPage()
  const requests: RequestFact[] = []
  await installApiStubs(page, requests)

  await page.goto(ASSIGNMENTS_ROUTE)
  await expect(page.getByText('Desktop recommended')).toBeVisible()
  await expect(page).toHaveURL(new RegExp(`/attendance/admin/groups/${GROUP_ID}/schedule\\?`))
  await expect(page.locator('[data-attendance-group-context]')).toHaveCount(0)
  await expect(page.locator('.attendance__drawer-backdrop')).toHaveCount(0)
  expect(requests.some(({ pathname }) => pathname.startsWith('/api/attendance/groups'))).toBe(false)

  await page.screenshot({
    path: path.join(EVIDENCE_DIR, 'r2-narrow-touch-blocked-390x844.png'),
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Back to Overview' }).click()
  await expect(page).toHaveURL(new RegExp('/attendance\\?tab=admin&section=attendance-admin-groups$'))
  await context.close()
})

test('wide coarse pointer remains unblocked', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    hasTouch: true,
    isMobile: false,
  })
  await installSession(context)
  const page = await context.newPage()
  const requests: RequestFact[] = []
  await installApiStubs(page, requests)

  await page.goto(ASSIGNMENTS_ROUTE)
  await assertReadyAssignments(page)
  await expect(page.getByText('Desktop recommended')).toHaveCount(0)
  expect(requests.some(({ pathname }) => pathname === `/api/attendance/groups/${GROUP_ID}`)).toBe(true)

  await page.screenshot({
    path: path.join(EVIDENCE_DIR, 'r2-wide-coarse-ready-1440x900.png'),
    fullPage: true,
  })
  await context.close()
})

for (const [name, groupId, status] of [
  ['unavailable', GROUP_ID, 404],
  ['cross-org', OTHER_ORG_GROUP_ID, 403],
] as const) {
  test(`${name} group fails closed before scoped requests`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    await installSession(context)
    const page = await context.newPage()
    const requests: RequestFact[] = []
    await installApiStubs(page, requests, { groupStatus: status })

    await page.goto(`/attendance/admin/groups/${groupId}/schedule?surface=assignments`)
    await expect(page.locator('[data-attendance-group-context="unavailable"]')).toBeVisible()
    expect(requests.filter(({ pathname }) => pathname.startsWith(`/api/attendance/groups/${groupId}/`))).toEqual([])
    await context.close()
  })
}
