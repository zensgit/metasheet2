'use strict'

// E4 ACCEPTANCE SUITE — K3 Save/Submit/Audit permanent fence (HG v1.2 §10, §13 PR-B, §15.2).
//
// One test per acceptance row, named E4-01..E4-06 so the verification MD maps 1:1:
//
//   E4-01  Apply HTTP route            refused; credential reload / token consume / source read /
//                                      adapter construction / login / save all ZERO
//   E4-02  direct applyExternalWrite   refused; token / source / adapter / save ZERO
//   E4-03  direct K3 write-source      refused; adapter / login / save ZERO
//   E4-04  direct K3 adapter upsert    refused; login / save ZERO, Submit/Audit ZERO
//   E4-05  READ-ONLY regression        a synthetic K3 fixture REACHES the planner/dry-run and
//                                      succeeds; save/submit/audit ZERO (anti-fake-green: a
//                                      blanket deny that stops the planner is a FAIL)
//   E4-06  READ-FAILURE regression     an injected K3 read failure surfaces only a pre-enumerated
//                                      READ-ONLY code, never the write-fence code
//
// The four layers are INDEPENDENT. Each of E4-01..E4-04 drives its own layer's entry point
// directly, so removing layer N's guard turns exactly E4-0N red while the deeper layers still
// hold login=0 / save=0 — which is what the guard-removal drills in the PR body record.
//
// VALUES-FREE: every assertion here is a closed code, a count, or a fixed marker object.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const { registerIntegrationRoutes } = require(path.join(__dirname, '..', 'lib', 'http-routes.cjs'))
const { applyExternalWrite, dryRunExternalWrite } = require(path.join(__dirname, '..', 'lib', 'external-write-dry-run.cjs'))
const {
  K3_WISE_C6_WRITE_PROFILE,
  createK3WiseC6WriteSource,
  deriveK3WiseC6PlannerTargetConfig,
} = require(path.join(__dirname, '..', 'lib', 'adapters', 'k3-wise-c6-write-profile.cjs'))
const { createK3WiseWebApiAdapter } = require(path.join(__dirname, '..', 'lib', 'adapters', 'k3-wise-webapi-adapter.cjs'))
const {
  K3_WISE_EXTERNAL_WRITE_DISABLED,
} = require(path.join(__dirname, '..', 'lib', 'k3-external-write-permanent-fence.cjs'))
const { contentKeyFor } = require(path.join(__dirname, '..', 'lib', 'read-source-config-store.cjs'))
const { normalizeReadSourceConfig } = require(path.join(__dirname, '..', 'lib', 'read-source-config.cjs'))
const {
  K3WISE_MATERIAL_LIST_B4_TEMPLATE,
} = require(path.join(__dirname, '..', 'lib', 'read-source-k3-material-list-b4-contract.cjs'))

const PROFILE_ID = 'material-k3wise-customer-profile-v1'
const TENANT_ID = 'tenant_1'
const WORKSPACE_ID = 'workspace_1'
const K3_KIND = 'erp:k3-wise-webapi'

// The exact code frozen by §10.1. Spelled as a LITERAL here, not taken from the import, so that
// renaming the constant in production code cannot silently re-point every expectation.
const FIXED_CODE = 'K3_WISE_EXTERNAL_WRITE_DISABLED'

test('E4-00 (control): the module constant and the frozen §10.1 literal agree', () => {
  assert.equal(K3_WISE_EXTERNAL_WRITE_DISABLED, FIXED_CODE)
})

// --------------------------------------------------------------------------------------------
// Shared fixtures
// --------------------------------------------------------------------------------------------

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}

