import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import {
  createYidaConnectionTestRuntime, type YidaConnectionTestInput, type YidaConnectionTestRuntimeBinding,
} from '../../src/integration/yida-connection-test-runtime'
import type { YidaInitializationDatabase } from '../../src/integration/yida-initialization-bootstrap'
import type { Queryable } from '../../src/multitable/automation-durable-dispatcher'
import { createIntegrationYidaOwnerRouter, yidaOwnerNoStoreMiddleware,
  type YidaConnectionTestHttpPort, type YidaInitializationHttpPort, type YidaOwnerHttpPort } from '../../src/routes/integration-yida-owner'
import { YIDA_OWNER_HTTP_PREFIX as PREFIX } from '../../src/integration/yida-owner-http-observation'

// ADR adr-yida-connection-test-20261028, addendum 2026-11-23: the form-definition read inside the same
// 测试连接 click, behind INTEGRATION_YIDA_FORM_FIELDS_READ_ENABLED. CONTROL/QUERY CONTRACT ONLY: a synthetic
// query model, the actual plugin probe binding over an injected fetch, and the actual Express router with fake
// ports. No PostgreSQL, socket or credential; every identifier below is synthetic.
type Row = Record<string, unknown>
const requireCjs = createRequire(import.meta.url)
const { createYidaConnectionProbeBinding } = requireCjs(path.resolve(__dirname, '../../../../plugins/plugin-integration-core/lib/yida-connection-probe.cjs')) as {
  createYidaConnectionProbeBinding(): YidaConnectionTestRuntimeBinding
}
// Literals on purpose: never imported from the plugin.
const DINGTALK_OAUTH_ENDPOINT = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const DEFINITIONS = 'https://api.dingtalk.com/v1.0/yida/forms/definitions/APP_SYNTHETIC01/FORM-SYNTHETIC-01'
const actor = Object.freeze({ actorId: 'synthetic-owner', tenantId: 'synthetic-tenant', workspaceId: null })
const commandId = '00000000-0000-4000-8000-000000000001'
const form = () => ({ appType: 'APP_SYNTHETIC01', formUuid: 'FORM-SYNTHETIC-01', systemToken: 'synthetic-system-token', userId: 'synthetic-user' })
const input = (overrides: Row = {}): YidaConnectionTestInput => ({ commandId, mode: 'candidate',
  material: { appKey: 'synthetic-app', appSecret: 'synthetic-secret' }, form: form(), ...overrides } as YidaConnectionTestInput)
const tokenResponse = () => new Response(JSON.stringify({ accessToken: 'synthetic-access-token', expireIn: 7200 }), { status: 200 })
const definitionsResponse = () => new Response(JSON.stringify({ result: [
  { fieldId: 'textField_proj01', label: '项目号', componentName: 'TextField' },
  { fieldId: 'numberField_qty01', label: '数量', componentName: 'NumberField' },
] }), { status: 200 })

