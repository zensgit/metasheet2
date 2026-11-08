'use strict'

// 批次标识 BI-7 — THE PULL-BATCH SETTINGS ROUTES (batch-identifier design §5.5 / §7.1 / §11; coordinator rulings C2 / C6 /
// C7 / C8 / C10 / C12; register R-65), over the real route stack (support/stock-preparation-project-sheet-harness.cjs:
// the REAL registry store on its memory db with its real per-tenant lock) with the REAL pull-batch ledger store and the
// REAL audit store on ONE fake of migration 105 (support/stock-preparation-pull-batch-kit.cjs) — plus, built here by
// hand, the audit table of migration 066 whose action CHECK is the audit store's closed vocabulary — so a throw inside
// the store's transaction really rolls the setting AND its audit row back.
//
//   SR-01 SWITCHES OFF (C6): the pull-batch switch off, the project-sheets switch off, both, or a near-miss literal
//         ('TRUE', ' true', '1') => all three routes 404 STOCK_PREP_PULL_BATCH_SETTINGS_DISABLED for both admins with
//         ZERO IO (no ledger statement, no registry statement, no scope lookup, no audit row) — before the 501 a
//         missing store would answer; below ADMIN the gate refuses first
//   SR-02 THE TIERS: anonymous, a bare login, read-only, the floor, the puller and the two orphans are refused at the
//         gate with zero IO; stock-prep:admin and the platform admin pass; a tenantless platform admin, a contradicted
//         carried tenant and a steering query are refused by the operator scope before any ledger read
//   SR-03 GET: no tenant row => built_in / version 0 / builtIn = the 10-27 design; vocabulary, fixed facts, locks, the
//         sheet keys and the help copy (C10's rule-F caveat) are the modules' own; one row per REGISTERED sheet with its
//         captured values (null = 「安装时采用」), locks and `may.set` (active ∧ captured ∧ unlocked only); a ledger row
//         with no registry row is counted, never listed; no audit row; a store without its ledger 501
//   SR-04 THE TENANT BODY, PURE: unknown keys (the removed C2 keys among them), out-of-vocabulary / folded values, an
//         empty patch, a bad expectedVersion => 400 CONFIG_INVALID naming the field only, with ZERO IO (not even the
//         scope lookup) and no echo of the value
//   SR-05 THE TENANT WRITE: v0 -> v1 with exactly ONE audit row (`project_fields_update`, mode
//         pull_batch_settings_tenant_updated, project_id NULL, subject_id NULL, the flat depth-1 detail); a stale
//         version 409 SETTINGS_VERSION_CONFLICT with nothing written; the no-op 200 written:false with no write / audit
//   SR-06 ATOMICITY (C8): a failing audit insert rolls the setting back (the answer is the error, the row is unchanged);
//         an audit store without appendWithin is 501 before any statement; a database whose action CHECK lacks 088's
//         action is 503 before the write
//   SR-07 THE PER-SHEET EDIT: the pure refusals (confirm mismatch, landing / placement, an invalid path number) with zero
//         IO; ABSENT / ARCHIVED 409 with no ledger statement; a registered sheet with no ledger row 409 NOT_CAPTURED;
//         the success (version + 1, ONE audit row with project_id = the path number, subject_id = the registry sheet,
//         NO project number in the detail); a locked sheet 409 CONFIG_LOCKED { locked: ['firstPullBatchRule'] } with no
//         write, and the captured value repeated on it 200 written:false; a stale version 409; an archive committing
//         between the read and the lock is refused by the locked re-check in the route's own words
//   SR-08 a tenant edit never moves a captured sheet (byte-equal before and after)
//   SR-09 VALUES: across every answer and audit row of the suite, the project number appears only in the GET's
//         sheets[*].projectNo, the per-sheet answer and the audit row's project_id — never in a detail, mode, subject
//         or an error
//   SR-10 CALL SITES (text): each handler reads the switches before the operator scope; no audit mode is respelled in
//         http-routes.cjs or the helper; the helper's confirm code is the route file's
//
// Synthetic values only.

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const LIB = path.join(__dirname, '..', 'lib')
const projectSheet = require(path.join(__dirname, 'support', 'stock-preparation-project-sheet-harness.cjs'))
const kit = require(path.join(__dirname, 'support', 'stock-preparation-pull-batch-kit.cjs'))
const {
  STOCK_PREP_ADMIN,
  STOCK_PREP_OPERATE,
  STOCK_PREP_PULL,
  STOCK_PREP_READ,
} = require(path.join(LIB, 'stock-preparation-workbench-access.cjs'))
const { PROJECT_SHEETS_ENABLED_ENV } = require(path.join(LIB, 'stock-preparation-project-targets.cjs'))
const PB = require(path.join(LIB, 'stock-preparation-pull-batch.cjs'))
const ST = require(path.join(LIB, 'stock-preparation-pull-batch-store.cjs'))
const { STOCK_PREP_PULL_BATCH_ENABLED_ENV } = require(path.join(LIB, 'stock-preparation-pull-batch-lanes.cjs'))
const SETTINGS = require(path.join(LIB, 'stock-preparation-pull-batch-settings.cjs'))
const AUDIT = require(path.join(LIB, 'stock-preparation-audit-store.cjs'))

const TENANT = 'tenant-pbs-syn'
const OTHER_TENANT = 'tenant-pbs-syn-foreign'
const PROJECT = 'PRJ-PBS-01'
const ARCHIVED_PROJECT = 'PRJ-PBS-02'
const UNCAPTURED_PROJECT = 'PRJ-PBS-03'
const UNREGISTERED_PROJECT = 'PRJ-PBS-09'
const SETTINGS_PATH = '/api/integration/stock-preparation/pull-batch/settings'
const SHEET_PATH = '/api/integration/stock-preparation/projects/:projectNo/target/pull-batch/settings'
const DISABLED = 'STOCK_PREP_PULL_BATCH_SETTINGS_DISABLED'

const ANONYMOUS = undefined
const LOGGED_IN = Object.freeze({ id: 'u_pbs_plain', tenantId: TENANT, permissions: [] })
const READ_ONLY = Object.freeze({ id: 'u_pbs_read', tenantId: TENANT, permissions: [STOCK_PREP_READ] })
const FLOOR = Object.freeze({ id: 'u_pbs_floor', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE] })
const PULLER = Object.freeze({ id: 'u_pbs_pull', tenantId: TENANT, permissions: [STOCK_PREP_READ, STOCK_PREP_OPERATE, STOCK_PREP_PULL] })
const PULL_ORPHAN = Object.freeze({ id: 'u_pbs_pull_orphan', tenantId: TENANT, permissions: [STOCK_PREP_PULL] })
const OPERATE_ORPHAN = Object.freeze({ id: 'u_pbs_op_orphan', tenantId: TENANT, permissions: [STOCK_PREP_OPERATE] })
const WORKBENCH_ADMIN = Object.freeze({ id: 'u_pbs_wb', tenantId: TENANT, permissions: [STOCK_PREP_ADMIN] })
const PLATFORM_ADMIN = Object.freeze({ id: 'u_pbs_admin', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] })
const TENANTLESS_PLATFORM_ADMIN = Object.freeze({ id: 'u_pbs_root', roles: ['admin'], permissions: ['integration:admin'] })

