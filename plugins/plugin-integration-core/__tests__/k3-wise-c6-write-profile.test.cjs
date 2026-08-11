'use strict'

// K3WriteDecision (owner, 20260805) — content-bound approval for K3 Material Save, end to end.
// This suite drives the REAL C6 planner (dryRunExternalWrite / applyExternalWrite) against the
// REAL K3 adapter over a counting mock fetch — the only fakes are the HTTP wire and the token
// store. What it proves:
//   * the chain the delivery names: read -> plan -> dry-run token -> apply -> Save (0 Submit/Audit)
//   * the approval is CONTENT-bound: change the source rows between dry-run and apply -> 409
//   * the plan-level row bound IS the profile's frozen cap: 4 source rows -> not_applyable, no token
//   * fail-closed capability: a target config without the named customer profile never plans
//   * lookup "not found" is a business-level miss (-> add), transport failure fails the dry-run

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  applyExternalWrite,
  dryRunExternalWrite,
} = require('../lib/external-write-dry-run.cjs')
const {
  K3_WISE_C6_MAX_APPLY_ROWS,
  K3_WISE_C6_WRITE_PROFILE,
  createK3WiseC6WriteSource,
  deriveK3WiseC6PlannerTargetConfig,
} = require('../lib/adapters/k3-wise-c6-write-profile.cjs')
const { createK3WiseWebApiAdapter } = require('../lib/adapters/k3-wise-webapi-adapter.cjs')

const PROFILE_ID = 'material-k3wise-customer-profile-v1'
const {
  K3WISE_MATERIAL_LIST_B4_TEMPLATE: RATIFIED_B4_TEMPLATE,
} = require('../lib/read-source-k3-material-list-b4-contract.cjs')

// ADVERSARIAL REVIEW P1-2 (20260805): the first version's stub IGNORED list()'s arguments and
// baked in the scope, so mutating the resolver's scope/filters left every suite green — the
// gate had zero real coverage. This is a mini-store that HONOURS its arguments: tenant and
// workspace exact (null-distinct, like the real scopeWhere), status filter, and the page limit.
// Any filter the resolver drops is now visible as a wrong row surviving.
function b4Store(rows) {
  return {
    async list(input = {}) {
      const wanted = input.workspaceId ?? null
      let out = rows.filter((row) => {
        if (row.tenantId !== input.tenantId) return false
        if ((row.workspaceId ?? null) !== wanted) return false
        if (input.status !== undefined && row.status !== input.status) return false
        return true
      })
      const limit = Number.isInteger(input.limit) && input.limit > 0 ? input.limit : 100
      return out.slice(0, limit)
    },
  }
}
function b4Of(rows, overrides = {}) {
  return {
    readSourceConfigs: b4Store(rows),
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    pipelineSystemIds: ['source_1', 'k3-target-1'],
    // REVIEW P2-2: the instance gate is now FAIL-CLOSED — a binding with no way to check its
    // identity is refused rather than waved through. Cases in this file that are NOT about
    // instance identity (page exhaustion, ratified-contract matching, …) therefore need a digest
    // source, or they fail on a property they are not testing.
    //
    // This default is DELIBERATELY PERMISSIVE — one constant, so every record reads as the same
    // instance. That is stated rather than hidden: the cases that actually exercise identity
    // OVERRIDE it with per-record digests, and a fixture this permissive would be a defect if it
    // were the only thing standing behind the gate.
    instanceDigestOf: async () => 'fixture-single-instance',
    ...overrides,
  }
}
// Row shape as the STORE emits it: actionProfileVersion lives in the nested config
// (review P2-1 — the first version read a top-level field the store never emits, so the
// "identity triple" carried a permanently empty member).
const { normalizeReadSourceConfig } = require('../lib/read-source-config.cjs')
const { __internals: { contentKeyFor } } = require('../lib/read-source-config-store.cjs')

function b4Row(overrides = {}) {
  const { config: configOverride, contentKey: contentKeyOverride, ...rest } = overrides
  const config = {
    ...JSON.parse(JSON.stringify(RATIFIED_B4_TEMPLATE)),
    systemId: 'source_1',
    ...(configOverride || {}),
  }
  // REVIEW P2-E4: the contentKey is now the gate's comparator, so the fixture must carry the
  // REAL one — computed by the store's own contentKeyFor over the normalized config, exactly
  // as a genuine mint would. A hand-written string would make every gate assertion vacuous.
  let realContentKey
  try { realContentKey = contentKeyFor(normalizeReadSourceConfig(config)) } catch { realContentKey = 'unnormalizable' }
  return {
    id: 'rsc_b4_1',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    object: 'material',
    status: 'approved',
    version: 3,
    contentKey: contentKeyOverride !== undefined ? contentKeyOverride : realContentKey,
    config,
    ...rest,
  }
}
const APPROVED_B4_ROW = Object.freeze(b4Row())

function memoryStore() {
  const map = new Map()
  return {
    async get(key) { return map.get(key) || null },
    async set(key, value) { map.set(key, JSON.parse(JSON.stringify(value))) },
    async consume(key) { const v = map.get(key) || null; map.delete(key); return v },
    async delete(key) { map.delete(key) },
  }
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}

// Mock K3: login, GetDetail (existing row for MAT-C6-EXIST, business-fail for everything
// else — K3's real "not found" shape), Save success. Counts every path.
function mockK3({ existing = {}, fallbackDetail = null, echoOnly = false } = {}) {
  const calls = []
  const impl = async (url, init) => {
    const parsed = new URL(url)
    calls.push({ pathname: parsed.pathname, body: init && init.body ? JSON.parse(init.body) : null })
    if (parsed.pathname.endsWith('/Login')) {
      return jsonResponse(200, { success: true, sessionId: 'c6-session' })
    }
    if (parsed.pathname.endsWith('/Material/GetDetail')) {
      const requestData = calls[calls.length - 1].body && calls[calls.length - 1].body.Data
      // The adapter sends the key under Data.FNumber (verified against the real request body).
      const number = requestData ? requestData.FNumber || requestData.Number : undefined
      const row = existing[number]
      if (row) {
        return jsonResponse(200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ FStatus: true, FItemID: row.FItemID, Data: row }],
        })
      }
      if (echoOnly) {
        return jsonResponse(200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ FStatus: true, Data: { FNumber: number } }],
        })
      }
      if (fallbackDetail) {
        return jsonResponse(200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ FStatus: true, FItemID: fallbackDetail.FItemID, Data: fallbackDetail }],
        })
      }
      // K3's business-level miss: FStatus false — businessSuccess() is false for this shape.
      return jsonResponse(200, {
        StatusCode: 200,
        Message: 'Successful',
        Data: [{ FStatus: false, FItemID: 0, FMessage: 'required base-data object missing' }],
      })
    }
    if (parsed.pathname.endsWith('/Material/Save')) {
      return jsonResponse(200, {
        StatusCode: 200,
        Message: 'Successful',
        Data: [{ FStatus: true, FItemID: 9001 }],
      })
    }
    return jsonResponse(404, { success: false, message: 'not found' })
  }
  return { impl, calls }
}

