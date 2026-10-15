import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseYamlDocument } from './ci-realdb-step-contract.mjs'

export const FROZEN_SHA = '42984091d7fe0e4f81ac026243200840c314bb79'
export const SCHEMA = 'ci-execution-ledger-p0/1'
export const RECEIPT_SCHEMA = 'ci-execution-receipt-p0/1'
export const SOURCE_PATHS = Object.freeze([
  '.github/workflows/plugin-tests.yml',
  '.github/workflows/web-tests.yml',
  'apps/web/scripts/run-required-web-tests.sh',
])
export const WEB_RUNNER_PATH = SOURCE_PATHS[2]
const WORKFLOW_PATHS = SOURCE_PATHS.slice(0, 2)
const RUNNER_MARK = 'run-required-web-tests.sh'
const SAFE_ID = /^[A-Za-z0-9_-]+$/
const REQUIRED_NAME = /^[A-Za-z0-9_ .()+-]+$/
const USES_REF = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+@[A-Za-z0-9_.-]+$/
const HEX64 = /^[0-9a-f]{64}$/
const HEX40 = /^[0-9a-f]{40}$/

export class LedgerError extends Error {
  constructor(code) {
    super(code)
    this.name = 'LedgerError'
    this.code = code
  }
}

function fail(code) {
  throw new LedgerError(code)
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isObject(value)) return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key])
  return out
}

export function canonicalDigest(value) {
  return sha256(Buffer.from(JSON.stringify(canonicalize(value)), 'utf8'))
}

function hashOrNull(value) {
  if (value === undefined || value === null) return null
  return canonicalDigest(value)
}

function boundedFlag(value) {
  if (value == null) return null
  if (value === true || value === false) return value
  return hashOrNull(value)
}

function boundedInt(value) {
  if (value == null) return null
  if (Number.isInteger(value) && value >= 0 && value <= 100000) return value
  return hashOrNull(value)
}

function needsOf(value) {
  if (value == null) return []
  const list = typeof value === 'string' ? [value] : value
  if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || !SAFE_ID.test(item))) {
    fail('LEDGER_MALFORMED_SCHEMA')
  }
  return list.slice()
}

function projectUses(value) {
  if (value == null) return null
  if (typeof value === 'string' && !value.includes('://') && !value.includes('${{') && USES_REF.test(value)) {
    return value
  }
  return hashOrNull(value)
}

function bufferOf(value) {
  if (Buffer.isBuffer(value)) return value
  if (typeof value === 'string') return Buffer.from(value, 'utf8')
  fail('LEDGER_MALFORMED_SCHEMA')
}

function projectWorkflow(path, buf) {
  const text = buf.toString('utf8')
  let doc
  try {
    doc = parseYamlDocument(text)
  } catch {
    fail('LEDGER_MALFORMED_YAML')
  }
  if (!isObject(doc) || !isObject(doc.jobs) || Object.keys(doc.jobs).length === 0) fail('LEDGER_MALFORMED_SCHEMA')
  const jobs = []
  const invocationContexts = []
  for (const [jobId, job] of Object.entries(doc.jobs)) {
    if (!SAFE_ID.test(jobId) || !isObject(job) || !Array.isArray(job.steps)) fail('LEDGER_MALFORMED_SCHEMA')
    const steps = job.steps.map((step, index) => {
      if (!isObject(step)) fail('LEDGER_MALFORMED_SCHEMA')
      if (Object.prototype.hasOwnProperty.call(step, 'run') && typeof step.run !== 'string') fail('LEDGER_MALFORMED_SCHEMA')
      const run = typeof step.run === 'string' ? step.run : null
      const runHash = hashOrNull(run)
      if (run !== null && run.includes(RUNNER_MARK)) {
        invocationContexts.push({ workflowPath: path, jobId, index, runHash })
      }
      const id = step.id == null ? null : (typeof step.id === 'string' && SAFE_ID.test(step.id) ? step.id : hashOrNull(step.id))
      return {
        index,
        id,
        uses: projectUses(step.uses),
        runHash,
        ifHash: hashOrNull(step.if ?? null),
        envHash: hashOrNull(step.env ?? null),
        withHash: hashOrNull(step.with ?? null),
        shell: typeof step.shell === 'string' && SAFE_ID.test(step.shell) ? step.shell : null,
        shellHash: typeof step.shell === 'string' && SAFE_ID.test(step.shell) ? null : hashOrNull(step.shell ?? null),
        cwdHash: hashOrNull(step['working-directory'] ?? null),
        continueOnError: boundedFlag(step['continue-on-error']),
        timeoutMinutes: boundedInt(step['timeout-minutes']),
      }
    })
    jobs.push({
      id: jobId,
      nameHash: hashOrNull(job.name ?? null),
      needs: needsOf(job.needs),
      ifHash: hashOrNull(job.if ?? null),
      runnerHash: hashOrNull(job['runs-on'] ?? null),
      servicesHash: hashOrNull(job.services ?? null),
      environmentHash: hashOrNull(job.environment ?? null),
      defaultsHash: hashOrNull(job.defaults ?? null),
      envHash: hashOrNull(job.env ?? null),
      matrixHash: hashOrNull(job.strategy ?? null),
      timeoutMinutes: boundedInt(job['timeout-minutes']),
      steps,
    })
  }
  const trigger = doc.True !== undefined ? doc.True : (doc.on ?? null)
  return {
    path,
    sha256: sha256(buf),
    byteLength: buf.length,
    triggerHash: hashOrNull(trigger),
    concurrencyHash: hashOrNull(doc.concurrency ?? null),
    environmentHash: hashOrNull(doc.env ?? null),
    defaultsHash: hashOrNull(doc.defaults ?? null),
    jobs,
    invocationContexts,
  }
}