const BELOW_ADMIN = [
  ['anonymous', ANONYMOUS], ['logged-in', LOGGED_IN], ['read-only', READ_ONLY], ['floor', FLOOR], ['puller', PULLER],
  ['pull-orphan', PULL_ORPHAN], ['operate-orphan', OPERATE_ORPHAN],
]
const ADMINS = [['workbench-admin', WORKBENCH_ADMIN], ['platform-admin', PLATFORM_ADMIN]]

// ── the substrate ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Migration 066's audit table, added BY HAND to the pull-batch kit's fake (the kit parses 105 only): the 066 columns,
 * the action CHECK as the audit store's closed vocabulary (which the audit-migration suite pins SET-EQUAL to migration
 * 101's CHECK) under the constraint name the store's vocabulary probe recognizes. It joins the kit's snapshot /
 * rollback, so a throw inside the store's transaction removes the audit row with the setting.
 */
function addAuditTable(db) {
  const column = (type, { notNull = false, primaryKey = false, def } = {}) => ({ type, notNull: notNull || primaryKey, primaryKey, default: def })
  db.schema[AUDIT.AUDIT_TABLE] = {
    columns: {
      id: column('TEXT', { primaryKey: true }),
      tenant_id: column('TEXT', { notNull: true }),
      workspace_id: column('TEXT'),
      project_id: column('TEXT'),
      action: column('TEXT', { notNull: true }),
      subject_id: column('TEXT'),
      mode: column('TEXT'),
      actor: column('TEXT'),
      detail: column('JSONB', { notNull: true }),
      created_at: column('TIMESTAMPTZ', { notNull: true, def: { kind: 'now' } }),
    },
    enums: [{ name: 'integration_stock_prep_audit_action_check', column: 'action', values: [...AUDIT.STOCK_PREP_AUDIT_ACTIONS], nullable: false }],
  }
  db.tables.set(AUDIT.AUDIT_TABLE, new Map())
}

const restoreEnv = []
function setEnv(key, value) {
  const previous = process.env[key]
  restoreEnv.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous })
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}
function resetEnv() {
  while (restoreEnv.length) restoreEnv.pop()()
}

/**
 * One mount: the route stack (project-sheets switch per `projectSheets`), the pull-batch switch per `pullBatch`, the
 * REAL ledger store (unless `store: false`) and the REAL audit store patched IN PLACE into the service object the routes
 * captured at mount (the harness's documented seam) — both on one kit db.
 */
function mount(options = {}) {
  // An explicit `undefined` means "unset" (a default parameter would turn it into 'true').
  const pullBatch = Object.prototype.hasOwnProperty.call(options, 'pullBatch') ? options.pullBatch : 'true'
  const projectSheets = Object.prototype.hasOwnProperty.call(options, 'projectSheets') ? options.projectSheets : 'true'
  const store = options.store !== false
  const clock = kit.createClock('2026-11-07T01:00:00.000Z')
  const db = kit.createFakePullBatchDb({ clock })
  addAuditTable(db)
  let n = 0
  const ledger = ST.createStockPreparationPullBatchStore({ db, now: clock.now, idGenerator: (kind) => `pb${kind}_syn_${(n += 1)}` })
  const h = projectSheet.mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    switchOn: true,
    serviceExtras: store ? { stockPreparationPullBatchStore: ledger } : {},
  })
  let a = 0
  const audit = AUDIT.createStockPreparationAuditStore({ db, idGenerator: () => `aud_syn_${(a += 1)}` })
  Object.assign(h.services.stockPreparationAuditStore, audit)
  // The harness reads its switch at mount; the routes read both switches PER REQUEST — set them for this test.
  setEnv(PROJECT_SHEETS_ENABLED_ENV, projectSheets)
  setEnv(STOCK_PREP_PULL_BATCH_ENABLED_ENV, pullBatch)
  // The harness's fake host derives long readable sheet ids; the REAL host's are `sheet_<24 hex>` (provisioning.ts
  // stableMetaId), the shape the audit store's subject gate admits. Registered rows are re-keyed to that shape.
  const seedRegistryRow = h.seedRegistryRow
  h.seedRegistryRow = (projectNo, opts = {}) => {
    const seeded = seedRegistryRow(projectNo, opts)
    const sheetId = `sheet_${crypto.createHash('sha1').update(`${opts.tenant || TENANT}:${projectNo}`).digest('hex').slice(0, 24)}`
    const row = h.db.rowsOf(projectSheet.PROJECT_TARGET_TABLE).find((entry) => entry.project_no === projectNo && entry.tenant_id === (opts.tenant || TENANT))
    row.sheet_id = sheetId
    return { ...seeded, sheetId }
  }
  return Object.assign(h, { ledgerDb: db, ledger, clock })
}

function auditRows(h) {
  return h.ledgerDb.rows(AUDIT.AUDIT_TABLE)
}

let seededLedgerRows = 0
/** A `_sheet` row as BI-2's install / birth writes it (the kit's shape), straight into the fake. */
function seedLedger(h, { projectNo = PROJECT, sheetId, tenant = TENANT, ...over } = {}) {
  seededLedgerRows += 1
  return h.ledgerDb.seed(kit.T.sheet, kit.sheetRow({ id: `pbs_syn_${seededLedgerRows}`, tenantId: tenant, sheetId, projectNo, ...over }))
}

function ledgerSheet(h, sheetId, projectNo = PROJECT) {
  return h.ledgerDb.rows(kit.T.sheet).find((row) => row.sheet_id === sheetId && row.project_no === projectNo) || null
}

function clearLogs(h) {
  h.ledgerDb.log.length = 0
  h.db.calls.length = 0
  h.tenantDirectoryCalls.length = 0
  h.provisioning.calls.length = 0
}

function readSettings(h, user, { query = { tenantId: TENANT }, authenticatedTenantId } = {}) {
  return projectSheet.call(h.routes, 'GET', SETTINGS_PATH, { user, query, ...(authenticatedTenantId !== undefined ? { authenticatedTenantId } : {}) })
}

function setTenant(h, user, body, { authenticatedTenantId } = {}) {
  return projectSheet.call(h.routes, 'POST', SETTINGS_PATH, { user, body, ...(authenticatedTenantId !== undefined ? { authenticatedTenantId } : {}) })
}

