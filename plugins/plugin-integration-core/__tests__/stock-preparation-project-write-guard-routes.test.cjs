'use strict'

// Batch-refresh phase 0 step 1 — the ROUTE wiring of the project write lock (lib/http-routes.cjs), on the
// shared project-sheet substrate (support/stock-preparation-project-sheet-harness.cjs) with an
// inspectable in-memory lock (support/stock-preparation-project-write-lock-kit.cjs):
//
//   R1  a busy project refuses apply 409 WRITE_LOCKED BEFORE the B2a fence, the credential / adapter
//       load and the token claim (the token is still stored); the source scan pins the order.
//   R2  a preview of a project being written is refused 409 before any source read — sync and job lane.
//   R3  no lock service: apply 501 with zero IO; the dry-run still answers, with an UNBOUND token.
//   R4  the status / code table, and the pull-outcome stamp (`refused`, or `failed` once rows landed).
//   R5  the lease is released after success and after every error path.
//
// Every value here is synthetic.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const harness = require(path.join(__dirname, 'support', 'stock-preparation-project-sheet-harness.cjs'))
const kit = require(path.join(__dirname, 'support', 'stock-preparation-project-write-lock-kit.cjs'))
const { STOCK_PREP_OPERATE, STOCK_PREP_PULL, STOCK_PREP_READ } = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { PLM_STOCK_PREPARATION_ACTION_ID } = require(path.join(LIB, 'stock-preparation-table-actions.cjs'))
const {
  PROJECT_WRITE_ERROR_CODES,
  PROJECT_WRITE_LOCK_TABLE,
  projectWriteScopeKey,
} = require(path.join(LIB, 'stock-preparation-project-write-lock.cjs'))

const tests = []
const test = (name, fn) => tests.push([name, fn])

const TENANT = 'tenant-swl-routes'
const PROJECT = 'SYN-SWL-0005'
const DRY_RUN_PATH = '/api/integration/table-actions/:actionId/dry-run'
const JOBS_PATH = '/api/integration/table-actions/:actionId/dry-run-jobs'
const APPLY_PATH = '/api/integration/table-actions/:actionId/apply'
const PULLER = Object.freeze({ id: 'u_swl_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })

// The project-sheet mount with (a) an inspectable lock (or none) and (b) counters on the two
// identity-bearing source steps, so "before the adapter load" is observable.
function mount({ lock = 'memory' } = {}) {
  const env = lock === 'memory' ? kit.createInMemoryProjectWriteLock({ timers: 'real' }) : null
  const loads = []
  const system = (input = {}) => ({
    id: input.id,
    tenantId: input.tenantId,
    name: 'Readonly PLM SQL (synthetic)',
    kind: 'data-source:sql-readonly',
    role: 'source',
    status: 'active',
    config: { dataSourceId: 'ds_synthetic', object: 'DN_PDM_PathExAttrInfo' },
  })
  const inert = (name) => async () => { throw new Error(`unexpected service call: ${name}`) }
  const holder = { adapter: null }
  const h = harness.mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    switchOn: true,
    serviceExtras: {
      stockPreparationProjectWriteLock: env ? env.lock : null,
      externalSystemRegistry: {
        upsertExternalSystem: inert('upsertExternalSystem'),
        deleteExternalSystem: inert('deleteExternalSystem'),
        listExternalSystems: inert('listExternalSystems'),
        async getExternalSystem(input = {}) { return system(input) },
        async getExternalSystemForAdapter(input = {}) {
          loads.push(input.tenantId || null)
          return { ...system(input), credentials: {} }
        },
      },
      adapterRegistry: {
        createAdapter() { return holder.adapter },
        listAdapterKinds() { return [] },
      },
    },
  })
  holder.adapter = h.source.adapter
  h.env = env
  h.loads = loads
  return h
}

const call = (h, method, routePath, { body, query = { tenantId: TENANT } } = {}) =>
  harness.call(h.routes, method, routePath, { user: PULLER, params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID }, body, query })
const dryRun = (h) => call(h, 'POST', DRY_RUN_PATH, { body: { parameters: { projectNo: PROJECT } } })
const startJob = (h) => call(h, 'POST', JOBS_PATH, { body: { parameters: { projectNo: PROJECT } } })
const apply = (h, token) => call(h, 'POST', APPLY_PATH, { body: { parameters: { projectNo: PROJECT }, confirm: { dryRunToken: token } } })
const lockRow = (h, scope) => h.env.db.rows(PROJECT_WRITE_LOCK_TABLE).find((row) => row.scope_key === scope) || null
const registryRow = (h) => h.registryRows().find((row) => row.project_no === PROJECT)
const writes = (h) => h.records.calls.filter((c) => c[0] === 'createRecord' || c[0] === 'patchRecord')

