// Hermetic tests for scripts/ops/stock-prep-acceptance-bootstrap.mjs.
//
// NO NETWORK, NO DATABASE, NO FILESYSTEM WRITES. A fake fetch stands in for the whole
// deployment; every route the bootstrap touches is modelled here, and the fake enforces
// the same request-shape rules the real routes do (notably the apply body allowlist), so
// a test that passes against the fake is testing the rule and not just the happy path.
//
// The four witnessed-RED assertions this suite pins:
//   1. the human band must be EMPTY on every written row      (criterion 1, human half)
//   2. the second dry-run must be all-skip                    (criterion 2)
//   3. the sandbox objectId comes from the PACK               (resolvePackTarget)
//   4. the values-free self-check refuses to print a leak     (assertValuesFree)

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  getObjectFieldId,
  getObjectSheetId,
} from './stock-preparation-derive-target-binding.mjs'

import {
  BootstrapInputError,
  HUMAN_PRESERVED_FIELD_IDS,
  QUEUE_ROW_KEYS,
  SCANNED_ENV_NAMES,
  STEP_COUNT,
  STEP_PLAN,
  assertHumanBandEmpty,
  assertMappedExtCellsPresent,
  assertValuesFree,
  buildApplyBody,
  isIdempotentSecondDryRun,
  isNonEmptyCell,
  isScannableValue,
  main,
  parseArgs,
  readCell,
  readEnvConfig,
  renderPlan,
  resolvePackTarget,
  runBootstrap,
} from './stock-prep-acceptance-bootstrap.mjs'

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const API_BASE = 'http://api.test/api'
const TENANT_ID = 'tenant-dev'
const PROJECT_ID = `${TENANT_ID}:integration-core`
const OBJECT_ID = 'plm_stock_preparation_sandbox_m0'
const PACK_ID = 'factory-a'

// Deliberately distinctive so the leak scan has something unambiguous to find.
const SECRET_TOKEN = 'tok-QZX9-bearer-secret'
const SECRET_PROJECT_NO = 'PRJ-QZX9-0001'
const SECRET_HOST = 'plm-db.internal.example'
const SECRET_PASSWORD = 'pw-QZX9-hunter2'
// A business cell value. It must never reach the report; the leak-guard test proves the
// self-check would catch it if the reductions above ever regressed.
const SECRET_CELL = 'DRAWING-QZX9-773-A'

const BASE_ENV = Object.freeze({
  MS_API: API_BASE,
  MS_TOKEN: SECRET_TOKEN,
  MS_PROJECT_NO: SECRET_PROJECT_NO,
  MS_PACK_ID: PACK_ID,
  MS_DATA_SOURCE_ID: 'ds-plm-1',
  // REQUIRED: the id of the system the table action is configured to read through. The API
  // never exposes that binding, so it can only come from the deployment's own config.
  MS_EXTERNAL_SYSTEM_ID: 'plm-bom-source',
  MS_TENANT_ID: TENANT_ID,
})

const CONFIGURED_SYSTEM = Object.freeze({
  id: 'plm-bom-source',
  name: 'PLM BOM source',
  kind: 'data-source:sql-readonly',
  role: 'source',
  config: { dataSourceId: 'ds-plm-1', schema: 'public' },
  status: 'active',
})

const EXT_SYSTEM_FIELDS = ['ext_legacyRowId', 'ext_plmObjectId']
const EXT_HUMAN_FIELDS = ['ext_blankLength']

const PACK = Object.freeze({
  packId: PACK_ID,
  packVersion: 1,
  targetObjectId: OBJECT_ID,
  extensionFields: [
    { id: 'ext_legacyRowId', type: 'text', ownership: 'plm_system', preserveOnRefresh: false },
    { id: 'ext_plmObjectId', type: 'text', ownership: 'plm_system', preserveOnRefresh: false },
    { id: 'ext_blankLength', type: 'number', ownership: 'human_preserved', preserveOnRefresh: true },
  ],
})

// The real preflight contract (#5345): posture states carry no `fix` by design — a fix
// line next to "B2a dormant" would be a preflight nudging an operator toward arming a
// gate. This fixture mirrors that shape so the step is tested against the route it reads.
const READY_PREFLIGHT = Object.freeze({
  ready: true,
  blockerCount: 0,
  blockers: [],
  checks: {},
  posture: {
    productionApply: { state: 'closed', canonicalObjectId: 'plm_stock_preparation_main', note: 'production Apply is closed; there is nothing to run.' },
    k3ExternalWrite: { state: 'permanently_disabled', code: 'K3_WISE_EXTERNAL_WRITE_DISABLED', note: 'refused permanently and structurally.' },
    b2aTrialRegistry: { state: 'dormant', envVar: 'INTEGRATION_CORE_B2A_REGISTRY_PATH', note: 'dormant, which is correct; nothing to run.' },
    outboundHttpWrite: { state: 'unset', envVar: 'INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS', note: 'unset means deny — the correct posture; nothing to run.' },
  },
})

const INSTALLED_FIELDS = PACK.extensionFields.map((f) => ({
  fieldId: f.id,
  ownership: f.ownership,
  preserveOnRefresh: f.preserveOnRefresh,
  extension: true,
  action: 'already_stamped',
}))

const physicalId = (fieldId) => getObjectFieldId(PROJECT_ID, OBJECT_ID, fieldId)
const SHEET_ID = getObjectSheetId(PROJECT_ID, OBJECT_ID)

function buildTargetRow(index, { humanValue = null, extValue = SECRET_CELL } = {}) {
  const data = {}
  data[physicalId('plmDrawingNo')] = `${extValue}-${index}`
  for (const id of EXT_SYSTEM_FIELDS) data[physicalId(id)] = `${extValue}-${id}-${index}`
  // The human band is EMPTY by default — that is the whole point of criterion 1.
  for (const id of [...HUMAN_PRESERVED_FIELD_IDS, ...EXT_HUMAN_FIELDS]) data[physicalId(id)] = ''
  if (humanValue !== null) data[physicalId(humanValue.fieldId)] = humanValue.value
  return { id: `rec-${index}`, version: 1, data }
}

function json(status, body) {
  return { status, text: async () => JSON.stringify(body) }
}

const okEnvelope = (data) => ({ ok: true, data })
const errEnvelope = (code) => ({ ok: false, error: { code, message: 'refused' } })

/**
 * The fake deployment. `opts` lets a single test bend exactly one behaviour; everything
 * else stays on the proven happy path, so a RED is attributable to the mutation.
 */
