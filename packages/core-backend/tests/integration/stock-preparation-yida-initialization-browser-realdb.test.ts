// Isolated actual parent Vue -> SDK -> real JWT/live ACL -> actual native
// initialization producer/090-094/PG. Not a full Workbench/password-login proof.
// Browser execution requires the caller's independent native egress isolation;
// page routing or the Node guard alone cannot authorize launching this suite.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createYidaOwnerBrowserFixture, realBrowserData, realBrowserJson, type YidaOwnerBrowserFixture } from '../utils/stock-preparation-yida-owner-browser-fixture'
import { createYidaOwnerHttpRealdbFixture, fourStepDraftInput, principals, syntheticMaterial, tenant,
  type Data, type Draft, type YidaOwnerHttpRealdbFixture } from '../utils/stock-preparation-yida-owner-http-fixture'
import { parseYidaRuleTemplate } from '../../../../plugins/plugin-integration-core/lib/yida-rule-template.mjs'

const prefix = '/api/integration/yida-owner-send'
const materialFields = ['appKey', 'appSecret', 'systemToken', 'userId'] as const
type BrowserPersistence = {
  local: Array<[string, string]>
  session: Array<[string, string]>
  documentCookie: string
  cookieJar: string
  indexedDbNames: string[]
  cacheNames: string[]
}
it('sentinel: isolated initialization browser requires EXPECT_DB=1 and dedicated DATABASE_URL', () => {
  expect(process.env.EXPECT_DB).toBe('1')
  expect(Boolean(process.env.DATABASE_URL)).toBe(true)
})
const databaseSuite = process.env.EXPECT_DB === '1' && process.env.DATABASE_URL ? describe : describe.skip
databaseSuite('Approved A isolated initialization browser — empty slot and actual parent/HTTP/PG', () => {
  let host: YidaOwnerHttpRealdbFixture, ui: YidaOwnerBrowserFixture | undefined
  let expectedAborts = 0
  let persistenceBefore: BrowserPersistence | undefined
  const input = fourStepDraftInput
  const initializedCounts = [1, 1, 1, 1, 3, 1, 1, 1, 1]
  beforeAll(async () => { host = await createYidaOwnerHttpRealdbFixture({ initialization: true, connectionTest: true }) }, 30000)
  beforeEach(async () => { await host.reset(); expectedAborts = 0; persistenceBefore = undefined }, 30000)
  afterEach(async context => {
    try {
      if (ui) {
        if (context.task.result?.state === 'fail') {
          // Closed diagnostic fields only: never publish request bodies, tokens,
          // arbitrary paths, returned handles, input material or raw rejections.
          console.log('YIDA_INITIALIZATION_BROWSER_DIAGNOSTIC ' + JSON.stringify({ requests: ui.responseDiagnostics(),
            page: await ui.pageDiagnostic(), expectedAborts }))
        }
        expect(ui.violations).toEqual([])
        expect(ui.pageErrors).toBe(0)
        expect(ui.requests.every(request => request.correctSession && !request.scopeHeaders)).toBe(true)
        expect(ui.abortedApiRequests).toBe(expectedAborts)
        const diagnostics = ui.responseDiagnostics()
        expect(diagnostics.filter(row => row.browserFailure === 'aborted')).toHaveLength(expectedAborts)
        expect(diagnostics.filter(row => row.browserFailure === 'unknown')).toHaveLength(0)
      }
    } finally { await ui?.cleanup(); ui = undefined }
  }, 30000)
  afterAll(async () => { await host?.cleanup() }, 30000)

  async function noSend() {
    expect((await host.proof()).counts).toEqual([0, 0, 0, 0, 0, 0])
    expect([host.tokenPayloads.length, host.formPayloads.length]).toEqual([0, 0])
  }
  async function noPrivateControls() {
    // Inspect presence and clearing together: initialization can unmount the
    // fieldset between separate browser calls. Never return private values.
    const controls = await ui!.page.evaluate(fields => fields.map(({ label, kind }) => {
      const nodes = document.querySelectorAll(`[data-testid="sp-yida-${label}"]`)
      const control = nodes[0]
      return { label, count: nodes.length, absentOrEmpty: nodes.length === 0 || (nodes.length === 1
        && control instanceof HTMLInputElement && control.type === kind
        && (kind === 'checkbox' ? !control.checked : control.value === '')) }
    }), [...materialFields.filter(label => label !== 'userId').map(label => ({ label, kind: 'password' })),
      ...['userId', 'review', 'organization'].map(label => ({ label, kind: 'text' })),
      { label: 'ack', kind: 'checkbox' }])
    for (const control of controls) {
      expect(control.count, control.label).toBeLessThanOrEqual(1)
      expect(control.absentOrEmpty, control.label).toBe(true)
    }
  }
  async function readPersistence(): Promise<BrowserPersistence> {
    const actual = await ui!.page.evaluate(async () => {
      const entries = (storage: Storage): Array<[string, string]> => Object.keys(storage).sort()
        .map(key => [key, storage.getItem(key) ?? ''])
      return { local: entries(localStorage), session: entries(sessionStorage), documentCookie: document.cookie,
        // Enumerate real database/cache labels only, never open/create databases
        // or claim that all IndexedDB records/cache response bodies were read.
        indexedDbNames: (await indexedDB.databases()).map(database => database.name ?? '').sort(),
        cacheNames: (await caches.keys()).sort() }
    })
    const cookies = await ui!.page.context().cookies()
    return { ...actual, cookieJar: JSON.stringify(cookies.sort((left, right) =>
      `${left.domain}/${left.path}/${left.name}`.localeCompare(`${right.domain}/${right.path}/${right.name}`))) }
  }
  async function noPrivatePersistence() {
    expect(persistenceBefore !== undefined).toBe(true)
    const before = persistenceBefore!, actual = await readPersistence()
    const fields = syntheticMaterial()
    const privateStrings = [...new Set([...materialFields.flatMap(field => [fields[field], fields[field].trim()]),
      'synthetic-http-review', 'synthetic-http-organization'])]
    const storedStrings = [...actual.local.flat(), ...actual.session.flat(), actual.documentCookie, actual.cookieJar,
      ...actual.indexedDbNames, ...actual.cacheNames]
    // Compare only booleans so a failed assertion cannot print the synthetic
    // session JWT or stored values. Keep the legitimate auth_token unchanged.
    expect({ localUnchanged: JSON.stringify(actual.local) === JSON.stringify(before.local),
      sessionUnchanged: JSON.stringify(actual.session) === JSON.stringify(before.session),
      readableCookiesUnchanged: actual.documentCookie === before.documentCookie,
      allCookiesUnchanged: actual.cookieJar === before.cookieJar,
      databaseLabelsUnchanged: JSON.stringify(actual.indexedDbNames) === JSON.stringify(before.indexedDbNames),
      cacheLabelsUnchanged: JSON.stringify(actual.cacheNames) === JSON.stringify(before.cacheNames),
      privateValueObserved: storedStrings.some(value => privateStrings.some(secret => value.includes(secret))) },
    ).toEqual({ localUnchanged: true, sessionUnchanged: true, readableCookiesUnchanged: true,
      allCookiesUnchanged: true, databaseLabelsUnchanged: true, cacheLabelsUnchanged: true, privateValueObserved: false })
  }
  async function startParent(asOtherAdmin = false) {
    expect((await host.initializationProof()).counts).toEqual(Array(9).fill(0))
    const anchor = (await host.rows('integration_yida_initialization_anchor'))[0]
    expect(anchor).toMatchObject({ slot: 1, owner_id: principals.owner, tenant_id: tenant, workspace_id: null })
    ui = await createYidaOwnerBrowserFixture({ apiOrigin: host.origin,
      ownerToken: asOtherAdmin ? host.tokens.otherOwner : host.tokens.owner,
      otherToken: asOtherAdmin ? host.tokens.owner : host.tokens.otherOwner, draftInput: input(), mode: 'parent' })
    await ui.settled()
    persistenceBefore = await readPersistence()
    expect(ui.requests.map(request => [request.method, request.path])).toEqual([['GET', prefix + '/initialization']])
    if (asOtherAdmin) {
      expect(await realBrowserJson(await ui.initializationRead!, 403)).toEqual({ ok: false, error: { code: 'YIDA_INITIALIZATION_DENIED' } })
    } else {
      expect(await realBrowserData(await ui.initializationRead!, 200)).toMatchObject({ commandId: anchor.command_id, status: 'ready',
        connectionTestEnabled: true, formFieldsReadEnabled: true })
    }
    expect((await host.initializationProof()).counts).toEqual(Array(9).fill(0))
    await noSend()
    return anchor.command_id as string
  }

  async function fillTarget() {
    await ui!.page.getByTestId('sp-yida-app-type').fill('synthetic_http_app')
    await ui!.page.getByTestId('sp-yida-form-uuid').fill('synthetic_http_form')
  }

  async function runLocalPreview() {
    const page = ui!.page
    await page.getByTestId('sp-yida-rows').fill(input().rowsText)
    await page.getByTestId('sp-yida-allocation').locator('summary').click()
    await page.getByTestId('sp-yida-allocation-mode').selectOption('equal_integer')
    await page.getByTestId('sp-yida-allocation-projects').fill('SYN-P1\nSYN-P2\nSYN-P3')
    await page.getByTestId('sp-yida-run').click()
    await page.getByTestId('sp-yida-summary').filter({ hasText: '共 3 行；计划创建 3；无效 0；本地重复键 0。' }).waitFor()
  }

  async function prepareSave(commandId: string) {
    const page = ui!.page
    await page.getByTestId('sp-yida-status').filter({ hasText: '服务器已就绪' }).waitFor()
    expect(await page.getByTestId('sp-yida-save-submit').isDisabled()).toBe(true)
    expect(await page.getByTestId('sp-yida-owner-open').count()).toBe(0)
    await fillTarget()
    const fields = syntheticMaterial()
    for (const field of materialFields) await page.getByTestId('sp-yida-' + field).fill(fields[field])
    await page.getByTestId('sp-yida-review').fill('synthetic-http-review')
    await page.getByTestId('sp-yida-organization').fill('synthetic-http-organization')
    await page.getByTestId('sp-yida-ack').check()
    const response = ui!.waitApi('POST', '/initialization/connection-test')
    await page.getByTestId('sp-yida-connection-test').click()
    const result = await realBrowserData(await response, 200)
    expect(result).toMatchObject({ commandId, outcome: 'ok', formRead: { outcome: 'ok' } })
    expect(JSON.stringify(result)).not.toContain('synthetic-probe-access-token')
    await page.getByTestId('sp-yida-form-read-result').filter({ hasText: '已读到这张表单的 9 个字段' }).waitFor()
    expect(host.connectionCalls).toEqual(['token', 'definitions'])
    expect((await host.initializationProof()).counts).toEqual(Array(9).fill(0))
    await runLocalPreview(); await noPrivatePersistence(); await noSend()
  }

  async function checkRuleArchive() {
    const text = await ui!.page.getByTestId('sp-yida-rule-archive-text').inputValue()
    const decoded = JSON.stringify(JSON.parse(text))
    const fields = syntheticMaterial()
    const privateStrings = [...materialFields.flatMap(field => [fields[field], fields[field].trim()]),
      'synthetic-http-review', 'synthetic-http-organization', 'synthetic_http_app', 'synthetic_http_form']
    expect(privateStrings.some(value => text.includes(value) || decoded.includes(value))).toBe(false)
    const { target: _target, ...rules } = input().config
    expect(parseYidaRuleTemplate(text)).toEqual({ formatVersion: 1, kind: 'stock-preparation-yida-rule-template',
      status: 'local-unverified', rules, allocation: { mode: 'equal_integer', projectField: 'projectNo', quantityField: 'quantity' } })
  }

  async function checkInitializationRequest(commandId: string) {
    const submitted = ui!.requests.filter(request => request.method === 'POST' && request.path === prefix + '/initialization')
    expect(submitted).toHaveLength(1)
    expect(submitted[0].body).toEqual({ commandId, material: syntheticMaterial(), draft: input(), attestation: {
      kind: 'owner-reviewed-target', reviewRef: 'synthetic-http-review', organizationId: 'synthetic-http-organization',
      executionIdentity: syntheticMaterial().userId,
    } })
  }

  it('real parent DOM initializes the empty slot while OFF without a CREATE entry; ON reveals it for one parent owner send', async () => {
    const commandId = await startParent()
    await prepareSave(commandId)
    const response = ui!.waitApi('POST', '/initialization')
    await ui!.page.getByTestId('sp-yida-save-submit').click()
    await ui!.settled(); await noPrivateControls(); await noPrivatePersistence()
    const result = await realBrowserData(await response, 201)
    expect(result).toMatchObject({ commandId, status: 'initialized', draft: { rowCount: 3, reused: false },
      canSend: false, tokenIssued: false, externalWriteAttempted: false, sendEnabled: false })
    await ui!.page.getByTestId('sp-yida-initialized').waitFor()
    expect((await host.initializationProof()).counts).toEqual(initializedCounts)
    const stored = (await host.rows('integration_yida_initializations'))[0], persisted = result.draft as Data
    expect(stored).toMatchObject({ command_id: commandId, owner_id: principals.owner, tenant_id: tenant,
      workspace_id: null, operation_id: persisted.operationId, credential_generation: 1 })
    await checkInitializationRequest(commandId); await noSend()
    const draft = result.draft as unknown as Draft
    await checkRuleArchive()
    // OFF: the UI offers no CREATE entry at all. The old draft/approval OFF denials stay real and
    // independent of the UI: verify them with actual returned row membership, never forged UI state.
    expect(await ui!.page.getByTestId('stock-prep-yida-owner-send-panel').count()).toBe(0)
    const before = await host.initializationProof()
    host.sql.length = 0
    const off = await host.http('POST', '/drafts', input())
    expect(off.status).toBe(403)
    expect(off.body).toEqual({ ok: false, error: { code: 'YIDA_OWNER_RUNTIME_DISABLED' } })
    const approval = await host.http('POST', '/approvals', { operationId: draft.operationId, rowKey: draft.rows[0].rowKey,
      confirmationId: randomUUID(), acknowledgeOnce: true, ttlMs: 900000 })
    expect(approval.status).toBe(403)
    expect(approval.body).toEqual({ ok: false, error: { code: 'YIDA_OWNER_RUNTIME_DISABLED' } })
    expect(host.sql).toEqual([]); expect(await host.initializationProof()).toEqual(before); await noSend()
    expect(ui!.requests.map(request => [request.method, request.path])).toEqual([
      ['GET', prefix + '/initialization'], ['POST', prefix + '/initialization/connection-test'], ['POST', prefix + '/initialization'],
    ])
    // On reload a real authorized read restores the permanent initialization, but not local preview rows.
    host.setEnablement('true')
    const page = ui!.page, expected = input(), reopened = ui!.waitApi('GET', '/initialization')
    await page.reload()
    expect(await realBrowserData(await reopened, 200)).toMatchObject({ commandId, status: 'initialized',
      draft: { rowCount: 3, reused: true }, sendEnabled: true })
    await page.getByTestId('sp-yida-initialized').waitFor()
    expect(await page.getByTestId('sp-yida-owner-open').isDisabled()).toBe(true)
    expect(await page.getByTestId('sp-yida-appSecret').isDisabled()).toBe(true)
    await fillTarget()
    const mappings = expected.config.fieldMap as Array<{ target: string }>
    for (let index = 0; index < mappings.length; index++) {
      await page.getByTestId(`sp-yida-map-target-${index}`).fill(mappings[index].target)
    }
    await runLocalPreview()
    await page.getByTestId('sp-yida-owner-open').click()
    await page.getByTestId('stock-prep-yida-owner-send-panel').waitFor()
    const saved = ui!.waitApi('POST', '/drafts')
    await page.getByTestId('sp-yida-owner-save').click()
    const owned = await realBrowserData(await saved, 201) as unknown as Draft
    // The actual parent captured its own DOM input and handed exactly that to the owner child.
    expect(ui!.requests.filter(request => request.path === prefix + '/drafts').map(request => request.body)).toEqual([expected])
    expect(owned.rows).toHaveLength(3)
    await page.getByTestId('sp-yida-owner-draft').waitFor()
    await page.getByTestId('sp-yida-owner-row').selectOption(owned.rows[2].rowKey)
    const previewed = ui!.waitApi('POST', '/preview')
    await page.getByTestId('sp-yida-owner-preview').click()
    const preview = await realBrowserData(await previewed, 200)
    await page.getByTestId('sp-yida-owner-payload').waitFor()
    expect(preview.payload).toEqual(host.compiledPayload(expected, 2))
    await page.getByTestId('sp-yida-owner-ack').check()
    const approved = ui!.waitApi('POST', '/approvals')
    await page.getByTestId('sp-yida-owner-approve').click()
    const grant = await realBrowserData(await approved, 201)
    await page.getByTestId('sp-yida-owner-grant').waitFor()
    // The child's actual locked-change event must reach the actual parent.
    expect(await page.locator('[data-testid="sp-yida-preview"]').evaluate(element => (element as HTMLFieldSetElement).disabled)).toBe(true)
    expect((await host.proof()).counts).toEqual([1, 0, 0, 1, 0, 0])
    expect([host.tokenPayloads.length, host.formPayloads.length]).toEqual([0, 0])
    const sentResponse = ui!.waitApi('POST', '/submissions')
    await page.getByTestId('sp-yida-owner-submit').click()
    const sent = await realBrowserData(await sentResponse, 200)
    await page.getByTestId('sp-yida-owner-acknowledged').waitFor()
    expect(sent).toMatchObject({ status: 'acknowledged', businessVerified: false, externalWriteAttempted: true,
      approval: { grantId: grant.grantId, remainingAttempts: 0 }, delivery: { status: 'acknowledged', durable: true } })
    expect([host.tokenPayloads.length, host.formPayloads.length, host.tokenCommitted, host.validRequests]).toEqual([1, 1, true, true])
    expect(host.formPayloads[0]).toEqual(preview.payload)
    expect((await host.proof()).counts).toEqual([1, 0, 1, 2, 1, 3])
    expect(await page.getByTestId('sp-yida-owner-submit').isDisabled()).toBe(true)
    expect(ui!.requests.map(request => [request.method, request.path])).toEqual([
      ['GET', prefix + '/initialization'], ['POST', prefix + '/initialization/connection-test'], ['POST', prefix + '/initialization'],
      ['GET', prefix + '/initialization'], ['POST', prefix + '/drafts'], ['POST', prefix + '/preview'],
      ['POST', prefix + '/approvals'], ['POST', prefix + '/submissions'],
    ])
    expect((await host.rows('integration_yida_initialization_anchor'))[0].command_id).toBe(commandId)
  }, 90000)

  it('another qualified admin gets a native refusal and cannot enter private material or save', async () => {
    await startParent(true)
    const page = ui!.page, before = await host.initializationProof()
    await page.getByTestId('sp-yida-error').filter({ hasText: 'YIDA_INITIALIZATION_DENIED' }).waitFor()
    expect(ui!.responseDiagnostics()).toMatchObject([{ operation: 'initialization', method: 'GET',
      nativeConfirmed: true, upstreamStatus: 403, requestFinished: true }])
    await noPrivateControls(); await noPrivatePersistence()
    expect(await page.getByTestId('sp-yida-appSecret').isDisabled()).toBe(true)
    expect(await page.getByTestId('sp-yida-save-submit').isDisabled()).toBe(true)
    expect(await page.getByTestId('sp-yida-owner-open').count()).toBe(0)
    expect(ui!.requests).toHaveLength(1)
    expect(host.connectionCalls).toEqual([])
    expect(await host.initializationProof()).toEqual(before); await noSend()
  }, 60000)

  it('withholding a committed 201 freezes POST until an automatic same-command GET recovers initialized', async () => {
    host.setEnablement('true')
    const commandId = await startParent()
    await prepareSave(commandId)
    const page = ui!.page, held = ui!.delayNext('POST', '/initialization')
    const response = ui!.waitApi('POST', '/initialization')
    const rejected = expect(response).rejects.toThrow('YIDA_OWNER_BROWSER_ACTUAL_REQUEST_FAILED')
    expectedAborts = 1
    try {
      await page.getByTestId('sp-yida-save-submit').click()
      await ui!.reached(held, 201)
      expect((await host.initializationProof()).counts).toEqual(initializedCounts)
      await noSend(); await noPrivateControls(); await noPrivatePersistence()
      expect(await page.getByTestId('sp-yida-save-submit').isDisabled()).toBe(true)
      expect(await page.getByTestId('sp-yida-owner-open').count()).toBe(0)
      const proof = await host.initializationProof()
      const recovery = ui!.delayNext('GET', '/initialization')
      const recovered = ui!.waitApi('GET', '/initialization')
      try {
        await rejected
        await ui!.reached(recovery, 200)
        await page.getByTestId('sp-yida-status').filter({ hasText: '服务器状态未确认' }).waitFor()
        expect(await page.getByTestId('sp-yida-save-submit').isDisabled()).toBe(true)
        expect(await page.getByTestId('sp-yida-owner-open').count()).toBe(0)
        await checkInitializationRequest(commandId)
      } finally { recovery.release() }
      expect(await realBrowserData(await recovered, 200)).toMatchObject({ commandId, status: 'initialized',
        draft: { rowCount: 3, reused: true }, sendEnabled: true })
      await page.getByTestId('sp-yida-initialized').waitFor()
      await page.locator('[data-testid="sp-yida-owner-open"]:enabled').waitFor()
      expect(await host.initializationProof()).toEqual(proof)
    } finally { held.release() }
    await ui!.settled()
    expect(ui!.responseDiagnostics().filter(row => row.operation === 'initialization' && row.method === 'POST')).toMatchObject([
      { requestObserved: true, nativeConfirmed: true, upstreamStatus: 201, upstreamComplete: true,
        browserFailure: 'aborted', requestFinished: false, settlement: 'failed' },
    ])
    expect(ui!.requests.map(request => [request.method, request.path])).toEqual([
      ['GET', prefix + '/initialization'], ['POST', prefix + '/initialization/connection-test'], ['POST', prefix + '/initialization'],
      ['GET', prefix + '/initialization'],
    ])
    await checkInitializationRequest(commandId); await noPrivateControls(); await noPrivatePersistence(); await noSend()
  }, 60000)
})