function fixture(options: { enablement?: unknown; formEnablement?: unknown; binding?: YidaConnectionTestRuntimeBinding
  respondDefinitions?: () => Response; respondToken?: () => Response; beforeCommit?: () => void } = {}) {
  let formEnablement: unknown = Object.hasOwn(options, 'formEnablement') ? options.formEnablement : 'true'
  let transactions = 0
  const query: Queryable['query'] = vi.fn(async (text: string, params?: unknown[]) => {
    let rows: Row[] = []
    const user = params?.[0]
    if (text.includes('transaction_isolation')) rows = [{ isolation: 'read committed' }]
    else if (text.includes('pg_current_xact_id')) rows = [{ xid: 'synthetic-stable-xid' }]
    else if (text.includes('pg_advisory_xact_lock')) rows = [{}]
    else if (/FROM user_roles\b/u.test(text)) rows = [{ role_id: 'admin' }]
    else if (/FROM role_permissions\b|FROM user_permissions\b/u.test(text)) rows = []
    else if (/FROM users\b/u.test(text)) rows = [{ id: user, role: 'admin', is_active: true, activation_status: 'activated', permissions: [] }]
    else if (/FROM user_orgs\b/u.test(text)) rows = [{ user_id: user, org_id: params?.[1], is_active: true }]
    else if (/FROM user_namespace_admissions\b/u.test(text)) rows = []
    else if (text.includes('FROM integration_yida_initialization_anchor')) rows = [{ slot: 1, command_id: commandId, owner_id: actor.actorId, tenant_id: actor.tenantId, workspace_id: null }]
    else if (text.includes('FROM integration_yida_initializations')) rows = []
    else if (text.includes('FROM integration_yida_approved_target')) rows = []
    else throw new Error('Unexpected synthetic query')
    return { rows, rowCount: rows.length }
  })
  const database: YidaInitializationDatabase = { async transaction<T>(work: (trx: Queryable) => Promise<T>) {
    transactions++
    const result = await work({ query })
    options.beforeCommit?.()
    return result
  } }
  const fetchCalls: Array<{ url: string; init: RequestInit | undefined }> = []
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init })
    if (String(url) === DINGTALK_OAUTH_ENDPOINT) return (options.respondToken ?? tokenResponse)()
    return (options.respondDefinitions ?? definitionsResponse)()
  }) as unknown as typeof globalThis.fetch
  const runtime = createYidaConnectionTestRuntime({ database, fetch,
    readEnablement: () => Object.hasOwn(options, 'enablement') ? options.enablement : 'true',
    readFormFieldsEnablement: () => formEnablement })
  return { runtime, fetchCalls, binding: options.binding ?? createYidaConnectionProbeBinding(),
    setFormEnablement(value: unknown) { formEnablement = value }, get transactions() { return transactions } }
}
async function active(options: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(options)
  await f.runtime.createPluginCapability().activate(f.binding)
  return f
}
const rejected = (promise: Promise<unknown>, code: string) => expect(promise).rejects.toMatchObject({ code: `YIDA_CONNECTION_TEST_${code}` })
const base = (outcome = 'ok') => ({ commandId, mode: 'candidate', outcome, tokenIssued: outcome === 'ok',
  tokenRetained: false, externalWriteAttempted: false, canSend: false })