export function buildLedger(files) {
  if (!isObject(files)) fail('LEDGER_MALFORMED_SCHEMA')
  for (const path of SOURCE_PATHS) if (!Object.prototype.hasOwnProperty.call(files, path)) fail('LEDGER_MISSING_FILE')
  const buffers = Object.fromEntries(SOURCE_PATHS.map((path) => [path, bufferOf(files[path])]))
  const workflows = WORKFLOW_PATHS.map((path) => projectWorkflow(path, buffers[path]))
  const invocationContexts = []
  for (const workflow of workflows) {
    for (const ctx of workflow.invocationContexts) {
      invocationContexts.push({
        ...ctx,
        occurrence: String(invocationContexts.length + 1),
        runnerSha256: sha256(buffers[WEB_RUNNER_PATH]),
      })
    }
  }
  if (invocationContexts.length === 0) fail('INVOCATION_EMPTY')
  const body = {
    schema: SCHEMA,
    frozenSha: FROZEN_SHA,
    sources: SOURCE_PATHS.map((path) => ({
      path,
      sha256: sha256(buffers[path]),
      byteLength: buffers[path].length,
    })),
    webRunner: {
      path: WEB_RUNNER_PATH,
      sha256: sha256(buffers[WEB_RUNNER_PATH]),
      byteLength: buffers[WEB_RUNNER_PATH].length,
      binding: 'exact-source-hash',
      shellParsed: false,
      runtimeCasesCollected: false,
    },
    workflows: workflows.map(({ invocationContexts: _ignored, ...workflow }) => workflow),
    invocationContexts,
  }
  return { ...body, ledgerDigest: canonicalDigest(body) }
}

function isHash(value) {
  return typeof value === 'string' && HEX64.test(value)
}

function requireHashOrNull(value) {
  if (value !== null && !isHash(value)) fail('LEDGER_MALFORMED_SCHEMA')
}

function requireCount(value) {
  if (!Number.isInteger(value) || value < 0 || value > 20000000) fail('LEDGER_MALFORMED_SCHEMA')
}

function requireUses(value) {
  if (value === null || isHash(value)) return
  if (typeof value !== 'string' || value.includes('://') || value.includes('${{') || !USES_REF.test(value)) {
    fail('LEDGER_MALFORMED_SCHEMA')
  }
}

