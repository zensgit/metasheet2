import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { isAuthorizationVersionConflict, lockSubjectAuthorizationVersionForAdmission } from '../multitable/authz-version-protocol'
import { assertAutomationIntegrationActor } from './automation-live-authority'

// Internal host service only. Trusted authentication must supply context; this
// module is not registered as a route, plugin API, bearer capability or sender.
// A committed admission consumes the attempt, but does not perform external IO.
type Context = { actorId: string; tenantId: string; workspaceId: null }
type Row = Record<string, unknown>
// LIMIT (gate 4, R-71 ⑦.2): the selected row would exceed the shared YiDa send budget (runner snapshot
// or form request body). Fixed and values-free: no byte count, field name or value.
// IDENTITY_RESERVED (design baseline v2.3 §3.3, D16 a): the row's logical creation identity (key value +
// project number, the material code's inputs) already has a ledger row under this target; refused at approval,
// before any grant, so the operator sees it early. The partial unique index on the ledger is the final guarantee.
// GENERATED_LAYOUT_CONFLICT (external review P1, 2026-11-08; migration zzzz20261108120000): the target's generated layout
// was sealed by an earlier approval / admission and this selection's layout signature differs (another template shape on
// the same target could give another identity the same code). Refused at approval and at admission, before any write.
type ErrorCode = 'INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'EXPIRED' | 'REVOKED' | 'CANCELLED' | 'UNAVAILABLE' | 'LIMIT' | 'IDENTITY_RESERVED'
  | 'GENERATED_LAYOUT_CONFLICT'
const CODES = new Set<unknown>(['INPUT', 'NOT_FOUND', 'CONFLICT', 'EXPIRED', 'REVOKED', 'CANCELLED', 'UNAVAILABLE', 'LIMIT', 'IDENTITY_RESERVED',
  'GENERATED_LAYOUT_CONFLICT'])
const ownErrors = new WeakMap<object, ErrorCode>()
const MAX_TTL = 900000
const MAX_PLAIN = 16 * 1024 * 1024
const MAX_CIPHER = 24 * 1024 * 1024
const DIGEST = /^[0-9a-f]{64}$/
// Y2 multi-target: additional owner-attested targets live in slots 2..16 (migration zzzz20261103130000).
const MAX_SLOT = 16
const TARGET_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// Source binding (§7.2): a selection names its two row digests (null for an unbound row) and its per-row binding.
const SELECTION_KEYS = ['tenantId', 'workspaceId', 'ownerId', 'operationId', 'rowKey', 'targetRef',
  'targetRevision', 'planRevision', 'credentialRef', 'credentialGeneration', 'businessKeyDigest',
  'rowPayloadDigest', 'planDigest', 'sourceRecordDigest', 'creationIdentityDigest', 'sourceBinding',
  'config', 'selectedRow', 'source', 'plan'] as const
const ROW_BINDING_KEYS = ['sheetId', 'recordId', 'keyFieldId', 'keyValue', 'projectNo', 'fieldBindings', 'fieldDependencies'] as const
const BINDING_KEYS = ['tenantId', 'workspaceId', 'ownerId', 'credentialRef', 'credentialGeneration'] as const
const IDENTITY_KEYS = ['tenantId', 'workspaceId', 'ownerId', 'actorId', 'operationId', 'rowKey'] as const
const GRANT_ANCHOR_KEYS = ['grant_id', 'confirmation_id', 'tenant_id', 'workspace_id', 'owner_id', 'target_ref',
  'operation_id', 'row_key', 'target_revision', 'plan_revision', 'plan_digest', 'credential_ref',
  'credential_generation', 'business_key_digest', 'row_payload_digest', 'execution_payload_digest',
  'source_record_digest', 'creation_identity_digest',
  'ttl_ms', 'approved_at_ms', 'expires_at_ms', 'max_attempts', 'snapshot_encrypted'] as const
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
type Checkpoint = () => void
const noCheckpoint: Checkpoint = () => {}

function callerSignal(options: unknown): AbortSignal | undefined {
  const parsed = record(options, ['signal'], [])
  if (parsed.signal === undefined) return undefined
  const signal = parsed.signal
  if (!signal || typeof signal !== 'object' || types.isProxy(signal)
    || Object.getPrototypeOf(signal) !== AbortSignal.prototype) fail('INPUT')
  try { abortedGetter.call(signal) } catch { fail('INPUT') }
  return signal as AbortSignal
}
async function checked<T>(checkpoint: Checkpoint, operation: () => Promise<T>): Promise<T> {
  checkpoint()
  const result = await operation()
  checkpoint()
  return result
}

export class YidaSendApprovalError extends Error {
  readonly code: string
  constructor(code: unknown) {
    const safe = (CODES.has(code) ? code : 'UNAVAILABLE') as ErrorCode
    super(`YIDA_SEND_APPROVAL_${safe}`)
    this.name = 'YidaSendApprovalError'
    this.code = this.message
    ownErrors.set(this, safe)
  }
}
function fail(code: ErrorCode): never { throw new YidaSendApprovalError(code) }
function closeError(error: unknown): never {
  // WeakMap.get also accepts non-object rejection values without coercion.
  fail(ownErrors.get(error as object) ?? 'UNAVAILABLE')
}
// The HTTP/runtime boundary may classify only this module's own fixed errors.
// Do not inspect another dependency's code, prototype, message or Proxy traps.
export function yidaSendApprovalErrorCode(error: unknown): string | undefined {
  const code = ownErrors.get(error as object)
  return code === undefined ? undefined : `YIDA_SEND_APPROVAL_${code}`
}
function record(value: unknown, keys: readonly string[], required = keys): Row {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail('INPUT')
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) fail('INPUT')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !keys.includes(key))
    || required.some(key => !Object.hasOwn(descriptors, key))) fail('INPUT')
  const result: Row = {}
  for (const key of Object.keys(descriptors)) {
    const descriptor = descriptors[key]
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('INPUT')
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true })
  }
  return result
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('INPUT')
  return value
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail('UNAVAILABLE')
  return value
}
// A binding digest: null for an unbound row, otherwise a 64-hex sha256.
function optionalDigest(value: unknown): string | null {
  return value === null ? null : digest(value)
}
function millis(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]{1,16}$/.test(value))) fail('UNAVAILABLE')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail('UNAVAILABLE')
  return parsed
}
function cipher(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('enc:') || value.length <= 4
    || Buffer.byteLength(value, 'utf8') > MAX_CIPHER) fail('UNAVAILABLE')
  return value
}
function canonical(value: unknown): string {
  let nodes = 0
  const ancestors = new Set<object>()
  function visit(entry: unknown, depth: number): unknown {
    if (++nodes > 300000 || depth > 40) fail('UNAVAILABLE')
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') return entry
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry) || Object.is(entry, -0)) fail('UNAVAILABLE')
      return entry
    }
    if (!entry || typeof entry !== 'object' || types.isProxy(entry) || ancestors.has(entry)) fail('UNAVAILABLE')
    const array = Array.isArray(entry), proto = Object.getPrototypeOf(entry)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail('UNAVAILABLE')
    const descriptors = Object.getOwnPropertyDescriptors(entry), keys = Reflect.ownKeys(descriptors)
    if (keys.some(key => typeof key !== 'string')) fail('UNAVAILABLE')
    ancestors.add(entry)
    let result: unknown
    if (array) {
      if (keys.length !== entry.length + 1 || entry.length > 300000) fail('UNAVAILABLE')
      result = Array.from({ length: entry.length }, (_, index) => {
        const property = descriptors[String(index)]
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail('UNAVAILABLE')
        return visit(property.value, depth + 1)
      })
    } else {
      const object: Row = Object.create(null)
      for (const key of (keys as string[]).sort()) {
        const property = descriptors[key]
        if (!property.enumerable || !Object.hasOwn(property, 'value')) fail('UNAVAILABLE')
        object[key] = visit(property.value, depth + 1)
      }
      result = object
    }
    ancestors.delete(entry)
    return result
  }
  const text = JSON.stringify(visit(value, 0))
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_PLAIN) fail('UNAVAILABLE')
  return text
}

