'use strict'

// Test support (NOT a suite; support/ is outside the chain-completeness walk): THE LARGE-LANE IDENTITY HARNESS of
// batch-refresh step 4 PR-3b (plan-final §5 L05 / P3-C09 large leg; brief item 5).
//
// It drives ONE not-governed project through the REAL large-lane routes (lib/http-routes.cjs over the shared
// project-sheet substrate, support/stock-preparation-project-sheet-harness.cjs) — expansion start, GET, run, plan,
// approve, GET apply job, every chunk until the job is terminal — and reduces every route answer, both stored job
// records, the rows the chunks wrote, the records-API call sequence and the source reads to digests. The REAL refresh
// governance (support/stock-preparation-refresh-governance-wiring.cjs) answers the consults through a recorder that
// counts them per route.
//
// `__tests__/stock-preparation-refresh-large-lane.test.cjs` pins those digests as literals: this very harness's capture
// over the route module of origin/main 4c4cd3aba (PR-3a, before PR-3b), with the four digests that hash #6323/#6324's
// v3 BOM evaluation identity updated as an explicit main -> v3 delta (see the suite's LL-12 block). It replays them on
// the head: the not-governed large lane must answer, store and write byte for byte what it did before PR-3b — apart
// from ONE consult per start / run / plan / approve call and the ONE new values-free key the plan records on the
// expansion job (`governanceVerdict`, stripped here before digesting and returned apart so the suite asserts its shape).
//
// NORMALISATION (both sides alike): every UUID (job ids, lock tokens) is replaced by its ordinal of first appearance
// across the whole observation, so two runs compare structurally and a token in a wrong place still moves a digest;
// every ISO timestamp is masked. Nothing else is touched. Values-free: synthetic ids only.

const crypto = require('node:crypto')
const path = require('node:path')

const PLM_STOCK_PREPARATION_ACTION_ID = 'plm.stock-preparation.pull-bom.v1'
const TENANT = 'tenant-ll-golden'
const PROJECT = 'PRJ-LL-GOLDEN'
const ADMIN = Object.freeze({ id: 'u_ll_golden_admin', tenantId: TENANT, roles: ['admin'], permissions: ['integration:admin'] })
const JOBS_PATH = '/api/integration/table-actions/:actionId/large-bom/expansion-jobs'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z/g

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value === undefined ? null : value))).digest('hex')
}

// One normaliser per observation: UUID ordinals are shared across every value it sees (in call order).
function createNormaliser() {
  const ordinals = new Map()
  function text(value) {
    return value
      .replace(UUID, (match) => {
        if (!ordinals.has(match)) ordinals.set(match, ordinals.size + 1)
        return `<uuid:${ordinals.get(match)}>`
      })
      .replace(ISO, '<ts>')
  }
  function normalise(value) {
    if (typeof value === 'string') return text(value)
    if (Array.isArray(value)) return value.map(normalise)
    if (value && typeof value === 'object') {
      const out = {}
      for (const key of Object.keys(value).sort()) out[text(key)] = normalise(value[key])
      return out
    }
    return value
  }
  return normalise
}

/**
 * Drive the not-governed large lane once, through whatever route module the project-sheet harness mounts (the head's;
 * a capture script points it at the base's through the require cache — never on disk in the repo).
 */
