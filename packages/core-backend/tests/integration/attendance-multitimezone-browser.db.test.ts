import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import path from 'node:path'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { hash } from 'bcryptjs'
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { createServer, type ViteDevServer } from '../../../../apps/web/node_modules/vite/dist/node/index.js'
import { createOnlinePunchDbFixture, punchClock } from '../utils/attendance-online-punch-db'

if (!process.env.ATTENDANCE_TEST_DATABASE_URL) throw new Error('MULTITIMEZONE_BROWSER_REAL_DATABASE_REQUIRED')
if (!process.env.METASHEET_ENV_DIR) throw new Error('MULTITIMEZONE_BROWSER_EMPTY_ENV_DIRECTORY_REQUIRED')
const fixture = createOnlinePunchDbFixture({ retainHistoryInIsolatedDatabase: true })
const require = createRequire(import.meta.url)
const { setBusinessTripInstantForTests } = require('../../../../plugins/plugin-attendance/lib/attendance-business-trip.cjs')
function setScenarioInstant(value: string): void {
  punchClock.setOnlinePunchInstantForTests(value)
  setBusinessTripInstantForTests(value)
}
const output = path.resolve(process.env.ATTENDANCE_BROWSER_OUTPUT_DIR || 'artifacts/attendance-multitimezone-browser')
const password = 'Synthetic-attendance-qualification-Only-2026!'
// Keep the synthetic clock within the actual rules/me asOf horizon while
// exercising the UTC/local date correction through the real endpoint.
// All scenario punches also remain in the past for the existing future-punch guard.
const targetDay = new Date()
targetDay.setUTCHours(0, 0, 0, 0)
targetDay.setUTCDate(targetDay.getUTCDate() - 4)
const targetWorkDate = targetDay.toISOString().slice(0, 10)
const initialServerInstant = new Date(targetDay.getTime() - 3_600_000).toISOString()
const punchServerInstant = new Date(targetDay.getTime() + 1_800_000).toISOString()
type Actor = Awaited<ReturnType<typeof fixture.user>>
let admin: Actor
let employee: Actor
let browser: Browser | undefined
let web: ViteDevServer | undefined
let webBase = ''
let employeeContext: BrowserContext | undefined
let adminContext: BrowserContext | undefined
let employeePage: Page
let adminPage: Page
const priorCancelEntry = process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED
const pageErrors: string[] = []
let approvedTripId = ''
const tripDay = new Date(targetDay.getTime() + 86_400_000)
const tripWorkDate = tripDay.toISOString().slice(0, 10)
const tripEnd = new Date(tripDay.getTime() + 2 * 86_400_000)

