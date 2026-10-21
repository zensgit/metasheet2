import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import type { Page, Request, Response } from '@playwright/test'
import type { YidaInitializationState } from '../../../../apps/web/src/services/integration/yidaInitialization'

type Data = Record<string, unknown>
function data(value: unknown): Data {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'APP_YIDA_AUTO_BROWSER_OBJECT_REQUIRED')
  return value as Data
}
type Expected = { method: 'GET' | 'POST'; pathname: string; status: number; body?: unknown }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const initializationPath = '/api/integration/yida-owner-send/initialization'
const previewPath = '/api/integration/yida-owner-send/preview'

/** A closed, separately armed window AFTER the original initialization journey.
 * Requests always continue to the actual main app. No response/session injection.
 * Adding this window does not extend the original general API allowlist. */
export function createYidaAutomationDefaultOffBrowserWindow(origin: string, token: () => string, ownerId: string) {
  let active = false, rulesPath = '', state: YidaInitializationState | undefined
  let created: Readonly<{ id: string; revision: string; slot: string; sheetId: string }> | undefined
  const armed: Expected[] = [], pending = new Map<Request, Expected>(), matched = new WeakSet<Request>()
  const counts = { requests: 0, responses: 0, ruleGets: 0, rulePosts: 0, initializationGets: 0, previewPosts: 0, expectedConsoleErrors: 0 }
  let previewRefused = false, previewStatusChecked = false, submittedSlot = ''
  let responsePhase: 'NONE' | 'IDENTITY' | 'STATUS' | 'BODY' | 'ENVELOPE' | 'RULE_OWNER' | 'RULE_SHAPE' | 'RULE_REVISION' | 'RULE_SHEET' | 'INIT' | 'PREVIEW' | 'DONE' = 'NONE'
  let responseStatus = 0
  return {
    counts,
    diagnostics() { return { responsePhase, responseStatus } },
    configure(sheetId: string, initialized: YidaInitializationState) {
      assert(!active && sheetId && initialized.status === 'initialized' && initialized.draft?.rowCount === 2)
      rulesPath = '/api/multitable/sheets/' + encodeURIComponent(sheetId) + '/automations'
      state = initialized; active = true
    },
    candidate(request: Pick<Request, 'url'>) {
      const url = new URL(request.url())
      return active && [rulesPath, initializationPath, previewPath].includes(url.pathname)
    },
    armLoad() {
      assert(active && !armed.length && !pending.size && counts.requests === 0)
      armed.push({ method: 'GET', pathname: rulesPath, status: 200 }, { method: 'GET', pathname: initializationPath, status: 200 })
    },
    armCreate() {
      assert(active && !armed.length && !pending.size && counts.responses === 2 && !created)
      armed.push({ method: 'POST', pathname: rulesPath, status: 200 })
    },
    armPreview() {
      assert(active && !armed.length && !pending.size && counts.responses === 3 && created && state?.draft)
      armed.push({ method: 'POST', pathname: previewPath, status: 403,
        body: { operationId: state.draft.operationId, rowKey: state.draft.rows[0].rowKey } })
    },
    accept(request: Request) {
      const expected = armed.shift(), url = new URL(request.url()), headers = request.headers()
      assert(expected && url.origin === origin && !url.search && !url.hash && !url.username && !url.password
        && url.pathname === expected.pathname && request.method() === expected.method, 'APP_YIDA_AUTO_BROWSER_EXACT_REQUEST_REQUIRED')
      assert(token() && headers.authorization === 'Bearer ' + token()
        && !['cookie', 'x-tenant-id', 'x-workspace-id', 'x-owner-id', 'x-user-role'].some(key => key in headers),
      'APP_YIDA_AUTO_BROWSER_SESSION_ONLY_REQUIRED')
      if (expected.method === 'GET') assert.equal(request.postData(), null)
      else {
        assert(/^application\/json(?:\s*;|$)/iu.test(headers['content-type'] ?? ''))
        if (expected.pathname === rulesPath) {
          const body = data(request.postDataJSON()), config = data(body.actionConfig)
          assert.deepEqual(Object.keys(config), ['authorizationSlot'])
          assert(typeof config.authorizationSlot === 'string' && uuid.test(config.authorizationSlot))
          submittedSlot = config.authorizationSlot
          assert.deepEqual(body, { name: '宜搭有限授权', enabled: true, triggerType: 'schedule.interval',
            triggerConfig: { intervalMs: 60000 }, actionType: 'integration_yida_send_authorized',
            actionConfig: { authorizationSlot: submittedSlot }, actions: null, conditions: null, executionMode: 'legacy' })
        } else assert(isDeepStrictEqual(request.postDataJSON(), expected.body), 'APP_YIDA_AUTO_BROWSER_EXACT_BODY_REQUIRED')
      }
      assert(!matched.has(request)); matched.add(request); pending.set(request, expected); counts.requests++
      if (expected.pathname === rulesPath) expected.method === 'GET' ? counts.ruleGets++ : counts.rulePosts++
      else if (expected.pathname === initializationPath) counts.initializationGets++
      else counts.previewPosts++
    },
    owns(request: Request) { return matched.has(request) },
    async response(response: Response) {
      responsePhase = 'IDENTITY'; responseStatus = response.status()
      const expected = pending.get(response.request())
      assert(expected, 'APP_YIDA_AUTO_BROWSER_RESPONSE_IDENTITY_REQUIRED')
      responsePhase = 'STATUS'
      assert.equal(response.status(), expected.status)
      if (expected.pathname === previewPath) previewStatusChecked = true
      responsePhase = 'BODY'
      const envelope = data(await response.json())
      if (expected.pathname === previewPath) {
        responsePhase = 'PREVIEW'
        assert.deepEqual(envelope, { ok: false, error: { code: 'YIDA_OWNER_RUNTIME_DISABLED' } })
        assert.equal(response.headers()['cache-control'], 'no-store')
        previewRefused = true
      } else {
        responsePhase = 'ENVELOPE'
        assert.equal(envelope.ok, true)
        if (expected.pathname === initializationPath) { responsePhase = 'INIT'; assert.deepEqual(envelope.data, state) }
        else if (expected.method === 'POST') {
          const rule = data(data(envelope.data).rule)
          responsePhase = 'RULE_OWNER'
          assert.equal(rule.createdBy, ownerId); assert.equal(rule.enabled, true)
          responsePhase = 'RULE_SHAPE'
          assert.equal(rule.actionType, 'integration_yida_send_authorized')
          assert.deepEqual(rule.actionConfig, { authorizationSlot: submittedSlot })
          responsePhase = 'RULE_REVISION'
          assert(typeof rule.id === 'string' && rule.id && typeof rule.integrationAuthorityRevision === 'string'
            && uuid.test(rule.integrationAuthorityRevision))
          const sheetId = decodeURIComponent(rulesPath.slice('/api/multitable/sheets/'.length, -'/automations'.length))
          responsePhase = 'RULE_SHEET'
          assert.equal(rule.sheetId, sheetId)
          created = Object.freeze({ id: rule.id, revision: rule.integrationAuthorityRevision, slot: submittedSlot, sheetId })
        } else assert(Array.isArray(data(envelope.data).rules))
      }
      pending.delete(response.request()); counts.responses++; responsePhase = 'DONE'
    },
    consoleRefusal(url: string, text: string) {
      if (previewStatusChecked && url === origin + previewPath
        && text === 'Failed to load resource: the server responded with a status of 403 (Forbidden)') {
        counts.expectedConsoleErrors++; assert(counts.expectedConsoleErrors <= 1); return true
      }
      return false
    },
    verify() {
      assert(active && !armed.length && !pending.size && created && previewRefused)
      assert.deepEqual({ ...counts, expectedConsoleErrors: 0 }, { requests: 4, responses: 4, ruleGets: 1, rulePosts: 1,
        initializationGets: 1, previewPosts: 1, expectedConsoleErrors: 0 })
      return { rule: created, counts: { ...counts } }
    },
  }
}

