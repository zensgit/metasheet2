// #4709 FSER-4 §4 gate 9 (amendment `docs/development/
// attendance-4709-fser4-member-projection-contract-amendment-20260804.md`, RATIFIED
// `45d71c4209af35a63768ce7ce9f576377f6b8ce4`, OD-4709-2=(a)): three-viewport browser evidence for
// all five surfaces, driven against the REAL app (not jsdom) with SYNTHETIC network stubs, mirroring
// `attendance-group-context-r2.spec.ts`'s installSession/installApiStubs pattern.
import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const GROUP_ID = '2f6b1d2c-9a3e-4c5b-8d7e-1a2b3c4d5e6f'
const RETURN_TO = '/attendance?tab=admin&section=attendance-admin-groups'
const SCHEDULE_ROUTE = `/attendance/admin/groups/${GROUP_ID}/schedule?returnTo=${encodeURIComponent(RETURN_TO)}`
const EVIDENCE_DIR = path.resolve(process.cwd(), '../../docs/development/assets/attendance-4709-fser4-frontend-20260807')

const VIEWPORTS = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'tablet-820x1180', width: 820, height: 1180 },
  { name: 'mobile-390x844', width: 390, height: 844 },
] as const

const group = {
  id: GROUP_ID,
  orgId: 'org-a',
  name: 'Ops Team',
  code: 'ops-team',
  timezone: 'Asia/Shanghai',
  ruleSetId: 'rule-set-1',
  attendanceType: 'fixed_shift',
  description: 'Synthetic browser-verification group',
  memberCount: 5,
}

const adminEffectivenessFixture = {
  groupId: GROUP_ID,
  state: 'configuration_changed',
  reasonCodes: ['DIFFERENT_MANAGED_KEY_ACTIVE', 'TARGET_MEMBER_MISSING'],
  desired: { shiftId: 'shift-1', startDate: '2026-08-01', endDate: '2026-08-31', revision: 3 },
  coverage: { targetMembers: 5, matchingMembers: 2, missingMembers: 3, nonMemberTargets: 0, differentKeyRows: 1 },
  drift: {
    unconfiguredManagedRows: 0,
    unpublishedManagedRows: 0,
    managedSets: [{ shiftId: 'shift-0', startDate: '2026-07-01', endDate: '2026-07-31', producerKey: 'old-key', rowCount: 4 }],
  },
  evaluatedAt: '2026-08-05T00:00:00.000Z',
}

const selfEffectivenessFixture = {
  groupId: GROUP_ID,
  state: 'pending_apply',
  reasonCodes: ['TARGET_MEMBER_MISSING'],
  desired: { shiftId: 'shift-1', startDate: '2026-08-01', endDate: '2026-08-31', revision: 3 },
  applicability: 'non_matching',
  evaluatedAt: '2026-08-05T00:00:00.000Z',
}

const selfRulesFixture = {
  userId: 'employee-1',
  orgId: 'org-a',
  assignment: {
    attendanceGroups: [{ id: GROUP_ID, name: 'Ops Team', code: 'ops-team', attendanceType: 'fixed_shift' }],
    scheduleGroups: [],
  },
  runtimeRule: {
    name: 'Default rule',
    timezone: 'Asia/Shanghai',
    workStartTime: '09:00',
    workEndTime: '18:00',
    workingDays: [1, 2, 3, 4, 5],
    lateGraceMinutes: 10,
    earlyGraceMinutes: 10,
    earlyLeaveGraceMinutes: 10,
    severeLateThresholdMinutes: 60,
    absenceLateThresholdMinutes: 120,
  },
}

function json(route: Route, payload: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) })
}

async function installSession(context: BrowserContext, options: { admin: boolean }): Promise<void> {
  const payload = btoa(JSON.stringify({
    sub: options.admin ? 'browser-admin' : 'browser-employee',
    tenantId: 'org-a',
    roles: options.admin ? ['admin'] : ['employee'],
    permissions: options.admin ? ['*:*', 'attendance:admin', 'attendance:read'] : ['attendance:read'],
  }))
  await context.addInitScript(({ token }) => {
    localStorage.setItem('auth_token', token)
    localStorage.setItem('jwt', token)
    localStorage.setItem('tenantId', 'org-a')
    localStorage.setItem('workspaceId', 'org-a')
    localStorage.setItem('metasheet_locale', 'en')
  }, { token: `eyJhbGciOiJub25lIn0.${payload}.signature` })
}

