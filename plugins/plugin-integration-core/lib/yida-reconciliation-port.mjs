import { types } from 'node:util'
import credentialMaterials from './yida-credential-material-store.cjs'
import tokenClientModule from './yida-token-client.cjs'
import tokenExchangeModule from './yida-token-exchange.cjs'
import readbackModule from './yida-form-readback.cjs'
import reconciliationStoreModule from './yida-reconciliation-store.cjs'
import { createInternalYidaApprovedTargetTransactionReader, YidaApprovedTargetError } from './yida-approved-target-store.mjs'
import {
  YIDA_RECONCILE_LIMITS, assertYidaReconcileLayout, buildYidaReconcileSearchCondition, classifyYidaReconcileRecord,
  yidaObservedBusinessKey, yidaReconcileCompletion, yidaReconcilePayloadDigest, yidaReconcileProjectMatches,
  YidaReconciliationPlanError,
} from './yida-reconciliation-plan.mjs'

// R-71 ⑦.5 cut-over reconciliation port (host-private; reached only through the host reconciliation runtime
// after live integration-admin + anchor-owner authorization). One step = transaction A (target, current
// material, key layout, project registry, run row) COMMITTED before any network; then a token and at most
// `pagesPerStep` paginated READS, each page classified and committed in its own transaction B.
//
// It cannot write to YiDa: it imports no form transport, no delivery runner and no send port, and its only
// remote calls are the fixed token endpoint and the fixed search endpoint. Transaction B never reads or locks
// the approved-target row, so a step never holds a slot lock across the network.
const CODES = new Set(['INPUT', 'DISABLED', 'CONFLICT', 'NOT_FOUND', 'CANCELLED', 'UNAVAILABLE'])
const ownErrors = new WeakMap()
const CONTEXT = ['tenantId', 'workspaceId', 'ownerId', 'actorId']
const INPUT_KEYS = ['commandId', 'mode', 'projectNo', 'projectKeyTarget', 'expectedKeyTargets']
const OPTIONAL_INPUT = ['targetRef', 'pageSize', 'pagesPerStep']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PROJECT_TARGET = 'integration_stock_prep_project_target'
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get
const PAGE_FAILURES = new Set(['THROTTLED', 'RESPONSE', 'TOO_LARGE', 'UNAVAILABLE'])

export class YidaReconciliationError extends Error {
  constructor(code) {
    const fixed = CODES.has(code) ? code : 'UNAVAILABLE'
    super(`YIDA_RECONCILE_${fixed}`)
    this.name = 'YidaReconciliationError'
    this.code = this.message
    ownErrors.set(this, fixed)
  }
}
function fail(code) { throw new YidaReconciliationError(code) }
function suffix(error, prefix) {
  const code = error && typeof error === 'object' && !types.isProxy(error) ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined
  return typeof code === 'string' && code.startsWith(prefix) ? code.slice(prefix.length) : undefined
}
// Closes any rejection into the port's fixed vocabulary; foreign text never passes.
function closed(error) {
  if (ownErrors.has(error)) throw error
  const store = reconciliationStoreModule.yidaReconciliationStoreErrorKind(error)
  if (store === 'CONFLICT' || store === 'NOT_FOUND' || store === 'INPUT') fail(store)
  if (error instanceof YidaApprovedTargetError) {
    const kind = suffix(error, 'YIDA_APPROVED_TARGET_')
    fail(kind === 'NOT_FOUND' || kind === 'CONFLICT' || kind === 'INPUT' ? kind : 'UNAVAILABLE')
  }
  if (error instanceof YidaReconciliationPlanError) fail(suffix(error, 'YIDA_RECONCILE_PLAN_') === 'CONFLICT' ? 'CONFLICT' : 'INPUT')
  fail('UNAVAILABLE')
}
function record(value, keys, optional = []) {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail('INPUT')
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) fail('INPUT')
  const properties = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(properties).some(key => typeof key !== 'string' || ![...keys, ...optional].includes(key))
    || keys.some(key => !Object.hasOwn(properties, key))) fail('INPUT')
  const result = Object.create(null)
  for (const key of Object.keys(properties)) {
    const property = properties[key]
    if (!property.enumerable || !Object.hasOwn(property, 'value')) fail('INPUT')
    result[key] = property.value
  }
  return result
}
function id(value, maximum = 128) {
  if (typeof value !== 'string' || !value || value.length > maximum || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('INPUT')
  return value
}
function bounded(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('INPUT')
  return value
}
function observePromise(value) {
  try {
    if (types.isPromise(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Promise.prototype
      && !Object.hasOwn(value, 'constructor')) Promise.prototype.then.call(value, undefined, () => {})
  } catch { /* Asynchronous control is never enablement. */ }
}
function literalTrue(read) {
  let value
  try { value = read() } catch { return false }
  if (value === 'true') return true
  observePromise(value)
  return false
}
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && aborted.call(signal)) { reject(new YidaReconciliationError('CANCELLED')); return }
    const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(new YidaReconciliationError('CANCELLED')) }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Closed, values-free step/inspect view: never projectNo, formData, systemToken, userId or any key value. */