async function observeLargeLane() {
  const harness = require('./stock-preparation-project-sheet-harness.cjs')
  const kit = require('./stock-preparation-project-write-lock-kit.cjs')
  const wiring = require('./stock-preparation-refresh-governance-wiring.cjs')
  const lockEnv = kit.createInMemoryProjectWriteLock({ timers: 'real' })
  let h = null
  let route = 'mount'
  const consults = {}
  const env = wiring.createRefreshGovernanceEnv({
    lockOf: () => lockEnv.lock,
    registryOf: () => (h ? h.services.stockPreparationProjectTargetStore : null),
  })
  const governance = Object.freeze({
    async consult(input) {
      consults[route] = (consults[route] || 0) + 1
      return env.governance.consult(input)
    },
  })
  h = harness.mountProjectSheetRoutes({
    tenantId: TENANT,
    projectNo: PROJECT,
    switchOn: true,
    serviceExtras: {
      stockPreparationProjectWriteLock: lockEnv.lock,
      stockPreparationRefreshGovernance: governance,
      stockPreparationContinuationStore: env.store,
    },
  })
  const call = (label, method, routePath, { params = {}, body } = {}) => {
    route = label
    return harness.call(h.routes, method, routePath, { user: ADMIN, params: { actionId: PLM_STOCK_PREPARATION_ACTION_ID, ...params }, body, query: { tenantId: TENANT } })
  }
  const answers = {}
  const statuses = {}
  const record = (label, res) => {
    statuses[label] = res.statusCode
    answers[label] = { status: res.statusCode, body: res.body === undefined ? null : res.body }
    return res
  }
  try {
    h.seedRegistryRow(PROJECT)
    const started = record('start', await call('start', 'POST', JOBS_PATH, { body: { parameters: { projectNo: PROJECT } } }))
    const jobId = started.body && started.body.data ? started.body.data.jobId : null
    if (!jobId) throw new Error(`large-lane golden: the start answered ${started.statusCode} ${JSON.stringify(started.body && started.body.error)}`)
    record('getQueued', await call('get', 'GET', `${JOBS_PATH}/:jobId`, { params: { jobId } }))
    record('run', await call('run', 'POST', `${JOBS_PATH}/:jobId/run`, { params: { jobId }, body: {} }))
    record('plan', await call('plan', 'POST', `${JOBS_PATH}/:jobId/plan`, { params: { jobId }, body: {} }))
    // The generation token the plan's consult observed (the approval bumps it next).
    const lockLib = require(path.join(__dirname, '..', '..', 'lib', 'stock-preparation-project-write-lock.cjs'))
    const plannedEntry = Array.from(h.context.storage.entries()).find(([key]) => String(key).startsWith('stock-preparation:large-bom:background:'))
    const planTimeToken = plannedEntry ? (await lockEnv.lock.readGeneration(lockLib.sheetWriteScopeKey(plannedEntry[1].actionSnapshot.target.sheetId))).generationToken : undefined
    const approved = record('approve', await call('approve', 'POST', `${JOBS_PATH}/:jobId/apply-jobs`, { params: { jobId }, body: { confirm: { acceptManualConfirmHold: true } } }))
    const applyJobId = approved.body && approved.body.data ? approved.body.data.jobId : null
    if (!applyJobId) throw new Error(`large-lane golden: the approval answered ${approved.statusCode} ${JSON.stringify(approved.body && approved.body.error)}`)
    record('getApply', await call('get', 'GET', `${JOBS_PATH}/:jobId/apply-jobs/:applyJobId`, { params: { jobId, applyJobId } }))
    const chunks = []
    for (let i = 0; i < 20; i += 1) {
      const ran = await call('chunk', 'POST', `${JOBS_PATH}/:jobId/apply-jobs/:applyJobId/run`, { params: { jobId, applyJobId }, body: {} })
      chunks.push({ status: ran.statusCode, body: ran.body === undefined ? null : ran.body })
      const status = ran.body && ran.body.data ? ran.body.data.status : null
      if (ran.statusCode !== 200 || ['succeeded', 'partial'].includes(status)) break
    }
    answers.chunks = chunks
    statuses.chunks = chunks.map((entry) => entry.status)
    record('getFinal', await call('get', 'GET', `${JOBS_PATH}/:jobId`, { params: { jobId } }))
    const storedExpansion = Array.from(h.context.storage.entries()).filter(([key]) => String(key).startsWith('stock-preparation:large-bom:background:'))
    const storedApply = Array.from(h.context.storage.entries()).filter(([key]) => String(key).startsWith('stock-preparation:large-bom:apply:'))
    if (storedExpansion.length !== 1 || storedApply.length !== 1) throw new Error(`large-lane golden: expected one expansion and one apply job record, found ${storedExpansion.length} / ${storedApply.length}`)
    const expansionRecord = JSON.parse(JSON.stringify(storedExpansion[0][1]))
    const verdict = Object.prototype.hasOwnProperty.call(expansionRecord, 'governanceVerdict') ? expansionRecord.governanceVerdict : undefined
    delete expansionRecord.governanceVerdict
    const applyRecord = JSON.parse(JSON.stringify(storedApply[0][1]))
    const normalise = createNormaliser()
    const callLog = h.records.calls.map((entry) => entry.slice())
    const writes = callLog.filter((entry) => entry[0] === 'createRecord' || entry[0] === 'patchRecord')
    // The project sheet as the chunks left it (read AFTER the call log was taken: this read is the harness's own).
    const sheetRows = await h.records.queryRecords({ sheetId: expansionRecord.actionSnapshot.target.sheetId })
    const observed = {
      statuses,
      answers: Object.fromEntries(Object.entries(answers).map(([label, value]) => [label, digest(normalise(value))])),
      storedExpansionJob: digest(normalise({ key: storedExpansion[0][0], value: expansionRecord })),
      storedApplyJob: digest(normalise({ key: storedApply[0][0], value: applyRecord })),
      planRevision: digest(normalise(expansionRecord.planRevision)),
      planArtifact: digest(normalise(expansionRecord.planArtifact)),
      sheetRows: digest(normalise(sheetRows.map((row) => ({ id: row.id, sheetId: row.sheetId, version: row.version, data: row.data })))),
      sheetRowCount: sheetRows.length,
      recordsCalls: digest(normalise(callLog)),
      recordsWrites: writes.length,
      sourceReads: h.source.calls.length,
      sourceReadInputs: digest(normalise(h.source.calls)),
    }
    return {
      observed,
      consults: { start: consults.start || 0, run: consults.run || 0, plan: consults.plan || 0, approve: consults.approve || 0, chunk: consults.chunk || 0, get: consults.get || 0 },
      verdict,
      planTimeToken,
      stepFourRowCount: env.stepFourRowCount(),
    }
  } finally {
    h.restore()
  }
}

module.exports = {
  ADMIN,
  JOBS_PATH,
  PROJECT,
  TENANT,
  createNormaliser,
  digest,
  observeLargeLane,
}