describe('YiDa connection test — form-definition read (runtime)', () => {
  it.each([undefined, 'false', 'TRUE', ' true', '1', true])('form switch %j: a named form is DISABLED before any transaction or fetch', async value => {
    const f = await active({ formEnablement: value })
    await rejected(f.runtime.test(actor, input()), 'DISABLED')
    expect([f.transactions, f.fetchCalls.length]).toEqual([0, 0])
    expect(f.runtime.formFieldsReadEnabled()).toBe(false)
  })
  it('the plain test is unchanged while the form switch is off: no formRead key, one exchange', async () => {
    const f = await active({ formEnablement: undefined })
    const { form: _form, ...plain } = input()
    expect(await f.runtime.test(actor, plain as YidaConnectionTestInput)).toEqual(base())
    expect(f.fetchCalls.map(call => call.url)).toEqual([DINGTALK_OAUTH_ENDPOINT])
  })
  it('switch ON: one exchange, then one GET of the fixed definitions path; the view carries fields, never the token', async () => {
    const f = await active()
    expect(f.runtime.formFieldsReadEnabled()).toBe(true)
    const result = await f.runtime.test(actor, input())
    expect(result).toEqual({ ...base(), formRead: { outcome: 'ok', fields: [
      { fieldId: 'textField_proj01', label: '项目号', componentName: 'TextField', parentId: null },
      { fieldId: 'numberField_qty01', label: '数量', componentName: 'NumberField', parentId: null },
    ] } })
    expect(Object.isFrozen(result) && Object.isFrozen(result.formRead) && Object.isFrozen(result.formRead?.fields)).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/synthetic-access-token|synthetic-system-token|synthetic-secret/u)
    expect(f.fetchCalls).toHaveLength(2)
    const read = new URL(f.fetchCalls[1].url)
    expect(read.origin + read.pathname).toBe(DEFINITIONS)
    expect(f.fetchCalls[1].init?.method).toBe('GET')
    expect((f.fetchCalls[1].init?.headers as Row)['x-acs-dingtalk-access-token']).toBe('synthetic-access-token')
  })
  it('a rejected pair never reads the form; a rejected form read keeps the pair ok', async () => {
    const pair = await active({ respondToken: () => new Response('{}', { status: 401 }) })
    expect(await pair.runtime.test(actor, input())).toEqual({ ...base('upstream_rejected'), formRead: { outcome: 'not_attempted', fields: [] } })
    expect(pair.fetchCalls.map(call => call.url)).toEqual([DINGTALK_OAUTH_ENDPOINT])
    const read = await active({ respondDefinitions: () => new Response('{"code":"Forbidden"}', { status: 403 }) })
    expect(await read.runtime.test(actor, input())).toEqual({ ...base(), formRead: { outcome: 'upstream_rejected', fields: [] } })
  })
  it.each([
    ['path traversal appType', { ...form(), appType: 'APP/../x' }],
    ['query in formUuid', { ...form(), formUuid: 'FORM?x=1' }],
    ['padded systemToken', { ...form(), systemToken: 'synthetic-system-token ' }],
    ['control in userId', { ...form(), userId: 'synthetic\nuser' }],
    ['extra key', { ...form(), organizationId: 'x' }],
    ['missing userId', { appType: 'APP_A', formUuid: 'FORM-A', systemToken: 'x' }],
  ])('%s is INPUT before any transaction or fetch', async (_name, bad) => {
    const f = await active()
    await rejected(f.runtime.test(actor, input({ form: bad })), 'INPUT')
    expect([f.transactions, f.fetchCalls.length]).toEqual([0, 0])
  })
  it('the form switch turned off after authorization stops the run before the exchange', async () => {
    let f: ReturnType<typeof fixture> | undefined
    f = await active({ beforeCommit: () => f?.setFormEnablement('false') })
    await rejected(f.runtime.test(actor, input()), 'DISABLED')
    expect(f.transactions).toBe(1)
    expect(f.fetchCalls).toHaveLength(0)
  })
  it('a plugin probe without probeForm is INACTIVE for a named form and never fetches', async () => {
    const binding = Object.freeze({ createConnectionProbe: () => Object.freeze({ async probe() { return Object.freeze({ outcome: 'ok' }) } }) })
    const f = await active({ binding: binding as unknown as YidaConnectionTestRuntimeBinding })
    await rejected(f.runtime.test(actor, input()), 'INACTIVE')
    expect(f.fetchCalls).toHaveLength(0)
  })
  it.each([
    ['token-bearing receipt', { outcome: 'ok', accessToken: 'x', form: Object.freeze({ outcome: 'not_attempted' }) }],
    ['ok form without fields', { outcome: 'ok', form: Object.freeze({ outcome: 'ok' }) }],
    ['fields on a failed read', { outcome: 'ok', form: Object.freeze({ outcome: 'upstream_rejected', fields: Object.freeze([]) }) }],
    ['form read after a rejected pair', { outcome: 'upstream_rejected', form: Object.freeze({ outcome: 'upstream_rejected' }) }],
    ['field with an extra key', { outcome: 'ok', form: Object.freeze({ outcome: 'ok', fields: Object.freeze([Object.freeze({ fieldId: 'textField_a', label: '', componentName: 'TextField', parentId: null, value: 'x' })]) }) }],
    ['unfrozen form', { outcome: 'ok', form: { outcome: 'not_attempted' } }],
  ])('a malformed plugin receipt (%s) is UNAVAILABLE and nothing of it reaches the view', async (_name, receipt) => {
    const binding = Object.freeze({ createConnectionProbe: () => Object.freeze({
      async probe() { return Object.freeze({ outcome: 'ok' }) },
      async probeForm() { return Object.freeze(receipt) },
    }) })
    const f = await active({ binding: binding as unknown as YidaConnectionTestRuntimeBinding })
    await rejected(f.runtime.test(actor, input()), 'UNAVAILABLE')
  })
})

