'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const test = require('node:test')
const { createMemoryDb } = require('./support/yida-reconciliation-memory-db.cjs')

// R-71 ⑦.5 reconciliation port (RC8-RC10): composition, throttling, lock discipline, evidence separation and
// the structural no-write closure. Fake db, synthetic target/material readers and a fetch double only.
const LIB = path.join(__dirname, '..', 'lib')
const lib = (name) => import(pathToFileURL(path.join(LIB, name)).href)
const portPromise = lib('yida-reconciliation-port.mjs')
const plannerPromise = lib('yida-static-plan.mjs')
const compilerPromise = lib('yida-draft-plan.mjs')
const V2 = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'development', 'takeover-beiliao-20260821',
  'yida-legacy-templates', 'material.json'), 'utf8'))
const LOCATOR = Object.freeze({ appType: 'synthetic_slot_app', formUuid: 'synthetic_slot_form' })
const SEVEN = ['project', 'drawingNo', 'partName', 'specification', 'materialGrade', 'versionNo', 'parentDrawingNo']
const TOKEN_URL = 'https://api.dingtalk.com/v1.0/oauth2/accessToken'
const SEARCH_URL = 'https://api.dingtalk.com/v1.0/yida/forms/instances/advances/query'
const CONTEXT = { tenantId: 'synthetic-tenant', workspaceId: null, ownerId: 'synthetic-owner', actorId: 'synthetic-owner' }
const LEDGER = 'integration_yida_delivery_ledger'
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex')

async function keyDefinition() {
  const { createYidaTransformExample } = await plannerPromise
  const { compileYidaSendDraft } = await compilerPromise
  return compileYidaSendDraft({ config: { ...V2.rules, target: LOCATOR }, rowsText: createYidaTransformExample().text,
    allocation: { ...V2.allocation, projects: ['DEMO-P1', 'DEMO-P2'] } }).keyDefinition
}
const remote = (index, project = 'DEMO-P1') => ({ formInstanceId: `FINST-${index}`, formUuid: LOCATOR.formUuid,
  formData: { project, drawingNo: `DRW-${index}`, partName: 'Synthetic part', materialGrade: 'Q235', versionNo: 'A' } })

async function harness(options = {}) {
  const { createYidaReconciliationPortForTests } = await portPromise
  const memory = createMemoryDb()
  const definition = await keyDefinition()
  const calls = []
  const violations = []
  const sleeps = []
  const pages = options.pages ?? [[remote(1), remote(2)], [remote(3, 'DEMO-P9')]]
  const total = options.total ?? pages.reduce((sum, page) => sum + page.length, 0)
  let enablementReads = 0
  const readEnablement = options.readEnablement ?? (() => { enablementReads += 1; return 'true' })
  const fetch = async (url, init) => {
    if (memory.state.open !== 0) violations.push('fetch while a transaction is open')
    calls.push({ url: String(url), method: init.method })
    if (url === TOKEN_URL) return new Response(JSON.stringify({ accessToken: 'synthetic-access', expireIn: 7200 }))
    if (url === SEARCH_URL) {
      if (options.searchResponse) return options.searchResponse(JSON.parse(init.body))
      const body = JSON.parse(init.body)
      return new Response(JSON.stringify({ pageNumber: body.pageNumber, totalCount: total, data: pages[body.pageNumber - 1] ?? [] }))
    }
    throw new Error('SYNTHETIC_UNEXPECTED_URL')
  }
  const target = { target_ref: 'synthetic-target-ref', credential_ref: 'synthetic-credential', credential_generation: 1,
    key_definition_digest: sha('layout'), plan_digest: sha('plan') }
  const internals = {
    async readTarget(...args) {
      // Same call shape as createInternalYidaApprovedTargetTransactionReader: (trx, targetRef), targetRef optional.
      if (args.length !== 2 || (args[1] !== undefined && typeof args[1] !== 'string')) throw new Error('SYNTHETIC_READ_TARGET_SHAPE')
      const [trx] = args
      // The real reader locks the slot row; the double does the same statement so the log shows where it happens.
      await trx.selectOneForUpdate('integration_yida_approved_target', { slot: 1 })
      return { target, envelope: { locator: LOCATOR, keyDefinition: definition, attestation: { executionIdentity: 'synthetic-user' } } }
    },
    async readExecutionMaterial() {
      return { tenantId: CONTEXT.tenantId, workspaceId: null, ownerId: CONTEXT.ownerId, credentialRef: 'synthetic-credential',
        credentialGeneration: 1, appKey: 'synthetic-key', appSecret: 'synthetic-secret', systemToken: 'synthetic-system',
        userId: options.userId ?? 'synthetic-user' }
    },
    credentialStore: { async loadTokenCredential(binding) { return { ...binding, appKey: 'synthetic-key', appSecret: 'synthetic-secret' } } },
  }
  const port = createYidaReconciliationPortForTests({ db: memory.db, security: { encrypt() {}, decrypt() {} }, context: CONTEXT,
    fetch, readEnablement, readProjectSheetsEnablement: options.readProjectSheetsEnablement ?? (() => undefined),
    sleep: async (ms) => { sleeps.push(ms) } }, internals)
  const input = (patch = {}) => ({ commandId: options.commandId ?? '11111111-2222-4333-8444-555555555555', mode: 'register',
    projectNo: 'DEMO-P1', projectKeyTarget: 'project', expectedKeyTargets: [...SEVEN], pageSize: 2, pagesPerStep: 3, ...patch })
  return { memory, port, calls, violations, sleeps, input, enablementReads: () => enablementReads, definition }
}