function setSheet(h, user, body, { projectNo = PROJECT, authenticatedTenantId } = {}) {
  return projectSheet.call(h.routes, 'POST', SHEET_PATH, { user, params: { projectNo }, body, ...(authenticatedTenantId !== undefined ? { authenticatedTenantId } : {}) })
}

const allThree = (h, user) => [
  ['GET settings', () => readSettings(h, user)],
  ['POST settings', () => setTenant(h, user, { expectedVersion: 0, firstPullBatchRule: 'predecessor_suffix' })],
  ['POST sheet settings', () => setSheet(h, user, { confirmProjectNo: PROJECT, expectedVersion: 0, firstPullBatchRule: 'predecessor_suffix' })],
]

function assertNoIo(h, label) {
  assert.deepEqual(h.ledgerDb.log, [], `${label}: no ledger / audit statement`)
  assert.deepEqual(h.db.calls, [], `${label}: no registry statement`)
  assert.deepEqual(h.tenantDirectoryCalls, [], `${label}: not even the scope lookup`)
  assert.deepEqual(h.provisioning.calls, [], `${label}: no host call`)
  assert.deepEqual(auditRows(h), [], `${label}: no audit row`)
}

// Every answer body the suite saw, for SR-09.
const SEEN = []
function seen(label, res) {
  SEEN.push({ label, body: res.body })
  return res
}

const tests = []
const test = (name, fn) => tests.push([name, async () => {
  try { await fn() } finally { resetEnv() }
}])

// ── SR-01 ─────────────────────────────────────────────────────────────────────────────────────────────