// A K3 wire mock that RECORDS every path. Login and Save are both answered SUCCESSFULLY on
// purpose: if a fence ever failed to hold, the call would succeed and the zero-count assertions
// would fail loudly rather than being masked by a mock that refuses anyway.
function recordingK3({ readFailure = null } = {}) {
  const calls = []
  const impl = async (url, init) => {
    const parsed = new URL(url)
    calls.push({ pathname: parsed.pathname, body: init && init.body ? JSON.parse(init.body) : null })
    if (parsed.pathname.endsWith('/Login')) {
      return jsonResponse(200, { success: true, sessionId: 'e4-session' })
    }
    if (parsed.pathname.endsWith('/Material/GetDetail')) {
      if (readFailure === 'transport') return jsonResponse(503, { success: false, message: 'gateway down' })
      if (readFailure === 'business') {
        return jsonResponse(200, {
          StatusCode: 200,
          Message: 'Successful',
          Data: [{ FStatus: false, FItemID: 0, FMessage: 'permission denied for this account set' }],
        })
      }
      // Default: K3's business-level "not found" shape.
      return jsonResponse(200, {
        StatusCode: 200,
        Message: 'Successful',
        Data: [{ FStatus: false, FItemID: 0, FMessage: 'required base-data object missing' }],
      })
    }
    if (parsed.pathname.endsWith('/Material/Save')) {
      return jsonResponse(200, { StatusCode: 200, Message: 'Successful', Data: [{ FStatus: true, FItemID: 9001 }] })
    }
    if (parsed.pathname.endsWith('/Material/Submit') || parsed.pathname.endsWith('/Material/Audit')) {
      return jsonResponse(200, { StatusCode: 200, Message: 'Successful', Data: [{ FStatus: true }] })
    }
    return jsonResponse(404, { success: false, message: 'not found' })
  }
  const count = (suffix) => calls.filter((c) => c.pathname.endsWith(suffix)).length
  return {
    calls,
    impl,
    get login() { return count('/Login') },
    get save() { return count('/Material/Save') },
    get submit() { return count('/Material/Submit') },
    get audit() { return count('/Material/Audit') },
    get read() { return count('/Material/GetDetail') },
  }
}

function k3TargetSystem() {
  return {
    id: 'k3-target-1',
    name: 'K3 target',
    kind: K3_KIND,
    role: 'target',
    status: 'active',
    credentials: { username: 'u', password: 'p', acctId: 'AIS' },
    config: {
      baseUrl: 'https://k3.example.test',
      autoSubmit: false,
      autoAudit: false,
      objects: { material: { profile: PROFILE_ID } },
    },
  }
}

function pipelineFixture() {
  return {
    id: 'pipe_k3_e4',
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    sourceSystemId: 'source_1',
    sourceObject: 'materials',
    targetSystemId: 'k3-target-1',
    targetObject: 'material',
    status: 'active',
    createdBy: 'owner-7',
    options: { source: { filters: { fixtureScope: 'approved' } } },
    fieldMappings: [
      { sourceField: 'code', targetField: 'FNumber', validation: [{ type: 'required' }] },
      { sourceField: 'name', targetField: 'FName', validation: [{ type: 'required' }] },
      { sourceField: 'spec', targetField: 'FModel' },
    ],
  }
}

// A genuine approved B4 read binding, keyed by the store's own contentKeyFor — a hand-written key
// would make the capability gate vacuous and the E4-05 dry-run would never plan.
function approvedB4Row() {
  const config = {
    ...JSON.parse(JSON.stringify(K3WISE_MATERIAL_LIST_B4_TEMPLATE)),
    systemId: 'source_1',
  }
  return {
    id: 'rsc_b4_e4',
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    object: 'material',
    status: 'approved',
    version: 3,
    contentKey: contentKeyFor(normalizeReadSourceConfig(config)),
    config,
  }
}

function b4Scope() {
  const rows = [approvedB4Row()]
  return {
    readSourceConfigs: {
      async list(input = {}) {
        const wanted = input.workspaceId ?? null
        return rows.filter((row) => row.tenantId === input.tenantId
          && (row.workspaceId ?? null) === wanted
          && (input.status === undefined || row.status === input.status))
      },
    },
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    pipelineSystemIds: ['source_1', 'k3-target-1'],
    targetSystemId: 'k3-target-1',
    // Equal digests: the bound read record and the write target address the same physical K3 and
    // account set. The gate is fail-closed without this, so E4-05 would never reach the planner.
    async instanceDigestOf() { return 'e4-instance-digest' },
  }
}

function memoryTokenStore() {
  const map = new Map()
  const stats = { get: 0, set: 0, consume: 0, delete: 0 }
  return {
    map,
    stats,
    async get(key) { stats.get += 1; return map.get(key) || null },
    async set(key, value) { stats.set += 1; map.set(key, JSON.parse(JSON.stringify(value))) },
    async consume(key) { stats.consume += 1; const v = map.get(key) || null; map.delete(key); return v },
    async delete(key) { stats.delete += 1; map.delete(key) },
  }
}