function k3TargetSystem(overrides = {}) {
  return {
    id: 'k3-target-1',
    name: 'K3 target',
    kind: 'erp:k3-wise-webapi',
    role: 'target',
    status: 'active',
    credentials: { username: 'u', password: 'p', acctId: 'AIS' },
    config: {
      baseUrl: 'https://k3.example.test',
      autoSubmit: false,
      autoAudit: false,
      objects: { material: { profile: PROFILE_ID } },
      ...(overrides.config || {}),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'config')),
  }
}

function pipelineFixture() {
  return {
    id: 'pipe_k3_c6',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    sourceSystemId: 'source_1',
    sourceObject: 'materials',
    targetSystemId: 'k3-target-1',
    targetObject: 'material',
    createdBy: 'owner-7',
    fieldMappings: [
      { sourceField: 'code', targetField: 'FNumber', validation: [{ type: 'required' }] },
      { sourceField: 'name', targetField: 'FName', validation: [{ type: 'required' }] },
      { sourceField: 'spec', targetField: 'FModel' },
    ],
  }
}

function sourceAdapterOf(rows) {
  return {
    async read() {
      return { records: rows, done: true }
    },
  }
}

// Assemble inputs exactly the way http-routes' resolveC6WritePlanInputs does for a K3 target.
function c6Inputs({ rows, fetchPair, targetOverrides, tokenStore, maxRows }) {
  const targetSystem = k3TargetSystem(targetOverrides || {})
  const pipeline = pipelineFixture()
  const flatConfig = deriveK3WiseC6PlannerTargetConfig({
    system: targetSystem,
    object: pipeline.targetObject,
    fieldMappings: pipeline.fieldMappings,
  })
  const writeSource = createK3WiseC6WriteSource({
    system: targetSystem,
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: fetchPair.impl }),
    b4: b4Of([APPROVED_B4_ROW]),
  })
  return {
    pipeline,
    sourceSystem: { id: 'source_1', kind: 'data-source:sql-readonly' },
    targetSystem: { ...targetSystem, config: flatConfig },
    sourceAdapter: sourceAdapterOf(rows),
    dataSourceWrites: writeSource,
    targetWriteProfile: K3_WISE_C6_WRITE_PROFILE,
    tokenStore,
    dryRunUser: 'operator-1',
    dataSourceOwnerPrincipal: 'owner-principal-1',
    maxRows: maxRows !== undefined ? maxRows : K3_WISE_C6_MAX_APPLY_ROWS,
  }
}

test('the flat planner config derives from the customer profile: key + schema-known writables', () => {
  const cfg = deriveK3WiseC6PlannerTargetConfig({
    system: k3TargetSystem(),
    object: 'material',
    fieldMappings: pipelineFixture().fieldMappings,
  })
  assert.deepEqual(cfg.keyFields, ['FNumber'])
  assert.deepEqual(cfg.writableFields, ['FName', 'FModel'])
  assert.equal(cfg.object, 'material')
})

test('REVIEW P2: a mapped target the write cannot carry is REFUSED, never silently dropped', () => {
  assert.throws(
    () => deriveK3WiseC6PlannerTargetConfig({
      system: k3TargetSystem(),
      object: 'material',
      fieldMappings: pipelineFixture().fieldMappings.concat([
        { sourceField: 'ghost', targetField: 'FNotInSchema' },
      ]),
    }),
    (error) => error.details && error.details.code === 'K3_C6_UNSUPPORTED_TARGET_FIELD',
    'a silent drop means the pipeline LOOKS configured while quietly writing less',
  )
})

test('REVIEW P1: a field the FE overlay removed from the EFFECTIVE schema is refused — preview must equal write', () => {
  // The operator overlay REPLACES the schema array wholly. FModel is in the profile literal
  // but absent from this overlay, so the Save body cannot carry it — the old literal-only
  // allowlist would have previewed and fingerprinted it while the Save silently dropped it.
  const overlaySystem = k3TargetSystem({
    config: {
      objects: {
        material: {
          profile: PROFILE_ID,
          schema: [
            { name: 'FNumber', label: 'Code', type: 'string', required: true },
            { name: 'FName', label: 'Name', type: 'string', required: true },
          ],
        },
      },
    },
  })
  assert.throws(
    () => deriveK3WiseC6PlannerTargetConfig({
      system: overlaySystem,
      object: 'material',
      fieldMappings: pipelineFixture().fieldMappings, // maps spec -> FModel
    }),
    (error) => error.details && error.details.code === 'K3_C6_UNSUPPORTED_TARGET_FIELD'
      && error.details.profileSanctioned === true && error.details.saveComposable === false,
  )
  // And the inverse: a field the overlay ADDS but the profile deliberately omits (FBaseUnitID
  // broke the M1 dry-run) must not smuggle back in through the effective schema.
  const smuggleSystem = k3TargetSystem({
    config: {
      objects: {
        material: {
          profile: PROFILE_ID,
          schema: [
            { name: 'FNumber', label: 'Code', type: 'string', required: true },
            { name: 'FName', label: 'Name', type: 'string', required: true },
            { name: 'FBaseUnitID', label: 'Base unit', type: 'reference', reference: { kind: 'number' } },
          ],
        },
      },
    },
  })
  assert.throws(
    () => deriveK3WiseC6PlannerTargetConfig({
      system: smuggleSystem,
      object: 'material',
      fieldMappings: [
        { sourceField: 'code', targetField: 'FNumber', validation: [{ type: 'required' }] },
        { sourceField: 'name', targetField: 'FName', validation: [{ type: 'required' }] },
        { sourceField: 'bu', targetField: 'FBaseUnitID' },
      ],
    }),
    (error) => error.details && error.details.code === 'K3_C6_UNSUPPORTED_TARGET_FIELD'
      && error.details.profileSanctioned === false && error.details.saveComposable === true,
  )
})

