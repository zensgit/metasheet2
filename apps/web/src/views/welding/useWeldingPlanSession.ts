import { computed, onScopeDispose, getCurrentScope, reactive, watch } from 'vue'
import { onAuthPrincipalChange, readAuthSessionSignature, readStoredToken, TOKEN_KEYS } from '../../composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../../utils/explicitSessionOrg'
import { createWeldingPlanClient, WeldingPlanError, validateSaveAck, validatePlan, validateRevisionAck, type WeldingPlanClient, type PlanRecord, type RecoveryAuthority, type RequestScope, type PlanCandidate, type DrawingCandidate, type WorkflowState, type RevisionAck } from '../../services/welding/planClient'
import { clone, equal, need, isObject, jsonBytes, validatePayload, openPlanRecoveryStore, validateRecovery, type PlanPayload, type PlanRecoveryRecord, type PlanRecoveryStore, type WeldingOwner } from '../../services/welding/planRecovery'
import { validateWorkflowPending, type WorkflowPending } from '../../services/welding/commandRecovery'
import { validateReuseAck, validateReuseProvenance, type ReuseAck } from '../../services/welding/planClient'
import { validateBomProjection, validateAssemblyPreview, type BomProjection, type AssemblyPreview } from '../../services/welding/planClient'
import { validateAssemblySide, validateAssemblyCancel, type AssemblySide } from '../../services/welding/planRecovery'
import { validateSourceReview, type SourceReview } from '../../services/welding/planClient'
import { validateSourcePreparation, type SourcePreparation } from '../../services/welding/planClient'
import { validateReviewResolution, type ReviewResolution } from '../../services/welding/planRecovery'

