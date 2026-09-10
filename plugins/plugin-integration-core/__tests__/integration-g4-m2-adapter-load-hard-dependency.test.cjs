'use strict'

/**
 * G4 / M2 — "NO CREDENTIAL-STRIPPED FALLBACK ON AN ADAPTER LOAD PATH".
 *
 * Design: `docs/development/integration-g4-structural-enforcement-design-20260908.md`
 *   * §2 I2 — the SQL public projection may not be adapter input, and NO adapter load point in this
 *     cut may degrade because `getExternalSystemForAdapter` is missing.
 *   * §3 M2  — route `requireService` and runner `requireDependency` gain the accessor as a HARD
 *     dependency; the 13 ternary fallbacks become direct calls; the 2 C6 target overloads lose their
 *     method-existence condition but keep the peek -> kind -> reload order.
 *   * §4 M2-a / M2-b — what each of these tests must be able to catch, and what it may not claim.
 *
 * WHY A SEPARATE SUITE, AND WHAT EACH HALF IS FOR
 * -----------------------------------------------
 * The failure this closes (#5538's shape, restated in the design's §1 table) is not "a guard was
 * wrong" — it is "a guard was OPTIONAL, so removing it broke nothing that anyone was watching". Two
 * independent things therefore have to be witnessed, and neither may be allowed to stand in for the
 * other:
 *
 *   M2-a  CONSTRUCTION.  A services object / deps object WITHOUT the decrypting accessor must be
 *         refused at mount time. Mutation: delete the name from the dependency list -> registration
 *         succeeds -> the refusal tests below go red. This says nothing about what any route does.
 *
 *   M2-b  CALL SITES.  Every adapter load must actually read the decrypting accessor. Two guards:
 *         a STRUCTURAL one (an allowlist of the exact expression forms the two production modules
 *         may use, so restoring a fallback at ANY ONE point is a red), and RUNTIME ones (the object
 *         handed to `createAdapter` is the one the decrypting accessor returned, not the public
 *         projection). Mutation: restore the ternary at one site -> the runtime test for that site
 *         and the structural test both go red.
 *
 * The design also rules out a NON-discriminating report: once the hard dependency exists, "restore
 * the ternary AND use a stub that omits the accessor" fails registration in the original too, so it
 * proves nothing. Every mutation in `scripts/g4-m2-mutation-probe.cjs` is one that the ORIGINAL
 * passes and the mutant fails.
 *
 * ALIASING IS THE OTHER FAKE-GREEN. Every registry stub here returns two DIFFERENT objects from the
 * two accessors — the public one with the kind's private config subtree deleted and no credentials,
 * exactly as `external-systems.cjs publicRow()` builds it. A stub that aliases one function to the
 * other cannot tell a degraded call site from a correct one.
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const httpRoutes = require('../lib/http-routes.cjs')
const { createPipelineRunner } = require('../lib/pipeline-runner.cjs')

const PLUGIN_ROOT = path.resolve(__dirname, '..')
const HTTP_ROUTES_FILE = path.join(PLUGIN_ROOT, 'lib', 'http-routes.cjs')
const PIPELINE_RUNNER_FILE = path.join(PLUGIN_ROOT, 'lib', 'pipeline-runner.cjs')

const TENANT_ID = 't_g4'
const WRITER = Object.freeze({ id: 'u_write', tenantId: TENANT_ID, permissions: ['integration:write'] })
const READER = Object.freeze({ id: 'u_read', tenantId: TENANT_ID, permissions: ['integration:read'] })

// ============================================================================================
// PART 1 — M2-b STRUCTURAL: the two production modules may only express these forms
// ============================================================================================

/**
 * Physical source lines, with whole-line comments dropped.
 *
 * Deliberately NOT a comment-stripping parser: a line that merely STARTS a comment is dropped, and
 * anything else is treated as code in full. A trailing `// …` appended to one of the allowlisted
 * lines therefore turns this suite red and has to be added to the allowlist on purpose. That is the
 * fail-closed direction; a cleverer stripper would be the other one.
 *
 * `\r?\n` because `lib/pipeline-runner.cjs` is not `eol=lf` in `.gitattributes` and is CRLF on a
 * `core.autocrlf=true` Windows checkout.
 */
function codeLines(file) {
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line, index) => ({ number: index + 1, text: line.trim() }))
    .filter(({ text }) => text.length > 0)
    .filter(({ text }) => !text.startsWith('//') && !text.startsWith('*') && !text.startsWith('/*'))
}

