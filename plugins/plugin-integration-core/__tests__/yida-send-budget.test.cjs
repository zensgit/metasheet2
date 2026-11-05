'use strict'

// Gate 4 (R-71 ⑦.2): the shared YiDa send budget. Every oracle here is the REAL code: the real
// planner, the real delivery runner (snapshot bound, plan, ledger, claim) and the real form transport
// (input checks and request-body bound). Only the database, the token client and fetch are synthetic,
// and fetch never reaches a network. All values are synthetic; nothing here is a customer value.
const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const { stableCanonicalStringify } = require('../lib/gip-canonical-json.cjs')
const budget = require('../lib/yida-send-budget.cjs')
const { createYidaFormTransport } = require('../lib/yida-form-transport.cjs')

const LIB = path.resolve(__dirname, '../lib')
const LIMIT = 262144
const bytes = (text) => Buffer.byteLength(text, 'utf8')
const WORST = { systemToken: '\u0001'.repeat(4096), userId: '\u0001'.repeat(128) }
const REALISTIC = { systemToken: 'T'.repeat(64), userId: 'u'.repeat(24) }
const planner = import('../lib/yida-static-plan.mjs')
const runnerModule = import('../lib/yida-delivery-runner.mjs')
const LEDGER = 'integration_yida_delivery_ledger'
const AUDIT = 'integration_yida_delivery_audit'
const id = (tag) => `synthetic-${tag}`.padEnd(36, '0')
const context = () => ({ tenantId: id('tenant'), workspaceId: null, ownerId: id('owner'), actorId: id('owner') })
const identity = () => ({ operationId: id('operation'), rowKey: id('row') })

// The primitive's execution snapshot without the two credential fields: the exact key set the host
// execution handle resolves (resolveExecutionSnapshot), with real-length identifiers.
function snapshotOf(config, row) {
  return { ...context(), ...identity(), grantRef: id('grant'), expiresAt: 2000000000000, targetRef: id('target'),
    targetRevision: 'evidence-1', planRevision: 'f'.repeat(64), credentialRef: id('credential'), credentialGeneration: 1,
    config, row }
}

function config(n, targetName, extra = {}) {
  const sources = Array.from({ length: n }, (_, i) => 's' + i)
  const targets = Array.from({ length: n }, (_, i) => targetName(i))
  return {
    version: 2, kind: 'yida-form-protocol-static',
    target: { appType: extra.appType || 'synthetic_app', formUuid: extra.formUuid || 'synthetic_form' },
    intent: 'create', businessKey: [sources[0]], emptyKeyFields: [],
    fieldCatalog: targets.map((target, i) => extra.options && i >= (extra.selectFrom ?? 1)
      ? { id: target, control: 'select', required: false, options: extra.options(i) }
      : { id: target, control: 'text', required: i === 0 }),
    fieldMap: sources.map((source, i) => ({ source, target: targets[i], type: 'string', required: i === 0 })),
  }
}
const shortTargets = (i) => 't' + i
const longTargets = (i) => ('t' + i).padEnd(128, 'x')
const cjkOptions = (count) => () => Array.from({ length: count }, (_, k) => (String(k) + '选项').padEnd(128, '项'))

// Plan one row exactly as the primitive does: the selected row is rebuilt from the planned payload
// through the field map, and the create data is the canonical payload text.
async function planned(cfg, row) {
  const { buildYidaStaticPlan } = await planner
  let plan
  try { plan = buildYidaStaticPlan({ config: cfg, rows: [row] }) } catch { return null }
  const entry = plan.rows[0]
  if (!entry || entry.status !== 'planned_create' || entry.issues.length !== 0) return null
  const selectedRow = Object.fromEntries(cfg.fieldMap.filter((field) => Object.hasOwn(entry.payload, field.target))
    .map((field) => [field.source, entry.payload[field.target]]))
  const data = { ...entry.protocolPreview.data, formDataJson: stableCanonicalStringify(entry.payload) }
  return { snapshot: snapshotOf(cfg, selectedRow), data, previewPayloadBytes: bytes(JSON.stringify(entry.payload)) }
}

