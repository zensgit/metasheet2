import assert from 'node:assert/strict'
import type { Page, Request, Response, Route } from '@playwright/test'
import { checkedReconciliationInput, checkedReconciliationRecord } from '../../src/integration/yida-reconciliation-contracts'

type Expected = { method: 'GET' | 'POST'; head: number; mode?: 'lose' | 'replay' }
/** Actual app requests only. One explicit test fault discards a real committed
 * response; no successful response, JWT, storage or database is fabricated. */
export function createYidaReconciliationBrowserWindow(origin: string, token: () => string) {
  let path = '', firstId = ''
  const armed: Expected[] = [], pending = new Map<Request, Expected>()
  const inputs = new Map<Request, ReturnType<typeof checkedReconciliationInput>>()
  const saved: ReturnType<typeof checkedReconciliationRecord>[] = []
  const counts = { requests: 0, responses: 0, reads: 0, appends: 0, droppedReceipts: 0,
    idempotentReplays: 0, expectedNetworkFailures: 0 }
  let lostInput: ReturnType<typeof checkedReconciliationInput> | undefined, consoleFailures = 0
  const expectedFailures = new WeakSet<Request>()
  const candidate = (request: Pick<Request, 'url'>) => !!path && new URL(request.url()).pathname === path
  async function read(request: Request, response: Pick<Response, 'status' | 'headers' | 'json'>) {
    const expected = pending.get(request)
    assert(expected && response.status() === (expected.method === 'POST' && expected.mode !== 'replay' ? 201 : 200))
    assert.equal(response.headers()['cache-control'], 'no-store')
    const envelope = await response.json() as { ok: boolean; data: Record<string, unknown> }
    assert.equal(envelope.ok, true)
    const data = envelope.data
    if (expected.method === 'POST') {
      const record = checkedReconciliationRecord(data.record), input = inputs.get(request)!
      assert.equal(data.reused, expected.mode === 'replay')
      for (const key of Object.keys(input) as (keyof typeof input)[]) assert.deepEqual(record[key], input[key])
      assert.equal(record.sequence, expected.head + 1)
      assert.equal(typeof record.id, 'string')
      if (expected.mode === 'replay') { assert.deepEqual(record, saved[0]); counts.idempotentReplays++ }
      else {
        if (expected.head === 0) firstId = record.id as string
        saved.push(record); counts.appends++
      }
      inputs.delete(request)
    } else {
      assert.deepEqual(data, { records: saved, headSequence: expected.head, nextAfterId: null, canSend: false, canRetry: false })
      assert.equal(saved.length, expected.head); counts.reads++
    }
    pending.delete(request)
    if (expected.mode === 'lose') counts.droppedReceipts++
    else counts.responses++
  }
  return {
    candidate,
    scope(grantId: string, requestId: string) {
      assert(!path && [grantId, requestId].every(id => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)))
      path = `/api/integration/yida-automation-authorizations/${grantId}/requests/${requestId}/observations`
    },
    arm(method: 'GET' | 'POST', head: number, mode?: 'lose' | 'replay') {
      assert(path && !armed.length && !pending.size)
      assert(!mode || method === 'POST' && head === 0)
      armed.push({ method, head, ...(mode ? { mode } : {}) })
      if (method === 'POST' && mode !== 'lose') armed.push({ method: 'GET', head: head + 1 })
    },
    accept(request: Request) {
      const expected = armed.shift(), url = new URL(request.url()), headers = request.headers()
      assert(expected && url.origin === origin && url.pathname === path && !url.search && !url.hash
        && !url.username && !url.password && request.method() === expected.method)
      assert(token() && headers.authorization === 'Bearer ' + token()
        && !('x-tenant-id' in headers) && !('x-workspace-id' in headers) && !('cookie' in headers))
      if (expected.method === 'GET') assert.equal(request.postData(), null)
      else {
        assert(/^application\/json(?:\s*;|$)/iu.test(headers['content-type'] ?? ''))
        const body = checkedReconciliationInput(request.postDataJSON())
        assert.deepEqual(body, { commandKey: body.commandKey, expectedHeadSequence: expected.head,
          conclusion: 'inconclusive', reason: expected.head === 0 ? 'NO_OBSERVATION' : 'CORRECTION',
          evidenceKind: null, evidenceRef: null, evidenceSha256: null, claimedObservedAt: null,
          supersedesObservationId: expected.head === 0 ? null : firstId })
        if (expected.mode === 'replay') {
          assert(lostInput && counts.droppedReceipts === 1 && counts.idempotentReplays === 0)
          assert.deepEqual(body, lostInput)
        } else {
          assert(!saved.some(row => row.commandKey === body.commandKey))
          if (expected.mode === 'lose') { assert(!lostInput && !saved.length); lostInput = body }
        }
        inputs.set(request, body)
      }
      pending.set(request, expected); counts.requests++
    },
    matched(request: Request, method?: 'GET' | 'POST') {
      return pending.has(request) && (method === undefined || pending.get(request)!.method === method)
    },
    async read(response: Response) { await read(response.request(), response) },
    async dropCommittedResponse(route: Route) {
      const request = route.request()
      if (pending.get(request)?.mode !== 'lose') return false
      // Default redirect/retry handling must not forward this JWT elsewhere or
      // silently issue a second POST. Read the real 201 before losing delivery.
      const upstream = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30000 })
      try { await read(request, upstream) } finally { await upstream.dispose() }
      expectedFailures.add(request)
      await route.abort('failed')
      return true
    },
    expectedFailure(request: Request) {
      if (!expectedFailures.has(request)) return false
      assert.equal(request.failure()?.errorText, 'net::ERR_FAILED')
      expectedFailures.delete(request); counts.expectedNetworkFailures++
      return true
    },
    consoleFailure(url: string, message: string) {
      if (counts.droppedReceipts !== 1 || consoleFailures || url !== origin + path
        || message !== 'Failed to load resource: net::ERR_FAILED') return false
      consoleFailures++; return true
    },
    verify() {
      assert(!armed.length && !pending.size && !inputs.size)
      assert.deepEqual(counts, { requests: 8, responses: 7, reads: 5, appends: 2,
        droppedReceipts: 1, idempotentReplays: 1, expectedNetworkFailures: 1 })
      assert.equal(saved.length, 2); assert.equal(saved[1].supersedesObservationId, saved[0].id)
      return { records: saved, counts: { ...counts }, evidence: { realUiAppend: true, realUiCorrection: true,
        realUiRemountRead: true, realUiLostReceiptRecovery: true, originalUnknownVisible: true, evidenceUnverified: true,
        responseStubs: 0, storageInjections: 0, externalSend: false } }
    },
  }
}