function makeFakeApi(opts = {}) {
  const state = {
    calls: [],
    installCalls: 0,
    dryRunCalls: 0,
    applyBodies: [],
    reconcileCalls: 0,
    confirmBodies: [],
    queueListCalls: 0,
    upsertBodies: [],
    // `null` = the deployment has no such external system yet (GET answers 404).
    system: opts.existingSystem === undefined ? null : opts.existingSystem,
  }
  const rows = opts.rows || [buildTargetRow(1), buildTargetRow(2)]
  const packs = opts.packs || [PACK]

  async function fetchImpl(url, init = {}) {
    const pathname = String(url).slice(API_BASE.length).split('?')[0]
    const method = init.method || 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    state.calls.push(`${method} ${pathname}`)

    // --- 1 preflight ---------------------------------------------------------
    if (pathname === '/integration/stock-preparation/preflight') {
      if (opts.preflight) return json(opts.preflight.status, opts.preflight.body)
      return json(404, errEnvelope('NOT_FOUND'))
    }

    // --- 2 managed tables ----------------------------------------------------
    if (pathname === '/integration/stock-preparation/confirmation-decisions/ensure') {
      assert.deepEqual(body, {}, 'confirmation-decisions/ensure takes no body keys')
      return json(200, okEnvelope({ ready: true, created: false, mode: 'confirmation_decision_existing' }))
    }
    if (pathname === '/integration/stock-preparation/customer-packs' && method === 'GET') {
      return json(200, okEnvelope({ packCount: packs.length, packs }))
    }
    if (pathname === '/integration/stock-preparation/sandbox-target/ensure') {
      // The namespace rule is enforced server-side; model it so a bad objectId cannot
      // silently succeed against the fake.
      if (!/^plm_stock_preparation_sandbox(?:$|[_-])/.test(body.objectId)) {
        return json(422, errEnvelope('TARGET_SANDBOX_OBJECT_ID_INVALID'))
      }
      return json(200, okEnvelope({ ready: true, mode: 'sandbox_existing', targetBindingAvailable: true }))
    }

    // --- 3 customer pack -----------------------------------------------------
    if (pathname === `/integration/stock-preparation/customer-packs/${PACK_ID}/dry-run`) {
      return json(200, okEnvelope({
        projectId: PROJECT_ID,
        mode: 'dry_run',
        packId: PACK_ID,
        objectId: OBJECT_ID,
        canInstall: opts.packCanInstall === false ? false : true,
        willCreateFieldIds: [],
        willStampFieldIds: [],
        alreadyStampedFieldIds: PACK.extensionFields.map((f) => f.id),
        conflictingFieldIds: opts.packCanInstall === false ? ['ext_legacyRowId'] : [],
        counts: { extensionFields: 3, willCreate: 0, willStamp: 0, alreadyStamped: 3, conflicting: 0 },
      }))
    }
    if (pathname === `/integration/stock-preparation/customer-packs/${PACK_ID}/install`) {
      state.installCalls += 1
      assert.deepEqual(Object.keys(body), ['mode'], 'install body allowlist is exactly { mode }')
      if (state.installCalls === 1) {
        return json(200, okEnvelope({
          projectId: PROJECT_ID,
          packId: PACK_ID,
          createdFields: [],
          stampedExistingFields: [],
          alreadyStampedFields: PACK.extensionFields.map((f) => f.id),
          installedFields: INSTALLED_FIELDS,
        }))
      }
      const replay = opts.installReplay || {
        createdFields: [],
        stampedExistingFields: [],
        alreadyStampedFields: PACK.extensionFields.map((f) => f.id),
      }
      return json(200, okEnvelope({ projectId: PROJECT_ID, packId: PACK_ID, ...replay, installedFields: INSTALLED_FIELDS }))
    }

    // --- 4 source wiring -----------------------------------------------------
    if (pathname === '/data-sources' && method === 'POST') {
      assert.equal(body.options.readOnly, true, 'the data source is registered read-only')
      return json(201, okEnvelope({ id: body.id, hasCredentials: true }))
    }
    if (pathname.startsWith('/data-sources/') && method === 'GET') {
      return json(200, okEnvelope({ id: BASE_ENV.MS_DATA_SOURCE_ID, type: 'postgres' }))
    }
    if (pathname === '/integration/external-systems' && method === 'POST') {
      state.upsertBodies.push(body)
      // The real route refuses a kind/role change after creation; model the parts the
      // script relies on so a destructive body cannot pass here and fail only in the field.
      if (state.system) {
        if (body.kind && body.kind !== state.system.kind) return json(400, errEnvelope('EXTERNAL_SYSTEM_VALIDATION'))
        if (body.role && body.role !== state.system.role) return json(400, errEnvelope('EXTERNAL_SYSTEM_VALIDATION'))
        // Omitted config/capabilities are PRESERVED — that is the property step 4 relies on.
        if (body.config !== undefined) state.system.config = body.config
        if (body.status !== undefined) state.system.status = body.status
        if (body.name !== undefined) state.system.name = body.name
        return json(200, okEnvelope({ ...state.system }))
      }
      assert.equal(body.kind, 'data-source:sql-readonly')
      assert.equal(body.config.dataSourceId, BASE_ENV.MS_DATA_SOURCE_ID)
      state.system = { id: body.id, name: body.name, kind: body.kind, role: body.role, config: body.config, status: body.status }
      return json(201, okEnvelope({ ...state.system }))
    }
    if (pathname.endsWith('/test') && method === 'POST') {
      return json(200, okEnvelope(opts.externalSystemTest || { ok: true, status: 'active', connected: true }))
    }
    if (pathname.startsWith('/integration/external-systems/') && method === 'GET') {
      if (!state.system) return json(404, errEnvelope('NOT_FOUND'))
      return json(200, okEnvelope({ ...state.system, status: opts.externalSystemStatus || state.system.status }))
    }

    // --- 5/7 dry-run ---------------------------------------------------------
    if (pathname.endsWith('/dry-run') && pathname.startsWith('/integration/table-actions/')) {
      state.dryRunCalls += 1
      assert.deepEqual(Object.keys(body).sort(), ['parameters'], 'dry-run body carries parameters only')
      const first = state.dryRunCalls === 1
      const counts = first
        ? { add: 2, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }
        : (opts.secondDryRunCounts || { add: 0, update: 0, skip: 2, inactive: 0, manual_confirm: 0 })
      return json(200, okEnvelope({
        status: 'ready',
        canApply: opts.canApply === false ? false : true,
        dryRunToken: opts.canApply === false ? null : `token-${state.dryRunCalls}`,
        revision: 'rev-1',
        counts,
        evidence: {
          actionId: 'plm.stock-preparation.pull-bom.v1',
          projectNoPresent: true,
          extFieldMapping: opts.extFieldMapping === null ? undefined : {
            mappingId: 'factory-a-map',
            mappingVersion: 1,
            targetFieldIds: opts.mappedFieldIds || EXT_SYSTEM_FIELDS,
          },
        },
      }))
    }

    // --- 6 apply -------------------------------------------------------------
    if (pathname.endsWith('/apply') && pathname.startsWith('/integration/table-actions/')) {
      state.applyBodies.push(body)
      // THE BODY-SHAPE RULE, modelled exactly as normalizeTableActionBody enforces it:
      // an allowlist of { parameters, confirm }, and the token nested under confirm.
      for (const key of Object.keys(body)) {
        if (key !== 'parameters' && key !== 'confirm') {
          return json(400, errEnvelope('TABLE_ACTION_REQUEST_INVALID'))
        }
      }
      const token = body.confirm && body.confirm.dryRunToken
      if (typeof token !== 'string' || token === '') {
        return json(400, errEnvelope('TABLE_ACTION_DRY_RUN_TOKEN_REQUIRED'))
      }
      return json(200, okEnvelope({
        status: 'applied',
        permission: 'sandbox',
        dryRunRevision: 'rev-1',
        apply: { ok: true, status: 'applied', written: rows.length, counts: { add: rows.length }, resultStatuses: ['created'], errorCodes: [] },
      }))
    }

    // --- 6 target read -------------------------------------------------------
    if (pathname === '/multitable/records' && method === 'GET') {
      assert.ok(String(url).includes(`sheetId=${SHEET_ID}`), 'the sheetId is derived, never guessed')
      return json(200, okEnvelope({ records: rows, nextCursor: null, hasMore: false }))
    }

    // --- 8 confirmation queue ------------------------------------------------
    if (pathname.endsWith('/confirmation-decisions/reconcile')) {
      state.reconcileCalls += 1
      if (opts.reconcileNotActive) return json(409, errEnvelope('TABLE_ACTION_SOURCE_NOT_ACTIVE'))
      return json(200, okEnvelope({ ok: true, mode: 'confirmation_decisions_reconciled', counts: { created: 1 } }))
    }
    if (pathname === '/integration/stock-preparation/confirmation-decisions' && method === 'GET') {
      state.queueListCalls += 1
      const queue = state.queueListCalls === 1
        ? (opts.queueBefore || defaultQueue([queueRow('dec-1'), queueRow('dec-2')]))
        : (opts.queueAfter || defaultQueue([queueRow('dec-2')]))
      return json(200, okEnvelope(queue))
    }
    if (pathname === '/integration/stock-preparation/confirmation-decisions/confirm') {
      state.confirmBodies.push(body)
      return json(200, okEnvelope({
        ok: true,
        mode: 'confirmation_decision_confirmed',
        decisionId: body.decisionId,
        status: 'confirmed',
        resolutionAction: body.resolutionAction,
      }))
    }

    throw new Error(`fake api: unrouted ${method} ${pathname}`)
  }

  return { state, fetchImpl }
}