// A row: key field s0, then text fields s1..s<textFields>, each starting with one ASCII character (so a
// field never switches between omitted and present), `count` copies of `fill` spread over them, then
// `pad` ASCII characters (one byte each, everywhere); the remaining select fields stay null.
function rowOf(fill, count, pad = 0, textFields = 31, total = 32) {
  const row = { s0: 'K' }
  const perField = Math.floor(4095 / fill.length)
  let left = count
  for (let i = 1; i <= textFields; i += 1) {
    const take = Math.min(perField, left)
    row['s' + i] = 'b' + fill.repeat(take)
    left -= take
  }
  if (left > 0) return null
  let padLeft = pad
  for (let i = 1; i <= textFields && padLeft > 0; i += 1) {
    const take = Math.min(4096 - row['s' + i].length, padLeft)
    row['s' + i] += 'a'.repeat(take)
    padLeft -= take
  }
  for (let i = textFields + 1; i < total; i += 1) row['s' + i] = null
  return padLeft > 0 ? null : row
}

// A bounded single-process stand-in for the delivery ledger (same shape as the runner suite's).
function memoryDb() {
  let state = { [LEDGER]: [], [AUDIT]: [] }
  const copy = (value) => structuredClone(value)
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value)
  return {
    rows: () => copy(state[LEDGER]),
    db: {
      async selectOne(table, where) { return copy(state[table].find((row) => matches(row, where)) || null) },
      async transaction(callback) {
        const staged = copy(state)
        const trx = {
          async setTransactionIsolationLevel(level) { assert.equal(level, 'read committed') },
          async selectOneForUpdate(table, where) { return copy(staged[table].find((row) => matches(row, where)) || null) },
          async insertOne(table, values) {
            const row = { claim_token: null, claim_actor_id: null, ack_status_code: null, ack_instance_id: null,
              ...copy(values), created_at: '2000-01-01T00:00:00.000Z', updated_at: '2000-01-01T00:00:00.000Z' }
            staged[table].push(row)
            return [copy(row)]
          },
          async updateRow(table, values, where) {
            const changed = staged[table].filter((row) => matches(row, where))
            for (const row of changed) Object.assign(row, copy(values))
            return copy(changed)
          },
        }
        const result = await callback(trx)
        state = staged
        return result
      },
    },
  }
}

// The real runner + real transport, credentials substituted. 'acknowledged' means the snapshot bound,
// the plan, the transport input checks and the request-body bound ALL passed and the POST went out.
async function pipeline(assessed, credentials) {
  const { createYidaDeliveryRunner } = await runnerModule
  const store = memoryDb()
  const seen = { business: 0, bodyBytes: null }
  const transport = createYidaFormTransport({ readEnablement: () => 'true', fetch: async (_url, init) => {
    seen.business += 1
    seen.bodyBytes = bytes(init.body)
    return new Response(JSON.stringify({ result: 'synthetic-instance' }), { status: 201 })
  } })
  const snapshot = { ...assessed.snapshot, ...credentials }
  const runner = createYidaDeliveryRunner({ db: store.db, context: context(),
    resolveExecutionSnapshot: async () => structuredClone(snapshot),
    tokenClient: { getAccessToken: async () => 'synthetic_access' }, formTransport: transport,
    readEnablement: () => 'true', wallClock: () => 1000, timeoutMs: 60000 })
  let status
  try { status = (await runner.run(identity())).status } catch (error) { status = error.code }
  return { status, ...seen, ledger: store.rows().length }
}

// The real transport's input checks, offline: a disabled transport answers DISABLED only after its own
// input checks (including the request-body bound) passed, and never calls fetch.
async function transportVerdict(data, credentials) {
  let fetched = 0
  const transport = createYidaFormTransport({ fetch: () => { fetched += 1; throw new Error('synthetic-offline') } })
  const error = await transport.send({ intent: 'create', data, accessToken: 'synthetic_access', ...credentials },
    { signal: new AbortController().signal }).then(() => null, (failure) => failure)
  assert.equal(fetched, 0)
  return error && error.code
}