async function login(page: Page, actor: Actor) {
  await page.bringToFront()
  await page.goto(webBase + '/login', { waitUntil: 'domcontentloaded' })
  await page.locator('input[autocomplete="username"]').waitFor({ timeout: 120_000 })
  await page.locator('input[autocomplete="username"]').fill(actor.userId + '@online-clock.test')
  await page.locator('input[autocomplete="current-password"]').fill(password)
  const result = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/login'
    && response.request().method() === 'POST')
  await page.locator('.login-submit').click()
  const response = await result
  expect(response.status()).toBe(200)
  const body = await response.json()
  expect(body.success).toBe(true)
  expect(typeof body.data?.token).toBe('string')
  expect(body.data?.user?.id).toBe(actor.userId)
  expect(body.data?.user?.tenantId).toBe(fixture.orgId)
  expect(body.data?.features?.attendance).toBe(true)
  if (actor === admin) expect(body.data?.features?.attendanceAdmin).toBe(true)
  await page.waitForURL(url => url.pathname !== '/login', { timeout: 60_000 })
}
async function recordRules(response: import('@playwright/test').Response, name: string) {
  const body = await response.json()
  const data = body.data
  const context = data?.attendanceTimeContext
  await writeFile(path.join(output, name + '.json'), JSON.stringify({
    status: response.status(), topKeys: Object.keys(body).sort(),
    dataKeys: data ? Object.keys(data).sort() : [],
    contextKeys: context ? Object.keys(context).sort() : [],
    resolvedAt: data?.resolvedAt, resolvedForDate: data?.resolvedForDate, context,
  }, null, 2))
}
async function openAdminRequest(requestId: string): Promise<void> {
  await adminPage.bringToFront()
  const focused = adminPage.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/requests/' + requestId)
  await adminPage.goto(webBase + '/attendance?requestId=' + encodeURIComponent(requestId), { waitUntil: 'domcontentloaded' })
  const response = await focused
  const body = await response.json()
  await writeFile(path.join(output, 'focused-request-diagnostic.json'), JSON.stringify({
    status: response.status(), errorCode: body.error?.code ?? null,
    identityMatches: body.data?.request?.id === requestId,
    requestType: body.data?.request?.request_type ?? body.data?.request?.requestType ?? null,
    statusEnum: body.data?.request?.status ?? null,
  }, null, 2))
  expect(response.status(), body.error?.code).toBe(200)
  expect(body.data?.request?.id).toBe(requestId)
  const tools = adminPage.locator('[data-attendance-request-tools]')
  await tools.locator('summary').waitFor()
  if (await tools.getAttribute('open') === null) await tools.locator('summary').click()
}
async function refreshEmployee() {
  await employeePage.bringToFront()
  // Match a newly issued request, not an old tab's in-flight response that
  // Chromium may discard while reload replaces its document.
  const requested = employeePage.waitForRequest(value => new URL(value.url()).pathname === '/api/attendance/rules/me')
  await employeePage.reload({ waitUntil: 'domcontentloaded' })
  const refreshed = await (await requested).response()
  expect(refreshed).not.toBeNull()
  if (!refreshed) throw new Error('BROWSER_RULES_RESPONSE_REQUIRED')
  expect(refreshed.status()).toBe(200)
  await recordRules(refreshed, 'warm-rules')
}
describe('multi-timezone actual browser login, API and isolated PostgreSQL', () => {
  beforeAll(async () => {
    process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED = 'true'
    await mkdir(output, { recursive: true })
    setScenarioInstant(initialServerInstant)
    admin = await fixture.start()
    employee = await fixture.user(false)
    const passwordHash = await hash(password, 8)
    await fixture.pool.query("UPDATE users SET password_hash=$1,activation_status='activated',local_password_set=true,must_change_password=false WHERE id=ANY($2::text[])", [passwordHash, [admin.userId, employee.userId]])
    await fixture.pool.query("INSERT INTO user_permissions(user_id,permission_code) VALUES($1,'attendance:write') ON CONFLICT DO NOTHING", [employee.userId])
    await fixture.pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.userId])
    const rule = await fixture.request('/api/attendance/rules/default', admin.token, {
      orgId: fixture.orgId, timezone: 'Asia/Singapore', workStartTime: '09:00', workEndTime: '18:00',
      workingDays: [0, 1, 2, 3, 4, 5, 6],
    }, 'PUT')
    expect(rule.status).toBe(200)
    for (const requestType of ['business_trip', 'time_correction']) {
      const flow = await fixture.request('/api/attendance/approval-flows', admin.token, {
        orgId: fixture.orgId, name: 'Synthetic browser ' + requestType, requestType,
        steps: [{ approverUserIds: [admin.userId] }],
      })
      expect(flow.status).toBe(201)
    }
    const webRoot = path.resolve(__dirname, '../../../../apps/web')
    web = await createServer({
      root: webRoot, configFile: path.join(webRoot, 'vite.config.ts'),
      envDir: process.env.METASHEET_ENV_DIR, cacheDir: path.join(output, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, hmr: false,
        proxy: { '/api': { target: fixture.getBaseUrl(), changeOrigin: true, ws: true } } },
    })
    await web.listen()
    const address = web.httpServer?.address()
    if (!address || typeof address === 'string') throw new Error('BROWSER_VITE_LOOPBACK_REQUIRED')
    webBase = 'http://127.0.0.1:' + address.port
    browser = await chromium.launch({ headless: true })
    employeeContext = await browser.newContext({ timezoneId: 'America/New_York', viewport: { width: 1280, height: 900 } })
    adminContext = await browser.newContext({ timezoneId: 'Asia/Tokyo', viewport: { width: 1280, height: 900 } })
    employeePage = await employeeContext.newPage()
    adminPage = await adminContext.newPage()
    employeePage.setDefaultTimeout(90_000)
    adminPage.setDefaultTimeout(90_000)
    let ruleResponseRound = 0
    for (const page of [employeePage, adminPage]) {
      page.on('pageerror', () => pageErrors.push('BROWSER_PAGE_ERROR'))
      page.on('response', async response => {
        const url = new URL(response.url())
        if (url.pathname !== '/api/attendance/rules/me') return
        const ordinal = ruleResponseRound++
        try {
          const body = await response.json()
          const context = body.data?.attendanceTimeContext
          await writeFile(path.join(output, 'rules-response-' + ordinal + '.json'), JSON.stringify({
            actor: page === employeePage ? 'employee' : 'admin',
            status: response.status(),
            corrective: url.searchParams.has('asOf'),
            requestedDateEqualsResolvedDate: url.searchParams.has('asOf') && body.data ? url.searchParams.get('asOf') === body.data.resolvedForDate : null,
            resolvedDateEqualsCurrentDate: body.data && context ? body.data.resolvedForDate === context.currentLocalDate : null,
            contextInstantEqualsResolvedAt: body.data && context ? context.resolvedForInstant === body.data.resolvedAt : null,
            currentContextKeys: context ? Object.keys(context).sort() : [],
          }, null, 2))
        } catch {
          await writeFile(path.join(output, 'rules-response-' + ordinal + '.json'), JSON.stringify({ code: 'RULES_RESPONSE_DIAGNOSTIC_UNAVAILABLE' }))
        }
      })
    }
  }, 240_000)
  let diagnosticRound = 0
  afterEach(async () => {
    const states = []
    for (const [name, page] of [['employee', employeePage], ['admin', adminPage]] as const) {
      if (!page || page.isClosed()) continue
      states.push({ actor: name, routePath: new URL(page.url()).pathname,
        routeTab: new URL(page.url()).searchParams.get('tab'),
        routeSection: new URL(page.url()).searchParams.get('section'),
        documentHidden: await page.evaluate(() => document.hidden),
        clockDiagnostics: await page.evaluate(() => {
          type Component = { type?: { __file?: string }; parent?: Component; setupState?: Record<string, unknown> }
          const element = document.querySelector('[data-attendance-hero-timezone]')
          let component = (element as unknown as { __vueParentComponent?: Component } | null)?.__vueParentComponent
          while (component && !component.type?.__file?.endsWith('/AttendanceView.vue')) component = component.parent
          const state = component?.setupState
          return {
            componentFound: Boolean(component),
            stateHasSnapshot: Boolean(state?.selfRulesSnapshot),
            stateHasCurrentContext: Boolean(state?.currentTimeContext),
            stateHasHeroInstant: Boolean(state?.heroClockNow),
            stateHasRulesError: Boolean(state?.selfRulesError),
            rulesLoading: state?.selfRulesLoading === true,
            rulesRequests: performance.getEntriesByType('resource')
              .filter(entry => new URL(entry.name).pathname === '/api/attendance/rules/me')
              .map(entry => ({ durationMs: Math.round(entry.duration), corrective: new URL(entry.name).searchParams.has('asOf') })),
          }
        }),
        timezoneLabelText: await page.locator('[data-attendance-hero-timezone]').allTextContents(),
        loginFormPresent: await page.locator('.login-form').count(),
        timezoneLabelPresent: await page.locator('[data-attendance-hero-timezone]').count(),
        policyPanelPresent: await page.locator('[data-attendance-timezone-policy]').count() })
      await page.screenshot({ path: path.join(output, name + '-state-' + diagnosticRound + '.png'), fullPage: true })
    }
    await writeFile(path.join(output, 'state-' + diagnosticRound++ + '.json'),
      JSON.stringify({ states, pageErrorCodes: pageErrors }, null, 2))
  })
  afterAll(async () => {
    await employeeContext?.close()
    await adminContext?.close()
    await browser?.close()
    await web?.close()
    await fixture.stop()
    setBusinessTripInstantForTests(null)
    if (priorCancelEntry === undefined) delete process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED
    else process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED = priorCancelEntry
  }, 60_000)

  it('logs in through the real form and shows the system default when multi-timezone is OFF', async () => {
    await login(employeePage, employee)
    const rules = employeePage.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/rules/me')
    await employeePage.goto(webBase + '/attendance', { waitUntil: 'domcontentloaded' })
    const initialRules = await rules
    expect(initialRules.status()).toBe(200)
    await recordRules(initialRules, 'initial-rules')
    await employeePage.locator('[data-attendance-hero-timezone]').waitFor()
    await refreshEmployee()
    await employeePage.locator('[data-attendance-hero-timezone]').filter({ hasText: 'Asia/Singapore' }).waitFor({ timeout: 60_000 })
    expect((await fixture.pool.query('SELECT enabled FROM attendance_timezone_policies WHERE org_id=$1', [fixture.orgId])).rows).toEqual([])
    await employeePage.screenshot({ path: path.join(output, 'employee-default-off.png'), fullPage: true })
    expect(pageErrors).toEqual([])
  }, 240_000)

  it('uses actual admin preview and explicit save, with no policy writes during preview', async () => {
    await login(adminPage, admin)
    await adminPage.goto(webBase + '/attendance?tab=admin&section=attendance-admin-settings', { waitUntil: 'domcontentloaded' })
    await adminPage.locator('[data-attendance-timezone-policy]').waitFor({ timeout: 60_000 })
    await adminPage.locator('[data-attendance-timezone-policy] button').first().click()
    await adminPage.locator('[data-timezone-default]').waitFor()
    await adminPage.locator('[data-timezone-proposed]').check()
    const preview = adminPage.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/timezone-policy/preview')
    await adminPage.locator('[data-timezone-preview]').click()
    expect((await preview).status()).toBe(200)
    await adminPage.locator('[data-timezone-impact]').waitFor()
    expect(await adminPage.locator('[data-timezone-conflicting]').textContent()).toBe('0')
    expect((await fixture.pool.query('SELECT enabled FROM attendance_timezone_policies WHERE org_id=$1', [fixture.orgId])).rows).toEqual([])
    const saved = adminPage.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/timezone-policy'
      && response.request().method() === 'PUT')
    await adminPage.locator('[data-timezone-save]').click()
    expect((await saved).status()).toBe(200)
    expect((await fixture.pool.query('SELECT enabled,version FROM attendance_timezone_policies WHERE org_id=$1', [fixture.orgId])).rows)
      .toEqual([{ enabled: true, version: 1 }])
    await adminPage.screenshot({ path: path.join(output, 'admin-explicit-enable-synthetic.png'), fullPage: true })
    await adminPage.setViewportSize({ width: 390, height: 844 })
    try {
      const mobileSettings = adminPage.locator('[data-attendance-timezone-policy]')
      await mobileSettings.locator('[data-timezone-default]').scrollIntoViewIfNeeded()
      expect(await mobileSettings.locator('[data-timezone-default]').isVisible()).toBe(true)
      expect(await mobileSettings.locator('[data-timezone-default]').textContent()).toBe('Asia/Singapore')
      expect(await mobileSettings.locator('[data-timezone-enabled]').textContent()).toMatch(/Enabled|已启用/)
      expect(await mobileSettings.locator('[data-timezone-proposed]').isVisible()).toBe(true)
      expect(await mobileSettings.locator('[data-timezone-proposed]').isChecked()).toBe(true)
      await adminPage.screenshot({ path: path.join(output, 'mobile-admin-timezone-settings.png'), fullPage: true })
    } finally {
      await adminPage.setViewportSize({ width: 1280, height: 900 })
    }
    expect(pageErrors).toEqual([])
  }, 240_000)

  it('refreshes an administrator employee override and stores a browser punch at the server UTC instant', async () => {
    const override = await fixture.request('/api/attendance/timezone-policy/employees/' + employee.userId, admin.token, {
      timezone: 'Asia/Tokyo', effectiveFrom: initialServerInstant, effectiveTo: null, expectedPolicyVersion: 1,
    })
    expect(override.status).toBe(201)
    setScenarioInstant(punchServerInstant)
    await refreshEmployee()
    await employeePage.locator('[data-attendance-hero-timezone]').filter({ hasText: 'Asia/Tokyo' }).waitFor({ timeout: 60_000 })
    await employeePage.setViewportSize({ width: 390, height: 844 })
    try {
      const mobileSource = employeePage.locator('[data-attendance-hero-timezone]')
      await mobileSource.scrollIntoViewIfNeeded()
      expect(await mobileSource.isVisible()).toBe(true)
      expect(await mobileSource.textContent()).toContain('Asia/Tokyo')
      expect(await mobileSource.textContent()).toMatch(/Employee configuration|员工配置/)
      await employeePage.screenshot({ path: path.join(output, 'mobile-employee-timezone-source.png'), fullPage: true })
    } finally {
      await employeePage.setViewportSize({ width: 1280, height: 900 })
    }
    const submitted = employeePage.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/punch'
      && response.request().method() === 'POST')
    await employeePage.locator('[data-attendance-hero-cta="check_in"]').click()
    const response = await submitted
    const reply = await response.json()
    const payload = response.request().postDataJSON()
    await writeFile(path.join(output, 'punch-in-diagnostic.json'), JSON.stringify({
      status: response.status(), errorCode: reply.error?.code ?? null,
      payloadKeys: Object.keys(payload).sort(),
      zoneMatchesExpected: payload.timezone === 'Asia/Tokyo',
      source: payload.source ?? null,
    }, null, 2))
    expect(response.status(), reply.error?.code).toBe(200)
    expect(payload).not.toHaveProperty('occurredAt')
    expect(payload).not.toHaveProperty('occurred_at')
    const rows = await fixture.pool.query('SELECT timezone,work_date::text,occurred_at,event_type FROM attendance_events WHERE org_id=$1 AND user_id=$2 ORDER BY occurred_at', [fixture.orgId, employee.userId])
    expect(rows.rows.map(row => ({ ...row, occurred_at: row.occurred_at.toISOString() }))).toEqual([{
      timezone: 'Asia/Tokyo', work_date: targetWorkDate, occurred_at: punchServerInstant, event_type: 'check_in',
    }])
    await employeePage.screenshot({ path: path.join(output, 'employee-tokyo-server-punch.png'), fullPage: true })
    expect(pageErrors).toEqual([])
  }, 240_000)
  it('shows a real started-shift conflict and prevents saving a conflicting policy preview', async () => {
    const policyBefore = await fixture.pool.query('SELECT enabled,version FROM attendance_timezone_policies WHERE org_id=$1', [fixture.orgId])
    const contextBefore = await fixture.pool.query('SELECT context_fingerprint FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2 AND work_date=$3::date', [fixture.orgId, employee.userId, targetWorkDate])
    expect(contextBefore.rows).toHaveLength(1)
    await adminPage.bringToFront()
    await adminPage.locator('[data-timezone-proposed]').uncheck()
    const preview = adminPage.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/timezone-policy/preview')
    await adminPage.locator('[data-timezone-preview]').click()
    const response = await preview
    expect(response.status()).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.data.proposedEnabled).toBe(false)
    expect(body.data.conflictingUsers).toBe(1)
    expect(body.data.conflictCounts).toEqual({ startedContext: 1, tripContext: 0, invalidTargetContext: 0 })
    await adminPage.locator('[data-timezone-conflicting]').filter({ hasText: '1' }).waitFor()
    expect(await adminPage.locator('[data-timezone-save]').isDisabled()).toBe(true)
    const panel = adminPage.locator('[data-attendance-timezone-policy]')
    expect(await panel.textContent()).toMatch(/Resolve conflicts|请处理冲突/)
    await panel.scrollIntoViewIfNeeded()
    await panel.screenshot({ path: path.join(output, 'admin-started-shift-conflict.png') })
    await adminPage.setViewportSize({ width: 390, height: 844 })
    try {
      await panel.locator('[data-timezone-conflicting]').scrollIntoViewIfNeeded()
      expect(await panel.locator('[data-timezone-conflicting]').isVisible()).toBe(true)
      expect(await panel.locator('[data-timezone-conflicting]').textContent()).toBe('1')
      expect(await panel.textContent()).toMatch(/Resolve conflicts|请处理冲突/)
      expect(await panel.locator('[data-timezone-save]').isVisible()).toBe(true)
      expect(await panel.locator('[data-timezone-save]').isDisabled()).toBe(true)
      await adminPage.screenshot({ path: path.join(output, 'mobile-admin-started-shift-conflict.png'), fullPage: true })
    } finally {
      await adminPage.setViewportSize({ width: 1280, height: 900 })
    }
    expect((await fixture.pool.query('SELECT enabled,version FROM attendance_timezone_policies WHERE org_id=$1', [fixture.orgId])).rows).toEqual(policyBefore.rows)
    expect((await fixture.pool.query('SELECT context_fingerprint FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2 AND work_date=$3::date', [fixture.orgId, employee.userId, targetWorkDate])).rows).toEqual(contextBefore.rows)
    await writeFile(path.join(output, 'policy-conflict-preview.json'), JSON.stringify({
      status: response.status(), conflictCounts: body.data.conflictCounts,
      conflictingUsers: body.data.conflictingUsers, saveDisabled: true,
      policyUnchanged: true, contextUnchanged: true,
    }, null, 2))
    await adminPage.locator('[data-timezone-proposed]').check()
    expect(pageErrors).toEqual([])
  }, 240_000)

  it('checks out the original employee shift using its original stored timezone', async () => {
    const before = await fixture.pool.query('SELECT context_fingerprint FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2 AND work_date=$3::date', [fixture.orgId, employee.userId, targetWorkDate])
    expect(before.rows).toHaveLength(1)
    const outInstant = new Date(targetDay.getTime() + 9 * 3_600_000).toISOString()
    setScenarioInstant(outInstant)
    await refreshEmployee()
    const reply = employeePage.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/punch' && response.request().method() === 'POST')
    await employeePage.locator('[data-attendance-hero-cta="check_out"]').click()
    expect((await reply).status()).toBe(200)
    const events = await fixture.pool.query('SELECT timezone,event_type,occurred_at FROM attendance_events WHERE org_id=$1 AND user_id=$2 AND work_date=$3::date ORDER BY occurred_at', [fixture.orgId, employee.userId, targetWorkDate])
    expect(events.rows.map(row => ({ ...row, occurred_at: row.occurred_at.toISOString() }))).toEqual([
      { timezone: 'Asia/Tokyo', event_type: 'check_in', occurred_at: punchServerInstant },
      { timezone: 'Asia/Tokyo', event_type: 'check_out', occurred_at: outInstant },
    ])
    expect((await fixture.pool.query('SELECT context_fingerprint FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2 AND work_date=$3::date', [fixture.orgId, employee.userId, targetWorkDate])).rows).toEqual(before.rows)
  }, 240_000)

  it('submits a real destination-time trip form and publishes only after browser approval', async () => {
    await employeePage.bringToFront()
    await employeePage.locator('[data-attendance-request-tools] > summary').click()
    const card = employeePage.locator('[data-attendance-business-trip-card]')
    await card.locator('[data-trip-open]').click()
    await card.locator('[data-trip-zone]').selectOption('Asia/Singapore')
    await card.locator('[data-trip-local="startAt"]').fill(tripWorkDate + 'T08:00')
    await card.locator('[data-trip-local="endAt"]').fill(tripEnd.toISOString().slice(0, 10) + 'T08:00')
    expect(await card.locator('[data-trip-offset="startAt"]').textContent()).toContain('UTC+08:00')
    expect(await card.locator('[data-trip-offset="endAt"]').textContent()).toContain('UTC+08:00')
    expect(await card.locator('[data-trip-submit]').isVisible()).toBe(true)
    await employeePage.screenshot({ path: path.join(output, 'desktop-real-trip-input.png'), fullPage: true })
    await employeePage.setViewportSize({ width: 390, height: 844 })
    await card.scrollIntoViewIfNeeded()
    expect(await card.locator('[data-trip-zone]').isVisible()).toBe(true)
    expect(await card.locator('[data-trip-submit]').isVisible()).toBe(true)
    await employeePage.screenshot({ path: path.join(output, 'mobile-real-trip-input.png'), fullPage: true })
    const submitted = employeePage.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/business-trip-requests' && response.request().method() === 'POST')
    await card.locator('[data-trip-submit]').click()
    const created = await submitted
    expect(created.status()).toBe(201)
    const payload = await created.json()
    approvedTripId = payload.data.request.id
    expect(payload.data.request.status).toBe('pending')
    expect(created.request().postDataJSON()).toMatchObject({
      destinationTimezone: 'Asia/Singapore', startAt: tripDay.toISOString(), endAt: tripEnd.toISOString(),
    })
    expect((await fixture.pool.query('SELECT request_id FROM attendance_business_trip_arrangements WHERE request_id=$1', [approvedTripId])).rows).toEqual([])
    await employeePage.setViewportSize({ width: 1280, height: 900 })
    await openAdminRequest(approvedTripId)
    const row = adminPage.locator('[data-attendance-request-id="' + approvedTripId + '"]')
    await row.waitFor()
    await adminPage.setViewportSize({ width: 390, height: 844 })
    try {
      const mobileApprove = row.getByRole('button', { name: /^(Approve|批准)$/ })
      await mobileApprove.scrollIntoViewIfNeeded()
      expect(await mobileApprove.isVisible()).toBe(true)
      expect(await mobileApprove.isEnabled()).toBe(true)
      expect(await row.textContent()).toMatch(/Business trip|出差/)
      await adminPage.screenshot({ path: path.join(output, 'mobile-real-trip-approval.png'), fullPage: true })
    } finally {
      await adminPage.setViewportSize({ width: 1280, height: 900 })
    }
    const approved = adminPage.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/requests/' + approvedTripId + '/approve')
    await row.getByRole('button', { name: /^(Approve|批准)$/ }).click()
    const decision = await approved
    expect(decision.status()).toBe(200)
    expect((await decision.json()).data.status).toBe('approved')
    expect((await fixture.pool.query('SELECT destination_timezone,version FROM attendance_business_trip_arrangements WHERE request_id=$1', [approvedTripId])).rows).toEqual([{ destination_timezone: 'Asia/Singapore', version: 1 }])
    await row.scrollIntoViewIfNeeded()
    await adminPage.screenshot({ path: path.join(output, 'desktop-real-trip-approved.png'), fullPage: true })
  }, 240_000)

  it('uses the approved trip for browser punch, related correction and original checkout', async () => {
    const tripIn = new Date(tripDay.getTime() + 3_600_000).toISOString()
    setScenarioInstant(tripIn)
    await refreshEmployee()
    await employeePage.locator('[data-attendance-hero-timezone]').filter({ hasText: 'Approved business trip' }).waitFor({ timeout: 60_000 })
    const incoming = employeePage.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/punch' && response.request().method() === 'POST')
    await employeePage.locator('[data-attendance-hero-cta="check_in"]').click()
    expect((await incoming).status()).toBe(200)
    const frozen = await fixture.pool.query('SELECT context_fingerprint FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2 AND work_date=$3::date', [fixture.orgId, employee.userId, tripWorkDate])
    expect(frozen.rows).toHaveLength(1)
    await employeePage.locator('[data-attendance-request-tools] > summary').click()
    await employeePage.locator('#attendance-request-work-date').fill(tripWorkDate)
    await employeePage.locator('#attendance-request-type').selectOption('time_correction')
    await employeePage.locator('[data-request-timezone]').filter({ hasText: 'Asia/Singapore' }).waitFor()
    await employeePage.locator('#attendance-request-in').fill(tripWorkDate + 'T09:00')
    await employeePage.locator('#attendance-request-out').fill(tripWorkDate + 'T18:00')
    const requested = employeePage.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/requests' && response.request().method() === 'POST')
    await employeePage.locator('.attendance__request-form').getByRole('button', { name: /^(Submit request|提交申请)$/ }).click()
    const correction = await requested
    expect(correction.status()).toBe(201)
    expect(correction.request().postDataJSON()).toMatchObject({
      workDate: tripWorkDate, requestType: 'time_correction',
      requestedInAt: tripIn, requestedOutAt: new Date(tripDay.getTime() + 10 * 3_600_000).toISOString(),
      expectedTimezoneContextFingerprint: frozen.rows[0].context_fingerprint,
    })
    const requestId = (await correction.json()).data.request.id
    await openAdminRequest(requestId)
    const row = adminPage.locator('[data-attendance-request-id="' + requestId + '"]')
    await row.waitFor()
    const approved = adminPage.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/requests/' + requestId + '/approve')
    await row.getByRole('button', { name: /^(Approve|批准)$/ }).click()
    expect((await approved).status()).toBe(200)
    const tripOut = new Date(tripDay.getTime() + 10 * 3_600_000).toISOString()
    setScenarioInstant(tripOut)
    await refreshEmployee()
    const outgoing = employeePage.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/punch' && response.request().method() === 'POST')
    await employeePage.locator('[data-attendance-hero-cta="check_out"]').click()
    expect((await outgoing).status()).toBe(200)
    const events = await fixture.pool.query('SELECT timezone,event_type,occurred_at FROM attendance_events WHERE org_id=$1 AND user_id=$2 AND work_date=$3::date AND source=$4 ORDER BY occurred_at', [fixture.orgId, employee.userId, tripWorkDate, 'manual'])
    expect(events.rows.map(row => ({ ...row, occurred_at: row.occurred_at.toISOString() }))).toEqual([
      { timezone: 'Asia/Singapore', event_type: 'check_in', occurred_at: tripIn },
      { timezone: 'Asia/Singapore', event_type: 'check_out', occurred_at: tripOut },
    ])
    expect((await fixture.pool.query('SELECT context_fingerprint FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2 AND work_date=$3::date', [fixture.orgId, employee.userId, tripWorkDate])).rows).toEqual(frozen.rows)
    await employeePage.waitForFunction(() => {
      const hero = document.querySelector('[data-testid="attendance-hero-punch"]')
      const timezone = hero?.querySelector('[data-attendance-hero-timezone]')?.textContent ?? ''
      const clock = hero?.querySelector('[data-testid="attendance-hero-time"]')?.textContent?.trim() ?? ''
      const status = document.querySelector('[data-attendance-overview-primary] .attendance__status')
      return /^\d{2}:\d{2}:\d{2}$/.test(clock)
        && timezone.includes('Approved business trip') && timezone.includes('Asia/Singapore')
        && Boolean(hero?.querySelector('[data-attendance-clock-state="complete"]'))
        && !hero?.querySelector('[data-testid="attendance-refreshing-indicator"]')
        && Boolean(status?.textContent?.includes('Check out recorded'))
        && !status?.classList.contains('attendance__status--error')
    })
    await employeePage.screenshot({ path: path.join(output, 'employee-real-trip-correction-checkout.png'), fullPage: true })
    expect(pageErrors).toEqual([])
  }, 240_000)

  it('launches and approves trip cancellation in the browser without rewriting past contexts', async () => {
    const stored = await fixture.pool.query('SELECT context_fingerprint FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2 ORDER BY work_date', [fixture.orgId, employee.userId])
    expect(stored.rows).toHaveLength(2)
    const cancelledAt = new Date(tripDay.getTime() + 86_400_000).toISOString()
    setScenarioInstant(cancelledAt)
    await employeePage.bringToFront()
    const summary = employeePage.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/requests/' + approvedTripId + '/cancel-round')
    await employeePage.goto(webBase + '/attendance?requestId=' + encodeURIComponent(approvedTripId), { waitUntil: 'domcontentloaded' })
    expect((await summary).status()).toBe(200)
    const panel = employeePage.locator('[data-attendance-cancel-round="' + approvedTripId + '"]')
    await panel.locator('[data-cancel-round-launch]').click()
    const launched = employeePage.waitForResponse(response => new URL(response.url()).pathname === '/api/attendance/requests/' + approvedTripId + '/cancel-round' && response.request().method() === 'POST')
    await panel.locator('[data-cancel-round-confirm]').click()
    const response = await launched
    expect(response.status()).toBe(201)
    expect((await fixture.pool.query('SELECT cancelled_at FROM attendance_business_trip_arrangements WHERE request_id=$1', [approvedTripId])).rows).toEqual([{ cancelled_at: null }])
    await adminPage.bringToFront()
    const pending = adminPage.waitForResponse(value => new URL(value.url()).pathname === '/api/attendance/cancel-rounds/pending')
    await adminPage.goto(webBase + '/attendance?requestId=' + encodeURIComponent(approvedTripId), { waitUntil: 'domcontentloaded' })
    const pendingResponse = await pending
    const pendingBody = await pendingResponse.json()
    const entries = pendingBody.data?.items
    await writeFile(path.join(output, 'trip-cancel-pending-diagnostic.json'), JSON.stringify({
      status: pendingResponse.status(), errorCode: pendingBody.error?.code ?? null,
      sameOrgSelector: new URL(pendingResponse.url()).searchParams.get('orgId') === fixture.orgId,
      itemCount: Array.isArray(entries) ? entries.length : null,
      includesTarget: Array.isArray(entries) && entries.some((entry: { requestId?: string }) => entry.requestId === approvedTripId),
    }, null, 2))
    expect(pendingResponse.status()).toBe(200)
    expect(Array.isArray(entries)).toBe(true)
    expect(entries.some((entry: { requestId?: string }) => entry.requestId === approvedTripId)).toBe(true)
    const item = adminPage.locator('[data-cancel-round-pending-item="' + approvedTripId + '"]')
    await item.locator('[data-cancel-round-pending-approve]').click()
    const decision = adminPage.waitForResponse(value => new URL(value.url()).pathname === '/api/attendance/requests/' + approvedTripId + '/cancel-round/actions')
    await item.locator('[data-cancel-round-pending-confirm-submit]').click()
    expect((await decision).status()).toBe(200)
    const arrangement = await fixture.pool.query('SELECT effective_end_at,version,cancelled_at IS NOT NULL AS cancelled FROM attendance_business_trip_arrangements WHERE request_id=$1', [approvedTripId])
    // Tokyo's base shift has already started at 00:00 UTC, even though the
    // Singapore trip shift starts an hour later. Preserve this entire work date.
    const cancellationBoundary = new Date(tripDay.getTime() + 86_400_000 + 10 * 3_600_000).toISOString()
    expect(arrangement.rows.map(row => ({ ...row, effective_end_at: row.effective_end_at.toISOString() }))).toEqual([{ effective_end_at: cancellationBoundary, version: 2, cancelled: true }])
    expect((await fixture.pool.query('SELECT context_fingerprint FROM attendance_timezone_context_companions WHERE org_id=$1 AND user_id=$2 ORDER BY work_date', [fixture.orgId, employee.userId])).rows).toEqual(stored.rows)
    await refreshEmployee()
    await employeePage.locator('[data-attendance-hero-timezone]').filter({ hasText: 'Approved business trip' }).waitFor()
    setScenarioInstant(cancellationBoundary)
    await refreshEmployee()
    await employeePage.locator('[data-attendance-hero-timezone]').filter({ hasText: 'Asia/Tokyo' }).waitFor()
    await employeePage.screenshot({ path: path.join(output, 'employee-real-trip-cancelled-original-history.png'), fullPage: true })
    expect(pageErrors).toEqual([])
  }, 240_000)

})