function requireStep(step, index) {
  if (!isObject(step) || step.index !== index) fail('LEDGER_MALFORMED_SCHEMA')
  if (step.id !== null && (typeof step.id !== 'string' || (!SAFE_ID.test(step.id) && !isHash(step.id)))) fail('LEDGER_MALFORMED_SCHEMA')
  requireUses(step.uses)
  requireHashOrNull(step.runHash)
  for (const key of ['ifHash', 'envHash', 'withHash', 'cwdHash', 'shellHash']) requireHashOrNull(step[key])
  if (step.shell !== null && (typeof step.shell !== 'string' || !SAFE_ID.test(step.shell))) fail('LEDGER_MALFORMED_SCHEMA')
  if (step.continueOnError !== null && step.continueOnError !== true && step.continueOnError !== false && !isHash(step.continueOnError)) {
    fail('LEDGER_MALFORMED_SCHEMA')
  }
  if (step.timeoutMinutes !== null && !isHash(step.timeoutMinutes) && (!Number.isInteger(step.timeoutMinutes) || step.timeoutMinutes < 0 || step.timeoutMinutes > 100000)) {
    fail('LEDGER_MALFORMED_SCHEMA')
  }
}

function requireJob(job) {
  if (!isObject(job) || typeof job.id !== 'string' || !SAFE_ID.test(job.id) || !Array.isArray(job.steps)) {
    fail('LEDGER_MALFORMED_SCHEMA')
  }
  if (!Array.isArray(job.needs) || job.needs.some((dep) => typeof dep !== 'string' || !SAFE_ID.test(dep))) {
    fail('LEDGER_MALFORMED_SCHEMA')
  }
  for (const key of ['nameHash', 'ifHash', 'runnerHash', 'servicesHash', 'environmentHash', 'defaultsHash', 'envHash', 'matrixHash']) {
    requireHashOrNull(job[key])
  }
  if (job.timeoutMinutes !== null && !isHash(job.timeoutMinutes) && (!Number.isInteger(job.timeoutMinutes) || job.timeoutMinutes < 0 || job.timeoutMinutes > 100000)) {
    fail('LEDGER_MALFORMED_SCHEMA')
  }
  job.steps.forEach(requireStep)
}

function requireLedgerShape(body) {
  if (!isObject(body) || body.schema !== SCHEMA || body.frozenSha !== FROZEN_SHA) fail('LEDGER_MALFORMED_SCHEMA')
  if (!Array.isArray(body.sources) || body.sources.length !== SOURCE_PATHS.length) fail('LEDGER_MALFORMED_SCHEMA')
  body.sources.forEach((item, index) => {
    if (!isObject(item) || item.path !== SOURCE_PATHS[index] || !isHash(item.sha256)) fail('LEDGER_MALFORMED_SCHEMA')
    requireCount(item.byteLength)
  })
  const runner = body.webRunner
  if (!isObject(runner) || runner.path !== WEB_RUNNER_PATH || runner.binding !== 'exact-source-hash') fail('LEDGER_MALFORMED_SCHEMA')
  if (runner.shellParsed !== false || runner.runtimeCasesCollected !== false || !isHash(runner.sha256)) fail('LEDGER_MALFORMED_SCHEMA')
  requireCount(runner.byteLength)
  if (runner.sha256 !== body.sources[2].sha256 || runner.byteLength !== body.sources[2].byteLength) fail('LEDGER_MALFORMED_SCHEMA')
  if (!Array.isArray(body.workflows) || body.workflows.length !== WORKFLOW_PATHS.length) fail('LEDGER_MALFORMED_SCHEMA')
  body.workflows.forEach((workflow, index) => {
    if (!isObject(workflow) || workflow.path !== WORKFLOW_PATHS[index] || !isHash(workflow.sha256)) fail('LEDGER_MALFORMED_SCHEMA')
    requireCount(workflow.byteLength)
    for (const key of ['triggerHash', 'concurrencyHash', 'environmentHash', 'defaultsHash']) requireHashOrNull(workflow[key])
    if (!Array.isArray(workflow.jobs) || workflow.jobs.length === 0) fail('LEDGER_MALFORMED_SCHEMA')
    workflow.jobs.forEach(requireJob)
  })
  if (!Array.isArray(body.invocationContexts) || body.invocationContexts.length === 0) fail('LEDGER_MALFORMED_SCHEMA')
  body.invocationContexts.forEach((ctx, occurrence) => {
    if (!isObject(ctx) || !Number.isInteger(ctx.index) || ctx.index < 0 || ctx.occurrence !== String(occurrence + 1) || ctx.runnerSha256 !== runner.sha256 || !isHash(ctx.runHash)) {
      fail('LEDGER_MALFORMED_SCHEMA')
    }
    const workflow = body.workflows.find((item) => item.path === ctx.workflowPath)
    const job = workflow && workflow.jobs.find((item) => item.id === ctx.jobId)
    const step = job && job.steps[ctx.index]
    if (!isObject(step) || step.runHash !== ctx.runHash) fail('LEDGER_MALFORMED_SCHEMA')
  })
}