function countingSourceAdapter(rows) {
  const state = { reads: 0 }
  return {
    state,
    adapter: {
      async read() {
        state.reads += 1
        return { records: rows, done: true }
      },
    },
  }
}

const SOURCE_ROWS = [{ code: 'MAT-E4-1', name: 'One', spec: 'S1' }]

// Assemble planner inputs exactly the way http-routes' resolveC6WritePlanInputs does for K3.
function c6Inputs({ wire, tokenStore, source }) {
  const targetSystem = k3TargetSystem()
  const pipeline = pipelineFixture()
  const adapterCreates = { count: 0 }
  const flatConfig = deriveK3WiseC6PlannerTargetConfig({
    system: targetSystem,
    object: pipeline.targetObject,
    fieldMappings: pipeline.fieldMappings,
  })
  const writeSource = createK3WiseC6WriteSource({
    system: targetSystem,
    createAdapter: (system) => {
      adapterCreates.count += 1
      return createK3WiseWebApiAdapter({ system, fetchImpl: wire.impl })
    },
    b4: b4Scope(),
  })
  return {
    adapterCreates,
    input: {
      pipeline,
      sourceSystem: { id: 'source_1', kind: 'data-source:sql-readonly' },
      targetSystem: { ...targetSystem, config: flatConfig },
      sourceAdapter: source.adapter,
      dataSourceWrites: writeSource,
      targetWriteProfile: K3_WISE_C6_WRITE_PROFILE,
      tokenStore,
      dryRunUser: 'operator-1',
      dataSourceOwnerPrincipal: 'owner-7',
      maxRows: 3,
    },
  }
}

// --------------------------------------------------------------------------------------------
// E4-01 — Apply HTTP route
// --------------------------------------------------------------------------------------------

function createMockContext(storage) {
  const routes = new Map()
  return {
    routes,
    context: {
      storage,
      config: {},
      api: {
        http: {
          addRoute(method, routePath, handler) {
            routes.set(`${String(method).toUpperCase()} ${routePath}`, handler)
          },
        },
      },
    },
  }
}

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function invoke(routes, method, routePath, req) {
  const handler = routes.get(`${String(method).toUpperCase()} ${routePath}`)
  assert.ok(handler, `expected route ${method} ${routePath} to be registered`)
  const res = createResponse()
  await handler({ user: req.user, body: req.body || {}, query: req.query || {}, params: req.params || {} }, res)
  return res
}

const NOOP_CONFIG_STORE = {
  async saveVersion() { return {} },
  async list() { return [] },
  async get() { return {} },
  async approve() { return {} },
  async retire() { return {} },
  async listAudit() { return [] },
  async getForRuntime() { return {} },
}