function seeded(h) {
  const { sheetId } = h.seedRegistryRow(PROJECT)
  return projectWriteScopeKey(sheetId, PROJECT)
}

function errorOf(res) {
  return res.body && res.body.error ? res.body.error : {}
}

// ── R1 ────────────────────────────────────────────────────────────────────────────────────────────
test('R1 a busy project refuses apply 409 WRITE_LOCKED before the B2a fence, the adapter load and the token claim', async () => {
  const h = mount()
  try {
    const scope = seeded(h)
    const dry = await dryRun(h)
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
    const loadsAfterDry = h.loads.length
    const holder = await h.env.lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-other-run' })
    const refused = await apply(h, dry.body.data.dryRunToken)
    assert.equal(refused.statusCode, 409, JSON.stringify(refused.body))
    assert.equal(errorOf(refused).code, PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
    assert.equal(errorOf(refused).details.holderPurpose, 'small_apply')
    assert.equal(h.loads.length, loadsAfterDry, 'no credential / adapter load')
    assert.equal(h.context.storage.size, 1, 'the token was not claimed')
    assert.equal(writes(h).length, 0)
    await h.env.lock.createGuard(holder).release()
    const ok = await apply(h, dry.body.data.dryRunToken)
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.data.status, 'succeeded')
  } finally { h.restore() }
})

test('R1 source order in tableActionApply: lease acquired after the tenant wall and before the B2a fence, the adapter load and the lib call', () => {
  const code = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const start = code.indexOf('    async tableActionApply(req, res) {')
  const body = code.slice(start, code.indexOf('\n    },', start))
  const at = (needle) => {
    const i = body.indexOf(needle)
    assert.notEqual(i, -1, `tableActionApply contains ${needle}`)
    return i
  }
  const lease = at('withProjectWriteLease(')
  assert.ok(at('assertResolvedProjectTargetTenancy(') < at('requireStockPreparationProjectWriteLock()'), 'the lock is required after the tenant wall')
  for (const later of ['assertB2aStockPreparationReadAuthorized(', 'loadTableActionSourceAdapter(', 'applyStockPreparationAction(', 'projectWriteGuard,']) {
    assert.ok(lease < at(later), `the lease is acquired before ${later}`)
  }
  assert.ok(at('if (applyFailure) {') > at('applyStockPreparationAction('), 'the outcome stamp runs after the lease callback')
})

// ── R2 ────────────────────────────────────────────────────────────────────────────────────────────
test('R2 a preview of a project being written is refused 409 before any source read — sync and job lane; the slot is freed', async () => {
  const h = mount()
  try {
    const scope = seeded(h)
    const holder = await h.env.lock.acquire(scope, { purpose: 'small_apply', runId: 'swl-other-run' })
    const sync = await dryRun(h)
    assert.equal(sync.statusCode, 409, JSON.stringify(sync.body))
    assert.equal(errorOf(sync).code, PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
    const job = await startJob(h)
    assert.equal(job.statusCode, 409, JSON.stringify(job.body))
    assert.equal(errorOf(job).code, PROJECT_WRITE_ERROR_CODES.WRITE_LOCKED)
    assert.equal(h.source.calls.length, 0, 'zero PLM reads')
    assert.deepEqual(h.loads, [], 'zero credential loads')
    assert.equal(lockRow(h, scope).generation, 0, 'nothing was bumped')
    await h.env.lock.createGuard(holder).release()
    const again = await dryRun(h)
    assert.equal(again.statusCode, 200, JSON.stringify(again.body))
    assert.equal(lockRow(h, scope).generation, 1, 'the applicable preview bumped once')
  } finally { h.restore() }
})

// ── R3 ────────────────────────────────────────────────────────────────────────────────────────────
test('R3 no lock service: apply 501 with zero IO; the dry-run still answers, with an UNBOUND token', async () => {
  const h = mount({ lock: null })
  try {
    seeded(h)
    const dry = await dryRun(h)
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body))
    const record = Array.from(h.context.storage.values()).find((value) => value && value.revision)
    assert.ok(record, 'a token record was stored')
    assert.equal(Object.prototype.hasOwnProperty.call(record, 'writeScope'), false, 'unbound')
    const loads = h.loads.length
    const refused = await apply(h, dry.body.data.dryRunToken)
    assert.equal(refused.statusCode, 501, JSON.stringify(refused.body))
    assert.equal(errorOf(refused).code, PROJECT_WRITE_ERROR_CODES.UNAVAILABLE)
    assert.equal(h.loads.length, loads, 'zero adapter loads')
    assert.equal(writes(h).length, 0)
  } finally { h.restore() }
})