test('fail-closed: a target without the named customer profile cannot even derive a plan config', () => {
  assert.throws(
    () => deriveK3WiseC6PlannerTargetConfig({
      system: k3TargetSystem({ config: { objects: { material: { savePath: '/K3API/Material/Save' } } } }),
      object: 'material',
      fieldMappings: pipelineFixture().fieldMappings,
    }),
    /material.profile/,
  )
})

test('roundtrip: dry-run plans add+update, mints a token; apply consumes it and Saves — 0 Submit, 0 Audit', async () => {
  const tokenStore = memoryStore()
  const fetchPair = mockK3({
    existing: {
      'MAT-C6-EXIST': { FNumber: 'MAT-C6-EXIST', FItemID: 1001, FName: 'Old name', FModel: 'SPEC-OLD' },
    },
  })
  const rows = [
    { code: 'MAT-C6-NEW', name: 'Brand new', spec: 'SPEC-N' },
    { code: 'MAT-C6-EXIST', name: 'New name', spec: 'SPEC-OLD' },
  ]

  const dryRun = await dryRunExternalWrite(c6Inputs({ rows, fetchPair, tokenStore }))
  assert.equal(dryRun.status, 'ready')
  assert.ok(dryRun.dryRunToken, 'a ready dry-run must mint a token')
  assert.equal(dryRun.counts.sourceRows, 2)
  assert.equal(dryRun.counts.add, 1, 'business-level GetDetail miss classifies as add')
  assert.equal(dryRun.counts.update, 1, 'differing FName classifies as update')
  const dryRunSaves = fetchPair.calls.filter((c) => c.pathname.endsWith('/Material/Save'))
  assert.equal(dryRunSaves.length, 0, 'dry-run must not write')

  const apply = await applyExternalWrite({
    ...c6Inputs({ rows, fetchPair, tokenStore }),
    dryRunToken: dryRun.dryRunToken,
    applyUser: 'operator-1',
  })
  assert.equal(apply.counts.written, 2)
  assert.equal(apply.counts.failed, 0)

  const saves = fetchPair.calls.filter((c) => c.pathname.endsWith('/Material/Save'))
  assert.equal(saves.length, 2, 'one Save per planned row')
  const savedNumbers = saves.map((c) => c.body && c.body.Data && c.body.Data.FNumber).sort()
  assert.deepEqual(savedNumbers, ['MAT-C6-EXIST', 'MAT-C6-NEW'])
  assert.equal(fetchPair.calls.filter((c) => /\/(Submit|Audit)$/.test(c.pathname)).length, 0,
    'save-only must survive the entire C6 lifecycle')
})

test('lookup ignores a successful GetDetail record whose normalized key does not exactly match', async () => {
  const fetchPair = mockK3({
    // Reproduces the onsite failure shape: an unknown requested key receives a successful
    // default/template detail record for a different material. That record is not existence
    // evidence for the requested key and must therefore plan as add.
    fallbackDetail: { FNumber: '  TEMPLATE-MATERIAL  ', FItemID: 7001, FName: 'Template' },
  })
  const dryRun = await dryRunExternalWrite(c6Inputs({
    rows: [{ code: 'NEW-MATERIAL', name: 'New material', spec: 'SPEC-N' }],
    fetchPair,
    tokenStore: memoryStore(),
  }))

  assert.equal(dryRun.counts.add, 1)
  assert.equal(dryRun.counts.update, 0)
  assert.equal(dryRun.counts.held, 0)
})

test('lookup ignores an echo-only successful GetDetail envelope with no independent material identity', async () => {
  const fetchPair = mockK3({
    // Live-shape regression: the endpoint accepts the request and echoes FNumber, but neither
    // a stable material id nor FName was independently returned.
    echoOnly: true,
  })
  const dryRun = await dryRunExternalWrite(c6Inputs({
    rows: [{ code: 'ECHO-ONLY-MATERIAL', name: 'New material', spec: 'SPEC-N' }],
    fetchPair,
    tokenStore: memoryStore(),
  }))

  assert.equal(dryRun.counts.add, 1)
  assert.equal(dryRun.counts.update, 0)
  assert.equal(dryRun.counts.held, 0)
})

test('lookup ignores an empty successful GetDetail detail even when the adapter correlates its request key', async () => {
  const dryRun = await dryRunExternalWrite(c6Inputs({
    rows: [{ code: 'SYNTHETIC-KEY-MATERIAL', name: 'New material', spec: 'SPEC-N' }],
    fetchPair: mockK3({ fallbackDetail: {} }),
    tokenStore: memoryStore(),
  }))

  assert.equal(dryRun.counts.add, 1)
  assert.equal(dryRun.counts.update, 0)
  assert.equal(dryRun.counts.held, 0)
})

test('lookup keeps a returned record whose normalized key exactly matches the request', async () => {
  const fetchPair = mockK3({
    existing: {
      'MATCHED-MATERIAL': {
        FNumber: '  MATCHED-MATERIAL  ',
        FItemID: 7002,
        FName: 'Old name',
        FModel: 'SPEC-OLD',
      },
    },
  })
  const dryRun = await dryRunExternalWrite(c6Inputs({
    rows: [{ code: 'MATCHED-MATERIAL', name: 'New name', spec: 'SPEC-OLD' }],
    fetchPair,
    tokenStore: memoryStore(),
  }))

  assert.equal(dryRun.counts.add, 0)
  assert.equal(dryRun.counts.update, 1)
  assert.equal(dryRun.counts.held, 0)
})

test('lookup preserves multiple exact key matches so the planner holds the ambiguous row', async () => {
  const input = c6Inputs({
    rows: [{ code: 'AMBIGUOUS-MATERIAL', name: 'New name', spec: 'SPEC-N' }],
    fetchPair: mockK3(),
    tokenStore: memoryStore(),
  })
  const targetSystem = k3TargetSystem()
  input.dataSourceWrites = createK3WiseC6WriteSource({
    system: targetSystem,
    createAdapter: () => ({
      async read() {
        return {
          records: [
            { FNumber: 'AMBIGUOUS-MATERIAL', FName: 'First' },
            { FNumber: '  AMBIGUOUS-MATERIAL  ', FName: 'Second' },
          ],
        }
      },
    }),
    b4: b4Of([APPROVED_B4_ROW]),
  })

  const dryRun = await dryRunExternalWrite(input)
  assert.equal(dryRun.counts.add, 0)
  assert.equal(dryRun.counts.update, 0)
  assert.equal(dryRun.counts.held, 1)
  assert.equal(dryRun.canApply, false)
})