function routeHarness() {
  const wire = recordingK3()
  const tokenStore = memoryTokenStore()
  const source = countingSourceAdapter(SOURCE_ROWS)
  const probes = { credentialReloads: 0, strippedLoads: 0, adapterCreates: 0 }
  const targetSystem = k3TargetSystem()
  const sourceSystem = { id: 'source_1', name: 'Source', kind: 'data-source:sql-readonly', role: 'source', status: 'active', config: {} }
  const systems = new Map([[targetSystem.id, targetSystem], [sourceSystem.id, sourceSystem]])

  const externalSystemRegistry = {
    async upsertExternalSystem() { return {} },
    async deleteExternalSystem() { return {} },
    async listExternalSystems() { return [] },
    // The credential-STRIPPED public accessor. This is the only load the fence is allowed to use.
    async getExternalSystem(input) {
      probes.strippedLoads += 1
      const system = systems.get(input.id)
      if (!system) return null
      const { credentials, ...rest } = system
      return { ...rest, hasCredentials: Boolean(credentials) }
    },
    // The credential-bearing reload. Reaching this at all for a K3 apply is a layer-1 FAILURE.
    async getExternalSystemForAdapter(input) {
      probes.credentialReloads += 1
      return systems.get(input.id) || null
    },
    // Wired so the B4 same-instance gate can pass. Without it the capability check fails closed
    // and a layer-1-removal drill would stop on the gate instead of travelling to layer 2 —
    // i.e. the drill would prove nothing.
    async getExternalSystemInstanceDigest() { return 'e4-instance-digest' },
  }

  // A REAL approved B4 read binding, so a drill that removes the outer guard genuinely reaches
  // the deeper ones rather than dying on unrelated scaffolding.
  const b4Rows = [approvedB4Row()]
  const readSourceConfigStore = {
    ...NOOP_CONFIG_STORE,
    async list(input = {}) {
      const wanted = input.workspaceId ?? null
      return b4Rows.filter((row) => row.tenantId === input.tenantId
        && (row.workspaceId ?? null) === wanted
        && (input.status === undefined || row.status === input.status))
    },
  }

  const { context, routes } = createMockContext(tokenStore)
  registerIntegrationRoutes({
    context,
    services: {
      externalSystemRegistry,
      adapterRegistry: {
        listAdapterKinds() { return [K3_KIND, 'data-source:sql-readonly'] },
        createAdapter(system) {
          probes.adapterCreates += 1
          // The SOURCE gets the counting read-only fake, so that removing the layer-1 guard in a
          // drill lets the request travel on to layer 2 instead of dying on harness scaffolding.
          // A harness that cannot reach the next layer makes the guard-removal drill vacuous.
          if (system && system.kind === K3_KIND) {
            return createK3WiseWebApiAdapter({ system, fetchImpl: wire.impl })
          }
          return source.adapter
        },
      },
      pipelineRegistry: {
        async upsertPipeline() { return {} },
        async getPipeline() { return pipelineFixture() },
        async listPipelines() { return [] },
        async listPipelineRuns() { return [] },
      },
      pipelineRunner: { async runPipeline() { return {} } },
      deadLetterStore: { async listDeadLetters() { return [] } },
      stagingInstaller: { async installStaging() { return {} }, listStagingDescriptors() { return [] } },
      templateRegistry: {
        async upsertTemplate() { return {} },
        async getTemplate() { return {} },
        async listTemplates() { return [] },
        async deleteTemplate() { return {} },
        async instantiateTemplate() { return {} },
      },
      readSourceConfigStore,
      readSourceCompositionConfigStore: NOOP_CONFIG_STORE,
      bridgeAgentChecklistStore: {
        async saveVersion() { return {} },
        async approve() { return {} },
        async retire() { return {} },
        async getForApply() { return {} },
      },
    },
    logger: { warn() {}, error() {}, info() {} },
  })
  return { routes, wire, tokenStore, source, probes }
}

test('E4-01: the C6 Apply HTTP route refuses a K3 target before credential reload, token consumption, source read, adapter construction or any network call', async () => {
  const h = routeHarness()

  // A token that WOULD otherwise be presentable: seeded straight into the store, exactly like an
  // in-flight approval minted before this fence shipped and still inside its 30-minute TTL.
  await h.tokenStore.set('integration:c6-write-dry-run-token:e4-in-flight', {
    pipelineId: 'pipe_k3_e4',
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    dryRunUser: 'user_write',
    dataSourceOwnerPrincipal: 'owner-7',
    revision: 'whatever',
    counts: {},
    maxRows: 3,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  })
  const consumesBefore = h.tokenStore.stats.consume + h.tokenStore.stats.delete

  const res = await invoke(h.routes, 'POST', '/api/integration/pipelines/:id/external-write/apply', {
    user: { id: 'user_write', tenantId: TENANT_ID, permissions: ['integration:write'] },
    params: { id: 'pipe_k3_e4' },
    body: { confirm: { dryRunToken: 'e4-in-flight' } },
  })

  assert.equal(res.statusCode, 403, 'the refusal is a 403 — not a configuration the caller can fix')
  assert.equal(res.body.error.code, FIXED_CODE)

  assert.equal(h.probes.credentialReloads, 0, 'E4-01: credential reload = 0')
  assert.equal(h.tokenStore.stats.consume + h.tokenStore.stats.delete, consumesBefore, 'E4-01: token consume = 0')
  assert.ok(
    await h.tokenStore.get('integration:c6-write-dry-run-token:e4-in-flight'),
    'E4-01: the in-flight token is left UNCONSUMED and still presentable',
  )
  assert.equal(h.source.state.reads, 0, 'E4-01: source read = 0')
  assert.equal(h.probes.adapterCreates, 0, 'E4-01: adapter construction = 0')
  assert.equal(h.wire.login, 0, 'E4-01: login = 0')
  assert.equal(h.wire.save, 0, 'E4-01: save = 0')
  assert.equal(h.wire.submit + h.wire.audit, 0, 'E4-01: submit/audit = 0')
})