test('SR-01 switches off (C6): 404 SETTINGS_DISABLED with zero IO for both admins, before the store-unavailable 501; below ADMIN the gate refuses first; only the exact literal is on', async () => {
  const offShapes = [
    { pullBatch: undefined, projectSheets: 'true' },
    { pullBatch: 'true', projectSheets: undefined },
    { pullBatch: undefined, projectSheets: undefined },
    { pullBatch: 'TRUE', projectSheets: 'true' },
    { pullBatch: ' true', projectSheets: 'true' },
    { pullBatch: 'true ', projectSheets: 'true' },
    { pullBatch: '1', projectSheets: 'true' },
    { pullBatch: 'true', projectSheets: 'TRUE' },
  ]
  for (const shape of offShapes) {
    for (const store of [true, false]) {
      const h = mount({ ...shape, store })
      try {
        h.seedRegistryRow(PROJECT)
        clearLogs(h)
        for (const [actorName, user] of ADMINS) {
          for (const [route, run] of allThree(h, user)) {
            const res = seen(`SR-01 ${route}`, await run())
            const label = `${JSON.stringify(shape)} store=${store} ${actorName} ${route}`
            assert.equal(res.statusCode, 404, `${label}: ${JSON.stringify(res.body)}`)
            assert.equal(res.body.error.code, DISABLED, label)
            assertNoIo(h, label)
          }
        }
        for (const [actorName, user] of BELOW_ADMIN) {
          for (const [route, run] of allThree(h, user)) {
            const res = await run()
            assert.equal(res.statusCode, user === undefined ? 401 : 403, `${actorName} ${route}: the gate first`)
            assertNoIo(h, `${actorName} ${route}`)
          }
        }
      } finally { h.restore() }
    }
  }
  // The off answer names both switches' rule without a value; the store-absent answer with both on is the 501.
  const h = mount({ store: false })
  try {
    h.seedRegistryRow(PROJECT)
    clearLogs(h)
    for (const [route, run] of allThree(h, WORKBENCH_ADMIN)) {
      const res = await run()
      assert.equal(res.statusCode, 501, `${route}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, SETTINGS.STOCK_PREP_PULL_BATCH_STORE_UNAVAILABLE_CODE)
    }
    assert.deepEqual(h.ledgerDb.log.filter(([method]) => !method.startsWith('trx.') && method !== 'transaction' && method !== 'commit' && method !== 'rollback'), [], 'no ledger statement without a store')
    assert.deepEqual(auditRows(h), [])
  } finally { h.restore() }
})

// ── SR-02 ─────────────────────────────────────────────────────────────────────────────────────────────

test('SR-02 the tiers: below ADMIN refused at the gate with zero IO; both admins pass; the operator scope refuses a tenantless admin, a contradicted claim and a steering query before any ledger read', async () => {
  const h = mount()
  try {
    h.seedRegistryRow(PROJECT)
    clearLogs(h)
    for (const [actorName, user] of BELOW_ADMIN) {
      for (const [route, run] of allThree(h, user)) {
        const res = await run()
        assert.equal(res.statusCode, user === undefined ? 401 : 403, `${actorName} ${route}`)
        assertNoIo(h, `${actorName} ${route}`)
      }
    }
    for (const [actorName, user] of ADMINS) {
      const res = seen('SR-02 GET', await readSettings(h, user))
      assert.equal(res.statusCode, 200, `${actorName}: ${JSON.stringify(res.body)}`)
    }
    clearLogs(h)
    const refusals = [
      ['tenantless platform admin GET', () => readSettings(h, TENANTLESS_PLATFORM_ADMIN, { query: {} }), 'OPERATOR_SCOPE_TENANT_REQUIRED'],
      ['tenantless platform admin POST', () => setTenant(h, TENANTLESS_PLATFORM_ADMIN, { expectedVersion: 0, labelFormat: 'ordinal' }), 'OPERATOR_SCOPE_TENANT_REQUIRED'],
      ['tenantless platform admin sheet POST', () => setSheet(h, TENANTLESS_PLATFORM_ADMIN, { confirmProjectNo: PROJECT, expectedVersion: 0, labelFormat: 'ordinal' }), 'OPERATOR_SCOPE_TENANT_REQUIRED'],
      ['contradicted claim GET', () => readSettings(h, WORKBENCH_ADMIN, { authenticatedTenantId: OTHER_TENANT }), 'OPERATOR_SCOPE_TENANT_CONTRADICTED'],
      ['contradicted claim POST', () => setTenant(h, WORKBENCH_ADMIN, { expectedVersion: 0, labelFormat: 'ordinal' }, { authenticatedTenantId: OTHER_TENANT }), 'OPERATOR_SCOPE_TENANT_CONTRADICTED'],
      ['contradicted claim sheet POST', () => setSheet(h, WORKBENCH_ADMIN, { confirmProjectNo: PROJECT, expectedVersion: 0, labelFormat: 'ordinal' }, { authenticatedTenantId: OTHER_TENANT }), 'OPERATOR_SCOPE_TENANT_CONTRADICTED'],
      ['steering query GET', () => readSettings(h, WORKBENCH_ADMIN, { query: { tenantId: OTHER_TENANT } }), 'OPERATOR_SCOPE_TENANT_MISMATCH'],
    ]
    for (const [label, run, code] of refusals) {
      const res = await run()
      assert.equal(res.statusCode, 403, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, code, label)
    }
    assert.deepEqual(h.ledgerDb.log, [], 'a scope refusal costs no ledger statement')
    assert.deepEqual(h.db.calls, [], 'a scope refusal costs no registry statement')
    assert.deepEqual(auditRows(h), [])
  } finally { h.restore() }
})

// ── SR-03 ─────────────────────────────────────────────────────────────────────────────────────────────

test('SR-03 GET: the built-in default, the modules\' vocabulary / facts / locks / help, one row per registered sheet with its captured values and locks; unregistered ledger rows counted; no audit row', async () => {
  const h = mount()
  try {
    const active = h.seedRegistryRow(PROJECT)
    const archived = h.seedRegistryRow(ARCHIVED_PROJECT, { archived: true })
    const uncaptured = h.seedRegistryRow(UNCAPTURED_PROJECT)
    seedLedger(h, { projectNo: PROJECT, sheetId: active.sheetId, rule: 'material', labelFormat: 'ordinal_date', placement: 'left', landing: null })
    seedLedger(h, { projectNo: ARCHIVED_PROJECT, sheetId: archived.sheetId, rule: 'predecessor_suffix', labelFormat: 'ordinal', placement: 'right', landing: 'keep_current', status: 'backfilled', locale: 'en' })
    seedLedger(h, { projectNo: UNREGISTERED_PROJECT, sheetId: 'sheet_syn_unregistered' })
    seedLedger(h, { projectNo: PROJECT, sheetId: 'sheet_syn_foreign_tenant', tenant: OTHER_TENANT })
    clearLogs(h)
    const res = seen('SR-03 GET', await readSettings(h, WORKBENCH_ADMIN))
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    const data = res.body.data
    assert.deepEqual(data.tenant, { settings: { ...PB.DEFAULT_PULL_BATCH_CONFIG }, source: 'built_in', version: 0 })
    assert.deepEqual(data.builtIn, { ...PB.DEFAULT_PULL_BATCH_CONFIG })
    assert.deepEqual(data.builtIn, { firstPullBatchRule: 'material', labelFormat: 'ordinal_date', landing: 'promote_prep_fill', placement: 'left' }, 'the 10-27 design')
    assert.deepEqual(data.vocabulary, JSON.parse(JSON.stringify(PB.PULL_BATCH_CONFIG_VALUES)))
    assert.deepEqual(data.fixedFacts, { ...PB.PULL_BATCH_FIXED_FACTS })
    assert.deepEqual(data.locks, { ...PB.PULL_BATCH_CONFIG_LOCKS })
    assert.deepEqual(data.sheetKeys, [...ST.PULL_BATCH_SHEET_SETTING_KEYS])
    assert.deepEqual(data.help, JSON.parse(JSON.stringify(PB.PULL_BATCH_SETTINGS_HELP)))
    assert.match(data.help.firstPullBatchRule.predecessor_suffix['zh-CN'], /今天的「有效」状态/, 'C10: the rule-F caveat comes from the module')
    assert.deepEqual(data.may, { setTenant: true })
    assert.equal(data.unregisteredLedgerRowCount, 1, 'the unregistered project is counted (the other tenant\'s row is not this tenant\'s at all)')
    assert.deepEqual(data.sheets.map((row) => row.projectNo), [PROJECT, ARCHIVED_PROJECT, UNCAPTURED_PROJECT], 'registry order; never the unregistered project')
    const [a, b, c] = data.sheets
    assert.deepEqual(a, {
      projectNo: PROJECT,
      sheetId: active.sheetId,
      registryStatus: 'active',
      captured: { firstPullBatchRule: 'material', labelFormat: 'ordinal_date', landing: null, placement: 'left' },
      labelLocale: 'zh-CN',
      historyStatus: 'born_empty',
      locks: { firstPullBatchRule: false, labelFormat: false, landing: false, placement: true },
      lockedAt: null,
      version: 0,
      may: { set: true },
    })
    assert.equal(b.registryStatus, 'archived')
    assert.deepEqual(b.captured, { firstPullBatchRule: 'predecessor_suffix', labelFormat: 'ordinal', landing: 'keep_current', placement: 'right' })
    assert.deepEqual(b.locks, { firstPullBatchRule: true, labelFormat: true, landing: true, placement: true })
    assert.equal(typeof b.lockedAt, 'string')
    assert.equal(b.labelLocale, 'en')
    assert.deepEqual(b.may, { set: false }, 'archived (and locked): no edit')
    assert.deepEqual(c, {
      projectNo: UNCAPTURED_PROJECT, sheetId: uncaptured.sheetId, registryStatus: 'active', captured: null, labelLocale: null,
      historyStatus: null, locks: null, lockedAt: null, version: null, may: { set: false },
    })
    assert.deepEqual(auditRows(h), [], 'a read writes no audit row')
    assert.ok(!h.ledgerDb.log.some(([method]) => /insertOne|updateRow/.test(method)), 'reads only')
    // A tenant row once written answers as itself.
    const written = await setTenant(h, WORKBENCH_ADMIN, { expectedVersion: 0, placement: 'right' })
    assert.equal(written.statusCode, 200, JSON.stringify(written.body))
    const again = seen('SR-03 GET (tenant)', await readSettings(h, WORKBENCH_ADMIN))
    assert.deepEqual(again.body.data.tenant, { settings: { ...PB.DEFAULT_PULL_BATCH_CONFIG, placement: 'right' }, source: 'tenant', version: 1 })
  } finally { h.restore() }
})

// ── SR-04 ─────────────────────────────────────────────────────────────────────────────────────────────

test('SR-04 the tenant body, pure: unknown keys, removed C2 keys, out-of-vocabulary or folded values, an empty patch and a bad version are 400 CONFIG_INVALID naming the field, with zero IO and no echo', async () => {
  const h = mount()
  try {
    clearLogs(h)
    const cases = [
      [{ expectedVersion: 0, tenantId: TENANT }, 'tenantId'],
      [{ expectedVersion: 0, formalExport: 'excluded' }, 'formalExport'],
      [{ expectedVersion: 0, trashedRowsAreEvidence: true }, 'trashedRowsAreEvidence'],
      [{ expectedVersion: 0, pullBatchMeaning: 'latest' }, 'pullBatchMeaning'],
      [{ expectedVersion: 0, firstPullBatchColumn: 'hidden' }, 'firstPullBatchColumn'],
      [{ expectedVersion: 0, firstPullBatchRule: 'off' }, 'firstPullBatchRule'],
      [{ expectedVersion: 0, firstPullBatchRule: 'position' }, 'firstPullBatchRule'],
      [{ expectedVersion: 0, labelFormat: 'date' }, 'labelFormat'],
      [{ expectedVersion: 0, firstPullBatchRule: 'Material' }, 'firstPullBatchRule'],
      [{ expectedVersion: 0, firstPullBatchRule: ' material' }, 'firstPullBatchRule'],
      [{ expectedVersion: 0, landing: 'promote_fill' }, 'landing'],
      [{ expectedVersion: 0, placement: null }, 'placement'],
      [{ expectedVersion: 0 }, 'patch'],
      [{}, 'expectedVersion'],
      [{ expectedVersion: -1, labelFormat: 'ordinal' }, 'expectedVersion'],
      [{ expectedVersion: 1.5, labelFormat: 'ordinal' }, 'expectedVersion'],
      [{ expectedVersion: '0', labelFormat: 'ordinal' }, 'expectedVersion'],
    ]
    for (const [body, field] of cases) {
      const res = seen('SR-04', await setTenant(h, WORKBENCH_ADMIN, body))
      const label = JSON.stringify(body)
      assert.equal(res.statusCode, 400, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, PB.PULL_BATCH_ERROR_CODES.CONFIG_INVALID, label)
      assert.equal(res.body.error.details.field, field, label)
      for (const value of Object.values(body)) {
        if (typeof value === 'string' && !['excluded', TENANT].includes(value) && value.trim().length > 2) {
          assert.ok(!JSON.stringify(res.body.error).includes(value), `${label}: the value is never echoed`)
        }
      }
      assertNoIo(h, label)
    }
    // A non-object body.
    const res = await projectSheet.call(h.routes, 'POST', SETTINGS_PATH, { user: WORKBENCH_ADMIN, body: ['material'] })
    assert.equal(res.statusCode, 400)
    assertNoIo(h, 'array body')
  } finally { h.restore() }
})

// ── SR-05 ─────────────────────────────────────────────────────────────────────────────────────────────

test('SR-05 the tenant write: v0 -> v1 with ONE flat audit row (project_id NULL); a stale version 409 with nothing written; the no-op writes nothing', async () => {
  const h = mount()
  try {
    clearLogs(h)
    const res = seen('SR-05 write', await setTenant(h, WORKBENCH_ADMIN, { expectedVersion: 0, firstPullBatchRule: 'predecessor_suffix' }))
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.data, {
      tenant: { settings: { ...PB.DEFAULT_PULL_BATCH_CONFIG, firstPullBatchRule: 'predecessor_suffix' }, source: 'tenant', version: 1 },
      written: true,
      changedKeys: ['firstPullBatchRule'],
    })
    const rows = auditRows(h)
    assert.equal(rows.length, 1, 'exactly one audit row')
    const [row] = rows
    assert.equal(row.tenant_id, TENANT)
    assert.equal(row.action, 'project_fields_update')
    assert.equal(row.action, ST.PULL_BATCH_STORE_AUDIT.settingsAction)
    assert.equal(row.mode, 'pull_batch_settings_tenant_updated')
    assert.equal(row.mode, ST.PULL_BATCH_STORE_AUDIT.modes.tenantSettingsUpdated)
    assert.equal(row.project_id, null, 'a tenant row carries no project')
    assert.equal(row.subject_id, null)
    assert.equal(row.actor, WORKBENCH_ADMIN.id)
    assert.deepEqual(row.detail, { firstPullBatchRuleBefore: 'material', firstPullBatchRuleAfter: 'predecessor_suffix', version: 1 })
    assert.ok(Object.values(row.detail).every((value) => value === null || typeof value !== 'object'), 'depth 1')
    AUDIT.__internals.assertValuesFreeDetail(row.detail)
    // The settings row itself.
    const settingsRow = h.ledgerDb.rows(kit.T.settings)[0]
    assert.equal(settingsRow.version, 1)
    assert.equal(settingsRow.first_pull_batch_rule, 'predecessor_suffix')
    // A stale version: 409, nothing written.
    const stale = seen('SR-05 stale', await setTenant(h, WORKBENCH_ADMIN, { expectedVersion: 0, labelFormat: 'ordinal' }))
    assert.equal(stale.statusCode, 409, JSON.stringify(stale.body))
    assert.equal(stale.body.error.code, ST.SETTINGS_VERSION_CONFLICT_CODE)
    assert.equal(h.ledgerDb.rows(kit.T.settings)[0].version, 1)
    assert.equal(h.ledgerDb.rows(kit.T.settings)[0].label_format, 'ordinal_date')
    assert.equal(auditRows(h).length, 1)
    // The no-op: same version, same value => written:false, no write, no audit.
    const noop = seen('SR-05 no-op', await setTenant(h, WORKBENCH_ADMIN, { expectedVersion: 1, firstPullBatchRule: 'predecessor_suffix' }))
    assert.equal(noop.statusCode, 200, JSON.stringify(noop.body))
    assert.equal(noop.body.data.written, false)
    assert.deepEqual(noop.body.data.changedKeys, [])
    assert.equal(noop.body.data.tenant.version, 1)
    assert.equal(h.ledgerDb.rows(kit.T.settings)[0].version, 1, 'no version bump')
    assert.equal(auditRows(h).length, 1, 'no second audit row')
    // A no-op with a STALE version still goes to the store, which answers 409 by CAS.
    const staleNoop = await setTenant(h, WORKBENCH_ADMIN, { expectedVersion: 0, firstPullBatchRule: 'predecessor_suffix' })
    assert.equal(staleNoop.statusCode, 409)
    // The built-in values sent as a first write at version 0 are a no-op too (nothing to record).
    const h2 = mount()
    try {
      const builtIn = await setTenant(h2, PLATFORM_ADMIN, { expectedVersion: 0, landing: 'promote_prep_fill' })
      assert.equal(builtIn.statusCode, 200)
      assert.equal(builtIn.body.data.written, false)
      assert.deepEqual(h2.ledgerDb.rows(kit.T.settings), [])
      assert.deepEqual(auditRows(h2), [])
    } finally { h2.restore() }
  } finally { h.restore() }
})

// ── SR-06 ─────────────────────────────────────────────────────────────────────────────────────────────

test('SR-06 atomicity (C8): a failing audit insert rolls the setting back; no appendWithin 501 before any statement; a database without the action 503 before the write', async () => {
  {
    const h = mount()
    try {
      h.ledgerDb.faults.insertOne = (args) => (args.table === AUDIT.AUDIT_TABLE && args.row && args.row.mode !== 'vocabulary_probe'
        ? kit.sqlError('XX000', 'synthetic audit insert failure') : null)
      const res = seen('SR-06 fault', await setTenant(h, WORKBENCH_ADMIN, { expectedVersion: 0, placement: 'right' }))
      assert.ok(res.statusCode >= 500, JSON.stringify(res.body))
      assert.equal(res.body.error.code, PB.PULL_BATCH_ERROR_CODES.STORE_FAILED)
      assert.deepEqual(h.ledgerDb.rows(kit.T.settings), [], 'the setting rolled back with its audit row')
      assert.deepEqual(auditRows(h), [])
      // The same fault on the per-sheet edit leaves the captured row byte-equal.
      const { sheetId } = h.seedRegistryRow(PROJECT)
      seedLedger(h, { sheetId })
      const before = ledgerSheet(h, sheetId)
      const sheetRes = await setSheet(h, WORKBENCH_ADMIN, { confirmProjectNo: PROJECT, expectedVersion: 0, labelFormat: 'ordinal' })
      assert.ok(sheetRes.statusCode >= 500, JSON.stringify(sheetRes.body))
      assert.deepEqual(ledgerSheet(h, sheetId), before, 'the sheet edit rolled back with its audit row')
      assert.deepEqual(auditRows(h), [])
    } finally { h.restore() }
  }
  {
    const h = mount()
    try {
      h.seedRegistryRow(PROJECT)
      delete h.services.stockPreparationAuditStore.appendWithin
      clearLogs(h)
      for (const [route, run] of allThree(h, WORKBENCH_ADMIN).slice(1)) {
        const res = await run()
        assert.equal(res.statusCode, 501, `${route}: ${JSON.stringify(res.body)}`)
        assert.equal(res.body.error.code, 'AUDIT_STORE_UNAVAILABLE')
        assertNoIo(h, route)
      }
    } finally { h.restore() }
  }
  {
    // A FRESH mount (the probe's verdict is cached per mount once it says yes): the database's CHECK lacks the action.
    const h = mount()
    try {
      const { sheetId } = h.seedRegistryRow(PROJECT)
      seedLedger(h, { sheetId })
      h.services.stockPreparationAuditStore.supportsAction = async () => ({ supported: false, reason: 'action_not_in_check_constraint' })
      for (const [route, run] of allThree(h, WORKBENCH_ADMIN).slice(1)) {
        const res = await run()
        assert.equal(res.statusCode, 503, `${route}: ${JSON.stringify(res.body)}`)
        assert.equal(res.body.error.code, 'STOCK_PREPARATION_AUDIT_VOCABULARY_UNAVAILABLE')
      }
      assert.deepEqual(h.ledgerDb.rows(kit.T.settings), [], 'nothing written')
      assert.equal(ledgerSheet(h, sheetId).version, 0)
      assert.deepEqual(auditRows(h), [])
    } finally { h.restore() }
  }
})

// ── SR-07 ─────────────────────────────────────────────────────────────────────────────────────────────

test('SR-07 the per-sheet edit: pure refusals, ABSENT / ARCHIVED / NOT_CAPTURED, the success with project_id and a values-free detail, the lock (409 { locked }) and its no-op, a stale version, an archive racing the lock', async () => {
  const h = mount()
  try {
    const { sheetId } = h.seedRegistryRow(PROJECT)
    h.seedRegistryRow(ARCHIVED_PROJECT, { archived: true })
    h.seedRegistryRow(UNCAPTURED_PROJECT)
    seedLedger(h, { sheetId })
    clearLogs(h)
    // Pure refusals: zero IO.
    const pure = [
      ['confirm missing', { expectedVersion: 0, firstPullBatchRule: 'predecessor_suffix' }, 400, SETTINGS.STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH_CODE, 'confirmProjectNo'],
      ['confirm other', { confirmProjectNo: ARCHIVED_PROJECT, expectedVersion: 0, firstPullBatchRule: 'predecessor_suffix' }, 400, SETTINGS.STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH_CODE, 'confirmProjectNo'],
      ['confirm folded', { confirmProjectNo: PROJECT.toLowerCase(), expectedVersion: 0, firstPullBatchRule: 'predecessor_suffix' }, 400, SETTINGS.STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH_CODE, 'confirmProjectNo'],
      ['landing', { confirmProjectNo: PROJECT, expectedVersion: 0, landing: 'keep_current' }, 400, PB.PULL_BATCH_ERROR_CODES.CONFIG_INVALID, 'landing'],
      ['placement', { confirmProjectNo: PROJECT, expectedVersion: 0, placement: 'right' }, 400, PB.PULL_BATCH_ERROR_CODES.CONFIG_INVALID, 'placement'],
      ['tenantId', { confirmProjectNo: PROJECT, expectedVersion: 0, tenantId: TENANT }, 400, PB.PULL_BATCH_ERROR_CODES.CONFIG_INVALID, 'tenantId'],
      ['bad value', { confirmProjectNo: PROJECT, expectedVersion: 0, labelFormat: 'date' }, 400, PB.PULL_BATCH_ERROR_CODES.CONFIG_INVALID, 'labelFormat'],
      ['empty patch', { confirmProjectNo: PROJECT, expectedVersion: 0 }, 400, PB.PULL_BATCH_ERROR_CODES.CONFIG_INVALID, 'patch'],
    ]
    for (const [label, body, status, code, field] of pure) {
      const res = seen('SR-07 pure', await setSheet(h, WORKBENCH_ADMIN, body))
      assert.equal(res.statusCode, status, `${label}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, code, label)
      assert.equal(res.body.error.details.field, field, label)
      assertNoIo(h, label)
    }
    const badPath = await setSheet(h, WORKBENCH_ADMIN, { confirmProjectNo: '-bad no', expectedVersion: 0, labelFormat: 'ordinal' }, { projectNo: '-bad no' })
    assert.equal(badPath.statusCode, 400)
    assert.equal(badPath.body.error.code, 'STOCK_PREPARATION_PROJECT_TARGET_REQUEST_INVALID')
    assertNoIo(h, 'invalid path number')
    // Registry refusals: no ledger statement.
    for (const [projectNo, code] of [[UNREGISTERED_PROJECT, 'STOCK_PREPARATION_PROJECT_ABSENT'], [ARCHIVED_PROJECT, 'STOCK_PREPARATION_PROJECT_ARCHIVED']]) {
      h.ledgerDb.log.length = 0
      const res = seen('SR-07 registry', await setSheet(h, WORKBENCH_ADMIN, { confirmProjectNo: projectNo, expectedVersion: 0, labelFormat: 'ordinal' }, { projectNo }))
      assert.equal(res.statusCode, 409, `${projectNo}: ${JSON.stringify(res.body)}`)
      assert.equal(res.body.error.code, code)
      assert.ok(!h.ledgerDb.log.some(([method, args]) => args && (args.table === kit.T.sheet)), `${code}: no ledger statement`)
    }
    // Registered, not captured.
    const notCaptured = seen('SR-07 not captured', await setSheet(h, WORKBENCH_ADMIN, { confirmProjectNo: UNCAPTURED_PROJECT, expectedVersion: 0, labelFormat: 'ordinal' }, { projectNo: UNCAPTURED_PROJECT }))
    assert.equal(notCaptured.statusCode, 409, JSON.stringify(notCaptured.body))
    assert.equal(notCaptured.body.error.code, ST.SETTINGS_NOT_CAPTURED_CODE)
    assert.deepEqual(auditRows(h), [])
    // THE SUCCESS (the §1.1 signature: the store hands the lock helper `state`).
    const ok = seen('SR-07 ok', await setSheet(h, WORKBENCH_ADMIN, { confirmProjectNo: ` ${PROJECT} `, expectedVersion: 0, firstPullBatchRule: 'predecessor_suffix' }))
    assert.equal(ok.statusCode, 200, JSON.stringify(ok.body))
    assert.equal(ok.body.data.written, true)
    assert.deepEqual(ok.body.data.sheet, {
      projectNo: PROJECT,
      sheetId,
      registryStatus: 'active',
      captured: { firstPullBatchRule: 'predecessor_suffix', labelFormat: 'ordinal_date', landing: null, placement: 'left' },
      labelLocale: 'zh-CN',
      historyStatus: 'born_empty',
      locks: { firstPullBatchRule: false, labelFormat: false, landing: false, placement: true },
      lockedAt: null,
      version: 1,
      may: { set: true },
    })
    assert.equal(ledgerSheet(h, sheetId).first_pull_batch_rule, 'predecessor_suffix')
    assert.equal(ledgerSheet(h, sheetId).version, 1)
    const rows = auditRows(h)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].action, 'project_fields_update')
    assert.equal(rows[0].mode, ST.PULL_BATCH_STORE_AUDIT.modes.sheetSettingsUpdated)
    assert.equal(rows[0].mode, 'pull_batch_settings_sheet_updated')
    assert.equal(rows[0].project_id, PROJECT, 'the 088 project handle (ruling C12)')
    assert.equal(rows[0].subject_id, sheetId, 'the registry sheet')
    assert.deepEqual(rows[0].detail, { firstPullBatchRuleBefore: 'material', firstPullBatchRuleAfter: 'predecessor_suffix', version: 1 })
    assert.ok(!JSON.stringify(rows[0].detail).includes(PROJECT), 'no project number inside the detail')
    // GET reads back what the POST answered.
    const got = await readSettings(h, WORKBENCH_ADMIN)
    assert.deepEqual(got.body.data.sheets.find((row) => row.projectNo === PROJECT), ok.body.data.sheet)
    // A stale version: 409, nothing written.
    const stale = seen('SR-07 stale', await setSheet(h, WORKBENCH_ADMIN, { confirmProjectNo: PROJECT, expectedVersion: 0, labelFormat: 'ordinal' }))
    assert.equal(stale.statusCode, 409, JSON.stringify(stale.body))
    assert.equal(stale.body.error.code, ST.SETTINGS_VERSION_CONFLICT_CODE)
    assert.equal(ledgerSheet(h, sheetId).label_format, 'ordinal_date')
    assert.equal(auditRows(h).length, 1)
    // THE LOCK: the sheet's first label landed (fixture: settings_locked_at set).
    h.ledgerDb.tables.get(kit.T.sheet).get(ledgerSheet(h, sheetId).id).settings_locked_at = '2026-11-07T02:00:00.000Z'
    const locked = seen('SR-07 locked', await setSheet(h, WORKBENCH_ADMIN, { confirmProjectNo: PROJECT, expectedVersion: 1, firstPullBatchRule: 'material' }))
    assert.equal(locked.statusCode, 409, JSON.stringify(locked.body))
    assert.equal(locked.body.error.code, PB.PULL_BATCH_ERROR_CODES.CONFIG_LOCKED)
    assert.deepEqual(locked.body.error.details.locked, ['firstPullBatchRule'], 'the locked keys reach the web (it names them in words)')
    assert.equal(ledgerSheet(h, sheetId).first_pull_batch_rule, 'predecessor_suffix')
    assert.equal(ledgerSheet(h, sheetId).version, 1)
    assert.equal(auditRows(h).length, 1)
    // Both keys locked, both proposed: both named.
    const lockedBoth = await setSheet(h, WORKBENCH_ADMIN, { confirmProjectNo: PROJECT, expectedVersion: 1, firstPullBatchRule: 'material', labelFormat: 'ordinal' })
    assert.deepEqual(lockedBoth.body.error.details.locked, ['firstPullBatchRule', 'labelFormat'])
    // The captured value repeated on the locked sheet: a no-op (no version bump, no audit row).
    const repeat = seen('SR-07 repeat', await setSheet(h, WORKBENCH_ADMIN, { confirmProjectNo: PROJECT, expectedVersion: 1, firstPullBatchRule: 'predecessor_suffix' }))
    assert.equal(repeat.statusCode, 200, JSON.stringify(repeat.body))
    assert.equal(repeat.body.data.written, false)
    assert.equal(repeat.body.data.sheet.version, 1)
    assert.deepEqual(repeat.body.data.sheet.locks, { firstPullBatchRule: true, labelFormat: true, landing: false, placement: true })
    assert.equal(repeat.body.data.sheet.lockedAt, '2026-11-07T02:00:00.000Z')
    assert.deepEqual(repeat.body.data.sheet.may, { set: false })
    assert.equal(ledgerSheet(h, sheetId).version, 1)
    assert.equal(auditRows(h).length, 1)
    // An archive that commits between the route's registry read and its lock: the locked re-check refuses it.
    const targets = h.services.stockPreparationProjectTargetStore
    const realGet = targets.get
    const row = h.registryRows().find((entry) => entry.project_no === PROJECT)
    targets.get = async (input) => {
      const answer = await realGet(input)
      row.status = 'archived'
      row.archived_at = new Date('2026-11-07T03:00:00Z')
      row.archived_by = 'seed'
      return answer
    }
    h.ledgerDb.log.length = 0
    const raced = seen('SR-07 raced', await setSheet(h, WORKBENCH_ADMIN, { confirmProjectNo: PROJECT, expectedVersion: 1, firstPullBatchRule: 'predecessor_suffix' }))
    targets.get = realGet
    assert.equal(raced.statusCode, 409, JSON.stringify(raced.body))
    assert.equal(raced.body.error.code, 'STOCK_PREPARATION_PROJECT_ARCHIVED')
    assert.match(raced.body.error.message, /pull-batch settings/, 'in this route\'s words')
    assert.ok(!h.ledgerDb.log.some(([, args]) => args && args.table === kit.T.sheet), 'no ledger statement after the refused lock')
  } finally { h.restore() }
})