test('CONTENT BINDING: source rows changed between dry-run and apply -> 409, nothing written', async () => {
  const tokenStore = memoryStore()
  const fetchPair = mockK3()
  const rows = [{ code: 'MAT-C6-A', name: 'Original', spec: 'S1' }]

  const dryRun = await dryRunExternalWrite(c6Inputs({ rows, fetchPair, tokenStore }))
  assert.equal(dryRun.status, 'ready')

  const changed = [{ code: 'MAT-C6-A', name: 'TAMPERED AFTER APPROVAL', spec: 'S1' }]
  await assert.rejects(
    applyExternalWrite({
      ...c6Inputs({ rows: changed, fetchPair, tokenStore }),
      dryRunToken: dryRun.dryRunToken,
      applyUser: 'operator-1',
    }),
    (error) => error && error.code === 'C6_WRITE_DRY_RUN_TOKEN_MISMATCH',
  )
  assert.equal(fetchPair.calls.filter((c) => c.pathname.endsWith('/Material/Save')).length, 0,
    'the human approved OTHER content — nothing may reach K3')
})

test('the plan-level bound IS the frozen cap: a 4th source row makes the run not_applyable, no token', async () => {
  const tokenStore = memoryStore()
  const fetchPair = mockK3()
  const rows = [1, 2, 3, 4].map((i) => ({ code: 'MAT-C6-' + i, name: 'Material ' + i, spec: 'S' }))
  // Source paginates: first page returns cap rows with a cursor — the planner stops at the
  // cap and marks the read truncated, exactly the first-version boundary.
  const sourceAdapter = {
    async read({ limit, cursor }) {
      if (!cursor) return { records: rows.slice(0, limit), nextCursor: 'more' }
      return { records: rows.slice(3), done: true }
    },
  }
  const input = c6Inputs({ rows, fetchPair, tokenStore })
  input.sourceAdapter = sourceAdapter
  const dryRun = await dryRunExternalWrite(input)
  assert.equal(dryRun.status, 'not_applyable')
  assert.equal(dryRun.dryRunToken, null, 'a truncated read must not mint an applyable token')
  assert.equal(K3_WISE_C6_MAX_APPLY_ROWS, 3, 'single source of the bound: the profile literal')
})

test('fail-closed capability: profile deselected between derive and plan -> unsafe, refused before any row', async () => {
  const tokenStore = memoryStore()
  const fetchPair = mockK3()
  // Derive with the profile present, then hand the WRITE SOURCE a system whose profile is
  // gone — the capability gate (not the deriver) must catch it.
  const armed = k3TargetSystem()
  const disarmed = k3TargetSystem({ config: { objects: { material: { savePath: '/K3API/Material/Save' } } } })
  const pipeline = pipelineFixture()
  const flatConfig = deriveK3WiseC6PlannerTargetConfig({
    system: armed, object: 'material', fieldMappings: pipeline.fieldMappings,
  })
  await assert.rejects(
    dryRunExternalWrite({
      pipeline,
      sourceSystem: { id: 'source_1', kind: 'data-source:sql-readonly' },
      targetSystem: { ...armed, config: flatConfig },
      sourceAdapter: sourceAdapterOf([{ code: 'M', name: 'N' }]),
      dataSourceWrites: createK3WiseC6WriteSource({
        system: disarmed,
        createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: fetchPair.impl }),
        b4: b4Of([APPROVED_B4_ROW]),
      }),
      targetWriteProfile: K3_WISE_C6_WRITE_PROFILE,
      tokenStore,
      dryRunUser: 'operator-1',
      dataSourceOwnerPrincipal: 'owner-principal-1',
      maxRows: 3,
    }),
    (error) => /customer-profile locked/.test(String(error && error.message)),
  )
  assert.equal(fetchPair.calls.length, 0, 'capability refusal must precede ALL network activity')
})

test('lookup transport failure fails the dry-run closed (only the business-level miss maps to add)', async () => {
  const tokenStore = memoryStore()
  const calls = []
  const impl = async (url) => {
    const parsed = new URL(url)
    calls.push(parsed.pathname)
    if (parsed.pathname.endsWith('/Login')) {
      return jsonResponse(200, { success: true, sessionId: 's' })
    }
    throw new Error('connection reset')
  }
  await assert.rejects(
    dryRunExternalWrite(c6Inputs({
      rows: [{ code: 'MAT-T', name: 'T' }],
      fetchPair: { impl, calls },
      tokenStore,
    })),
    (error) => {
      const code = error && error.details && error.details.code
      return code === 'K3_WISE_READ_FAILED'
    },
  )
})

test('a Save business failure lands as the registered closed token, not WRITE_FAILED', async () => {
  const tokenStore = memoryStore()
  const calls = []
  const impl = async (url, init) => {
    const parsed = new URL(url)
    calls.push(parsed.pathname)
    if (parsed.pathname.endsWith('/Login')) return jsonResponse(200, { success: true, sessionId: 's' })
    if (parsed.pathname.endsWith('/Material/GetDetail')) {
      return jsonResponse(200, { StatusCode: 200, Message: 'Successful', Data: [{ FStatus: false, FItemID: 0, FMessage: 'missing' }] })
    }
    if (parsed.pathname.endsWith('/Material/Save')) {
      // Business-level Save refusal — the adapter COLLECTS this as a failed row (returns
      // counts); the write source must CONVERT it to a throw so C6 records the row error.
      return jsonResponse(200, { StatusCode: 200, Message: 'Successful', Data: [{ FStatus: false, FItemID: 0, FMessage: 'unit group parameter invalid' }] })
    }
    return jsonResponse(404, { success: false })
  }
  const fetchPair = { impl, calls }
  const rows = [{ code: 'MAT-C6-BAD', name: 'Will fail', spec: 'S' }]

  const dryRun = await dryRunExternalWrite(c6Inputs({ rows, fetchPair, tokenStore }))
  assert.equal(dryRun.status, 'ready', 'planning succeeds — the failure is at write time')

  const apply = await applyExternalWrite({
    ...c6Inputs({ rows, fetchPair, tokenStore }),
    dryRunToken: dryRun.dryRunToken,
    applyUser: 'operator-1',
  })
  assert.equal(apply.counts.written, 0)
  assert.equal(apply.counts.failed, 1)
  // The registered token, not the WRITE_FAILED collapse — this is the positive control for
  // the SAFE_WRITE_ERROR_CODES registration; values-free by construction (a closed token).
  assert.deepEqual(apply.rowErrors.map((e) => e.errorCode), ['K3_WISE_SAVE_FAILED'])
})

