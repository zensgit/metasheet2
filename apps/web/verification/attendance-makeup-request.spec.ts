import { expect, test, type Page } from '@playwright/test'

const cardSelector = '[data-attendance-makeup-request-card]'
const proof = 'https://example.com/synthetic-proof.png'

async function mockAttendance(page: Page) {
  const posts: Record<string, unknown>[] = []
  const unexpected: string[] = []
  await page.clock.setFixedTime(new Date('2026-04-15T10:00:00+08:00'))
  await page.addInitScript(() => {
    localStorage.setItem('auth_token', 'synthetic-browser-test-token')
    localStorage.setItem('tenantId', 'synthetic-org')
    localStorage.setItem('metasheet_locale', 'zh-CN')
  })
  const emptyLists = new Set([
    '/api/attendance/records', '/api/attendance/requests',
    '/api/attendance/reports/requests', '/api/attendance/holidays',
    '/api/attendance/leave-types', '/api/attendance/overtime-rules',
    '/api/attendance/shift-swap-requests',
  ])
  await page.route('**/api/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const reply = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    if (path === '/api/attendance/requests' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>
      posts.push(body)
      if (!body.attachmentUrl) {
        return reply({ ok: false, error: { code: 'MAKEUP_PUNCH_ATTACHMENT_REQUIRED', message: 'Attachment required' } }, 422)
      }
      return reply({ ok: true, data: { id: 'synthetic-request', status: 'pending' } })
    }
    if (request.method() !== 'GET') {
      unexpected.push(`${request.method()} ${path}`)
      return route.abort()
    }
    if (path === '/api/auth/me') {
      return reply({ ok: true, data: { user: { id: 'synthetic-employee', tenantId: 'synthetic-org', roles: ['user'], permissions: ['attendance:read', 'attendance:write'] } } })
    }
    if (path === '/api/plugins') return reply([{ name: 'plugin-attendance', status: 'active' }])
    if (path === '/api/auth/session-orgs') {
      return reply({ success: true, data: { orgs: ['synthetic-org'], currentOrgId: 'synthetic-org' } })
    }
    if (path === '/api/attendance/anomalies') {
      return reply({ ok: true, data: { items: [
        { recordId: 'today-in', workDate: '2026-04-15', state: 'open', status: 'partial', suggestedRequestType: 'missed_check_in', request: null },
        { recordId: 'yesterday-in', workDate: '2026-04-14', state: 'open', status: 'partial', suggestedRequestType: 'missed_check_in', request: null },
        { recordId: 'yesterday-out', workDate: '2026-04-14', state: 'open', status: 'partial', suggestedRequestType: 'missed_check_out', request: null },
      ] } })
    }
    if (emptyLists.has(path)) return reply({ ok: true, data: { items: [], total: 0 } })
    if (path === '/api/attendance/summary') {
      return reply({ ok: true, data: { total_days: 0, total_minutes: 0 } })
    }
    if (path === '/api/attendance/employee-quick-action-icons') {
      return reply({ ok: true, data: { makeup: 'clock-plus', leave: 'calendar', overtime: 'moon', swap: 'swap' } })
    }
    if (path === '/api/attendance/rules/me') {
      return reply({ ok: true, data: {
        userId: 'synthetic-employee', orgId: 'synthetic-org', resolvedForDate: '2026-04-15',
        assignment: { attendanceGroups: [], scheduleGroups: [] },
        runtimeRule: { timezone: 'Asia/Shanghai' }, punchPolicy: { merge: {} }, warnings: [],
      } })
    }
    if (path === '/api/attendance/effective-calendar') {
      return reply({ ok: true, data: { mode: 'userId', from: '2026-04-01', to: '2026-04-30', timezone: 'Asia/Shanghai', items: [] } })
    }
    if (path === '/api/attendance/leave-balances/me') {
      return reply({ ok: true, data: { summary: { grantedMinutes: 0, usedMinutes: 0, remainingMinutes: 0 }, ledger: [] } })
    }
    unexpected.push(`${request.method()} ${path}`)
    return route.abort()
  })
  return { posts, unexpected }
}