function view(run, tokenIssued) {
  return Object.freeze({ runId: run.runId, commandId: run.commandId, targetRef: run.targetRef, mode: run.mode,
    status: run.status, nextPageNumber: run.nextPageNumber, pagesDone: run.pagesDone,
    totalCountFirst: run.totalCountFirst, totalCountLast: run.totalCountLast, counts: run.counts,
    lastErrorCode: run.lastErrorCode, tokenIssued, canSend: false, externalWriteAttempted: false,
    businessVerified: false, historyVerified: false, formOwnershipVerified: false })
}

function build(options, internals = {}) {
  const config = record(options, ['db', 'security', 'context', 'fetch', 'readEnablement'],
    ['readProjectSheetsEnablement', 'timeoutMs', 'sleep'])
  const scope = record(config.context, CONTEXT)
  for (const key of CONTEXT) if (key !== 'workspaceId') id(scope[key])
  if (scope.workspaceId !== null || scope.actorId !== scope.ownerId) fail('INPUT')
  const context = Object.freeze({ tenantId: scope.tenantId, workspaceId: null, ownerId: scope.ownerId })
  const db = config.db
  if (!db || typeof db.transaction !== 'function' || typeof config.fetch !== 'function'
    || typeof config.readEnablement !== 'function') fail('INPUT')
  const readEnablement = config.readEnablement
  const readProjectSheets = config.readProjectSheetsEnablement ?? (() => process.env.MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED)
  const timeoutMs = bounded(config.timeoutMs, 5000, 10, 60000)
  const sleep = config.sleep ?? defaultSleep
  if (typeof readProjectSheets !== 'function' || typeof sleep !== 'function') fail('INPUT')
  // The three private readers are the real ones; only the unit suite substitutes doubles (createYidaReconciliationPortForTests).
  const readTarget = internals.readTarget ?? createInternalYidaApprovedTargetTransactionReader({ security: config.security, context })
  const readExecutionMaterial = internals.readExecutionMaterial
    ?? credentialMaterials.createInternalYidaCredentialExecutionReader({ security: config.security, context })
  const credentialStore = internals.credentialStore
    ?? credentialMaterials.createYidaCredentialMaterialStore({ db, security: config.security, context })
  const store = reconciliationStoreModule.createYidaReconciliationStore({ db, context })

  function enabled() { if (!literalTrue(readEnablement)) fail('DISABLED') }
  function cancellation(signal) { if (signal !== undefined && aborted.call(signal)) fail('CANCELLED') }

  function parse(input) {
    const parsed = record(input, INPUT_KEYS, OPTIONAL_INPUT)
    if (typeof parsed.commandId !== 'string' || !UUID.test(parsed.commandId)) fail('INPUT')
    if (!['count', 'register'].includes(parsed.mode)) fail('INPUT')
    const projectNo = id(parsed.projectNo, 64)
    const projectKeyTarget = id(parsed.projectKeyTarget)
    if (!Array.isArray(parsed.expectedKeyTargets) || types.isProxy(parsed.expectedKeyTargets)
      || parsed.expectedKeyTargets.length < 1 || parsed.expectedKeyTargets.length > 32) fail('INPUT')
    const expectedKeyTargets = Object.freeze(parsed.expectedKeyTargets.map(target => id(target)))
    return Object.freeze({ commandId: parsed.commandId, mode: parsed.mode, projectNo, projectKeyTarget, expectedKeyTargets,
      targetRef: Object.hasOwn(parsed, 'targetRef') ? id(parsed.targetRef) : undefined,
      pageSize: bounded(parsed.pageSize, YIDA_RECONCILE_LIMITS.defaultPageSize, 1, YIDA_RECONCILE_LIMITS.maxPageSize),
      pagesPerStep: bounded(parsed.pagesPerStep, YIDA_RECONCILE_LIMITS.defaultPagesPerStep, 1, YIDA_RECONCILE_LIMITS.maxPagesPerStep) })
  }

  // Transaction A: everything that locks the slot row happens here and is COMMITTED before any network.
  function prepare(request) {
    return db.transaction(async trx => {
      const approved = await readTarget(trx, true, request.targetRef)
      const target = approved.target
      const material = await readExecutionMaterial(trx, { credentialRef: target.credential_ref,
        credentialGeneration: target.credential_generation })
      if (material.tenantId !== context.tenantId || material.ownerId !== context.ownerId || material.workspaceId !== null
        || material.credentialRef !== target.credential_ref || material.credentialGeneration !== target.credential_generation
        || material.userId !== approved.envelope.attestation.executionIdentity) fail('CONFLICT')
      assertYidaReconcileLayout({ keyDefinition: approved.envelope.keyDefinition, expectedKeyTargets: request.expectedKeyTargets,
        projectKeyTarget: request.projectKeyTarget })
      // Decision R4: with project sheets ON, only a registered, active project may be reconciled.
      if (literalTrue(readProjectSheets)) {
        const registered = await trx.selectOne(PROJECT_TARGET, { tenant_id: context.tenantId, project_no: request.projectNo })
        if (!registered || registered.status !== 'active') fail('CONFLICT')
      }
      const run = await store.openRunInTransaction(trx, { commandId: request.commandId, targetRef: target.target_ref,
        projectNo: request.projectNo, projectKeyTarget: request.projectKeyTarget, keyDefinitionDigest: target.key_definition_digest,
        mode: request.mode, pageSize: request.pageSize })
      return { run: store.projectRun(run), locator: approved.envelope.locator, keyDefinition: approved.envelope.keyDefinition,
        targetRef: target.target_ref, planRevision: target.plan_digest,
        binding: Object.freeze({ ...context, credentialRef: target.credential_ref, credentialGeneration: target.credential_generation }),
        execution: { systemToken: material.systemToken, userId: material.userId } }
    })
  }

  async function step(input, options = {}) {
    let client
    let tokenIssued = false
    try {
      const request = parse(input)
      const { signal } = record(options, [], ['signal'])
      if (signal !== undefined && (!signal || types.isProxy(signal) || Object.getPrototypeOf(signal) !== AbortSignal.prototype)) fail('INPUT')
      cancellation(signal); enabled()
      const prepared = await prepare(request)
      // COMMITTED: no slot or material lock is held from here on.
      let run = prepared.run
      if (run.status !== 'running') return view(run, false)
      cancellation(signal); enabled()
      const exchange = tokenExchangeModule.createDingTalkAppTokenExchange({ fetch: config.fetch })
      client = tokenClientModule.createYidaTokenClient({
        // Its own short transaction (current, not revoked) at the moment the exchange needs the pair.
        loadCredential: (binding, loadOptions) => credentialStore.loadTokenCredential(binding, loadOptions),
        exchangeToken: async (material, exchangeOptions) => { cancellation(exchangeOptions.signal); enabled(); return exchange(material, exchangeOptions) },
        maxBindings: 1, maxOutstandingFlights: 1, maxWaitersPerFlight: 1, refreshTimeoutMs: timeoutMs })
      client.activate(prepared.binding)
      const reader = readbackModule.createYidaFormSearchReadback({ fetch: config.fetch, readEnablement })
      const searchCondition = buildYidaReconcileSearchCondition({ projectKeyTarget: request.projectKeyTarget, projectNo: request.projectNo })
      const pageSignal = signal ?? new AbortController().signal
      for (let index = 0; index < request.pagesPerStep && run.status === 'running'; index += 1) {
        // Single flight, at least one second between two page reads (the only public throttle number).
        if (index > 0) await sleep(YIDA_RECONCILE_LIMITS.minPageIntervalMs, signal)
        cancellation(signal); enabled()
        let page
        for (let attempt = 0; ; attempt += 1) {
          let code
          try {
            const accessToken = await client.getAccessToken(prepared.binding, { signal: pageSignal })
            tokenIssued = true
            cancellation(signal); enabled()
            page = await reader.search({ appType: prepared.locator.appType, formUuid: prepared.locator.formUuid, accessToken,
              systemToken: prepared.execution.systemToken, userId: prepared.execution.userId, pageNumber: run.nextPageNumber,
              pageSize: run.pageSize, searchCondition }, { signal: pageSignal })
            break
          } catch (error) {
            if (ownErrors.has(error)) throw error
            cancellation(signal)
            code = suffix(error, 'YIDA_READBACK_')
            if (code === 'DISABLED') fail('DISABLED')
            if (code === 'ABORTED') fail('CANCELLED')
            if (!PAGE_FAILURES.has(code)) code = 'UNAVAILABLE'
          }
          if (code === 'THROTTLED' && attempt < YIDA_RECONCILE_LIMITS.throttleRetries) {
            await sleep(YIDA_RECONCILE_LIMITS.throttleSleepMs, signal)
            continue
          }
          // The page was not read: nothing of it is stored and the cursor stays; the same commandId resumes.
          return view(await store.failRun({ runId: run.runId, code }), tokenIssued)
        }
        cancellation(signal)
        const entries = page.records.map(item => {
          if (!yidaReconcileProjectMatches({ formData: item.formData, projectKeyTarget: request.projectKeyTarget, projectNo: request.projectNo })) {
            return { observedInstanceId: item.formInstanceId, kind: 'project_mismatch' }
          }
          const observed = yidaObservedBusinessKey({ locator: prepared.locator, keyDefinition: prepared.keyDefinition, formData: item.formData })
          return observed.comparable
            ? { observedInstanceId: item.formInstanceId, kind: 'comparable', businessKeyDigest: observed.businessKeyDigest }
            : { observedInstanceId: item.formInstanceId, kind: 'key_unmatchable' }
        })
        let committed
        try {
          committed = await store.commitPage({ runId: run.runId, pageNumber: run.nextPageNumber, totalCount: page.totalCount,
            responseDigest: page.responseDigest, entries,
            evidence: { targetRef: prepared.targetRef, planRevision: prepared.planRevision, formUuid: prepared.locator.formUuid,
              credentialRef: prepared.binding.credentialRef, credentialGeneration: prepared.binding.credentialGeneration,
              payloadDigest: ({ observedInstanceId, businessKeyDigest }) => yidaReconcilePayloadDigest({
                formUuid: prepared.locator.formUuid, observedInstanceId, businessKeyDigest }) },
            classify: (holder, observedInstanceId) => classifyYidaReconcileRecord({ mode: request.mode, holder, observedInstanceId }),
            completion: ({ pageNumber, recordCount, totalCount, totalCountFirst }) => yidaReconcileCompletion({
              pageNumber, pageSize: run.pageSize, recordCount, totalCount, totalCountFirst }) })
        } catch (error) {
          const kind = reconciliationStoreModule.yidaReconciliationStoreErrorKind(error)
          // A concurrent admission took one of this page's fence tuples: the page rolled back as a whole.
          if (kind === 'RETRY') return view(await store.failRun({ runId: run.runId, code: 'RETRY' }), tokenIssued)
          // Another step of the same run already committed this page: report the run as it now stands.
          if (kind === 'STALE') return view(await store.inspect({ runId: run.runId }), tokenIssued)
          throw error
        }
        run = committed.run
      }
      return view(run, tokenIssued)
    } catch (error) { closed(error) }
    finally {
      try { if (client) await client.disposeAndDrain() } catch { /* No dependency error escapes cleanup. */ }
    }
  }

  async function inspect(input) {
    try {
      const { runId } = record(input, ['runId'])
      if (typeof runId !== 'string' || !UUID.test(runId)) fail('INPUT')
      return view(await store.inspect({ runId }), false)
    } catch (error) { closed(error) }
  }
  return Object.freeze({ step, inspect })
}

export function createYidaReconciliationPort(options) {
  try { return build(options) } catch (error) { closed(error) }
}
// Unit-suite seam only (synthetic target/material readers over a fake db). Never reached by the binding.
export function createYidaReconciliationPortForTests(options, internals) {
  try { return build(options, internals) } catch (error) { closed(error) }
}