test('REVIEW P2: an unchanged reference-shaped field converges to skip (unwrap parity)', async () => {
  // GetDetail returns FUnitID as {FNumber:'PCS'}; the source maps the scalar 'PCS'. Without
  // unwrapping, classifyExisting compares object-vs-scalar and re-plans `update` forever.
  const tokenStore = memoryStore()
  const fetchPair = mockK3({
    existing: {
      'MAT-C6-REF': { FNumber: 'MAT-C6-REF', FItemID: 1002, FName: 'Same name', FUnitID: { FNumber: 'PCS' } },
    },
  })
  const pipeline = pipelineFixture()
  pipeline.fieldMappings = [
    { sourceField: 'code', targetField: 'FNumber', validation: [{ type: 'required' }] },
    { sourceField: 'name', targetField: 'FName', validation: [{ type: 'required' }] },
    { sourceField: 'unit', targetField: 'FUnitID' },
  ]
  const targetSystem = k3TargetSystem()
  const flatConfig = deriveK3WiseC6PlannerTargetConfig({
    system: targetSystem, object: 'material', fieldMappings: pipeline.fieldMappings,
  })
  const dryRun = await dryRunExternalWrite({
    pipeline,
    sourceSystem: { id: 'source_1', kind: 'data-source:sql-readonly' },
    targetSystem: { ...targetSystem, config: flatConfig },
    sourceAdapter: sourceAdapterOf([{ code: 'MAT-C6-REF', name: 'Same name', unit: 'PCS' }]),
    dataSourceWrites: createK3WiseC6WriteSource({
      system: targetSystem,
      createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: fetchPair.impl }),
      b4: b4Of([APPROVED_B4_ROW]),
    }),
    targetWriteProfile: K3_WISE_C6_WRITE_PROFILE,
    tokenStore,
    dryRunUser: 'operator-1',
    dataSourceOwnerPrincipal: 'owner-principal-1',
    maxRows: 3,
  })
  assert.equal(dryRun.counts.skip, 1, 'identical scalar-vs-reference values must converge to skip, not update forever')
  assert.equal(dryRun.counts.update, 0)
})

test('REVIEW P2: a Save failure WITH a K3 Code field still lands as the registered token', async () => {
  const tokenStore = memoryStore()
  const calls = []
  const impl = async (url) => {
    const parsed = new URL(url)
    calls.push(parsed.pathname)
    if (parsed.pathname.endsWith('/Login')) return jsonResponse(200, { success: true, sessionId: 's' })
    if (parsed.pathname.endsWith('/Material/GetDetail')) {
      return jsonResponse(200, { StatusCode: 200, Message: 'Successful', Data: [{ FStatus: false, FItemID: 0, FMessage: 'missing' }] })
    }
    if (parsed.pathname.endsWith('/Material/Save')) {
      // A realistic K3 refusal WITH an error code — passing this arbitrary string through as
      // error.code would collapse to WRITE_FAILED at valuesFreeErrorCode (not in the SAFE set).
      return jsonResponse(200, { StatusCode: 500, Code: 'E-K3-000123', Message: 'Faild', Data: [{ FStatus: false, FItemID: 0 }] })
    }
    return jsonResponse(404, { success: false })
  }
  const rows = [{ code: 'MAT-C6-CODED', name: 'Coded fail', spec: 'S' }]
  const dryRun = await dryRunExternalWrite(c6Inputs({ rows, fetchPair: { impl, calls }, tokenStore }))
  const apply = await applyExternalWrite({
    ...c6Inputs({ rows, fetchPair: { impl, calls }, tokenStore }),
    dryRunToken: dryRun.dryRunToken,
    applyUser: 'operator-1',
  })
  assert.deepEqual(apply.rowErrors.map((e) => e.errorCode), ['K3_WISE_SAVE_FAILED'],
    'the closed token must be unconditional — K3 code strings are neither SAFE-registered nor values-free')
})


test('B4 GATE: zero approved bindings -> refused before any row (absent is fail-closed)', async () => {
  const tokenStore = memoryStore()
  const fetchPair = mockK3()
  const input = c6Inputs({ rows: [{ code: 'M-B4', name: 'N' }], fetchPair, tokenStore })
  input.dataSourceWrites = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: fetchPair.impl }),
    b4: b4Of([]),
  })
  await assert.rejects(
    dryRunExternalWrite(input),
    (error) => /approved B4 read binding/.test(String(error && error.message)),
  )
  assert.equal(fetchPair.calls.length, 0, 'B4 refusal precedes ALL network activity')
})

test('B4 GATE: two approved bindings -> refused (ambiguous is fail-closed, never a silent pick)', async () => {
  const tokenStore = memoryStore()
  const fetchPair = mockK3()
  const input = c6Inputs({ rows: [{ code: 'M-B4', name: 'N' }], fetchPair, tokenStore })
  input.dataSourceWrites = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: fetchPair.impl }),
    b4: b4Of([APPROVED_B4_ROW, b4Row({ id: 'rsc_b4_2', version: 4, config: { systemId: 'k3-target-1' } })]),
  })
  await assert.rejects(
    dryRunExternalWrite(input),
    (error) => /approved B4 read binding/.test(String(error && error.message)),
  )
})

test('SAME-INSTANCE: the fail-closed branch is load-bearing (review P2-1)', () => {
  // The `catch { return false }` in sameK3Instance had NO coverage: flipping it to `return true`
  // left 27/27 green. "Cannot tell" silently became "same instance" — the exact inversion a
  // fail-closed comparator exists to prevent.
  const { __internals } = require('../lib/adapters/k3-wise-c6-write-profile.cjs')
  const same = __internals && __internals.sameK3Instance
  assert.equal(typeof same, 'function', 'sameK3Instance must be reachable to be tested')

  // Unparseable / absent / wrong-typed must all be NON-matches.
  for (const [a, b, why] of [
    ['not a url', 'https://k3.example.test', 'unparseable left'],
    ['https://k3.example.test', 'not a url', 'unparseable right'],
    [null, 'https://k3.example.test', 'null left'],
    ['https://k3.example.test', undefined, 'undefined right'],
    ['', 'https://k3.example.test', 'empty left'],
    [42, 'https://k3.example.test', 'non-string left'],
  ]) {
    assert.equal(same(a, b), false, `${why} must NOT read as the same instance`)
  }

  // POSITIVE CONTROL — real same/different origins still classify correctly, so the above is
  // not just "returns false for everything".
  assert.equal(same('https://k3.example.test/K3API', 'https://k3.example.test/OTHER'), true,
    'same origin, different path — the step 0-b topology — must match')
  assert.equal(same('https://k3-a.example.test', 'https://k3-b.example.test'), false,
    'different hosts must not match')
})