export async function runYidaReconciliationBrowser(page: Page, window: ReturnType<typeof createYidaReconciliationBrowserWindow>,
  settled: () => Promise<void>, remount: () => Promise<void>) {
  const panel = () => page.getByTestId('sp-yida-reconciliation').filter({ hasText: 'outcome_unknown' })
  const read = async (head: number) => {
    window.arm('GET', head)
    const response = page.waitForResponse(value => window.matched(value.request(), 'GET'))
    await panel().getByRole('button', { name: '读取核验历史', exact: true }).click()
    await window.read(await response); await settled()
  }
  assert.equal(await panel().count(), 1)
  const append = () => panel().getByRole('button', { name: '追加人工声明', exact: true })
  assert(await append().isDisabled())
  window.arm('GET', 0)
  const initial = page.waitForResponse(value => window.matched(value.request(), 'GET'))
  await panel().getByRole('button', { name: '读取核验历史', exact: true }).click()
  await window.read(await initial); await settled()
  for (let head = 0; head < 2; head++) {
    if (head === 1) await panel().getByRole('button', { name: '追加更正此条', exact: true }).click()
    assert(await append().isDisabled())
    await panel().getByRole('checkbox').check()
    if (head === 0) {
      window.arm('POST', 0, 'lose')
      const lost = page.waitForEvent('requestfailed', request => window.candidate(request) && request.method() === 'POST')
      await append().click(); await lost; await settled()
      assert.equal(await panel().getByRole('button', { name: '按原命令及原内容核对（仅本地记录）', exact: true }).count(), 1)
      // Genuine component teardown and sessionStorage recovery, no injection.
      await remount()
      assert.equal(await panel().locator('ol > li').count(), 0)
      await read(1)
      assert.equal(await panel().locator('ol > li').count(), 1)
    }
    window.arm('POST', head, head === 0 ? 'replay' : undefined)
    const post = page.waitForResponse(value => window.matched(value.request(), 'POST'))
    const refresh = page.waitForResponse(value => window.matched(value.request(), 'GET'))
    await (head === 0 ? panel().getByRole('button', { name: '按原命令及原内容核对（仅本地记录）', exact: true }) : append()).click()
    await window.read(await post); await window.read(await refresh); await settled()
    assert.equal(await panel().locator('ol > li').count(), head + 1)
    assert(await append().isDisabled())
    assert((await panel().innerText()).includes('不允许重发'))
  }
  await remount()
  assert.equal(await panel().locator('ol > li').count(), 0)
  await read(2)
  assert.equal(await panel().locator('ol > li').count(), 2)
  assert((await panel().innerText()).includes('追加更正，原记录仍保留'))
  return window.verify()
}