// The actual router: the `form` key exists only while the port reports the form switch ON.
const ready = () => ({ commandId, status: 'ready', draft: null, canSend: false, tokenIssued: false, externalWriteAttempted: false })
function port(result: unknown, formOn: boolean) {
  const calls: unknown[] = []
  const value: YidaConnectionTestHttpPort = {
    async test(_owner, received) { calls.push(received); return result },
    connectionTestEnabled() { return true },
    formFieldsReadEnabled() { return formOn },
  }
  return { value, calls }
}
const initPort: YidaInitializationHttpPort = { async status() { return ready() }, async initialize() { return ready() } }
async function dispatch(method: string, url: string, payload: unknown, connection: YidaConnectionTestHttpPort) {
  const req = Object.assign(new EventEmitter(), { method, url, originalUrl: PREFIX + url, headers: {}, query: {}, body: payload,
    user: { id: actor.actorId }, authenticatedTenantId: actor.tenantId, aborted: false })
  let status = 0
  const owner = { sendEnabled: () => false } as unknown as YidaOwnerHttpPort
  const router = createIntegrationYidaOwnerRouter(owner, initPort, connection)
  const res = Object.assign(new EventEmitter(), { writableEnded: false, destroyed: false, setHeader() {},
    status(value: number) { status = value; return this }, json(_body: unknown) {} })
  const result = await new Promise<unknown>((resolve, reject) => {
    res.json = (sent: unknown) => { res.writableEnded = true; resolve(sent) }
    yidaOwnerNoStoreMiddleware(req as unknown as Request, res as unknown as Response, () => {
      router(req as unknown as Request, res as unknown as Response, reject)
    })
  })
  return { status, result }
}
const body = (withForm = true) => ({ commandId, mode: 'candidate', material: { appKey: 'synthetic-app', appSecret: 'synthetic-secret' },
  ...(withForm ? { form: form() } : {}) })
const fields = [{ fieldId: 'textField_proj01', label: '项目号', componentName: 'TextField', parentId: null }]

describe('YiDa connection test — form-definition read (HTTP contract)', () => {
  it('switch OFF: a form key is a plain 400 before the port; the reply has no formFieldsReadEnabled key', async () => {
    const f = port(base(), false)
    expect(await dispatch('POST', '/initialization/connection-test', body(), f.value)).toEqual({ status: 400, result: { ok: false, error: { code: 'YIDA_OWNER_HTTP_INPUT' } } })
    expect(f.calls).toHaveLength(0)
    const status = await dispatch('GET', '/initialization', undefined, f.value)
    expect(status.status).toBe(200)
    expect(Object.keys((status.result as { data: Row }).data)).not.toContain('formFieldsReadEnabled')
  })
  it('switch ON: the form reaches the port, the closed view carries formRead, and the reply shows the bit', async () => {
    const f = port({ ...base(), formRead: { outcome: 'ok', fields } }, true)
    expect(await dispatch('POST', '/initialization/connection-test', body(), f.value))
      .toEqual({ status: 200, result: { ok: true, data: { ...base(), formRead: { outcome: 'ok', fields } } } })
    expect(f.calls).toEqual([body()])
    const status = await dispatch('GET', '/initialization', undefined, f.value)
    expect((status.result as { data: Row }).data.formFieldsReadEnabled).toBe(true)
  })
  it('switch ON without a form: the plain view, and a stray formRead from the port is refused', async () => {
    expect((await dispatch('POST', '/initialization/connection-test', body(false), port(base(), true).value)).result)
      .toEqual({ ok: true, data: base() })
    const stray = await dispatch('POST', '/initialization/connection-test', body(false), port({ ...base(), formRead: { outcome: 'ok', fields } }, true).value)
    expect(stray.status).toBe(503)
  })
  it.each([
    ['bad appType', { ...form(), appType: 'APP/x' }],
    ['padded systemToken', { ...form(), systemToken: ' x' }],
    ['extra key', { ...form(), extra: 1 }],
  ])('switch ON: %s is a 400 before the port', async (_name, bad) => {
    const f = port(base(), true)
    expect((await dispatch('POST', '/initialization/connection-test', { ...body(false), form: bad }, f.value)).status).toBe(400)
    expect(f.calls).toHaveLength(0)
  })
  it('a port view with a malformed field is refused (no field text leaks through an unchecked shape)', async () => {
    const f = port({ ...base(), formRead: { outcome: 'ok', fields: [{ ...fields[0], value: 'x' }] } }, true)
    expect((await dispatch('POST', '/initialization/connection-test', body(), f.value)).status).toBe(503)
  })
})