test('E4-01 control: the route harness is COMPLETE — the same wiring drives a real K3 dry-run end to end', async () => {
  // The guard-removal drill for layer 1 is only informative if, with the guard gone, the request
  // would actually have travelled onward to layer 2. Prove the scaffolding can carry it: the
  // SAME harness, through the SAME route registration, runs the C6 dry-run for this K3 pipeline
  // and produces a real plan (credential reload, source adapter, B4 binding, K3 GetDetail all
  // wired). Without this, "layer 2 caught it" could really mean "the harness fell over first".
  const h = routeHarness()
  const res = await invoke(h.routes, 'POST', '/api/integration/pipelines/:id/external-write/dry-run', {
    user: { id: 'user_write', tenantId: TENANT_ID, permissions: ['integration:read'] },
    params: { id: 'pipe_k3_e4' },
    body: {},
  })
  assert.equal(res.statusCode, 200, `dry-run must succeed through this harness, got ${JSON.stringify(res.body && res.body.error)}`)
  assert.ok(h.probes.credentialReloads > 0, 'the harness DOES reload credentials when the path is allowed to get there')
  assert.ok(h.probes.adapterCreates > 0, 'the harness DOES construct adapters')
  assert.ok(h.source.state.reads > 0, 'the harness DOES read the source')
  assert.ok(h.wire.read > 0, 'the harness DOES reach K3 GetDetail')
  assert.equal(res.body.data.status, 'not_applyable', 'and the plan still refuses to authorise an apply')
  assert.equal(res.body.data.dryRunToken, null)
  assert.equal(h.wire.save, 0, 'with zero Save')
})

test('E4-01 control: every probe E4-01 reads as zero is a probe that actually records', async () => {
  // Anti-fake-green for E4-01 itself. Each count there is an ABSENCE; if a probe were unwired the
  // assertion would pass against a harness that does nothing. Drive each instrument once and
  // require it to move.
  const h = routeHarness()
  assert.equal(h.probes.credentialReloads, 0)
  await h.source.adapter.read()
  assert.equal(h.source.state.reads, 1, 'the source-read probe records')
  await h.tokenStore.set('k', { v: 1 })
  await h.tokenStore.consume('k')
  assert.equal(h.tokenStore.stats.consume, 1, 'the token-consume probe records')
  await h.wire.impl('https://k3.example.test/K3API/Login', {})
  assert.equal(h.wire.login, 1, 'the wire probe records')
  await h.wire.impl('https://k3.example.test/K3API/Material/Save', { body: JSON.stringify({ Data: {} }) })
  assert.equal(h.wire.save, 1, 'the save probe records')
})

// --------------------------------------------------------------------------------------------
// E4-02 — direct applyExternalWrite
// --------------------------------------------------------------------------------------------

test('E4-02: applyExternalWrite refuses a K3 target before token consumption and before the planner', async () => {
  const wire = recordingK3()
  const tokenStore = memoryTokenStore()
  const source = countingSourceAdapter(SOURCE_ROWS)
  const { input, adapterCreates } = c6Inputs({ wire, tokenStore, source })

  await tokenStore.set('integration:c6-write-dry-run-token:e4-direct', {
    pipelineId: input.pipeline.id,
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    dryRunUser: 'operator-1',
    dataSourceOwnerPrincipal: 'owner-7',
    revision: 'whatever',
    counts: {},
    maxRows: 3,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  })
  const consumesBefore = tokenStore.stats.consume + tokenStore.stats.delete

  const refusal = await applyExternalWrite({
    ...input,
    dryRunToken: 'e4-direct',
    applyUser: 'operator-1',
  }).then(() => null, (error) => error)

  assert.ok(refusal, 'E4-02: apply must refuse')
  assert.equal(refusal.code, FIXED_CODE)
  assert.equal(refusal.status, 403)
  assert.equal(tokenStore.stats.consume + tokenStore.stats.delete, consumesBefore, 'E4-02: token consume = 0')
  assert.ok(await tokenStore.get('integration:c6-write-dry-run-token:e4-direct'), 'E4-02: the token is left unconsumed')
  assert.equal(source.state.reads, 0, 'E4-02: source read = 0 (the planner never ran)')
  assert.equal(adapterCreates.count, 0, 'E4-02: adapter construction = 0')
  assert.equal(wire.login, 0, 'E4-02: login = 0')
  assert.equal(wire.save, 0, 'E4-02: save = 0')
})

