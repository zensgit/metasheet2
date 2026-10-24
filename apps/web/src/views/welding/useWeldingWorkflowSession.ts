import { computed, getCurrentScope, onScopeDispose, reactive, watch } from 'vue'
import { onAuthPrincipalChange, readAuthSessionSignature, readStoredToken, TOKEN_KEYS } from '../../composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../../utils/explicitSessionOrg'
import { clone, equal, need, jsonBytes, type WeldingOwner } from '../../services/welding/planRecovery'
import { WeldingPlanError, validateWorkflowAck, validateWorkflowBody, validateRevisionAck, validateFinalAck, finalGenerationBasis, type RequestScope, type WorkflowState, type WorkflowHistory, type WorkflowOriginal, type WorkflowAck, type ReviewGeneration, type FinalGenerationAck, type RevisionAck, type Publication, type PublicationEntry, type PublicationDirectory, type PublicationComparison } from '../../services/welding/planClient'
import { openGenerationRecoveryStore, validateWorkflowPending, withGenerationOwnerLock, type CommandRecoveryStore, type WorkflowPending } from '../../services/welding/commandRecovery'
import type { useWeldingPlanSession } from './useWeldingPlanSession'
import { validateReuseRequest, validateReuseAck, validateReuseProvenance, type ReuseRequest, type ReuseOriginal, type ReuseAck, type ReuseProvenance, type PlanCandidate, type DrawingCandidate, type ReuseBomCandidate } from '../../services/welding/planClient'

type CommandAction = 'submit' | 'approve' | 'reject' | 'withdraw' | 'reopen' | 'final-render' | 'final-retry' | 'release' | 'revise'

type RevisionCleanup = { original: WorkflowPending; ack: RevisionAck; opened: { plan_id: string; item_version_id: string; draft_seq: number; content_hash: string }; signature: string; identity: number; serial: number }
type ReuseCleanup = Omit<RevisionCleanup, 'ack'> & { ack: ReuseAck }

