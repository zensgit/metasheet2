import assert from 'node:assert/strict'
import { isDeepStrictEqual } from 'node:util'
import type { Page, Request, Response } from '@playwright/test'
import { createYidaReconciliationBrowserWindow, runYidaReconciliationBrowser } from './yida-reconciliation-browser'

type Data = Record<string, unknown>
function data(value: unknown): Data {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'APP_YIDA_AUTH_BROWSER_OBJECT_REQUIRED')
  return value as Data
}
export interface YidaAuthorizedBrowserInput {
  operationId: string
  rowKeys: readonly string[]
  rule: Readonly<{ id: string; revision: string; slot: string; sheetId: string }>
}
type Expected = { method: 'GET' | 'POST'; path: string; status: number; kind: 'rules' | 'draft' | 'preview' | 'approve' | 'request' | 'inspect' | 'revoke'; ordinal?: number }
const prefix = '/api/integration/yida-automation-authorizations'
const initialization = '/api/integration/yida-owner-send/initialization'
const preview = '/api/integration/yida-owner-send/preview'
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u

/** Test-only closed browser window. Every request continues to the actual app;
 * no response, JWT, storage, DB result or production sender is substituted. */
export function createYidaAuthorizedBrowserWindow(origin: string, token: () => string, input: YidaAuthorizedBrowserInput) {
  const reconciliation = createYidaReconciliationBrowserWindow(origin, token)
  const rules = '/api/multitable/sheets/' + encodeURIComponent(input.rule.sheetId) + '/automations'
  const armed: Expected[] = [], pending = new Map<Request, Expected>()
  const counts = { requests: 0, responses: 0, previews: 0, approvals: 0, submissions: 0, inspections: 0, revocations: 0 }
  let grantId = '', confirmationId = ''
  const requestKeys = new Set<string>()
  const candidate = (request: Pick<Request, 'url'>) => {
    const url = new URL(request.url())
    return reconciliation.candidate(request) || [rules, initialization, preview, prefix].includes(url.pathname)
      || !!grantId && [prefix + '/' + grantId, prefix + '/' + grantId + '/requests', prefix + '/' + grantId + '/revoke'].includes(url.pathname)
  }
  return {
    counts, candidate, reconciliation,
    arm(kind: Expected['kind'], ordinal?: number) {
      assert(!armed.length && !pending.size, 'APP_YIDA_AUTH_BROWSER_UNFINISHED_REQUEST')
      const path = kind === 'rules' ? rules : kind === 'draft' ? initialization : kind === 'preview' ? preview
        : kind === 'approve' ? prefix : prefix + '/' + grantId + (kind === 'request' ? '/requests' : kind === 'revoke' ? '/revoke' : '')
      assert(['rules','draft','preview','approve'].includes(kind) || uuid.test(grantId))
      armed.push({ kind, path, ordinal, method: ['rules','draft','inspect'].includes(kind) ? 'GET' : 'POST',
        status: kind === 'approve' ? 201 : kind === 'request' ? 202 : 200 })
      if (kind === 'rules') armed.push({ kind: 'draft', path: initialization, method: 'GET', status: 200 })
      if (kind === 'preview' && ordinal === 0) armed.push({ kind, path, ordinal: 1, method: 'POST', status: 200 })
    },
    accept(request: Request) {
      if (reconciliation.candidate(request)) { reconciliation.accept(request); return }
      const expected = armed.shift(), url = new URL(request.url()), headers = request.headers()
      assert(expected && url.origin === origin && url.pathname === expected.path && !url.search && !url.hash
        && !url.username && !url.password && request.method() === expected.method)
      assert(token() && headers.authorization === 'Bearer ' + token()
        && !('x-tenant-id' in headers) && !('x-workspace-id' in headers) && !('cookie' in headers))
      if (expected.method === 'GET') assert.equal(request.postData(), null)
      else {
        assert(/^application\/json(?:\s*;|$)/iu.test(headers['content-type'] ?? ''))
        const body = data(request.postDataJSON())
        if (expected.kind === 'preview') assert.deepEqual(body, { operationId: input.operationId, rowKey: input.rowKeys[expected.ordinal!] })
        else if (expected.kind === 'approve') {
          assert(counts.approvals === 0 && counts.previews === 2 && typeof body.confirmationId === 'string' && uuid.test(body.confirmationId))
          confirmationId = body.confirmationId
          assert.deepEqual(body, { confirmationId, ruleId: input.rule.id, expectedRuleRevision: input.rule.revision,
            actionId: input.rule.slot, projectNo: 'DEMO-P1', operationId: input.operationId, rowKeys: [...input.rowKeys],
            allowedTriggers: ['manual'], maxExecutions: 2, ttlMs: 900000 })
        } else if (expected.kind === 'request') {
          assert.deepEqual(Object.keys(body), ['requestKey'])
          assert(typeof body.requestKey === 'string' && uuid.test(body.requestKey) && !requestKeys.has(body.requestKey)
            && requestKeys.size < 2)
          requestKeys.add(body.requestKey)
        } else assert.deepEqual(body, {})
      }
      pending.set(request, expected); counts.requests++
    },
    matched(request: Request) { return pending.has(request) || reconciliation.matched(request) },
    matches(request: Request, kind: Expected['kind'], ordinal?: number) {
      const expected = pending.get(request)
      return expected?.kind === kind && (ordinal === undefined || expected.ordinal === ordinal)
    },
    async read(response: Response) {
      const expected = pending.get(response.request())
      assert(expected && response.status() === expected.status, 'APP_YIDA_AUTH_BROWSER_HTTP_REQUIRED')
      const envelope = data(await response.json())
      assert.equal(envelope.ok, true)
      const value = envelope.data
      if (expected.kind === 'rules') {
        // List envelopes are parsed by the real client as well. Check the
        // specific production rule without imposing unrelated list ordering.
        const rows = Array.isArray(value) ? value : data(value).rules
        assert(Array.isArray(rows) && rows.some(row => {
          const item = data(row)
          return item.id === input.rule.id && item.sheetId === input.rule.sheetId
        }))
      } else if (expected.kind === 'draft') {
        const state = data(value), draft = data(state.draft)
        assert.equal(state.status, 'initialized'); assert.equal(draft.operationId, input.operationId)
        assert(isDeepStrictEqual(data(state.draft).rows, input.rowKeys.map((rowKey, index) => ({ index, rowKey }))))
      } else if (expected.kind === 'preview') {
        const row = data(value)
        assert.equal(row.operationId, input.operationId); assert.equal(row.rowKey, input.rowKeys[expected.ordinal!]); counts.previews++
      } else if (expected.kind === 'approve') {
        const row = data(value)
        assert(typeof row.grantId === 'string' && uuid.test(row.grantId)); grantId = row.grantId
        assert.equal(row.usedExecutions, 0); assert.equal(row.maxExecutions, 2)
        assert.equal(row.canSend, false); assert.equal(row.externalWriteAttempted, false); counts.approvals++
      } else if (expected.kind === 'request') {
        const row = data(value)
        assert.equal(row.rowOrdinal, expected.ordinal); assert.equal(row.reused, false)
        assert.equal(row.deliveryQueued, true); assert.equal(row.canSend, false); counts.submissions++
      } else if (expected.kind === 'inspect') counts.inspections++
      else { assert.equal(data(value).revoked, true); counts.revocations++ }
      pending.delete(response.request()); counts.responses++
      return value
    },
    verify() {
      assert(!armed.length && !pending.size && counts.requests === counts.responses && counts.previews === 2
        && counts.approvals === 1 && counts.submissions === 2 && counts.inspections >= 4 && counts.revocations === 1)
      return { grantId, counts: { ...counts } }
    },
  }
}