test('INSTANCE DIGEST: identity is (kind, origin, acctId) — the account set, not just the host', async () => {
  // OWNER RULING 20260806 [P1]. The previous gate compared origins only, but K3 WISE login
  // REQUIRES acctId, so ONE server hosts many account sets. A read binding on account set A
  // compared EQUAL to a write target on account set B, and the write would have landed in the
  // wrong 账套. These three cases are the owner's pinned set.
  //
  // The fixture derives digests the SAME way production does — length-prefixed (kind, origin,
  // acctId) — rather than inventing its own scheme. A fixture more permissive than production is
  // exactly how the origin-only gap stayed invisible.
  const crypto = require('node:crypto')
  const digestOf = ({ kind, origin, acctId }) => {
    if (!kind || !origin || !acctId) return null
    const material = [kind, origin, acctId].map((part) => `${part.length}:${part}`).join('|')
    return crypto.createHmac('sha256', 'test-key').update(material).digest('hex').slice(0, 16)
  }
  const K3 = 'erp:k3-wise-webapi'
  const TARGET = { kind: K3, origin: 'https://k3.example.test', acctId: 'ACCT-A' }

  async function planWith(boundIdentity) {
    const fetchPair = mockK3()
    const input = c6Inputs({ rows: [{ code: 'M-INST', name: 'N' }], fetchPair, tokenStore: memoryStore() })
    input.dataSourceWrites = createK3WiseC6WriteSource({
      system: k3TargetSystem(),
      createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: fetchPair.impl }),
      b4: b4Of([APPROVED_B4_ROW], {
        targetSystemId: 'k3-write-target',
        instanceDigestOf: async (id) => digestOf(id === 'k3-write-target' ? TARGET : boundIdentity),
      }),
    })
    return dryRunExternalWrite(input)
  }

  // (1) SAME origin, DIFFERENT acctId — the defect this ruling names. MUST BE REFUSED.
  await assert.rejects(
    planWith({ kind: K3, origin: 'https://k3.example.test', acctId: 'ACCT-B' }),
    (e) => (e && e.details && e.details.code) === 'K3_C6_B4_BINDING_INSTANCE_MISMATCH',
    'one server, two account sets: a binding on 账套 B must not certify a write to 账套 A',
  )

  // (2) SAME origin, SAME acctId, PASSWORD ROTATED — MUST BE ACCEPTED. The account set is the
  // identity, not the secret; a digest over credentials would break on every rotation.
  const rotated = await planWith({ ...TARGET })
  assert.ok(rotated, 'the same account set on the same host must be accepted across a password rotation')

  // (3) DIFFERENT origin — MUST BE REFUSED.
  await assert.rejects(
    planWith({ kind: K3, origin: 'https://k3-other.example.test', acctId: 'ACCT-A' }),
    (e) => (e && e.details && e.details.code) === 'K3_C6_B4_BINDING_INSTANCE_MISMATCH',
    'a different host must not certify this write',
  )

  // (4) NON-K3 at the same origin and account set — the kind is IN the digest material, so it is
  // refused without a separate kind gate. Pinned so that stays true.
  await assert.rejects(
    planWith({ kind: 'plm:yuantus-wrapper', origin: 'https://k3.example.test', acctId: 'ACCT-A' }),
    (e) => (e && e.details && e.details.code) === 'K3_C6_B4_BINDING_INSTANCE_MISMATCH',
    'kind participates in the digest, so a same-origin non-K3 record cannot match',
  )

  // (5) FAIL-CLOSED on unknowable: a record with no authenticatable acctId digests to null, and
  // two nulls must NOT compare equal.
  await assert.rejects(
    planWith({ kind: K3, origin: 'https://k3.example.test', acctId: '' }),
    (e) => (e && e.details && e.details.code) === 'K3_C6_B4_BINDING_INSTANCE_UNVERIFIABLE',
    '"cannot establish identity" must never read as "same instance"',
  )
})

test('REVIEW P3-2: a FULL page of approved configs is a refusal, not a silent pass', async () => {
  // `list()` gives no ordering guarantee, so a full page may be truncated — and a truncated set
  // can hide the second approved binding that the ambiguity check above exists to catch. A full
  // page is indistinguishable from "there might be more", so it fails closed.
  const tokenStore = memoryStore()
  const fetchPair = mockK3()
  const input = c6Inputs({ rows: [{ code: 'M-B4', name: 'N' }], fetchPair, tokenStore })
  const fullPage = Array.from({ length: 500 }, (_, i) => b4Row({ id: `rsc_pad_${i}`, object: 'material-bom' }))
  input.dataSourceWrites = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: fetchPair.impl }),
    b4: b4Of([APPROVED_B4_ROW, ...fullPage.slice(0, 499)]),
  })
  await assert.rejects(
    dryRunExternalWrite(input),
    (error) => /uniqueness|B4_BINDING_PAGE_EXHAUSTED/.test(String((error && error.message) || ''))
      || (error && error.details && error.details.code === 'K3_C6_B4_BINDING_PAGE_EXHAUSTED'),
    'a page filled to the limit must refuse rather than resolve from a possibly-truncated set',
  )

  // POSITIVE CONTROL: one under the limit still resolves normally — without this, a guard that
  // refused every page would satisfy the assertion above.
  const okInput = c6Inputs({ rows: [{ code: 'M-B4', name: 'N' }], fetchPair: mockK3(), tokenStore: memoryStore() })
  okInput.dataSourceWrites = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: fetchPair.impl }),
    b4: b4Of([APPROVED_B4_ROW, ...fullPage.slice(0, 498)]),
  })
  const plan = await dryRunExternalWrite(okInput)
  assert.ok(plan, 'a page under the limit must still produce a plan')
})