export function useWeldingWorkflowSession(options: {
  session: ReturnType<typeof useWeldingPlanSession>; active: () => boolean; writable: () => boolean
  openStore?: () => Promise<CommandRecoveryStore>; uuid?: () => string
}) {
  const session = options.session, s = session.state, client = session.client, uuid = options.uuid ?? (() => crypto.randomUUID())
  const state = reactive({ planId: '', versionId: '', owner: null as WeldingOwner | null, current: null as WorkflowState | null,
    history: null as WorkflowHistory | null, pending: null as WorkflowPending | null, working: false, storageBlocked: false,
    revisionAck: null as RevisionAck | null, revisionCleanup: null as RevisionCleanup | null, reuseAck: null as ReuseAck | null, reuseCleanup: null as ReuseCleanup | null, message: '', polling: false, downloading: false, validation: null as { ready: boolean; issues: string[] } | null })
  const emptyReuse = () => ({ name: '', number: '', reason: '', selectedWeldIds: [] as string[], products: [] as PlanCandidate[], drawings: [] as DrawingCandidate[], boms: [] as ReuseBomCandidate[], product: null as ReuseRequest['product'] | null, drawing: null as ReuseRequest['drawing'] | null, bom: null as NonNullable<ReuseRequest['bom']> | null, bomWorking: false, bomMessage: '' })
  const reuse = reactive(emptyReuse()), provenance = reactive({ current: null as ReuseProvenance | null, working: false, message: '' })
  let provenanceSerial = 0, provenanceController = new AbortController()
  let reuseSelectionSerial = 0, reuseBomController = new AbortController()
  let identityEpoch = 0, cleanupSerial = 0, cleanupController = new AbortController()
  let epoch = 0, operation = 0, pendingRead = 0, disposed = false, controller = new AbortController()
  let pollSerial = 0, downloadSerial = 0, pollTimer: ReturnType<typeof setTimeout> | undefined, pollController = new AbortController(), downloadController = new AbortController()
  const downloads = new Map<string, ReturnType<typeof setTimeout>>()
  let store: CommandRecoveryStore | null = null, storePromise: Promise<CommandRecoveryStore> | null = null, unsubscribeStore: (() => void) | undefined
  const attached = () => s.planId === state.planId && s.versionId === state.versionId
  const localReady = computed(() => !attached() || !s.busy && !s.editBusy && !s.commandBusy && !s.dirty && !s.pending && !s.uncertain && !s.storageBlocked && !s.cadBusy && !s.atomicBusy)
  const canResolve = computed(() => options.active() && !state.working && !state.storageBlocked && Boolean(state.pending))
  const canReplay = computed(() => canResolve.value && options.writable() && localReady.value)
  const canDownloadPublication = computed(() => options.active() && Boolean(state.current?.publication) && !state.downloading)
  const canOpenRevision = computed(() => options.active() && !state.working && Boolean(state.revisionAck && state.pending?.action === 'revise'))
  const canCleanupRevision = computed(() => options.active() && !state.working && Boolean(state.revisionCleanup))
  const canOpenReuse = computed(() => options.active() && !state.working && Boolean(state.reuseAck && state.pending?.action === 'reuse'))
  const canCleanupReuse = computed(() => options.active() && !state.working && Boolean(state.reuseCleanup))
  function sourceWeldIds(current: WorkflowState | null): string[] {
    const publication = current?.publication, approval = current?.approval, submission = approval?.submission, saved = s.savedPoint
    if (!current || current.state !== 'Released' || !publication || publication.state !== 'Released' || approval?.state !== 'approved' || approval.decision?.decision.decision !== 'approve' || !submission || !state.owner || !attached() || !saved?.payload.product) return []
    if (publication.plan_id !== state.planId || publication.item_version_id !== state.versionId || publication.draft_seq !== current.draft_seq || publication.content_hash !== current.content_hash || publication.approval_request_id !== approval.approval_request_id || publication.submission_hash !== approval.submission_hash || publication.decision_hash !== approval.decision.decision_hash || publication.review_generation_id !== submission.review_generation_id || submission.plan_id !== publication.plan_id || submission.item_version_id !== publication.item_version_id || submission.draft_seq !== publication.draft_seq || submission.plan_content_hash !== publication.content_hash || submission.tenant_id !== state.owner.tenant_id || submission.org_id !== state.owner.org_id || saved.plan_id !== publication.plan_id || saved.item_version_id !== publication.item_version_id || saved.draft_seq !== publication.draft_seq || saved.content_hash !== publication.content_hash) return []
    return Array.isArray(submission.included_weld_ids) ? [...submission.included_weld_ids] as string[] : []
  }
  const reuseWeldIds = computed(() => sourceWeldIds(state.current))
  function reuseBody(requestId: string, targetId: string, form = reuse, current = state.current): ReuseRequest {
    need(current?.publication && form.product && form.drawing && form.product.item_id !== s.savedPoint?.payload.product?.item_id, '请明确选择另一产品及固定图纸')
    const included = sourceWeldIds(current); need(included.length && form.selectedWeldIds.every(id => included.includes(id)), '仅可选择此正式版本批准纳入的焊缝')
    return validateReuseRequest({ request_id: requestId, source_publication_id: current.publication.publication_id, expected_draft_seq: current.draft_seq, expected_content_hash: current.content_hash, selected_weld_ids: form.selectedWeldIds, target_plan_id: targetId, name: form.name, number: form.number, product: form.product, drawing: form.drawing, bom: form.bom, reason: form.reason })
  }
  const canCreateReuse = computed(() => {
    if (!options.active() || !options.writable() || state.working || reuse.bomWorking || state.storageBlocked || state.pending || !localReady.value || s.commandPending || !state.owner) return false
    try { reuseBody('preview-request', state.planId === 'preview-target' ? 'preview-other' : 'preview-target'); return true } catch { return false }
  })
  function canAction(action: CommandAction) {
    const current = state.current, owner = state.owner
    if (!options.active() || !options.writable() || state.working || state.storageBlocked || state.pending || !localReady.value || attached() && s.commandPending || !current?.is_current || !current.allowed_actions.includes(action) || !owner) return false
    if (action === 'revise') return current.state === 'Released' && Boolean(current.publication && current.publication.draft_seq === current.draft_seq && current.publication.content_hash === current.content_hash)
    if (action === 'submit') return attached() && !s.blocked && current.state === 'Draft' && Boolean(s.savedPoint) && s.draftSeq === current.draft_seq && s.contentHash === current.content_hash
    if (action === 'approve' || action === 'reject') return current.state === 'InReview' && current.approval?.submission.reviewer.auth_user_id === owner.auth_user_id && current.approval.submission.reviewer.rbac_user_id === owner.rbac_user_id
    if (action === 'final-render') return current.state === 'Approved' && Boolean(current.final_profile && current.approval?.decision)
    if (action === 'final-retry' || action === 'release') return current.state === 'Approved' && current.final_generation?.status === (action === 'release' ? 'Ready' : 'Failed')
    return action === 'withdraw' ? current.state === 'InReview' : current.state === 'Approved'
  }
  function check(scope: RequestScope) { need(scope.accepts() && !scope.signal?.aborted, '会话或评审目标已变化，原请求保留') }
  function capture(): RequestScope {
    const captured = epoch, serial = operation, signature = readAuthSessionSignature(), plan = state.planId, version = state.versionId
    return { signal: controller.signal, accepts: () => !disposed && captured === epoch && serial === operation && signature === readAuthSessionSignature() && Boolean(readStoredToken()) && options.active() && plan === state.planId && version === state.versionId }
  }
  function stopPoll() { pollSerial++; clearTimeout(pollTimer); pollTimer = undefined; pollController.abort(); pollController = new AbortController(); state.polling = false }
  function releaseDownloads() { for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url) }; downloads.clear() }
  function readScope(signal: AbortSignal): RequestScope {
    const captured = epoch, signature = readAuthSessionSignature(), plan = state.planId, version = state.versionId
    return { signal, accepts: () => !disposed && epoch === captured && options.active() && Boolean(readStoredToken()) && signature === readAuthSessionSignature() && plan === state.planId && version === state.versionId && !signal.aborted }
  }
  function stopReuseBoms() { reuseBomController.abort(); reuseBomController = new AbortController(); reuse.bomWorking = false }
  const stopReuseSelection = watch(() => [s.savedPoint, s.savedPoint?.plan_id, s.savedPoint?.item_version_id, s.savedPoint?.draft_seq, s.savedPoint?.content_hash, s.savedPoint?.payload.product?.item_id, s.savedPoint?.payload.product?.version_id, s.commandPending,
    jsonBytes([state.current?.publication ?? null, state.current?.approval ?? null, reuse.selectedWeldIds, state.pending])],
  () => { reuseSelectionSerial++; stopReuseBoms() }, { flush: 'sync' })
  function reuseSelectionScope(base: RequestScope): RequestScope {
    const editor = session.capture(), serial = reuseSelectionSerial, pendingSerial = pendingRead, owner = clone(state.owner)
    return { signal: base.signal, accepts: () => base.accepts() && editor.accepts() && serial === reuseSelectionSerial && pendingSerial === pendingRead && !state.pending && !s.commandPending && equal(state.owner, owner) }
  }
  function hide(preserveCleanup = false) {
    stopReuseBoms()
    stopPoll(); downloadSerial++; downloadController.abort(); downloadController = new AbortController(); state.downloading = false; releaseDownloads()
    epoch++; operation++; pendingRead++; controller.abort(); controller = new AbortController()
    Object.assign(state, { owner: null, current: null, history: null, pending: null, revisionAck: null, reuseAck: null, working: false, storageBlocked: false, validation: null })
    Object.assign(reuse, emptyReuse()); provenanceSerial++; provenanceController.abort(); provenanceController = new AbortController(); Object.assign(provenance, { current: null, working: false, message: '' })
    if (!preserveCleanup) { cleanupSerial++; state.revisionCleanup = null; state.reuseCleanup = null; cleanupController.abort(); cleanupController = new AbortController() }
  }
  function invalidate() { identityEpoch++; hideFormal(); hide(); state.message = '会话已变化，旧评审内容已隐藏；原请求保留，请重新读取' }
  const unsubscribeAuth = onAuthPrincipalChange(invalidate)
  const storageChanged = (event: StorageEvent) => { if ((!event.storageArea || event.storageArea === localStorage) && (event.key === null || event.key === EXPLICIT_SESSION_ORG_KEY || (TOKEN_KEYS as readonly string[]).includes(event.key))) invalidate() }
  window.addEventListener('storage', storageChanged)
  async function authority(scope: RequestScope, expected = state.owner): Promise<WeldingOwner> {
    check(scope); const owner = await client.authority(scope); check(scope)
    if (expected && !equal(owner, expected)) { invalidate(); throw new Error('账号、组织或映射已变化，原请求保留') }
    return owner
  }
  async function storage(scope: RequestScope) {
    check(scope)
    if (!storePromise) storePromise = (options.openStore ?? openGenerationRecoveryStore)().then(value => {
      if (disposed) { value.close(); throw new Error('页面已关闭') }; store = value; unsubscribeStore = value.subscribe?.(storeChanged); return value
    }).catch(error => { storePromise = null; throw error })
    const db = await storePromise; check(scope); return db
  }
  function gate(scope: RequestScope, pending: boolean, plan = state.planId, version = state.versionId) {
    check(scope)
    if (s.planId === plan && s.versionId === version) session.setWorkflowPending(scope, pending)
  }
  async function readPending(scope: RequestScope, owner: WeldingOwner) {
    const serial = ++pendingRead, db = await storage(scope); check(scope)
    const value = await db.getWorkflow(owner, state.planId, state.versionId, scope); check(scope)
    await authority(scope, owner); check(scope)
    if (serial === pendingRead) { state.pending = value; state.storageBlocked = false; gate(scope, Boolean(value)) }
    return value
  }
  function storeChanged(event?: Event) {
    if (disposed || !options.active() || !state.planId || !state.versionId) return
    const scope = capture(); if (!scope.accepts()) return
    pendingRead++
    // Keep the initiating click available; mutation admission still rereads the original.
    if (event?.type !== 'focus') gate(scope, true)
    const refresh = authority(scope).then(owner => readPending(scope, owner)).then(() => {}).catch(error => {
      if (!scope.accepts()) return
      state.storageBlocked = true; gate(scope, true); state.message = error instanceof Error ? error.message : '原评审请求无法核对'
    })
    session.trackCommandRefresh(refresh)
  }
  window.addEventListener('focus', storeChanged)
  session.setWorkflowAdmission(async (scope, mode, target, action) => {
    need(!disposed, '评审原请求核对已关闭，编制动作未发送'); check(scope)
    if (s.planId === target.plan_id && s.versionId === target.item_version_id) session.setWorkflowPending(scope, true)
    const owner = await authority(scope, s.owner); check(scope)
    return withGenerationOwnerLock(owner, scope, async locked => {
      try {
        const db = await storage(locked); check(locked)
        const pending = target.item_version_id === null ? null : await db.getWorkflow(owner, target.plan_id, target.item_version_id, locked); check(locked)
        await authority(locked, owner); check(locked)
        if (s.planId === target.plan_id && s.versionId === target.item_version_id) session.setWorkflowPending(locked, Boolean(pending))
        if (mode !== 'original') need(!pending, '此目标的原评审请求仍待确认；动作未发送')
        if (mode !== 'original' && target.item_version_id && !s.pending && s.planId === target.plan_id && s.versionId === target.item_version_id) {
          const current = await client.readReviewState(target.plan_id, target.item_version_id, owner, locked); check(locked)
          await authority(locked, owner); check(locked)
          if (current.state !== 'Draft' || current.draft_seq !== s.draftSeq || current.content_hash !== s.contentHash || !current.is_current) {
            session.lockWorkflowBody({ plan_id: target.plan_id, item_version_id: target.item_version_id }, locked); throw new Error('正文状态或保存点已变化，请重新读取；动作未发送')
          }
        }
      } catch (error) {
        if (locked.accepts() && s.planId === target.plan_id && s.versionId === target.item_version_id) session.setWorkflowPending(locked, true)
        throw error
      }
      return action(locked)
    })
  })
  async function run(action: (scope: RequestScope) => Promise<void>) {
    if (state.working || disposed || !options.active() || !state.planId || !state.versionId) return
    stopReuseBoms(); stopPoll(); operation++; controller.abort(); controller = new AbortController(); const scope = capture(); state.working = true
    try { await action(scope) } catch (error) {
      if (!scope.accepts()) return
      state.current = null; state.history = null; state.validation = null
      state.message = `${error instanceof Error ? error.message : '评审动作无法确认'}${state.pending ? '；原请求保留' : ''}`
    } finally { if (scope.accepts()) { state.working = false; schedulePoll() } }
  }
  async function readState(scope: RequestScope, owner: WeldingOwner) {
    const current = await client.readReviewState(state.planId, state.versionId, owner, scope); check(scope)
    await authority(scope, owner); check(scope); state.current = current; state.owner = clone(owner)
    return current
  }
  async function refresh(offset = 0) {
    await run(async scope => {
      const owner = await authority(scope); check(scope)
      let storageMessage = ''
      try { await readPending(scope, owner); check(scope) }
      catch (error) { check(scope); state.storageBlocked = true; gate(scope, true); storageMessage = error instanceof Error ? error.message : '原评审请求存储不可用' }
      await readState(scope, owner); check(scope)
      const history = await client.readReviewHistory(state.planId, state.versionId, owner, offset, scope); check(scope)
      await authority(scope, owner); check(scope); state.history = history; state.message = storageMessage ? `已读取评审资料；${storageMessage}，新动作未开启` : '已读取当前评审状态与冻结历史'
    })
  }
  async function dispatch(original: WorkflowOriginal | ReuseOriginal, scope: RequestScope): Promise<WorkflowAck | FinalGenerationAck | RevisionAck | ReuseAck> {
    if (original.action === 'reuse') return client.reusePlan(original.plan_id, original.item_version_id, original.body, scope)
    if (original.action === 'revise') return client.reviseWorkflowPlan(original.plan_id, original.item_version_id, original.body, scope)
    if (original.action === 'submit') return client.submitWorkflowPlan(original.plan_id, original.item_version_id, original.body, scope)
    if (original.action === 'review') return client.reviewWorkflowPlan(original.plan_id, original.item_version_id, original.body, scope)
    if (original.action === 'withdraw') return client.withdrawWorkflowPlan(original.plan_id, original.item_version_id, original.body, scope)
    if (original.action === 'final-render') return client.createFinalGeneration(original.plan_id, original.item_version_id, original.body, scope)
    if (original.action === 'final-retry') return client.retryFinalGeneration(original.basis, original.body, scope)
    if (original.action === 'release') return client.releaseWorkflowPlan(original.plan_id, original.item_version_id, original.body, scope)
    return client.reopenWorkflowPlan(original.plan_id, original.item_version_id, original.body, scope)
  }
  async function complete(rawAck: WorkflowAck | FinalGenerationAck | RevisionAck | ReuseAck, original: WorkflowPending, scope: RequestScope, db: CommandRecoveryStore) {
    if (original.action === 'reuse') {
      const ack = validateReuseAck(rawAck, original); check(scope); await authority(scope, original.owner); check(scope)
      need(jsonBytes(await db.getWorkflow(original.owner, original.plan_id, original.item_version_id, scope)) === jsonBytes(original), '原复用记录已变化'); check(scope)
      state.reuseAck = ack; state.pending = original; gate(scope, true); state.message = '独立草稿已建立；请明确打开目标计划，来源原请求保留'; return
    }
    if (original.action === 'revise') {
      const ack = validateRevisionAck(rawAck, original); check(scope); await authority(scope, original.owner); check(scope)
      need(equal(await db.getWorkflow(original.owner, original.plan_id, original.item_version_id, scope), original), '原修订记录已变化'); check(scope)
      state.revisionAck = ack; state.pending = original; gate(scope, true); state.message = '修订已建立；请明确打开目标版本，原请求保留'; return
    }
    const ack = original.action === 'final-render' || original.action === 'final-retry' ? validateFinalAck(rawAck, original) : validateWorkflowAck(rawAck, original); check(scope); await authority(scope, original.owner); check(scope)
    session.lockWorkflowBody(original, scope)
    need(await db.clearWorkflow(original, scope), '动作已确认，但原记录已变化；请重新核对'); check(scope)
    await readPending(scope, original.owner); check(scope)
    state.message = '原评审动作已确认'
    try {
      await readState(scope, original.owner); check(scope)
      const history = await client.readReviewHistory(original.plan_id, original.item_version_id, original.owner, 0, scope); check(scope)
      await authority(scope, original.owner); check(scope); state.history = history
      await session.refreshWorkflowBody(original, scope); check(scope)
      state.message = `评审动作已确认：${'state' in ack ? ack.state : '批准文件任务已接受'}`
    } catch (error) {
      check(scope); state.message = `动作已确认，正文或评审资料尚未刷新；${error instanceof Error ? error.message : '请重新读取'}`
    }
  }
  async function command(action: CommandAction, input: { generation?: ReviewGeneration; reviewer?: number; opinion?: string; reason?: string }) {
    if (!canAction(action)) return
    await run(async scope => {
      const owner = await authority(scope), displayed = clone(state.current); check(scope); need(displayed)
      await session.withWorkflowPoint(displayed, action === 'submit', scope, captured => withGenerationOwnerLock(owner, captured, async locked => {
        const db = await storage(locked); check(locked)
        need(!await db.getWorkflow(owner, state.planId, state.versionId, locked), '原评审请求仍待确认'); check(locked)
        const generationPending = await db.get(owner, locked); check(locked)
        need(!generationPending || generationPending.plan_id !== state.planId || generationPending.item_version_id !== state.versionId, '此目标的原生成请求仍待确认')
        const current = await client.readReviewState(state.planId, state.versionId, owner, locked); check(locked); await authority(locked, owner); check(locked)
        need(current.is_current && current.allowed_actions.includes(action) && current.draft_seq === displayed.draft_seq && current.content_hash === displayed.content_hash && equal(current.approval, displayed.approval), '评审资格或固定依据已变化，请重新读取')
        const base = { request_id: uuid(), expected_draft_seq: current.draft_seq, expected_content_hash: current.content_hash }
        let original: WorkflowOriginal
        if (action === 'revise') {
          need(current.state === 'Released' && current.publication && current.publication.draft_seq === current.draft_seq && current.publication.content_hash === current.content_hash && equal(current.publication, displayed.publication), '正式来源或修订资格已变化')
          original = { plan_id: state.planId, item_version_id: state.versionId, action, body: { ...base, source_publication_id: current.publication.publication_id, reason: input.reason ?? '' } }
        } else if (action === 'submit') {
          need(current.state === 'Draft' && input.generation?.status === 'Ready', '请选择已完成的评审生成物')
          need(input.reviewer !== owner.rbac_user_id, '请选择其他评审人')
          const generation = await client.readReviewGeneration(input.generation.generation_id, locked); check(locked)
          need(generation.status === 'Ready' && generation.plan_id === state.planId && generation.item_version_id === state.versionId && generation.draft_seq === current.draft_seq && generation.plan_content_hash === current.content_hash && equal(generation, input.generation), '评审生成物与当前保存点不一致')
          original = { plan_id: state.planId, item_version_id: state.versionId, action: 'submit', body: { ...base, review_generation_id: generation.generation_id, reviewer_rbac_id: input.reviewer! } }
        } else {
          const approval = current.approval; need(approval)
          const approved = { ...base, approval_request_id: approval.approval_request_id, expected_submission_hash: approval.submission_hash }
          if (action === 'final-render' || action === 'final-retry' || action === 'release') {
            need(current.state === 'Approved' && approval.state === 'approved' && approval.decision?.decision.decision === 'approve', '需要已批准的固定资料')
            const decision = { ...approved, expected_decision_hash: approval.decision.decision_hash }
            if (action === 'final-render') {
              need(current.final_profile && equal(current.final_profile, displayed.final_profile), '批准文件模板已变化，请重新读取')
              original = { plan_id: state.planId, item_version_id: state.versionId, action, body: { ...decision, template_id: current.final_profile.id, template_version: current.final_profile.version, template_digest: current.final_profile.digest } }
            } else {
              need(current.final_generation && equal(current.final_generation, displayed.final_generation), '批准生成任务已变化，请重新读取')
              const basis = finalGenerationBasis(current.final_generation), fresh = await client.readFinalGeneration(basis, locked); check(locked)
              await authority(locked, owner); check(locked)
              need(equal(fresh, current.final_generation) && fresh.status === (action === 'release' ? 'Ready' : 'Failed'), '批准生成状态或文件已变化，动作未发送')
              if (action === 'final-retry') original = { plan_id: state.planId, item_version_id: state.versionId, action, body: { request_id: base.request_id, expected_attempt: fresh.attempt }, basis }
              else {
                need(fresh.files.pdf && fresh.files.docx)
                original = { plan_id: state.planId, item_version_id: state.versionId, action, body: { ...decision, final_generation_id: basis.generation_id, expected_final_pdf_sha256: fresh.files.pdf.artifact_sha256, expected_final_docx_sha256: fresh.files.docx.artifact_sha256 } }
              }
            }
          } else if (action === 'approve' || action === 'reject') {
            need(current.state === 'InReview' && approval.submission.reviewer.auth_user_id === owner.auth_user_id && approval.submission.reviewer.rbac_user_id === owner.rbac_user_id, '当前身份不是指定评审人')
            original = { plan_id: state.planId, item_version_id: state.versionId, action: 'review', body: { ...approved, decision: action, opinion: input.opinion ?? '' } }
          } else {
            need(current.state === (action === 'withdraw' ? 'InReview' : 'Approved'))
            original = { plan_id: state.planId, item_version_id: state.versionId, action, body: { ...approved, reason: input.reason ?? '' } }
          }
        }
        validateWorkflowBody(original.action, original.body)
        const pending = validateWorkflowPending({ ...original, schema: 'metasheet.welding_command_pending/1', kind: 'workflow', owner })
        need(await db.claimWorkflow(pending, locked), '已有原请求，未发送新动作'); check(locked)
        state.pending = pending; gate(locked, true)
        await authority(locked, owner); check(locked); need(options.writable(), '当前写入已关闭，原请求保留')
        need(equal(await db.getWorkflow(owner, pending.plan_id, pending.item_version_id, locked), pending)); check(locked)
        const ack = await dispatch(pending, locked); check(locked); await complete(ack, pending, locked, db)
      }))
    })
  }
  async function resolve() {
    if (!canResolve.value) return
    if (state.pending?.action === 'reuse') return resolveReuse()
    await run(async scope => {
      const owner = await authority(scope), db = await storage(scope); check(scope)
      const original = await readPending(scope, owner); check(scope); need(original && original.action !== 'reuse')
      const ack = await client.resolveWorkflowReceipt(original, scope); check(scope); await authority(scope, owner); check(scope)
      if (!ack) { state.message = '原评审请求结果仍待确认；可明确重发同一原请求'; return }
      await withGenerationOwnerLock(owner, scope, locked => complete(ack, original, locked, db))
    })
  }
  async function replay() {
    if (!canReplay.value) return
    if (state.pending?.action === 'reuse') return replayReuse()
    await run(async scope => {
      const owner = await authority(scope), expected = await readPending(scope, owner); check(scope); need(expected)
      const point = clone(state.current)
      const send = (captured: RequestScope) => withGenerationOwnerLock(owner, captured, async locked => {
        const db = await storage(locked), original = await readPending(locked, owner); check(locked); need(original && equal(original, expected), '原评审记录已变化，请重新读取')
        const generation = await db.get(owner, locked); check(locked)
        need(!generation || generation.plan_id !== original.plan_id || generation.item_version_id !== original.item_version_id, '此目标的原生成请求仍待确认')
        await authority(locked, owner); check(locked); need(options.writable())
        const ack = await dispatch(original, locked); check(locked); await complete(ack, original, locked, db)
      })
      if (point) await session.withWorkflowPoint(point, false, scope, send)
      else { need(!attached(), '请先读取当前评审依据并核对正文'); await send(scope) }
    })
  }
  async function openRevisionTarget() {
    if (!canOpenRevision.value) return
    await run(async scope => {
      const original = clone(state.pending!); need(original.action === 'revise')
      const ack = validateRevisionAck(state.revisionAck, original), owner = await authority(scope, original.owner), db = await storage(scope); check(scope)
      await withGenerationOwnerLock(owner, scope, async locked => {
        need(equal(await db.getWorkflow(owner, original.plan_id, original.item_version_id, locked), original), '原修订记录已变化'); check(locked)
        const targetClear = async () => {
          need(!await db.getWorkflow(owner, ack.plan_id, ack.target_version_id, locked), '目标有原评审请求待核对'); check(locked)
          const generation = await db.get(owner, locked); check(locked)
          need(!generation || generation.plan_id !== ack.plan_id || generation.item_version_id !== ack.target_version_id, '目标有原生成请求待核对')
        }
        await targetClear()
        const prepared = await session.prepareRevisionTarget(ack, original, locked); check(locked)
        await targetClear(); await authority(locked, owner); check(locked)
        need(equal(await db.getWorkflow(owner, original.plan_id, original.item_version_id, locked), original), '原修订记录已变化'); check(locked)
        const cleanup = { original: clone(original), ack: clone(ack), opened: prepared.opened, signature: readAuthSessionSignature(), identity: identityEpoch, serial: ++cleanupSerial }
        const opened = session.applyRevisionTarget(prepared)
        need(opened.plan_id === ack.plan_id && opened.item_version_id === ack.target_version_id, '真实目标未打开；原请求保留')
        state.revisionCleanup = cleanup
        state.message = '目标已打开；原修订请求仍待核对，请明确清理'
      })
    })
  }
  async function cleanupTarget(kind: 'revisionCleanup' | 'reuseCleanup') {
    if (!options.active() || state.working || !state[kind]) return
    const context = state[kind]!, label = kind === 'reuseCleanup' ? '复用' : '修订', signature = readAuthSessionSignature(), identity = identityEpoch, startedOperation = operation
    cleanupController.abort(); cleanupController = new AbortController()
    const scope: RequestScope = { signal: cleanupController.signal, accepts: () => !disposed && options.active() && Boolean(readStoredToken()) && signature === readAuthSessionSignature() && identity === identityEpoch && context.signature === signature && context.identity === identity && context.serial === cleanupSerial && state[kind] === context }
    state.working = true
    try {
      const owner = await authority(scope, context.original.owner); check(scope)
      await withGenerationOwnerLock(owner, scope, async locked => {
        const db = await storage(locked); check(locked)
        need(equal(await db.getWorkflow(owner, context.original.plan_id, context.original.item_version_id, locked), context.original), '原记录已变化；请回来源核对'); check(locked)
        await authority(locked, owner); check(locked)
        need(await db.clearWorkflow(context.original, locked), '原记录未清理，请重新核对'); check(locked)
        state[kind] = null; cleanupSerial++; state.message = `目标已打开，原${label}请求已明确清理`
      })
    } catch (error) { if (scope.accepts()) state.message = `目标已打开，原${label}请求仍待核对；${error instanceof Error ? error.message : '清理未确认'}` }
    finally { if (!disposed && operation === startedOperation && identity === identityEpoch && signature === readAuthSessionSignature()) state.working = false }
  }
  const cleanupRevision = () => cleanupTarget('revisionCleanup')
  const cleanupReuse = () => cleanupTarget('reuseCleanup')
  async function searchReuseProducts(query: string) {
    if (state.pending) return
    await run(async base => {
      reuse.products = []; const scope = reuseSelectionScope(base)
      try { const owner = await authority(scope); const items = await client.reuseProductCandidates(query, scope); check(scope); await authority(scope, owner); check(scope); reuse.products = items }
      catch (error) { if (scope.accepts()) throw error }
    })
  }
  async function selectReuseProduct(product: PlanCandidate) {
    if (state.pending) return
    await run(async base => {
      reuse.product = null; reuse.boms = []; reuse.bom = null; reuse.bomMessage = ''
      const scope = reuseSelectionScope(base)
      try {
        need(reuse.products.some(item => equal(item, product)) && product.item_id !== s.savedPoint?.payload.product?.item_id, '请选择另一固定产品')
        const owner = await authority(scope), fixed = await client.reuseProductContext(product, scope); check(scope)
        await authority(scope, owner); check(scope)
        reuse.product = { item_id: fixed.item_id, version_id: fixed.version_id }
      } catch (error) { if (scope.accepts()) throw error }
    })
  }
  async function loadReuseBoms() {
    if (disposed || !options.active() || state.working || state.pending || s.commandPending || reuse.bomWorking || !reuse.product || !state.owner || !reuseWeldIds.value.length) return
    stopReuseBoms()
    const signal = reuseBomController.signal, base = reuseSelectionScope(readScope(signal)), serial = operation
    const product = clone(reuse.product), owner = clone(state.owner)
    const scope: RequestScope = { signal, accepts: () => base.accepts() && serial === operation && equal(reuse.product, product) && Boolean(reuseWeldIds.value.length) }
    reuse.boms = []; reuse.bom = null; reuse.bomMessage = ''; reuse.bomWorking = true
    try {
      await authority(scope, owner); check(scope)
      let items: ReuseBomCandidate[]
      try { items = await client.reuseBomCandidates(product, scope) }
      catch {
        check(scope); await authority(scope, owner); check(scope)
        reuse.bomMessage = '可选 BOM 暂不可用；可明确不采用 BOM'
        return
      }
      check(scope); await authority(scope, owner); check(scope)
      reuse.boms = items
      reuse.bomMessage = items.length ? '已读取可选 BOM；请明确选择，或不采用 BOM' : '没有可见的可选 BOM；可明确不采用 BOM'
    } catch {
      if (scope.accepts()) { invalidate(); state.message = '身份核验未确认，旧内容已隐藏；请重新读取' }
    } finally { if (reuseBomController.signal === signal) reuse.bomWorking = false }
  }
  async function searchReuseDrawings(query: string) {
    await run(async scope => { const owner = await authority(scope); const items = await client.drawingCandidates(query, scope); check(scope); await authority(scope, owner); check(scope); reuse.drawings = items })
  }
  function selectReuseDrawing(drawing: DrawingCandidate) {
    if (!options.active() || state.working || !reuse.drawings.some(item => equal(item, drawing))) return
    reuse.drawing = { item_id: drawing.item_id, version_id: drawing.version_id, file_id: drawing.file_id, file_role: drawing.file_role, expected_checksum: drawing.checksum.toLowerCase() }
  }
  function selectReuseBom(candidate: ReuseBomCandidate | null) {
    if (!options.active() || state.working || state.pending || candidate && (reuse.bomWorking || !reuse.boms.some(item => equal(item, candidate)))) return
    reuse.bom = candidate ? { baseline_id: candidate.baseline_id, expected_fingerprint: candidate.fingerprint } : null
  }
  async function createReuse() {
    if (!canCreateReuse.value) return
    const form = clone(reuse), displayed = clone(state.current!)
    await run(async scope => {
      const owner = await authority(scope); check(scope)
      await session.withWorkflowPoint(displayed, false, scope, captured => withGenerationOwnerLock(owner, captured, async locked => {
        const db = await storage(locked); check(locked)
        need(!await db.getWorkflow(owner, state.planId, state.versionId, locked), '此来源已有原请求'); check(locked)
        const generation = await db.get(owner, locked); check(locked)
        need(!generation || generation.plan_id !== state.planId || generation.item_version_id !== state.versionId, '此来源已有原生成请求')
        const current = await client.readReviewState(state.planId, state.versionId, owner, locked); check(locked); await authority(locked, owner); check(locked)
        need(equal(current.publication, displayed.publication) && equal(current.approval, displayed.approval), '正式来源已变化，请重新读取')
        const body = reuseBody(uuid(), uuid(), form, current)
        const pending = validateWorkflowPending({ schema: 'metasheet.welding_command_pending/1', kind: 'workflow', owner, plan_id: state.planId, item_version_id: state.versionId, action: 'reuse', body })
        need(await db.claimWorkflow(pending, locked), '已有原请求，未发送复用'); check(locked)
        state.pending = pending; gate(locked, true)
        need(jsonBytes(await db.getWorkflow(owner, pending.plan_id, pending.item_version_id, locked)) === jsonBytes(pending), '原复用请求持久化未确认'); check(locked)
        await authority(locked, owner); check(locked); need(options.writable(), '当前写入已关闭，原请求保留')
        const ack = await dispatch(pending, locked); check(locked); await complete(ack, pending, locked, db)
      }))
    })
  }
  async function resolveReuse() {
    if (!canResolve.value || state.pending?.action !== 'reuse') return
    await run(async scope => {
      const owner = await authority(scope), db = await storage(scope), original = await readPending(scope, owner); check(scope); need(original?.action === 'reuse')
      const ack = await client.resolveReuseReceipt(original, scope); check(scope); await authority(scope, owner); check(scope)
      if (!ack) { state.message = '原复用请求结果仍待确认；可明确重发同一原请求'; return }
      await withGenerationOwnerLock(owner, scope, locked => complete(ack, original, locked, db))
    })
  }
  async function replayReuse() {
    if (!canReplay.value || state.pending?.action !== 'reuse') return
    await run(async scope => {
      const owner = await authority(scope), expected = clone(state.pending); check(scope)
      await withGenerationOwnerLock(owner, scope, async locked => {
        const db = await storage(locked), original = await readPending(locked, owner); check(locked); need(original?.action === 'reuse' && jsonBytes(original) === jsonBytes(expected), '原复用请求已变化')
        const generation = await db.get(owner, locked); check(locked)
        need(!generation || generation.plan_id !== original.plan_id || generation.item_version_id !== original.item_version_id, '此来源已有原生成请求')
        await authority(locked, owner); check(locked); need(options.writable())
        const ack = await dispatch(original, locked); check(locked); await complete(ack, original, locked, db)
      })
    })
  }
  async function openReuseTarget() {
    if (!canOpenReuse.value) return
    await run(async scope => {
      const original = clone(state.pending!); need(original.action === 'reuse')
      const ack = validateReuseAck(state.reuseAck, original), owner = await authority(scope, original.owner), db = await storage(scope); check(scope)
      await withGenerationOwnerLock(owner, scope, async locked => {
        need(jsonBytes(await db.getWorkflow(owner, original.plan_id, original.item_version_id, locked)) === jsonBytes(original), '原复用记录已变化'); check(locked)
        const targetClear = async () => {
          need(!await db.getWorkflow(owner, ack.target_plan_id, ack.target_version_id, locked), '目标有原评审请求待核对'); check(locked)
          const generation = await db.get(owner, locked); check(locked)
          need(!generation || generation.plan_id !== ack.target_plan_id || generation.item_version_id !== ack.target_version_id, '目标有原生成请求待核对')
        }
        await targetClear(); const prepared = await session.prepareReuseTarget(ack, original, locked); check(locked)
        await targetClear(); await authority(locked, owner); check(locked)
        need(jsonBytes(await db.getWorkflow(owner, original.plan_id, original.item_version_id, locked)) === jsonBytes(original), '原复用记录已变化'); check(locked)
        const cleanup: ReuseCleanup = { original: clone(original), ack: clone(ack), opened: prepared.opened, signature: readAuthSessionSignature(), identity: identityEpoch, serial: ++cleanupSerial }
        const opened = session.applyReuseTarget(prepared)
        need(opened.plan_id === ack.target_plan_id && opened.item_version_id === ack.target_version_id, '独立目标未打开；原请求保留')
        state.reuseCleanup = cleanup; state.message = '独立目标已打开；来源原请求保留，请单独明确清理'
      })
    })
  }
  async function readReuseProvenance() {
    if (!options.active() || !state.planId || !state.versionId || provenance.working) return
    const serial = ++provenanceSerial, scope = readScope(provenanceController.signal), plan = state.planId, version = state.versionId
    provenance.working = true; provenance.current = null
    try {
      const owner = await authority(scope); check(scope)
      const value = validateReuseProvenance(await client.readReuseProvenance(plan, version, owner, scope), plan, version, owner); check(scope)
      await authority(scope, owner); check(scope); if (serial !== provenanceSerial) return
      provenance.current = value; provenance.message = '已读取初始采用来源；目标后续版本由服务授权核验'
    } catch (error) { if (scope.accepts() && serial === provenanceSerial) { provenance.current = null; provenance.message = error instanceof Error ? error.message : '复用来源无法读取' } }
    finally { if (scope.accepts() && serial === provenanceSerial) provenance.working = false }
  }
  async function validate() {
    if (!state.current || state.working) return
    await run(async scope => {
      const owner = await authority(scope), current = await readState(scope, owner); check(scope)
      const value = await client.validateWorkflowPlan(state.planId, state.versionId, { expected_draft_seq: current.draft_seq, expected_content_hash: current.content_hash }, scope); check(scope)
      await authority(scope, owner); check(scope); state.validation = value; state.message = value.ready ? '当前保存点可提交评审' : '当前保存点尚需完成检查'
    })
  }
  function schedulePoll() {
    clearTimeout(pollTimer); pollTimer = undefined
    if (!disposed && options.active() && ['Queued', 'Running'].includes(state.current?.final_generation?.status ?? '')) pollTimer = setTimeout(() => { void refreshFinal() }, 2000)
  }
  async function refreshFinal() {
    if (state.polling || state.working || disposed || !options.active() || !state.current?.final_generation || !state.owner) return
    clearTimeout(pollTimer); pollTimer = undefined
    const fixed = finalGenerationBasis(state.current.final_generation), owner = clone(state.owner), serial = ++pollSerial, command = operation, base = readScope(pollController.signal)
    const scope: RequestScope = { signal: base.signal, accepts: () => base.accepts() && serial === pollSerial && command === operation && state.current?.final_generation?.generation_id === fixed.generation_id }
    state.polling = true; let next = false
    try {
      await authority(scope, owner); check(scope)
      const value = await client.readFinalGeneration(fixed, scope); check(scope); await authority(scope, owner); check(scope)
      need(equal(finalGenerationBasis(value), fixed) && value.state === state.current?.state, '批准文件依据或版本状态已变化，请重新读取')
      if (value.status === 'Ready' || value.status === 'Failed') {
        const current = await client.readReviewState(state.planId, state.versionId, owner, scope); check(scope); await authority(scope, owner); check(scope)
        need(current.final_generation && equal(finalGenerationBasis(current.final_generation), fixed), '批准生成任务已变化，请重新读取')
        state.current = current
      } else { state.current!.final_generation = value; next = true }
      state.message = '已读取批准文件任务状态'
    } catch (error) { if (scope.accepts()) state.message = `批准文件状态未刷新；${error instanceof Error ? error.message : '请重新读取'}` }
    finally { if (serial === pollSerial) { state.polling = false; if (next && scope.accepts()) schedulePoll() } }
  }
  async function downloadPublication(format: 'pdf' | 'docx') {
    if (!canDownloadPublication.value || !state.owner) return
    const selected = clone(state.current!.publication!), owner = clone(state.owner), serial = ++downloadSerial, scope = readScope(downloadController.signal)
    state.downloading = true
    try {
      await authority(scope, owner); check(scope)
      const before = await client.readPublication(selected.plan_id, selected.item_version_id, scope); check(scope); need(equal(before, selected), '正式归档已变化，请重新读取')
      const blob = await client.downloadPublicationFile(before, format, scope); check(scope)
      const after = await client.readPublication(selected.plan_id, selected.item_version_id, scope); check(scope); await authority(scope, owner); check(scope)
      need(equal(before, after) && equal(state.current?.publication, selected), '正式归档或文件选择已变化，未提供下载')
      const url = URL.createObjectURL(blob), anchor = document.createElement('a'); let clicked = false
      try { anchor.href = url; anchor.download = `welding-publication.${format}`; document.body.append(anchor); anchor.click(); clicked = true }
      finally {
        anchor.remove()
        if (clicked) downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url) }, 1000))
        else URL.revokeObjectURL(url)
      }
      state.message = `已提供正式 ${format.toUpperCase()} 文件`
    } catch (error) { if (scope.accepts()) state.message = error instanceof Error ? error.message : '正式文件无法读取' }
    finally { if (serial === downloadSerial) state.downloading = false }
  }
  const formal = reactive({ planId: '', versionId: '', owner: null as WeldingOwner | null, working: false, downloading: false, message: '', directory: null as PublicationDirectory | null,
    selected: null as Publication | null, from: null as Publication | null, to: null as Publication | null, comparison: null as PublicationComparison | null })
  let formalEpoch = 0, formalOperation = 0, formalController = new AbortController()
  function hideFormal() {
    formalEpoch++; formalOperation++; formalController.abort(); formalController = new AbortController(); releaseDownloads()
    Object.assign(formal, { owner: null, directory: null, selected: null, from: null, to: null, comparison: null, working: false, downloading: false })
  }
  function formalScope(): RequestScope {
    const epoch = formalEpoch, serial = formalOperation, signature = readAuthSessionSignature(), plan = formal.planId
    return { signal: formalController.signal, accepts: () => !disposed && options.active() && epoch === formalEpoch && serial === formalOperation && signature === readAuthSessionSignature() && Boolean(readStoredToken()) && plan === formal.planId }
  }
  async function formalOwner(scope: RequestScope, expected = formal.owner) {
    const owner = await client.authority(scope); check(scope)
    if (expected && !equal(owner, expected)) { invalidate(); throw new Error('正式读取身份或组织已变化') }
    return owner
  }
  async function formalRun(action: (scope: RequestScope, owner: WeldingOwner) => Promise<void>) {
    if (disposed || !options.active() || !formal.planId || formal.working) return
    formalOperation++; formalController.abort(); formalController = new AbortController(); formal.downloading = false
    const scope = formalScope(); formal.working = true
    try { const owner = await formalOwner(scope); check(scope); await action(scope, owner); check(scope); formal.owner = owner }
    catch (error) { if (scope.accepts()) { formal.directory = null; formal.selected = null; formal.from = null; formal.to = null; formal.comparison = null; formal.message = error instanceof Error ? error.message : '正式文件读取失败' } }
    finally { if (scope.accepts()) formal.working = false }
  }
  const entryMatches = (entry: PublicationEntry, value: Publication) => entry.publication_id === value.publication_id && entry.item_version_id === value.item_version_id && entry.version_label === value.version_label && entry.content_hash === value.content_hash && entry.published_at === value.published_at
  async function refreshFormal(offset = formal.directory?.offset ?? 0) {
    await formalRun(async (scope, owner) => {
      const selections = { selected: formal.selected, from: formal.from, to: formal.to }
      const directory = await client.readPublications(formal.planId, offset, scope); check(scope)
      for (const key of ['selected', 'from', 'to'] as const) {
        const selected = selections[key]
        if (selected) { const fresh = await client.readPublication(formal.planId, selected.item_version_id, scope); check(scope); need(entryMatches(selected, fresh), '选定正式归档已变化'); selections[key] = fresh }
      }
      let message = '已读取可见正式目录'
      if (!selections.selected && formal.versionId) {
        try { const selected = await client.readPublication(formal.planId, formal.versionId, scope); check(scope); selections.selected = selected }
        catch (error) { check(scope); if (!(error instanceof WeldingPlanError) || ![403, 404].includes(error.status)) throw error; message = '已读取正式目录；此选定版本没有可见正式文件' }
      }
      check(scope); await formalOwner(scope, owner); check(scope)
      Object.assign(formal, selections, { directory, comparison: null, message })
    })
  }
  async function setFormalTarget(plan: string, version: string) {
    if (formal.planId !== plan || formal.versionId !== version) { hideFormal(); formal.planId = plan; formal.versionId = version; formal.message = '' }
    if (plan) await refreshFormal(0)
  }
  async function selectFormal(entry: PublicationEntry, side: 'selected' | 'from' | 'to') {
    await formalRun(async (scope, owner) => {
      formal.comparison = null
      const value = await client.readPublication(formal.planId, entry.item_version_id, scope); check(scope)
      need(entryMatches(entry, value), '选定正式归档与目录不一致'); await formalOwner(scope, owner); check(scope); formal[side] = value; formal.message = '已读取选定正式版本'
    })
  }
  async function compareFormal() {
    if (!formal.from || !formal.to || formal.from.item_version_id === formal.to.item_version_id) return
    const from = clone(formal.from), to = clone(formal.to)
    await formalRun(async (scope, owner) => {
      formal.comparison = null
      const before = await client.readPublication(formal.planId, from.item_version_id, scope), after = await client.readPublication(formal.planId, to.item_version_id, scope); check(scope)
      need(entryMatches(from, before) && entryMatches(to, after), '选定正式归档已变化')
      const comparison = await client.comparePublications(formal.planId, from.item_version_id, to.item_version_id, scope); check(scope)
      for (const [side, publication] of [[comparison.from, from], [comparison.to, to]] as const) need(side.publication_id === publication.publication_id && side.item_version_id === publication.item_version_id && side.version_label === publication.version_label && side.content_hash === publication.content_hash, '比较依据与选定正式版本不一致')
      await formalOwner(scope, owner); check(scope); formal.comparison = comparison; formal.message = '已读取正式版本变化类别；原参数见两侧正式文件'
    })
  }
  async function downloadFormal(format: 'pdf' | 'docx', side: 'selected' | 'from' | 'to' = 'selected') {
    if (!formal[side] || formal.working || formal.downloading) return
    const selected = clone(formal[side]!), scope = formalScope(); formal.downloading = true
    try {
      const owner = await formalOwner(scope); check(scope)
      const before = await client.readPublication(formal.planId, selected.item_version_id, scope); check(scope); need(entryMatches(selected, before), '正式归档已变化')
      const blob = await client.downloadPublicationFile(before, format, scope); check(scope)
      const after = await client.readPublication(formal.planId, selected.item_version_id, scope); check(scope); await formalOwner(scope, owner); check(scope)
      need(equal(before, after) && equal(formal[side], selected), '正式归档或选择已变化')
      const url = URL.createObjectURL(blob), anchor = document.createElement('a'); let clicked = false
      try { anchor.href = url; anchor.download = `welding-${selected.item_version_id}.${format}`; document.body.append(anchor); anchor.click(); clicked = true }
      finally { anchor.remove(); if (clicked) downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url) }, 1000)); else URL.revokeObjectURL(url) }
      formal.message = `已提供正式 ${format.toUpperCase()} 文件`
    } catch (error) { if (scope.accepts()) { formal.directory = null; formal.selected = null; formal.from = null; formal.to = null; formal.comparison = null; formal.message = error instanceof Error ? error.message : '正式文件无法读取' } }
    finally { if (scope.accepts()) formal.downloading = false }
  }
  async function setTarget(plan: string, version: string) {
    if (state.planId !== plan || state.versionId !== version) { const cleanup = state.reuseCleanup ?? state.revisionCleanup; hide(Boolean(cleanup && cleanup.opened.plan_id === plan && cleanup.opened.item_version_id === version && cleanup.identity === identityEpoch && cleanup.signature === readAuthSessionSignature())); state.planId = plan; state.versionId = version; state.message = '' }
    if (!plan || !version) return
    gate(capture(), true)
    if (state.working) { storeChanged(); return }
    await refresh()
  }
  const stopTarget = watch(() => [s.planId, s.versionId] as const, ([plan, version]) => { if (plan && version) { void setTarget(plan, version); void setFormalTarget(plan, version) } else if (state.revisionCleanup || state.reuseCleanup) hide() })
  const stopActive = watch(options.active, active => { if (!active) { hideFormal(); hide() } })
  function dispose() {
    if (disposed) return
    disposed = true; hideFormal(); hide(); unsubscribeAuth(); unsubscribeStore?.(); stopTarget(); stopActive(); stopReuseSelection(); window.removeEventListener('storage', storageChanged); window.removeEventListener('focus', storeChanged); store?.close()
  }
  if (getCurrentScope()) onScopeDispose(dispose)
  return { state, reuse, provenance, reuseWeldIds, canCreateReuse, canOpenReuse, canCleanupReuse, createReuse, resolveReuse, replayReuse, openReuseTarget, cleanupReuse, searchReuseProducts, selectReuseProduct, loadReuseBoms, searchReuseDrawings, selectReuseDrawing, selectReuseBom, readReuseProvenance, formal, setFormalTarget, refreshFormal, selectFormal, compareFormal, downloadFormal, canOpenRevision, canCleanupRevision, openRevisionTarget, cleanupRevision, canAction, canResolve, canReplay, canDownloadPublication, refreshFinal, downloadPublication, refresh, setTarget, validate, resolve, replay, command, dispose }
}