/** Mentions the DECRYPTING accessor. */
const DECRYPTING = /getExternalSystemForAdapter/

/**
 * Mentions the CREDENTIAL-STRIPPED public accessor. The negative lookahead keeps the three sibling
 * accessors out: `…ForAdapter` (decrypting), `…AdapterConfig` (non-decrypting guard read),
 * `…ForSealedSnapshot` and `…InstanceDigest`.
 */
const PUBLIC_PROJECTION = /(?:\.getExternalSystem(?![A-Za-z])|'getExternalSystem')/

/**
 * THE ONLY FORMS AN ADAPTER LOAD MAY TAKE in `lib/http-routes.cjs`.
 *
 * Anything else mentioning the decrypting accessor — a restored `typeof … === 'function' ? … : …`
 * ternary, a `… || externalSystems.getExternalSystem` coalesce, an `externalSystems?.
 * getExternalSystemForAdapter` optional call — matches none of these and is a red.
 */
const ROUTE_DECRYPTING_FORMS = Object.freeze([
  {
    // The HARD dependency itself. Written out in full so that removing the accessor from the list
    // (the M2-a mutation) also moves this structural guard — reported as such, never as the
    // designed witness for M2-a, which is the registration test in PART 2.
    exact: "const externalSystems = requireService('externalSystemRegistry', ['upsertExternalSystem', 'getExternalSystem', 'getExternalSystemForAdapter', 'deleteExternalSystem', 'listExternalSystems'])",
    count: 1,
    why: 'the registration-time hard dependency (§3 M2)',
  },
  {
    exact: 'const loadSystem = externalSystems.getExternalSystemForAdapter.bind(externalSystems)',
    count: 11,
    why: 'an unconditional adapter-load binding',
  },
  {
    exact: 'const loadSourceSystem = externalSystems.getExternalSystemForAdapter.bind(externalSystems)',
    count: 2,
    why: 'an unconditional C6 SOURCE adapter-load binding (dry-run + apply)',
  },
  {
    exact: 'targetSystem = await externalSystems.getExternalSystemForAdapter(targetSystemScope)',
    count: 2,
    why: 'the C6 target credential RELOAD, reached only through the kind check above it',
  },
])

/**
 * EVERY REMAINING PUBLIC-PROJECTION READ in `lib/http-routes.cjs`, each with the reason it is not an
 * adapter load. This is the half that makes the guard structural rather than a spot check: a new
 * public read cannot appear in this module without a reviewer adding it here and saying why the
 * object never reaches `createAdapter`.
 */
const ROUTE_PUBLIC_PROJECTION_FORMS = Object.freeze([
  {
    exact: 'const sourceSystem = await externalSystems.getExternalSystem(scopedInput(req, { id: pipeline.sourceSystemId }))',
    count: 1,
    why: 'B2a: the source system KIND for the registration key. Contracted to precede any credential reload; the fence tests assert the decrypting accessor was called zero times on a refusal.',
  },
  {
    exact: 'const targetSystem = await externalSystems.getExternalSystem(scopedInput(req, { id: pipeline.targetSystemId }))',
    count: 1,
    why: 'E3-01: the target KIND for the safe-lifecycle check. Identifying a kind must not itself reload secrets.',
  },
  {
    exact: ": (typeof externalSystems.getExternalSystem === 'function'",
    count: 1,
    why: 'peekTableActionSourceBinding second preference. A values-free, connection-free peek whose only consumer is the read-PRINCIPAL resolution; it builds no adapter and the field it reads (config.dataSourceOwnerId) survives the public projection.',
  },
  {
    exact: '? externalSystems.getExternalSystem.bind(externalSystems)',
    count: 1,
    why: 'the same peek, continued.',
  },
  {
    exact: 'return sendOk(res, await externalSystems.getExternalSystem(scopedInput(req, { id: requestParams(req).id })))',
    count: 1,
    why: 'the public GET route — the projection IS the response body.',
  },
  {
    exact: 'let targetSystem = await externalSystems.getExternalSystem(targetSystemScope)',
    count: 2,
    why: 'the C6 PEEK. Kept first on purpose (§3 M2): the kind is the cheapest fact, and only adapter-backed kinds are then re-loaded with credentials.',
  },
  {
    exact: 'getExternalSystem: (input) => externalSystems.getExternalSystem(input),',
    count: 2,
    why: 'handed to resolveC6WritePlanInputs for the K3 B4 same-INSTANCE comparison, which reads baseUrl/kind only. Credentials reach that planner through the already-reloaded targetSystem, not through this seam.',
  },
  {
    exact: 'const candidate = await externalSystems.getExternalSystem({ ...listScope, id: externalSystemId })',
    count: 1,
    why: 'source-binding admission check: kind + accessibility of a candidate row. Nothing downstream builds an adapter from it.',
  },
])

