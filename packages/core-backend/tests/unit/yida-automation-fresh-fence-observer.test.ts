import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { observeUnknownLedger, isResolvedUnknownRetry } from '../utils/yida-automation-main-fresh-consent-fence'
import { verifyYidaNaturalOccurrences } from '../utils/yida-automation-main-inflight-stop'
import { createYidaMainSyntheticVendor } from '../utils/yida-automation-main-synthetic-send'
import { initializationMaterial } from '../utils/stock-preparation-yida-initialization-full-app'

const identity = { tenantId: 'synthetic-tenant', ownerId: 'synthetic-owner', operationId: 'synthetic-operation', rowKey: 'synthetic-row' }
const sql = 'SELECT * FROM "integration_yida_delivery_ledger" WHERE "tenant_id" = $1 AND "workspace_id" IS NULL'
  + ' AND "operation_id" = $2 AND "row_key" = $3 LIMIT 1 FOR UPDATE'
const values = [identity.tenantId, identity.operationId, identity.rowKey]
const result = { rows: [{ tenant_id: identity.tenantId, owner_id: identity.ownerId, workspace_id: null,
  operation_id: identity.operationId, row_key: identity.rowKey, status: 'outcome_unknown' }] }

describe('native unknown-row observer preserves both original pg calling contracts', () => {
  for (const mode of [undefined, 'unknown-first'] as const) {
    it(`synthetic vendor ${mode ?? 'original'} preserves exact transport body and first receipt semantics`, async () => {
      const keys = ['NODE_ENV','PLM_FULL_APP_DATABASE_URL','INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED'] as const
      const old = keys.map(key => [key, process.env[key]] as const)
      process.env.NODE_ENV = 'production'
      process.env.PLM_FULL_APP_DATABASE_URL = 'postgresql://127.0.0.1/plm_full_app_synthetic'
      process.env.INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED = 'true'
      let fallbackCalls = 0
      const vendor = createYidaMainSyntheticVendor(async () => { fallbackCalls++; throw new Error('SYNTHETIC_FALLBACK_FORBIDDEN') })
      const material = initializationMaterial(), signal = new AbortController().signal
      try {
        vendor.start(mode)
        const token = await vendor.fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', { method: 'POST', redirect: 'error', signal,
          body: JSON.stringify({ appKey: material.appKey, appSecret: material.appSecret }) })
        const access = await token.json() as { accessToken: string }
        const response = await vendor.fetch('https://api.dingtalk.com/v1.0/yida/forms/instances', { method: 'POST', redirect: 'error', signal,
          headers: { 'x-acs-dingtalk-access-token': access.accessToken }, body: JSON.stringify({ appType: 'synthetic_stock_app',
            formUuid: 'synthetic_stock_form', systemToken: material.systemToken, userId: material.userId,
            formDataJson: JSON.stringify({ project: 'DEMO-P1', componentCode: 'DEMO-PART-A', componentName: '示例物料',
              specification: 'SPEC-1', material: 'MAT-1', version: 'V1', qty: 0, priority: 'normal' }) }) })
        expect(response.status).toBe(201)
        expect(await response.json()).toEqual({ result: mode === 'unknown-first' ? null : 'synthetic-automatic-instance' })
        expect(vendor.snapshot()).toEqual({ active: true, closed: false, tokenCalls: 1, formCalls: 1, refusedCalls: 0 })
        vendor.close()
        await expect(vendor.fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', { method: 'POST', redirect: 'error', signal,
          body: '{}' })).rejects.toThrow('APP_YIDA_SYNTHETIC_VENDOR_REFUSED')
        expect(fallbackCalls).toBe(0)
      } finally {
        vendor.close()
        for (const [key, value] of old) if (value === undefined) delete process.env[key]; else process.env[key] = value
      }
    })
  }
  const naturalWitness = () => {
    const value = { grantId: 'synthetic-grant', activationId: 'synthetic-activation', ruleId: 'synthetic-rule',
      ruleRevision: 'synthetic-revision', actionId: 'synthetic-slot', anchorMs: 10000, approvedAtMs: 10001,
      observedAtMs: 15000, intervalMs: 2000, requests: [] as { ordinal: number; occurrenceKey: string }[] }
    const hash = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex')
    const definition = hash(['yida-interval-definition/v1', value.ruleId, value.ruleRevision, value.actionId, 10000, 2000])
    value.requests = [12000, 14000].map((scheduled, ordinal) => ({ ordinal, occurrenceKey: hash(['yida-automation-occurrence/v1',
      value.grantId, value.activationId, value.ruleId, value.ruleRevision, value.actionId, 'schedule.interval', scheduled, 10000, 2000, definition]) }))
    return value
  }
  it('accepts two distinct persisted natural ticks after the real grant phase, not a fabricated scheduler receipt', () => {
    expect(verifyYidaNaturalOccurrences(naturalWitness())).toEqual({ phaseAnchorVerified: true, occurrenceKeysVerified: 2, manualOccurrencesExcluded: true })
  })
  it('rejects wrong phase/version/activation/manual hash and duplicate or reversed natural requests', () => {
    const value = naturalWitness()
    const patches = [{ anchorMs: 10001 }, { approvedAtMs: 12001 }, { observedAtMs: 13999 }, { intervalMs: 1000 },
      { ruleRevision: 'other-revision' }, { activationId: 'other-activation' }, { grantId: 'other-grant' },
      { requests: value.requests.slice().reverse() }, { requests: [value.requests[0], { ...value.requests[0], ordinal: 1 }] },
      { requests: [{ ...value.requests[0], ordinal: 1 }, value.requests[1]] },
      { requests: value.requests.map(request => ({ ...request, occurrenceKey: createHash('sha256').update(JSON.stringify([
        'yida-automation-occurrence/v1', value.grantId, value.activationId, value.ruleId, value.ruleRevision, value.actionId,
        'manual', 'synthetic-manual-request'])).digest('hex') })) }]
    for (const patch of patches) expect(() => verifyYidaNaturalOccurrences({ ...value, ...patch })).toThrow(/APP_CONFIGURED_YIDA_NATURAL_/u)
  })
  it('requires a completed original retry fence, never just an in-progress or historical-error claim', () => {
    const resolved = { status: 'in_progress', attempts: 1, fence: '2', last_error: 'unknown' }
    expect(isResolvedUnknownRetry(resolved)).toBe(true)
    expect(isResolvedUnknownRetry({ ...resolved, attempts: 2, fence: '4' })).toBe(true)
    for (const patch of [{ fence: '1' }, { attempts: 2, fence: '3' }, { fence: '3' }, { fence: 2 }, { fence: '-2' },
      { fence: '02' }, { attempts: 0 }, { attempts: '1' }, { attempts: 1.5 }, { attempts: 65, fence: '130' },
      { last_error: null }, { last_error: 'adapter_timeout' }, { status: 'pending' }, { status: 'dead_letter' }, { status: 'done' }]) {
      expect(isResolvedUnknownRetry({ ...resolved, ...patch })).toBe(false)
    }
  })
  it('arms after an existing observer has captured the client-own query; restore leaves captured forwarder inactive', async () => {
    const pending = Promise.resolve(result)
    class Client { query(..._args: unknown[]) { return pending } }
    const client = new Client(), original = Client.prototype.query
    const observer = observeUnknownLedger(Client)
    const captured = client.query
    client.query = function (...args: unknown[]) { return Reflect.apply(captured, this, args) }
    const args = [{ text: sql, values }]
    try {
      await client.query(...args)
      expect(observer.counts).toEqual({ attempts: 0, completions: 0, unknownRows: 0, errors: 0 })
      observer.arm(identity)
      await observer.positiveControl(() => client.query(...args))
      expect(observer.counts).toEqual({ attempts: 0, completions: 0, unknownRows: 0, errors: 0 })
      expect(client.query(...args)).toBe(pending); await pending
      expect(observer.counts).toEqual({ attempts: 1, completions: 1, unknownRows: 1, errors: 0 })
      expect(() => observer.arm(identity)).toThrow('APP_YIDA_FRESH_FENCE_ALREADY_ARMED')
    } finally { observer.restore() }
    expect(Client.prototype.query).toBe(original)
    await client.query(...args)
    expect(observer.counts).toEqual({ attempts: 1, completions: 1, unknownRows: 1, errors: 0 })
  })
  it('unarmed observation refuses a control instead of accepting no query as proof', async () => {
    class Client { query(..._args: unknown[]) { return Promise.resolve(result) } }
    const observer = observeUnknownLedger(Client)
    try { await expect(observer.positiveControl(() => new Client().query(sql, values))).rejects.toThrow('APP_YIDA_FRESH_FENCE_NOT_ARMED') }
    finally { observer.restore() }
  })
  for (const config of [false, true]) {
    it(`${config ? 'QueryConfig' : 'string'} Promise is returned unchanged; census does not become worker evidence`, async () => {
      const pending = Promise.resolve(result), received: unknown[][] = []
      class Client { query(...args: unknown[]) { received.push(args); return pending } }
      const client = new Client(), original = Client.prototype.query
      const observer = observeUnknownLedger(Client, identity)
      const args = config ? [{ text: sql, values, query_timeout: 8000 }] : [sql, values]
      try {
        await observer.positiveControl(async () => client.query(...args))
        expect(observer.counts).toEqual({ attempts: 0, completions: 0, unknownRows: 0, errors: 0 })
        expect(client.query(...args)).toBe(pending)
        await pending
        expect(observer.counts).toEqual({ attempts: 1, completions: 1, unknownRows: 1, errors: 0 })
        expect(received).toEqual([args, args])
        expect(received[1][0]).toBe(args[0])
      } finally { observer.restore() }
      expect(Client.prototype.query).toBe(original)
    })
    it(`${config ? 'QueryConfig' : 'string'} callback retains this, all arguments and original return`, () => {
      const marker = {}, callbackThis = {}, extra = {}, returned = {}
      class Client {
        query(...args: unknown[]) {
          const callback = args.at(-1) as (...args: unknown[]) => unknown
          expect(callback.call(callbackThis, null, result, extra)).toBe(returned)
          return marker
        }
      }
      const client = new Client(), observer = observeUnknownLedger(Client, identity)
      const callback = function (this: unknown, ...args: unknown[]) {
        expect(this).toBe(callbackThis); expect(args).toEqual([null, result, extra]); return returned
      }
      try {
        const args = config ? [{ text: sql, values }, callback] : [sql, values, callback]
        expect(client.query(...args)).toBe(marker)
        expect(observer.counts).toEqual({ attempts: 1, completions: 1, unknownRows: 1, errors: 0 })
      } finally { observer.restore() }
    })
  }
  it('unrelated scope/query passes untouched and is not counted', async () => {
    const pending = Promise.resolve(result)
    class Client { query(..._args: unknown[]) { return pending } }
    const client = new Client(), observer = observeUnknownLedger(Client, identity)
    try {
      expect(client.query({ text: sql, values: ['other-tenant', ...values.slice(1)] })).toBe(pending)
      expect(client.query('SELECT 1')).toBe(pending)
      await pending
      expect(observer.counts).toEqual({ attempts: 0, completions: 0, unknownRows: 0, errors: 0 })
    } finally { observer.restore() }
  })
  it('a resolved row that is not unknown cannot satisfy the positive control', async () => {
    class Client { query(..._args: unknown[]) { return Promise.resolve({ rows: [{ ...result.rows[0], status: 'acknowledged' }] }) } }
    const client = new Client(), observer = observeUnknownLedger(Client, identity)
    try { await expect(observer.positiveControl(() => client.query({ text: sql, values }))).rejects.toThrow('APP_YIDA_FRESH_FENCE_QUERY_CONTROL_REQUIRED') }
    finally { observer.restore() }
  })
  it('the original rejection is preserved and recorded without a fabricated completion', async () => {
    const failure = new Error('SYNTHETIC_QUERY_REJECTED')
    class Client { query(..._args: unknown[]) { return Promise.reject(failure) } }
    const client = new Client(), observer = observeUnknownLedger(Client, identity)
    try {
      await expect(client.query({ text: sql, values })).rejects.toBe(failure)
      expect(observer.counts).toEqual({ attempts: 1, completions: 0, unknownRows: 0, errors: 1 })
    } finally { observer.restore() }
  })
})
