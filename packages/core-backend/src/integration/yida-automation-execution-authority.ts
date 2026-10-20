import { types } from 'node:util'
import { performance } from 'node:perf_hooks'
import { assertAutomationIntegrationActor } from './automation-live-authority'
import { createYidaAutomationLiveAuthority } from './yida-automation-live-authority'
import { createYidaAutomationAuthorizationStore } from './yida-automation-authorization-store'
import { captureInternalYidaAutomationClaim, createYidaAutomationDispatchClaimAuthority } from './yida-automation-dispatch-claim'
import { serializeInternalYidaSnapshot, type YidaSendExecutionPrimitives,
  type YidaSendAuthoritySelection } from './yida-send-approval-service'
import type { Queryable } from '../multitable/automation-durable-dispatcher'

export const YIDA_AUTOMATION_SEND_FLAG = 'INTEGRATION_YIDA_AUTOMATION_SEND_ENABLED'
type Row = Record<string, unknown>
export type YidaAutomationExecutionPrimitives = YidaSendExecutionPrimitives & {
  claimInTransaction(trx: Queryable, input: unknown): Promise<{ record: Readonly<Row>; claimToken: string }>
  finishInTransaction(trx: Queryable, input: unknown, kind: 'acknowledgement' | 'unknown'): Promise<Readonly<Row>>
}
type Dependencies = Omit<Parameters<typeof createYidaAutomationLiveAuthority>[0], 'primitives'> & {
  primitives: YidaAutomationExecutionPrimitives
  database: { transaction<T>(work: (trx: Queryable) => Promise<T>): Promise<T> }
  security: { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
  activationId: string; workerId: string; readEnablement?: () => unknown; monotonicNow?: () => number; timeoutMs?: number
}
type Claim = ReturnType<typeof captureInternalYidaAutomationClaim>
type Anchor = Readonly<{ grantId: string; requestId: string; admissionId: string; ledgerId: string;
  expiresAt: number; startedMonotonic: number; remainingMs: number; materialRevision: string; executionDigest: string;
  claim: Claim; selected: YidaSendAuthoritySelection; envelope: string; signal: AbortSignal | null }>
const DIGEST = /^[0-9a-f]{64}$/u
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
function denied(): never { throw new Error('YIDA_AUTOMATION_EXECUTION_DENIED') }
function cancellation(options: unknown): AbortSignal | null {
  if (options === undefined) return null
  const parsed = data(options, ['signal']), signal = parsed.signal
  if (!signal || typeof signal !== 'object' || types.isProxy(signal)
    || Object.getPrototypeOf(signal) !== AbortSignal.prototype) denied()
  try { abortedGetter.call(signal) } catch { return denied() }
  return signal as AbortSignal
}
function notCancelled(signal: AbortSignal | null) {
  if (signal && abortedGetter.call(signal)) denied()
}
function data(value: unknown, keys: readonly string[]): Row {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) denied()
  const proto = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value)
  if (proto !== Object.prototype && proto !== null || Reflect.ownKeys(descriptors).length !== keys.length) denied()
  return Object.fromEntries(keys.map(key => {
    const property = descriptors[key]
    if (!property?.enumerable || !Object.hasOwn(property, 'value')) denied()
    return [key, property.value]
  }))
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) denied()
  return value
}
function millis(value: unknown): number {
  const result = typeof value === 'string' && /^[0-9]{1,16}$/u.test(value) ? Number(value) : value
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0) denied()
  return result
}
function cipher(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('enc:') || value.length <= 4
    || Buffer.byteLength(value, 'utf8') > 24 * 1024 * 1024) denied()
  return value
}
function consumeAccidentalPromise(value: unknown) {
  try {
    if (types.isPromise(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Promise.prototype
      && !Object.hasOwn(value, 'constructor')) Promise.prototype.then.call(value, undefined, () => {})
  } catch { /* Invalid enablement stays OFF; do not coerce dependency values. */ }
}

/** Host-private admission/commit boundary; no route, token or HTTP sender. The
 * registered host supplies actual delegated primitives and a distinct worker.
 * Returned tickets are instance-local, not serialized grants. A later private
 * execution kernel must consume them, and recheck before every external IO. */
export function createYidaAutomationExecutionAuthority(dependencies: Dependencies) {
  const actor = data(dependencies.grantor, ['actorId', 'tenantId', 'workspaceId'])
  if (actor.workspaceId !== null) denied()
  const grantor = Object.freeze({ actorId: id(actor.actorId), tenantId: id(actor.tenantId), workspaceId: null })
  const scope = Object.freeze({ tenantId: grantor.tenantId, workspaceId: null, ownerId: grantor.actorId })
  const workerId = id(dependencies.workerId), activationId = id(dependencies.activationId)
  if (workerId === scope.ownerId) denied()
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now())
  const timeoutMs = dependencies.timeoutMs ?? 10000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60000) denied()
  const readEnablement = dependencies.readEnablement ?? (() => 'false')
  const transact = dependencies.database.transaction.bind(dependencies.database)
  const encrypt = dependencies.security.encrypt.bind(dependencies.security), decrypt = dependencies.security.decrypt.bind(dependencies.security)
  if (typeof dependencies.primitives.claimInTransaction !== 'function'
    || typeof dependencies.primitives.finishInTransaction !== 'function') denied()
  const prepare: YidaAutomationExecutionPrimitives['prepareInTransaction'] = dependencies.primitives.prepareInTransaction.bind(dependencies.primitives)
  const loadMaterial = dependencies.primitives.loadExecutionMaterialInTransaction.bind(dependencies.primitives)
  const finishDelivery = dependencies.primitives.finishInTransaction.bind(dependencies.primitives)
  const claimDelivery = dependencies.primitives.claimInTransaction.bind(dependencies.primitives)
  const digest = dependencies.primitives.executionPayloadDigest.bind(dependencies.primitives)
  const live = createYidaAutomationLiveAuthority({ grantor, binding: dependencies.binding, primitives: dependencies.primitives,
    installationRevisionInTransaction: dependencies.installationRevisionInTransaction })
  const store = createYidaAutomationAuthorizationStore({ scope, activationId, monotonicNow })
  const claims = createYidaAutomationDispatchClaimAuthority({ scope, activationId, workerId, monotonicNow })
  let closed = false, permits = new WeakMap<object, Anchor>()
  function mono() {
    const value = monotonicNow()
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) denied()
    return Math.floor(value)
  }
  function active(anchor?: Anchor) {
    if (closed) denied()
    const enabled = readEnablement()
    consumeAccidentalPromise(enabled)
    if (enabled !== 'true') denied()
    if (anchor) {
      notCancelled(anchor.signal)
      const now = mono(); if (now < anchor.startedMonotonic || now - anchor.startedMonotonic >= anchor.remainingMs) denied()
    }
  }
  async function checked<T>(work: () => Promise<T>, anchor?: Anchor) {
    active(anchor); const result = await work(); active(anchor); return result
  }
  async function now(trx: Queryable) {
    const result = await trx.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint::text AS now_ms')
    if (result.rows.length !== 1) denied()
    return millis(result.rows[0].now_ms)
  }
  async function transaction<T>(work: (trx: Queryable) => Promise<T>, anchor?: Anchor,
    guard: () => void = () => {}): Promise<T> {
    function check() { active(anchor); guard() }
    try {
      check()
      const result = await transact(async raw => {
        // One wrapper per real transaction preserves proof/xid identity. Do not
        // race away an in-flight PG operation: await it, then reject before any
        // subsequent statement, allowing the provider to actually roll back.
        const trx: Queryable = Object.freeze({ async query(sql: string, params?: unknown[]) {
          check(); const value = await raw.query(sql, params); check(); return value
        } })
        await trx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
        await assertAutomationIntegrationActor(trx, grantor)
        const value = await work(trx); check(); return value
      })
      check() // A lost/cancelled response after known COMMIT never releases a ticket.
      return result
    } catch { return denied() }
  }
  async function hint(trx: Queryable, claim: Claim) {
    const result = await trx.query(`SELECT l.grant_id,l.request_id,r.row_ordinal FROM integration_yida_auto_outbox_links l
      JOIN integration_yida_auto_requests r ON r.id=l.request_id AND r.grant_id=l.grant_id
      JOIN integration_yida_auto_grants g ON g.id=l.grant_id
      WHERE l.outbox_id=$1 AND l.consumer_key=$2 AND l.request_id=$3
        AND g.tenant_id=$4 AND g.owner_id=$5 AND g.workspace_id IS NULL`,
    [claim.outboxId, claim.consumerKey, claim.payload.requestId, scope.tenantId, scope.ownerId])
    if (result.rows.length !== 1) denied()
    return { grantId: id(result.rows[0].grant_id), requestId: id(result.rows[0].request_id), rowOrdinal: millis(result.rows[0].row_ordinal) }
  }
  async function material(trx: Queryable, grantId: string, rowOrdinal: number) {
    const grant = await store.readInTransaction(trx, grantId)
    const { maxTotalRows: _derived, ...consent } = grant.consent
    const proof = await live.lockForExecutionInTransaction(trx, consent, grant.materialRevision)
    const measured = await live.takeInTransaction(trx, proof), selected = measured.selections[rowOrdinal]
    if (!selected || selected.rowKey !== grant.consent.rowKeys[rowOrdinal]) denied()
    return { grant, selected }
  }
  function metadata(anchor: Pick<Anchor, 'grantId' | 'requestId' | 'admissionId' | 'ledgerId'>, reused: boolean) {
    return Object.freeze({ grantId: anchor.grantId, requestId: anchor.requestId, admissionId: anchor.admissionId,
      ledgerId: anchor.ledgerId, reused, status: 'admitted', canSend: false, externalWriteAttempted: false })
  }
  async function verifyLedger(trx: Queryable, ledgerId: string, selected: YidaSendAuthoritySelection,
    executionDigest: string, expectedStatus: 'prepared' | 'dispatching') {
    // Native prepare intentionally returns a values-free projection. Never add
    // private fingerprints to that DTO or infer integrity from absent fields.
    const records = await trx.query('SELECT * FROM integration_yida_delivery_ledger WHERE id=$1 FOR UPDATE', [ledgerId])
    const ledger = records.rows[0]
    if (records.rows.length !== 1 || ledger.tenant_id !== scope.tenantId || ledger.workspace_id !== null
      || ledger.owner_id !== scope.ownerId || ledger.operation_id !== selected.operationId || ledger.row_key !== selected.rowKey
      || ledger.target_ref !== selected.targetRef || ledger.target_revision !== selected.targetRevision
      || ledger.plan_revision !== selected.planRevision || ledger.credential_ref !== selected.credentialRef
      || ledger.credential_generation !== selected.credentialGeneration || ledger.business_key_digest !== selected.businessKeyDigest
      || ledger.payload_digest !== executionDigest || ledger.intent !== 'create' || ledger.status !== expectedStatus) denied()
    if (expectedStatus === 'prepared') {
      if (ledger.claim_token !== null || ledger.claim_actor_id !== null) denied()
    } else if (ledger.claim_actor_id !== workerId || typeof ledger.claim_token !== 'string' || !DIGEST.test(ledger.claim_token)) denied()
  }
  async function persist(claim: Claim, signal: AbortSignal | null) {
    return transaction(async trx => {
      const source = await hint(trx, claim)
      // A request-specific advisory lock precedes rule/material locks. It never
      // takes the grant/request row early, and makes concurrent replay history
      // visible before any second material read or prepare.
      await trx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [serializeInternalYidaSnapshot(['yida-auto-admission', scope.tenantId, scope.ownerId, source.requestId])])
      const history = await trx.query('SELECT id,ledger_id FROM integration_yida_auto_admissions WHERE grant_id=$1 AND request_id=$2',
        [source.grantId, source.requestId])
      if (history.rows.length === 1) return { metadata: metadata({ ...source,
        admissionId: id(history.rows[0].id), ledgerId: id(history.rows[0].ledger_id) }, true), anchor: null }
      if (history.rows.length) denied()
      const { grant, selected } = await material(trx, source.grantId, source.rowOrdinal)
      const proof = await claims.lockInTransaction(trx, claim), delivery = await claims.takeInTransaction(trx, proof)
      if (delivery.grantId !== source.grantId || delivery.requestId !== source.requestId || delivery.rowOrdinal !== source.rowOrdinal) denied()
      const startedMonotonic = mono()
      const dbTime = await now(trx)
      const expiresAt = Math.min(grant.summary.expiresAt, delivery.leaseExpiresAt, dbTime + timeoutMs)
      const remainingMs = expiresAt - dbTime
      if (remainingMs <= 0) denied()
      const executionDigest = await checked(async () => digest(selected, { grantRef: source.grantId, expiresAt, actorId: workerId }))
      if (typeof executionDigest !== 'string' || !DIGEST.test(executionDigest)) denied()
      const prepared = await checked(() => prepare(trx, { ...scope, operationId: selected.operationId,
        rowKey: selected.rowKey, targetRef: selected.targetRef, targetRevision: selected.targetRevision,
        planRevision: selected.planRevision, credentialRef: selected.credentialRef, credentialGeneration: selected.credentialGeneration,
        businessKeyDigest: selected.businessKeyDigest, payloadDigest: executionDigest, intent: 'create' }))
      const ledger = prepared.record
      if (prepared.reused !== false || ledger.status !== 'prepared' || ledger.intent !== 'create'
        || ledger.tenantId !== scope.tenantId || ledger.workspaceId !== null || ledger.ownerId !== scope.ownerId
        || ledger.operationId !== selected.operationId || ledger.rowKey !== selected.rowKey) denied()
      await verifyLedger(trx, id(ledger.id), selected, executionDigest, 'prepared')
      const admitted = await store.admitInTransaction(trx, source.grantId, { requestId: source.requestId,
        ledgerId: id(ledger.id), workerId, workerFence: claim.fence })
      if (admitted.reused) denied() // No recovery/remint branch for an admitted child.
      const base = { grantId: source.grantId, requestId: source.requestId,
        admissionId: admitted.admissionId, ledgerId: admitted.ledgerId }
      const envelope = serializeInternalYidaSnapshot({ purpose: 'yida-automation-execution', schemaVersion: 1,
        ...scope, ...base, activationId, workerId, workerFence: claim.fence,
        expiresAt, materialRevision: grant.materialRevision, executionDigest, selection: selected })
      const snapshot = cipher(await checked(() => encrypt(envelope)))
      await trx.query(`INSERT INTO integration_yida_auto_execution_snapshots
        (admission_id,grant_id,request_id,ledger_id,worker_id,worker_fence,activation_id,expires_at_ms,
         material_revision,execution_payload_digest,snapshot_encrypted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [base.admissionId, base.grantId, base.requestId, base.ledgerId, workerId, claim.fence, activationId,
        expiresAt, grant.materialRevision, executionDigest, snapshot])
      const anchor: Anchor = Object.freeze({ ...base, expiresAt, startedMonotonic, remainingMs, materialRevision: grant.materialRevision,
        executionDigest, claim, selected, envelope, signal })
      // Final actual grant/claim/time checks include prepare/encryption/DB waits.
      const admittedProof = await claims.lockAdmittedInTransaction(trx, claim, base)
      await claims.takeInTransaction(trx, admittedProof)
      active(anchor)
      if (await now(trx) >= expiresAt) denied()
      return { metadata: metadata(base, false), anchor }
    }, undefined, () => notCancelled(signal))
  }
  async function admitForExecution(input: unknown, options?: unknown) {
    try {
      const signal = cancellation(options)
      notCancelled(signal)
      const claim = captureInternalYidaAutomationClaim(input)
      const saved = await persist(claim, signal) // Includes the provider's known COMMIT.
      if (!saved.anchor || saved.metadata.reused) return Object.freeze({ approval: saved.metadata, permit: null })
      active(saved.anchor)
      const permit = Object.freeze({})
      permits.set(permit, saved.anchor)
      return Object.freeze({ approval: saved.metadata, permit })
    } catch { return denied() }
  }
  async function observeAdmission(input: unknown) {
    const requested = data(input, ['grantId', 'requestId', 'admissionId', 'ledgerId'])
    for (const value of Object.values(requested)) id(value)
    return transaction(async trx => {
      const result = await trx.query(`SELECT l.status FROM integration_yida_auto_admissions a
        JOIN integration_yida_auto_grants g ON g.id=a.grant_id
        JOIN integration_yida_auto_requests r ON r.id=a.request_id AND r.grant_id=g.id
        JOIN integration_yida_delivery_ledger l ON l.id=a.ledger_id
        WHERE g.id=$1 AND r.id=$2 AND a.id=$3 AND l.id=$4
          AND g.tenant_id=$5 AND g.owner_id=$6 AND g.workspace_id IS NULL
          AND l.tenant_id=g.tenant_id AND l.owner_id=g.owner_id AND l.workspace_id IS NULL`,
      [requested.grantId, requested.requestId, requested.admissionId, requested.ledgerId, scope.tenantId, scope.ownerId])
      const status = result.rows[0]?.status
      if (result.rows.length !== 1 || typeof status !== 'string'
        || !['prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'not_sent'].includes(status)) denied()
      return Object.freeze({ status, durable: true, canSend: false, externalWriteAttempted: false })
    })
  }
  function takeExecution(permit: unknown) {
    const found = permits.get(permit as object)
    if (!found) denied()
    const anchor: Anchor = found
    permits.delete(permit as object)
    active(anchor)
    const context = Object.freeze({ ...scope, actorId: workerId })
    const operation = Object.freeze({ operationId: anchor.selected.operationId, rowKey: anchor.selected.rowKey })
    const identity = Object.freeze({ ...context, ...operation })
    const credentialBinding = Object.freeze({ ...scope, credentialRef: anchor.selected.credentialRef,
      credentialGeneration: anchor.selected.credentialGeneration })
    let ended = false, busy = false, resolutions = 0, loads = 0
    function assertActive() { if (ended) denied(); active(anchor) }
    async function authenticated<T>(expectedStatus: 'prepared' | 'dispatching', options: unknown,
      project: (trx: Queryable, selected: YidaSendAuthoritySelection) => Promise<T>,
      afterFinalProof?: (trx: Queryable) => Promise<void>): Promise<T> {
      let ownsBusy = false
      try {
        const signal = cancellation(options)
        const guard = () => { if (ended) denied(); notCancelled(signal) }
        guard()
        if (ended || busy || !['prepared', 'dispatching'].includes(expectedStatus)) denied()
        busy = true; ownsBusy = true
        return await transaction(async trx => {
          if (ended) denied()
          const source = await hint(trx, anchor.claim)
          if (source.grantId !== anchor.grantId || source.requestId !== anchor.requestId) denied()
          const { grant, selected } = await material(trx, anchor.grantId, source.rowOrdinal)
          if (grant.materialRevision !== anchor.materialRevision
            || serializeInternalYidaSnapshot(selected) !== serializeInternalYidaSnapshot(anchor.selected)) denied()
          const proof = await claims.lockAdmittedInTransaction(trx, anchor.claim, {
            grantId: anchor.grantId, requestId: anchor.requestId, admissionId: anchor.admissionId, ledgerId: anchor.ledgerId })
          await claims.takeInTransaction(trx, proof)
          const saved = await trx.query('SELECT * FROM integration_yida_auto_execution_snapshots WHERE admission_id=$1', [anchor.admissionId])
          const row = saved.rows[0]
          if (saved.rows.length !== 1 || row.grant_id !== anchor.grantId || row.request_id !== anchor.requestId
            || row.ledger_id !== anchor.ledgerId || row.worker_id !== workerId || String(row.worker_fence) !== anchor.claim.fence
            || row.activation_id !== activationId || row.material_revision !== anchor.materialRevision
            || row.execution_payload_digest !== anchor.executionDigest || millis(row.expires_at_ms) !== anchor.expiresAt) denied()
          if (await checked(() => decrypt(cipher(row.snapshot_encrypted)), anchor) !== anchor.envelope) denied()
          await verifyLedger(trx, anchor.ledgerId, selected, anchor.executionDigest, expectedStatus)
          const projected = await project(trx, selected)
          const finalProof = await claims.lockAdmittedInTransaction(trx, anchor.claim, {
            grantId: anchor.grantId, requestId: anchor.requestId, admissionId: anchor.admissionId, ledgerId: anchor.ledgerId })
          await claims.takeInTransaction(trx, finalProof)
          if (await now(trx) >= anchor.expiresAt || ended) denied()
          // Terminal retirement runs only AFTER the unchanged admitted proof.
          // Grant/request/consumer locks remain held to this transaction's COMMIT.
          // Rechecking an admitted proof after retirement would reject the very
          // transition we just proved; never relax that shared proof validator.
          if (afterFinalProof) {
            await afterFinalProof(trx)
            if (await now(trx) >= anchor.expiresAt || ended) denied()
          }
          return projected
        }, anchor, guard)
      } catch { ended = true; return denied() }
      finally { if (ownsBusy) busy = false }
    }
    async function checkpoint(expectedStatus: 'prepared' | 'dispatching' = 'prepared', options?: unknown) {
      return authenticated(expectedStatus, options, async (_trx, selected) => Object.freeze({ context,
        operation: Object.freeze({ operationId: selected.operationId, rowKey: selected.rowKey }),
        grantRef: anchor.grantId, expiresAt: anchor.expiresAt, executionDigest: anchor.executionDigest,
        targetRef: selected.targetRef, targetRevision: selected.targetRevision, planRevision: selected.planRevision,
        credentialBinding: Object.freeze({ ...scope, credentialRef: selected.credentialRef,
          credentialGeneration: selected.credentialGeneration }),
        config: selected.config, row: selected.selectedRow,
        canSend: false, externalWriteAttempted: false }))
    }
    async function currentMaterial(trx: Queryable, selected: YidaSendAuthoritySelection) {
      const raw = data(await loadMaterial(trx, { credentialRef: selected.credentialRef,
        credentialGeneration: selected.credentialGeneration }), [...Object.keys(credentialBinding), 'appKey', 'appSecret', 'systemToken', 'userId'])
      if (Object.entries(credentialBinding).some(([key, value]) => raw[key] !== value)) denied()
      for (const key of ['appKey', 'appSecret', 'systemToken', 'userId']) {
        if (typeof raw[key] !== 'string' || !raw[key] || raw[key].length > (key === 'userId' ? 128 : 4096)) denied()
      }
      return raw
    }
    async function resolveExecutionSnapshot(input: unknown, options?: unknown): Promise<Readonly<Row>> {
      try {
        assertActive()
        const requested = data(input, Object.keys(identity))
        if (Object.entries(identity).some(([key, value]) => requested[key] !== value) || busy || resolutions >= 3
          || (resolutions === 1 && loads !== 2)) denied()
        const ordinal = ++resolutions
        return await authenticated(ordinal === 3 ? 'dispatching' : 'prepared', options, async (trx, selected) => {
          const material = await currentMaterial(trx, selected)
          return Object.freeze({ ...identity, grantRef: anchor.grantId, expiresAt: anchor.expiresAt,
            targetRef: selected.targetRef, targetRevision: selected.targetRevision, planRevision: selected.planRevision,
            credentialRef: selected.credentialRef, credentialGeneration: selected.credentialGeneration,
            config: selected.config, row: selected.selectedRow, systemToken: material.systemToken, userId: material.userId })
        })
      } catch { ended = true; return denied() }
    }
    async function loadCredential(input: unknown, options?: unknown): Promise<Readonly<Row>> {
      try {
        assertActive()
        const requested = data(input, Object.keys(credentialBinding))
        if (Object.entries(credentialBinding).some(([key, value]) => requested[key] !== value)
          || busy || resolutions !== 1 || loads >= 2) denied()
        // The ORIGINAL token client checks material before exchange AND before
        // publishing the received token. These two reads are one flight, not
        // permission for another token request or another delivery attempt.
        loads += 1
        return await authenticated('prepared', options, async (trx, selected) => {
          const material = await currentMaterial(trx, selected)
          return Object.freeze({ ...credentialBinding, appKey: material.appKey, appSecret: material.appSecret })
        })
      } catch { ended = true; return denied() }
    }
    async function claimDeliveryExecution(input: unknown) {
      try {
        assertActive()
        const requested = data(input, Object.keys(identity))
        if (Object.entries(identity).some(([key, value]) => requested[key] !== value)
          || resolutions !== 2 || loads !== 2) denied()
        return await authenticated('prepared', undefined, async (trx, selected) => {
          const claimed = await claimDelivery(trx, requested)
          if (typeof claimed.claimToken !== 'string' || !DIGEST.test(claimed.claimToken)) denied()
          await verifyLedger(trx, anchor.ledgerId, selected, anchor.executionDigest, 'dispatching')
          return claimed
        })
      } catch { ended = true; return denied() }
    }
    async function finish(input: unknown, kind: 'acknowledgement' | 'unknown') {
      try {
        assertActive()
        const requested = data(input, [...Object.keys(identity), 'claimToken', kind === 'acknowledgement' ? 'ack' : 'reason'])
        const resolutionAllowed = resolutions === 3 || (kind === 'unknown' && resolutions === 2)
        if (Object.entries(identity).some(([key, value]) => requested[key] !== value)
          || !resolutionAllowed || loads !== 2 || typeof requested.claimToken !== 'string' || !DIGEST.test(requested.claimToken)) denied()
        // A cancelled waiter may receive the real claim only AFTER COMMIT and
        // before resolution 3. That exact dispatching ledger may be recorded as
        // unknown, never acknowledged or retried; all live/fence checks remain.
        // The ORIGINAL terminal writer and audit now run under the SAME actual
        // transaction/consumer row lock as the final live admission/fence check.
        // A superseded worker cannot fall back to an unguarded ledger write.
        // Cleanup does not inherit the runner's cancelled per-IO signal; the
        // immutable parent/expiry/current-fence checks are still mandatory.
        const result = await authenticated('dispatching', undefined, trx => finishDelivery(trx, requested, kind),
          kind === 'acknowledgement' ? async trx => {
            // Native ACK/audit and this retirement MUST commit or roll back
            // together. Unknown never frees the serial slot or refunds budget.
            const terminal = await trx.query(`SELECT l.id FROM integration_yida_delivery_ledger l
              JOIN integration_yida_auto_admissions a ON a.ledger_id=l.id
              WHERE l.id=$1 AND a.id=$2 AND a.grant_id=$3 AND a.request_id=$4
                AND l.tenant_id=$5 AND l.owner_id=$6 AND l.workspace_id IS NULL
                AND l.status='acknowledged' AND l.claim_actor_id=$7 AND l.claim_token=$8
                AND a.worker_id=$7 AND a.worker_fence=$9::bigint`,
            [anchor.ledgerId, anchor.admissionId, anchor.grantId, anchor.requestId,
              scope.tenantId, scope.ownerId, workerId, requested.claimToken, anchor.claim.fence])
            if (terminal.rows.length !== 1) denied()
            const retired = await trx.query(`UPDATE integration_yida_auto_requests SET status='closed_observed'
              WHERE id=$1 AND grant_id=$2 AND status='admitted' RETURNING id`, [anchor.requestId, anchor.grantId])
            if (retired.rows.length !== 1) denied()
            const released = await trx.query(`UPDATE integration_yida_auto_grants SET active_request_id=NULL
              WHERE id=$1 AND active_request_id=$2 AND tenant_id=$3 AND owner_id=$4
                AND workspace_id IS NULL RETURNING id`,
            [anchor.grantId, anchor.requestId, scope.tenantId, scope.ownerId])
            if (released.rows.length !== 1) denied()
          } : undefined)
        ended = true
        return result
      } catch { ended = true; return denied() }
    }
    return Object.freeze({ context, operation, credentialBinding, checkpoint, assertActive,
      resolveExecutionSnapshot, loadCredential,
      claim: claimDeliveryExecution,
      recordAcknowledgement: (input: unknown) => finish(input, 'acknowledgement'),
      markUnknown: (input: unknown) => finish(input, 'unknown'), close() { ended = true } })
  }
  return Object.freeze({ admitForExecution, takeExecution, observeAdmission,
    close() { closed = true; permits = new WeakMap(); live.close(); claims.close() } })
}
