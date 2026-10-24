import { computed, getCurrentScope, onScopeDispose, reactive, watch } from 'vue'
import { clone, equal, need, isObject } from '../../services/welding/planRecovery'
import { generationBasis, validateReviewAck, validateReviewGeneration, validateTemplateOptions, WeldingPlanError, type GenerationBasis, type RenderTemplate, type ReviewGeneration, type RequestScope, type TemplateOptions } from '../../services/welding/planClient'
import { openGenerationRecoveryStore, validateGenerationPending, withGenerationOwnerLock, type GenerationPending, type GenerationRecoveryStore } from '../../services/welding/commandRecovery'
import type { useWeldingPlanSession } from './useWeldingPlanSession'

const blankOptions = (): TemplateOptions => ({ organization_name: '', header_text: '', footer_text: '', optional_columns: [], logo: null })
export function useWeldingGenerationSession(options: {
  session: ReturnType<typeof useWeldingPlanSession>; active: () => boolean; writable: () => boolean
  openStore?: () => Promise<GenerationRecoveryStore>; uuid?: () => string
}) {
  const session = options.session, s = session.state, client = session.client
  const state = reactive({ templates: [] as RenderTemplate[], templateIndex: -1, options: blankOptions(), working: false,
    storageBlocked: false, pending: null as GenerationPending | null, current: null as ReviewGeneration | null,
    items: [] as ReviewGeneration[], total: 0, offset: 0, message: '', previewUrl: '' })
  let disposed = false, epoch = 0, operation = 0, controller: AbortController | null = null
  let store: GenerationRecoveryStore | null = null, storePromise: Promise<GenerationRecoveryStore> | null = null
  let work: Promise<void> | null = null, poll: ReturnType<typeof setTimeout> | null = null, downloadUrl = ''
  let pendingRead = 0, unsubscribe: (() => void) | undefined
  const template = computed(() => state.templates[state.templateIndex])
  const commandReady = computed(() => options.active() && options.writable() && !state.working && !state.storageBlocked && !state.pending
    && !s.busy && !s.editBusy && !s.commandBusy && !s.commandPending && !s.dirty && !s.storageBlocked && !s.pending && !s.uncertain
    && !s.cadBusy && !s.atomicBusy && !s.blocked && s.serverState === 'Draft' && Boolean(s.savedPoint))
  const canCreate = computed(() => commandReady.value && Boolean(template.value?.available)
    && (isObject(s.savedPoint?.payload.overlay) && s.savedPoint.payload.overlay.schema === 'vemcad-weld-overlay/3') === (template.value?.version === '3'))
  const canRetry = computed(() => commandReady.value && state.current?.status === 'Failed')
  const canConfirm = computed(() => options.active() && options.writable() && !state.working && !state.storageBlocked && Boolean(state.pending) && !s.busy && !s.commandBusy && !s.pending && !s.cadBusy && !s.atomicBusy)
  function stopPoll() { if (poll !== null) clearTimeout(poll); poll = null }
  function clearFiles() {
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl)
    if (downloadUrl) URL.revokeObjectURL(downloadUrl)
    state.previewUrl = ''; downloadUrl = ''
  }
  function clearView() {
    epoch++; operation++; pendingRead++; controller?.abort(); controller = null; work = null; stopPoll(); clearFiles()
    Object.assign(state, { templates: [], templateIndex: -1, options: blankOptions(), working: false, pending: null, current: null, items: [], total: 0, offset: 0, storageBlocked: false })
  }
  function check(scope: RequestScope) { need(scope.accepts() && !scope.signal?.aborted, '会话、保存点或选择已变化，原请求保留') }
  async function fresh(scope: RequestScope) { check(scope); const owner = await session.fresh(scope); check(scope); return owner }
  async function storage(scope: RequestScope) {
    check(scope)
    if (!storePromise) storePromise = (options.openStore ?? openGenerationRecoveryStore)().then(value => {
      if (disposed) { value.close(); throw new Error('页面已关闭') }; store = value; unsubscribe = value.subscribe?.(storeChanged); return value
    }).catch(error => { storePromise = null; throw error })
    const db = await storePromise; check(scope); return db
  }
  function pendingGate(scope: RequestScope) { session.setCommandPending(scope, state.storageBlocked || Boolean(state.pending && state.pending.plan_id === s.planId && state.pending.item_version_id === s.versionId)) }
  async function readPending(scope: RequestScope) {
    const owner = clone(s.owner); need(owner); const serial = ++pendingRead
    return withGenerationOwnerLock(owner, scope, async locked => {
      need(equal(await fresh(locked), owner)); check(locked)
      const db = await storage(locked), pending = await db.get(owner, locked); check(locked)
      need(equal(await fresh(locked), owner)); check(locked)
      if (serial === pendingRead) { state.storageBlocked = false; state.pending = pending; pendingGate(locked) }
      return pending
    })
  }
  function storeChanged(event?: Event) {
    if (disposed || !options.active() || !s.owner || !s.versionId) return
    const scope = session.capture(false); if (!scope.accepts()) return
    pendingRead++
    // Returning from the CAD iframe can focus the window between pointerdown and click.
    if (event?.type !== 'focus') session.setCommandPending(scope, true)
    const refresh = readPending(scope).then(() => {}).catch(error => {
      if (!scope.accepts() || disposed) return
      state.storageBlocked = true; pendingGate(scope); state.message = error instanceof Error ? error.message : '跨页原请求无法核对'
    })
    session.trackCommandRefresh(refresh)
  }
  window.addEventListener('focus', storeChanged)
  session.setGenerationAdmission(async (scope, mode, target, action) => {
    check(scope); const owner = clone(s.owner); need(owner)
    return withGenerationOwnerLock(owner, scope, async locked => {
      let pending: GenerationPending | null
      try { pending = await readPending(locked); check(locked) }
      catch (error) {
        if (!disposed && locked.accepts() && !locked.signal?.aborted) { state.storageBlocked = true; pendingGate(locked) }
        throw error
      }
      if (mode === 'generation') need(!pending, '已有原生成请求，未发送新请求')
      else if (mode === 'edit') need(!pending || pending.plan_id !== target.plan_id || pending.item_version_id !== target.item_version_id, '此保存目标的原生成请求仍待确认；编制动作未发送')
      else need(pending, '原生成记录已变化，请重新读取')
      return action(locked)
    })
  })
  function failure(error: unknown, scope: RequestScope) {
    if (!scope.accepts()) return
    if (error instanceof WeldingPlanError && [401, 403, 404, 410].includes(error.status)) { stopPoll(); clearFiles(); state.current = null; state.items = []; state.templates = [] }
    state.message = `${error instanceof Error ? error.message : '生成操作无法确认'}${state.pending ? '；原请求仍待确认' : ''}`
  }
  function run(action: (scope: RequestScope) => Promise<void>): Promise<void> {
    if (state.working) return work ?? Promise.resolve()
    if (disposed || !options.active() || !s.owner) return Promise.resolve()
    const captured = session.capture(), capturedEpoch = epoch, serial = ++operation, local = new AbortController()
    controller = local
    const abort = () => local.abort(); captured.signal?.addEventListener('abort', abort, { once: true })
    if (captured.signal?.aborted) local.abort()
    const scope: RequestScope = { signal: local.signal, accepts: () => !disposed && options.active() && capturedEpoch === epoch && captured.accepts() && !local.signal.aborted }
    state.working = true
    work = (async () => {
      try { await action(scope) } catch (error) { failure(error, scope) }
      finally { captured.signal?.removeEventListener('abort', abort); if (serial === operation) { state.working = false; work = null; controller = null } }
    })()
    return work
  }
  async function status(scope: RequestScope, fixed: GenerationBasis) {
    stopPoll(); const owner = await fresh(scope)
    const record = validateReviewGeneration(await client.readReviewGeneration(fixed.generation_id, scope), fixed); check(scope)
    need(equal(await fresh(scope), owner)); check(scope)
    state.current = record
    if (record.status === 'Queued' || record.status === 'Running') {
      const selected = record.generation_id, capturedEpoch = epoch
      poll = setTimeout(() => { poll = null; if (!disposed && capturedEpoch === epoch && options.active() && state.current?.generation_id === selected) void run(next => status(next, fixed)) }, 3000)
    }
  }
  function refresh(offset = state.offset): Promise<void> {
    return run(async scope => {
      stopPoll(); const owner = await fresh(scope)
      try { await readPending(scope); check(scope) }
      catch (error) { check(scope); state.storageBlocked = true; pendingGate(scope); state.message = error instanceof Error ? error.message : '原请求存储不可用' }
      need(equal(await fresh(scope), owner)); check(scope)
      if (!s.versionId) return
      const templates = await client.renderTemplates(scope); check(scope)
      const listed = await client.listReviewGenerations(s.planId, s.versionId, offset, scope); check(scope)
      need(equal(await fresh(scope), owner)); check(scope)
      const oldTemplate = template.value, nextIndex = oldTemplate ? templates.findIndex(value => equal(value, oldTemplate)) : -1
      state.items = listed.items; state.total = listed.total; state.offset = listed.offset
      const selected = state.current
      if (selected) await status(scope, generationBasis(selected))
      check(scope)
      state.templates = templates
      if (nextIndex >= 0) state.templateIndex = nextIndex
      else { state.templateIndex = templates.findIndex(value => (isObject(s.savedPoint?.payload.overlay) && s.savedPoint.payload.overlay.schema === 'vemcad-weld-overlay/3') === (value.version === '3')); state.options = state.templateIndex >= 0 ? clone(templates[state.templateIndex].default_options) : blankOptions() }
      if (!state.storageBlocked) state.message = state.pending ? '发现原生成请求，结果待确认；请核对并重发原请求' : '已读取模板与固定评审任务'
    })
  }
  async function send(original: GenerationPending, scope: RequestScope) {
    const owner = await fresh(scope); need(equal(owner, original.owner), '原生成请求不属于当前身份')
    const db = await storage(scope); check(scope)
    need(equal(await db.get(owner, scope), original), '原生成记录已变化，未发送'); check(scope)
    if (original.action === 'retry') {
      const record = await client.readReviewGeneration(original.basis.generation_id, scope); check(scope)
      need(equal(generationBasis(record), original.basis), '重试固定生成依据已变化')
    }
    need(equal(await fresh(scope), owner)); check(scope); need(options.writable(), '当前生成写入未开启')
    const ack = original.action === 'create'
      ? validateReviewAck(await client.createReviewGeneration(original.plan_id, original.item_version_id, original.body, scope), original.body, original)
      : validateReviewAck(await client.retryReviewGeneration(original.basis, original.body, scope), original.body, original.basis)
    check(scope); need(equal(await fresh(scope), owner)); check(scope)
    need(await db.clear(original, scope), '原请求已确认，但另一页面的原件已变化；请重新核对'); check(scope)
    state.pending = null; pendingGate(scope)
    state.message = '原生成请求已确认；任务状态以服务器记录为准'
    if (ack.plan_id === s.planId && ack.item_version_id === s.versionId) await status(scope, generationBasis(ack))
  }
  function create() {
    if (!canCreate.value) return Promise.resolve()
    const selected = clone(template.value!); let configured: TemplateOptions
    try { configured = validateTemplateOptions(state.options) } catch { state.message = '请核对模板选项、固定附件和文字长度'; return Promise.resolve() }
    return run(runScope => session.withSavedPoint(async (scope, point) => {
      check(scope)
      need(equal(selected, template.value) && equal(configured, state.options), '模板选择已变化')
      const owner = await fresh(scope); check(scope)
      const original = validateGenerationPending({ schema: 'metasheet.welding_command_pending/1', kind: 'generation', action: 'create', owner,
        plan_id: point.plan_id, item_version_id: point.item_version_id, basis: null,
        body: { request_id: (options.uuid ?? (() => crypto.randomUUID()))(), expected_draft_seq: point.draft_seq, expected_content_hash: point.content_hash, purpose: 'review', template_id: selected.id, template_version: selected.version, template_digest: selected.digest, template_options: configured } })
      const db = await storage(scope); check(scope); need(equal(selected, template.value) && equal(configured, state.options), '模板选择已变化')
      state.storageBlocked = true; session.setCommandPending(scope, true); state.message = '正在保存原生成请求；确认完成前暂停编辑'
      const claimed = await db.claim(original, scope); check(scope); state.storageBlocked = false
      if (!claimed) { state.pending = await db.get(owner, scope); check(scope); pendingGate(scope); throw new Error('已有另一条原生成请求，未覆盖或发送新请求') }
      state.pending = original; pendingGate(scope)
      need(equal(selected, template.value) && equal(configured, state.options), '模板选择已变化，原请求保留')
      await send(original, scope)
    }, runScope))
  }
  function retryFailed() {
    if (!canRetry.value || !state.current) return Promise.resolve()
    const selected = clone(state.current)
    return run(runScope => session.withSavedPoint(async scope => {
      check(scope); need(equal(selected, state.current) && selected.status === 'Failed')
      const owner = await fresh(scope), db = await storage(scope); check(scope)
      const original = validateGenerationPending({ schema: 'metasheet.welding_command_pending/1', kind: 'generation', action: 'retry', owner,
        plan_id: selected.plan_id, item_version_id: selected.item_version_id, basis: generationBasis(selected), body: { request_id: (options.uuid ?? (() => crypto.randomUUID()))(), expected_attempt: selected.attempt } })
      state.storageBlocked = true; session.setCommandPending(scope, true); state.message = '正在保存原生成请求；确认完成前暂停编辑'
      const claimed = await db.claim(original, scope); check(scope); state.storageBlocked = false
      if (!claimed) { state.pending = await db.get(owner, scope); check(scope); pendingGate(scope); throw new Error('已有另一条原生成请求，未覆盖或发送新重试') }
      check(scope); state.pending = original; pendingGate(scope); await send(original, scope)
    }, runScope))
  }
  function confirmOriginal() {
    if (!canConfirm.value || !state.pending) return Promise.resolve()
    const original = validateGenerationPending(state.pending)
    return run(scope => session.withOriginalCommand(locked => send(original, locked), scope))
  }
  function select(id: string) {
    if (state.working) return Promise.resolve()
    const item = state.items.find(value => value.generation_id === id); need(item, '请选择已读取的固定任务')
    epoch++; stopPoll(); clearFiles(); state.current = null
    return run(scope => status(scope, generationBasis(item)))
  }
  function download(format: 'pdf' | 'docx', preview = false) {
    if (state.working || state.current?.status !== 'Ready') return Promise.resolve()
    const selected = clone(state.current), file = selected.files[format]; need(file)
    return run(async scope => {
      const owner = await fresh(scope), blob = await client.downloadReviewFile(selected.generation_id, file, scope); check(scope)
      need(equal(await fresh(scope), owner) && state.current?.generation_id === selected.generation_id); check(scope); clearFiles()
      const url = URL.createObjectURL(blob)
      if (preview && format === 'pdf') state.previewUrl = url
      else { downloadUrl = url; const link = document.createElement('a'); link.href = url; link.download = `welding-review-${selected.draft_seq}.${format}`; link.click(); link.remove() }
      state.message = '已读取固定草稿评审文件；尚未审批或发布'
    })
  }
  function selectTemplate(index: number) { if (state.working) return; need(Number.isSafeInteger(index) && state.templates[index]); state.templateIndex = index; state.options = clone(state.templates[index].default_options) }
  function setLogo(logo: TemplateOptions['logo']) { if (state.working) return; state.options = validateTemplateOptions({ ...clone(state.options), logo }) }
  const stopForm = watch(() => [state.templateIndex, state.options], () => { if (state.working) controller?.abort() }, { deep: true, flush: 'sync' })
  const stopTarget = watch([() => s.planId, () => s.versionId, () => s.owner?.tenant_id, () => s.owner?.org_id, () => s.owner?.auth_user_id, () => s.owner?.rbac_user_id, () => options.active()], () => {
    clearView()
    if (!disposed && options.active() && s.owner && s.versionId) { session.setCommandPending(session.capture(), true); queueMicrotask(() => { if (!disposed) void refresh() }) }
  }, { flush: 'sync' })
  function dispose() { if (disposed) return; disposed = true; stopTarget(); stopForm(); clearView(); unsubscribe?.(); window.removeEventListener('focus', storeChanged); store?.close() }
  if (getCurrentScope()) onScopeDispose(dispose)
  return { state, canCreate, canRetry, canConfirm, refresh, create, retryFailed, confirmOriginal, select, download, selectTemplate, setLogo,
    cancelDownload: () => { controller?.abort(); clearFiles(); state.message = '文件读取已取消' }, dispose,
    freshness: (record: ReviewGeneration) => record.plan_id !== s.planId || record.item_version_id !== s.versionId || record.draft_seq !== s.draftSeq || record.plan_content_hash !== s.contentHash ? '旧保存内容' : s.dirty || s.pending ? '当前还有未保存修改' : '对应当前已保存内容',
  }
}
