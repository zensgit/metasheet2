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
    fieldMappings: pipelineFixture().fieldMappings.concat([
      { sourceField: 'ghost', targetField: 'FNotInSchema' },
    ]),
  })
  assert.deepEqual(cfg.keyFields, ['FNumber'])
  assert.deepEqual(cfg.writableFields, ['FName', 'FModel'], 'key excluded; schema-unknown target dropped')
  assert.equal(cfg.object, 'material')
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