function verdict(assessed) {
  const result = budget.assessYidaSendBudget({ snapshot: assessed.snapshot, data: assessed.data })
  assert.equal(Object.isFrozen(result), true)
  assert.deepEqual(Object.keys(result), ['withinBudget'])
  assert.equal(typeof result.withinBudget, 'boolean')
  return result.withinBudget
}
const bodyBytes = (data, credentials) => bytes(budget.encodeYidaFormRequestBody(data, credentials.systemToken, credentials.userId))
const snapshotBytes = (assessed, credentials) => bytes(stableCanonicalStringify({ ...assessed.snapshot, ...credentials }))

test('the shared constants are the one definition and the runner, transport and primitive use it', () => {
  assert.equal(budget.YIDA_SEND_SNAPSHOT_MAX_BYTES, LIMIT)
  assert.equal(budget.YIDA_SEND_REQUEST_MAX_BYTES, LIMIT)
  assert.equal(budget.YIDA_SEND_SNAPSHOT_MAX_NODES, 4096)
  assert.equal(budget.YIDA_SEND_SNAPSHOT_MAX_DEPTH, 12)
  assert.equal(budget.YIDA_SEND_SYSTEM_TOKEN_MAX_LENGTH, 4096)
  assert.equal(budget.YIDA_SEND_USER_ID_MAX_LENGTH, 128)
  assert.deepEqual(Object.keys(budget).sort(), ['YIDA_SEND_REQUEST_MAX_BYTES', 'YIDA_SEND_SNAPSHOT_MAX_BYTES',
    'YIDA_SEND_SNAPSHOT_MAX_DEPTH', 'YIDA_SEND_SNAPSHOT_MAX_NODES', 'YIDA_SEND_SYSTEM_TOKEN_MAX_LENGTH',
    'YIDA_SEND_USER_ID_MAX_LENGTH', 'assessYidaSendBudget', 'boundYidaExecutionSnapshot', 'encodeYidaFormRequestBody'])
  assert.equal(budget.encodeYidaFormRequestBody({ appType: 'a', formUuid: 'b', formDataJson: '{"k":"\\""}' }, 's', 'u'),
    JSON.stringify({ appType: 'a', formUuid: 'b', formDataJson: '{"k":"\\""}', systemToken: 's', userId: 'u' }))
})

test('no independent 256 KiB literal remains on the send path; each consumer takes the shared definition', () => {
  const root = path.resolve(__dirname, '../../..')
  const files = {
    runner: path.join(LIB, 'yida-delivery-runner.mjs'),
    transport: path.join(LIB, 'yida-form-transport.cjs'),
    primitives: path.join(LIB, 'yida-send-authority-primitives.mjs'),
    service: path.join(root, 'packages/core-backend/src/integration/yida-send-approval-service.ts'),
    route: path.join(root, 'packages/core-backend/src/routes/integration-yida-owner.ts'),
    web: path.join(root, 'apps/web/src/services/integration/yidaOwner.ts'),
  }
  const literal = /256\s*\*\s*1024|262_?144|0x40000|1024\s*\*\s*256|2\s*\*\*\s*18|1\s*<<\s*18/
  const text = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, fs.readFileSync(file, 'utf8')]))
  for (const [key, source] of Object.entries(text)) assert.equal(literal.test(source), false, `${key} carries its own send budget literal`)
  assert.match(text.runner, /from '\.\/yida-send-budget\.cjs'/)
  assert.match(text.runner, /boundYidaExecutionSnapshot\(value\)/)
  assert.match(text.transport, /require\('\.\/yida-send-budget\.cjs'\)/)
  assert.match(text.transport, /const MAX_REQUEST_BYTES = YIDA_SEND_REQUEST_MAX_BYTES\b/)
  assert.match(text.transport, /const body = encodeYidaFormRequestBody\(data, request\.systemToken, request\.userId\)/)
  assert.match(text.primitives, /sendBudgetModule\.assessYidaSendBudget\(/)
  assert.match(text.route, /from '\.\.\/integration\/yida-send-budget'/)
  assert.match(text.web, /from '\.\/yidaSendBudget'/)
  // The only definition of the number on the send path is the shared module (the mirrors are pinned equal elsewhere).
  assert.match(fs.readFileSync(path.join(LIB, 'yida-send-budget.cjs'), 'utf8'), /const YIDA_SEND_REQUEST_MAX_BYTES = 262144\n/)
})

