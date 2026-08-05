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
    ...overrides,
  }
}
// Row shape as the STORE emits it: actionProfileVersion lives in the nested config
// (review P2-1 — the first version read a top-level field the store never emits, so the
// "identity triple" carried a permanently empty member).
function b4Row(overrides = {}) {
  const { config: configOverride, ...rest } = overrides
  return {
    id: 'rsc_b4_1',
    tenantId: 'tenant_1',
    workspaceId: 'workspace_1',
    object: 'material',
    status: 'approved',
    version: 3,
    contentKey: 'b4-content-key-aaaaaaaaaaaaaaaa',
    config: {
      // The RATIFIED template verbatim (review P2-D2: matching only the profile-version STRING
      // let a config that differed everywhere else pass — the fixture must therefore carry real
      // content, or the new equality check would be untested).
      ...JSON.parse(JSON.stringify(RATIFIED_B4_TEMPLATE)),
      systemId: 'source_1',
      ...(configOverride || {}),
    },
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
function mockK3({ existing = {} } = {}) {
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
    b4: b4Of([APPROVED_B4_ROW, b4Row({ id: 'rsc_b4_2', version: 4, contentKey: 'b4-content-key-bbbbbbbbbbbbbbbb' })]),
  })
  await assert.rejects(
    dryRunExternalWrite(input),
    (error) => /approved B4 read binding/.test(String(error && error.message)),
  )
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
      b4: b4Of([binding]),
    })
    const out = await dryRunExternalWrite(input)
    assert.equal(out.status, 'ready')
    return out.evidence ? out.evidence.dryRunRevision : out.revision
  }
  const base = await revisionWith(APPROVED_B4_ROW)
  assert.ok(base, 'base revision must be observable')
  // PER-FIELD variation: a single identity field changing must change the revision. Varying
  // two at once would let a mutation that de-binds ONE field hide behind the other.
  const versionOnly = await revisionWith(b4Row({ version: 9 }))
  const contentKeyOnly = await revisionWith(b4Row({ contentKey: 'b4-content-key-cccccccccccccccc' }))
  assert.notEqual(base, versionOnly, 'approvedConfigVersion alone must move the revision')
  assert.notEqual(base, contentKeyOnly, 'configContentKey alone must move the revision')
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
  assert.equal(state.b4ConfigContentKey, 'b4-content-key-aaaaaaaaaaaaaaaa')
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

test('B4 RELATION: the binding may be minted on EITHER pipeline endpoint (source or target)', async () => {
  for (const boundTo of ['source_1', 'k3-target-1']) {
    const source = createK3WiseC6WriteSource({
      system: k3TargetSystem(),
      createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: mockK3().impl }),
      b4: b4Of([b4Row({ config: { systemId: boundTo } })]),
    })
    const state = (await source.test()).capabilityState
    assert.equal(state.b4BindingApproved, true, `a binding on ${boundTo} is legitimately this pipeline's`)
    assert.equal(state.b4BindingCount, 1)
  }
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
    ['operations', { operations: ['read', 'upsert'] }],
    ['requiredKind', { requiredKind: 'http' }],
  ]
  for (const [label, patch] of divergences) {
    const source = createK3WiseC6WriteSource({
      system: k3TargetSystem(),
      createAdapter: (system) => createK3WiseWebApiAdapter({ system, fetchImpl: mockK3().impl }),
      b4: b4Of([b4Row({ config: patch })]),
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