function queueRow(decisionId, overrides = {}) {
  return {
    decisionId,
    conflictType: 'duplicate_expanded_key',
    status: 'pending',
    resolutionAction: null,
    inputFingerprint: `fp-${decisionId}`,
    sourceRevisionPresent: true,
    confirmedByPresent: false,
    confirmedAtPresent: false,
    notesPresent: false,
    resolvedValuePresent: false,
    resolvedAuxValuePresent: false,
    ...overrides,
  }
}

function defaultQueue(rows) {
  return {
    ok: true,
    rowCount: rows.length,
    byStatus: { pending: rows.filter((r) => r.status === 'pending').length },
    byResolutionAction: {},
    parkedCount: 0,
    rows,
  }
}

async function run(opts = {}, envOverrides = {}) {
  const fake = makeFakeApi(opts)
  const result = await runBootstrap({
    env: { ...BASE_ENV, ...envOverrides },
    fetchImpl: fake.fetchImpl,
    now: () => '2026-08-30T00:00:00.000Z',
  })
  return { ...result, state: fake.state }
}

function stepById(report, id) {
  return report.steps.find((s) => s.id === id)
}

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe('happy path', () => {
  test('all eight steps report OK or SKIP and the run exits 0', async () => {
    const { report, lines, exitCode } = await run()
    assert.equal(exitCode, 0)
    assert.equal(report.summary.pass, true)
    assert.equal(report.steps.length, STEP_COUNT)
    assert.equal(report.summary.failCount, 0)
    for (const step of report.steps) {
      assert.ok(step.status === 'OK' || step.status === 'SKIP', `${step.id} was ${step.status}: ${step.reason}`)
    }
    assert.equal(lines.length, STEP_COUNT)
    assert.match(lines[0], /^\[1\/8\] preflight \.\.\. SKIP — /)
    assert.match(lines[5], /^\[6\/8\] acceptance-apply \.\.\. OK — criterion 1 PASS/)
  })

  test('preflight SKIPs (not FAILs) on a deployment that predates the route', async () => {
    const { report } = await run()
    const step = stepById(report, 'preflight')
    assert.equal(step.status, 'SKIP')
    assert.match(step.reason, /route_absent/)
    assert.match(step.reason, /5345/)
  })

  test('a ready preflight passes and its SERVER posture is what the report carries', async () => {
    const { report } = await run({ preflight: { status: 200, body: okEnvelope(READY_PREFLIGHT) } })
    const step = stepById(report, 'preflight')
    assert.equal(step.status, 'OK')
    assert.equal(report.preflight.ready, true)
    assert.equal(report.preflight.blockerCount, 0)
    assert.equal(report.posture.scope, 'server_preflight')
    assert.equal(report.posture.productionApply, 'closed')
    assert.equal(report.posture.b2aTrialRegistry, 'dormant')
    assert.equal(report.posture.outboundHttpWrite, 'unset')
    assert.equal(report.posture.k3ExternalWrite, 'permanently_disabled')
    // The preflight's prose notes are not reproduced: this report's face is tokens.
    assert.ok(!JSON.stringify(report).includes('nothing to run'))
  })

  test('a blocking preflight prints every blocker with its paste-able fix.run and FAILs', async () => {
    const { report, exitCode } = await run({
      preflight: {
        status: 200,
        body: okEnvelope({
          ready: false,
          blockerCount: 1,
          blockers: [{
            code: 'STOCK_PREP_SANDBOX_ALLOWLIST_MISSING_TARGET',
            what: 'the sandbox write allowlist does not contain the declared target',
            fix: { kind: 'env', name: 'STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS', value: OBJECT_ID, run: `STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS=${OBJECT_ID}` },
          }],
          posture: READY_PREFLIGHT.posture,
        }),
      },
    })
    assert.equal(exitCode, 1)
    const step = stepById(report, 'preflight')
    assert.equal(step.status, 'FAIL')
    assert.match(step.fix, /STOCK_PREP_SANDBOX_ALLOWLIST_MISSING_TARGET -> run: STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS=/)
    assert.equal(report.preflight.blockerCount, 1)
    assert.equal(report.preflight.blockers[0].fixKind, 'env')
  })

  test('a preflight that says not-ready without naming a blocker still FAILs', async () => {
    const { report, exitCode } = await run({
      preflight: { status: 200, body: okEnvelope({ ready: false, blockers: [], posture: READY_PREFLIGHT.posture }) },
    })
    assert.equal(exitCode, 1)
    assert.match(stepById(report, 'preflight').fix, /not ready but named no blocker/)
  })

  test('both criteria are recorded as PASS verdicts', async () => {
    const { report } = await run()
    assert.equal(report.criterion1.verdict, 'PASS')
    assert.equal(report.criterion1.targetRowCount, 2)
    assert.deepEqual(report.criterion1.mappedExtEmptyFieldIds, [])
    assert.deepEqual(report.criterion1.humanBandNonEmptyFieldIds, [])
    assert.equal(report.criterion2.verdict, 'PASS')
    assert.equal(report.criterion2.counts.skip, 2)
  })

  test('the run stops at the first FAIL and never calls a later step', async () => {
    const { report, state } = await run({ packCanInstall: false })
    assert.equal(report.steps.length, 3)
    assert.equal(stepById(report, 'customer-pack').status, 'FAIL')
    assert.equal(report.summary.failedStepIndex, 3)
    assert.equal(report.summary.failedStepId, 'customer-pack')
    assert.ok(!state.calls.some((c) => c.includes('/apply')), 'apply must not run after a FAIL')
  })

  test('without the preflight route the posture falls back to the local env, booleans only', async () => {
    const { report } = await run({}, {
      INTEGRATION_CORE_B2A_REGISTRY_PATH: '/srv/secret/b2a.json',
      INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS: '/srv/secret/targets.json',
    })
    assert.equal(report.posture.scope, 'local_process_env')
    assert.equal(report.posture.b2aRegistryPathSet, true)
    assert.equal(report.posture.outboundHttpWriteTargetsSet, true)
    const serialized = JSON.stringify(report)
    assert.ok(!serialized.includes('/srv/secret/'), 'a fence path value must never be printed')
    // Posture is observational: an armed fence is reported and the run still completes.
    assert.equal(report.summary.pass, true)
  })

  test('an armed fence is reported, never remediated — the run offers nothing to run for it', async () => {
    const armed = JSON.parse(JSON.stringify(READY_PREFLIGHT))
    armed.posture.b2aTrialRegistry.state = 'armed'
    armed.posture.outboundHttpWrite.state = 'set'
    const { report } = await run({ preflight: { status: 200, body: okEnvelope(armed) } })
    assert.equal(stepById(report, 'preflight').status, 'OK', 'posture is never a blocker')
    assert.equal(report.posture.b2aTrialRegistry, 'armed')
    assert.equal(report.posture.outboundHttpWrite, 'set')
    assert.equal(report.summary.pass, true)
    // Nothing anywhere in the output tells an operator to set a fence env var.
    const blob = JSON.stringify(report)
    assert.ok(!/INTEGRATION_CORE_B2A_REGISTRY_PATH=/.test(blob))
    assert.ok(!/INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS=/.test(blob))
  })
})