test('RC8/RC9: a register step reads page by page, commits each page, never holds a transaction across fetch', async () => {
  const h = await harness()
  const view = await h.port.step(h.input())
  assert.equal(view.status, 'completed')
  assert.equal(view.pagesDone, 2)
  assert.equal(view.counts.registered, 2)
  assert.equal(view.counts.project_mismatch, 1)
  assert.equal(view.tokenIssued, true)
  for (const key of ['canSend', 'externalWriteAttempted', 'businessVerified', 'historyVerified', 'formOwnershipVerified']) assert.equal(view[key], false)
  assert.equal(Object.isFrozen(view), true)
  assert.equal(JSON.stringify(view).includes('DEMO-P1'), false, 'projectNo is never in the view')
  assert.deepEqual(h.violations, [])
  assert.deepEqual(h.calls.map(call => [call.url, call.method]), [[TOKEN_URL, 'POST'], [SEARCH_URL, 'POST'], [SEARCH_URL, 'POST']])
  assert.deepEqual(h.sleeps, [1000], 'one interval between two page reads')
  // Transaction A (first) locks the slot; no page transaction reads or locks the approved target.
  const [first, ...rest] = h.memory.transactions
  assert.ok(first.some(entry => entry.table === 'integration_yida_approved_target'))
  for (const log of rest) assert.equal(log.some(entry => entry.table === 'integration_yida_approved_target'), false)
  // Evidence separation: no ack, no claim, no acknowledgement audit.
  const ledger = h.memory.rows(LEDGER)
  assert.equal(ledger.length, 2)
  assert.ok(ledger.every(row => row.status === 'reconciled_existing' && row.ack_instance_id === null && row.claim_token === null))
  assert.equal(h.memory.rows('integration_yida_delivery_audit').some(row => row.event === 'acknowledgement'), false)
  // A replayed step on a completed run reads nothing.
  const before = h.calls.length
  assert.equal((await h.port.step(h.input())).status, 'completed')
  assert.equal(h.calls.length, before)
})

test('RC8: the switch is re-read before every page; turning it off stops at a page boundary, run still running', async () => {
  let reads = 0
  const h = await harness({ pages: [[remote(1), remote(2)], [remote(3), remote(4)], [remote(5)]],
    readEnablement: () => { reads += 1; return reads <= 9 ? 'true' : 'false' } })
  await assert.rejects(h.port.step(h.input()), { code: 'YIDA_RECONCILE_DISABLED' })
  const runs = h.memory.rows('integration_yida_reconciliation_runs')
  assert.equal(runs[0].status, 'running')
  assert.ok(runs[0].next_page_number >= 2, 'the committed page stays committed')
  const committedPages = h.memory.rows('integration_yida_reconciliation_pages').length
  assert.equal(runs[0].next_page_number, committedPages + 1)
  assert.ok(h.calls.filter(call => call.url === SEARCH_URL).length < 3)
})

test('RC8: execution identity or key layout mismatch is CONFLICT before any network', async () => {
  const wrongUser = await harness({ userId: 'synthetic-other-user' })
  await assert.rejects(wrongUser.port.step(wrongUser.input()), { code: 'YIDA_RECONCILE_CONFLICT' })
  assert.equal(wrongUser.calls.length, 0)
  const wrongLayout = await harness()
  await assert.rejects(wrongLayout.port.step(wrongLayout.input({ expectedKeyTargets: SEVEN.slice(1) })), { code: 'YIDA_RECONCILE_CONFLICT' })
  await assert.rejects(wrongLayout.port.step(wrongLayout.input({ projectKeyTarget: 'specification' })), { code: 'YIDA_RECONCILE_CONFLICT' })
  assert.equal(wrongLayout.calls.length, 0)
  assert.equal(wrongLayout.memory.rows('integration_yida_reconciliation_runs').length, 0)
  const off = await harness({ readEnablement: () => 'TRUE' })
  await assert.rejects(off.port.step(off.input()), { code: 'YIDA_RECONCILE_DISABLED' })
  assert.equal(off.memory.transactions.length, 0)
  assert.equal(off.calls.length, 0)
})