// ── SR-08 ─────────────────────────────────────────────────────────────────────────────────────────────

test('SR-08 a tenant edit never moves a captured sheet', async () => {
  const h = mount()
  try {
    const { sheetId } = h.seedRegistryRow(PROJECT)
    seedLedger(h, { sheetId })
    const before = ledgerSheet(h, sheetId)
    const res = await setTenant(h, WORKBENCH_ADMIN, { expectedVersion: 0, firstPullBatchRule: 'predecessor_suffix', labelFormat: 'ordinal', landing: 'keep_current', placement: 'right' })
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assert.deepEqual(res.body.data.changedKeys, ['firstPullBatchRule', 'labelFormat', 'landing', 'placement'])
    assert.deepEqual(ledgerSheet(h, sheetId), before, 'the captured row is byte-equal')
    const got = await readSettings(h, WORKBENCH_ADMIN)
    assert.deepEqual(got.body.data.sheets[0].captured, { firstPullBatchRule: 'material', labelFormat: 'ordinal_date', landing: null, placement: 'left' })
    assert.deepEqual(auditRows(h)[0].detail, {
      firstPullBatchRuleBefore: 'material', firstPullBatchRuleAfter: 'predecessor_suffix',
      labelFormatBefore: 'ordinal_date', labelFormatAfter: 'ordinal',
      landingBefore: 'promote_prep_fill', landingAfter: 'keep_current',
      placementBefore: 'left', placementAfter: 'right',
      version: 1,
    })
  } finally { h.restore() }
})