async function installApiStubs(page: Page, options: { admin: boolean }): Promise<void> {
  await page.route('**/*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (!url.pathname.startsWith('/api/')) return route.continue()

    if (url.pathname === '/api/auth/me') {
      return json(route, {
        ok: true,
        data: {
          user: {
            id: options.admin ? 'browser-admin' : 'browser-employee',
            tenantId: 'org-a',
            roles: options.admin ? ['admin'] : ['employee'],
            permissions: options.admin ? ['*:*', 'attendance:admin', 'attendance:read'] : ['attendance:read'],
            features: {
              attendance: true,
              attendanceAdmin: options.admin,
              attendanceImport: options.admin,
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
      return json(route, { ok: true, data: group })
    }
    if (url.pathname === `/api/attendance/groups/${GROUP_ID}/members`) {
      return json(route, { ok: true, data: { items: [], total: 0 } })
    }
    if (url.pathname === `/api/attendance/groups/${GROUP_ID}/managers`) {
      return json(route, { ok: true, data: { items: [], total: 0 } })
    }
    if (url.pathname === '/api/attendance/groups') {
      return json(route, { ok: true, data: { items: [group], total: 1, page: 1, pageSize: 200 } })
    }
    if (url.pathname === '/api/attendance/shifts') {
      return json(route, { ok: true, data: { items: [{ id: 'shift-1', orgId: 'org-a', name: 'Day Shift', workStartTime: '09:00', workEndTime: '18:00', workingDays: [1, 2, 3, 4, 5] }], total: 1 } })
    }
    if (url.pathname === '/api/attendance/rule-sets') {
      return json(route, { ok: true, data: { items: [{ id: 'rule-set-1', name: 'Ops Rules', version: 1, isDefault: true }], total: 1 } })
    }
    if (url.pathname === '/api/attendance/settings') {
      return json(route, { ok: true, data: {} })
    }
    if (url.pathname === '/api/attendance/rules/me') {
      return json(route, { ok: true, data: selfRulesFixture })
    }
    if (url.pathname === `/api/attendance/groups/${GROUP_ID}/fixed-schedule/effectiveness/me`) {
      return json(route, { ok: true, data: selfEffectivenessFixture })
    }
    if (url.pathname === `/api/attendance/groups/${GROUP_ID}/fixed-schedule/effectiveness`) {
      return json(route, { ok: true, data: adminEffectivenessFixture })
    }
    return json(route, { ok: true, data: { items: [], total: 0 } })
  })
}

test.beforeAll(() => {
  mkdirSync(EVIDENCE_DIR, { recursive: true })
})

for (const viewport of VIEWPORTS) {
  test(`group drawer: state/desired/counts/drift render, no overlap @ ${viewport.name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
    await installSession(context, { admin: true })
    const page = await context.newPage()
    await installApiStubs(page, { admin: true })

    await page.goto(SCHEDULE_ROUTE)
    const panel = page.locator('[data-attendance-fixed-schedule-effectiveness-panel]')
    await expect(panel).toBeVisible()
    // The app's real scroll container is `main.app-main` (overflow-y: auto), not
    // document.body -- `fullPage` screenshots only capture the (unscrolled) body box. Scroll the
    // panel to the top of its container so the evidence screenshot actually shows it.
    await panel.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await expect(page.locator('[data-attendance-fixed-schedule-state]')).toHaveAttribute('data-attendance-fixed-schedule-state-value', 'configuration_changed')
    await expect(page.locator('[data-attendance-fixed-schedule-managed-set]')).toHaveCount(1)
    await expect(page.locator('[data-attendance-fixed-schedule-count="target"]')).toContainText('5')

    // No-overlap check: the panel's bounding box must not intersect the existing preview form's
    // action buttons (both siblings inside the same "schedule" stage section).
    const panelBox = await panel.boundingBox()
    const previewSubmit = page.locator('[data-attendance-group-fixed-schedule-preview-submit]')
    const previewBox = await previewSubmit.boundingBox()
    expect(panelBox).toBeTruthy()
    expect(previewBox).toBeTruthy()
    if (panelBox && previewBox) {
      const overlaps = panelBox.y < previewBox.y + previewBox.height && panelBox.y + panelBox.height > previewBox.y
        && panelBox.x < previewBox.x + previewBox.width && panelBox.x + panelBox.width > previewBox.x
      expect(overlaps).toBe(false)
    }

    await page.screenshot({ path: path.join(EVIDENCE_DIR, `group-drawer-${viewport.name}.png`) })
    await context.close()
  })

  test(`employee schedule + self decision trace render, no overlap @ ${viewport.name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
    await installSession(context, { admin: false })
    const page = await context.newPage()
    await installApiStubs(page, { admin: false })

    await page.goto('/attendance?tab=overview')
    const card = page.locator('[data-attendance-self-fixed-schedule-card]')
    const trace = page.locator('[data-attendance-self-fixed-schedule-trace-section] [data-attendance-fixed-schedule-trace]')
    await expect(card).toBeVisible()
    await expect(trace).toBeVisible()
    await card.evaluate((el) => el.scrollIntoView({ block: 'start' }))
    await expect(page.locator('[data-attendance-self-fixed-schedule-state]')).toHaveAttribute('data-attendance-self-fixed-schedule-state-value', 'pending_apply')
    await expect(page.locator('[data-attendance-self-fixed-schedule-applicability]')).toHaveAttribute('data-attendance-self-fixed-schedule-applicability-value', 'non_matching')
    await expect(trace).toHaveAttribute('data-attendance-fixed-schedule-trace-audience', 'self')
    await expect(page.locator('[data-attendance-fixed-schedule-trace-applicability]')).toBeVisible()

    const cardBox = await card.boundingBox()
    const traceBox = await trace.boundingBox()
    expect(cardBox).toBeTruthy()
    expect(traceBox).toBeTruthy()
    if (cardBox && traceBox) {
      const overlaps = cardBox.y < traceBox.y + traceBox.height && cardBox.y + cardBox.height > traceBox.y
      // These are stacked cards, so a Y-overlap would indicate a layout bug; X ranges may share
      // the same column, which is expected -- only the vertical stacking must not overlap.
      expect(overlaps).toBe(false)
    }

    await page.screenshot({ path: path.join(EVIDENCE_DIR, `employee-self-${viewport.name}.png`) })
    await context.close()
  })

  test(`admin decision trace: typed group id -> load -> producer comparison renders @ ${viewport.name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
    await installSession(context, { admin: true })
    const page = await context.newPage()
    await installApiStubs(page, { admin: true })

    await page.goto('/attendance?tab=admin&section=attendance-admin-decision-trace')
    const input = page.locator('[data-attendance-fixed-schedule-trace-admin-group]')
    await expect(input).toBeVisible()
    await input.fill(GROUP_ID)
    await page.locator('[data-attendance-fixed-schedule-trace-admin-load]').click()

    const trace = page.locator('[data-attendance-admin-fixed-schedule-trace-section] [data-attendance-fixed-schedule-trace]')
    await expect(trace).toHaveAttribute('data-attendance-fixed-schedule-trace-audience', 'admin')
    await expect(page.locator('[data-attendance-fixed-schedule-trace-producer-comparison]')).toBeVisible()
    await expect(page.locator('[data-attendance-fixed-schedule-trace-applicability]')).toHaveCount(0)
    await trace.evaluate((el) => el.scrollIntoView({ block: 'start' }))

    await page.screenshot({ path: path.join(EVIDENCE_DIR, `admin-trace-${viewport.name}.png`) })
    await context.close()
  })

  test(`report widget: typed group id -> load -> state + counts only, no raw ids @ ${viewport.name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } })
    await installSession(context, { admin: true })
    const page = await context.newPage()
    await installApiStubs(page, { admin: true })

    await page.goto('/attendance?tab=reports')
    const input = page.locator('[data-attendance-fixed-schedule-report-group-id]')
    await expect(input).toBeVisible()
    await input.fill(GROUP_ID)
    await page.locator('[data-attendance-fixed-schedule-report-load]').click()

    await expect(page.locator('[data-attendance-fixed-schedule-report-state]')).toHaveAttribute('data-attendance-fixed-schedule-report-state-value', 'configuration_changed')
    await expect(page.locator('[data-attendance-fixed-schedule-report-counts]')).toBeVisible()
    const widgetHtml = await page.locator('[data-attendance-fixed-schedule-report-widget]').innerHTML()
    expect(widgetHtml).not.toContain('shift-1')
    expect(widgetHtml).not.toContain('old-key')
    await page.locator('[data-attendance-fixed-schedule-report-widget]').evaluate((el) => el.scrollIntoView({ block: 'start' }))

    await page.screenshot({ path: path.join(EVIDENCE_DIR, `report-widget-${viewport.name}.png`) })
    await context.close()
  })
}