// ---------------------------------------------------------------------------
// 2. The pack declares the objectId
// ---------------------------------------------------------------------------

describe('pack-target-from-pack rule', () => {
  test('resolvePackTarget reads targetObjectId off the catalog pack', () => {
    const target = resolvePackTarget([PACK], PACK_ID)
    assert.equal(target.targetObjectId, OBJECT_ID)
    assert.deepEqual(target.systemExtensionFieldIds, EXT_SYSTEM_FIELDS)
    assert.deepEqual(target.humanExtensionFieldIds, EXT_HUMAN_FIELDS)
  })

  // WITNESSED RED #3. Mutating resolvePackTarget to accept a pack without a
  // targetObjectId, or to skip assertSandboxObjectId, turns each of these green-to-red.
  test('a pack that declares no targetObjectId is refused — never invented', () => {
    assert.throws(
      () => resolvePackTarget([{ packId: PACK_ID, extensionFields: [] }], PACK_ID),
      (err) => err instanceof BootstrapInputError && err.field === 'PACK_TARGET_OBJECT_ID_ABSENT',
    )
  })

  test('a targetObjectId outside the sandbox namespace is refused', () => {
    assert.throws(
      () => resolvePackTarget([{ ...PACK, targetObjectId: 'plm_stock_prep_custom' }], PACK_ID),
      (err) => /not_sandbox_namespace/.test(JSON.stringify(err.details || {})) || /sandbox/.test(err.message),
    )
  })

  test('the production canonical target is refused as a sandbox objectId', () => {
    assert.throws(
      () => resolvePackTarget([{ ...PACK, targetObjectId: 'plm_stock_preparation_main' }], PACK_ID),
      (err) => /prod_canonical/.test(JSON.stringify(err.details || {})),
    )
  })

  test('a packId absent from the server-held catalog is refused', () => {
    assert.throws(
      () => resolvePackTarget([PACK], 'not-configured'),
      (err) => err instanceof BootstrapInputError && err.field === 'PACK_NOT_IN_CATALOG',
    )
  })

  test('the pack-target mismatch path FAILs step 2 with a fix that forbids inventing a name', async () => {
    const { report, exitCode, state } = await run({ packs: [{ ...PACK, targetObjectId: 'plm_stock_prep_custom' }] })
    assert.equal(exitCode, 1)
    const step = stepById(report, 'managed-tables')
    assert.equal(step.status, 'FAIL')
    assert.match(step.reason, /pack target unresolved/)
    assert.match(step.fix, /do not invent a name/)
    assert.ok(
      !state.calls.includes('POST /integration/stock-preparation/sandbox-target/ensure'),
      'a bad pack target must never reach the ensure route',
    )
  })

  test('no env var can supply the sandbox objectId', () => {
    const config = readEnvConfig({ ...BASE_ENV, MS_OBJECT_ID: 'plm_stock_preparation_sandbox_evil' })
    assert.ok(!Object.prototype.hasOwnProperty.call(config, 'objectId'))
    assert.ok(!JSON.stringify(config).includes('sandbox_evil'))
  })
})

// ---------------------------------------------------------------------------
// 3. Apply body shape
// ---------------------------------------------------------------------------

describe('apply-body-shape rule', () => {
  test('buildApplyBody nests the token under confirm and carries nothing else', () => {
    const body = buildApplyBody({ projectNo: 'P-1', dryRunToken: 'tok-1' })
    assert.deepEqual(Object.keys(body).sort(), ['confirm', 'parameters'])
    assert.deepEqual(body, { parameters: { projectNo: 'P-1' }, confirm: { dryRunToken: 'tok-1' } })
    assert.equal(body.dryRunToken, undefined, 'a top-level dryRunToken is exactly what the route refuses')
  })

  test('buildApplyBody refuses to build a body with no token', () => {
    assert.throws(
      () => buildApplyBody({ projectNo: 'P-1', dryRunToken: '' }),
      (err) => err instanceof BootstrapInputError && err.field === 'APPLY_TOKEN_ABSENT',
    )
  })

  test('the live apply call sends exactly that body', async () => {
    const { state } = await run()
    assert.equal(state.applyBodies.length, 1)
    assert.deepEqual(Object.keys(state.applyBodies[0]).sort(), ['confirm', 'parameters'])
    assert.equal(state.applyBodies[0].confirm.dryRunToken, 'token-1')
  })

  test('the fake models the real refusal: a top-level token is a 400', async () => {
    // Proves the guard above is load-bearing rather than a shape the fake accepts anyway.
    const fake = makeFakeApi()
    const res = await fake.fetchImpl(`${API_BASE}/integration/table-actions/a/apply`, {
      method: 'POST',
      body: JSON.stringify({ parameters: { projectNo: 'P-1' }, dryRunToken: 'tok-1' }),
    })
    assert.equal(res.status, 400)
    assert.equal(JSON.parse(await res.text()).error.code, 'TABLE_ACTION_REQUEST_INVALID')
  })

  test('a dry-run that cannot apply FAILs step 5 before any apply is attempted', async () => {
    const { report, state } = await run({ canApply: false })
    assert.equal(stepById(report, 'acceptance-dry-run').status, 'FAIL')
    assert.equal(state.applyBodies.length, 0)
  })
})