test('B4 IDENTITY IS CONTENT-BOUND: a different approved binding changes the dry-run revision', async () => {
  // The identity triple rides the capability state, which buildRevision hashes — so swapping
  // the approved binding between dry-run and apply is a 409, not a silent substitution. Proven
  // at the revision level: same rows, same pipeline, different binding -> different revision.
  const rows = [{ code: 'M-B4-REV', name: 'Rev probe', spec: 'S' }]
  async function revisionWith(binding) {
    const tokenStore = memoryStore()
    const fetchPair = mockK3()
    const input = c6Inputs({ rows, fetchPair, tokenStore })
    input.dataSourceWrites = createK3WiseC6WriteSource({
      system: k3TargetSystem(),
      createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: fetchPair.impl }),
      // D1 refuses a binding on the write target itself, so the systemId dimension varies over a
      // third VALID endpoint (a paired read record). The property under test is unchanged —
      // systemId alone must move the revision — only the sample value moved off the one D1 forbids.
      b4: b4Of([binding], { pipelineSystemIds: ['source_1', 'k3-target-1', 'k3-read-2'] }),
    })
    const out = await dryRunExternalWrite(input)
    assert.equal(out.status, 'ready')
    return out.evidence ? out.evidence.dryRunRevision : out.revision
  }
  const base = await revisionWith(APPROVED_B4_ROW)
  assert.ok(base, 'base revision must be observable')
  // PER-FIELD variation: a single identity field changing must change the revision. Varying
  // two at once would let a mutation that de-binds ONE field hide behind the other.
  // contentKey is now DERIVED from the config (review P2-E4), so the legitimately-varying
  // dimensions of an otherwise-ratified binding are the store-minted version and the systemId
  // (either pipeline endpoint is valid). Each must move the revision on its own.
  const versionOnly = await revisionWith(b4Row({ version: 9 }))
  const systemIdOnly = await revisionWith(b4Row({ config: { systemId: 'k3-read-2' } }))
  assert.notEqual(base, versionOnly, 'approvedConfigVersion alone must move the revision')
  assert.notEqual(base, systemIdOnly, 'configContentKey (via systemId) alone must move the revision')
  // actionProfileVersion is NOT a free variable any more: it is pinned to the ratified
  // contract, so a different one is REFUSED rather than producing another revision. That is
  // the stronger property — asserted in its own test below.
})

test('B4 FILTER: a non-ratified actionProfileVersion is not the B4 binding — refused', async () => {
  const tokenStore = memoryStore()
  const fetchPair = mockK3()
  const input = c6Inputs({ rows: [{ code: 'M-F1', name: 'N' }], fetchPair, tokenStore })
  input.dataSourceWrites = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: fetchPair.impl }),
    b4: b4Of([b4Row({ config: { actionProfileVersion: 'k3wise.material_list.v2' } })]),
  })
  await assert.rejects(dryRunExternalWrite(input), (e) => /approved B4 read binding/.test(String(e && e.message)))
})

test('B4 FILTER: a DRAFT row of the ratified contract must not satisfy the gate (status is load-bearing)', async () => {
  const tokenStore = memoryStore()
  const fetchPair = mockK3()
  const input = c6Inputs({ rows: [{ code: 'M-F2', name: 'N' }], fetchPair, tokenStore })
  input.dataSourceWrites = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: fetchPair.impl }),
    b4: b4Of([b4Row({ status: 'draft' })]),
  })
  await assert.rejects(dryRunExternalWrite(input), (e) => /approved B4 read binding/.test(String(e && e.message)))
})

test('B4 FILTER: an approved NON-material config must not satisfy the gate (object is load-bearing)', async () => {
  const tokenStore = memoryStore()
  const fetchPair = mockK3()
  const input = c6Inputs({ rows: [{ code: 'M-F3', name: 'N' }], fetchPair, tokenStore })
  input.dataSourceWrites = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: fetchPair.impl }),
    b4: b4Of([b4Row({ object: 'material-bom' })]),
  })
  await assert.rejects(dryRunExternalWrite(input), (e) => /approved B4 read binding/.test(String(e && e.message)))
})

test('B4 SCOPE: a binding minted in ANOTHER tenant/workspace is invisible (scope is load-bearing)', async () => {
  for (const foreign of [{ tenantId: 'tenant_other' }, { workspaceId: 'workspace_other' }, { workspaceId: null }]) {
    const tokenStore = memoryStore()
    const fetchPair = mockK3()
    const input = c6Inputs({ rows: [{ code: 'M-F4', name: 'N' }], fetchPair, tokenStore })
    input.dataSourceWrites = createK3WiseC6WriteSource({
      system: k3TargetSystem(),
      createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: fetchPair.impl }),
      b4: b4Of([b4Row(foreign)]),
    })
    await assert.rejects(dryRunExternalWrite(input), (e) => /approved B4 read binding/.test(String(e && e.message)),
      `a binding at ${JSON.stringify(foreign)} must not satisfy this pipeline's scope`)
  }
})

test('B4 IDENTITY: the resolved binding\'s real values ride the capability state (not empty strings)', async () => {
  // Review P2-1: the first version read a top-level actionProfileVersion the store never
  // emits, so the member was permanently ''. Assert the REAL values arrive.
  const source = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: mockK3().impl }),
    b4: b4Of([APPROVED_B4_ROW]),
  })
  const state = (await source.test()).capabilityState
  assert.equal(state.b4BindingApproved, true)
  assert.equal(state.b4ActionProfileVersion, 'k3wise.material_list.v1', 'must come from row.config, not a missing top-level field')
  assert.equal(state.b4ApprovedConfigVersion, '3')
  assert.equal(state.b4ConfigContentKey, APPROVED_B4_ROW.contentKey,
    'the REAL store-computed content key rides the capability state')
  assert.ok(/^[0-9a-f]{64}$/.test(state.b4ConfigContentKey), 'and it is a real sha256, not a fixture string')
})


test('B4 RELATION: a binding approved on an UNRELATED K3 system must not vouch for this write', async () => {
  // Reviewer scenario 1: dropping systemId entirely let one system's read contract back
  // another system's write — the round-2 defect rotated onto a new axis.
  const tokenStore = memoryStore()
  const fetchPair = mockK3()
  const input = c6Inputs({ rows: [{ code: 'M-R1', name: 'N' }], fetchPair, tokenStore })
  input.dataSourceWrites = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: fetchPair.impl }),
    b4: b4Of([b4Row({ config: { systemId: 'k3-system-UNRELATED' } })]),
  })
  await assert.rejects(dryRunExternalWrite(input), (e) => /approved B4 read binding/.test(String(e && e.message)))
  assert.equal(fetchPair.calls.length, 0)
})

