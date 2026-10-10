import { types } from 'node:util'
import type { Queryable } from '../multitable/automation-durable-dispatcher'
import { assertAutomationIntegrationActor, AutomationActorAuthorityError } from './automation-live-authority'
import {
  YidaInitializationError, closeYidaInitializationError, lockYidaInitializationSlot,
  type YidaInitializationDatabase, yidaInitializationErrorCode,
} from './yida-initialization-bootstrap'

export { YidaInitializationError, yidaInitializationErrorCode } from './yida-initialization-bootstrap'
export type YidaInitializationActor = Readonly<{ actorId: string; tenantId: string; workspaceId: null }>
export type YidaInitializationInput = Readonly<{ commandId: string; material: unknown; draft: unknown; attestation: unknown }>
type Row = Record<string, unknown>
export type YidaInitializationDraft = Readonly<{
  targetRef: string; operationId: string; status: 'unverified'; identityKind: 'local-unverified';
  canSend: false; canApply: false; tokenIssued: false; externalWriteAttempted: false;
  rowCount: number; rows: readonly Readonly<{ rowKey: string; index: number }>[]; reused: boolean
}>
export type YidaInitializationView = Readonly<{
  commandId: string; status: 'ready' | 'initialized'; draft: YidaInitializationDraft | null;
  canSend: false; tokenIssued: false; externalWriteAttempted: false
}>
export type YidaInitializationProducer = Readonly<{
  initializeInTransaction(trx: Queryable, input: YidaInitializationInput): Promise<{
    draft: unknown; credentialRef: string; credentialGeneration: number; targetRef: string
  }>
  inspectDraftInTransaction(trx: Queryable, input: { operationId: string }): Promise<unknown>
}>
export type YidaInitializationRuntimeBinding = Readonly<{
  createInitializationProducer(context: YidaInitializationActor): YidaInitializationProducer
}>
export type YidaInitializationRuntimeDependencies = {
  database: YidaInitializationDatabase
  security: { encrypt(value: string): Promise<string>; decrypt(value: string): Promise<string> }
}
const abortGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!
const addListener = EventTarget.prototype.addEventListener, removeListener = EventTarget.prototype.removeEventListener
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
function fail(code: ConstructorParameters<typeof YidaInitializationError>[0]): never { throw new YidaInitializationError(code) }
function record(value: unknown, keys: readonly string[], required = keys): Row {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INPUT')
  const properties = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(properties).some(key => typeof key !== 'string' || !keys.includes(key))
    || required.some(key => !Object.hasOwn(properties, key))) fail('INPUT')
  const result: Row = Object.create(null)
  for (const key of Object.keys(properties)) {
    const property = properties[key]
    if (!property.enumerable || !Object.hasOwn(property, 'value')) fail('INPUT')
    result[key] = property.value
  }
  return result
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || value.trim() !== value
    || /[\u0000-\u001f\u007f]/u.test(value)) fail('INPUT')
  return value
}
function command(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) fail('INPUT'); return value }
function captureActor(value: unknown): YidaInitializationActor {
  const row = record(value, ['actorId', 'tenantId', 'workspaceId'])
  if (row.workspaceId !== null) fail('INPUT')
  return Object.freeze({ actorId: id(row.actorId), tenantId: id(row.tenantId), workspaceId: null })
}
function snapshot(value: unknown): unknown {
  const ancestors = new Set<object>(); let nodes = 0
  function copy(item: unknown, depth: number): unknown {
    if (++nodes > 100000 || depth > 32) fail('INPUT')
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item
    if (typeof item === 'number') { if (!Number.isFinite(item) || Object.is(item, -0)) fail('INPUT'); return item }
    if (!item || typeof item !== 'object' || types.isProxy(item) || ancestors.has(item)) fail('INPUT')
    const array = Array.isArray(item), proto = Object.getPrototypeOf(item)
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) fail('INPUT')
    const properties = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(properties)
    if (keys.some(key => typeof key !== 'string')) fail('INPUT')
    ancestors.add(item)
    let copied: unknown
    if (array) {
      if (keys.length !== item.length + 1 || item.length > 100000) fail('INPUT')
      copied = Object.freeze(Array.from({ length: item.length }, (_, index) => {
        const property = properties[String(index)]
        if (!property?.enumerable || !Object.hasOwn(property, 'value')) fail('INPUT')
        return copy(property.value, depth + 1)
      }))
    } else {
      const result: Row = {}
      for (const key of keys as string[]) {
        const property = properties[key]
        if (!property.enumerable || !Object.hasOwn(property, 'value')) fail('INPUT')
        Object.defineProperty(result, key, { value: copy(property.value, depth + 1), enumerable: true })
      }
      copied = Object.freeze(result)
    }
    ancestors.delete(item); return copied
  }
  const copied = copy(value, 0)
  if (Buffer.byteLength(JSON.stringify(copied), 'utf8') > 192 * 1024) fail('INPUT')
  return copied
}
function captureInput(value: unknown): YidaInitializationInput {
  const row = record(value, ['commandId', 'material', 'draft', 'attestation'])
  const material = record(row.material, ['appKey', 'appSecret', 'systemToken', 'userId'])
  for (const key of Object.keys(material)) if (typeof material[key] !== 'string' || !material[key].trim()
    || material[key].length > (key === 'userId' ? 128 : 4096)) fail('INPUT')
  const draft = record(row.draft, ['config', 'rowsText', 'allocation'])
  if (typeof draft.rowsText !== 'string' || Buffer.byteLength(draft.rowsText, 'utf8') > 128 * 1024) fail('INPUT')
  const attestation = record(row.attestation, ['kind', 'reviewRef', 'organizationId', 'executionIdentity'])
  if (attestation.kind !== 'owner-reviewed-target' || attestation.executionIdentity !== material.userId) fail('INPUT')
  for (const key of ['reviewRef', 'organizationId', 'executionIdentity']) id(attestation[key])
  return snapshot({ commandId: command(row.commandId), material, draft, attestation }) as YidaInitializationInput
}
function signal(value: unknown): AbortSignal | undefined {
  const parsed = record(value, ['signal'], [])
  if (parsed.signal === undefined) return undefined
  if (!parsed.signal || typeof parsed.signal !== 'object' || types.isProxy(parsed.signal)
    || Object.getPrototypeOf(parsed.signal) !== AbortSignal.prototype) fail('INPUT')
  try { abortGetter.call(parsed.signal) } catch { fail('INPUT') }
  return parsed.signal as AbortSignal
}
function draftView(value: unknown): YidaInitializationDraft {
  try {
    const row = record(value, ['targetRef', 'operationId', 'status', 'identityKind', 'canSend', 'canApply',
      'tokenIssued', 'externalWriteAttempted', 'rowCount', 'rows', 'reused'])
    if (row.status !== 'unverified' || row.identityKind !== 'local-unverified' || row.canSend !== false
      || row.canApply !== false || row.tokenIssued !== false || row.externalWriteAttempted !== false
      || typeof row.reused !== 'boolean' || !Array.isArray(row.rows) || row.rows.length < 1 || row.rows.length > 100
      || row.rowCount !== row.rows.length) fail('UNAVAILABLE')
    const members = row.rows.map((value, index) => {
      const member = record(value, ['rowKey', 'index'])
      if (member.index !== index) fail('UNAVAILABLE')
      return Object.freeze({ rowKey: command(member.rowKey), index })
    })
    if (new Set(members.map(member => member.rowKey)).size !== members.length) fail('UNAVAILABLE')
    return Object.freeze({ ...row, targetRef: command(row.targetRef), operationId: command(row.operationId), rows: Object.freeze(members) }) as YidaInitializationDraft
  } catch { fail('UNAVAILABLE') }
}
function view(commandId: string, draft: YidaInitializationDraft | null): YidaInitializationView {
  return Object.freeze({ commandId, status: draft === null ? 'ready' : 'initialized', draft,
    canSend: false, tokenIssued: false, externalWriteAttempted: false })
}
type Run = { controller: AbortController; pending: Promise<unknown>; dependencies: Set<Promise<unknown>> }
type Registration = { closed: boolean; createProducer: YidaInitializationRuntimeBinding['createInitializationProducer']; runs: Set<Run>; draining?: Promise<void> }