const RUNNER_DECRYPTING_FORMS = Object.freeze([
  {
    exact: "const externalSystemRegistry = requireDependency(deps, 'externalSystemRegistry', ['getExternalSystem', 'getExternalSystemForAdapter'])",
    count: 1,
    why: 'the runner-side hard dependency (§3 M2: the route layer cannot reach this constructor)',
  },
  {
    exact: 'return externalSystemRegistry.getExternalSystemForAdapter(input)',
    count: 1,
    why: 'the sole body of loadExternalSystemForAdapter — source, target and replay all route through it',
  },
])

const RUNNER_PUBLIC_PROJECTION_FORMS = Object.freeze([
  {
    exact: 'const sourceSystem = await externalSystemRegistry.getExternalSystem({',
    count: 1,
    why: 'B2a: the source system KIND for the registration key, same contract as the route half — before any credential reload.',
  },
])

function assertOnlyAllowedForms({ file, label, mentions, forms }) {
  const lines = codeLines(file).filter(({ text }) => mentions.test(text))
  const allowed = new Map(forms.map((form) => [form.exact, form]))
  const seen = new Map()

  for (const { number, text } of lines) {
    const form = allowed.get(text)
    assert.ok(
      form,
      `${label}: ${path.basename(file)}:${number} is not one of the allowed forms.\n`
        + `  line: ${text}\n`
        + '  If this is a NEW adapter load, use the existing unconditional form. If it is a new\n'
        + '  non-adapter read of the public projection, add it to the allowlist in this file WITH\n'
        + '  the reason it never reaches createAdapter. Restoring a fallback is neither.',
    )
    seen.set(text, (seen.get(text) || 0) + 1)
  }

  for (const form of forms) {
    assert.equal(
      seen.get(form.exact) || 0,
      form.count,
      `${label}: expected ${form.count} occurrence(s) of "${form.exact}" (${form.why}); `
        + `found ${seen.get(form.exact) || 0}. A deliberate change updates this count.`,
    )
  }
}

test('G4/M2-b structural: every getExternalSystemForAdapter expression in http-routes.cjs is an UNCONDITIONAL adapter load', () => {
  assertOnlyAllowedForms({
    file: HTTP_ROUTES_FILE,
    label: 'route decrypting-accessor forms',
    mentions: DECRYPTING,
    forms: ROUTE_DECRYPTING_FORMS,
  })
})

test('G4/M2-b structural: every public-projection read in http-routes.cjs is on the reviewed non-adapter allowlist', () => {
  assertOnlyAllowedForms({
    file: HTTP_ROUTES_FILE,
    label: 'route public-projection forms',
    // A line that mentions BOTH (the requireService dependency list) is covered by the decrypting
    // allowlist above; excluding it here keeps each line under exactly one roster.
    mentions: { test: (text) => PUBLIC_PROJECTION.test(text) && !DECRYPTING.test(text) },
    forms: ROUTE_PUBLIC_PROJECTION_FORMS,
  })
})

test('G4/M2-b structural: pipeline-runner.cjs expresses one unconditional adapter load and one non-adapter kind read', () => {
  assertOnlyAllowedForms({
    file: PIPELINE_RUNNER_FILE,
    label: 'runner decrypting-accessor forms',
    mentions: DECRYPTING,
    forms: RUNNER_DECRYPTING_FORMS,
  })
  assertOnlyAllowedForms({
    file: PIPELINE_RUNNER_FILE,
    label: 'runner public-projection forms',
    mentions: { test: (text) => PUBLIC_PROJECTION.test(text) && !DECRYPTING.test(text) },
    forms: RUNNER_PUBLIC_PROJECTION_FORMS,
  })
})

// ============================================================================================
// Shared fixtures for PART 2 and PART 3
// ============================================================================================

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