const blank = (): PlanPayload => ({ schema_version: 1, product: null, drawing: null, welds: [], process_refs: [] })
type GenerationAdmission = <T>(scope: RequestScope, mode: 'edit' | 'generation' | 'original', target: { plan_id: string; item_version_id: string | null }, action: (scope: RequestScope) => Promise<T>) => Promise<T>
export interface SourceChangePreview { point: PlanRecord; owner: WeldingOwner; payload: PlanPayload; editSeq: number; recoveryId: string; preparation: SourcePreparation }
export function useWeldingPlanSession(options: {
  client?: WeldingPlanClient; openStore?: () => Promise<PlanRecoveryStore>; writable: () => boolean
  uuid?: () => string
}) {
  const client = options.client ?? createWeldingPlanClient(), uuid = options.uuid ?? (() => crypto.randomUUID())
  const state = reactive({
    owner: null as WeldingOwner | null, planId: '', versionId: null as string | null, name: '', number: '',
    draftSeq: 0, contentHash: null as string | null, serverState: '', sources: null as Record<string, unknown> | null,
    payload: blank(), editSeq: 0, dirty: false, busy: false, blocked: false, storageBlocked: false,
    savedPoint: null as PlanRecord | null, commandBusy: false, commandPending: false, editBusy: false,
    cadBusy: false, atomicBusy: false, overlayContextId: '', historyCursor: 0, historyLength: 0,
    pending: null as PlanRecoveryRecord['pending'], uncertain: false, recoveryId: '', message: '',
    plans: [] as PlanRecord[], total: 0, offset: 0, products: [] as PlanCandidate[], drawings: [] as DrawingCandidate[],
    assemblyCandidates: [] as BomProjection[], assemblyPreview: null as { original: PlanRecoveryRecord; impact: AssemblyPreview; editSeq: number; point: PlanRecord } | null,
    recoveries: [] as PlanRecoveryRecord[], preview: null as { record: PlanRecoveryRecord; authority: RecoveryAuthority } | null,
  })
  let epoch = 0, disposed = false, controller = new AbortController(), store: PlanRecoveryStore | null = null
  let storePromise: Promise<PlanRecoveryStore> | null = null, stored: PlanRecoveryRecord | null = null
  let recoveredSavePoint: PlanRecord | null = null
  let history: Array<{ before: PlanPayload; after: PlanPayload }> = [], representedBoundary = false
  let cadBarrier: (() => Promise<void>) | null = null
  let queue: Promise<unknown> = Promise.resolve()
  let editing: Promise<void> = Promise.resolve(), generationAdmission: GenerationAdmission | null = null, workflowAdmission: GenerationAdmission | null = null
  let generationPending = false, workflowPending = false
  const commandRefreshes = new Set<Promise<void>>()
  const canEdit = computed(() => Boolean(state.owner && state.planId && options.writable() && !state.busy
    && generationAdmission && workflowAdmission && !state.editBusy && !state.commandBusy && !state.commandPending && !state.blocked && !state.cadBusy && !state.atomicBusy && !state.pending && (state.versionId === null || state.serverState === 'Draft')))
  const upgradeReviewBasis = () => clone((state.savedPoint ?? recoveredSavePoint)?.payload ?? null)
  const canHistory = computed(() => canEdit.value || Boolean(state.owner && state.planId && options.writable()
    && generationAdmission && workflowAdmission && !state.busy && !state.editBusy && !state.commandBusy && !state.commandPending
    && !state.blocked && !state.cadBusy && !state.atomicBusy && !state.storageBlocked && state.uncertain
    && state.serverState === 'Draft' && !representedBoundary && state.pending?.method === 'PUT'
    && isObject((state.savedPoint ?? recoveredSavePoint)?.payload.overlay)
    && ['vemcad-weld-overlay/1', 'vemcad-weld-overlay/2'].includes(String(((state.savedPoint ?? recoveredSavePoint)!.payload.overlay as Record<string, unknown>).schema))
    && isObject(state.pending.body.payload) && isObject(state.pending.body.payload.overlay)
    && state.pending.body.payload.overlay.schema === 'vemcad-weld-overlay/3'
    && !['source_change', 'review_resolution', 'assembly_change', 'assembly_cancel'].some(key => Object.hasOwn(state.pending!.body, key))))
  const canAssembly = computed(() => Boolean(canEdit.value && !state.dirty && !state.storageBlocked && !state.uncertain
    && state.versionId && state.savedPoint && state.payload.product
    && state.savedPoint.draft_seq === state.draftSeq && state.savedPoint.content_hash === state.contentHash
    && equal(state.savedPoint.payload, state.payload)))
  const canSaveMeasurement = computed(() => Boolean(canEdit.value && !state.storageBlocked && !state.uncertain
    && state.versionId && state.overlayContextId && isObject(state.payload.overlay)))
  const canChangeDrawing = computed(() => Boolean(canEdit.value && !state.storageBlocked && !state.uncertain && state.savedPoint
    && state.versionId && state.savedPoint.payload.drawing && state.savedPoint.payload.product
    && equal({ ...state.payload, drawing: state.savedPoint.payload.drawing }, state.savedPoint.payload)))
  let assemblyChoiceEpoch = 0
  function clearAssemblyPreview() { assemblyChoiceEpoch++; state.assemblyPreview = null }
  const stopAssemblyWatch = watch([
    () => state.owner?.tenant_id, () => state.owner?.org_id, () => state.owner?.auth_user_id, () => state.owner?.rbac_user_id,
    () => state.planId, () => state.versionId, () => state.recoveryId, () => state.editSeq,
    () => state.savedPoint?.plan_id, () => state.savedPoint?.item_version_id, () => state.savedPoint?.draft_seq, () => state.savedPoint?.content_hash,
    () => state.draftSeq, () => state.contentHash, () => state.dirty, () => Boolean(state.pending), () => state.blocked, options.writable,
    () => JSON.stringify(state.assemblyCandidates.map(value => [value.baseline_id, value.fingerprint])),
  ], clearAssemblyPreview, { flush: 'sync' })
  const stopAssemblyGateWatch = watch(() => state.commandPending, () => { state.assemblyPreview = null }, { flush: 'sync' })
  function admit<T>(scope: RequestScope, mode: 'edit' | 'generation' | 'original', action: (scope: RequestScope) => Promise<T>, target = { plan_id: state.planId, item_version_id: state.versionId }) {
    need(generationAdmission, '请先核对跨页原生成请求；编制动作未发送')
    need(workflowAdmission, '请先核对跨页原评审请求；编制动作未发送')
    return workflowAdmission(scope, mode, target, locked => generationAdmission!(locked, mode, target, action))
  }
  function advance() { epoch++; controller.abort(); controller = new AbortController() }
  function clear() {
    commandRefreshes.clear()
    advance(); stored = null; recoveredSavePoint = null; history = []; representedBoundary = false; state.assemblyCandidates = []; state.assemblyPreview = null
    state.savedPoint = null; state.commandBusy = false; generationPending = false; workflowPending = false; state.commandPending = false; state.editBusy = false; editing = Promise.resolve()
    state.overlayContextId = ''; state.cadBusy = false; state.atomicBusy = false; state.historyCursor = 0; state.historyLength = 0
    Object.assign(state, { owner: null, planId: '', versionId: null, name: '', number: '', draftSeq: 0, contentHash: null,
      serverState: '', sources: null, payload: blank(), editSeq: 0, dirty: false, busy: false, blocked: false,
      storageBlocked: false, pending: null, uncertain: false, recoveryId: '', plans: [], products: [], drawings: [], recoveries: [], preview: null, total: 0, offset: 0 })
  }
  function invalidate() { clear(); state.message = '会话已变化，旧内容已隐藏；个人恢复记录保留，请重新读取' }
  const unsubscribe = onAuthPrincipalChange(invalidate)
  const storageChanged = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== localStorage) return
    if (event.key === null || event.key === EXPLICIT_SESSION_ORG_KEY || (TOKEN_KEYS as readonly string[]).includes(event.key)) invalidate()
  }
  window.addEventListener('storage', storageChanged)
  function ticket(): RequestScope {
    const captured = epoch, signature = readAuthSessionSignature(), plan = state.planId, version = state.versionId
    return { signal: controller.signal, accepts: () => !disposed && captured === epoch && signature === readAuthSessionSignature()
      && Boolean(readStoredToken()) && plan === state.planId && version === state.versionId }
  }
  function check(scope: RequestScope): void { need(scope.accepts() && !scope.signal?.aborted, '会话或目标已变化，原请求保留') }
  async function fresh(scope: RequestScope): Promise<WeldingOwner> {
    check(scope)
    let owner: WeldingOwner
    try { owner = await client.recoveryOwner(scope) } catch (error) { failure(error, scope); throw error }
    check(scope)
    if (state.owner && !equal(state.owner, owner)) { invalidate(); throw new Error('账号、组织或映射已变化') }
    state.owner = clone(owner)
    return owner
  }
  async function storage(scope: RequestScope): Promise<PlanRecoveryStore> {
    check(scope)
    if (!storePromise) storePromise = (options.openStore ?? openPlanRecoveryStore)().then(value => {
      if (disposed) { value.close(); throw new Error('页面已关闭') }
      store = value; return value
    }).catch(error => { storePromise = null; throw error })
    const value = await storePromise
    check(scope)
    return value
  }
  function record(): PlanRecoveryRecord {
    need(state.owner && state.recoveryId && state.planId)
    return validateRecovery({ schema: 'yuantus.welding_plan_recovery/1', recovery_id: state.recoveryId, updated_at: Date.now(), owner: clone(state.owner),
      draft: { plan_id: state.planId, version_id: state.versionId, base_draft_seq: state.draftSeq, base_content_hash: state.contentHash,
        name: state.name, number: state.number, payload: clone(state.payload) }, pending: clone(state.pending) })
  }
  function checkpoint(scope = ticket()): Promise<PlanRecoveryRecord> {
    const next = record()
    const job = queue.catch(() => {}).then(async () => {
      check(scope)
      const db = await storage(scope)
      check(scope)
      const durable = stored && equal({ ...next, updated_at: stored.updated_at }, stored) ? clone(stored) : next
      const replaced = stored ? await db.compareReplace(stored, durable, scope.signal) : await db.claim(durable, scope.signal)
      check(scope)
      need(replaced, '恢复点已被其他页面更新；原记录保留，未发送新保存')
      stored = durable; state.storageBlocked = false
      return durable
    })
    queue = job
    return job
  }
  function failure(error: unknown, scope: RequestScope) {
    if (!scope.accepts()) return
    const message = error instanceof Error ? error.message : '操作无法确认'
    if (error instanceof WeldingPlanError && [401, 403, 404, 410].includes(error.status)) clear()
    state.message = `${message}${state.pending ? '；原请求仍待确认' : ''}`
  }
  async function run(action: (scope: RequestScope) => Promise<void>): Promise<void> {
    if (state.busy || state.commandBusy || disposed) return
    const scope = ticket(), startedEpoch = epoch, signature = readAuthSessionSignature(); state.busy = true
    try { await action(scope) } catch (error) { failure(error, scope) }
    finally { if (!disposed && startedEpoch === epoch && signature === readAuthSessionSignature()) state.busy = false }
  }
  async function waitCommandRefresh(scope: RequestScope) {
    while (commandRefreshes.size) { await Promise.all(commandRefreshes); check(scope) }
  }
  function checkNavigation(scope: RequestScope) {
    check(scope)
    need(!commandRefreshes.size && !state.commandPending, '请先确认原请求或完成图纸动作')
  }
  async function preserve(scope: RequestScope) {
    await editing; check(scope)
    await waitCommandRefresh(scope)
    need(!state.pending && !state.uncertain && !state.cadBusy && !state.atomicBusy && !state.commandBusy && !state.commandPending, '请先确认原请求或完成图纸动作')
    await cadBarrier?.(); check(scope)
    await waitCommandRefresh(scope)
    need(!state.commandPending, '请先确认原请求或完成图纸动作')
    if (state.planId && (state.dirty || state.pending)) { await checkpoint(scope); check(scope) }
    checkNavigation(scope)
  }
  async function list(scope: RequestScope, offset = state.offset) {
    const value = await client.list(offset, undefined, scope)
    check(scope); await fresh(scope)
    check(scope); state.plans = value.items; state.total = value.total; state.offset = offset
  }
  function applyPlan(value: PlanRecord, saved = false) {
    state.assemblyCandidates = []; state.assemblyPreview = null
    const editSeq = state.editSeq
    const represented = isObject(value.payload.overlay) && value.payload.overlay.schema === 'vemcad-weld-overlay/3'
    const boundary = saved && represented && !representedBoundary
    if (!saved || boundary) { history = []; state.historyCursor = 0; state.historyLength = 0 }
    representedBoundary = represented
    if (!saved) state.overlayContextId = ''

    Object.assign(state, { planId: value.plan_id, versionId: value.item_version_id, name: value.name, number: value.number,
      draftSeq: value.draft_seq, contentHash: value.content_hash, serverState: value.state, sources: clone(value.sources),
      payload: clone(value.payload), dirty: false, blocked: false, pending: null, uncertain: false, recoveryId: uuid(), editSeq: saved ? editSeq : 0, preview: null })
    state.savedPoint = clone(value)
    recoveredSavePoint = null
    stored = null
    return boundary
  }
  async function readOpen(plan: string, version: string, scope: RequestScope) {
    await preserve(scope)
    const owner = await fresh(scope), value = await client.read(plan, version, scope)
    check(scope)
    if (value.state !== 'Draft') {
      await fresh(scope); check(scope)
      checkNavigation(scope)
      applyPlan(value); state.blocked = true; state.message = '已读取固定版本；当前仅可查看'
      return
    }
    // Resolve edit eligibility for this exact saved point without trusting a MetaSheet role.
    const local = validateRecovery({ schema: 'yuantus.welding_plan_recovery/1', recovery_id: uuid(), updated_at: Date.now(), owner,
      draft: { plan_id: value.plan_id, version_id: value.item_version_id, base_draft_seq: value.draft_seq, base_content_hash: value.content_hash,
        name: value.name, number: value.number, payload: value.payload }, pending: null })
    let authority: RecoveryAuthority
    try { authority = await client.recover('restore', local, scope) }
    catch (error) {
      if (!(error instanceof WeldingPlanError) || ![403, 404].includes(error.status)) throw error
      check(scope)
      const readable = await client.read(plan, version, scope)
      check(scope); await fresh(scope); check(scope)
      checkNavigation(scope)
      applyPlan(readable); state.blocked = true; state.message = '已读取固定版本；当前仅可查看'
      return
    }
    check(scope); await fresh(scope); check(scope)
    checkNavigation(scope)
    applyPlan(value)
    state.blocked = !authority.can_write || authority.conflict || !authority.current
      || authority.current.draft_seq !== value.draft_seq || authority.current.content_hash !== value.content_hash
    state.message = state.blocked ? '已读取固定版本；当前仅可查看' : '已读取服务器草稿'
  }
  async function prepareRevisionTarget(ack: RevisionAck, original: WorkflowPending, external: RequestScope) {
    const source = validateWorkflowPending(original); need(source.action === 'revise'); validateRevisionAck(ack, source)
    const local = state.planId === source.plan_id && state.versionId === source.item_version_id
    const lifetime = ticket(), editSeq = state.editSeq, owner = clone(state.owner)
    const scope: RequestScope = { signal: external.signal, accepts: () => external.accepts() && lifetime.accepts() && editSeq === state.editSeq && equal(owner, state.owner) }
    await editing; check(scope)
    need(!state.busy && !state.commandBusy && !state.dirty && !state.pending && !state.uncertain && !state.storageBlocked && !state.cadBusy && !state.atomicBusy && !state.editBusy, '请先保存正文并完成当前动作')
    // Only the exact revision source may hold its own workflow gate during explicit opening.
    need(!generationPending && (!state.commandPending || local && workflowPending), '另一原请求仍待确认')
    if (local) need(equal(state.owner, source.owner) && state.draftSeq === ack.source_draft_seq && state.contentHash === ack.source_content_hash, '修订来源保存点已变化')
    await cadBarrier?.(); check(scope)
    const value = validatePlan(await client.read(ack.plan_id, ack.target_version_id, scope), ack.plan_id, ack.target_version_id); check(scope)
    need(value.version_label === ack.target_version_label && (value.draft_seq > 1 || value.content_hash === ack.target_content_hash && value.state === 'Draft'), '目标版本与初始修订依据不一致')
    const localRecord = validateRecovery({ schema: 'yuantus.welding_plan_recovery/1', recovery_id: uuid(), updated_at: Date.now(), owner: source.owner,
      draft: { plan_id: value.plan_id, version_id: value.item_version_id, base_draft_seq: value.draft_seq, base_content_hash: value.content_hash, name: value.name, number: value.number, payload: value.payload }, pending: null })
    const authority = await client.recover('restore', localRecord, scope); check(scope)
    need(equal(authority.owner, source.owner) && authority.record_id === localRecord.recovery_id && !authority.conflict && authority.current && equal(validatePlan(authority.current, value.plan_id, value.item_version_id), value), '目标恢复授权与读取依据不一致')
    need(equal(await client.authority(scope), source.owner), '目标身份或组织已变化'); check(scope)
    const db = await storage(scope), recoveries = await db.list(source.owner); check(scope)
    need(!recoveries.some(point => point.pending && point.draft.plan_id === value.plan_id && point.draft.version_id === value.item_version_id), '目标有原保存请求待核对')
    const next = { planId: value.plan_id, versionId: value.item_version_id, name: value.name, number: value.number, draftSeq: value.draft_seq, contentHash: value.content_hash,
      serverState: value.state, sources: clone(value.sources), payload: clone(value.payload), savedPoint: clone(value), owner: clone(source.owner), dirty: false, blocked: !authority.can_write,
      pending: null, uncertain: false, recoveryId: localRecord.recovery_id, editSeq: 0, preview: null, commandBusy: false, busy: false, overlayContextId: '', historyCursor: 0, historyLength: 0 }
    const opened = { plan_id: value.plan_id, item_version_id: value.item_version_id, draft_seq: value.draft_seq, content_hash: value.content_hash }
    return { scope, next, opened, represented: isObject(value.payload.overlay) && value.payload.overlay.schema === 'vemcad-weld-overlay/3' }
  }
  async function prepareReuseTarget(ack: ReuseAck, original: WorkflowPending, external: RequestScope) {
    const source = validateWorkflowPending(original); need(source.action === 'reuse'); validateReuseAck(ack, source)
    const local = state.planId === source.plan_id && state.versionId === source.item_version_id
    const lifetime = ticket(), editSeq = state.editSeq, owner = clone(state.owner)
    const scope: RequestScope = { signal: external.signal, accepts: () => external.accepts() && lifetime.accepts() && editSeq === state.editSeq && equal(owner, state.owner) }
    await editing; check(scope)
    need(!state.busy && !state.commandBusy && !state.dirty && !state.pending && !state.uncertain && !state.storageBlocked && !state.cadBusy && !state.atomicBusy && !state.editBusy, '请先保存正文并完成当前动作')
    need(!generationPending && (!state.commandPending || local && workflowPending), '另一原请求仍待确认')
    if (local) need(equal(state.owner, source.owner) && state.draftSeq === ack.source_draft_seq && state.contentHash === ack.source_content_hash, '复用来源保存点已变化')
    await cadBarrier?.(); check(scope)
    const db = await storage(scope); check(scope)
    const targetClear = async () => { const records = await db.list(source.owner); check(scope); need(!records.some(record => record.pending && record.draft.plan_id === ack.target_plan_id && record.draft.version_id === ack.target_version_id), '目标有原保存请求待核对') }
    await targetClear()
    const value = validatePlan(await client.read(ack.target_plan_id, ack.target_version_id, scope), ack.target_plan_id, ack.target_version_id); check(scope)
    need(value.version_label === ack.target_version_label && (value.draft_seq > 1 || value.content_hash === ack.target_content_hash), '目标与初始复用依据不一致')
    const provenance = validateReuseProvenance(await client.readReuseProvenance(value.plan_id, value.item_version_id, source.owner, scope), value.plan_id, value.item_version_id, source.owner); check(scope)
    const { metadata, source: basis, target } = provenance.basis
    // Y stores lowercase checksums and an omitted BOM as null; keep the durable original unchanged.
    const normalizedRequest = { ...source.body, drawing: { ...source.body.drawing, expected_checksum: source.body.drawing.expected_checksum.toLowerCase() }, bom: source.body.bom ?? null }
    need(provenance.reuse_id === ack.reuse_id && provenance.reuse_provenance_sha256 === ack.reuse_provenance_sha256 && equal(provenance.basis.request, normalizedRequest) && metadata.source_plan_id === source.plan_id && metadata.source_version_id === source.item_version_id && metadata.target_version_id === ack.target_version_id && basis.draft_seq === ack.source_draft_seq && basis.content_hash === ack.source_content_hash && target.version_label === ack.target_version_label && target.content_hash === ack.target_content_hash, '复用来源与原回执不一致')
    need(equal(value.sources.reuse, { schema: 'yuantus.welding_reuse/1', reuse_id: ack.reuse_id }), '目标复用标记不一致')
    const localRecord = validateRecovery({ schema: 'yuantus.welding_plan_recovery/1', recovery_id: uuid(), updated_at: Date.now(), owner: source.owner,
      draft: { plan_id: value.plan_id, version_id: value.item_version_id, base_draft_seq: value.draft_seq, base_content_hash: value.content_hash, name: value.name, number: value.number, payload: value.payload }, pending: null })
    const authority = await client.recover('restore', localRecord, scope); check(scope)
    need(equal(authority.owner, source.owner) && authority.record_id === localRecord.recovery_id && !authority.conflict && authority.current && equal(validatePlan(authority.current, value.plan_id, value.item_version_id), value), '目标恢复授权与读取依据不一致')
    need(equal(await client.authority(scope), source.owner), '目标身份或组织已变化'); check(scope); await targetClear()
    const next = { planId: value.plan_id, versionId: value.item_version_id, name: value.name, number: value.number, draftSeq: value.draft_seq, contentHash: value.content_hash,
      serverState: value.state, sources: clone(value.sources), payload: clone(value.payload), savedPoint: clone(value), owner: clone(source.owner), dirty: false, blocked: !authority.can_write,
      pending: null, uncertain: false, recoveryId: localRecord.recovery_id, editSeq: 0, preview: null, commandBusy: false, busy: false, overlayContextId: '', historyCursor: 0, historyLength: 0 }
    return { scope, next, opened: { plan_id: value.plan_id, item_version_id: value.item_version_id, draft_seq: value.draft_seq, content_hash: value.content_hash }, represented: isObject(value.payload.overlay) && value.payload.overlay.schema === 'vemcad-weld-overlay/3' }
  }
  function applyRevisionTarget(prepared: Awaited<ReturnType<typeof prepareRevisionTarget>>) {
    check(prepared.scope)
    // Validation, cloning and recovery identity creation have already succeeded in preparation.
    history = []; stored = null; recoveredSavePoint = null; representedBoundary = prepared.represented
    generationPending = false; workflowPending = false
    state.assemblyCandidates = []; state.assemblyPreview = null
    Object.assign(state, prepared.next, { commandPending: false, message: prepared.next.blocked ? '已打开目标固定版本；当前仅可查看' : '已打开目标版本' })
    return prepared.opened
  }
  function remember(before: PlanPayload, after: PlanPayload) {
    const next = [...history.slice(0, state.historyCursor), { before: clone(before), after: clone(after) }]
    need(new TextEncoder().encode(jsonBytes(next)).length <= 20 * 1024 * 1024, '撤销历史超过 20 MiB，请保存并重新打开')
    history = next; state.historyCursor = next.length; state.historyLength = next.length
  }
  function payloadForSave(input: PlanPayload) {
    const payload = clone(input)
    if (state.versionId !== null) {
      const basis = state.savedPoint ?? recoveredSavePoint
      need(basis && basis.plan_id === state.planId && basis.item_version_id === state.versionId
        && basis.draft_seq === state.draftSeq && basis.content_hash === state.contentHash, '请重新读取当前保存基础后再保存')
      if (Object.hasOwn(basis.payload, 'preparation_notes') && !Object.hasOwn(payload, 'preparation_notes')) payload.preparation_notes = ''
      const previous = new Map(basis.payload.welds.map(row => [row.weld_id, row]))
      // Undo can restore a sparse snapshot; express clears only in a new request, never in history or pending replay.
      for (const row of payload.welds) {
        const old = previous.get(row.weld_id)
        for (const field of ['group_name', 'classification', 'included', 'welding_steps']) {
          if (old && Object.hasOwn(old, field) && !Object.hasOwn(row, field)) row[field] = field === 'included' ? true : field === 'welding_steps' ? [] : ''
        }
      }
    }
    return payload
  }
  async function commitPayload(next: PlanPayload, scope = ticket(), historyMove?: number) {
    return admit(scope, 'edit', async scope => {
    check(scope)
    const pendingHistory = Boolean(state.pending)
    if (pendingHistory) {
      need(canHistory.value && historyMove !== undefined && Math.abs(historyMove - state.historyCursor) === 1, '原保存待确认，仅可移动已有升级历史')
      const expected = historyMove! < state.historyCursor ? history[historyMove!]?.before : history[historyMove! - 1]?.after
      need(expected && equal(next, expected), '原保存待确认，仅可使用完整历史正文')
    }
    need(!state.commandBusy && !state.commandPending && !state.blocked && options.writable() && state.serverState === 'Draft')
    validatePayload(next)
    const before = clone(state.payload), beforeSeq = state.editSeq, lifetime = ticket()
    if (historyMove === undefined) need(new TextEncoder().encode(jsonBytes([...history.slice(0, state.historyCursor), { before, after: next }])).length <= 20 * 1024 * 1024, '撤销历史超过 20 MiB，请保存并重新打开')
    need(!state.atomicBusy); state.atomicBusy = true
    try {
      const owner = await fresh(scope); check(scope)
      await queue; check(scope)
      need(beforeSeq === state.editSeq && equal(before, state.payload), '编辑期间正文已变化')
      const original = record(), replacement = validateRecovery({ ...original, draft: { ...original.draft, payload: clone(next) },
        ...(pendingHistory ? { pending: { ...original.pending!, local_ahead: !equal(payloadForSave(next), original.pending!.body.payload) } } : {}) })
      const db = await storage(scope); check(scope)
      need(equal(await fresh(scope), owner)); check(scope)
      const succeeded = stored ? await db.compareReplace(stored, replacement, scope.signal) : await db.claim(replacement, scope.signal)
      check(scope); need(succeeded, '恢复点已被其他页面更新')
      stored = replacement
      need(equal(await fresh(scope), owner)); check(scope); need(options.writable(), '当前编制已关闭')
      if (historyMove === undefined) remember(before, next)
      else state.historyCursor = historyMove
      state.payload = clone(next); state.pending = clone(replacement.pending); state.editSeq++; state.dirty = true; state.storageBlocked = false; state.preview = null
      return state.editSeq
    } catch (error) { if (scope.accepts()) { state.storageBlocked = true; state.message = error instanceof Error ? error.message : '原子编辑未确认' } throw error }
    finally { if (lifetime.accepts()) { state.atomicBusy = false; state.cadBusy = false } }
    })
  }
  function edit(change: (payload: PlanPayload) => void) {
    if (!canEdit.value) return Promise.resolve()
    const scope = ticket(); state.editBusy = true
    editing = admit(scope, 'edit', async locked => {
      check(locked); const next = clone(state.payload); change(next)
      validatePayload(next); remember(state.payload, next)
      state.payload = next; state.editSeq++; state.dirty = true; state.preview = null
      await checkpoint(locked).catch(error => { if (scope.accepts()) { state.storageBlocked = true; state.message = `${error.message}；编辑仍在内存，未发送保存` } })
    }).catch(error => failure(error, scope)).finally(() => { if (scope.accepts()) state.editBusy = false })
    return editing
  }
  function editIdentity(key: 'name' | 'number', value: string) {
    if (!canEdit.value || state.versionId !== null) return
    state[key] = value; state.editSeq++; state.dirty = true
    const scope = ticket()
    void checkpoint(scope).catch(error => { if (scope.accepts()) { state.storageBlocked = true; state.message = `${error.message}；编辑仍在内存，未发送保存` } })
  }
  async function sendOriginal(scope: RequestScope, original: PlanRecoveryRecord, detached: boolean, requireWritable = false) {
    return admit(scope, 'edit', async scope => {
    const sourceStep = !detached && original.pending?.body.source_change && !equal(original.draft.payload, original.pending.body.payload)
      ? { before: clone(original.draft.payload), after: clone(original.pending.body.payload) as PlanPayload } : null
    let sourceHistory = sourceStep ? [...history.slice(0, state.historyCursor), sourceStep] : null
    const trimmedHistory = sourceHistory && new TextEncoder().encode(jsonBytes(sourceHistory)).length > 20 * 1024 * 1024
    if (trimmedHistory) sourceHistory = [sourceStep!]
    const owner = await fresh(scope)
    need(equal(owner, original.owner), '原请求不属于当前身份')
    const authorized = await client.recover('retry', original, scope)
    check(scope); need(equal(authorized.owner, owner))
    const db = await storage(scope)
    check(scope)
    // The original durable record must still be present before any receipt replay.
    need(equal(await db.get(owner, original.recovery_id), original), '原恢复点已变化，请重新读取')
    check(scope)
    if (requireWritable) need(options.writable() && !state.blocked && !state.commandPending && !state.commandBusy
      && !state.cadBusy && !state.atomicBusy && !state.editBusy && state.serverState === 'Draft'
      && equal(state.owner, original.owner) && equal(state.pending, original.pending)
      && state.draftSeq === original.draft.base_draft_seq && state.contentHash === original.draft.base_content_hash
      && equal(state.payload, original.draft.payload), '装配保存前身份或权限已变化；原请求保留')
    const ack = validateSaveAck(await client.save(original, scope), original)
    check(scope); need(equal(await fresh(scope), owner)); check(scope)
    const boundary = !detached && !representedBoundary
      && !['source_change', 'review_resolution', 'assembly_change', 'assembly_cancel'].some(key => Object.hasOwn(original.pending!.body, key))
      && isObject(ack.payload.overlay) && ack.payload.overlay.schema === 'vemcad-weld-overlay/3'
    const replacement = original.pending?.local_ahead ? validateRecovery({ ...original, updated_at: Date.now(),
      draft: { ...original.draft, version_id: ack.item_version_id, base_draft_seq: ack.draft_seq, base_content_hash: ack.content_hash }, pending: null }) : null
    const cleared = await db.compareReplace(original, replacement, scope.signal)
    check(scope)
    need(cleared, '原请求已确认，但另一个页面的恢复点已更新；请重新读取')
    if (!detached) {
      if (replacement) {
        state.versionId = ack.item_version_id; state.draftSeq = ack.draft_seq; state.contentHash = ack.content_hash
        state.pending = null; state.uncertain = false; state.blocked = true; stored = replacement
        if (boundary) { representedBoundary = true; history = []; state.historyCursor = 0; state.historyLength = 0; state.savedPoint = clone(ack); state.sources = clone(ack.sources); state.overlayContextId = '' }
      } else {
        applyPlan(ack, true)
        if (original.pending?.body.source_change) state.overlayContextId = ''
        if (sourceHistory && !boundary) { history = sourceHistory; state.historyCursor = history.length; state.historyLength = history.length }
      }
    }
    state.preview = null
    state.message = replacement ? '原保存已确认；后来编辑仍保留，须重新授权恢复' : trimmedHistory ? '原保存已确认；撤销历史超过容量，已保留本次换图撤销' : '原保存已确认'
    if (boundary) state.message += '；已建立多表示保存边界，之前的撤销历史已清除'
    if (boundary && replacement) state.message += '；服务器已保存多表示，本地副本保留供查看'
    }, { plan_id: original.draft.plan_id, item_version_id: original.draft.version_id })
  }
  async function save(measureGeometry = false) {
    const waitScope = ticket(); await editing; if (!waitScope.accepts()) return
    if (!canEdit.value || (measureGeometry ? !canSaveMeasurement.value : !state.dirty)) return
    try { await cadBarrier?.() } catch (error) { state.message = error instanceof Error ? error.message : '请完成图纸动作'; return }
    if (!waitScope.accepts() || !canEdit.value || state.storageBlocked || (measureGeometry && !canSaveMeasurement.value)) return
    await run(scope => admit(scope, 'edit', async scope => {
      const owner = await fresh(scope)
      need(state.payload.product && state.payload.drawing && state.name.length && state.number.length, '请先选择固定产品/图纸并填写名称和编号')
      await queue.catch(() => {}); check(scope)
      const payload = payloadForSave(state.payload)
      need(!measureGeometry || (state.versionId && state.overlayContextId && isObject(payload.overlay)), '请先保存 Draft 并打开固定图纸后核验几何测量')
      const body = state.versionId === null ? { plan_id: state.planId, name: state.name, number: state.number, save_id: uuid(), payload }
        : { expected_draft_seq: state.draftSeq, save_id: uuid(), payload, ...(state.overlayContextId ? { overlay_context_id: state.overlayContextId } : {}), ...(measureGeometry ? { measure_geometry: true } : {}) }
      state.pending = { method: state.versionId === null ? 'POST' : 'PUT', path: state.versionId === null ? ''
        : `/${encodeURIComponent(state.planId)}/versions/${encodeURIComponent(state.versionId)}/draft`, body, local_ahead: false }
      state.uncertain = false
      let original: PlanRecoveryRecord
      try { original = await checkpoint(scope); check(scope) }
      catch (error) {
        if (scope.accepts()) {
          state.storageBlocked = true
          throw new Error(`${error instanceof Error ? error.message : '恢复存储失败'}；原请求未持久化，未发送；编辑仍在内存`)
        }
        throw error
      }
      let dispatched = false
      try {
        need(equal(await fresh(scope), owner)); check(scope)
        dispatched = true
        const ack = validateSaveAck(await client.save(original, scope), original)
        check(scope); need(equal(await fresh(scope), owner)); check(scope)
        const db = await storage(scope)
        check(scope)
        need(await db.compareReplace(original, null, scope.signal), '原保存已确认，但本地记录已变化，请重新读取')
        check(scope); const boundary = applyPlan(ack, true)
        state.message = boundary ? '已保存服务器草稿；已建立多表示保存边界，之前的撤销历史已清除' : '已保存服务器草稿'
      } catch (error) {
        if (scope.accepts() && dispatched) {
          const uncertain = !(error instanceof WeldingPlanError) || error.status === 0 || error.status >= 500 || error.code === 'WELDING_RESULT_UNKNOWN'
          state.uncertain = state.uncertain || uncertain
          if (!state.uncertain && error instanceof WeldingPlanError && ![401, 403, 404, 410].includes(error.status)) {
            const replacement = validateRecovery({ ...original, updated_at: Date.now(), pending: null })
            const db = await storage(scope); check(scope)
            if (await db.compareReplace(original, replacement, scope.signal)) { check(scope); stored = replacement; state.pending = null }
          }
        }
        throw error
      }
    }))
  }
  async function confirmSourceReview(page: SourceReview, input: ReviewResolution, expectedOwner: WeldingOwner) {
    const resolution = validateReviewResolution(input), displayed = validateSourceReview(page, state.planId, state.versionId ?? '', page.offset)
    const waitScope = ticket(); await editing; check(waitScope)
    need(canEdit.value && !state.dirty && !state.storageBlocked && !state.uncertain && state.savedPoint && state.versionId, '请先保存编辑、核对原请求并读取可写 Draft 的复核义务')
    const point = clone(state.savedPoint)
    const unchanged = () => {
      check(waitScope)
      need(options.writable() && !state.dirty && !state.storageBlocked && !state.pending && !state.uncertain && !state.commandPending
        && !state.commandBusy && !state.cadBusy && !state.atomicBusy && !state.editBusy && !state.blocked && state.serverState === 'Draft'
        && equal(state.owner, expectedOwner) && equal(state.savedPoint, point) && equal(state.payload, point.payload)
        && state.draftSeq === point.draft_seq && state.contentHash === point.content_hash, '身份或保存点已变化，请重新读取复核义务')
      need(displayed.can_write && displayed.draft_seq === point.draft_seq && displayed.content_hash === point.content_hash)
    }
    unchanged()
    await run(scope => admit(scope, 'edit', async scope => {
      await cadBarrier?.(); check(scope); unchanged()
      const owner = await fresh(scope); check(scope); unchanged()
      const current = validateSourceReview(await client.sourceReview(point.plan_id, point.item_version_id, displayed.offset, scope), point.plan_id, point.item_version_id, displayed.offset)
      check(scope); need(equal(await fresh(scope), owner)); check(scope); unchanged()
      const selected = displayed.items.find(row => row.weld_id === resolution.weld_id), latest = current.items.find(row => row.weld_id === resolution.weld_id)
      need(current.can_write && current.draft_seq === point.draft_seq && current.content_hash === point.content_hash
        && selected?.state === 'pending' && equal(selected, latest) && selected.expected_review_digest === resolution.expected_review_digest, '复核内容已变化，请重新读取义务')
      await queue; check(scope); unchanged()
      state.pending = { method: 'PUT', path: `/${encodeURIComponent(point.plan_id)}/versions/${encodeURIComponent(point.item_version_id)}/draft`,
        body: { expected_draft_seq: point.draft_seq, save_id: uuid(), payload: clone(point.payload), review_resolution: resolution }, local_ahead: false }
      state.uncertain = true
      let original: PlanRecoveryRecord
      try { original = await checkpoint(scope); check(scope) }
      catch (error) { if (scope.accepts()) state.storageBlocked = true; throw error }
      await sendOriginal(scope, original, false)
    }))
  }
  function sourceBasis() {
    need(canChangeDrawing.value && state.savedPoint && state.owner, '请先保存其它编辑，或明确采用已保存底图')
    return { point: clone(state.savedPoint), owner: clone(state.owner), payload: clone(state.payload), editSeq: state.editSeq, recoveryId: state.recoveryId }
  }
  function unchangedSource(basis: Omit<SourceChangePreview, 'preparation'>, scope: RequestScope) {
    check(scope)
    need(options.writable() && !state.storageBlocked && !state.uncertain && !state.pending && !state.blocked
      && !state.commandPending && !state.commandBusy && !state.cadBusy && !state.atomicBusy && !state.editBusy && state.serverState === 'Draft'
      && equal(state.owner, basis.owner) && equal(state.savedPoint, basis.point) && equal(state.payload, basis.payload)
      && state.planId === basis.point.plan_id && state.versionId === basis.point.item_version_id && state.editSeq === basis.editSeq
      && state.recoveryId === basis.recoveryId && state.draftSeq === basis.point.draft_seq && state.contentHash === basis.point.content_hash,
    '身份、保存点或候选已变化，请重新准备换图')
  }
  async function sourceAction(basis: Omit<SourceChangePreview, 'preparation'>, external: RequestScope, action: (scope: RequestScope) => Promise<void>) {
    await run(async lifetime => {
      const scope = { signal: external.signal ?? lifetime.signal, accepts: () => lifetime.accepts() && external.accepts() }
      // Drain native actions before taking the owner lock needed by their durable commit.
      await cadBarrier?.(); unchangedSource(basis, scope)
      await admit(scope, 'edit', async locked => {
        unchangedSource(basis, locked); need(equal(await fresh(locked), basis.owner)); unchangedSource(basis, locked)
        await action(locked)
      })
    })
  }
  async function prepareDrawing(drawing: NonNullable<PlanPayload['drawing']>, external: RequestScope): Promise<SourceChangePreview> {
    const waiting = ticket(); await editing; check(waiting)
    const basis = sourceBasis(); let result: SourceChangePreview | null = null
    await sourceAction(basis, external, async scope => {
      const prepared = await client.prepareSourceChange(basis.point, drawing, basis.owner, uuid(), scope)
      unchangedSource(basis, scope); need(equal(await fresh(scope), basis.owner)); unchangedSource(basis, scope)
      result = { ...basis, preparation: validateSourcePreparation(prepared, basis.point, drawing, basis.owner) }
    })
    need(result, state.message || '换图准备未确认'); return result
  }
  async function confirmDrawing(input: SourceChangePreview, external: RequestScope) {
    const preview = clone(input), basis = sourceBasis(), drawing = preview.preparation.source_change.after.payload.drawing
    need(drawing && equal(basis, { point: preview.point, owner: preview.owner, payload: preview.payload, editSeq: preview.editSeq, recoveryId: preview.recoveryId }))
    validateSourcePreparation(preview.preparation, basis.point, drawing, basis.owner)
    await sourceAction(basis, external, async scope => {
      const current = await client.readSourcePreparation(basis.point, drawing, basis.owner, preview.preparation.context_id, scope)
      unchangedSource(basis, scope); need(equal(await fresh(scope), basis.owner)); unchangedSource(basis, scope)
      need(equal(current, preview.preparation), '换图准备内容已变化，请重新预览')
      await queue; unchangedSource(basis, scope)
      if (!equal(basis.payload, current.source_change.after.payload)) need(new TextEncoder().encode(jsonBytes([...history.slice(0, state.historyCursor), { before: basis.payload, after: current.source_change.after.payload }])).length <= 20 * 1024 * 1024, '撤销历史超过 20 MiB，请重新打开已保存草稿后换图')
      state.pending = { method: 'PUT', path: `/${encodeURIComponent(basis.point.plan_id)}/versions/${encodeURIComponent(basis.point.item_version_id)}/draft`, local_ahead: false,
        body: { expected_draft_seq: basis.point.draft_seq, save_id: uuid(), payload: clone(current.source_change.after.payload),
          overlay_context_id: current.context_id, source_change: { expected_content_hash: basis.point.content_hash, preparation_digest: current.source_change.preparation_digest } } }
      state.uncertain = true
      let original: PlanRecoveryRecord
      try { original = await checkpoint(scope); check(scope) }
      catch (error) { if (scope.accepts()) state.storageBlocked = true; throw error }
      await sendOriginal(scope, original, false, true)
    })
  }
  async function adoptSavedDrawing() {
    need(canEdit.value && state.savedPoint?.payload.drawing && !state.pending && !state.uncertain)
    const basis = clone(state.savedPoint), scope = ticket(); await cadBarrier?.(); check(scope)
    need(equal(basis, state.savedPoint), '保存点已变化')
    await edit(payload => { payload.drawing = clone(basis.payload.drawing) })
  }
  function assemblyBasis() {
    if (!options.writable()) clearAssemblyPreview()
    need(options.writable() && canAssembly.value && state.savedPoint && state.owner, '请先普通保存并读取可写草稿，再处理装配关联')
    return { point: clone(state.savedPoint), owner: clone(state.owner), editSeq: state.editSeq }
  }
  function unchangedAssembly(basis: ReturnType<typeof assemblyBasis>, scope: RequestScope) {
    check(scope)
    need(options.writable() && !state.dirty && !state.storageBlocked && !state.pending && !state.uncertain
      && !state.blocked && !state.commandBusy && !state.commandPending && !state.cadBusy && !state.atomicBusy && !state.editBusy
      && state.serverState === 'Draft' && equal(state.owner, basis.owner) && state.editSeq === basis.editSeq
      && equal(state.savedPoint, basis.point) && equal(state.payload, basis.point.payload)
      && state.planId === basis.point.plan_id && state.versionId === basis.point.item_version_id
      && state.draftSeq === basis.point.draft_seq && state.contentHash === basis.point.content_hash,
    '身份、保存点或编制权限已变化，请重新选择装配依据')
  }
  async function authorizeAssembly(basis: ReturnType<typeof assemblyBasis>, scope: RequestScope) {
    await cadBarrier?.(); unchangedAssembly(basis, scope)
    need(equal(await fresh(scope), basis.owner)); unchangedAssembly(basis, scope)
    const local = record(), authority = await client.recover('restore', local, scope)
    check(scope); need(equal(await fresh(scope), basis.owner)); unchangedAssembly(basis, scope)
    const savedPoint = clone(basis.point); delete savedPoint.save_id
    need(equal(authority.owner, basis.owner) && authority.record_id === local.recovery_id && authority.can_write
      && !authority.conflict && equal(authority.current, savedPoint), '服务器保存点或装配写入授权已变化')
  }
  function assemblyPayload(candidate: BomProjection, weldId: string, connection: { a: AssemblySide; b: AssemblySide }, point: PlanRecord, staged: ReadonlyArray<{ weldId: string; connection: { a: AssemblySide; b: AssemblySide } }> = []) {
    const selected = validateBomProjection(candidate, point.payload.product ?? undefined)
    need(state.assemblyCandidates.some(value => equal(value, selected)), '请重新读取并选择当前授权 BOM')
    const payload = clone(point.payload)
    need(Array.isArray(staged) && staged.length <= payload.welds.length && new Set(staged.map(row => row.weldId)).size === staged.length, '装配拟改焊缝重复或已变化')
    payload.assembly_format = 'yuantus.welding_assembly/1'
    payload.bom = { baseline_id: selected.baseline_id, expected_fingerprint: selected.fingerprint }
    for (const row of [...staged.filter(value => value.weldId !== weldId), { weldId, connection }]) {
      const weld = payload.welds.find(value => value.weld_id === row.weldId)
      need(weld, '焊缝已变化')
      const sides = { a: validateAssemblySide(row.connection.a), b: validateAssemblySide(row.connection.b) }
      for (const side of Object.values(sides)) {
        need([selected.root, ...selected.occurrences].some(node => equal(node.path, side.path)
          && node.item_id === side.item_id && node.version_id === side.version_id), '请选择固定 BOM 中的完整装配位置')
      }
      weld.assembly = sides
    }
    return validatePayload(payload)
  }
  function assemblyOriginal(payload: PlanPayload, body: Record<string, unknown>, method: 'PUT' | 'POST'): PlanRecoveryRecord {
    const local = record()
    return validateRecovery({ ...local, draft: { ...local.draft, payload }, pending: { method,
      path: `/${encodeURIComponent(state.planId)}/versions/${encodeURIComponent(state.versionId!)}/${method === 'POST' ? 'assembly-apply' : 'draft'}`,
      body: { expected_draft_seq: state.draftSeq, save_id: uuid(), payload, ...body }, local_ahead: false } })
  }
  async function persistAssembly(original: PlanRecoveryRecord, scope: RequestScope) {
    state.assemblyPreview = null
    state.payload = clone(original.draft.payload); state.dirty = true; state.editSeq++
    state.pending = clone(original.pending); state.uncertain = true
    let durable: PlanRecoveryRecord
    try { durable = await checkpoint(scope); check(scope) }
    catch (error) { if (scope.accepts()) state.storageBlocked = true; throw error }
    await sendOriginal(scope, durable, false, true)
  }
  async function readAssemblyCandidates() {
    const waiting = ticket(); await editing; check(waiting)
    const basis = assemblyBasis(); state.assemblyPreview = null
    await run(scope => admit(scope, 'edit', async scope => {
      await authorizeAssembly(basis, scope)
      const items = await client.bomCandidates(basis.point.payload.product!, scope)
      check(scope); need(equal(await fresh(scope), basis.owner)); unchangedAssembly(basis, scope)
      state.assemblyCandidates = items.map(item => validateBomProjection(item, basis.point.payload.product!))
      state.message = '已读取固定 BOM 装配位置'
    }))
  }
  async function saveAssembly(candidate: BomProjection, weldId: string, connection: { a: AssemblySide; b: AssemblySide }) {
    const waiting = ticket(); await editing; check(waiting)
    const basis = assemblyBasis(), payload = assemblyPayload(candidate, weldId, connection, basis.point), old = basis.point.payload.bom
    need(!isObject(old) || equal(old, payload.bom), '更换固定 BOM 请先比较，再明确应用')
    state.assemblyPreview = null
    await run(scope => admit(scope, 'edit', async scope => {
      await authorizeAssembly(basis, scope); await queue; unchangedAssembly(basis, scope)
      await persistAssembly(assemblyOriginal(payload, {}, 'PUT'), scope)
    }))
  }
  async function cancelAssembly(weldId: string, reason: string) {
    const waiting = ticket(); await editing; check(waiting)
    const basis = assemblyBasis(), command = validateAssemblyCancel({ weld_id: weldId, reason }), payload = clone(basis.point.payload)
    const weld = payload.welds.find(value => value.weld_id === weldId)
    need(weld && isObject(weld.assembly), '请选择已有装配关联的焊缝')
    delete weld.assembly; validatePayload(payload); state.assemblyPreview = null
    await run(scope => admit(scope, 'edit', async scope => {
      await authorizeAssembly(basis, scope); await queue; unchangedAssembly(basis, scope)
      await persistAssembly(assemblyOriginal(payload, { assembly_cancel: command }, 'PUT'), scope)
    }))
  }
  async function previewAssembly(candidate: BomProjection, weldId: string, connection: { a: AssemblySide; b: AssemblySide }, staged: ReadonlyArray<{ weldId: string; connection: { a: AssemblySide; b: AssemblySide } }> = []) {
    const selection = clone({ candidate, weldId, connection, staged })
    const waiting = ticket(); await editing; check(waiting)
    const basis = assemblyBasis(), payload = assemblyPayload(selection.candidate, selection.weldId, selection.connection, basis.point, selection.staged), old = basis.point.payload.bom
    need(isObject(old), '首次固定 BOM 关联请直接明确保存')
    clearAssemblyPreview(); const choiceEpoch = assemblyChoiceEpoch
    await run(scope => admit(scope, 'edit', async scope => {
      await authorizeAssembly(basis, scope); await queue; unchangedAssembly(basis, scope)
      const original = assemblyOriginal(payload, { assembly_change: { expected_content_hash: basis.point.content_hash,
        from_fingerprint: old.expected_fingerprint, to_fingerprint: (payload.bom as { expected_fingerprint: string }).expected_fingerprint } }, 'POST')
      const impact = validateAssemblyPreview(await client.assemblyPreview(original, scope), basis.point.plan_id, basis.point.item_version_id, original.pending!.body)
      check(scope); need(equal(await fresh(scope), basis.owner)); unchangedAssembly(basis, scope)
      need(choiceEpoch === assemblyChoiceEpoch, '装配选择已变化，请重新比较')
      state.assemblyPreview = { original, impact, editSeq: basis.editSeq, point: basis.point }
      state.message = '已比较固定装配依据；尚未保存，未知事实仍需核对'
    }))
  }
  async function applyAssembly() {
    const waiting = ticket(); await editing; check(waiting)
    const preview = clone(state.assemblyPreview), choiceEpoch = assemblyChoiceEpoch; need(preview, '请重新比较装配依据')
    const basis = assemblyBasis()
    need(equal(preview.original.owner, basis.owner) && preview.editSeq === basis.editSeq && equal(preview.point, basis.point), '装配比较已过期')
    validateAssemblyPreview(preview.impact, basis.point.plan_id, basis.point.item_version_id, preview.original.pending!.body)
    await run(scope => admit(scope, 'edit', async scope => {
      await authorizeAssembly(basis, scope); await queue; unchangedAssembly(basis, scope)
      need(choiceEpoch === assemblyChoiceEpoch, '装配比较已关闭或选择已变化')
      await persistAssembly(preview.original, scope)
    }))
  }
  async function generationCommand<T>(action: (scope: RequestScope, point: PlanRecord | null) => Promise<T>, saved: boolean, external?: RequestScope): Promise<T> {
    const waitScope = ticket(); await editing; check(waitScope)
    need(!disposed && !state.busy && !state.commandBusy && !state.atomicBusy && !state.cadBusy && !state.pending && !state.uncertain, '请先完成当前请求或图纸动作')
    const scope = ticket(), editSeq = state.editSeq, owner = clone(state.owner), point = clone(state.savedPoint)
    const captured: RequestScope = { signal: external?.signal ?? scope.signal, accepts: () => scope.accepts() && external?.accepts() !== false && editSeq === state.editSeq && equal(owner, state.owner) }
    if (saved) need(point && !state.dirty && !state.storageBlocked && !state.commandPending && !state.blocked && state.versionId === point.item_version_id && state.planId === point.plan_id && state.draftSeq === point.draft_seq && state.contentHash === point.content_hash && state.serverState === 'Draft', '请先保存当前草稿并核对原请求')
    state.commandBusy = true
    try {
      return await admit(captured, saved ? 'generation' : 'original', async locked => {
        await cadBarrier?.(); check(locked)
        await fresh(locked); check(locked)
        if (saved) need(equal(point, state.savedPoint) && !state.dirty && !state.storageBlocked && options.writable(), '保存点已变化或生成写入已关闭')
        return action(locked, point)
      })
    } finally { if (scope.accepts()) state.commandBusy = false }
  }
  async function workflowPoint<T>(point: WorkflowState, saved: boolean, external: RequestScope, action: (scope: RequestScope) => Promise<T>) {
    const attached = () => state.planId === point.plan_id && state.versionId === point.item_version_id
    const local = attached(), lifetime = ticket(), scope = local ? lifetime : external, editSeq = state.editSeq, owner = clone(state.owner)
    const captured: RequestScope = { signal: external.signal, accepts: () => external.accepts() && scope.accepts() && local === attached() && (!local || editSeq === state.editSeq && equal(owner, state.owner)) }
    await editing; check(captured)
    need(!state.commandBusy, '请先完成当前动作')
    if (local) {
      need(!state.busy && !state.dirty && !state.pending && !state.uncertain && !state.storageBlocked && !state.cadBusy && !state.atomicBusy && !state.editBusy, '请先保存正文、核对原请求并完成图纸动作')
      need(state.draftSeq === point.draft_seq && state.contentHash === point.content_hash, '正文保存点与评审依据不一致')
    }
    if (saved) need(local && !state.blocked && state.serverState === 'Draft' && state.savedPoint?.draft_seq === point.draft_seq && state.savedPoint.content_hash === point.content_hash, '提交评审前请先读取并保存当前草稿')
    state.commandBusy = true
    try { if (local) { await cadBarrier?.(); check(captured) }; return await action(captured) }
    finally { if (lifetime.accepts()) state.commandBusy = false }
  }
  function lockWorkflowBody(point: { plan_id: string; item_version_id: string }, scope: RequestScope) {
    check(scope)
    if (state.planId === point.plan_id && state.versionId === point.item_version_id) state.blocked = true
  }
  async function refreshWorkflowBody(point: { plan_id: string; item_version_id: string }, external: RequestScope) {
    check(external)
    if (state.planId !== point.plan_id || state.versionId !== point.item_version_id) return
    const scope = ticket(), editSeq = state.editSeq, owner = clone(state.owner)
    const captured: RequestScope = { signal: external.signal, accepts: () => external.accepts() && scope.accepts() && editSeq === state.editSeq && equal(owner, state.owner) }
    lockWorkflowBody(point, captured)
    need(!state.dirty && !state.pending && !state.uncertain && !state.storageBlocked, '动作已确认，本地正文保留，请核对后重新读取')
    const value = await client.read(point.plan_id, point.item_version_id, captured); check(captured); need(owner)
    if (value.state !== 'Draft') {
      need(equal(await client.authority(captured), owner)); check(captured)
      applyPlan(value); state.editSeq = editSeq; state.blocked = true
      state.message = '已读取固定版本；当前仅可查看'
      return
    }
    const local = validateRecovery({ schema: 'yuantus.welding_plan_recovery/1', recovery_id: uuid(), updated_at: Date.now(), owner,
      draft: { plan_id: value.plan_id, version_id: value.item_version_id, base_draft_seq: value.draft_seq, base_content_hash: value.content_hash, name: value.name, number: value.number, payload: value.payload }, pending: null })
    const authority = await client.recover('restore', local, captured); check(captured)
    need(equal(await client.authority(captured), owner)); check(captured)
    applyPlan(value); state.editSeq = editSeq
    state.blocked = !authority.can_write || authority.conflict || !authority.current || authority.current.draft_seq !== value.draft_seq || authority.current.content_hash !== value.content_hash
    state.message = state.blocked ? '已读取固定版本；当前仅可查看' : '已读取服务器草稿'
  }
  function dispose() {
    if (disposed) return
    disposed = true; advance(); stopAssemblyWatch(); stopAssemblyGateWatch(); unsubscribe(); window.removeEventListener('storage', storageChanged); store?.close()
  }
  if (getCurrentScope()) onScopeDispose(dispose)
  return {
    state, canEdit, canHistory, upgradeReviewBasis, canSaveMeasurement, canAssembly, readAssemblyCandidates, saveAssembly, cancelAssembly, previewAssembly, applyAssembly,
    clearAssemblyPreview,
    edit, editIdentity, save, confirmSourceReview, canChangeDrawing, prepareDrawing, confirmDrawing, adoptSavedDrawing, dispose, client, fresh, check, commitPayload,
    prepareRevisionTarget, applyRevisionTarget, prepareReuseTarget, applyReuseTarget: applyRevisionTarget,
    withWorkflowPoint: workflowPoint, lockWorkflowBody, refreshWorkflowBody,
    setWorkflowAdmission: (admission: GenerationAdmission) => { workflowAdmission = admission },
    setGenerationAdmission: (admission: GenerationAdmission) => { generationAdmission = admission },
    withTargetMutation: <T>(action: (scope: RequestScope) => Promise<T>, scope = ticket()) => admit(scope, 'edit', action),
    withSavedPoint: <T>(action: (scope: RequestScope, point: PlanRecord) => Promise<T>, external?: RequestScope) => generationCommand((scope, point) => { need(point); return action(scope, point) }, true, external),
    withOriginalCommand: <T>(action: (scope: RequestScope) => Promise<T>, external?: RequestScope) => generationCommand(scope => action(scope), false, external),
    setCommandPending: (scope: RequestScope, pending: boolean) => { check(scope); generationPending = pending; state.commandPending = generationPending || workflowPending },
    setWorkflowPending: (scope: RequestScope, pending: boolean) => { check(scope); workflowPending = pending; state.commandPending = generationPending || workflowPending },
    capture: (includeEdit = true): RequestScope => {
      const scope = ticket(), editSeq = state.editSeq, owner = clone(state.owner)
      return { signal: scope.signal, accepts: () => scope.accepts() && equal(owner, state.owner) && (!includeEdit || editSeq === state.editSeq) }
    },
    setCadBarrier: (barrier: (() => Promise<void>) | null) => { cadBarrier = barrier },
    trackCommandRefresh: (refresh: Promise<void>) => {
      commandRefreshes.add(refresh)
      void refresh.then(() => commandRefreshes.delete(refresh), () => commandRefreshes.delete(refresh))
    },
    historyCandidate: (direction: 'undo' | 'redo') => {
      const cursor = state.historyCursor + (direction === 'undo' ? -1 : 1)
      need(cursor >= 0 && cursor <= history.length && cursor !== state.historyCursor, '没有可用历史')
      return { cursor, payload: clone(direction === 'undo' ? history[cursor].before : history[cursor - 1].after) }
    },
    retryLocal: () => run(async scope => { need(!state.pending && !state.cadBusy && !state.atomicBusy); await fresh(scope); await checkpoint(scope); check(scope); await fresh(scope); check(scope); state.message = '本地恢复存储已确认' }),
    resetEntry: clear,
    prepareLeave: async () => {
      const scope = ticket()
      try { await preserve(scope); checkNavigation(scope); return true }
      catch (error) { failure(error, scope); return false }
    },
    initialize: () => run(async scope => { await fresh(scope); await list(scope); check(scope); state.message = '已读取个人范围与计划列表' }),
    refreshList: (offset = 0) => run(async scope => { await fresh(scope); await list(scope, offset) }),
    open: (plan: string, version: string) => run(scope => readOpen(plan, version, scope)),
    newDraft: () => run(async scope => {
      await preserve(scope); await fresh(scope); check(scope)
      checkNavigation(scope)
      Object.assign(state, { planId: uuid(), versionId: null, name: '', number: '', draftSeq: 0, contentHash: null,
        serverState: 'Draft', sources: null, payload: blank(), dirty: true, blocked: false, pending: null, uncertain: false,
        recoveryId: uuid(), editSeq: 0, preview: null, message: '新建本地草稿；选择固定产品与图纸后明确保存' })
      state.savedPoint = null; state.assemblyCandidates = []; state.assemblyPreview = null; generationPending = false; workflowPending = false; state.commandPending = false
      stored = null; recoveredSavePoint = null; history = []; state.historyCursor = 0; state.historyLength = 0; representedBoundary = false; state.overlayContextId = ''
    }),
    searchProducts: (query: string) => run(async scope => { await fresh(scope); const items = await client.productCandidates(query, scope); check(scope); await fresh(scope); check(scope); state.products = items }),
    searchDrawings: (query: string) => run(async scope => { await fresh(scope); const items = await client.drawingCandidates(query, scope); check(scope); await fresh(scope); check(scope); state.drawings = items }),
    selectProduct: (product: PlanCandidate) => run(async scope => {
      need(options.writable() && !state.pending && !state.blocked && state.versionId === null)
      await fresh(scope); const value = await client.productContext(product, scope); check(scope); await fresh(scope); check(scope)
      state.payload = { ...clone(state.payload), product: { item_id: value.item_id, version_id: value.version_id } }
      state.editSeq++; state.dirty = true; await checkpoint(scope)
    }),
    selectDrawing: (drawing: DrawingCandidate) => {
      if (!canEdit.value || state.versionId !== null || !state.drawings.some(value => equal(value, drawing))) return
      return edit(payload => { payload.drawing = { item_id: drawing.item_id, version_id: drawing.version_id, file_id: drawing.file_id, file_role: drawing.file_role, expected_checksum: drawing.checksum } })
    },
    refreshRecoveries: () => run(async scope => { const owner = await fresh(scope), db = await storage(scope); const records = await db.list(owner); check(scope); need(equal(await fresh(scope), owner)); check(scope); state.recoveries = records }),
    previewRecovery: (input: PlanRecoveryRecord) => run(async scope => {
      const record = validateRecovery(input), owner = await fresh(scope)
      need(equal(owner, record.owner))
      const db = await storage(scope)
      need(equal(await db.get(owner, record.recovery_id), record), '恢复点已变化，请重新读取'); check(scope)
      const authority = await client.recover('restore', record, scope)
      check(scope); need(equal(await fresh(scope), record.owner)); check(scope)
      state.preview = { record, authority }; state.message = '固定来源已核验；明确恢复后才替换本页内容'
    }),
    restoreRecovery: () => run(async scope => {
      const preview = state.preview; need(preview)
      await preserve(scope)
      const owner = await fresh(scope); need(equal(owner, preview.record.owner))
      const db = await storage(scope)
      need(equal(await db.get(owner, preview.record.recovery_id), preview.record)); check(scope)
      const authority = await client.recover('restore', preview.record, scope)
      check(scope); need(equal(await fresh(scope), owner)); check(scope)
      checkNavigation(scope)
      const draft = preview.record.draft, current = authority.current
      state.savedPoint = null; state.assemblyCandidates = []; state.assemblyPreview = null
      const matched = current?.plan_id === draft.plan_id && current?.item_version_id === draft.version_id && current?.draft_seq === draft.base_draft_seq && current?.content_hash === draft.base_content_hash
      need(!authority.can_write || draft.version_id === null || matched, '恢复写入基础不匹配')
      const retainedLegacy = !preview.record.pending && isObject(current?.payload.overlay) && current.payload.overlay.schema === 'vemcad-weld-overlay/3'
        && (!isObject(draft.payload.overlay) || draft.payload.overlay.schema !== 'vemcad-weld-overlay/3')
      recoveredSavePoint = matched ? clone(current) : null
      Object.assign(state, { planId: draft.plan_id, versionId: draft.version_id, name: draft.name, number: draft.number,
        draftSeq: draft.base_draft_seq, contentHash: draft.base_content_hash, payload: clone(draft.payload), sources: matched ? clone(current!.sources) : null,
        serverState: current?.state ?? 'Draft', pending: clone(preview.record.pending), uncertain: Boolean(preview.record.pending),
        recoveryId: preview.record.recovery_id, dirty: true, blocked: !authority.can_write || authority.conflict || retainedLegacy, storageBlocked: false, editSeq: state.editSeq + 1,
        preview: null, message: retainedLegacy ? '服务器已保存多表示；旧格式本地副本仅供查看，请打开服务器版本继续编制' : '已恢复本地副本，仍未保存；原保存请求需单独核对' })
      stored = clone(preview.record); history = []; state.historyCursor = 0; state.historyLength = 0; state.overlayContextId = ''; representedBoundary = Boolean(matched && isObject(current?.payload.overlay) && current.payload.overlay.schema === 'vemcad-weld-overlay/3')
    }),
    confirmOriginal: () => run(async scope => {
      need(state.pending)
      if (!stored?.pending) await checkpoint(scope)
      check(scope); need(stored?.pending)
      state.uncertain = true; await sendOriginal(scope, clone(stored), false)
    }),
    confirmRecoveryOriginal: (input: PlanRecoveryRecord) => run(async scope => {
      const original = validateRecovery(input); need(original.pending)
      const attached = original.recovery_id === state.recoveryId && original.draft.plan_id === state.planId
        && original.draft.version_id === state.versionId && equal(original.owner, state.owner)
      if (attached) {
        need(equal(original, stored) && equal(original.pending, state.pending) && equal(original.draft.payload, state.payload), '当前恢复点已变化，请重新读取')
        state.uncertain = true
      }
      await sendOriginal(scope, original, !attached)
    }),
  }
}