test('E4-02: neither identity alone can launder K3 past the module fence', async () => {
  const wire = recordingK3()
  const tokenStore = memoryTokenStore()
  const source = countingSourceAdapter(SOURCE_ROWS)
  const { input } = c6Inputs({ wire, tokenStore, source })

  // Two independent identities carry K3 into applyExternalWrite. Strip either one and the other
  // must still refuse — the check is OR-shaped on purpose.
  for (const [label, mutate] of [
    ['targetSystem.kind disguised', (i) => ({ ...i, targetSystem: { ...i.targetSystem, kind: 'data-source:sql-write-gated' } })],
    ['targetWriteProfile disguised', (i) => ({ ...i, targetWriteProfile: { ...i.targetWriteProfile, kind: 'data-source:sql-write-gated' } })],
  ]) {
    const refusal = await applyExternalWrite({
      ...mutate(input),
      dryRunToken: 'nope',
      applyUser: 'operator-1',
    }).then(() => null, (error) => error)
    assert.equal(refusal && refusal.code, FIXED_CODE, `${label}: the surviving identity still refuses`)
  }
  assert.equal(wire.save, 0, 'E4-02: save = 0 for every disguise')
})

// --------------------------------------------------------------------------------------------
// E4-03 — direct K3 write-source / profile
// --------------------------------------------------------------------------------------------

test('E4-03: the K3 C6 write source refuses insertRows/updateRows before obtaining the adapter', async () => {
  const wire = recordingK3()
  const adapterCreates = { count: 0 }
  const writeSource = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => {
      adapterCreates.count += 1
      return createK3WiseWebApiAdapter({ system, fetchImpl: wire.impl })
    },
    b4: b4Scope(),
  })
  const policy = { keyFields: ['FNumber'], writableFields: ['FName', 'FModel'] }
  const rows = [{ FNumber: 'MAT-E4-1', FName: 'One', FModel: 'S1' }]

  for (const method of ['insertRows', 'updateRows']) {
    const refusal = await writeSource[method]('k3-target-1', 'material', rows, policy, 'owner-7')
      .then(() => null, (error) => error)
    assert.ok(refusal, `E4-03: ${method} must refuse`)
    assert.equal(refusal.details && refusal.details.code, FIXED_CODE, `E4-03: ${method} carries the fixed code`)
  }
  assert.equal(adapterCreates.count, 0, 'E4-03: adapter construction = 0')
  assert.equal(wire.login, 0, 'E4-03: login = 0')
  assert.equal(wire.save, 0, 'E4-03: save = 0')
})

test('E4-03 control: the SAME write source still serves its read-side lookup, constructing the adapter and reaching K3', async () => {
  // Anti-fake-green: `adapterCreates = 0` above must mean "the write path stopped early", not
  // "this facade never builds an adapter at all". The read side does, on the same instance.
  const wire = recordingK3()
  const adapterCreates = { count: 0 }
  const writeSource = createK3WiseC6WriteSource({
    system: k3TargetSystem(),
    createAdapter: (system) => {
      adapterCreates.count += 1
      return createK3WiseWebApiAdapter({ system, fetchImpl: wire.impl })
    },
    b4: b4Scope(),
  })
  const lookup = await writeSource.lookupByKey('k3-target-1', 'material', { FNumber: 'MAT-E4-1' }, { keyFields: ['FNumber'] }, 'owner-7')
  assert.deepEqual(lookup.data, [], 'a business-level miss reads as absent')
  assert.equal(adapterCreates.count, 1, 'the read path DOES build the adapter — so 0 on the write path is meaningful')
  assert.ok(wire.read > 0, 'and it really reached K3 GetDetail')
  assert.equal(wire.save, 0, 'still zero Save')
})

// --------------------------------------------------------------------------------------------
// E4-04 — direct K3 adapter upsert
// --------------------------------------------------------------------------------------------

