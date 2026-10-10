// Chromium DOM -> actual Vue owner panel/production SDK -> same-origin Vite
// proxy -> actual JWT/AuthService/core/plugin binding -> real PostgreSQL.
// Synthetic JWT injection is authentication setup, not a full login assertion.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createYidaOwnerBrowserFixture, realBrowserData, realBrowserJson, type YidaOwnerBrowserFixture } from '../utils/stock-preparation-yida-owner-browser-fixture'
import { createYidaOwnerHttpRealdbFixture, draftInput, type Data, type Draft,
  type YidaOwnerHttpRealdbFixture } from '../utils/stock-preparation-yida-owner-http-fixture'

const prefix = '/api/integration/yida-owner-send'
it('sentinel: actual Chromium owner proof requires EXPECT_DB=1 and dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip
databaseSuite('SA05 owner browser — isolated real panel and actual HTTP/PG authority', () => {
  let host: YidaOwnerHttpRealdbFixture, ui: YidaOwnerBrowserFixture | undefined
  const input = () => draftInput('equal_integer', 6)
  beforeAll(async () => { host = await createYidaOwnerHttpRealdbFixture() }, 30000)
  beforeEach(async () => {
    await host.reset()
    ui = await createYidaOwnerBrowserFixture({ apiOrigin: host.origin, ownerToken: host.tokens.owner,
      otherToken: host.tokens.otherOwner, draftInput: input() })
  }, 60000)
  afterEach(async context => {
    try {
      if (ui) {
        const diagnostics = ui.responseDiagnostics(), testFailed = context.task.result?.state === 'fail'
        if (testFailed || diagnostics.some(row => row.settlement === 'failed' || row.browserFailure !== 'none')) {
          // Diagnostics are counts/closed enums only; failures never print
          // request URLs, headers, body bytes, grants, sessions or raw errors.
          const immediate = { requests: ui.responseDiagnostics(), page: await ui.pageDiagnostic() }
          try { await ui.settled() } catch { /* Keep the original test failure. */ }
          const settled = { requests: ui.responseDiagnostics(), page: await ui.pageDiagnostic() }
          let counts: number[] | null = null
          try {
            const proof = await host.proof()
            if (proof.counts.length === 6 && proof.counts.every(count => Number.isSafeInteger(count) && count >= 0)) counts = proof.counts
          } catch { /* Unavailable diagnostics cannot mask the original failure. */ }
          console.log('YIDA_OWNER_BROWSER_CAPTURE_DIAGNOSTIC ' + JSON.stringify({ testFailed, immediate, settled, databaseCounts: counts }))
        }
        expect(ui.violations).toEqual([])
        expect(ui.pageErrors).toBe(0)
        expect(ui.requests.every(request => request.correctSession && !request.scopeHeaders)).toBe(true)
      }
    } finally { await ui?.cleanup(); ui = undefined }
  }, 30000)
  afterAll(async () => { await host?.cleanup() }, 30000)

  async function saveAndSelect() {
    const page = ui!.page
    const initial = await host.proof()
    await ui!.settled()
    expect(ui!.requests).toEqual([])
    expect([host.tokenPayloads.length, host.formPayloads.length]).toEqual([0, 0])
    const response = ui!.waitApi('POST', '/drafts')
    await page.getByTestId('sp-yida-owner-save').click()
    const draft = await realBrowserData(await response, 201) as unknown as Draft
    await page.getByTestId('sp-yida-owner-draft').waitFor()
    const values = await page.getByTestId('sp-yida-owner-row').locator('option').evaluateAll(options =>
      options.map(option => (option as HTMLOptionElement).value).filter(Boolean))
    expect(values).toEqual(draft.rows.map(row => row.rowKey))
    expect(draft.rows).toHaveLength(3)
    await page.getByTestId('sp-yida-owner-row').selectOption(draft.rows[2].rowKey)
    await ui!.settled()
    expect(ui!.requests).toHaveLength(1)
    expect(await page.getByTestId('sp-yida-owner-confirmation').count()).toBe(0)
    expect(await host.proof()).toEqual(initial)
    return draft
  }
  async function readPreview(draft: Draft) {
    const page = ui!.page, response = ui!.waitApi('POST', '/preview')
    await page.getByTestId('sp-yida-owner-preview').click()
    const preview = await realBrowserData(await response, 200)
    await page.getByTestId('sp-yida-owner-payload').waitFor()
    expect(JSON.parse(await page.getByTestId('sp-yida-owner-payload').innerText())).toEqual(preview.payload)
    expect(preview).toMatchObject({ operationId: draft.operationId, rowKey: draft.rows[2].rowKey, canSend: false,
      externalWriteAttempted: false, policy: { maxAttempts: 1, requiresExplicitConfirmation: true, unknownMustNotRetry: true } })
    expect(preview.payload).toEqual(host.compiledPayload(input(), 2))
    expect((preview.payload as Data).qty).toBe(2)
    expect((JSON.parse(input().rowsText) as Data[])[2]).toBeUndefined()
    expect(await page.getByTestId('sp-yida-owner-approve').isDisabled()).toBe(true)
    expect((await host.proof()).counts).toEqual([0, 0, 0, 0, 0, 0])
    return preview
  }
  async function approve() {
    const page = ui!.page, count = ui!.requests.length
    await page.getByTestId('sp-yida-owner-ack').check()
    await ui!.settled()
    expect(ui!.requests).toHaveLength(count)
    const response = ui!.waitApi('POST', '/approvals')
    await page.getByTestId('sp-yida-owner-approve').click()
    const grant = await realBrowserData(await response, 201)
    await page.getByTestId('sp-yida-owner-grant').waitFor()
    expect(await page.getByTestId('sp-yida-owner-submit').isEnabled()).toBe(true)
    expect((await host.proof()).counts).toEqual([1, 0, 0, 1, 0, 0])
    expect([host.tokenPayloads.length, host.formPayloads.length]).toEqual([0, 0])
    const request = ui!.requests.find(request => request.path === prefix + '/approvals')!
    expect(request.body).toMatchObject({ acknowledgeOnce: true, ttlMs: 900000 })
    expect(typeof (request.body as Data).confirmationId).toBe('string')
    return grant
  }
  async function refreshConsumed() {
    await ui!.page.getByTestId('sp-yida-owner-refresh').waitFor({ state: 'visible' })
    await ui!.page.waitForFunction(() => {
      const refresh = document.querySelector<HTMLButtonElement>('[data-testid="sp-yida-owner-refresh"]')
      return refresh && !refresh.disabled
    })
    expect(await ui!.page.getByTestId('sp-yida-owner-error').count()).toBe(0)
  }

  it('DOM actions send the selected returned member once and manual refresh only reads durable ACK', async () => {
    host.setEnablement('true')
    const draft = await saveAndSelect(), preview = await readPreview(draft), grant = await approve()
    expect(ui!.requests.map(request => [request.method, request.path])).toEqual([
      ['POST', prefix + '/drafts'], ['POST', prefix + '/preview'], ['POST', prefix + '/approvals'],
    ])
    const sentResponse = ui!.waitApi('POST', '/submissions')
    await ui!.page.getByTestId('sp-yida-owner-submit').click()
    const sent = await realBrowserData(await sentResponse, 200)
    await ui!.page.getByTestId('sp-yida-owner-acknowledged').waitFor()
    expect(sent).toMatchObject({ status: 'acknowledged', reused: false, externalWriteAttempted: true,
      businessVerified: false, durable: true, approval: { remainingAttempts: 0 } })
    expect([host.tokenPayloads.length, host.formPayloads.length, host.tokenCommitted, host.validRequests]).toEqual([1, 1, true, true])
    expect(host.formPayloads[0]).toEqual(preview.payload)
    expect((await host.proof()).counts).toEqual([1, 0, 1, 2, 1, 3])
    expect((await host.rows('integration_yida_send_admissions'))[0]).toMatchObject({ grant_id: grant.grantId,
      ledger_id: (sent.delivery as Data).id })
    expect((await host.rows('integration_yida_delivery_ledger'))[0]).toMatchObject({ status: 'acknowledged', ack_status_code: 201 })
    expect(await ui!.page.getByTestId('sp-yida-owner-submit').isDisabled()).toBe(true)
    expect(await ui!.page.getByTestId('sp-yida-owner-row').isDisabled()).toBe(true)
    const before = await host.proof(), postCount = ui!.requests.filter(request => request.method === 'POST').length
    const refresh = ui!.waitApi('GET', '/approvals/' + grant.grantId)
    await ui!.page.getByTestId('sp-yida-owner-refresh').click()
    expect(await realBrowserData(await refresh, 200)).toMatchObject({ delivery: sent.delivery })
    await refreshConsumed()
    await ui!.settled()
    expect(ui!.requests.filter(request => request.method === 'POST')).toHaveLength(postCount)
    expect([host.tokenPayloads.length, host.formPayloads.length]).toEqual([1, 1]); expect(await host.proof()).toEqual(before)
    expect(await ui!.page.getByTestId('sp-yida-owner-acknowledged').innerText()).toContain('尚未核验业务创建成功')
  }, 45000)

  it('same-path next observers bind distinct browser requests and a different method cannot consume them', async () => {
    host.setEnablement('true')
    const draft = await saveAndSelect(), before = await host.proof(), page = ui!.page
    const first = ui!.waitApi('POST', '/preview')
    await page.getByTestId('sp-yida-owner-preview').click()
    const firstResponse = await first, firstData = await realBrowserData(firstResponse, 200)
    await page.getByTestId('sp-yida-owner-payload').waitFor()
    expect(firstData.payload).toEqual(host.compiledPayload(input(), 2))
    expect(JSON.parse(await page.getByTestId('sp-yida-owner-payload').innerText())).toEqual(firstData.payload)
    await page.getByTestId('sp-yida-owner-row').selectOption(draft.rows[0].rowKey)
    const wrongMethod = ui!.waitApi('GET', '/preview'), second = ui!.waitApi('POST', '/preview')
    await page.getByTestId('sp-yida-owner-preview').click()
    const secondResponse = await second, secondData = await realBrowserData(secondResponse, 200)
    expect(secondResponse.request()).not.toBe(firstResponse.request())
    expect(secondData.rowKey).toBe(draft.rows[0].rowKey)
    expect(secondData.payload).toEqual(host.compiledPayload(input(), 0))
    expect(secondData.payload).not.toEqual(firstData.payload)
    expect(wrongMethod.bound).toBe(false)
    wrongMethod.cancel()
    await expect(wrongMethod).rejects.toThrow('YIDA_OWNER_BROWSER_OBSERVER_CANCELLED')
    await page.getByTestId('sp-yida-owner-payload').waitFor()
    expect(JSON.parse(await page.getByTestId('sp-yida-owner-payload').innerText())).toEqual(secondData.payload)
    expect(ui!.requests.map(request => [request.method, request.path])).toEqual([
      ['POST', prefix + '/drafts'], ['POST', prefix + '/preview'], ['POST', prefix + '/preview'],
    ])
    expect(await host.proof()).toEqual(before)
    expect([host.tokenPayloads.length, host.formPayloads.length]).toEqual([0, 0])
  }, 45000)

  it('real parent DOM captures local input, opens owner flow, and locks its editor after the one-row grant', async () => {
    // Keep the previous six owner-only cases unchanged. This case mounts the
    // actual parent with no props; only its public DOM config controls are used.
    await ui!.cleanup(); ui = undefined
    ui = await createYidaOwnerBrowserFixture({ apiOrigin: host.origin, ownerToken: host.tokens.owner,
      otherToken: host.tokens.otherOwner, draftInput: input(), mode: 'parent' })
    host.setEnablement('true')
    const page = ui.page, expected = input(), beforeLocal = await host.proof()
    await ui.settled()
    expect(ui.requests).toEqual([])
    expect(await page.getByTestId('stock-prep-yida-owner-send-panel').count()).toBe(0)
    expect(await page.getByTestId('sp-yida-owner-open').count()).toBe(0)
    await page.getByTestId('sp-yida-preview-mode').selectOption('protocol')
    await page.getByTestId('sp-yida-app-type').fill('synthetic_http_app')
    await page.getByTestId('sp-yida-form-uuid').fill('synthetic_http_form')
    await page.getByTestId('sp-yida-intent').selectOption('create')
    const mappings = expected.config.fieldMap as Array<{ source: string; target: string; type: string; required: boolean }>
    const catalog = expected.config.fieldCatalog as Array<{ id: string; control: string; required: boolean }>
    const businessKey = expected.config.businessKey as string[], emptyKey = expected.config.emptyKeyFields as string[]
    for (let index = 0; index < mappings.length; index++) {
      if (index > 0) await page.getByTestId('sp-yida-map-add').click()
      const mapping = mappings[index]
      await page.getByTestId(`sp-yida-map-source-${index}`).fill(mapping.source)
      await page.getByTestId(`sp-yida-map-target-${index}`).fill(mapping.target)
      await page.getByTestId(`sp-yida-map-type-${index}`).selectOption(mapping.type)
      await page.getByTestId(`sp-yida-map-required-${index}`).setChecked(mapping.required)
      await page.getByTestId(`sp-yida-map-key-${index}`).setChecked(businessKey.includes(mapping.source))
      await page.getByTestId(`sp-yida-map-empty-key-${index}`).setChecked(emptyKey.includes(mapping.source))
      await page.getByTestId('sp-yida-catalog-add').click()
      await page.getByTestId(`sp-yida-catalog-id-${index}`).fill(catalog[index].id)
      await page.getByTestId(`sp-yida-catalog-control-${index}`).selectOption(catalog[index].control)
      await page.getByTestId(`sp-yida-catalog-required-${index}`).setChecked(catalog[index].required)
    }
    await page.getByTestId('sp-yida-rows').fill(expected.rowsText)
    await page.getByTestId('sp-yida-allocation-mode').selectOption('equal_integer')
    await page.getByTestId('sp-yida-allocation-projects').fill('SYN-P1\nSYN-P2\nSYN-P3')
    await page.getByTestId('sp-yida-allocation-project-field').selectOption('projectNo')
    await page.getByTestId('sp-yida-allocation-quantity-field').selectOption('quantity')
    await page.getByTestId('sp-yida-run').click()
    await page.getByTestId('sp-yida-owner-open').waitFor()
    expect(await page.getByTestId('sp-yida-summary').innerText()).toBe('共 3 行；计划创建 3；计划更新 0；无效 0；本地重复键 0。')
    expect(JSON.parse(await page.getByTestId('sp-yida-payload-2').innerText())).toEqual(host.compiledPayload(expected, 2))
    await ui.settled()
    expect(ui.requests).toEqual([]); expect(await host.proof()).toEqual(beforeLocal)
    await page.getByTestId('sp-yida-owner-open').click()
    await page.getByTestId('stock-prep-yida-owner-send-panel').waitFor()
    await ui.settled(); expect(ui.requests).toEqual([])
    const draft = await saveAndSelect()
    expect(ui.requests[0].body).toEqual(expected)
    const preview = await readPreview(draft)
    expect(await page.getByTestId('sp-yida-app-type').isEnabled()).toBe(true)
    const grant = await approve()
    // The child's actual locked-change event must reach the actual parent.
    expect(await page.locator('fieldset.sp-yida-preview__editor').evaluate(element => (element as HTMLFieldSetElement).disabled)).toBe(true)
    for (const id of ['sp-yida-app-type', 'sp-yida-form-uuid', 'sp-yida-rows', 'sp-yida-run',
      'sp-yida-example-primary', 'sp-yida-allocation-mode']) expect(await page.getByTestId(id).isDisabled()).toBe(true)
    const sentResponse = ui.waitApi('POST', '/submissions')
    await page.getByTestId('sp-yida-owner-submit').click()
    const sent = await realBrowserData(await sentResponse, 200)
    await page.getByTestId('sp-yida-owner-acknowledged').waitFor()
    expect(sent).toMatchObject({ status: 'acknowledged', businessVerified: false, externalWriteAttempted: true,
      approval: { grantId: grant.grantId, remainingAttempts: 0 }, delivery: { status: 'acknowledged', durable: true } })
    expect([host.tokenPayloads.length, host.formPayloads.length, host.tokenCommitted]).toEqual([1, 1, true])
    expect(host.formPayloads[0]).toEqual(preview.payload)
    expect((await host.proof()).counts).toEqual([1, 0, 1, 2, 1, 3])
    expect(await page.getByTestId('sp-yida-owner-submit').isDisabled()).toBe(true)
    const beforeHistory = await host.proof(), history = ui.waitApi('GET', '/approvals/' + grant.grantId)
    await page.getByTestId('sp-yida-owner-refresh').click()
    expect(await realBrowserData(await history, 200)).toMatchObject({ delivery: sent.delivery })
    await refreshConsumed()
    await ui.settled()
    expect(ui.requests.map(request => [request.method, request.path])).toEqual([
      ['POST', prefix + '/drafts'], ['POST', prefix + '/preview'], ['POST', prefix + '/approvals'],
      ['POST', prefix + '/submissions'], ['GET', prefix + '/approvals/' + grant.grantId],
    ])
    expect([host.tokenPayloads.length, host.formPayloads.length]).toEqual([1, 1])
    expect(await host.proof()).toEqual(beforeHistory)
  }, 60000)

  it('default OFF is visible in DOM and a clicked draft gets the real denial with no owner SQL/fetch', async () => {
    await ui!.settled()
    expect(ui!.requests).toEqual([])
    expect(await ui!.page.getByTestId('sp-yida-owner-default-off').innerText()).toContain('发送默认关闭')
    const before = await host.proof(); host.sql.length = 0
    const denied = ui!.waitApi('POST', '/drafts')
    await ui!.page.getByTestId('sp-yida-owner-save').click()
    const response = await denied
    expect(response.status()).toBe(403)
    expect(await realBrowserJson(response, 403)).toEqual({ ok: false, error: { code: 'YIDA_OWNER_RUNTIME_DISABLED' } })
    await ui!.page.getByTestId('sp-yida-owner-disabled').waitFor()
    expect(await ui!.page.getByTestId('sp-yida-owner-error').innerText()).toBe('YIDA_OWNER_RUNTIME_DISABLED')
    expect(await ui!.page.getByTestId('sp-yida-owner-save').isDisabled()).toBe(true)
    expect(await ui!.page.getByTestId('sp-yida-owner-draft').count()).toBe(0)
    expect(host.sql).toEqual([]); expect([host.tokenPayloads.length, host.formPayloads.length]).toEqual([0, 0])
    expect(await host.proof()).toEqual(before)
    await ui!.settled(); expect(ui!.requests).toHaveLength(1)
  }, 45000)

  it('unknown protocol result freezes DOM submission and manual refresh cannot produce another form', async () => {
    host.setEnablement('true'); host.setFormOutcome('unknown')
    const draft = await saveAndSelect(); await readPreview(draft); const grant = await approve()
    const sentResponse = ui!.waitApi('POST', '/submissions')
    await ui!.page.getByTestId('sp-yida-owner-submit').click()
    const sent = await realBrowserData(await sentResponse, 200)
    expect(sent).toMatchObject({ status: 'outcome_unknown', reused: false, externalWriteAttempted: true,
      businessVerified: false, approval: { remainingAttempts: 0 } })
    await ui!.page.getByTestId('sp-yida-owner-frozen').waitFor()
    expect(await ui!.page.getByTestId('sp-yida-owner-delivery').innerText()).toContain('outcome_unknown')
    expect(await ui!.page.getByTestId('sp-yida-owner-submit').isDisabled()).toBe(true)
    expect(await ui!.page.getByTestId('sp-yida-owner-unverified').innerText()).toContain('不可重试创建')
    const before = await host.proof()
    for (let index = 0; index < 2; index++) {
      const refresh = ui!.waitApi('GET', '/approvals/' + grant.grantId)
      await ui!.page.getByTestId('sp-yida-owner-refresh').click()
      expect(await realBrowserData(await refresh, 200)).toMatchObject({ delivery: { status: 'outcome_unknown' } })
      await refreshConsumed()
    }
    await ui!.settled()
    expect(ui!.requests.filter(request => request.path === prefix + '/submissions')).toHaveLength(1)
    expect([host.tokenPayloads.length, host.formPayloads.length]).toEqual([1, 1]); expect(await host.proof()).toEqual(before)
    expect((await host.rows('integration_yida_delivery_ledger'))[0].status).toBe('outcome_unknown')
  }, 45000)

  it.each(['configuration', 'session'])('%s invalidation closes an already-computed real preview response', async change => {
    host.setEnablement('true')
    const draft = await saveAndSelect(), before = await host.proof(), held = ui!.delayNext('POST', '/preview')
    const invalidated = ui!.waitApi('POST', '/preview')
    await ui!.page.getByTestId('sp-yida-owner-preview').click()
    await ui!.reached(held)
    expect(host.sql.some(sql => sql.includes('integration_yida_credential_materials'))).toBe(true)
    if (change === 'configuration') await ui!.applyInput(draftInput('equal_integer', 9))
    else await ui!.switchSession()
    // Invalidation is synchronous while the real response is still held.
    // Removing the component watcher / SDK session subscriber must turn red.
    expect(await ui!.page.getByTestId('sp-yida-owner-draft').count()).toBe(0)
    if (change === 'session') expect(await ui!.page.getByTestId('sp-yida-owner-error').innerText()).toBe('YIDA_OWNER_SESSION_CHANGED')
    held.release()
    // The upstream already produced real bytes; the browser aborted instead
    // of consuming them. A body capture cannot turn this into UI success.
    await expect(invalidated).rejects.toThrow('YIDA_OWNER_BROWSER_ACTUAL_REQUEST_FAILED')
    await ui!.settled()
    expect(await ui!.page.getByTestId('sp-yida-owner-confirmation').count()).toBe(0)
    expect(await ui!.page.getByTestId('sp-yida-owner-draft').count()).toBe(0)
    expect(await ui!.page.getByTestId('sp-yida-owner-grant').count()).toBe(0)
    if (change === 'session') expect(await ui!.page.getByTestId('sp-yida-owner-error').innerText()).toBe('YIDA_OWNER_SESSION_CHANGED')
    expect(ui!.requests.map(request => [request.method, request.path])).toEqual([
      ['POST', prefix + '/drafts'], ['POST', prefix + '/preview'],
    ])
    expect(await host.proof()).toEqual(before)
    expect([host.tokenPayloads.length, host.formPayloads.length]).toEqual([0, 0])
    expect(draft.rows[2].rowKey).toBeTruthy()
  }, 45000)
})