// ── SR-09 ─────────────────────────────────────────────────────────────────────────────────────────────

test('SR-09 values: the project number appears only in sheets[*].projectNo, the per-sheet answer and the audit row\'s project_id', async () => {
  assert.ok(SEEN.length > 20, 'the earlier tests fed the scan')
  for (const { label, body } of SEEN) {
    const text = JSON.stringify(body)
    if (body && body.ok === false) {
      for (const project of [PROJECT, ARCHIVED_PROJECT, UNCAPTURED_PROJECT, UNREGISTERED_PROJECT]) {
        assert.ok(!text.includes(project), `${label}: an error never carries a project number`)
      }
      continue
    }
    const data = body && body.data
    if (!data) continue
    if (data.tenant && !data.sheets && !data.sheet) {
      assert.ok(![PROJECT, ARCHIVED_PROJECT, UNCAPTURED_PROJECT].some((project) => text.includes(project)), `${label}: a tenant answer carries no project number`)
    }
    if (Array.isArray(data.sheets)) {
      const stripped = JSON.stringify({ ...data, sheets: data.sheets.map(({ projectNo: _projectNo, ...rest }) => rest) })
      assert.ok(![PROJECT, ARCHIVED_PROJECT, UNCAPTURED_PROJECT, UNREGISTERED_PROJECT].some((project) => stripped.includes(project)), `${label}: only sheets[*].projectNo`)
    }
    if (data.sheet) {
      const { projectNo: _projectNo, ...rest } = data.sheet
      assert.ok(!JSON.stringify(rest).includes(PROJECT), `${label}: only sheet.projectNo`)
    }
  }
  // And every audit row of a fresh run: the number only in project_id.
  const h = mount()
  try {
    const { sheetId } = h.seedRegistryRow(PROJECT)
    seedLedger(h, { sheetId })
    await setTenant(h, WORKBENCH_ADMIN, { expectedVersion: 0, labelFormat: 'ordinal' })
    await setSheet(h, WORKBENCH_ADMIN, { confirmProjectNo: PROJECT, expectedVersion: 0, labelFormat: 'ordinal' })
    const rows = auditRows(h)
    assert.equal(rows.length, 2)
    for (const row of rows) {
      const { project_id: projectId, ...rest } = row
      assert.ok(!JSON.stringify(rest).includes(PROJECT), `${row.mode}: no project number outside project_id`)
      assert.ok(projectId === null || projectId === PROJECT)
      AUDIT.__internals.assertValuesFreeDetail(row.detail)
    }
  } finally { h.restore() }
})