test('P2-2: a binding with NO way to check its instance is REFUSED, not waved through', async () => {
  // The gate used to be OPT-IN: no digest function meant no gate, silently. Combined with two
  // upstream ternaries and the requireService list, it failed OPEN at three hops — and the shipped
  // offline PoC demo ran the whole C6 lifecycle with the check structurally absent.
  //
  // The demo alone cannot prove this: once the demo is wired, reverting the hop leaves it green.
  // Only an explicitly UNWIRED scope discriminates, which is why this case exists separately.
  const unwired = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: mockK3().impl }),
    b4: b4Of([b4Row({ config: { systemId: 'source_1' } })], { instanceDigestOf: undefined }),
  })
  await assert.rejects(
    unwired.test(),
    (e) => (e && e.details && e.details.code) === 'K3_C6_B4_INSTANCE_CHECK_UNWIRED',
    'a gate that disappears when its wiring is missing is not a gate',
  )
})

test('B4 RELATION: minted on a pipeline endpoint — but NOT on the write target itself (D1 narrowing)', async () => {
  // ⚠️ DELIBERATE NARROWING OF A RATIFIED PROPERTY, recorded here rather than silently absorbed.
  //
  // #4769 ratified "the binding may be minted on EITHER pipeline endpoint (source or target)", and
  // this test asserted exactly that for both. The owner's D1 ruling supersedes the target half:
  // binding to the write target made the instance check compare the target with ITSELF, which is
  // structurally incapable of detecting a read/write mismatch. Self-reference is now refused.
  //
  // The SOURCE half of the ratified property is unchanged.
  const onSource = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: mockK3().impl }),
    b4: b4Of([b4Row({ config: { systemId: 'source_1' } })]),
  })
  const state = (await onSource.test()).capabilityState
  assert.equal(state.b4BindingApproved, true, "a binding on the SOURCE endpoint is still legitimately this pipeline's")
  assert.equal(state.b4BindingCount, 1)

  const onTargetItself = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: mockK3().impl }),
    b4: b4Of([b4Row({ config: { systemId: 'k3-target-1' } })]),
  })
  await assert.rejects(
    onTargetItself.test(),
    (e) => (e && e.details && e.details.code) === 'K3_C6_B4_BINDING_SELF_REFERENTIAL',
    'binding on the write target itself is now REFUSED — it can only ever compare a record with itself',
  )
})

test('B4 RELATION: an unrelated system\'s binding does not create false ambiguity', async () => {
  // Reviewer scenario 2: two K3 systems each approved -> the whole scope was hard-blocked.
  // The unrelated one must simply not count.
  const source = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: mockK3().impl }),
    b4: b4Of([
      b4Row({ config: { systemId: 'source_1' } }),
      b4Row({ id: 'rsc_b4_other', contentKey: 'other', config: { systemId: 'k3-system-UNRELATED' } }),
    ]),
  })
  const state = (await source.test()).capabilityState
  assert.equal(state.b4BindingCount, 1, 'only this pipeline\'s binding counts')
  assert.equal(state.b4BindingApproved, true)
})


test('REVIEW P2-D2: the B4 gate checks CONTENT, not just the profile-version string', async () => {
  // A reviewer minted a config whose mode/readPath/containerPaths/fieldMap all differed from
  // the ratified template and passed the gate by typing the right actionProfileVersion — the
  // gate was self-certifying. Each divergence below must now be refused on its own.
  const divergences = [
    ['mode', { mode: 'single_record' }],
    ['readPath', { readPath: '/K3API/Material/GetDetail' }],
    ['containerPaths', { containerPaths: ['Data'] }],
    ['fieldMap', { fieldMap: [{ source: 'FModel', target: 'erpSpec' }] }],
    ['requiredKind', { requiredKind: 'http' }],
    // NOT included: `operations`. Measured — validateReadSourceConfig REJECTS a non-read-only
    // operations list outright (READ_SOURCE_WRITE_CONFIG_REJECTED) and normalizeReadSourceConfig
    // forces it back to ['read'], so such a row cannot be minted at all. Listing it here would
    // have asserted the gate catches something the store never lets exist — a stronger-sounding
    // but false claim. The read-only line upstream is the real carrier.
  ]
  for (const [label, patch] of divergences) {
    const source = createK3WiseC6WriteSource({
      system: k3TargetSystem(),
      createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: mockK3().impl }),
      // Keep the row's contentKey as the RATIFIED one while the config diverges — that is
      // exactly the forgery the key-projection version could not see (review P2-E4).
      b4: b4Of([b4Row({ config: patch, contentKey: APPROVED_B4_ROW.contentKey })]),
    })
    const state = (await source.test()).capabilityState
    assert.equal(state.b4BindingApproved, false, `a config diverging in ${label} must not certify`)
  }

  // POSITIVE CONTROL: the ratified content (the fixture's default) certifies — otherwise the
  // assertions above would also hold for a gate that rejected everything.
  const good = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: mockK3().impl }),
    b4: b4Of([APPROVED_B4_ROW]),
  })
  assert.equal((await good.test()).capabilityState.b4BindingApproved, true)
})

test('B4 GATE: the two content checks are EXCLUSIVE — neither may cover for the other', async () => {
  // Mutation record: removing the ratified-equality check alone left the suite green, because
  // the self-consistency check was covering for it. That is the "gates covering for each other"
  // trap. These two rows each defeat exactly ONE check, so each must fail on its own.
  const forgeries = [
    // (a) SELF-CONSISTENT but NOT the ratified content: a genuinely mintable row that simply
    //     is not the B4 contract. Only the ratified-equality check can refuse it.
    ['self-consistent, non-ratified', b4Row({ config: { keyField: 'FNumber' } })],
    // (b) key claims the ratified content while the config diverges — impossible for a genuine
    //     mint, but only the self-consistency check can refuse it.
    ['key/config mismatch', b4Row({ config: { readPath: '/K3API/Material/GetDetail' }, contentKey: APPROVED_B4_ROW.contentKey })],
  ]
  for (const [label, row] of forgeries) {
    const source = createK3WiseC6WriteSource({
      system: k3TargetSystem(),
      createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: mockK3().impl }),
      b4: b4Of([row]),
    })
    assert.equal((await source.test()).capabilityState.b4BindingApproved, false, `${label} must not certify`)
  }
})