function inertService(methods) {
  const service = {}
  for (const method of methods) {
    service[method] = async () => { throw new Error(`unexpected service call: ${method}`) }
  }
  return service
}

const NOOP_CONFIG_STORE = Object.freeze({
  async saveVersion() { return {} },
  async list() { return [] },
  async get() { return {} },
  async approve() { return {} },
  async retire() { return {} },
  async listAudit() { return [] },
  async getForRuntime() { return {} },
})

/**
 * A stored row and its PUBLIC projection, built the way `external-systems.cjs` builds them.
 *
 * `credentials` is deleted and the kind's private config subtree is deleted — for
 * `data-source:sql-readonly` that is `lookupProjection` (PRIVATE_CONFIG_KEYS_BY_KIND). Both halves
 * matter: the credentials difference catches an HTTP-kind degradation, the config difference catches
 * a SQL-kind one, and a stub that returned the same object twice would catch neither.
 */
function publicProjectionOf(row) {
  const { credentials, ...rest } = row
  const config = { ...(row.config || {}) }
  delete config.lookupProjection
  return { ...rest, config }
}

/**
 * The registry every runtime case mounts: two DISTINCT accessors over one store, each recording its
 * own calls so a test can say WHICH accessor an adapter's object came from.
 */
function recordingRegistry(rows) {
  const systems = new Map(rows.map((row) => [row.id, row]))
  const calls = { public: [], decrypting: [] }
  return {
    calls,
    registry: {
      async upsertExternalSystem() { return {} },
      async deleteExternalSystem() { return {} },
      async listExternalSystems() { return [] },
      async getExternalSystem(input = {}) {
        calls.public.push(input.id)
        const row = systems.get(input.id)
        return row ? publicProjectionOf(row) : null
      },
      async getExternalSystemForAdapter(input = {}) {
        calls.decrypting.push(input.id)
        const row = systems.get(input.id)
        return row ? { ...row } : null
      },
    },
  }
}

const HTTP_SYSTEM = Object.freeze({
  id: 'sys_http',
  name: 'Vendor HTTP',
  kind: 'http',
  role: 'source',
  status: 'active',
  config: { baseUrl: 'https://vendor.example/api' },
  credentials: { token: 'REDACTED-IN-TEST' },
})

const SQL_SYSTEM = Object.freeze({
  id: 'sys_sql',
  name: 'Readonly PLM SQL',
  kind: 'data-source:sql-readonly',
  role: 'source',
  status: 'active',
  config: { dataSourceId: 'ds_plm', schema: 'dbo', lookupProjection: { table: 'dbo.parts' } },
  credentials: { password: 'REDACTED-IN-TEST' },
})