test('request body boundary: exactly 262,144 bytes with worst-case credentials is within, 262,145 is not', async () => {
  const cfg = config(32, shortTargets)
  // Find the ASCII padding that puts the worst-case request body exactly on the limit.
  const base = await planned(cfg, rowOf('"', 59000))
  const short = LIMIT - bodyBytes(base.data, WORST)
  assert.ok(short > 0 && short < 32 * 4096)
  const exact = await planned(cfg, rowOf('"', 59000, short)), over = await planned(cfg, rowOf('"', 59000, short + 1))
  assert.equal(bodyBytes(exact.data, WORST), LIMIT)
  assert.equal(bodyBytes(over.data, WORST), LIMIT + 1)
  assert.ok(snapshotBytes(exact, WORST) < LIMIT && snapshotBytes(over, WORST) < LIMIT)
  assert.equal(verdict(exact), true)
  assert.equal(verdict(over), false)
  // The same two rows against the real transport and the real runner, worst-case credentials.
  assert.equal(await transportVerdict(exact.data, WORST), 'YIDA_FORM_DISABLED')
  assert.equal(await transportVerdict(over.data, WORST), 'YIDA_FORM_INPUT')
  const sent = await pipeline(exact, WORST), refused = await pipeline(over, WORST)
  assert.deepEqual([sent.status, sent.business, sent.bodyBytes], ['acknowledged', 1, LIMIT])
  // Today, without the pre-admission check, this row would be claimed and recorded as an unknown outcome
  // although no byte left: the transport refuses it before fetch.
  assert.deepEqual([refused.status, refused.business], ['outcome_unknown', 0])
})

test('snapshot boundary: exactly 262,144 serialized bytes with worst-case credentials is within, 262,145 is not', async () => {
  const cfg = config(32, shortTargets, { options: cjkOptions(30), selectFrom: 16 })
  const base = await planned(cfg, rowOf('a', 0, 0, 15))
  const short = LIMIT - snapshotBytes(base, WORST)
  assert.ok(short > 0 && short < 15 * 4095, String(short))
  const exact = await planned(cfg, rowOf('a', 0, short, 15)), over = await planned(cfg, rowOf('a', 0, short + 1, 15))
  assert.equal(snapshotBytes(exact, WORST), LIMIT)
  assert.equal(snapshotBytes(over, WORST), LIMIT + 1)
  assert.ok(bodyBytes(exact.data, WORST) < LIMIT && bodyBytes(over.data, WORST) < LIMIT)
  assert.equal(verdict(exact), true)
  assert.equal(verdict(over), false)
  assert.doesNotThrow(() => budget.boundYidaExecutionSnapshot({ ...exact.snapshot, ...WORST }))
  assert.throws(() => budget.boundYidaExecutionSnapshot({ ...over.snapshot, ...WORST }), { code: 'YIDA_SEND_BUDGET_INVALID' })
  const sent = await pipeline(exact, WORST), refused = await pipeline(over, WORST)
  assert.deepEqual([sent.status, sent.business], ['acknowledged', 1])
  assert.deepEqual([refused.status, refused.business, refused.ledger], ['YIDA_RUN_SNAPSHOT_INVALID', 0, 0])
})