test('E4-04: the K3 WebAPI adapter refuses upsert before login — Save, Submit and Audit all unreachable', async () => {
  const wire = recordingK3()
  const adapter = createK3WiseWebApiAdapter({ system: k3TargetSystem(), fetchImpl: wire.impl })

  const refusal = await adapter.upsert({
    object: 'material',
    records: [{ FNumber: 'MAT-E4-1', FName: 'One' }],
    keyFields: ['FNumber'],
    // The request-parameter enablement surface §10.1 enumerates, pushed to its most permissive.
    options: { autoSubmit: true, autoAudit: true },
  }).then(() => null, (error) => error)

  assert.ok(refusal, 'E4-04: upsert must refuse')
  assert.equal(refusal.details && refusal.details.code, FIXED_CODE)
  assert.equal(wire.login, 0, 'E4-04: login = 0')
  assert.equal(wire.save, 0, 'E4-04: save = 0')
  assert.equal(wire.submit, 0, 'E4-04: submit = 0')
  assert.equal(wire.audit, 0, 'E4-04: audit = 0')
  assert.equal(wire.calls.length, 0, 'E4-04: nothing at all reached K3')
})

test('E4-04: no env flag, config switch, request option or policy object re-enables the adapter write', async () => {
  // §10.1 verbatim: "env flag、通用 C6 开关、owner policy、审批结果和请求参数均不能解锁".
  // Each surface below is pushed to its most permissive setting simultaneously.
  const ENV_KEYS = [
    'INTEGRATION_C6_WRITE_APPLY_DISABLED',
    'INTEGRATION_K3_WRITE_ENABLED',
    'INTEGRATION_EXTERNAL_WRITE_ENABLED',
    'K3_WISE_EXTERNAL_WRITE_DISABLED',
  ]
  const saved = ENV_KEYS.map((key) => [key, process.env[key]])
  try {
    for (const key of ENV_KEYS) process.env[key] = 'false'
    const wire = recordingK3()
    const permissiveSystem = k3TargetSystem()
    permissiveSystem.config.autoSubmit = true
    permissiveSystem.config.autoAudit = true
    permissiveSystem.config.externalWriteEnabled = true
    permissiveSystem.config.c6AcceptancePolicy = { profile: 'k3-test-only-exact-two-add-v1' }
    const adapter = createK3WiseWebApiAdapter({ system: permissiveSystem, fetchImpl: wire.impl })
    const refusal = await adapter.upsert({
      object: 'material',
      records: [{ FNumber: 'MAT-E4-1', FName: 'One' }],
      keyFields: ['FNumber'],
      options: { autoSubmit: true, autoAudit: true },
    }).then(() => null, (error) => error)
    assert.equal(refusal && refusal.details && refusal.details.code, FIXED_CODE, 'still refused')
    assert.equal(wire.calls.length, 0, 'still zero calls')
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

// --------------------------------------------------------------------------------------------
// E4-05 — READ-ONLY regression (anti-fake-green)
// --------------------------------------------------------------------------------------------

test('E4-05: a synthetic read-only K3 fixture REACHES the planner and produces a real dry-run — save/submit/audit = 0', async () => {
  // §15.2 E4-05 anti-fake-green: a blanket deny that killed the read path would satisfy every
  // zero-count assertion in E4-01..E4-04 while destroying the product. This test FAILS if the
  // planner does not actually run — it requires real K3 GetDetail traffic, a classified row and a
  // real revision, none of which a blanket deny could produce.
  const wire = recordingK3()
  const tokenStore = memoryTokenStore()
  const source = countingSourceAdapter(SOURCE_ROWS)
  const { input } = c6Inputs({ wire, tokenStore, source })

  const dryRun = await dryRunExternalWrite(input)

  assert.ok(source.state.reads > 0, 'E4-05: the SOURCE was actually read')
  assert.ok(wire.read > 0, 'E4-05: the K3 READ endpoint was actually reached')
  assert.ok(wire.login > 0, 'E4-05: the read path is allowed to authenticate — the ban is on writes')
  assert.equal(dryRun.counts.sourceRows, SOURCE_ROWS.length, 'E4-05: the planner classified real rows')
  assert.equal(dryRun.counts.add, 1, 'E4-05: a business-level miss still classifies as add')
  assert.equal(dryRun.counts.failed, 0)
  assert.equal(dryRun.counts.held, 0)
  assert.match(String(dryRun.revision), /^[0-9a-f]{64}$/, 'E4-05: a real dry-run revision was computed')
  assert.equal(dryRun.evidence.targetKind, K3_KIND)

  // The apply-facing outputs are the only thing E4 changes about a dry-run.
  assert.equal(dryRun.status, 'not_applyable')
  assert.equal(dryRun.canApply, false)
  assert.equal(dryRun.dryRunToken, null)
  assert.deepEqual(dryRun.externalWriteApply, {
    permanentlyRefused: true,
    refusalCode: FIXED_CODE,
    authority: 'E4',
  }, 'E4-05: the plan carries the fixed values-free marker')

  assert.equal(wire.save, 0, 'E4-05: save = 0')
  assert.equal(wire.submit, 0, 'E4-05: submit = 0')
  assert.equal(wire.audit, 0, 'E4-05: audit = 0')
})

test('E4-05: previewUpsert still composes a K3 Save body and sends nothing', async () => {
  // The other half of the read/preview surface §10 leaves open: composing a body a human can
  // approve is not a write. A blanket deny would take this out too.
  const wire = recordingK3()
  const adapter = createK3WiseWebApiAdapter({ system: k3TargetSystem(), fetchImpl: wire.impl })
  const preview = await adapter.previewUpsert({
    object: 'material',
    records: [{ FNumber: 'MAT-E4-1', FName: 'One' }],
    keyFields: ['FNumber'],
  })
  assert.equal(preview.records.length, 1, 'E4-05: the preview still composes')
  assert.deepEqual(preview.records[0].body, { Data: { FNumber: 'MAT-E4-1', FName: 'One' } })
  assert.match(preview.records[0].path, /\/Material\/Save$/)
  assert.equal(preview.metadata.autoSubmit, false, 'and it still reports the save-only hard lock')
  assert.equal(preview.metadata.autoAudit, false)
  assert.equal(wire.calls.length, 0, 'E4-05: composing sends nothing')
})

// --------------------------------------------------------------------------------------------
// E4-06 — READ-FAILURE regression
// --------------------------------------------------------------------------------------------

// The pre-enumerated read-only failure codes. The write-fence code must never appear here.
const READ_ONLY_FAILURE_CODES = new Set([
  'K3_WISE_READ_FAILED',
  'K3_WISE_READ_BUSINESS_ERROR',
  'K3_WISE_READ_NOT_CONFIGURED',
  'K3_WISE_READ_MODE_MISMATCH',
  'K3_WISE_READ_LIST_NOT_CONFIGURED',
])

test('E4-06: an injected K3 READ failure surfaces a pre-enumerated read-only code, never the write-fence code', async () => {
  for (const failure of ['transport', 'business']) {
    const wire = recordingK3({ readFailure: failure })
    const adapter = createK3WiseWebApiAdapter({ system: k3TargetSystem(), fetchImpl: wire.impl })
    const error = await adapter.read({ object: 'material', filters: { FNumber: 'MAT-E4-1' } })
      .then(() => null, (err) => err)

    assert.ok(error, `${failure}: the injected read failure must surface`)
    const code = error.details && error.details.code
    assert.notEqual(code, FIXED_CODE, `${failure}: a READ failure must NOT be reported as the write fence`)
    assert.ok(
      READ_ONLY_FAILURE_CODES.has(code),
      `${failure}: the surfaced code must be one of the pre-enumerated read-only codes, got ${String(code)}`,
    )
    const serialized = JSON.stringify({ message: error.message, details: error.details })
    assert.equal(serialized.includes(FIXED_CODE), false, `${failure}: the write-fence code must not appear anywhere in a read failure`)
    assert.equal(wire.save, 0, `${failure}: save = 0`)
  }
})

test('E4-06: a K3 read failure inside the C6 planner keeps its own read-only code', async () => {
  // The same property one level up: the planner's lookup is a READ. A transport failure must fail
  // the dry-run CLOSED with the read code — if the fence ever swallowed read errors, this would
  // report the write code instead and turn red.
  const wire = recordingK3({ readFailure: 'transport' })
  const tokenStore = memoryTokenStore()
  const source = countingSourceAdapter(SOURCE_ROWS)
  const { input } = c6Inputs({ wire, tokenStore, source })

  const error = await dryRunExternalWrite(input).then(() => null, (err) => err)
  assert.ok(error, 'the dry-run must fail closed on a transport-level read failure')
  const code = (error.details && error.details.code) || error.code
  assert.notEqual(code, FIXED_CODE, 'a read failure is not a write refusal')
  assert.ok(READ_ONLY_FAILURE_CODES.has(code), `expected a pre-enumerated read-only code, got ${String(code)}`)
  assert.equal(tokenStore.map.size, 0, 'and no token is minted')
  assert.equal(wire.save, 0, 'save = 0')
})