// ── SR-10 ─────────────────────────────────────────────────────────────────────────────────────────────

test('SR-10 call sites (text): switches before the scope in every handler; no audit mode respelled; one confirm code', () => {
  const hr = fs.readFileSync(path.join(LIB, 'http-routes.cjs'), 'utf8').replace(/\r\n/g, '\n')
  const helper = fs.readFileSync(path.join(LIB, 'stock-preparation-pull-batch-settings.cjs'), 'utf8').replace(/\r\n/g, '\n')
  for (const handler of ['stockPreparationPullBatchSettingsGet', 'stockPreparationPullBatchSettingsSet', 'stockPreparationProjectPullBatchSettingsSet']) {
    const start = hr.indexOf(`    async ${handler}(req, res) {`)
    assert.notEqual(start, -1, `${handler} is declared as its own handler`)
    const end = hr.indexOf('\n    },\n', start)
    const body = hr.slice(start, end)
    const gate = body.indexOf('requireAccess(req, STOCK_PREP_ADMIN)')
    const switches = body.indexOf('requireStockPreparationPullBatchSettingsEnabled()')
    const scope = body.indexOf('resolveOperatorValueScope(')
    const ledger = body.search(/ledger\.(readTenantSettings|writeTenantSettings|setSheetSettings|listSheetSettings|readSheetState)\(/)
    assert.ok(gate !== -1 && switches !== -1 && scope !== -1 && ledger !== -1, handler)
    assert.ok(gate < switches && switches < scope && scope < ledger, `${handler}: gate -> switches -> scope -> ledger`)
  }
  for (const literal of Object.values(ST.PULL_BATCH_STORE_AUDIT.modes)) {
    assert.ok(!hr.includes(`'${literal}'`), `http-routes.cjs never respells ${literal}`)
    assert.ok(!helper.includes(`'${literal}'`), `the helper never respells ${literal}`)
  }
  assert.ok(!helper.includes("'project_fields_update'"), 'the helper takes the action from the store')
  assert.ok(!/process\.env/.test(helper), 'the helper reads no environment (the lanes helper is the switch\'s one reader)')
  const routeConfirm = /const STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH_CODE = '([A-Z_]+)'/.exec(hr)
  assert.equal(routeConfirm && routeConfirm[1], SETTINGS.STOCK_PREPARATION_PROJECT_CONFIRM_MISMATCH_CODE)
  assert.equal(SETTINGS.PULL_BATCH_SETTINGS_AUDIT, ST.PULL_BATCH_STORE_AUDIT, 'one audit spelling: the store\'s')
  assert.deepEqual([...SETTINGS.PULL_BATCH_TENANT_SETTINGS_BODY_KEYS], ['expectedVersion', ...ST.PULL_BATCH_SETTING_KEYS])
  assert.deepEqual([...SETTINGS.PULL_BATCH_SHEET_SETTINGS_BODY_KEYS], ['confirmProjectNo', 'expectedVersion', ...ST.PULL_BATCH_SHEET_SETTING_KEYS])
})

require('./support/fail-closed-suite-runner.cjs').runFailClosedSuite('stock-preparation-pull-batch-settings-routes.test.cjs', tests, { passLine: '✓ stock-preparation-pull-batch-settings-routes' })