// ── R4 / R5 ───────────────────────────────────────────────────────────────────────────────────────
test('R4/R5 status-code table + outcome stamps; the lease is released after success and after every error path', async () => {
  // PLAN_SUPERSEDED: two previews, apply the first.
  {
    const h = mount()
    try {
      const scope = seeded(h)
      const first = await dryRun(h)
      const second = await dryRun(h)
      const refused = await apply(h, first.body.data.dryRunToken)
      assert.equal(refused.statusCode, 409)
      assert.equal(errorOf(refused).code, PROJECT_WRITE_ERROR_CODES.PLAN_SUPERSEDED)
      assert.equal(errorOf(refused).details.reason, 'newer_plan')
      assert.equal(registryRow(h).last_pull_outcome, 'refused')
      assert.equal(lockRow(h, scope).lease_id, null, 'released after PLAN_SUPERSEDED')
      const ok = await apply(h, second.body.data.dryRunToken)
      assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
      assert.equal(lockRow(h, scope).lease_id, null, 'released after success')
      assert.equal(registryRow(h).last_pull_outcome, 'applied')
    } finally { h.restore() }
  }
  // STORE_FAILED on acquire: 503, nothing read.
  {
    const h = mount()
    try {
      seeded(h)
      const dry = await dryRun(h)
      const loads = h.loads.length
      h.env.db.faults.selectOne = Object.assign(new Error('relation missing'), { code: '42P01' })
      const refused = await apply(h, dry.body.data.dryRunToken)
      assert.equal(refused.statusCode, 503, JSON.stringify(refused.body))
      assert.equal(errorOf(refused).code, PROJECT_WRITE_ERROR_CODES.STORE_FAILED)
      assert.equal(h.loads.length, loads)
      assert.equal(h.context.storage.size >= 1, true, 'token not claimed')
    } finally { h.restore() }
  }
  // STORE_FAILED mid-run after one row landed: 503, partial, stamped `failed`, lease released.
  {
    const h = mount()
    try {
      const scope = seeded(h)
      // A two-row plan (assembly + child), so the run can stop AFTER its first write.
      h.source.adapter.read = kit.createSourceAdapter(kit.goldenPlmData(PROJECT)).adapter.read
      const dry = await dryRun(h)
      assert.equal(dry.body.data.counts.add, 2, 'calibration: two writes planned')
      let holderCas = 0
      h.env.db.faults.updateRow = (args) => {
        if (args.set && Object.prototype.hasOwnProperty.call(args.set, 'lease_seq') && !Object.prototype.hasOwnProperty.call(args.set, 'lease_id')) {
          holderCas += 1
          if (holderCas === 2) return new Error('connection lost')
        }
        return null
      }
      const refused = await apply(h, dry.body.data.dryRunToken)
      assert.equal(refused.statusCode, 503, JSON.stringify(refused.body))
      assert.equal(errorOf(refused).code, PROJECT_WRITE_ERROR_CODES.STORE_FAILED)
      assert.equal(errorOf(refused).details.partial, true)
      assert.equal(errorOf(refused).details.written, 1)
      assert.equal(writes(h).length, 1)
      assert.equal(registryRow(h).last_pull_outcome, 'failed', 'rows landed: a failed pull, not a refusal')
      delete h.env.db.faults.updateRow
      assert.equal(lockRow(h, scope).lease_id, null, 'released after a fenced stop')
    } finally { h.restore() }
  }
  // An ordinary lib refusal (token missing) inside the lease: released.
  {
    const h = mount()
    try {
      const scope = seeded(h)
      await dryRun(h)
      const refused = await apply(h, '')
      assert.equal(refused.statusCode, 400)
      assert.equal(errorOf(refused).code, 'TABLE_ACTION_DRY_RUN_TOKEN_REQUIRED')
      assert.equal(lockRow(h, scope).lease_id, null, 'released after a lib refusal')
    } finally { h.restore() }
  }
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-project-write-guard-routes.test.cjs', tests, { passLine: '✓ stock-preparation-project-write-guard-routes' })