test('escape doubling is refused even though the planner and the preview accept it; CJK and control rows are not', async () => {
  const fillToCap = async (cfg, fill) => {
    // Grow every value with `fill` until the planner's 128 KiB row JSON cap.
    const row = Object.fromEntries(cfg.fieldMap.map((field, i) => [field.source, i === 0 ? 'K' : '']))
    const unit = bytes(JSON.stringify(fill)) - 2
    for (let i = 1; i < cfg.fieldMap.length; i += 1) {
      const room = Math.floor((131072 - bytes(JSON.stringify([row]))) / unit)
      row['s' + i] += fill.repeat(Math.max(0, Math.min(4096 - row['s' + i].length, room)))
    }
    assert.ok(bytes(JSON.stringify([row])) <= 131072 && bytes(JSON.stringify([row])) > 131072 - unit - 16)
    const result = await planned(cfg, row)
    assert.ok(result, 'planner accepts the row')
    return result
  }
  const quotes = await fillToCap(config(32, longTargets), '"')
  assert.equal(quotes.previewPayloadBytes, 133070) // far below the 256 KiB preview DTO cap: the preview shows it
  assert.equal(bodyBytes(quotes.data, REALISTIC), 264118) // over the limit even with realistic credentials
  assert.equal(verdict(quotes), false)
  assert.equal(await transportVerdict(quotes.data, REALISTIC), 'YIDA_FORM_INPUT')
  const backslashes = await fillToCap(config(32, longTargets), '\\')
  assert.equal(verdict(backslashes), false)
  for (const fill of ['中', '\u0001']) {
    const multi = await fillToCap(config(32, shortTargets), fill)
    assert.equal(verdict(multi), true, `a maximal ${fill === '中' ? 'CJK' : 'control-character'} row is not falsely refused`)
    assert.ok(bodyBytes(multi.data, WORST) <= 178118)
    const sent = await pipeline(multi, WORST)
    assert.deepEqual([sent.status, sent.business], ['acknowledged', 1])
  }
})

test('long select options in the config: 16 per field is within, 24 per field is refused before admission', async () => {
  const row = (cfg) => Object.fromEntries(cfg.fieldMap.map((field) => [field.source, null]))
  const results = {}
  for (const count of [16, 24]) {
    const cfg = config(32, shortTargets, { options: cjkOptions(count) })
    const value = row(cfg); value.s0 = 'K'
    const assessed = await planned(cfg, value)
    assert.ok(assessed, 'planner and draft limits accept the config')
    assert.ok(bodyBytes(assessed.data, WORST) < 30000)
    results[count] = { within: verdict(assessed), run: await pipeline(assessed, WORST), realistic: await pipeline(assessed, REALISTIC) }
  }
  assert.equal(results[16].within, true)
  assert.deepEqual([results[16].run.status, results[16].run.business], ['acknowledged', 1])
  assert.equal(results[24].within, false)
  // Over the snapshot limit even with realistic credentials: today this would consume the permit and
  // leave the ledger fence prepared forever. Here the runner proves it refuses before preparing.
  assert.deepEqual([results[24].realistic.status, results[24].realistic.business, results[24].realistic.ledger],
    ['YIDA_RUN_SNAPSHOT_INVALID', 0, 0])
})