export async function runYidaAuthorizedBrowser(page: Page, window: ReturnType<typeof createYidaAuthorizedBrowserWindow>,
  input: YidaAuthorizedBrowserInput, origin: string, settled: () => Promise<void>, reloadSession: () => Promise<void>) {
  let phase: 'OPEN' | 'LOAD' | 'PREVIEW' | 'APPROVE' | 'REQUEST' | 'ACK' | 'UNKNOWN' | 'REVOKE' = 'OPEN'
  const click = async (kind: Expected['kind'], testId: string, ordinal?: number) => {
    window.arm(kind, ordinal)
    const response = page.waitForResponse(value => window.matched(value.request()))
    await page.getByTestId(testId).click()
    const value = await window.read(await response)
    await settled(); return value
  }
  try {
    assert.equal(new URL(origin).hostname, '127.0.0.1')
    await page.getByTestId('stock-prep-project-board-yida').click()
    await page.getByTestId('sp-yida-preview-mode').selectOption('protocol')
    await page.getByTestId('sp-yida-protocol-example-primary').click()
    await page.getByTestId('sp-yida-run').click()
    await page.getByTestId('sp-yida-auto-open').click()
    const panel = page.getByTestId('sp-yida-auto-panel'); await panel.waitFor(); await settled()
    assert.equal(window.counts.requests, 0, 'APP_YIDA_AUTH_BROWSER_OPEN_QUIET_REQUIRED')
    // Both sequential requests are explicitly armed before the click. The
    // client can start the second before the observer has parsed the first.
    phase = 'LOAD'; window.arm('rules')
    const first = page.waitForResponse(value => window.matches(value.request(), 'rules'))
    const second = page.waitForResponse(value => window.matches(value.request(), 'draft'))
    await panel.getByTestId('sp-yida-auto-load').click()
    await window.read(await first)
    await window.read(await second)
    await panel.getByTestId('sp-yida-auto-draft').waitFor(); await settled()
    await panel.getByTestId('sp-yida-auto-rule').selectOption(input.rule.id)
    await panel.getByTestId('sp-yida-auto-row-0').check(); await panel.getByTestId('sp-yida-auto-row-1').check()
    phase = 'PREVIEW'; window.arm('preview', 0)
    const previewFirst = page.waitForResponse(value => window.matches(value.request(), 'preview', 0))
    const previewSecond = page.waitForResponse(value => window.matches(value.request(), 'preview', 1))
    await panel.getByTestId('sp-yida-auto-preview').click(); await window.read(await previewFirst)
    await window.read(await previewSecond)
    await panel.getByTestId('sp-yida-auto-previews').waitFor(); await settled()
    assert(await panel.getByTestId('sp-yida-auto-approve').isDisabled())
    await panel.getByTestId('sp-yida-auto-manual').check()
    assert.equal(await panel.getByTestId('sp-yida-auto-schedule').isChecked(), false)
    await panel.getByTestId('sp-yida-auto-ack').check()
    phase = 'APPROVE'; await click('approve', 'sp-yida-auto-approve')
    await panel.getByTestId('sp-yida-auto-grant').waitFor()
    assert(await panel.getByTestId('sp-yida-auto-request').isDisabled())
    await click('inspect', 'sp-yida-auto-refresh')
    for (let ordinal = 0; ordinal < 2; ordinal++) {
      phase = 'REQUEST'; await click('request', 'sp-yida-auto-request', ordinal)
      const deadline = performance.now() + 10000
      let terminal = false
      while (performance.now() < deadline) {
        const observed = data(await click('inspect', 'sp-yida-auto-refresh'))
        assert(Array.isArray(observed.requests))
        const row = observed.requests[ordinal] ? data(observed.requests[ordinal]) : undefined
        if (row?.status === (ordinal === 0 ? 'closed_observed' : 'admitted')
          && row.ledgerStatus === (ordinal === 0 ? 'acknowledged' : 'outcome_unknown')) {
          assert.equal(observed.usedExecutions, ordinal + 1); assert.equal(observed.serialBlocked, ordinal === 1)
          terminal = true; break
        }
        await page.waitForTimeout(100) // Read-only observation; never retry a POST.
      }
      assert(terminal, 'APP_YIDA_AUTH_BROWSER_TERMINAL_REQUIRED')
      phase = ordinal === 0 ? 'ACK' : 'UNKNOWN'
      const label = await panel.getByTestId('sp-yida-auto-result-' + ordinal).innerText()
      assert(label.includes(ordinal === 0 ? '业务成功尚未核验' : '禁止再次 CREATE'))
      assert.equal(await panel.getByTestId('sp-yida-auto-request').isDisabled(), ordinal === 1)
    }
    phase = 'REVOKE'; await click('revoke', 'sp-yida-auto-revoke')
    const revoked = data(await click('inspect', 'sp-yida-auto-refresh'))
    assert.equal(revoked.revoked, true); assert.equal(revoked.usedExecutions, 2); assert.equal(revoked.serialBlocked, true)
    assert(await panel.getByTestId('sp-yida-auto-request').isDisabled())
    assert.equal(await panel.getByTestId('sp-yida-auto-error').count(), 0)
    assert(Array.isArray(revoked.requests))
    const unknown = revoked.requests.map(data).filter(row => row.ledgerStatus === 'outcome_unknown')
    assert.equal(unknown.length, 1); assert.equal(typeof unknown[0].requestId, 'string')
    const grantId = window.verify().grantId
    window.reconciliation.scope(grantId, unknown[0].requestId as string)
    let restorations = 0
    const reconciliation = await runYidaReconciliationBrowser(page, window.reconciliation, settled, async () => {
      if (restorations++ === 0) {
        await reloadSession()
        // Re-open through the ordinary UI; do not inject stores or revive the
        // old Vue instance. The pending command must come from tab storage.
        await page.getByTestId('stock-prep-project-board-yida').click()
        await page.getByTestId('sp-yida-preview-mode').selectOption('protocol')
        await page.getByTestId('sp-yida-protocol-example-primary').click()
        await page.getByTestId('sp-yida-run').click()
        await page.getByTestId('sp-yida-auto-open').click()
        await panel.waitFor()
      } else await panel.getByRole('button', { name: '清除本页状态（不删除授权历史）', exact: true }).click()
      await settled()
      assert.equal(await panel.getByTestId('sp-yida-reconciliation').count(), 0)
      await panel.getByTestId('sp-yida-auto-restore-id').fill(grantId)
      const restored = data(await click('inspect', 'sp-yida-auto-restore'))
      assert.deepEqual(restored, revoked)
    })
    assert.equal(restorations, 2)
    return { ...window.verify(), reconciliation, evidence: { realPageApproval: true, realPageRequests: 2, actualServerPreviews: 2,
      manualOnly: true, acknowledged: 1, outcomeUnknown: 1, unknownBlocksNextCreate: true, revokedWithoutRefund: true,
      businessVerified: false, responseStubs: 0, storageInjections: 0 } }
  } catch {
    console.error('YIDA_AUTO_AUTH_BROWSER_FAILURE ' + JSON.stringify({ phase, ...window.counts }))
    throw new Error('APP_YIDA_AUTH_BROWSER_FAILED')
  }
}