function mountRoutes({ registry, adapterRegistry, pipelineRegistry, storage, config }) {
  const routes = new Map()
  httpRoutes.registerIntegrationRoutes({
    context: {
      storage: storage || new Map(),
      config: config || {},
      api: {
        http: {
          addRoute(method, routePath, handler) {
            routes.set(`${String(method).toUpperCase()} ${routePath}`, handler)
          },
        },
        multitable: { provisioning: {}, records: {} },
      },
    },
    services: {
      externalSystemRegistry: registry,
      adapterRegistry,
      pipelineRegistry: pipelineRegistry
        || inertService(['upsertPipeline', 'getPipeline', 'listPipelines', 'listPipelineRuns']),
      pipelineRunner: inertService(['runPipeline']),
      deadLetterStore: inertService(['listDeadLetters']),
      stagingInstaller: inertService(['installStaging', 'listStagingDescriptors']),
      templateRegistry: inertService(['upsertTemplate', 'getTemplate', 'listTemplates', 'deleteTemplate', 'instantiateTemplate']),
      readSourceConfigStore: NOOP_CONFIG_STORE,
      readSourceCompositionConfigStore: NOOP_CONFIG_STORE,
      bridgeAgentChecklistStore: inertService(['saveVersion', 'approve', 'retire', 'getForApply']),
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  return routes
}

// ============================================================================================
// PART 2 — M2-a CONSTRUCTION: the accessor is unrepresentably absent
// ============================================================================================

test('G4/M2-a route: registerIntegrationRoutes REFUSES a registry without getExternalSystemForAdapter', () => {
  const { registry } = recordingRegistry([HTTP_SYSTEM])
  delete registry.getExternalSystemForAdapter

  assert.throws(
    () => mountRoutes({ registry, adapterRegistry: { createAdapter() { return {} }, listAdapterKinds() { return [] } } }),
    /externalSystemRegistry\.getExternalSystemForAdapter is required/,
    'a services object that omits the decrypting accessor must not mount at all — the pre-M2 code '
      + 'mounted happily and downgraded every credential load to the public projection at request time',
  )
})

test('G4/M2-a route control: the SAME mount succeeds once the decrypting accessor is present', () => {
  const { registry } = recordingRegistry([HTTP_SYSTEM])
  const routes = mountRoutes({
    registry,
    adapterRegistry: { createAdapter() { return {} }, listAdapterKinds() { return [] } },
  })
  // Anti-fake-green for the refusal above: it must be THIS method that decided, not some unrelated
  // breakage in the harness.
  assert.ok(routes.size > 0, 'the identical harness mounts when the accessor is present')
})

function runnerDeps(registry) {
  return {
    pipelineRegistry: { async getPipeline() { return null } },
    externalSystemRegistry: registry,
    adapterRegistry: { createAdapter() { return {} } },
    deadLetterStore: { async createDeadLetter() { return {} } },
    watermarkStore: { async getWatermark() { return null }, async setWatermark() { return {} } },
    runLogger: { async startRun() { return { id: 'run_1' } }, async finishRun() { return {} } },
  }
}

test('G4/M2-a runner: createPipelineRunner REFUSES deps without getExternalSystemForAdapter', () => {
  const { registry } = recordingRegistry([HTTP_SYSTEM])
  delete registry.getExternalSystemForAdapter

  assert.throws(
    () => createPipelineRunner(runnerDeps(registry)),
    /createPipelineRunner: externalSystemRegistry\.getExternalSystemForAdapter is required/,
    'the runner has its OWN dependency check and index.cjs builds it directly, so the route layer’s '
      + 'hard dependency cannot cover this door',
  )
})

test('G4/M2-a runner control: the SAME deps construct once the decrypting accessor is present', () => {
  const { registry } = recordingRegistry([HTTP_SYSTEM])
  const runner = createPipelineRunner(runnerDeps(registry))
  assert.equal(typeof runner.runPipeline, 'function')
})

// ============================================================================================
// PART 3 — M2-b RUNTIME: the object an adapter is built from came from the DECRYPTING accessor
// ============================================================================================

test('G4/M2-b runtime (HTTP kind): externalSystemsTest builds its adapter from the DECRYPTING accessor', async () => {
  const { registry, calls } = recordingRegistry([HTTP_SYSTEM])
  const adapterInputs = []
  const routes = mountRoutes({
    registry,
    adapterRegistry: {
      listAdapterKinds() { return ['http'] },
      createAdapter(system) {
        adapterInputs.push(system)
        return { async testConnection() { return { ok: true } } }
      },
    },
  })

  const res = await invoke(routes, 'POST', '/api/integration/external-systems/:id/test', {
    user: WRITER,
    params: { id: HTTP_SYSTEM.id },
  })

  assert.equal(res.statusCode, 200)
  assert.equal(adapterInputs.length, 1, 'exactly one adapter was built')
  assert.deepEqual(calls.decrypting, [HTTP_SYSTEM.id], 'the decrypting accessor was the one that loaded it')
  assert.deepEqual(calls.public, [], 'the credential-stripped projection was not read on this path at all')
  // The property, not the accessor name: a degraded call site hands over a row with no credentials.
  assert.deepEqual(
    adapterInputs[0].credentials,
    HTTP_SYSTEM.credentials,
    'the adapter received the CREDENTIAL-BEARING row; the public projection deletes this field',
  )
})

test('G4/M2-b runtime (SQL kind): externalSystemObjects builds its adapter from the DECRYPTING accessor', async () => {
  const { registry, calls } = recordingRegistry([SQL_SYSTEM])
  const adapterInputs = []
  const routes = mountRoutes({
    registry,
    adapterRegistry: {
      listAdapterKinds() { return ['data-source:sql-readonly'] },
      createAdapter(system) {
        adapterInputs.push(system)
        return { async listObjects() { return [] } }
      },
    },
  })

  const res = await invoke(routes, 'GET', '/api/integration/external-systems/:id/objects', {
    user: READER,
    params: { id: SQL_SYSTEM.id },
  })

  assert.equal(res.statusCode, 200)
  assert.equal(adapterInputs.length, 1)
  assert.deepEqual(calls.decrypting, [SQL_SYSTEM.id])
  assert.deepEqual(calls.public, [])
  // The SQL half is deliberately asserted on the PRIVATE CONFIG SUBTREE rather than on credentials:
  // `publicRow()` deletes `lookupProjection` for this kind, and an adapter built from the projection
  // would be silently reading a different plan — the #5534 shape.
  assert.deepEqual(
    adapterInputs[0].config.lookupProjection,
    SQL_SYSTEM.config.lookupProjection,
    'the adapter received the FULL config; the public projection deletes the private subtree',
  )
})

/**
 * The runner half. `runPipeline` resolves BOTH systems and builds BOTH adapters as its first act,
 * and dead-letter replay re-enters through it — so one dry run witnesses the source leg, the target
 * leg and (by construction) the accessor replay's kind check reads.
 */
test('G4/M2-b runtime (runner): the pipeline SOURCE and TARGET adapters are built from the DECRYPTING accessor', async () => {
  const target = {
    id: 'sys_target',
    name: 'Staging',
    kind: 'metasheet:staging',
    role: 'target',
    status: 'active',
    config: { sheetId: 'sheet_1' },
    credentials: { token: 'REDACTED-IN-TEST' },
  }
  const { registry, calls } = recordingRegistry([SQL_SYSTEM, target])
  const adapterInputs = []

  const runner = createPipelineRunner({
    pipelineRegistry: {
      async getPipeline() {
        return {
          id: 'pipe_g4',
          tenantId: TENANT_ID,
          workspaceId: null,
          sourceSystemId: SQL_SYSTEM.id,
          sourceObject: 'parts',
          targetSystemId: target.id,
          targetObject: 'parts',
          status: 'active',
          createdBy: 'u_owner',
          fieldMappings: [{ sourceField: 'code', targetField: 'code' }],
        }
      },
    },
    externalSystemRegistry: registry,
    adapterRegistry: {
      createAdapter(system) {
        adapterInputs.push(system)
        return {
          async read() { return { records: [{ code: 'MAT-1' }], done: true } },
          async upsert() { return { written: 1, failed: 0, results: [], errors: [] } },
          async previewUpsert() { return { records: [], metadata: {} } },
        }
      },
    },
    deadLetterStore: { async createDeadLetter() { return {} } },
    watermarkStore: { async getWatermark() { return null }, async setWatermark() { return {} } },
    runLogger: { async startRun() { return { id: 'run_1' } }, async finishRun() { return {} }, async failRun() { return {} } },
    logger: { info() {}, warn() {}, error() {} },
  })

  await runner.runPipeline({
    tenantId: TENANT_ID,
    workspaceId: null,
    pipelineId: 'pipe_g4',
    dryRun: true,
  })

  assert.deepEqual(
    calls.decrypting,
    [SQL_SYSTEM.id, target.id],
    'both legs were loaded through the decrypting accessor, source first',
  )
  assert.deepEqual(calls.public, [], 'a dormant runner reads the public projection on neither leg')
  const source = adapterInputs.find((system) => system.id === SQL_SYSTEM.id)
  const loadedTarget = adapterInputs.find((system) => system.id === target.id)
  assert.ok(source && loadedTarget, 'both adapters were built')
  assert.deepEqual(source.config.lookupProjection, SQL_SYSTEM.config.lookupProjection)
  assert.deepEqual(loadedTarget.credentials, target.credentials)
})

// ============================================================================================
// PART 4 — M2-b C6: the target overload keeps its KIND limit after losing its existence check
// ============================================================================================

const K3_TARGET_KIND = 'erp:k3-wise-webapi'
const NON_ADAPTER_BACKED_TARGET_KIND = 'metasheet:multitable'

function c6Harness(targetKind) {
  const source = { ...SQL_SYSTEM, id: 'sys_c6_source' }
  const target = {
    id: 'sys_c6_target',
    name: 'C6 target',
    kind: targetKind,
    role: 'target',
    status: 'active',
    config: { baseUrl: 'https://erp.example/k3', sheetId: 'sheet_1' },
    credentials: { acctId: 'REDACTED-IN-TEST' },
  }
  const { registry, calls } = recordingRegistry([source, target])
  const routes = mountRoutes({
    registry,
    adapterRegistry: {
      listAdapterKinds() { return [targetKind, SQL_SYSTEM.kind] },
      createAdapter() {
        return {
          async read() { return { records: [], done: true } },
          async previewUpsert() { return { records: [], metadata: {} } },
          async upsert() { return { written: 0, failed: 0, results: [], errors: [] } },
        }
      },
    },
    pipelineRegistry: {
      async upsertPipeline() { return {} },
      async listPipelines() { return [] },
      async listPipelineRuns() { return [] },
      async getPipeline() {
        return {
          id: 'pipe_c6',
          tenantId: TENANT_ID,
          workspaceId: null,
          sourceSystemId: source.id,
          sourceObject: 'parts',
          targetSystemId: target.id,
          targetObject: 'parts',
          status: 'active',
          createdBy: 'u_owner',
          fieldMappings: [{ sourceField: 'code', targetField: 'FNumber' }],
        }
      },
    },
  })
  return { routes, calls, source, target }
}

test('G4/M2-b C6 dry-run: an ADAPTER-BACKED target IS re-loaded through the decrypting accessor', async () => {
  const h = c6Harness(K3_TARGET_KIND)

  await invoke(h.routes, 'POST', '/api/integration/pipelines/:id/external-write/dry-run', {
    user: READER,
    params: { id: 'pipe_c6' },
    body: {},
  })

  // Order is the contract, not an accident: peek the target (stripped) -> decide by kind -> reload.
  assert.deepEqual(
    h.calls.public,
    [h.target.id],
    'the target was PEEKED once through the credential-stripped accessor',
  )
  assert.deepEqual(
    h.calls.decrypting,
    [h.source.id, h.target.id],
    'the source always reloads; an adapter-backed target reloads too, and only after the kind check',
  )
})

test('G4/M2-b C6 dry-run: a NON-adapter-backed target is NEVER re-loaded through the decrypting accessor', async () => {
  const h = c6Harness(NON_ADAPTER_BACKED_TARGET_KIND)

  await invoke(h.routes, 'POST', '/api/integration/pipelines/:id/external-write/dry-run', {
    user: READER,
    params: { id: 'pipe_c6' },
    body: {},
  })

  assert.deepEqual(h.calls.public, [h.target.id], 'the peek still happens')
  assert.deepEqual(
    h.calls.decrypting,
    [h.source.id],
    'M2 removed the METHOD-EXISTENCE condition only. The KIND limit is what stops a config-only '
      + 'target from being handed decrypted credentials, and it is still standing.',
  )
})

/**
 * The apply half, stated as it actually is rather than as a mirror of the dry-run.
 *
 * `ADAPTER_BACKED_C6_TARGET_KINDS` has exactly one member (`erp:k3-wise-webapi`), and on the APPLY
 * route the E4 layer-1 permanent fence refuses that kind BEFORE the source load and before the
 * target reload. So apply's adapter-backed reload branch is, today, unreachable — and this test
 * pins that fact instead of claiming a reload it cannot witness. If the fence is ever narrowed or a
 * second adapter-backed kind is added, this test is where the change has to be acknowledged.
 */
test('G4/M2-b C6 apply: the only adapter-backed kind is refused BEFORE any credential load', async () => {
  const h = c6Harness(K3_TARGET_KIND)

  const res = await invoke(h.routes, 'POST', '/api/integration/pipelines/:id/external-write/apply', {
    user: WRITER,
    params: { id: 'pipe_c6' },
    body: { confirm: { dryRunToken: 'never-minted' } },
  })

  assert.equal(res.statusCode, 403)
  assert.equal(res.body.error.code, 'K3_WISE_EXTERNAL_WRITE_DISABLED')
  assert.deepEqual(h.calls.public, [h.target.id], 'the credential-stripped peek is all that ran')
  assert.deepEqual(h.calls.decrypting, [], 'zero credential loads — neither source nor target')
})

test('G4/M2-b C6 apply: a NON-adapter-backed target loads the SOURCE with credentials and the target without', async () => {
  const h = c6Harness(NON_ADAPTER_BACKED_TARGET_KIND)

  await invoke(h.routes, 'POST', '/api/integration/pipelines/:id/external-write/apply', {
    user: WRITER,
    params: { id: 'pipe_c6' },
    body: { confirm: { dryRunToken: 'never-minted' } },
  })

  assert.deepEqual(h.calls.public, [h.target.id])
  assert.deepEqual(
    h.calls.decrypting,
    [h.source.id],
    'the apply source load is unconditional after M2; the config-only target stays config-only',
  )
})