/** Local configuration authority. No enablement read, send authority, grant, token or fetch. */
export function createYidaInitializationRuntime(dependencies: YidaInitializationRuntimeDependencies) {
  if (!dependencies?.database || typeof dependencies.database.transaction !== 'function'
    || !dependencies.security || typeof dependencies.security.encrypt !== 'function' || typeof dependencies.security.decrypt !== 'function') fail('UNAVAILABLE')
  const transaction = dependencies.database.transaction.bind(dependencies.database) as YidaInitializationDatabase['transaction']
  let active: Registration | undefined, generation = 0, terminal = false, terminalDrain: Promise<void> | undefined
  function drain(state: Registration): Promise<void> {
    state.closed = true
    for (const run of state.runs) run.controller.abort()
    return state.draining ??= Promise.allSettled([...state.runs].map(run => run.pending)).then(() => { if (active === state) active = undefined })
  }
  function execute(actorInput: unknown, supplied: unknown, options: unknown, initializing = false): Promise<YidaInitializationView> {
    try {
      // Capture immutable caller data synchronously, before any await/dependency.
      const actor = captureActor(actorInput), input = initializing ? captureInput(supplied) : undefined, caller = signal(options), state = active
      if (terminal || !state || state.closed) fail('INACTIVE')
      if (caller && abortGetter.call(caller)) fail('CANCELLED')
      if (state.runs.size >= 32) fail('UNAVAILABLE')
      const controller = new AbortController(), abort = () => controller.abort()
      if (caller) addListener.call(caller, 'abort', abort, { once: true })
      const checkpoint = () => {
        if (abortGetter.call(controller.signal) || caller && abortGetter.call(caller)) fail('CANCELLED')
        if (terminal || state.closed || active !== state) fail('INACTIVE')
      }
      const run: Run = { controller, pending: undefined!, dependencies: new Set() }
      state.runs.add(run)
      async function checked<T>(operation: () => Promise<T>): Promise<T> {
        checkpoint(); const pending = operation(); run.dependencies.add(pending)
        try { const result = await pending; checkpoint(); return result }
        finally { run.dependencies.delete(pending) }
      }
      run.pending = Promise.resolve().then(async () => {
        try {
          checkpoint()
          const result = await checked(() => transaction(async raw => {
            const trx: Queryable = Object.freeze({ query: (sql: string, params?: unknown[]) => checked(() => raw.query(sql, params)) })
            // The trusted provider pins RC before this function. Actual PG probes
            // reject transaction-marker forgery/autocommit, not just a TS marker.
            try { await checked(() => assertAutomationIntegrationActor(trx, actor)) }
            catch (error) {
              checkpoint()
              if (error && typeof error === 'object' && !types.isProxy(error)
                && Object.getPrototypeOf(error) === AutomationActorAuthorityError.prototype
                && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'AUTOMATION_ACTOR_AUTHORITY_DENIED') fail('DENIED')
              fail('UNAVAILABLE')
            }
            await checked(() => lockYidaInitializationSlot(trx))
            const anchors = await trx.query('SELECT slot,command_id,owner_id,tenant_id,workspace_id FROM integration_yida_initialization_anchor WHERE slot=1')
            const anchor = anchors.rows[0]
            if (anchors.rows.length !== 1 || anchor.slot !== 1 || anchor.workspace_id !== null) fail('UNAVAILABLE')
            let commandId: string
            try { commandId = command(anchor.command_id) } catch { fail('UNAVAILABLE') }
            if (anchor.owner_id !== actor.actorId || anchor.tenant_id !== actor.tenantId) fail('DENIED')
            if (input && input.commandId !== commandId) fail('CONFLICT')
            function producer() {
              checkpoint()
              const captured = record(state.createProducer(actor), ['initializeInTransaction', 'inspectDraftInTransaction'])
              for (const method of Object.values(captured)) if (typeof method !== 'function' || types.isProxy(method)) fail('UNAVAILABLE')
              checkpoint()
              return { initialize: captured.initializeInTransaction as YidaInitializationProducer['initializeInTransaction'],
                inspect: captured.inspectDraftInTransaction as YidaInitializationProducer['inspectDraftInTransaction'] }
            }
            async function stateRows() {
              const results = await trx.query('SELECT * FROM integration_yida_initializations WHERE slot=1')
              const targets = await trx.query('SELECT slot,target_ref,tenant_id,workspace_id,owner_id,operation_id,draft_target_ref,credential_ref,credential_generation,evidence_version,status FROM integration_yida_approved_target WHERE slot=1')
              if (results.rows.length > 1 || targets.rows.length > 1) fail('UNAVAILABLE')
              return { result: results.rows[0], target: targets.rows[0] }
            }
            async function validate(result: Row, target: Row, draft: YidaInitializationDraft) {
              if (result.slot !== 1 || result.command_id !== commandId || result.owner_id !== actor.actorId || result.tenant_id !== actor.tenantId
                || result.workspace_id !== null || target.slot !== 1 || target.owner_id !== actor.actorId || target.tenant_id !== actor.tenantId
                || target.workspace_id !== null || target.status !== 'manually_confirmed' || target.evidence_version !== 1
                || result.target_ref !== target.target_ref || result.operation_id !== target.operation_id || result.credential_ref !== target.credential_ref
                || result.credential_generation !== 1 || target.credential_generation !== 1 || draft.operationId !== result.operation_id
                || draft.targetRef !== target.draft_target_ref) fail('UNAVAILABLE')
              const material = await trx.query('SELECT tenant_id,workspace_id,owner_id,generation,status FROM integration_yida_credential_materials WHERE credential_ref=$1', [result.credential_ref])
              const operation = await trx.query(`SELECT t.tenant_id,t.workspace_id,t.owner_id,o.target_ref,o.row_count,
                o.status AS operation_status,t.status AS target_status
                FROM integration_yida_draft_operations o JOIN integration_yida_draft_targets t ON t.target_ref=o.target_ref
                WHERE o.operation_id=$1`, [result.operation_id])
              for (const selected of [material, operation]) if (selected.rows.length !== 1 || selected.rows[0].tenant_id !== actor.tenantId
                || selected.rows[0].workspace_id !== null || selected.rows[0].owner_id !== actor.actorId) fail('UNAVAILABLE')
              if (material.rows[0].generation !== 1 || material.rows[0].status !== 'current' || operation.rows[0].target_ref !== draft.targetRef
                || operation.rows[0].row_count !== draft.rowCount || operation.rows[0].operation_status !== 'unverified'
                || operation.rows[0].target_status !== 'unverified') fail('UNAVAILABLE')
              const members = await trx.query('SELECT row_key,ordinal FROM integration_yida_draft_rows WHERE operation_id=$1 ORDER BY ordinal', [result.operation_id])
              if (members.rows.length !== draft.rows.length || members.rows.some((member, index) => member.row_key !== draft.rows[index].rowKey
                || member.ordinal !== draft.rows[index].index)) fail('UNAVAILABLE')
            }
            const existing = await stateRows()
            if (existing.result || existing.target) {
              if (!existing.result || !existing.target) fail('UNAVAILABLE')
              if (input) fail('CONFLICT')
              const { inspect } = producer()
              const draft = draftView(await checked(() => inspect(trx, { operationId: id(existing.result.operation_id) })))
              await validate(existing.result, existing.target, draft)
              return view(commandId, draft)
            }
            if (!input) return view(commandId, null)
            const { initialize } = producer()
            const produced = record(await checked(() => initialize(trx, input)), ['draft', 'credentialRef', 'credentialGeneration', 'targetRef'])
            const draft = draftView(produced.draft), credentialRef = id(produced.credentialRef), targetRef = id(produced.targetRef)
            if (produced.credentialGeneration !== 1) fail('UNAVAILABLE')
            // Re-read the ACTUAL slot. A fabricated producer receipt cannot seed
            // initialization state or give a nonexistent/mismatched target authority.
            const after = await stateRows()
            if (after.result || !after.target) fail('UNAVAILABLE')
            const result = { slot: 1, command_id: commandId, owner_id: actor.actorId, tenant_id: actor.tenantId, workspace_id: null,
              target_ref: targetRef, operation_id: draft.operationId, credential_ref: credentialRef, credential_generation: 1 }
            await validate(result, after.target, draft)
            const inserted = await trx.query(`INSERT INTO integration_yida_initializations
              (slot,command_id,owner_id,tenant_id,workspace_id,target_ref,operation_id,credential_ref,credential_generation)
              VALUES (1,$1,$2,$3,NULL,$4,$5,$6,1) RETURNING *`, [commandId, actor.actorId, actor.tenantId, targetRef, draft.operationId, credentialRef])
            if (inserted.rows.length !== 1 || inserted.rowCount !== 1 || Object.entries(result).some(([key, value]) => inserted.rows[0][key] !== value)) fail('UNAVAILABLE')
            checkpoint(); return view(commandId, draft)
          }))
          checkpoint()
          return result
        } catch (error) {
          // Including a COMMIT acknowledgement loss or post-COMMIT cancellation:
          // reject closed, never claim rollback/absence or retry allocation.
          try { checkpoint() } catch (control) { closeYidaInitializationError(control) }
          closeYidaInitializationError(error)
        } finally {
          try {
            while (run.dependencies.size > 0) await Promise.allSettled([...run.dependencies])
            checkpoint()
          } finally {
            controller.abort()
            if (caller) removeListener.call(caller, 'abort', abort)
            state.runs.delete(run)
          }
        }
      })
      void run.pending.catch(() => {})
      return run.pending as Promise<YidaInitializationView>
    } catch (error) {
      try { closeYidaInitializationError(error) } catch (closed) {
        const pending = Promise.reject<YidaInitializationView>(closed); void pending.catch(() => {}); return pending
      }
    }
  }
  return Object.freeze({
    createPluginCapability() {
      if (terminal) fail('INACTIVE')
      const capturedGeneration = ++generation; let used = false
      return Object.freeze({ activate(binding: YidaInitializationRuntimeBinding): Promise<Readonly<{ stop(): Promise<void> }>> {
        try {
          if (terminal || used || generation !== capturedGeneration || active) fail('INACTIVE')
          used = true
          const parsed = record(binding, ['createInitializationProducer'])
          if (typeof parsed.createInitializationProducer !== 'function' || types.isProxy(parsed.createInitializationProducer)) fail('INPUT')
          const state: Registration = { closed: false, createProducer: parsed.createInitializationProducer as Registration['createProducer'], runs: new Set() }
          active = state
          return Promise.resolve(Object.freeze({ stop() { if (active === state && !state.closed) ++generation; return drain(state) } }))
        } catch (error) { try { closeYidaInitializationError(error) } catch (closed) { const pending = Promise.reject<Readonly<{ stop(): Promise<void> }>>(closed); void pending.catch(() => {}); return pending } }
      } })
    },
    status(actor: YidaInitializationActor, options: { signal?: AbortSignal } = {}) { return execute(actor, undefined, options) },
    initialize(actor: YidaInitializationActor, input: YidaInitializationInput, options: { signal?: AbortSignal } = {}) { return execute(actor, input, options, true) },
    deactivate() { ++generation; return active ? drain(active) : Promise.resolve() },
    stop() { if (terminalDrain) return terminalDrain; terminal = true; ++generation; return terminalDrain = active ? drain(active) : Promise.resolve() },
  })
}