// ---------------------------------------------------------------------------
// 4. Criterion 1 — the human band stays empty
// ---------------------------------------------------------------------------

describe('criterion 1: human band empty, mapped ext_ non-empty', () => {
  const physicalIdFor = physicalId

  test('a clean set of rows passes both halves', () => {
    const rows = [buildTargetRow(1), buildTargetRow(2)]
    const human = assertHumanBandEmpty({
      rows,
      humanFieldIds: [...HUMAN_PRESERVED_FIELD_IDS, ...EXT_HUMAN_FIELDS],
      physicalIdFor,
    })
    assert.equal(human.ok, true)
    assert.deepEqual(human.offendingFieldIds, [])
    const ext = assertMappedExtCellsPresent({ rows, mappedFieldIds: EXT_SYSTEM_FIELDS, physicalIdFor })
    assert.equal(ext.ok, true)
    assert.deepEqual(ext.emptyFieldIds, [])
  })

  // WITNESSED RED #1.
  test('one non-empty human_preserved cell is caught and named by FIELD NAME only', () => {
    const rows = [buildTargetRow(1), buildTargetRow(2, { humanValue: { fieldId: 'notes', value: SECRET_CELL } })]
    const leak = new Set()
    const human = assertHumanBandEmpty({
      rows,
      humanFieldIds: [...HUMAN_PRESERVED_FIELD_IDS, ...EXT_HUMAN_FIELDS],
      physicalIdFor,
      leakGuardValues: leak,
    })
    assert.equal(human.ok, false)
    assert.deepEqual(human.offendingFieldIds, ['notes'])
    assert.ok(!JSON.stringify(human).includes(SECRET_CELL), 'the offending VALUE never leaves the check')
    assert.ok(leak.has(SECRET_CELL), 'but it is handed to the leak guard')
  })

  test("a pack's own human_preserved ext_ column is in the band too", () => {
    const rows = [buildTargetRow(1, { humanValue: { fieldId: 'ext_blankLength', value: '120' } })]
    const human = assertHumanBandEmpty({
      rows,
      humanFieldIds: [...HUMAN_PRESERVED_FIELD_IDS, ...EXT_HUMAN_FIELDS],
      physicalIdFor,
    })
    assert.equal(human.ok, false)
    assert.deepEqual(human.offendingFieldIds, ['ext_blankLength'])
  })

  test('a mapped ext_ target empty on every row is caught (the missing source column)', () => {
    const rows = [buildTargetRow(1), buildTargetRow(2)]
    const ext = assertMappedExtCellsPresent({
      rows,
      mappedFieldIds: [...EXT_SYSTEM_FIELDS, 'ext_neverMapped'],
      physicalIdFor,
    })
    assert.equal(ext.ok, false)
    assert.deepEqual(ext.emptyFieldIds, ['ext_neverMapped'])
  })

  test('non-empty on ONE row is enough — per-cell coercion refusals are legitimate', () => {
    const sparse = buildTargetRow(2)
    sparse.data[physicalId('ext_plmObjectId')] = ''
    const ext = assertMappedExtCellsPresent({
      rows: [buildTargetRow(1), sparse],
      mappedFieldIds: EXT_SYSTEM_FIELDS,
      physicalIdFor,
    })
    assert.equal(ext.ok, true)
  })

  test('the end-to-end run FAILs step 6 when the machine filled the human band', async () => {
    const { report, exitCode } = await run({
      rows: [buildTargetRow(1), buildTargetRow(2, { humanValue: { fieldId: 'notes', value: SECRET_CELL } })],
    })
    assert.equal(exitCode, 1)
    const step = stepById(report, 'acceptance-apply')
    assert.equal(step.status, 'FAIL')
    assert.match(step.reason, /human_preserved cells are non-empty: notes/)
    assert.match(step.fix, /machine must never fill the human band/)
    assert.equal(report.criterion1.verdict, 'FAIL')
    assert.ok(!JSON.stringify(report).includes(SECRET_CELL))
  })

  test('the end-to-end run FAILs step 6 when a mapped ext_ target is empty everywhere', async () => {
    const { report, exitCode } = await run({ mappedFieldIds: [...EXT_SYSTEM_FIELDS, 'ext_neverMapped'] })
    assert.equal(exitCode, 1)
    const step = stepById(report, 'acceptance-apply')
    assert.equal(step.status, 'FAIL')
    assert.match(step.reason, /mapped ext_ targets empty on every row: ext_neverMapped/)
    assert.match(step.fix, /schema\.sql gotcha 2/)
  })

  test('an unconfigured ext-field mapping FAILs rather than passing vacuously', async () => {
    const { report } = await run({ extFieldMapping: null })
    const step = stepById(report, 'acceptance-apply')
    assert.equal(step.status, 'FAIL')
    assert.match(step.reason, /no ext_ field mapping is configured/)
  })

  test('readCell prefers the physical id and falls back to the logical one', () => {
    assert.equal(readCell({ [physicalId('notes')]: 'x' }, 'notes', physicalId), 'x')
    assert.equal(readCell({ notes: 'y' }, 'notes', physicalId), 'y')
    assert.equal(readCell({}, 'notes', physicalId), undefined)
  })

  test('isNonEmptyCell treats blank strings and empties as empty', () => {
    assert.equal(isNonEmptyCell(''), false)
    assert.equal(isNonEmptyCell('   '), false)
    assert.equal(isNonEmptyCell(null), false)
    assert.equal(isNonEmptyCell(undefined), false)
    assert.equal(isNonEmptyCell([]), false)
    assert.equal(isNonEmptyCell({}), false)
    assert.equal(isNonEmptyCell(0), true)
    assert.equal(isNonEmptyCell('a'), true)
  })
})

// ---------------------------------------------------------------------------
// 5. Criterion 2 / idempotence
// ---------------------------------------------------------------------------