test('soundness: every accepted row passes the real runner bound and the real transport with worst-case credentials', async () => {
  // Deterministic synthetic corpus around each fill's own threshold: quotes, backslashes, CJK, a
  // supplementary-plane character, a lone surrogate, control characters, plain ASCII; short and
  // 128-character target field names; with and without long option lists.
  const fills = ['"', '\\', '中', '\u{1F600}', '\ud800', '\u0001', 'a']
  const shapes = [
    { name: 'short', make: () => config(32, shortTargets) },
    { name: 'long-names', make: () => config(32, longTargets) },
    { name: 'options', text: 15, make: () => config(32, shortTargets, { options: cjkOptions(24), selectFrom: 16 }) },
    { name: 'long-locator', make: () => config(32, shortTargets, { appType: 'A'.repeat(128), formUuid: 'F'.repeat(128) }) },
  ]
  const tally = { accepted: 0, refused: 0, planned: new Set() }
  for (const shape of shapes) {
    const cfg = shape.make()
    for (const fill of fills) {
      // Largest planner-accepted count, then the budget threshold below it.
      const text = shape.text ?? 31
      let low = 0, high = Math.floor(4095 / fill.length) * text
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (await planned(cfg, rowOf(fill, mid, 0, text))) low = mid; else high = mid - 1
      }
      const plannerMax = low
      low = 0; high = plannerMax
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        if (verdict(await planned(cfg, rowOf(fill, mid, 0, text)))) low = mid; else high = mid - 1
      }
      const counts = new Set([0, low, Math.max(0, low - 1), Math.min(plannerMax, low + 1), plannerMax])
      for (const count of counts) {
        const assessed = await planned(cfg, rowOf(fill, count, 0, text))
        assert.ok(assessed, `${shape.name}/${count} planned`)
        tally.planned.add(fill)
        const within = verdict(assessed)
        const worst = await pipeline(assessed, WORST)
        // Exact for the worst case: the assessment answers what the real runner + transport answer.
        assert.equal(worst.status === 'acknowledged', within, `${shape.name} fill ${JSON.stringify(fill)} x${count}`)
        if (within) {
          tally.accepted += 1
          assert.equal(worst.business, 1)
          assert.ok(worst.bodyBytes <= LIMIT)
          assert.equal(await transportVerdict(assessed.data, WORST), 'YIDA_FORM_DISABLED')
          assert.doesNotThrow(() => budget.boundYidaExecutionSnapshot({ ...assessed.snapshot, ...WORST }))
          const realistic = await pipeline(assessed, REALISTIC)
          assert.deepEqual([realistic.status, realistic.business], ['acknowledged', 1])
        } else {
          tally.refused += 1
          assert.equal(worst.business, 0)
        }
      }
    }
  }
  assert.deepEqual([...tally.planned].sort(), [...fills].sort())
  assert.ok(tally.accepted >= 20 && tally.refused >= 8, JSON.stringify({ accepted: tally.accepted, refused: tally.refused }))
})

test('closed input: malformed snapshot or data throws a fixed values-free error; credentials are never accepted', () => {
  const snapshot = snapshotOf({ version: 2 }, {})
  const data = { appType: 'a', formUuid: 'b', formDataJson: '{}' }
  const invalid = { code: 'YIDA_SEND_BUDGET_INVALID', message: 'YIDA_SEND_BUDGET_INVALID' }
  assert.equal(budget.assessYidaSendBudget({ snapshot, data }).withinBudget, true)
  for (const input of [null, [], { snapshot }, { data }, { snapshot, data, extra: 1 },
    { snapshot: { ...snapshot, systemToken: 'x' }, data }, { snapshot: { ...snapshot, userId: 'x' }, data },
    { snapshot, data: { ...data, systemToken: 'x' } }, { snapshot, data: { appType: 'a', formUuid: 'b' } },
    { snapshot, data: { ...data, formDataJson: 1 } }, { snapshot: new Proxy(snapshot, {}), data },
    { snapshot, data: Object.defineProperty({ appType: 'a', formUuid: 'b' }, 'formDataJson', { enumerable: true, get: () => '{}' }) }]) {
    assert.throws(() => budget.assessYidaSendBudget(input), invalid)
  }
  // A structurally unbounded snapshot is over budget, not an error.
  let deep = {}
  for (let i = 0; i < 13; i += 1) deep = { deep }
  assert.equal(budget.assessYidaSendBudget({ snapshot: { ...snapshot, config: deep }, data }).withinBudget, false)
  assert.equal(budget.assessYidaSendBudget({ snapshot: { ...snapshot, config: Array.from({ length: 4097 }, () => 0) }, data }).withinBudget, false)
})