export function validateBaseline(baseline) {
  if (!isObject(baseline)) fail('LEDGER_MALFORMED_SCHEMA')
  const { ledgerDigest, ...body } = baseline
  requireLedgerShape(body)
  if (typeof ledgerDigest !== 'string' || ledgerDigest !== canonicalDigest(body)) fail('LEDGER_MALFORMED_SCHEMA')
  const encoded = JSON.stringify(baseline)
  if (encoded.includes('://') || encoded.includes('${{')) fail('LEDGER_MALFORMED_SCHEMA')
  return baseline
}

export function assertLedgerMatch(candidate, baseline) {
  validateBaseline(candidate)
  validateBaseline(baseline)
  if (JSON.stringify(canonicalize(candidate)) !== JSON.stringify(canonicalize(baseline))) fail('LEDGER_BASELINE_MISMATCH')
  return { ok: true }
}

export function loadBaseline(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    fail('LEDGER_MISSING_FILE')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    fail('LEDGER_MALFORMED_SCHEMA')
  }
  return validateBaseline(parsed)
}

export function readFrozenFiles(repoRoot, sha = FROZEN_SHA) {
  if (sha !== FROZEN_SHA || typeof repoRoot !== 'string' || repoRoot.length === 0) fail('LEDGER_BASELINE_MISMATCH')
  const files = {}
  for (const path of SOURCE_PATHS) {
    try {
      files[path] = execFileSync('git', ['cat-file', 'blob', `${sha}:${path}`], {
        cwd: repoRoot,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      fail('LEDGER_MISSING_FILE')
    }
  }
  return files
}

export function readWorktreeFiles(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) fail('LEDGER_MISSING_FILE')
  const files = {}
  for (const path of SOURCE_PATHS) {
    try {
      files[path] = readFileSync(join(repoRoot, path))
    } catch {
      fail('LEDGER_MISSING_FILE')
    }
  }
  return files
}

export function checkWorktree(repoRoot, baselineFile) {
  return assertLedgerMatch(buildLedger(readWorktreeFiles(repoRoot)), loadBaseline(baselineFile))
}

export function generateBaseline({ repoRoot, destination, write }) {
  const ledger = validateBaseline(buildLedger(readFrozenFiles(repoRoot)))
  if (write === true) {
    mkdirSync(new URL('./', destination), { recursive: true })
    writeFileSync(destination, `${JSON.stringify(canonicalize(ledger), null, 2)}\n`)
  }
  return ledger
}

function isRequiredName(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && !value.includes('://')
    && !value.includes('${{')
    && REQUIRED_NAME.test(value)
}

function namesOf(requiredNames) {
  if (!Array.isArray(requiredNames) || requiredNames.length === 0) fail('LEDGER_MALFORMED_SCHEMA')
  const seen = new Set()
  for (const name of requiredNames) {
    if (!isRequiredName(name)) fail('LEDGER_MALFORMED_SCHEMA')
    if (seen.has(name)) fail('WORKER_AMBIGUOUS_PRODUCER')
    seen.add(name)
  }
  return requiredNames.slice()
}

function conditionOf(value) {
  if (value == null || value === true || value === 'true' || value === 'success()') return 'success()'
  if (value === 'always()') return 'always()'
  fail('WORKER_UNSUPPORTED_CONDITION')
}

function workerNeeds(value) {
  if (value == null) return []
  if (!Array.isArray(value)) fail('LEDGER_MALFORMED_SCHEMA')
  const seen = new Set()
  for (const dep of value) {
    if (typeof dep !== 'string' || !SAFE_ID.test(dep)) fail('LEDGER_MALFORMED_SCHEMA')
    if (seen.has(dep)) fail('WORKER_DUPLICATE_EDGE')
    seen.add(dep)
  }
  return value.slice()
}

function normalizeWorkers(workers) {
  if (!Array.isArray(workers) || workers.length === 0) fail('WORKER_EMPTY')
  const byId = new Map()
  for (const worker of workers) {
    if (!isObject(worker) || typeof worker.id !== 'string' || !SAFE_ID.test(worker.id)) fail('LEDGER_MALFORMED_SCHEMA')
    if (byId.has(worker.id)) fail('WORKER_DUPLICATE_IDENTITY')
    const produces = worker.produces == null ? [] : worker.produces
    if (!Array.isArray(produces) || produces.some((name) => !isRequiredName(name))) fail('LEDGER_MALFORMED_SCHEMA')
    byId.set(worker.id, {
      id: worker.id,
      needs: workerNeeds(worker.needs),
      produces,
      condition: conditionOf(worker.condition),
    })
  }
  for (const worker of byId.values()) {
    for (const dep of worker.needs) if (!byId.has(dep)) fail('WORKER_MISSING_EDGE')
  }
  const state = new Map()
  const visit = (id) => {
    const mark = state.get(id)
    if (mark === 1) fail('WORKER_CYCLE')
    if (mark === 2) return
    state.set(id, 1)
    for (const dep of byId.get(id).needs) visit(dep)
    state.set(id, 2)
  }
  for (const id of byId.keys()) visit(id)
  return byId
}

function bindRequired(byId, requiredNames) {
  const names = namesOf(requiredNames)
  const producers = new Map()
  for (const worker of byId.values()) {
    for (const name of worker.produces) {
      if (producers.has(name)) fail('WORKER_AMBIGUOUS_PRODUCER')
      producers.set(name, worker.id)
    }
  }
  const closure = new Set()
  const absorb = (id) => {
    if (closure.has(id)) return
    closure.add(id)
    for (const dep of byId.get(id).needs) absorb(dep)
  }
  for (const name of names) {
    const producer = producers.get(name)
    if (!producer) fail('WORKER_MISSING_PRODUCER')
    absorb(producer)
  }
  for (const id of byId.keys()) if (!closure.has(id)) fail('WORKER_ORPHAN')
  return names
}

function inventoryDigest(byId, requiredNames) {
  return canonicalDigest({
    requiredNames,
    workers: [...byId.values()].map((worker) => ({
      id: worker.id,
      needs: worker.needs,
      produces: worker.produces,
      condition: worker.condition,
    })),
  })
}

function resultStatus(status) {
  if (status === 'success') return
  if (status === 'failure') fail('WORKER_RESULT_FAILURE')
  if (status === 'skipped') fail('WORKER_RESULT_SKIPPED')
  if (status === 'cancelled') fail('WORKER_RESULT_CANCELLED')
  fail('WORKER_RESULT_UNKNOWN')
}

function checkResults(byId, results) {
  if (!isObject(results)) fail('LEDGER_MALFORMED_SCHEMA')
  for (const id of Object.keys(results)) if (!byId.has(id)) fail('WORKER_RESULT_EXTRA')
  for (const id of byId.keys()) {
    if (!Object.prototype.hasOwnProperty.call(results, id)) fail('WORKER_RESULT_MISSING')
    resultStatus(results[id])
  }
}

function checkReceipts(byId, receipts, binding) {
  if (!Array.isArray(receipts) || receipts.length === 0) fail('RECEIPT_MISSING')
  if (!isObject(binding)) fail('LEDGER_MALFORMED_SCHEMA')
  const { currentSha, runId, attempt, ledgerDigest } = binding
  if (typeof currentSha !== 'string' || !HEX40.test(currentSha)) fail('LEDGER_MALFORMED_SCHEMA')
  if (typeof runId !== 'string' || !SAFE_ID.test(runId)) fail('LEDGER_MALFORMED_SCHEMA')
  if (!Number.isInteger(attempt) || attempt < 1) fail('LEDGER_MALFORMED_SCHEMA')
  if (typeof ledgerDigest !== 'string' || !HEX64.test(ledgerDigest)) fail('LEDGER_MALFORMED_SCHEMA')
  const seen = new Set()
  for (const receipt of receipts) {
    if (!isObject(receipt) || Object.keys(receipt).length === 0) fail('RECEIPT_EMPTY')
    if (receipt.schema !== RECEIPT_SCHEMA || typeof receipt.workerId !== 'string') fail('RECEIPT_SCHEMA')
    if (!byId.has(receipt.workerId)) fail('RECEIPT_EXTRA')
    if (seen.has(receipt.workerId)) fail('RECEIPT_DUPLICATE')
    seen.add(receipt.workerId)
    if (receipt.sha !== currentSha) fail('RECEIPT_STALE')
    if (receipt.runId !== runId) fail('RECEIPT_RUN_MISMATCH')
    if (receipt.attempt !== attempt) fail('RECEIPT_ATTEMPT_MISMATCH')
    if (receipt.ledgerDigest !== ledgerDigest) fail('RECEIPT_CONFIG_MISMATCH')
    if (receipt.status !== 'success') fail('RECEIPT_STATUS')
  }
  for (const id of byId.keys()) if (!seen.has(id)) fail('RECEIPT_MISSING')
}

function invocationKey(item) {
  if (!isObject(item)) fail('LEDGER_MALFORMED_SCHEMA')
  const fields = ['identity', 'config', 'flags', 'group', 'occurrence']
  for (const field of fields) {
    if (typeof item[field] !== 'string' || item[field].length === 0 || item[field].includes('://') || item[field].includes('${{')) {
      fail('LEDGER_MALFORMED_SCHEMA')
    }
  }
  return JSON.stringify(fields.map((field) => item[field]))
}

function checkInvocations(spec) {
  if (!isObject(spec) || !Array.isArray(spec.expected) || !Array.isArray(spec.observed)) fail('LEDGER_MALFORMED_SCHEMA')
  if (spec.expected.length === 0 || spec.observed.length === 0) fail('INVOCATION_EMPTY')
  const expected = spec.expected.map(invocationKey)
  const observed = spec.observed.map(invocationKey)
  const expPartial = new Map(spec.expected.map((item) => [`${item.identity}\0${item.occurrence}`, invocationKey(item)]))
  for (const item of spec.observed) {
    const wanted = expPartial.get(`${item.identity}\0${item.occurrence}`)
    if (wanted && wanted !== invocationKey(item)) fail('INVOCATION_ALTERED')
  }
  const count = (rows) => rows.reduce((map, key) => map.set(key, (map.get(key) || 0) + 1), new Map())
  const exp = count(expected)
  const obs = count(observed)
  for (const [key, times] of exp) if ((obs.get(key) || 0) < times) fail('INVOCATION_MISSING')
  for (const [key, times] of obs) {
    const wanted = exp.get(key) || 0
    if (wanted === 0) fail('INVOCATION_EXTRA')
    if (times > wanted) fail('INVOCATION_REPEATED')
  }
}

export function evaluateExecution(input) {
  if (!isObject(input) || !isObject(input.expected)) fail('LEDGER_MALFORMED_SCHEMA')
  const expectedWorkers = normalizeWorkers(input.expected.workers)
  const expectedNames = bindRequired(expectedWorkers, input.expected.requiredNames)
  const observedWorkers = normalizeWorkers(input.workers)
  const observedNames = bindRequired(observedWorkers, input.requiredNames)
  if (inventoryDigest(expectedWorkers, expectedNames) !== inventoryDigest(observedWorkers, observedNames)) {
    fail('WORKER_GRAPH_MISMATCH')
  }
  if (input.workflowStatus === 'cancelled') fail('WORKFLOW_CANCELLED')
  if (input.workflowStatus !== 'completed') fail('WORKER_RESULT_UNKNOWN')
  checkResults(expectedWorkers, input.results)
  checkReceipts(expectedWorkers, input.receipts, input.binding)
  checkInvocations(input.invocations)
  return { ok: true, workers: expectedWorkers.size }
}

function main() {
  try {
    const repoRoot = process.cwd()
    const destination = new URL('./fixtures/ci-execution-ledger-p0/baseline.json', import.meta.url)
    if (process.argv.includes('--generate')) {
      generateBaseline({ repoRoot, destination, write: true })
      process.stdout.write('generated\n')
      return
    }
    checkWorktree(repoRoot, destination)
    process.stdout.write('ok\n')
  } catch (err) {
    if (!(err instanceof LedgerError)) throw err
    process.stderr.write(`${err.code}\n`)
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