test('RC8: decision R4 — with project sheets ON the project must be registered and active', async () => {
  const absent = await harness({ readProjectSheetsEnablement: () => 'true' })
  await assert.rejects(absent.port.step(absent.input()), { code: 'YIDA_RECONCILE_CONFLICT' })
  assert.equal(absent.calls.length, 0)
  const active = await harness({ readProjectSheetsEnablement: () => 'true' })
  active.memory.seed('integration_stock_prep_project_target', { tenant_id: CONTEXT.tenantId, project_no: 'DEMO-P1', status: 'active' })
  assert.equal((await active.port.step(active.input())).status, 'completed')
  const archived = await harness({ readProjectSheetsEnablement: () => 'true' })
  archived.memory.seed('integration_stock_prep_project_target', { tenant_id: CONTEXT.tenantId, project_no: 'DEMO-P1', status: 'archived' })
  await assert.rejects(archived.port.step(archived.input()), { code: 'YIDA_RECONCILE_CONFLICT' })
})

test('RC8: throttling sleeps one second and retries the same page twice, then stops resumable', async () => {
  let attempts = 0
  const h = await harness({ searchResponse: () => { attempts += 1; return new Response('{"code":"x"}', { status: 429 }) } })
  const view = await h.port.step(h.input())
  assert.equal(attempts, 3)
  assert.deepEqual(h.sleeps, [1000, 1000])
  assert.equal(view.status, 'failed')
  assert.equal(view.lastErrorCode, 'THROTTLED')
  assert.equal(view.nextPageNumber, 1)
  assert.equal(h.memory.rows(LEDGER).length, 0)
  assert.equal(h.memory.rows('integration_yida_reconciliation_pages').length, 0)
})

test('RC9: count mode reads the project and inserts no ledger row', async () => {
  const h = await harness()
  const view = await h.port.step(h.input({ mode: 'count' }))
  assert.equal(view.status, 'completed')
  assert.equal(view.counts.would_register, 2)
  assert.equal(h.memory.rows(LEDGER).length, 0)
  assert.equal(h.memory.rows('integration_yida_delivery_audit').length, 0)
})

test('RC10: the reconciliation import graph reaches no form transport, delivery runner or send port', () => {
  const forbidden = ['yida-form-transport.cjs', 'yida-delivery-runner.mjs', 'yida-owner-send-port.mjs', 'yida-owner-runtime-factory.mjs']
  const seen = new Set()
  const pattern = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g
  function walk(file) {
    if (seen.has(file)) return
    seen.add(file)
    const source = fs.readFileSync(file, 'utf8')
    for (const match of source.matchAll(pattern)) walk(path.resolve(path.dirname(file), match[1]))
  }
  for (const entry of ['yida-reconciliation-binding.mjs', 'yida-reconciliation-port.mjs', 'yida-reconciliation-plan.mjs', 'yida-reconciliation-store.cjs']) {
    walk(path.join(LIB, entry))
  }
  const reached = [...seen].map(file => path.basename(file))
  assert.ok(reached.includes('yida-form-readback.cjs'))
  assert.ok(reached.includes('yida-token-exchange.cjs'))
  for (const name of forbidden) assert.equal(reached.includes(name), false, name)
  // The search client's only endpoint is the fixed search path; the create endpoint never appears in it.
  const readback = fs.readFileSync(path.join(LIB, 'yida-form-readback.cjs'), 'utf8')
  assert.match(readback, /const SEARCH_ENDPOINT = 'https:\/\/api\.dingtalk\.com\/v1\.0\/yida\/forms\/instances\/advances\/query'/)
  assert.equal(/method: '(PUT|PATCH|DELETE)'/.test(readback), false)
})

test('RC10: every URL the step fetches is one of the two fixed read endpoints', async () => {
  const h = await harness()
  await h.port.step(h.input())
  for (const call of h.calls) {
    const url = new URL(call.url)
    assert.equal(url.origin, 'https://api.dingtalk.com')
    assert.ok(['/v1.0/oauth2/accessToken', '/v1.0/yida/forms/instances/advances/query'].includes(url.pathname), url.pathname)
    assert.equal(url.search, '')
    assert.equal(call.method, 'POST')
  }
})