describe('idempotence', () => {
  // WITNESSED RED #2.
  test('an all-skip second dry-run is idempotent', () => {
    const v = isIdempotentSecondDryRun({ add: 0, update: 0, skip: 4, inactive: 0, manual_confirm: 0 })
    assert.equal(v.ok, true)
    assert.equal(v.skip, 4)
  })

  test('any add, update, inactive or manual_confirm breaks idempotence', () => {
    assert.equal(isIdempotentSecondDryRun({ add: 1, skip: 3 }).ok, false)
    assert.equal(isIdempotentSecondDryRun({ update: 1, skip: 3 }).ok, false)
    assert.equal(isIdempotentSecondDryRun({ inactive: 1, skip: 3 }).ok, false)
    assert.equal(isIdempotentSecondDryRun({ manual_confirm: 1, skip: 3 }).ok, false)
  })

  test('an empty plan is NOT idempotence — skip must be positive', () => {
    assert.equal(isIdempotentSecondDryRun({ add: 0, update: 0, skip: 0, inactive: 0, manual_confirm: 0 }).ok, false)
    assert.equal(isIdempotentSecondDryRun({}).ok, false)
  })

  test('the end-to-end run FAILs step 7 when the second dry-run still adds rows', async () => {
    const { report, exitCode } = await run({
      secondDryRunCounts: { add: 1, update: 0, skip: 1, inactive: 0, manual_confirm: 0 },
    })
    assert.equal(exitCode, 1)
    const step = stepById(report, 'acceptance-idempotent')
    assert.equal(step.status, 'FAIL')
    assert.match(step.reason, /second dry-run is not all-skip \(add=1/)
    assert.equal(report.criterion2.verdict, 'FAIL')
  })

  test('the pack install replay must report every field alreadyStamped', async () => {
    const { report, exitCode } = await run({
      installReplay: {
        createdFields: ['ext_legacyRowId'],
        stampedExistingFields: [],
        alreadyStampedFields: ['ext_plmObjectId', 'ext_blankLength'],
      },
    })
    assert.equal(exitCode, 1)
    const step = stepById(report, 'customer-pack')
    assert.equal(step.status, 'FAIL')
    assert.match(step.reason, /not idempotent \(created=1/)
  })

  test('a whole second run over an already-installed deployment is clean', async () => {
    const first = await run()
    assert.equal(first.exitCode, 0)
    const second = await run()
    assert.equal(second.exitCode, 0)
    for (const step of second.report.steps) {
      assert.notEqual(step.status, 'FAIL', `${step.id} FAILed on the second run: ${step.reason}`)
    }
    assert.deepEqual(
      first.report.steps.map((s) => `${s.id}:${s.status}`),
      second.report.steps.map((s) => `${s.id}:${s.status}`),
      'a second run reports the same verdicts as the first',
    )
  })
})

// ---------------------------------------------------------------------------
// 6. Values-free self-check
// ---------------------------------------------------------------------------

describe('values-free self-check', () => {
  const env = { ...BASE_ENV, MS_DS_HOST: SECRET_HOST, MS_DS_PASSWORD: SECRET_PASSWORD }

  test('a clean report passes', () => {
    assert.doesNotThrow(() => assertValuesFree({ steps: [{ reason: 'rows=2 written=2' }] }, { env }))
  })

  // WITNESSED RED #4.
  test('a leaked bearer token is refused', () => {
    assert.throws(
      () => assertValuesFree({ reason: `auth used ${SECRET_TOKEN}` }, { env }),
      /VALUES_FREE_SELF_CHECK_FAILED.*env:MS_TOKEN/,
    )
  })

  test('a leaked projectNo, host or password is refused', () => {
    for (const [name, value] of [
      ['MS_PROJECT_NO', SECRET_PROJECT_NO],
      ['MS_DS_HOST', SECRET_HOST],
      ['MS_DS_PASSWORD', SECRET_PASSWORD],
    ]) {
      assert.throws(
        () => assertValuesFree({ note: `x ${value} y` }, { env }),
        new RegExp(`env:${name}`),
        `${name} must be caught`,
      )
    }
  })

  test('a leaked target cell value is refused', () => {
    assert.throws(
      () => assertValuesFree({ detail: `saw ${SECRET_CELL}` }, { env, leakGuardValues: new Set([SECRET_CELL]) }),
      /target-cell-value/,
    )
  })

  test('object KEYS and numbers are not scanned — only string leaves', () => {
    assert.doesNotThrow(() => assertValuesFree({ [SECRET_TOKEN]: 'ok', count: 7 }, { env }))
  })

  test('a short bare number is not scanned (it collides with counts and HTTP statuses)', () => {
    // Documented bound: `200` as a cell value is indistinguishable from `http=200`.
    assert.equal(isScannableValue('200'), false)
    assert.equal(isScannableValue('2'), false)
    assert.equal(isScannableValue('2.5'), false)
    assert.doesNotThrow(() => assertValuesFree({ r: 'http=200' }, { env, leakGuardValues: new Set(['200']) }))
  })

  test('anything with a non-numeric character, or a four-digit number, IS scanned', () => {
    assert.equal(isScannableValue('DRAWING-1'), true)
    assert.equal(isScannableValue('ro'), false, 'a 2-char db user would collide with ordinary words')
    assert.equal(isScannableValue('1234'), true)
    assert.equal(isScannableValue('12.34'), true)
    assert.equal(isScannableValue(''), false)
  })

  test('SCANNED_ENV_NAMES deliberately excludes ids and the port', () => {
    assert.ok(!SCANNED_ENV_NAMES.includes('MS_PACK_ID'))
    assert.ok(!SCANNED_ENV_NAMES.includes('MS_DATA_SOURCE_ID'))
    assert.ok(!SCANNED_ENV_NAMES.includes('MS_TENANT_ID'))
    assert.ok(!SCANNED_ENV_NAMES.includes('MS_DS_PORT'))
    assert.ok(SCANNED_ENV_NAMES.includes('MS_TOKEN'))
    assert.ok(SCANNED_ENV_NAMES.includes('MS_PROJECT_NO'))
  })

  test('the end-to-end report carries no credential, hostname or business value', async () => {
    const { report, lines } = await run({}, { MS_DS_HOST: SECRET_HOST, MS_DS_PASSWORD: SECRET_PASSWORD, MS_DS_DATABASE: 'plmprod', MS_DS_USER: 'ro_user' })
    const blob = `${JSON.stringify(report)}\n${lines.join('\n')}`
    for (const secret of [SECRET_TOKEN, SECRET_PROJECT_NO, SECRET_HOST, SECRET_PASSWORD, SECRET_CELL, 'plmprod', 'ro_user']) {
      assert.ok(!blob.includes(secret), `output leaked ${secret.slice(0, 6)}...`)
    }
    // ...while still carrying the things it is SUPPOSED to: counts, ids and field names.
    assert.ok(blob.includes(OBJECT_ID))
    assert.ok(blob.includes('ext_legacyRowId'))
    assert.ok(blob.includes('"targetRowCount":2'))
  })

  test('a step line is self-checked BEFORE it is emitted', async () => {
    // The streaming half cannot wait for the final report: prove the per-step check runs
    // by making a step reason that would leak, and observing the run throws rather than
    // returning a report with the leak in it.
    const fake = makeFakeApi({
      preflight: {
        status: 200,
        body: okEnvelope({
          ready: false,
          blockers: [{ code: 'STOCK_PREP_PACK_TARGET_MISSING', what: 'x', fix: { kind: 'http', run: `POST /connect ${SECRET_HOST}` } }],
          posture: READY_PREFLIGHT.posture,
        }),
      },
    })
    await assert.rejects(
      runBootstrap({ env: { ...BASE_ENV, MS_DS_HOST: SECRET_HOST }, fetchImpl: fake.fetchImpl }),
      /VALUES_FREE_SELF_CHECK_FAILED/,
    )
  })
})

// ---------------------------------------------------------------------------
// 7. Source wiring, queue, CLI
// ---------------------------------------------------------------------------

describe('source wiring', () => {
  test('an absent system is created ACTIVE, pointing at the data source', async () => {
    const { report, state } = await run()
    assert.equal(report.sourceWiring.systemMode, 'created')
    assert.equal(report.sourceWiring.status, 'active')
    assert.equal(report.sourceWiring.kind, 'data-source:sql-readonly')
    assert.equal(state.upsertBodies[0].status, 'active', 'created explicitly active, never left at the default')
    assert.equal(state.upsertBodies[0].config.dataSourceId, BASE_ENV.MS_DATA_SOURCE_ID)
  })

  test("an existing INACTIVE system is activated WITHOUT rewriting the deployment's config", async () => {
    const stale = { ...CONFIGURED_SYSTEM, status: 'inactive', config: { ...CONFIGURED_SYSTEM.config } }
    const { report, state } = await run({ existingSystem: stale })
    assert.equal(report.sourceWiring.systemMode, 'activated')
    assert.equal(report.sourceWiring.status, 'active')
    const body = state.upsertBodies[0]
    assert.equal(body.status, 'active')
    assert.equal(body.config, undefined, 'a config key would REPLACE the stored public config')
    assert.equal(body.role, undefined, 'role cannot be changed after creation')
    // The stored config survived untouched — including a schema this script never knew about.
    assert.deepEqual(state.system.config, { dataSourceId: 'ds-plm-1', schema: 'public' })
  })

  test('an already-active system is left completely alone', async () => {
    const { report, state } = await run({ existingSystem: { ...CONFIGURED_SYSTEM, config: { ...CONFIGURED_SYSTEM.config } } })
    assert.equal(report.sourceWiring.systemMode, 'already_active')
    assert.equal(state.upsertBodies.length, 0, 'no write at all when there is nothing to move')
  })

  test('a system bound to a DIFFERENT data source FAILs rather than being repointed', async () => {
    const other = { ...CONFIGURED_SYSTEM, config: { dataSourceId: 'ds-somebody-elses' } }
    const { report, exitCode, state } = await run({ existingSystem: other })
    assert.equal(exitCode, 1)
    const step = stepById(report, 'source-wiring')
    assert.equal(step.status, 'FAIL')
    assert.match(step.reason, /config\.dataSourceId does not match MS_DATA_SOURCE_ID/)
    assert.match(step.fix, /will not silently repoint a configured system/)
    assert.equal(state.upsertBodies.length, 0)
  })

  test('a system of the wrong kind FAILs — kind cannot be changed after creation', async () => {
    const { report } = await run({ existingSystem: { ...CONFIGURED_SYSTEM, kind: 'k3-wise-webapi' } })
    const step = stepById(report, 'source-wiring')
    assert.equal(step.status, 'FAIL')
    assert.match(step.reason, /kind=k3-wise-webapi \(expected data-source:sql-readonly\)/)
  })

  test('a system left inactive FAILs with the reconcile-requires-active fix', async () => {
    const { report, exitCode } = await run({ externalSystemStatus: 'inactive' })
    assert.equal(exitCode, 1)
    const step = stepById(report, 'source-wiring')
    assert.equal(step.status, 'FAIL')
    assert.match(step.reason, /status=inactive \(expected active\)/)
    assert.match(step.fix, /reconcile requires status active .*dry-run does not/)
  })

  test('MS_EXTERNAL_SYSTEM_ID is required — the action binding is never guessed', async () => {
    assert.throws(
      () => readEnvConfig({ ...BASE_ENV, MS_EXTERNAL_SYSTEM_ID: undefined }),
      (err) => err instanceof BootstrapInputError && err.field === 'MS_EXTERNAL_SYSTEM_ID',
    )
    // ...and no default is silently synthesised from the data source id.
    const config = readEnvConfig(BASE_ENV)
    assert.equal(config.externalSystemId, 'plm-bom-source')
    assert.ok(!config.externalSystemId.includes(config.dataSourceId))
  })

  test('without connection env the data source is only verified, never created', async () => {
    const { report, state } = await run()
    assert.equal(report.sourceWiring.dataSourceMode, 'verified_existing')
    assert.ok(!state.calls.includes('POST /data-sources'))
  })

  test('with connection env the data source is registered read-only', async () => {
    const { report, state } = await run({}, { MS_DS_HOST: SECRET_HOST, MS_DS_DATABASE: 'plmprod', MS_DS_USER: 'ro_reader', MS_DS_PASSWORD: SECRET_PASSWORD })
    assert.ok(state.calls.includes('POST /data-sources'))
    assert.equal(report.sourceWiring.dataSourceMode, 'registered')
  })

  test('a failed connection test FAILs the step', async () => {
    const { report } = await run({ externalSystemTest: { ok: false, code: 'connection_refused' } })
    const step = stepById(report, 'source-wiring')
    assert.equal(step.status, 'FAIL')
    assert.match(step.reason, /external-system test failed/)
  })
})

describe('confirmation queue', () => {
  test('confirms keep_multiple_rows and reports the E1 re-hold as expected, not a failure', async () => {
    const { report, state } = await run()
    const step = stepById(report, 'confirmation-queue')
    assert.equal(step.status, 'OK')
    assert.equal(state.confirmBodies.length, 2)
    for (const body of state.confirmBodies) {
      assert.equal(body.resolutionAction, 'keep_multiple_rows')
      assert.deepEqual(Object.keys(body).sort(), ['decisionId', 'inputFingerprint', 'resolutionAction'])
    }
    // one released, one still held — the documented E1 asymmetry
    assert.equal(report.confirmationQueue.pendingBefore, 2)
    assert.equal(report.confirmationQueue.pendingAfter, 1)
    assert.equal(report.confirmationQueue.releasedCount, 1)
    assert.equal(report.confirmationQueue.e1ReheldCount, 1)
    assert.match(report.confirmationQueue.e1Reference, /o1-conflict-matrix-20260829\.md$/)
    assert.equal(state.reconcileCalls, 2)
  })

  test('every group releasing is fine too (no canonical rows existed)', async () => {
    const { report } = await run({ queueAfter: defaultQueue([]) })
    const step = stepById(report, 'confirmation-queue')
    assert.equal(step.status, 'OK')
    assert.equal(report.confirmationQueue.pendingAfter, 0)
    assert.equal(report.confirmationQueue.e1ReheldCount, 0)
  })

  test('confirming must never GROW the queue', async () => {
    const { report, exitCode } = await run({
      queueAfter: defaultQueue([queueRow('dec-2'), queueRow('dec-3'), queueRow('dec-4')]),
    })
    assert.equal(exitCode, 1)
    assert.match(stepById(report, 'confirmation-queue').reason, /grew the pending queue \(2 -> 3\)/)
  })

  test('a queue row carrying an unregistered key FAILs the values-free contract', async () => {
    const leaky = queueRow('dec-1')
    leaky.resolvedValue = SECRET_CELL
    const { report, exitCode } = await run({ queueBefore: defaultQueue([leaky]) })
    assert.equal(exitCode, 1)
    const step = stepById(report, 'confirmation-queue')
    assert.equal(step.status, 'FAIL')
    assert.match(step.reason, /unregistered key\(s\): resolvedValue/)
    assert.ok(!JSON.stringify(report).includes(SECRET_CELL))
  })

  test('the registered key set is exactly the queue projection', () => {
    assert.deepEqual([...QUEUE_ROW_KEYS], [...QUEUE_ROW_KEYS].sort())
    assert.equal(QUEUE_ROW_KEYS.length, 11)
    assert.ok(QUEUE_ROW_KEYS.includes('resolvedValuePresent'))
    assert.ok(!QUEUE_ROW_KEYS.includes('resolvedValue'))
  })

  test('a not-active source is reported against the reconcile-requires-active lesson', async () => {
    const { report } = await run({ reconcileNotActive: true })
    const step = stepById(report, 'confirmation-queue')
    assert.equal(step.status, 'FAIL')
    assert.match(step.fix, /requireActive:true/)
  })

  test('MS_SKIP_QUEUE_SMOKE=1 SKIPs the step and calls nothing', async () => {
    const { report, state } = await run({}, { MS_SKIP_QUEUE_SMOKE: '1' })
    const step = stepById(report, 'confirmation-queue')
    assert.equal(step.status, 'SKIP')
    assert.equal(state.reconcileCalls, 0)
  })

  test('an empty duplicate queue SKIPs honestly', async () => {
    const { report, exitCode } = await run({ queueBefore: defaultQueue([]) })
    assert.equal(exitCode, 0)
    assert.equal(stepById(report, 'confirmation-queue').status, 'SKIP')
  })
})

describe('CLI contract', () => {
  const explode = () => {
    throw new Error('--dry must not call the network')
  }

  test('--dry prints the plan and calls nothing', async () => {
    let out = ''
    const code = await main(['--dry'], {}, { fetchImpl: explode, stdout: (s) => { out += s } })
    assert.equal(code, 0)
    assert.match(out, /8 steps, --dry: nothing is called/)
    for (const step of STEP_PLAN) assert.ok(out.includes(step.id), `plan omits ${step.id}`)
    assert.ok(!out.includes('MS_TOKEN=') , 'the plan prints no env VALUES')
  })

  test('renderPlan is env-free: templates only', () => {
    const plan = renderPlan()
    assert.ok(plan.includes(':packId'))
    assert.ok(plan.includes(':actionId'))
    assert.ok(!plan.includes(SECRET_TOKEN))
  })

  test('--help exits 0 without calling anything', async () => {
    let out = ''
    const code = await main(['--help'], {}, { fetchImpl: explode, stdout: (s) => { out += s } })
    assert.equal(code, 0)
    assert.match(out, /Everything else is env/)
  })

  test('an unknown argument is exit 2, never ignored', async () => {
    let err = ''
    const code = await main(['--object-id=plm_stock_preparation_sandbox_x'], {}, { fetchImpl: explode, stderr: (s) => { err += s } })
    assert.equal(code, 2)
    assert.match(err, /unknown argument/)
  })

  test('missing required env is exit 2 and names the field', async () => {
    let err = ''
    const code = await main([], { MS_API: API_BASE, MS_DATA_SOURCE_ID: 'ds-1' }, { fetchImpl: explode, stderr: (s) => { err += s } })
    assert.equal(code, 2)
    assert.match(err, /env MS_TOKEN is required/)
  })

  test('parseArgs accepts only --dry and --help', () => {
    assert.deepEqual(parseArgs([]), { dry: false, help: false })
    assert.deepEqual(parseArgs(['--dry']), { dry: true, help: false })
    assert.throws(() => parseArgs(['--out', 'x.json']), (e) => e instanceof BootstrapInputError && e.field === 'ARGV')
  })

  test('a green run exits 0 and prints a machine-readable report line', async () => {
    const fake = makeFakeApi()
    let out = ''
    const code = await main([], BASE_ENV, { fetchImpl: fake.fetchImpl, stdout: (s) => { out += s } })
    assert.equal(code, 0)
    assert.match(out, /\nPASS — \d+ OK, \d+ SKIP, 0 FAIL of 8 steps\n/)
    const line = out.split('\n').find((l) => l.startsWith('STOCK_PREP_BOOTSTRAP_REPORT='))
    const parsed = JSON.parse(line.slice('STOCK_PREP_BOOTSTRAP_REPORT='.length))
    assert.equal(parsed.summary.pass, true)
    assert.equal(parsed.steps.length, 8)
  })

  test('a red run exits 1 and names the failed step and its fix', async () => {
    const fake = makeFakeApi({ externalSystemStatus: 'inactive' })
    let out = ''
    const code = await main([], BASE_ENV, { fetchImpl: fake.fetchImpl, stdout: (s) => { out += s } })
    assert.equal(code, 1)
    assert.match(out, /FAIL — step \[4\/8\] source-wiring/)
    assert.match(out, /fix: reconcile requires status active/)
  })
})

describe('plan integrity', () => {
  test('the step plan and the runner table agree', () => {
    assert.equal(STEP_PLAN.length, STEP_COUNT)
    assert.deepEqual(
      STEP_PLAN.map((s) => s.id),
      ['preflight', 'managed-tables', 'customer-pack', 'source-wiring', 'acceptance-dry-run', 'acceptance-apply', 'acceptance-idempotent', 'confirmation-queue'],
    )
  })

  test('no step plan route mentions a fence env var', () => {
    const blob = JSON.stringify(STEP_PLAN) + renderPlan()
    assert.ok(!blob.includes('INTEGRATION_CORE_B2A_REGISTRY_PATH'))
    assert.ok(!blob.includes('INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS'))
  })

  test('the human band is imported from the plugin template, not restated', () => {
    assert.ok(HUMAN_PRESERVED_FIELD_IDS.includes('notes'))
    assert.ok(HUMAN_PRESERVED_FIELD_IDS.includes('warehouseConfirmation'))
    assert.equal(HUMAN_PRESERVED_FIELD_IDS.length, 8)
  })
})