/** The per-row source binding of a bound selection (design baseline v2.3 §7.2); null for a pasted row. */
export type YidaSourceRowBinding = Readonly<{
  sheetId: string; recordId: string; keyFieldId: string; keyValue: string; projectNo: string
  fieldBindings: Readonly<Record<string, string>>; fieldDependencies: Readonly<Record<string, readonly string[]>>
}>
/**
 * D21 (design baseline v2.3 §7.2 「分界是准入提交」): the host's in-transaction re-authorization of ONE bound row
 * (`yida-sheet-source.ts reauthorizeYidaSourceBinding`, wired through the runtime). Called by approve() and
 * persistAdmission() on their own `trx`, after the actor's subject version row and the live-authority rows are
 * held. Answers a frozen plain verdict (`{ authorized: true }` or `{ authorized: false, code }`); this service
 * maps it to its own fixed codes and never inspects anything else about it.
 */
export type YidaSourceBindingReauthorizer = (trx: Queryable, actor: Readonly<Context>, binding: YidaSourceRowBinding) => Promise<unknown>
export type YidaSendAuthoritySelection = Readonly<{
  tenantId: string; workspaceId: null; ownerId: string; operationId: string; rowKey: string
  targetRef: string; targetRevision: 'evidence-1'; planRevision: string
  credentialRef: string; credentialGeneration: number; businessKeyDigest: string
  rowPayloadDigest: string; planDigest: string
  sourceRecordDigest: string | null; creationIdentityDigest: string | null; sourceBinding: YidaSourceRowBinding | null
  config: unknown; selectedRow: unknown; source: unknown; plan: unknown
}>
export type YidaSendAuthorityPrimitives = {
  resolveSelectionInTransaction(trx: Queryable, input: { operationId: string; rowKey: string }): Promise<YidaSendAuthoritySelection>
  executionPayloadDigest(selection: YidaSendAuthoritySelection, input: { grantRef: string; expiresAt: number; actorId: string }): string | Promise<string>
  // Gate 4: synchronous, one frozen boolean. Anything else (a promise, a Proxy, an accessor) is refused.
  sendBudget(selection: YidaSendAuthoritySelection, input: { grantRef: string; expiresAt: number; actorId: string }): Readonly<{ withinBudget: boolean }>
  // P1 (2026-11-08): seal-or-match the target's generated layout on this trx, inside approve() / persistAdmission(), after
  // the host's own checks and before its first write. A frozen plain verdict: { admissible: true, sealed } or
  // { admissible: false, code: 'GENERATED_LAYOUT_CONFLICT' }; this service maps it to its own fixed codes.
  sealGeneratedLayoutInTransaction(trx: Queryable, selection: YidaSendAuthoritySelection, input: { event: 'approve' | 'admit' }): Promise<unknown>
  prepareInTransaction(trx: Queryable, input: {
    tenantId: string; workspaceId: null; ownerId: string; operationId: string; rowKey: string
    targetRef: string; targetRevision: string; planRevision: string; credentialRef: string
    credentialGeneration: number; businessKeyDigest: string; payloadDigest: string; intent: 'create'
    sourceRecordDigest?: string | null; creationIdentityDigest?: string | null; sourceBinding?: YidaSourceRowBinding | null
  }): Promise<{ record: Row; reused: boolean }>
}
export type YidaSendApprovalMetadata = Readonly<{
  grantId: string; operationId: string; rowKey: string; targetRef: string
  approvedAt: number; expiresAt: number; maxAttempts: 1; remainingAttempts: 0 | 1
  status: 'approved' | 'expired' | 'revoked' | 'admitted'; revoked: boolean
  admissionId: string | null; ledgerId: string | null; canSend: false; externalWriteAttempted: false
}>
type Dependencies = {
  database: { transaction<T>(callback: (trx: Queryable) => Promise<T>): Promise<T> }
  security: { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
  context: Context
  // The actual private plugin factory supplies this port, never a request body.
  // It is data/execution infrastructure, not a substitute for live host authority.
  primitives: YidaSendAuthorityPrimitives
  // Y2: true only while the host multi-target switch reads exact 'true' for this run. False/absent =
  // the original permanent slot-1 authority, byte for byte (no targetRef accepted or forwarded).
  multiTarget?: boolean
  // D17 b (R-88): true only while INTEGRATION_YIDA_SHEET_SOURCE_ENABLED reads exact 'true' for this run. It admits the
  // host's sheet-source binding on a draft without multi-target (slot 1); it never admits a targetRef. Absent =
  // today's coupling (D17 a): a binding rides only with multiTarget.
  sheetSource?: boolean
  // D20 (design baseline v2.3 §3.3/§7.2): target refs that may take UNBOUND rows besides slot 1 (the material
  // TEST copy, R-71 decision 1). Every other target refuses an unbound row at approval and at admission. The
  // runtime parses INTEGRATION_YIDA_UNBOUND_TEST_TARGET_REFS once per run; absent = empty.
  unboundTestTargetRefs?: ReadonlySet<string>
  // D21 (§7.2): re-authorizes a BOUND row inside approve() / persistAdmission(); never consulted for an unbound row.
  // Absent = every bound row is refused (fail closed); the host runtime always wires it (yida-owner-runtime.ts).
  reauthorizeSourceBinding?: YidaSourceBindingReauthorizer
}
// A multi-target transaction names its target: explicitly (draft/preview/approve) or through the
// immutable grant row (inspect/revoke/admit/observe/execution). Never chosen from a request scope.
type TargetSelector = Readonly<{ targetRef: string }> | Readonly<{ grantId: string }>
type TargetBinding = Readonly<{ draftTargetRef: string }> | null

export type YidaExecutionCredentialBinding = Readonly<{
  tenantId: string; workspaceId: null; ownerId: string; credentialRef: string; credentialGeneration: number
}>
export type YidaSendExecutionPrimitives = YidaSendAuthorityPrimitives & {
  loadExecutionMaterialInTransaction(trx: Queryable, input: { credentialRef: string; credentialGeneration: number }):
    Promise<YidaExecutionCredentialBinding & { appKey: string; appSecret: string; systemToken: string; userId: string }>
  prepareDraftInTransaction?(trx: Queryable, input: unknown): Promise<Readonly<Row>>
  // R-71 ⑦.3 decision C1: pure and synchronous, one frozen boolean, checked before a draft is written.
  draftSendBudget?(input: unknown): Readonly<{ withinBudget: boolean }>
  previewInTransaction?(trx: Queryable, input: { operationId: string; rowKey: string }): Promise<Readonly<Row>>
}
export type YidaSendExecutionDependencies = Omit<Dependencies, 'primitives'> & { primitives: YidaSendExecutionPrimitives }
type ApprovalResult = YidaSendApprovalMetadata & Readonly<{ reused: boolean }>
type ExecutionAnchor = Readonly<{
  grantId: string; admissionId: string; submissionId: string; ledgerId: string; grant: Readonly<Row>
}>
export type YidaSendExecutionHandle = Readonly<{
  context: Readonly<Context & { ownerId: string }>
  operation: Readonly<{ operationId: string; rowKey: string }>
  credentialBinding: YidaExecutionCredentialBinding
  resolveExecutionSnapshot(identity: unknown, options?: unknown): Promise<Readonly<Row>>
  loadCredential(binding: unknown, options?: unknown): Promise<YidaExecutionCredentialBinding & Readonly<{ appKey: string; appSecret: string }>>
  close(): void
}>

function createApprovalInternals({ database, security, context, primitives, multiTarget, sheetSource, unboundTestTargetRefs, reauthorizeSourceBinding }: Dependencies,
  executionPrimitives?: YidaSendExecutionPrimitives) {
  const multi = multiTarget === true
  const sheetSourceOnly = !multi && sheetSource === true
  // Captured once: a Set of exact target refs, or empty. Never widened after construction.
  const unboundTargets: ReadonlySet<string> = new Set(unboundTestTargetRefs instanceof Set
    ? [...unboundTestTargetRefs].filter((value): value is string => typeof value === 'string' && TARGET_REF.test(value)) : [])
  const rawContext = record(context, ['actorId', 'tenantId', 'workspaceId'])
  const fixed: Context = Object.freeze({ actorId: id(rawContext.actorId), tenantId: id(rawContext.tenantId), workspaceId: null })
  if (rawContext.workspaceId !== null) fail('INPUT')
  if (!database || typeof database.transaction !== 'function' || !security || typeof security.encrypt !== 'function'
    || typeof security.decrypt !== 'function' || !primitives
    || ['resolveSelectionInTransaction', 'executionPayloadDigest', 'sendBudget', 'sealGeneratedLayoutInTransaction', 'prepareInTransaction']
      .some(key => typeof primitives[key as keyof YidaSendAuthorityPrimitives] !== 'function')) fail('UNAVAILABLE')

  // D21 phase 1 (approve / admit only): the actor's subject authorization version row FOR SHARE BEFORE the
  // live-actor rows, so this holder's order on the subject layer is the writer rule's (subject row → users): an
  // access-graph writer that bumped the subject row first waits here until the commit instead of forming a cycle
  // with the `users FOR SHARE` the live-actor check takes next. The sheet version rows and the bound record follow
  // inside the re-authorization. A lock conflict (40P01 / 40001 / 55P03) is CONFLICT, never a pass.
  async function lockSubjectVersion(trx: Queryable) {
    try { await lockSubjectAuthorizationVersionForAdmission(trx, fixed.actorId) }
    catch (error) { fail(isAuthorizationVersionConflict(error) ? 'CONFLICT' : 'UNAVAILABLE') }
  }
  // The callback also learns the locked target's slot: slot 1 is the material TEST copy (R-71 decision 1), the
  // one target that may take unbound rows without being listed (D20).
  async function transaction<T>(callback: (trx: Queryable, targetRef: string, bound: TargetBinding, slot: number) => Promise<T>,
    checkpoint = noCheckpoint, selector?: TargetSelector, subjectLock = false): Promise<T> {
    try {
      if (selector !== undefined && !multi) fail('INPUT')
      return await checked(checkpoint, () => database.transaction(async trx => {
        // The provider has BEGIN already. This must precede even the xid probe.
        await checked(checkpoint, () => trx.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'))
        if (subjectLock) await checked(checkpoint, () => lockSubjectVersion(trx))
        await checked(checkpoint, () => assertAutomationIntegrationActor(trx, fixed))
        if (selector === undefined) {
          const result = await checked(checkpoint, () => trx.query('SELECT slot, target_ref, tenant_id, workspace_id, owner_id, evidence_version, status FROM integration_yida_approved_target WHERE slot = 1 FOR UPDATE'))
          const slot = result.rows[0]
          if (result.rows.length !== 1 || slot.tenant_id !== fixed.tenantId || slot.workspace_id !== null
            || slot.owner_id !== fixed.actorId) fail('NOT_FOUND')
          if (slot.slot !== 1 || slot.status !== 'manually_confirmed' || slot.evidence_version !== 1) fail('UNAVAILABLE')
          return checked(checkpoint, () => callback(trx, id(slot.target_ref), null, 1))
        }
        // Y2: a grant names its target for good (append-only row); read that binding, then lock the
        // target row exactly as the slot-1 path does. A grant of another owner/tenant is NOT_FOUND.
        let wanted: string
        if ('grantId' in selector) {
          const bound = await checked(checkpoint, () => trx.query('SELECT target_ref FROM integration_yida_send_approvals WHERE grant_id = $1 AND tenant_id = $2 AND workspace_id IS NULL AND owner_id = $3',
            [id(selector.grantId), fixed.tenantId, fixed.actorId]))
          if (bound.rows.length !== 1) fail('NOT_FOUND')
          wanted = id(bound.rows[0].target_ref)
        } else wanted = id(selector.targetRef)
        if (!TARGET_REF.test(wanted)) fail('NOT_FOUND')
        const result = await checked(checkpoint, () => trx.query('SELECT slot, target_ref, tenant_id, workspace_id, owner_id, evidence_version, status, draft_target_ref FROM integration_yida_approved_target WHERE target_ref = $1 FOR UPDATE', [wanted]))
        const slot = result.rows[0]
        if (result.rows.length !== 1 || slot.target_ref !== wanted || slot.tenant_id !== fixed.tenantId
          || slot.workspace_id !== null || slot.owner_id !== fixed.actorId) fail('NOT_FOUND')
        if (!Number.isInteger(slot.slot) || Number(slot.slot) < 1 || Number(slot.slot) > MAX_SLOT || slot.status !== 'manually_confirmed'
          || slot.evidence_version !== 1) fail('UNAVAILABLE')
        const binding: TargetBinding = Object.freeze({ draftTargetRef: id(slot.draft_target_ref) })
        return checked(checkpoint, () => callback(trx, id(slot.target_ref), binding, Number(slot.slot)))
      }))
    } catch (error) { closeError(error) }
  }
  // D20 (design baseline v2.3 §3.3, §7.2): a formal target takes bound rows only. Slot 1 (the material TEST
  // copy) and the exact-listed test targets may still take an unbound row, which is then fenced by the
  // seven-key reservation alone. Checked at approval and again at admission, each inside its transaction.
  function assertBindingRequired(selected: YidaSendAuthoritySelection, targetRef: string, slot: number) {
    if (selected.creationIdentityDigest !== null) return
    if (slot === 1 || unboundTargets.has(targetRef)) return
    fail('CONFLICT')
  }
  // Early identity rejection (§3.3): a read-only look at the ledger before a grant is written. The partial
  // unique index on the ledger decides the race at admission; this only moves the answer forward.
  async function assertIdentityFree(trx: Queryable, selected: YidaSendAuthoritySelection, targetRef: string) {
    if (selected.creationIdentityDigest === null) return
    const reserved = await trx.query('SELECT 1 FROM integration_yida_delivery_ledger WHERE tenant_id = $1 AND workspace_id IS NULL AND target_ref = $2 AND intent = $3 AND creation_identity_digest = $4 LIMIT 1',
      [fixed.tenantId, targetRef, 'create', selected.creationIdentityDigest])
    if (reserved.rows.length !== 0) fail('IDENTITY_RESERVED')
  }
  // D21 (§7.2): a bound row is re-authorized INSIDE this transaction, on this trx, by the host's in-transaction re-check
  // (every check of the draft-time read, from locked rows). Only a frozen plain verdict passes. A refused check or a
  // lock conflict is CONFLICT (nothing written: the enclosing transaction rolls back, the grant keeps its attempt);
  // a protocol gap, a malformed verdict, a thrown error or an absent re-authorizer is UNAVAILABLE. An unbound row
  // (pasted rowsText) has nothing to re-authorize: D20 decides whether its target may take it.
  async function reauthorize(trx: Queryable, selected: YidaSendAuthoritySelection) {
    if (selected.sourceBinding === null) return
    if (typeof reauthorizeSourceBinding !== 'function' || types.isProxy(reauthorizeSourceBinding)) fail('UNAVAILABLE')
    let verdict: unknown
    try { verdict = await reauthorizeSourceBinding(trx, fixed, selected.sourceBinding) } catch { fail('UNAVAILABLE') }
    assertReauthorizationVerdict(verdict)
  }
  function assertReauthorizationVerdict(verdict: unknown) {
    if (!verdict || typeof verdict !== 'object' || types.isProxy(verdict) || Array.isArray(verdict) || !Object.isFrozen(verdict)) fail('UNAVAILABLE')
    const proto = Object.getPrototypeOf(verdict)
    if (proto !== Object.prototype && proto !== null) fail('UNAVAILABLE')
    const descriptors = Object.getOwnPropertyDescriptors(verdict), keys = Reflect.ownKeys(descriptors)
    if (keys.some(key => typeof key !== 'string') || !Object.hasOwn(descriptors, 'authorized') || !Object.hasOwn(descriptors.authorized, 'value')) fail('UNAVAILABLE')
    if (descriptors.authorized.value === true) {
      if (keys.length !== 1) fail('UNAVAILABLE')
      return
    }
    if (descriptors.authorized.value !== false || keys.length !== 2 || !Object.hasOwn(descriptors, 'code')
      || !Object.hasOwn(descriptors.code, 'value')) fail('UNAVAILABLE')
    // The check that refused (registry, table, field, record) or a lock conflict: the operator re-checks and retries.
    if (['REGISTRY', 'SHEET', 'FIELD', 'RECORD', 'CONFLICT'].includes(descriptors.code.value as string)) fail('CONFLICT')
    fail('UNAVAILABLE')
  }
  // P1 (external review 2026-11-08): the target's generated layout is sealed once, by the first approval or admission
  // that uses a generated entry, and every later selection with another layout signature is refused — on this trx, after
  // the D20 / identity / D21 checks and before the first write (the grant row, the ledger row). The primitive answers a
  // frozen plain verdict; only its exact conflict code becomes GENERATED_LAYOUT_CONFLICT, anything else is UNAVAILABLE.
  async function sealGeneratedLayout(trx: Queryable, selected: YidaSendAuthoritySelection, event: 'approve' | 'admit') {
    let verdict: unknown
    try { verdict = await primitives.sealGeneratedLayoutInTransaction(trx, selected, { event }) } catch { fail('UNAVAILABLE') }
    assertGeneratedLayoutVerdict(verdict)
  }
  function assertGeneratedLayoutVerdict(verdict: unknown) {
    if (!verdict || typeof verdict !== 'object' || types.isProxy(verdict) || Array.isArray(verdict) || !Object.isFrozen(verdict)) fail('UNAVAILABLE')
    const proto = Object.getPrototypeOf(verdict)
    if (proto !== Object.prototype && proto !== null) fail('UNAVAILABLE')
    const descriptors = Object.getOwnPropertyDescriptors(verdict), keys = Reflect.ownKeys(descriptors)
    if (keys.some(key => typeof key !== 'string') || keys.length !== 2 || !Object.hasOwn(descriptors, 'admissible')
      || !Object.hasOwn(descriptors.admissible, 'value')) fail('UNAVAILABLE')
    if (descriptors.admissible.value === true) {
      if (!Object.hasOwn(descriptors, 'sealed') || !Object.hasOwn(descriptors.sealed, 'value') || typeof descriptors.sealed.value !== 'boolean') fail('UNAVAILABLE')
      return
    }
    if (descriptors.admissible.value !== false || !Object.hasOwn(descriptors, 'code') || !Object.hasOwn(descriptors.code, 'value')) fail('UNAVAILABLE')
    if (descriptors.code.value === 'GENERATED_LAYOUT_CONFLICT') fail('GENERATED_LAYOUT_CONFLICT')
    fail('UNAVAILABLE')
  }
  // Y2: an operation (draft) is compiled for exactly one target's app/form. Under a named target it
  // must belong to that target's draft locator, or the request is a cross-target attempt: CONFLICT.
  async function assertOperationTarget(trx: Queryable, bound: TargetBinding, operationId: string) {
    if (bound === null) return
    const result = await trx.query('SELECT target_ref FROM integration_yida_draft_operations WHERE operation_id = $1', [operationId])
    if (result.rows.length !== 1) fail('NOT_FOUND')
    if (result.rows[0].target_ref !== bound.draftTargetRef) fail('CONFLICT')
  }
  const targeted = <T extends Row>(input: T, targetRef: string, bound: TargetBinding): T | (T & { targetRef: string }) =>
    bound === null ? input : { ...input, targetRef }
  const grantSelector = (grantId: string): TargetSelector | undefined => multi ? Object.freeze({ grantId }) : undefined
  async function now(trx: Queryable): Promise<number> {
    const result = await trx.query('SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS now_ms')
    if (result.rows.length !== 1) fail('UNAVAILABLE')
    return millis(result.rows[0].now_ms)
  }
  function checkGrant(row: Row, targetRef: string): Row {
    if (row.tenant_id !== fixed.tenantId || row.workspace_id !== null || row.owner_id !== fixed.actorId
      || row.target_ref !== targetRef) fail('NOT_FOUND')
    for (const key of ['grant_id', 'operation_id', 'row_key', 'confirmation_id', 'credential_ref']) id(row[key])
    const approvedAt = millis(row.approved_at_ms), expiresAt = millis(row.expires_at_ms)
    if (!Number.isInteger(row.ttl_ms) || Number(row.ttl_ms) < 1 || Number(row.ttl_ms) > MAX_TTL
      || expiresAt - approvedAt !== row.ttl_ms || row.max_attempts !== 1 || row.target_revision !== 'evidence-1'
      || !Number.isInteger(row.credential_generation) || Number(row.credential_generation) < 1
      || Number(row.credential_generation) > 2147483647) fail('UNAVAILABLE')
    for (const key of ['plan_revision', 'plan_digest', 'business_key_digest', 'row_payload_digest', 'execution_payload_digest']) digest(row[key])
    if (row.plan_revision !== row.plan_digest) fail('UNAVAILABLE')
    // The two binding digests travel together: both null (unbound) or both 64-hex.
    if ((optionalDigest(row.source_record_digest) === null) !== (optionalDigest(row.creation_identity_digest) === null)) fail('UNAVAILABLE')
    cipher(row.snapshot_encrypted)
    return row
  }
  async function grant(trx: Queryable, targetRef: string, grantId: string): Promise<Row> {
    const result = await trx.query('SELECT * FROM integration_yida_send_approvals WHERE grant_id = $1 AND tenant_id = $2 AND workspace_id IS NULL AND owner_id = $3 AND target_ref = $4 FOR UPDATE',
      [grantId, fixed.tenantId, fixed.actorId, targetRef])
    if (result.rows.length !== 1) fail('NOT_FOUND')
    return checkGrant(result.rows[0], targetRef)
  }
  async function facts(trx: Queryable, row: Row) {
    const admissions = await trx.query('SELECT id, grant_id, ledger_id, submission_id, actor_id FROM integration_yida_send_admissions WHERE grant_id = $1', [row.grant_id])
    const revocations = await trx.query('SELECT id, grant_id, actor_id FROM integration_yida_send_revocations WHERE grant_id = $1', [row.grant_id])
    if (admissions.rows.length > 1 || revocations.rows.length > 1) fail('UNAVAILABLE')
    for (const fact of [...admissions.rows, ...revocations.rows]) {
      if (fact.grant_id !== row.grant_id || fact.actor_id !== fixed.actorId) fail('UNAVAILABLE')
      id(fact.id)
    }
    const admission = admissions.rows[0] ?? null, revocation = revocations.rows[0] ?? null
    if (admission) { id(admission.ledger_id); id(admission.submission_id) }
    return { admission, revocation }
  }
  async function metadata(trx: Queryable, row: Row): Promise<YidaSendApprovalMetadata> {
    const { admission, revocation } = await facts(trx, row), instant = await now(trx)
    const expired = instant >= millis(row.expires_at_ms)
    return Object.freeze({ grantId: id(row.grant_id), operationId: id(row.operation_id), rowKey: id(row.row_key), targetRef: id(row.target_ref),
      approvedAt: millis(row.approved_at_ms), expiresAt: millis(row.expires_at_ms), maxAttempts: 1,
      remainingAttempts: admission || revocation || expired ? 0 : 1,
      status: admission ? 'admitted' : revocation ? 'revoked' : expired ? 'expired' : 'approved', revoked: Boolean(revocation),
      admissionId: admission ? id(admission.id) : null, ledgerId: admission ? id(admission.ledger_id) : null,
      canSend: false, externalWriteAttempted: false })
  }
  async function selection(trx: Queryable, targetRef: string, operationId: string, rowKey: string, bound: TargetBinding = null) {
    await assertOperationTarget(trx, bound, operationId)
    const selected = await primitives.resolveSelectionInTransaction(trx, targeted({ operationId, rowKey }, targetRef, bound))
    const checked = record(selected, SELECTION_KEYS)
    if (!Object.isFrozen(selected) || checked.tenantId !== fixed.tenantId || checked.workspaceId !== null
      || checked.ownerId !== fixed.actorId || checked.targetRef !== targetRef || checked.operationId !== operationId
      || checked.rowKey !== rowKey || checked.targetRevision !== 'evidence-1') fail('CONFLICT')
    id(checked.credentialRef)
    if (!Number.isInteger(checked.credentialGeneration) || Number(checked.credentialGeneration) < 1
      || Number(checked.credentialGeneration) > 2147483647 || checked.planRevision !== checked.planDigest) fail('UNAVAILABLE')
    for (const key of ['planRevision', 'planDigest', 'businessKeyDigest', 'rowPayloadDigest']) digest(checked[key])
    // Binding (§7.2): both digests and the per-row binding are present together, or all three are null.
    const isBound = optionalDigest(checked.sourceRecordDigest) !== null
    if (isBound !== (optionalDigest(checked.creationIdentityDigest) !== null) || isBound !== (checked.sourceBinding !== null)) fail('UNAVAILABLE')
    if (isBound) {
      const rowBinding = record(checked.sourceBinding, ROW_BINDING_KEYS)
      for (const key of ['sheetId', 'recordId', 'keyFieldId', 'projectNo']) id(rowBinding[key])
      if (typeof rowBinding.keyValue !== 'string' || !rowBinding.keyValue) fail('UNAVAILABLE')
    }
    canonical(selected)
    // Preserve the original object's private port brand for the digest call.
    return selected
  }
  function envelope(row: Row, selected: YidaSendAuthoritySelection) {
    return { purpose: 'yida-send-approval', schemaVersion: 1, tenantId: fixed.tenantId, workspaceId: null,
      ownerId: fixed.actorId, actorId: fixed.actorId, grantId: row.grant_id, confirmationId: row.confirmation_id,
      approvedAt: millis(row.approved_at_ms), expiresAt: millis(row.expires_at_ms), ttlMs: row.ttl_ms, maxAttempts: 1,
      executionPayloadDigest: row.execution_payload_digest, selection: selected }
  }
  async function authenticatedSelection(trx: Queryable, targetRef: string, row: Row, checkpoint = noCheckpoint, bound: TargetBinding = null) {
    const selected = await checked(checkpoint, () => selection(trx, targetRef, id(row.operation_id), id(row.row_key), bound))
    const executionDigest = digest(await checked(checkpoint, async () => primitives.executionPayloadDigest(selected,
      { grantRef: id(row.grant_id), expiresAt: millis(row.expires_at_ms), actorId: fixed.actorId })))
    if (executionDigest !== row.execution_payload_digest || selected.credentialRef !== row.credential_ref
      || selected.credentialGeneration !== row.credential_generation || selected.planDigest !== row.plan_digest
      || selected.businessKeyDigest !== row.business_key_digest || selected.rowPayloadDigest !== row.row_payload_digest) fail('CONFLICT')
    const plain = await checked(checkpoint, () => security.decrypt(cipher(row.snapshot_encrypted)))
    if (typeof plain !== 'string' || Buffer.byteLength(plain, 'utf8') > MAX_PLAIN) fail('UNAVAILABLE')
    if (canonical(JSON.parse(plain)) !== canonical(envelope(row, selected))) fail('CONFLICT')
    checkpoint()
    return { selected, executionDigest }
  }
  // Gate 4 (R-71 ⑦.2): the shared send budget, checked before a grant is written and before an
  // admission prepares the ledger. Only an own, frozen, plain { withinBudget: true } data property
  // passes; false is LIMIT, and any other shape (or a thrown error) is UNAVAILABLE. Either way the
  // enclosing transaction rolls back.
  function assertSendBudget(selected: YidaSendAuthoritySelection, grant: { grantRef: string; expiresAt: number; actorId: string }) {
    assertBudgetVerdict(primitives.sendBudget(selected, grant))
  }
  // One verdict rule for the gate-4 budget at approval/admission and the R-71 ⑦.3 draft-time budget.
  function assertBudgetVerdict(verdict: unknown) {
    if (types.isPromise(verdict)) {
      // Observe an ordinary local rejection only; never consult a dependency-owned constructor.
      try {
        if (!types.isProxy(verdict) && Object.getPrototypeOf(verdict) === Promise.prototype && !Object.hasOwn(verdict, 'constructor'))
          Promise.prototype.then.call(verdict, undefined, () => {})
      } catch { /* Still refused below. */ }
      fail('UNAVAILABLE')
    }
    if (!verdict || typeof verdict !== 'object' || types.isProxy(verdict) || Array.isArray(verdict) || !Object.isFrozen(verdict)) fail('UNAVAILABLE')
    const proto = Object.getPrototypeOf(verdict)
    if (proto !== Object.prototype && proto !== null) fail('UNAVAILABLE')
    const descriptors = Object.getOwnPropertyDescriptors(verdict), keys = Reflect.ownKeys(descriptors)
    if (keys.length !== 1 || keys[0] !== 'withinBudget' || !Object.hasOwn(descriptors.withinBudget, 'value')
      || typeof descriptors.withinBudget.value !== 'boolean') fail('UNAVAILABLE')
    if (descriptors.withinBudget.value !== true) fail('LIMIT')
  }
  async function audit(trx: Queryable, grantId: unknown, event: 'approve' | 'revoke' | 'admit') {
    const result = await trx.query('INSERT INTO integration_yida_send_approval_audit (id, grant_id, event, actor_id) VALUES ($1, $2, $3, $4) RETURNING id, grant_id, event, actor_id',
      [randomUUID(), grantId, event, fixed.actorId])
    if (result.rows.length !== 1 || result.rows[0].grant_id !== grantId || result.rows[0].event !== event
      || result.rows[0].actor_id !== fixed.actorId) fail('UNAVAILABLE')
  }
  async function approve(input: unknown) {
    const parsed = record(input, multi ? ['operationId', 'rowKey', 'confirmationId', 'ttlMs', 'targetRef']
      : ['operationId', 'rowKey', 'confirmationId', 'ttlMs'], ['operationId', 'rowKey', 'confirmationId'])
    const operationId = id(parsed.operationId), rowKey = id(parsed.rowKey), confirmationId = id(parsed.confirmationId)
    const ttlMs = Object.hasOwn(parsed, 'ttlMs') ? parsed.ttlMs : MAX_TTL
    if (!Number.isInteger(ttlMs) || Number(ttlMs) < 1 || Number(ttlMs) > MAX_TTL) fail('INPUT')
    const selector = Object.hasOwn(parsed, 'targetRef') ? Object.freeze({ targetRef: id(parsed.targetRef) }) : undefined
    return transaction(async (trx, targetRef, bound, slot) => {
      const previous = await trx.query('SELECT * FROM integration_yida_send_approvals WHERE tenant_id = $1 AND owner_id = $2 AND confirmation_id = $3 FOR UPDATE',
        [fixed.tenantId, fixed.actorId, confirmationId])
      if (previous.rows.length > 1) fail('UNAVAILABLE')
      if (previous.rows.length) {
        const old = checkGrant(previous.rows[0], targetRef)
        if (old.operation_id !== operationId || old.row_key !== rowKey || old.ttl_ms !== ttlMs) fail('CONFLICT')
        return Object.freeze({ ...await metadata(trx, old), reused: true })
      }
      // Recover an already committed confirmation even when its material has
      // since expired or been revoked. This returns history, not a new permit;
      // a fresh approval and first admission still authenticate current state.
      const selected = await selection(trx, targetRef, operationId, rowKey, bound)
      const window = await trx.query(`WITH instant AS MATERIALIZED
        (SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS at_ms)
        SELECT at_ms::text AS approved_at_ms, (at_ms + $1::bigint)::text AS expires_at_ms FROM instant`, [ttlMs])
      if (window.rows.length !== 1) fail('UNAVAILABLE')
      const approvedAt = millis(window.rows[0].approved_at_ms), expiresAt = millis(window.rows[0].expires_at_ms), grantId = randomUUID()
      if (expiresAt - approvedAt !== ttlMs) fail('UNAVAILABLE')
      const executionDigest = digest(await primitives.executionPayloadDigest(selected, { grantRef: grantId, expiresAt, actorId: fixed.actorId }))
      // Gate 4: refuse before the grant row (and its sealed snapshot) exists.
      assertSendBudget(selected, { grantRef: grantId, expiresAt, actorId: fixed.actorId })
      // D20, then the early identity rejection (§3.3), then the D21 re-authorization: all before any grant row exists.
      assertBindingRequired(selected, targetRef, slot)
      await assertIdentityFree(trx, selected, targetRef)
      await reauthorize(trx, selected)
      // P1: the first approval with a generated entry seals the target's generated layout; another layout is refused here.
      await sealGeneratedLayout(trx, selected, 'approve')
      const row: Row = { grant_id: grantId, confirmation_id: confirmationId, tenant_id: fixed.tenantId, workspace_id: null,
        owner_id: fixed.actorId, target_ref: targetRef, operation_id: operationId, row_key: rowKey, target_revision: selected.targetRevision,
        plan_revision: selected.planRevision, plan_digest: selected.planDigest, credential_ref: selected.credentialRef,
        credential_generation: selected.credentialGeneration, business_key_digest: selected.businessKeyDigest,
        row_payload_digest: selected.rowPayloadDigest, execution_payload_digest: executionDigest,
        source_record_digest: selected.sourceRecordDigest, creation_identity_digest: selected.creationIdentityDigest,
        ttl_ms: ttlMs, approved_at_ms: approvedAt, expires_at_ms: expiresAt, max_attempts: 1 }
      row.snapshot_encrypted = cipher(await security.encrypt(canonical(envelope(row, selected))))
      const result = await trx.query(`INSERT INTO integration_yida_send_approvals
        (grant_id, confirmation_id, tenant_id, workspace_id, owner_id, target_ref, operation_id, row_key,
         target_revision, plan_revision, plan_digest, credential_ref, credential_generation, business_key_digest,
         row_payload_digest, execution_payload_digest, source_record_digest, creation_identity_digest,
         ttl_ms, approved_at_ms, expires_at_ms, max_attempts, snapshot_encrypted)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`, Object.values(row))
      if (result.rows.length !== 1) fail('UNAVAILABLE')
      const inserted = checkGrant(result.rows[0], targetRef)
      if (Object.entries(row).some(([key, value]) => ['approved_at_ms', 'expires_at_ms'].includes(key)
        ? millis(inserted[key]) !== value : inserted[key] !== value)) fail('UNAVAILABLE')
      await audit(trx, grantId, 'approve')
      return Object.freeze({ ...await metadata(trx, inserted), reused: false })
    }, noCheckpoint, selector, true)
  }
  async function inspect(input: unknown) {
    const grantId = id(record(input, ['grantId']).grantId)
    return transaction(async (trx, targetRef) => metadata(trx, await grant(trx, targetRef, grantId)), noCheckpoint, grantSelector(grantId))
  }
  async function revoke(input: unknown) {
    const grantId = id(record(input, ['grantId']).grantId)
    return transaction(async (trx, targetRef) => {
      const row = await grant(trx, targetRef, grantId), { revocation } = await facts(trx, row)
      if (!revocation) {
        const result = await trx.query('INSERT INTO integration_yida_send_revocations (id, grant_id, actor_id) VALUES ($1, $2, $3) RETURNING id, grant_id, actor_id',
          [randomUUID(), grantId, fixed.actorId])
        if (result.rows.length !== 1 || result.rows[0].grant_id !== grantId || result.rows[0].actor_id !== fixed.actorId) fail('UNAVAILABLE')
        await audit(trx, grantId, 'revoke')
      }
      return Object.freeze({ ...await metadata(trx, row), reused: Boolean(revocation) })
    }, noCheckpoint, grantSelector(grantId))
  }
  function grantAnchor(row: Row): Readonly<Row> {
    return Object.freeze(Object.fromEntries(GRANT_ANCHOR_KEYS.map(key => [key,
      key === 'approved_at_ms' || key === 'expires_at_ms' ? millis(row[key]) : row[key]])))
  }
  async function persistAdmission(input: unknown): Promise<{ approval: ApprovalResult; anchor: ExecutionAnchor | null }> {
    const parsed = record(input, ['grantId', 'submissionId']), grantId = id(parsed.grantId), submissionId = id(parsed.submissionId)
    return transaction(async (trx, targetRef, bound, slot) => {
      const row = await grant(trx, targetRef, grantId), state = await facts(trx, row)
      if (state.admission) {
        if (state.admission.submission_id !== submissionId) fail('CONFLICT')
        // Historical observation only: never re-resolve or release a second permit.
        return { approval: Object.freeze({ ...await metadata(trx, row), reused: true }), anchor: null }
      }
      if (state.revocation) fail('REVOKED')
      if (await now(trx) >= millis(row.expires_at_ms)) fail('EXPIRED')
      const { selected, executionDigest } = await authenticatedSelection(trx, targetRef, row, noCheckpoint, bound)
      // Gate 4: refuse before the ledger row (the permanent business-key fence) is prepared. The grant
      // stays approved with its one attempt; nothing is revoked or consumed (owner choice h1).
      assertSendBudget(selected, { grantRef: id(row.grant_id), expiresAt: millis(row.expires_at_ms), actorId: fixed.actorId })
      // D20 again at admission: the grant's target still requires a binding, and the sealed selection's digests
      // must be the grant row's own (both covered by the execution digest compared above).
      assertBindingRequired(selected, targetRef, slot)
      if (selected.sourceRecordDigest !== optionalDigest(row.source_record_digest)
        || selected.creationIdentityDigest !== optionalDigest(row.creation_identity_digest)) fail('CONFLICT')
      // D21: the four checks, inside THIS transaction, before the ledger row (the admission's first write).
      await reauthorize(trx, selected)
      // P1: the sealed generated layout again at admission (sealed here if no approval sealed it yet).
      await sealGeneratedLayout(trx, selected, 'admit')
      const prepared = await primitives.prepareInTransaction(trx, { tenantId: fixed.tenantId, workspaceId: null,
        ownerId: fixed.actorId, operationId: selected.operationId, rowKey: selected.rowKey, targetRef,
        targetRevision: selected.targetRevision, planRevision: selected.planRevision, credentialRef: selected.credentialRef,
        credentialGeneration: selected.credentialGeneration, businessKeyDigest: selected.businessKeyDigest,
        payloadDigest: executionDigest, intent: 'create',
        sourceRecordDigest: selected.sourceRecordDigest, creationIdentityDigest: selected.creationIdentityDigest,
        sourceBinding: selected.sourceBinding })
      if (prepared.reused !== false) fail('CONFLICT')
      const ledger = prepared.record
      if (!ledger || ledger.tenantId !== fixed.tenantId || ledger.workspaceId !== null || ledger.ownerId !== fixed.actorId
        || ledger.operationId !== row.operation_id || ledger.rowKey !== row.row_key || ledger.intent !== 'create'
        || ledger.status !== 'prepared') fail('UNAVAILABLE')
      const admittedAt = await now(trx)
      if (admittedAt >= millis(row.expires_at_ms)) fail('EXPIRED')
      const result = await trx.query(`INSERT INTO integration_yida_send_admissions
        (id, grant_id, ledger_id, submission_id, actor_id, admitted_at_ms) VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, grant_id, ledger_id, submission_id, actor_id, admitted_at_ms`,
      [randomUUID(), grantId, id(ledger.id), submissionId, fixed.actorId, admittedAt])
      if (result.rows.length !== 1 || result.rows[0].grant_id !== grantId || result.rows[0].ledger_id !== ledger.id
        || result.rows[0].submission_id !== submissionId || result.rows[0].actor_id !== fixed.actorId
        || millis(result.rows[0].admitted_at_ms) !== admittedAt) fail('UNAVAILABLE')
      await audit(trx, grantId, 'admit')
      const approval = Object.freeze({ ...await metadata(trx, row), reused: false })
      const admissionId = id(result.rows[0].id), ledgerId = id(ledger.id)
      if (approval.status !== 'admitted' || approval.admissionId !== admissionId || approval.ledgerId !== ledgerId) fail('UNAVAILABLE')
      return { approval, anchor: Object.freeze({ grantId, admissionId, submissionId, ledgerId, grant: grantAnchor(row) }) }
    }, noCheckpoint, grantSelector(grantId), true)
  }
  async function admit(input: unknown): Promise<ApprovalResult> {
    // A public admission never inserts anything into the execution-permit map.
    return (await persistAdmission(input)).approval
  }
  async function delivery(trx: Queryable, row: Row, admission: Row, expectedStatus?: 'prepared' | 'dispatching') {
    const result = await trx.query('SELECT * FROM integration_yida_delivery_ledger WHERE id = $1 FOR UPDATE', [admission.ledger_id])
    if (result.rows.length !== 1) fail('UNAVAILABLE')
    const ledger = result.rows[0]
    const expected: Row = { id: admission.ledger_id, tenant_id: fixed.tenantId, workspace_id: null, owner_id: fixed.actorId,
      operation_id: row.operation_id, row_key: row.row_key, target_ref: row.target_ref,
      target_revision: row.target_revision, plan_revision: row.plan_revision, credential_ref: row.credential_ref,
      credential_generation: row.credential_generation, business_key_digest: row.business_key_digest,
      payload_digest: row.execution_payload_digest, intent: 'create', instance_id: null,
      source_record_digest: row.source_record_digest ?? null, creation_identity_digest: row.creation_identity_digest ?? null }
    if (Object.entries(expected).some(([key, value]) => ledger[key] !== value)) fail('CONFLICT')
    if (typeof ledger.status !== 'string'
      || !['prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'not_sent'].includes(ledger.status)) fail('UNAVAILABLE')
    if (expectedStatus && ledger.status !== expectedStatus) fail('CONFLICT')
    if (ledger.status === 'prepared' || ledger.status === 'not_sent') {
      if (ledger.claim_token !== null || ledger.claim_actor_id !== null) fail('CONFLICT')
    } else if (ledger.claim_actor_id !== fixed.actorId || typeof ledger.claim_token !== 'string'
      || !DIGEST.test(ledger.claim_token)) fail('CONFLICT')
    return ledger
  }
  async function observe(input: unknown) {
    const grantId = id(record(input, ['grantId']).grantId)
    return transaction(async (trx, targetRef) => {
      const row = await grant(trx, targetRef, grantId), { admission } = await facts(trx, row)
      const ledger = admission ? await delivery(trx, row, admission) : null
      return Object.freeze({ approval: await metadata(trx, row),
        delivery: ledger ? Object.freeze({ id: id(ledger.id), status: ledger.status as string, durable: true as const }) : null })
    }, noCheckpoint, grantSelector(grantId))
  }
  async function prepareDraft(input: unknown): Promise<Readonly<Row>> {
    // A source binding rides only on a sheet-source path: multi-target (D17 a) or, with the sheet-source switch, the
    // single-target slot 1 (D17 b, never a targetRef). Its closed shape is the plugin compiler's. Under the original
    // single-target authority with the sheet-source switch off the key itself is refused.
    const supplied = record(input, multi ? ['config', 'rowsText', 'allocation', 'targetRef', 'sourceBinding']
      : sheetSourceOnly ? ['config', 'rowsText', 'allocation', 'sourceBinding'] : ['config', 'rowsText', 'allocation'],
    ['config', 'rowsText', 'allocation'])
    const selector = Object.hasOwn(supplied, 'targetRef') ? Object.freeze({ targetRef: id(supplied.targetRef) }) : undefined
    const withBinding = Object.hasOwn(supplied, 'sourceBinding')
    const parsed = record({ config: supplied.config, rowsText: supplied.rowsText, allocation: supplied.allocation,
      ...(withBinding ? { sourceBinding: supplied.sourceBinding } : {}) },
    withBinding ? ['config', 'rowsText', 'allocation', 'sourceBinding'] : ['config', 'rowsText', 'allocation'])
    // Literal data only, never a source/Connection reference or a query port.
    // The actual plugin compiler applies its tighter input/row budgets too.
    canonical(parsed)
    if (!executionPrimitives?.prepareDraftInTransaction || typeof executionPrimitives.draftSendBudget !== 'function') fail('UNAVAILABLE')
    return transaction(async (trx, targetRef, bound) => {
      // R-71 ⑦.3 decision C1: a draft the shared send budget would refuse at approval is refused
      // here (LIMIT, 422), before any draft row is written; the transaction rolls back.
      assertBudgetVerdict(executionPrimitives.draftSendBudget!(parsed))
      const result = await executionPrimitives.prepareDraftInTransaction!(trx, targeted(parsed, targetRef, bound))
      const view = record(result, ['targetRef', 'operationId', 'status', 'identityKind', 'canSend', 'canApply',
        'tokenIssued', 'externalWriteAttempted', 'rowCount', 'rows', 'reused'])
      if (!Object.isFrozen(result) || view.status !== 'unverified' || view.identityKind !== 'local-unverified'
        || view.canSend !== false || view.canApply !== false || view.tokenIssued !== false
        || view.externalWriteAttempted !== false || typeof view.reused !== 'boolean'
        || !Array.isArray(view.rows) || view.rows.length < 1 || view.rows.length > 100 || view.rowCount !== view.rows.length) fail('UNAVAILABLE')
      id(view.targetRef); id(view.operationId)
      const keys = new Set<string>()
      view.rows.forEach((item, index) => {
        const row = record(item, ['rowKey', 'index']), key = id(row.rowKey)
        if (row.index !== index || keys.has(key)) fail('UNAVAILABLE')
        keys.add(key)
      })
      canonical(result)
      return result
    }, noCheckpoint, selector)
  }
  // Y2 sheet source: the same live-actor + owner/target proof prepareDraft runs first (same transaction
  // path, same refusals), done BEFORE the host reads any sheet row. It writes nothing and returns no data;
  // prepareDraft still proves everything again in its own transaction.
  async function proveDraftTarget(input: unknown): Promise<Readonly<{ proven: true }>> {
    const supplied = record(input, multi ? ['targetRef'] : [], [])
    const selector = Object.hasOwn(supplied, 'targetRef') ? Object.freeze({ targetRef: id(supplied.targetRef) }) : undefined
    if (!executionPrimitives?.prepareDraftInTransaction) fail('UNAVAILABLE')
    return transaction(async () => Object.freeze({ proven: true as const }), noCheckpoint, selector)
  }
  async function preview(input: unknown): Promise<Readonly<Row>> {
    const parsed = record(input, multi ? ['operationId', 'rowKey', 'targetRef'] : ['operationId', 'rowKey'], ['operationId', 'rowKey'])
    const operationId = id(parsed.operationId), rowKey = id(parsed.rowKey)
    const selector = Object.hasOwn(parsed, 'targetRef') ? Object.freeze({ targetRef: id(parsed.targetRef) }) : undefined
    if (!executionPrimitives?.previewInTransaction) fail('UNAVAILABLE')
    return transaction(async (trx, targetRef, bound) => {
      await assertOperationTarget(trx, bound, operationId)
      const result = await executionPrimitives.previewInTransaction!(trx, targeted({ operationId, rowKey }, targetRef, bound))
      const view = record(result, ['operationId', 'rowKey', 'planDigest', 'rowPayloadDigest', 'target', 'payload',
        'policy', 'canSend', 'externalWriteAttempted'])
      const target = record(view.target, ['targetRef', 'identityKind', 'evidenceVersion', 'reviewRef', 'organizationId', 'appType', 'formUuid'])
      const policy = record(view.policy, ['intent', 'maxAttempts', 'maxTtlMs', 'requiresExplicitConfirmation', 'unknownMustNotRetry'])
      if (!Object.isFrozen(result) || view.operationId !== operationId || view.rowKey !== rowKey
        || view.canSend !== false || view.externalWriteAttempted !== false || target.targetRef !== targetRef
        || target.identityKind !== 'owner-attested-single-target' || target.evidenceVersion !== 1
        || policy.intent !== 'create' || policy.maxAttempts !== 1 || policy.maxTtlMs !== MAX_TTL
        || policy.requiresExplicitConfirmation !== true || policy.unknownMustNotRetry !== true) fail('UNAVAILABLE')
      digest(view.planDigest); digest(view.rowPayloadDigest)
      for (const key of ['targetRef', 'reviewRef', 'organizationId', 'appType', 'formUuid']) id(target[key])
      if (!view.payload || typeof view.payload !== 'object' || Array.isArray(view.payload)
        || types.isProxy(view.payload) || !Object.isFrozen(view.payload)) fail('UNAVAILABLE')
      canonical(result)
      return result
    }, noCheckpoint, selector)
  }
  const permits = new WeakMap<object, ExecutionAnchor>()
  async function admitForExecution(input: unknown) {
    if (!executionPrimitives) fail('UNAVAILABLE')
    // No permit exists while BEGIN/prepare/audit/COMMIT is pending, or when the
    // COMMIT response is lost. Historical recovery never recreates a permit.
    const { approval, anchor } = await persistAdmission(input)
    if (!anchor || approval.reused) return Object.freeze({ approval, permit: null })
    const permit = Object.freeze({})
    permits.set(permit, anchor)
    return Object.freeze({ approval, permit })
  }
  async function authenticatedExecution(anchor: ExecutionAnchor, expectedStatus: 'prepared' | 'dispatching', checkpoint: Checkpoint) {
    if (!executionPrimitives) fail('UNAVAILABLE')
    return transaction(async (trx, targetRef, bound) => {
      const row = await checked(checkpoint, () => grant(trx, targetRef, anchor.grantId))
      const currentAnchor = grantAnchor(row)
      if (GRANT_ANCHOR_KEYS.some(key => currentAnchor[key] !== anchor.grant[key])) fail('CONFLICT')
      const state = await checked(checkpoint, () => facts(trx, row))
      if (!state.admission || state.admission.id !== anchor.admissionId || state.admission.ledger_id !== anchor.ledgerId
        || state.admission.submission_id !== anchor.submissionId) fail('CONFLICT')
      if (state.revocation) fail('REVOKED')
      if (await checked(checkpoint, () => now(trx)) >= millis(row.expires_at_ms)) fail('EXPIRED')
      const { selected } = await authenticatedSelection(trx, targetRef, row, checkpoint, bound)
      const raw = await checked(checkpoint, () => executionPrimitives.loadExecutionMaterialInTransaction(trx,
        targeted({ credentialRef: selected.credentialRef, credentialGeneration: selected.credentialGeneration }, targetRef, bound)))
      const material = record(raw, [...BINDING_KEYS, 'appKey', 'appSecret', 'systemToken', 'userId'])
      const expectedBinding = { tenantId: fixed.tenantId, workspaceId: null, ownerId: fixed.actorId,
        credentialRef: selected.credentialRef, credentialGeneration: selected.credentialGeneration }
      if (BINDING_KEYS.some(key => material[key] !== expectedBinding[key])) fail('CONFLICT')
      for (const key of ['appKey', 'appSecret', 'systemToken', 'userId']) {
        const text = material[key]
        if (typeof text !== 'string' || !text || text.length > (key === 'userId' ? 128 : 4096)) fail('UNAVAILABLE')
      }
      await checked(checkpoint, () => delivery(trx, row, state.admission!, expectedStatus))
      if (await checked(checkpoint, () => now(trx)) >= millis(row.expires_at_ms)) fail('EXPIRED')
      checkpoint()
      return { row, selected, material }
    }, checkpoint, grantSelector(anchor.grantId))
  }
  function takeExecution(permit: unknown): YidaSendExecutionHandle {
    const found = permits.get(permit as object)
    if (!found) fail('CONFLICT')
    const anchor: ExecutionAnchor = found
    // Synchronous consumption precedes construction and every possible await.
    permits.delete(permit as object)
    const executionContext = Object.freeze({ ...fixed, ownerId: fixed.actorId })
    const operation = Object.freeze({ operationId: id(anchor.grant.operation_id), rowKey: id(anchor.grant.row_key) })
    const credentialBinding = Object.freeze({ tenantId: fixed.tenantId, workspaceId: null, ownerId: fixed.actorId,
      credentialRef: id(anchor.grant.credential_ref), credentialGeneration: Number(anchor.grant.credential_generation) })
    const identity = Object.freeze({ ...executionContext, ...operation })
    let closed = false, busy = false, resolutions = 0, loads = 0
    function check(signal: AbortSignal | undefined) {
      if (closed) fail('CONFLICT')
      if (signal && abortedGetter.call(signal)) fail('CANCELLED')
    }
    async function resolveExecutionSnapshot(input: unknown, options: unknown = {}): Promise<Readonly<Row>> {
      let ownsBusy = false
      try {
        const requested = record(input, IDENTITY_KEYS), signal = callerSignal(options)
        const checkpoint = () => check(signal)
        checkpoint()
        if (IDENTITY_KEYS.some(key => requested[key] !== identity[key]) || busy || resolutions >= 3
          || (resolutions === 1 && loads < 1)) fail('CONFLICT')
        busy = true; ownsBusy = true
        const ordinal = ++resolutions
        const { row, selected, material } = await checked(checkpoint,
          () => authenticatedExecution(anchor, ordinal === 3 ? 'dispatching' : 'prepared', checkpoint))
        checkpoint()
        return Object.freeze({ ...identity, grantRef: anchor.grantId, expiresAt: millis(row.expires_at_ms),
          targetRef: selected.targetRef, targetRevision: selected.targetRevision, planRevision: selected.planRevision,
          credentialRef: selected.credentialRef, credentialGeneration: selected.credentialGeneration,
          sourceRecordDigest: selected.sourceRecordDigest, creationIdentityDigest: selected.creationIdentityDigest,
          config: selected.config, row: selected.selectedRow, systemToken: material.systemToken, userId: material.userId })
      } catch (error) { closed = true; return closeError(error) }
      finally { if (ownsBusy) busy = false }
    }
    async function loadCredential(input: unknown, options: unknown = {}) {
      let ownsBusy = false
      try {
        const requested = record(input, BINDING_KEYS), signal = callerSignal(options)
        const checkpoint = () => check(signal)
        checkpoint()
        if (BINDING_KEYS.some(key => requested[key] !== credentialBinding[key]) || busy || resolutions !== 1 || loads >= 2) fail('CONFLICT')
        busy = true; ownsBusy = true; loads++
        const { material } = await checked(checkpoint, () => authenticatedExecution(anchor, 'prepared', checkpoint))
        checkpoint()
        // Token material only; full execution material never crosses this port.
        return Object.freeze({ ...credentialBinding, appKey: material.appKey as string, appSecret: material.appSecret as string })
      } catch (error) { closed = true; return closeError(error) }
      finally { if (ownsBusy) busy = false }
    }
    function close() { closed = true }
    return Object.freeze({ context: executionContext, operation, credentialBinding, resolveExecutionSnapshot, loadCredential, close })
  }
  const approvals = Object.freeze({ approve, inspect, revoke, admit })
  return Object.freeze({ approvals, admitForExecution, takeExecution, observe, prepareDraft, proveDraftTarget, preview })
}

export function createYidaSendApprovalService(dependencies: Dependencies) {
  return createApprovalInternals(dependencies).approvals
}

export function createInternalYidaSendExecutionAuthority(dependencies: YidaSendExecutionDependencies) {
  try {
    if (!dependencies?.primitives || typeof dependencies.primitives.loadExecutionMaterialInTransaction !== 'function') fail('UNAVAILABLE')
    return createApprovalInternals(dependencies, dependencies.primitives)
  } catch (error) { closeError(error) }
}