async function assertFits(page: Page) {
  const card = page.locator(cardSelector)
  const outer = await card.boundingBox()
  expect(outer).not.toBeNull()
  for (const control of await card.locator('input, select, button').all()) {
    await expect(control).toBeVisible()
    const box = await control.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(outer!.x - 1)
    expect(box!.x + box!.width).toBeLessThanOrEqual(outer!.x + outer!.width + 1)
  }
  const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }))
  expect(size.scroll).toBeLessThanOrEqual(size.client)
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`${viewport.width}x${viewport.height}: reopening clears a different-date draft before submitting`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    const { posts, unexpected } = await mockAttendance(page)
    await page.goto('/verification/attendance-makeup-request-harness.html')
    const open = page.locator('[data-selfservice-action="missing-punch"]')
    const card = page.locator(cardSelector)
    await open.click()
    await card.locator('[data-makeup-card-anomaly]').selectOption('yesterday-in::2026-04-14')
    await card.locator('[data-makeup-card-time]').fill('2026-04-14T09:00')
    await card.locator('[data-makeup-card-attachment]').fill(proof)
    await card.locator('[data-makeup-card-cancel="footer"]').click()
    await open.click()
    await expect(card.locator('[data-makeup-card-anomaly]')).toHaveValue('today-in::2026-04-15')
    await expect(card.locator('[data-makeup-card-time]')).toHaveValue('')
    await card.locator('[data-makeup-card-submit]').click()
    await expect(page.locator('body')).toContainText('补签上班时间为必填项')
    expect(posts).toEqual([])
    await card.locator('[data-makeup-card-time]').fill('2026-04-15T09:00')
    await assertFits(page)
    await card.screenshot({ path: testInfo.outputPath(`reopen-${viewport.width}.png`) })
    await card.locator('[data-makeup-card-submit]').click()
    await expect(card).toHaveCount(0)
    expect(posts).toEqual([
      { workDate: '2026-04-15', requestType: 'missed_check_in', requestedInAt: '2026-04-15T09:00', attachmentUrl: proof, orgId: 'synthetic-org' },
    ])
    expect(unexpected).toEqual([])
  })

  test(`${viewport.width}x${viewport.height}: real parent attachment retry and anomaly date reset`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    const { posts, unexpected } = await mockAttendance(page)
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('/verification/attendance-makeup-request-harness.html')
    const card = page.locator(cardSelector)
    const tools = page.locator('[data-attendance-request-tools]')
    await expect(page.locator('[data-selfservice-action="missing-punch"]')).toBeVisible()
    await expect(card).toHaveCount(0)
    await page.locator('[data-selfservice-action="missing-punch"]').click()
    await expect(card).toBeVisible()
    await expect(tools).toHaveJSProperty('open', false)
    const time = card.locator('[data-makeup-card-time]')
    const anomaly = card.locator('[data-makeup-card-anomaly]')
    await anomaly.selectOption('today-in::2026-04-15')
    await time.fill('2026-04-15T09:00')
    await anomaly.selectOption('yesterday-in::2026-04-14')
    await expect(time).toHaveValue('')
    await card.locator('[data-makeup-card-submit]').click()
    await expect(card).toBeVisible()
    expect(posts).toEqual([])
    await time.fill('2026-04-14T09:00')
    // Same-date type change retains the entered time in the correct field.
    await anomaly.selectOption('yesterday-out::2026-04-14')
    await expect(time).toHaveValue('2026-04-14T09:00')
    await anomaly.selectOption('today-in::2026-04-15')
    await expect(time).toHaveValue('')
    await time.fill('2026-04-15T09:00')
    await card.locator('[data-makeup-card-reason]').fill('Synthetic proof')
    await card.locator('[data-makeup-card-submit]').click()
    await expect.poll(() => posts.length).toBe(1)
    await expect(page.getByText('MAKEUP_PUNCH_ATTACHMENT_REQUIRED', { exact: false })).toBeVisible()
    await expect(tools).toHaveJSProperty('open', false)
    const attachment = card.locator('[data-makeup-card-attachment]')
    await expect(attachment).toBeVisible()
    await attachment.fill(proof)
    await assertFits(page)
    await card.screenshot({ path: testInfo.outputPath(`card-${viewport.width}.png`) })
    await page.screenshot({ path: testInfo.outputPath(`retry-${viewport.width}.png`), fullPage: true })
    await card.locator('[data-makeup-card-submit]').click()
    await expect(card).toHaveCount(0)
    await expect(page.locator('body')).toContainText('申请已提交。')
    expect(posts).toEqual([
      { workDate: '2026-04-15', requestType: 'missed_check_in', requestedInAt: '2026-04-15T09:00', reason: 'Synthetic proof', orgId: 'synthetic-org' },
      { workDate: '2026-04-15', requestType: 'missed_check_in', requestedInAt: '2026-04-15T09:00', reason: 'Synthetic proof', orgId: 'synthetic-org', attachmentUrl: proof },
    ])
    await expect(tools).toHaveJSProperty('open', false)
    await page.locator('[data-selfservice-action="missing-punch"]').click()
    await card.locator('[data-makeup-card-cancel="footer"]').click()
    await expect(card).toHaveCount(0)
    expect(posts).toHaveLength(2)
    expect(unexpected).toEqual([])
    expect(errors).toEqual([])
  })
}
