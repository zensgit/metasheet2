// Isolated actual parent Vue -> SDK -> real JWT/live ACL -> actual native
// initialization producer/090-094/PG. Not a full Workbench/password-login proof.
// Browser execution requires the caller's independent native egress isolation;
// page routing or the Node guard alone cannot authorize launching this suite.
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createYidaOwnerBrowserFixture, realBrowserData, realBrowserJson, type YidaOwnerBrowserFixture } from '../utils/stock-preparation-yida-owner-browser-fixture'
import { createYidaOwnerHttpRealdbFixture, draftInput, principals, syntheticMaterial, tenant,
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
  const input = () => draftInput('equal_integer', 6)
  const initializedCounts = [1, 1, 1, 1, 3, 1, 1, 1, 1]
  beforeAll(async () => { host = await createYidaOwnerHttpRealdbFixture({ initialization: true }) }, 30000)
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
    for (const field of materialFields) {
      const control = ui!.page.getByTestId('sp-yida-init-' + field)
      if (await control.count()) expect(await control.inputValue()).toBe('')
    }
    for (const field of ['review', 'organization']) {
      const control = ui!.page.getByTestId('sp-yida-init-' + field)
      if (await control.count()) expect(await control.inputValue()).toBe('')
    }
    const acknowledgment = ui!.page.getByTestId('sp-yida-init-ack')
    if (await acknowledgment.count()) expect(await acknowledgment.isChecked()).toBe(false)
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
    const page = ui.page, expected = input()
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
    await page.getByTestId('sp-yida-initialization-open').waitFor()
    expect(await page.getByTestId('sp-yida-summary').innerText()).toBe('共 3 行；计划创建 3；计划更新 0；无效 0；本地重复键 0。')
    await page.getByTestId('sp-yida-initialization-open').click()
    await page.getByTestId('stock-prep-yida-initialization-panel').waitFor()
    await ui.settled()
    expect(ui.requests).toEqual([])
    expect((await host.initializationProof()).counts).toEqual(Array(9).fill(0))
    await noSend()
    persistenceBefore = await readPersistence()
    const commandId = anchor.command_id as string
    await preflightExport(commandId)
    return commandId
  }
  async function fillPrivate() {
    const fields = syntheticMaterial()
    for (const field of materialFields) await ui!.page.getByTestId('sp-yida-init-' + field).fill(fields[field])
    await ui!.page.getByTestId('sp-yida-init-review').fill('synthetic-http-review')
    await ui!.page.getByTestId('sp-yida-init-organization').fill('synthetic-http-organization')
    await ui!.page.getByTestId('sp-yida-init-ack').check()
    await noPrivatePersistence()
  }
  async function exportWithoutPrivateValues(commandId: string) {
    const before = await host.initializationProof(), requestsBefore = ui!.requests.length
    await ui!.page.getByTestId('sp-yida-rule-export').click()
    await ui!.settled()
    // The real button invalidates the LOCAL preview and unmounts both panels.
    // Do not pretend the client generation/draft remains alive after export.
    expect(await ui!.page.getByTestId('stock-prep-yida-initialization-panel').count()).toBe(0)
    expect(await ui!.page.getByTestId('sp-yida-result').count()).toBe(0)
    const text = await ui!.page.getByTestId('sp-yida-rule-export-text').inputValue()
    const decoded = JSON.stringify(JSON.parse(text))
    const fields = syntheticMaterial()
    const privateStrings = [...materialFields.flatMap(field => [fields[field], fields[field].trim()]),
      'synthetic-http-review', 'synthetic-http-organization']
    expect(privateStrings.some(value => text.includes(value) || decoded.includes(value))).toBe(false)
    // Validate the actual DOM JSON with the actual pure template parser. This
    // is not a replacement SDK, response, storage implementation or planner.
    const exported = parseYidaRuleTemplate(text)
    const { target: _target, ...rules } = input().config
    expect(exported).toEqual({ formatVersion: 1, kind: 'stock-preparation-yida-rule-template',
      status: 'local-unverified', rules, allocation: { mode: 'equal_integer', projectField: 'projectNo', quantityField: 'quantity' } })
    await noPrivateControls(); await noPrivatePersistence()
    expect(ui!.requests.length).toBe(requestsBefore)
    expect((await host.rows('integration_yida_initialization_anchor'))[0].command_id).toBe(commandId)
    expect(await host.initializationProof()).toEqual(before)
    await noSend()
  }
  async function preflightExport(commandId: string) {
    // Before the FIRST GET there is no observed client command to discard and
    // no additional API request is needed. Fill real controls, export, then
    // recompile the unchanged editor through its real DOM button and reopen.
    await fillPrivate()
    await exportWithoutPrivateValues(commandId)
    await ui!.page.getByTestId('sp-yida-run').click()
    await ui!.page.getByTestId('sp-yida-initialization-open').waitFor()
    expect(await ui!.page.getByTestId('sp-yida-summary').innerText()).toBe('共 3 行；计划创建 3；计划更新 0；无效 0；本地重复键 0。')
    await ui!.page.getByTestId('sp-yida-initialization-open').click()
    await ui!.page.getByTestId('stock-prep-yida-initialization-panel').waitFor()
    await ui!.settled(); await noPrivateControls(); await noPrivatePersistence()
    expect(ui!.requests).toEqual([])
  }
  async function observeReady(commandId: string) {
    const response = ui!.waitApi('GET', '/initialization')
    await ui!.page.getByTestId('sp-yida-init-refresh').click()
    expect(await realBrowserData(await response, 200)).toEqual({ commandId, status: 'ready', draft: null,
      canSend: false, tokenIssued: false, externalWriteAttempted: false })
    await ui!.page.getByTestId('sp-yida-init-ready').waitFor()
    await ui!.settled()
    expect(await ui!.page.getByTestId('sp-yida-init-submit').isDisabled()).toBe(true)
    await noSend()
  }
  async function checkInitializationRequest(commandId: string) {
    const submitted = ui!.requests.filter(request => request.method === 'POST' && request.path === prefix + '/initialization')
    expect(submitted).toHaveLength(1)
    expect(submitted[0].body).toEqual({ commandId, material: syntheticMaterial(), draft: input(), attestation: {
      kind: 'owner-reviewed-target', reviewRef: 'synthetic-http-review', organizationId: 'synthetic-http-organization',
      executionIdentity: syntheticMaterial().userId,
    } })
  }
  async function inspectRecovery(commandId: string) {
    const before = await host.initializationProof(), response = ui!.waitApi('GET', '/initialization')
    await ui!.page.getByTestId('sp-yida-init-refresh').click()
    const recovered = await realBrowserData(await response, 200)
    expect(recovered).toMatchObject({ commandId, status: 'initialized', draft: { rowCount: 3, reused: true },
      canSend: false, tokenIssued: false, externalWriteAttempted: false })
    await ui!.page.getByTestId('sp-yida-init-initialized').waitFor()
    await ui!.settled(); await noPrivateControls(); await noPrivatePersistence()
    expect(await host.initializationProof()).toEqual(before)
    await noSend()
    return recovered.draft as unknown as Draft
  }

  it('real parent DOM initializes the empty slot while OFF, clears material and preserves old draft/approval OFF denial', async () => {
    const commandId = await startParent()
    await observeReady(commandId); await fillPrivate()
    const response = ui!.waitApi('POST', '/initialization')
    await ui!.page.getByTestId('sp-yida-init-submit').click()
    await ui!.settled(); await noPrivateControls(); await noPrivatePersistence()
    const result = await realBrowserData(await response, 201)
    expect(result).toMatchObject({ commandId, status: 'initialized', draft: { rowCount: 3, reused: false },
      canSend: false, tokenIssued: false, externalWriteAttempted: false })
    await ui!.page.getByTestId('sp-yida-init-initialized').waitFor()
    expect((await host.initializationProof()).counts).toEqual(initializedCounts)
    const stored = (await host.rows('integration_yida_initializations'))[0], persisted = result.draft as Data
    expect(stored).toMatchObject({ command_id: commandId, owner_id: principals.owner, tenant_id: tenant,
      workspace_id: null, operation_id: persisted.operationId, credential_generation: 1 })
    await checkInitializationRequest(commandId); await noSend()
    const draft = await inspectRecovery(commandId)
    // The same parent opens the unchanged old SDK path. Its OFF denial is real,
    // not a client stub or a claim that initialization enables sending.
    await ui!.page.getByTestId('sp-yida-owner-open').click()
    const off = ui!.waitApi('POST', '/drafts'), before = await host.initializationProof()
    host.sql.length = 0
    await ui!.page.getByTestId('sp-yida-owner-save').click()
    expect(await realBrowserJson(await off, 403)).toEqual({ ok: false, error: { code: 'YIDA_OWNER_RUNTIME_DISABLED' } })
    await ui!.page.getByTestId('sp-yida-owner-disabled').waitFor()
    expect(await ui!.page.getByTestId('sp-yida-owner-save').isDisabled()).toBe(true)
    expect(host.sql).toEqual([])
    // No approval button is present after OFF. Verify the existing server gate
    // independently with actual returned row membership, never forge UI state.
    const approval = await host.http('POST', '/approvals', { operationId: draft.operationId, rowKey: draft.rows[0].rowKey,
      confirmationId: randomUUID(), acknowledgeOnce: true, ttlMs: 900000 })
    expect(approval.status).toBe(403)
    expect(approval.body).toEqual({ ok: false, error: { code: 'YIDA_OWNER_RUNTIME_DISABLED' } })
    expect(host.sql).toEqual([]); expect(await host.initializationProof()).toEqual(before); await noSend()
    expect(ui!.requests.map(request => [request.method, request.path])).toEqual([
      ['GET', prefix + '/initialization'], ['POST', prefix + '/initialization'], ['GET', prefix + '/initialization'], ['POST', prefix + '/drafts'],
    ])
    // All original OFF checks finish first. A post-success export may then
    // close the local panels but must not alter the permanent command or PG.
    await exportWithoutPrivateValues(commandId)
  }, 60000)

  it('another actually qualified admin cannot obtain ready and its pretyped secret controls are cleared', async () => {
    await startParent(true); await fillPrivate()
    const before = await host.initializationProof(), response = ui!.waitApi('GET', '/initialization')
    await ui!.page.getByTestId('sp-yida-init-refresh').click()
    expect(await realBrowserJson(await response, 403)).toEqual({ ok: false, error: { code: 'YIDA_INITIALIZATION_DENIED' } })
    await ui!.page.getByTestId('sp-yida-init-error').waitFor(); await ui!.settled(); await noPrivateControls(); await noPrivatePersistence()
    expect(await ui!.page.getByTestId('sp-yida-init-ready').count()).toBe(0)
    expect(await ui!.page.getByTestId('sp-yida-init-submit').isDisabled()).toBe(true)
    expect(await ui!.page.getByTestId('sp-yida-init-refresh').isDisabled()).toBe(true)
    expect(ui!.requests.map(request => [request.method, request.path])).toEqual([['GET', prefix + '/initialization']])
    expect(await host.initializationProof()).toEqual(before); await noSend()
  }, 60000)

  it('withholding an actual committed 201 freezes POST, then only explicit same-command GET recovers initialized', async () => {
    const commandId = await startParent()
    await observeReady(commandId); await fillPrivate()
    const held = ui!.delayNext('POST', '/initialization'), response = ui!.waitApi('POST', '/initialization')
    expectedAborts = 1
    try {
      await ui!.page.getByTestId('sp-yida-init-submit').click()
      // Reached means actual upstream response EOF/status, not a fabricated
      // response or an invented producer receipt. DB independent session must
      // see the complete COMMIT before the response is allowed to leave Vite.
      await ui!.reached(held, 201)
      expect((await host.initializationProof()).counts).toEqual(initializedCounts)
      await noSend(); await ui!.settled(); await noPrivateControls(); await noPrivatePersistence()
      expect(await ui!.page.locator('fieldset.sp-yida-preview__editor').evaluate(element => (element as HTMLFieldSetElement).disabled)).toBe(true)
      // Keep the original real SDK's existing 15-second logical deadline. Do
      // not install fake timers, alter its reader, resolve its promise or retry.
      await ui!.page.getByTestId('sp-yida-init-error').filter({ hasText: 'YIDA_INITIALIZATION_CANCELLED' }).waitFor({ timeout: 20000 })
      await expect(response).rejects.toThrow('YIDA_OWNER_BROWSER_ACTUAL_REQUEST_FAILED')
      expect(ui!.responseDiagnostics().filter(row => row.operation === 'initialization' && row.method === 'POST')).toMatchObject([
        { requestObserved: true, nativeConfirmed: true, upstreamStatus: 201, upstreamComplete: true,
          browserFailure: 'aborted', requestFinished: false, settlement: 'failed' },
      ])
      expect(await ui!.page.getByTestId('sp-yida-init-uncertain').count()).toBe(1)
      expect(await ui!.page.getByTestId('sp-yida-init-initialized').count()).toBe(0)
      expect(await ui!.page.getByTestId('sp-yida-init-submit').isDisabled()).toBe(true)
      expect(await ui!.page.getByTestId('sp-yida-owner-open').isDisabled()).toBe(true)
      await checkInitializationRequest(commandId)
      await noPrivatePersistence()
    } finally { held.release() }
    await ui!.settled()
    const before = await host.initializationProof()
    await inspectRecovery(commandId)
    expect(await host.initializationProof()).toEqual(before)
    expect(await ui!.page.locator('fieldset.sp-yida-preview__editor').evaluate(element => (element as HTMLFieldSetElement).disabled)).toBe(false)
    expect(ui!.requests.map(request => [request.method, request.path])).toEqual([
      ['GET', prefix + '/initialization'], ['POST', prefix + '/initialization'], ['GET', prefix + '/initialization'],
    ])
    await checkInitializationRequest(commandId); await noSend()
  }, 60000)
})