export async function runYidaAutomationDefaultOffBrowser(page: Page,
  window: ReturnType<typeof createYidaAutomationDefaultOffBrowserWindow>, settled: () => Promise<void>) {
  let phase: 'OPEN' | 'LOAD' | 'CREATE_RULE' | 'PREVIEW' | 'VERIFY' = 'OPEN'
  try {
    assert.equal(window.counts.requests, 0)
    await page.getByTestId('sp-yida-auto-open').click()
    const panel = page.getByTestId('sp-yida-auto-panel'); await panel.waitFor(); await settled()
    assert.equal(window.counts.requests, 0, 'APP_YIDA_AUTO_BROWSER_OPEN_MUST_BE_QUIET')
    phase = 'LOAD'; window.armLoad()
    await panel.getByTestId('sp-yida-auto-load').click()
    await panel.getByTestId('sp-yida-auto-draft').waitFor(); await settled()
    assert.equal(await panel.getByTestId('sp-yida-auto-row-0').count(), 1)
    assert.equal(await panel.getByTestId('sp-yida-auto-row-1').count(), 1)
    phase = 'CREATE_RULE'; window.armCreate()
    await panel.getByTestId('sp-yida-auto-create-rule').click()
    // A previously satisfied networkidle load-state is not the receipt for
    // this POST. Wait for the ACTUAL client to parse it and render its option;
    // do not inject a result, retry the create, or increase any timeout budget.
    await panel.getByTestId('sp-yida-auto-rule').locator('option').filter({ hasText: '宜搭有限授权' }).waitFor({ state: 'attached' })
    await settled()
    assert.notEqual(await panel.getByTestId('sp-yida-auto-rule').inputValue(), '', 'APP_YIDA_AUTO_BROWSER_RULE_SELECTION_REQUIRED')
    assert.equal(await panel.getByTestId('sp-yida-auto-grant').count(), 0, 'APP_YIDA_AUTO_BROWSER_RULE_IS_NOT_GRANT')
    await panel.getByTestId('sp-yida-auto-row-0').check()
    await panel.getByTestId('sp-yida-auto-row-1').check()
    phase = 'PREVIEW'; window.armPreview()
    await panel.getByTestId('sp-yida-auto-preview').click()
    await panel.getByTestId('sp-yida-auto-error').filter({ hasText: 'YIDA_OWNER_RUNTIME_DISABLED' }).waitFor()
    await settled()
    phase = 'VERIFY'
    assert.equal(await panel.getByTestId('sp-yida-auto-error').innerText(), 'YIDA_OWNER_RUNTIME_DISABLED')
    for (const id of ['sp-yida-auto-previews', 'sp-yida-auto-approve', 'sp-yida-auto-grant', 'sp-yida-auto-request']) {
      assert.equal(await panel.getByTestId(id).count(), 0, 'APP_YIDA_AUTO_BROWSER_OFF_MUST_NOT_UPGRADE')
    }
    const result = window.verify()
    return { ...result, evidence: { actualPanel: true, openingQuiet: true, actualServerDraftMembers: true,
      actualSdkRuleCreated: true, ruleNotAuthorization: true, twoRowsSelected: true, originalPreviewOff403: true,
      errorRetained: true, approvalAndRequestAbsent: true, responseStubs: 0, storageInjections: 0 } }
  } catch {
    // Only locally generated closed diagnostics; never Playwright errors or DOM.
    let createdOptionPresent: boolean | null = null, selectedRulePresent: boolean | null = null
    try {
      const select = page.getByTestId('sp-yida-auto-panel').getByTestId('sp-yida-auto-rule')
      if (await select.count() === 1) {
        createdOptionPresent = await select.locator('option').filter({ hasText: '宜搭有限授权' }).count() === 1
        selectedRulePresent = (await select.inputValue()) !== ''
      }
    } catch { /* Diagnostic absence does not replace the original failure. */ }
    console.error('YIDA_AUTO_OFF_FAILURE ' + JSON.stringify({ phase, requests: window.counts.requests, responses: window.counts.responses,
      ...window.diagnostics(), createdOptionPresent, selectedRulePresent }))
    throw new Error('APP_YIDA_AUTO_BROWSER_OFF_FAILED')
  }
}
