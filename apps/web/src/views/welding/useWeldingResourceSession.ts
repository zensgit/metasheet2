import { computed, getCurrentScope, onScopeDispose, reactive, watch } from 'vue'
import { TOKEN_KEYS, onAuthPrincipalChange, readAuthSessionSignature, readStoredToken } from '../../composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../../utils/explicitSessionOrg'
import { clone, equal, need, type WeldingOwner } from '../../services/welding/planRecovery'
import { createWeldingPlanClient, type RequestScope, type WeldingPlanClient } from '../../services/welding/planClient'
import { resourcePath, validateResourceAck, validateResourceForm, type ResourceForm, type ResourceMaintenanceRecord, type ResourceOriginal,
  type ResourceCatalogQuery, type ResourceKind, type ResourceSummary, type ResourceDocumentCandidate } from '../../services/welding/resourceContracts'
import { openGenerationRecoveryStore, validateResourcePending, withGenerationOwnerLock, type ResourcePending, type ResourceRecoveryStore } from '../../services/welding/commandRecovery'

const blank = (): ResourceForm => ({ name: '', number: '', payload: { schema_version: 1, kind: 'material', suggested_fields: {} } })
const formOf = (record: ResourceMaintenanceRecord): ResourceForm => clone({ name: record.name, number: record.number, payload: record.payload })
const originalOf = (pending: ResourcePending): ResourceOriginal => pending.action === 'create'
  ? { action: 'create', resource_id: pending.resource_id, body: pending.body, source: null }
  : { action: 'revise', resource_id: pending.resource_id, body: pending.body, source: pending.source }
export function useWeldingResourceSession(options: {
  active: () => boolean; writable: () => boolean; client?: WeldingPlanClient
  openStore?: () => Promise<ResourceRecoveryStore>; uuid?: () => string
}) {
  const client = options.client ?? createWeldingPlanClient(), uuid = options.uuid ?? (() => crypto.randomUUID())
  const state = reactive({ owner: null as WeldingOwner | null, form: blank(), record: null as ResourceMaintenanceRecord | null,
    comparison: null as ResourceForm | null, pending: null as ResourcePending | null, busy: false, storageBlocked: true, message: '',
    catalog: { filters: { kind: '', method: '', material_a: '', material_b: '', filler: '', joint_type: '', thickness_a_value: '', thickness_a_unit: '', thickness_b_value: '', thickness_b_unit: '', limit: 20 },
      items: [] as ResourceSummary[], nextCursor: null as string | null, loaded: false, message: '' },
    history: { resourceId: '', items: [] as ResourceSummary[], currentVersionId: null as string | null, nextCursor: null as string | null, loaded: false, message: '' },
    documents: { query: '', items: [] as ResourceDocumentCandidate[], nextCursor: null as string | null, loaded: false, message: '' } })
  let epoch = 0, operation = 0, disposed = false, ownerSignature = '', controller = new AbortController()
  let formRevision = 0, catalogRevision = 0, historyRevision = 0, documentRevision = 0
  let presentedOriginal: ResourcePending | null = null
  let store: ResourceRecoveryStore | null = null, storePromise: Promise<ResourceRecoveryStore> | null = null, unsubscribeStore = () => {}
  const canRequest = computed(() => Boolean(options.active() && options.writable() && state.owner && !state.busy && !state.storageBlocked && !state.pending
    && (!state.record || state.record.state === 'Draft' && state.comparison && equal(state.comparison, state.form))))
  const canConfirm = computed(() => Boolean(options.active() && options.writable() && state.owner && !state.busy && !state.storageBlocked && state.pending))
  function clearCatalog() { catalogRevision++; Object.assign(state.catalog, { items: [], nextCursor: null, loaded: false, message: '' }) }
  function clearHistory() { historyRevision++; Object.assign(state.history, { items: [], currentVersionId: null, nextCursor: null, loaded: false, message: '' }) }
  function clearDocuments() { documentRevision++; Object.assign(state.documents, { items: [], nextCursor: null, loaded: false, message: '' }) }
  function invalidate() {
    clearCatalog(); clearHistory(); clearDocuments()
    ownerSignature = ''; presentedOriginal = null; epoch++; operation++; controller.abort(); controller = new AbortController()
    Object.assign(state, { owner: null, form: blank(), record: null, comparison: null, pending: null, busy: false, storageBlocked: true,
      message: '会话或读取已变化，旧资料已隐藏；原请求保留，请重新读取个人原请求' })
  }
  function capture(initializing = false): RequestScope {
    const signature = readAuthSessionSignature()
    if (ownerSignature && ownerSignature !== signature) invalidate()
    need(initializing || state.owner && ownerSignature && ownerSignature === signature, '会话准入已变化，请重新核对个人原请求')
    const captured = epoch, admitted = ownerSignature || signature
    return { signal: controller.signal, accepts: () => !disposed && captured === epoch && options.active()
      && Boolean(readStoredToken()) && admitted === readAuthSessionSignature()
      && (ownerSignature === admitted || initializing && !ownerSignature) }
  }
  function check(scope: RequestScope) {
    if (!scope.accepts() || scope.signal?.aborted) {
      if (ownerSignature && ownerSignature !== readAuthSessionSignature()) invalidate()
      throw new Error('会话或页面已变化，原资料请求保留')
    }
  }
  async function fresh(scope: RequestScope, expected = state.owner) {
    check(scope); const owner = await client.authority(scope); check(scope)
    if (expected && !equal(owner, expected)) { invalidate(); throw new Error('资料身份已变化，原请求仍归原身份保留') }
    return owner
  }
  async function storage(scope: RequestScope) {
    check(scope)
    if (!storePromise) storePromise = (options.openStore ?? openGenerationRecoveryStore)().then(value => {
      if (disposed) { value.close(); throw new Error('页面已关闭') }
      store = value; unsubscribeStore = value.subscribe?.(storeChanged) ?? (() => {}); return value
    }).catch(error => { storePromise = null; throw error })
    try { const value = await storePromise; check(scope); return value }
    catch (error) { if (scope.accepts()) state.storageBlocked = true; throw error }
  }
  async function run(action: (scope: RequestScope) => Promise<void>, initializing = false, accepts = () => true) {
    if (disposed || state.busy || !options.active()) return
    const admitted = capture(initializing), scope = { signal: admitted.signal, accepts: () => admitted.accepts() && accepts() }, serial = ++operation; state.busy = true
    try { await action(scope) }
    catch (error) { if (serial === operation && accepts()) {
      if (ownerSignature && ownerSignature !== readAuthSessionSignature()) invalidate()
      else state.message = error instanceof Error ? error.message : '资料请求未确认，原请求保留'
    } }
    finally { if (serial === operation) state.busy = false }
  }
  function restore(pending: ResourcePending) {
    state.record = null; state.comparison = null
    state.form = clone({ name: pending.body.name, number: pending.action === 'create' ? pending.body.number : pending.source.number, payload: pending.body.payload })
    presentedOriginal = clone(pending)
  }
  async function initialize(restoreBlank = true) {
    return run(async scope => {
      const owner = await fresh(scope); state.owner = clone(owner); ownerSignature = readAuthSessionSignature()
      await withGenerationOwnerLock(owner, scope, async locked => {
        await fresh(locked, owner); const db = await storage(locked), pending = await db.getResource(owner, locked); check(locked)
        await fresh(locked, owner); state.pending = pending; state.storageBlocked = false
        if (pending) {
          if (restoreBlank && !state.record && equal(state.form, blank())) restore(pending)
          state.message = '个人原资料请求已读取；本页输入和固定依据保留，未自动发送，请核对原请求后明确重发'
        }
        else state.message = '身份已核对；资料 add/update 与来源权限由服务器逐次判定'
      })
    }, true)
  }
  function replaceAllowed() {
    need(!state.busy && state.owner && !state.pending && !state.storageBlocked, '请先核对个人原请求')
    return equal(state.form, state.record ? formOf(state.record) : blank()) || window.confirm('读取或新建将替换未登记编辑，是否明确放弃这些编辑？原请求不会被删除。')
  }
  async function noPending(db: ResourceRecoveryStore, owner: WeldingOwner, scope: RequestScope) {
    const pending = await db.getResource(owner, scope); check(scope)
    if (pending) { state.pending = pending; throw new Error('另一页面已有原资料请求；保留本页输入，请先核对原请求') }
    need(!state.pending, '原资料请求仍须核对')
  }
  async function read(resource: string, version: string, selectionCurrent = () => true) {
    if (!replaceAllowed()) return
    const editing = formRevision
    return run(async scope => {
      const owner = await fresh(scope)
      await withGenerationOwnerLock(owner, scope, async locked => {
        const db = await storage(locked); await noPending(db, owner, locked); await fresh(locked, owner)
        const value = await client.readResource(resource, version, locked); check(locked)
        await noPending(db, owner, locked); await fresh(locked, owner)
        presentedOriginal = null; state.record = value; state.form = formOf(value); state.comparison = null
        state.message = '已读取固定资料版本；不推断该版本仍为 current，修订由服务器核对 CAS'
      })
    }, false, () => editing === formRevision && selectionCurrent())
  }
  async function readDiagram(selection: RequestScope) {
    const admitted = capture(), revision = formRevision, record = clone(state.record)
    need(record?.kind === 'joint_diagram', '请先读取固定接头图版本')
    const scope: RequestScope = { signal: selection.signal, accepts: () => admitted.accepts() && selection.accepts()
      && revision === formRevision && equal(record, state.record) }
    const owner = await fresh(scope), blob = await client.readResourceDiagram(record, scope)
    check(scope); await fresh(scope, owner); check(scope)
    return { blob, record, scope }
  }
  function newResource() {
    if (!replaceAllowed()) return
    presentedOriginal = null; state.record = null; state.form = blank(); state.comparison = null; state.message = '新登记仍为 Draft，不代表批准或专业适用性'
  }
  function catalogQuery(): ResourceCatalogQuery {
    const f = state.catalog.filters, query: ResourceCatalogQuery = { limit: f.limit }
    if (f.kind) query.kind = f.kind as ResourceKind
    for (const key of ['method', 'material_a', 'material_b', 'filler', 'joint_type'] as const) if (f[key] !== '') query[key] = f[key]
    for (const side of ['a', 'b'] as const) {
      const amount = `thickness_${side}_value` as const, unit = `thickness_${side}_unit` as const
      if (f[amount] !== '') { need(f[amount].trim() !== '', '板厚数值不可为空白'); query[amount] = Number(f[amount]) }
      if (f[unit] !== '') query[unit] = f[unit] as 'mm' | 'in'
    }
    return query
  }
  async function runCatalog(page: { message: string }, action: (scope: RequestScope) => Promise<void>, current: () => boolean) {
    return run(async scope => {
      page.message = ''
      try { await action(scope) }
      catch (error) { if (scope.accepts()) page.message = error instanceof Error ? error.message : '目录查询未确认'; throw error }
    }, false, current)
  }
  async function searchCatalog(next = false) {
    const revision = catalogRevision, cursor = next ? state.catalog.nextCursor : null
    if (next && !cursor) return
    return runCatalog(state.catalog, async scope => {
      const query = catalogQuery(), owner = await fresh(scope)
      const page = await client.resourceCatalog({ ...query, ...(cursor ? { cursor } : {}) }, scope); check(scope); await fresh(scope, owner)
      Object.assign(state.catalog, { items: page.items, nextCursor: page.next_cursor, loaded: true, message: '' })
    }, () => revision === catalogRevision)
  }
  async function searchHistory(next = false) {
    const revision = historyRevision, resource = state.history.resourceId, cursor = next ? state.history.nextCursor : null
    if (next && !cursor) return
    return runCatalog(state.history, async scope => {
      const owner = await fresh(scope), page = await client.resourceVersionCatalog(resource, { limit: 20, ...(cursor ? { cursor } : {}) }, scope)
      check(scope); await fresh(scope, owner)
      Object.assign(state.history, { items: page.items, currentVersionId: page.current_version_id, nextCursor: page.next_cursor, loaded: true, message: '' })
    }, () => revision === historyRevision)
  }
  async function searchDocuments(next = false) {
    const revision = documentRevision, query = state.documents.query, cursor = next ? state.documents.nextCursor : null
    if (next && !cursor) return
    return runCatalog(state.documents, async scope => {
      const owner = await fresh(scope), page = await client.resourceDocumentCatalog(query, cursor ?? undefined, scope); check(scope); await fresh(scope, owner)
      Object.assign(state.documents, { items: page.items, nextCursor: page.next_cursor, loaded: true, message: '' })
    }, () => revision === documentRevision)
  }
  async function selectSummary(summary: ResourceSummary, history = false) {
    const list = history ? state.history : state.catalog, revision = history ? historyRevision : catalogRevision
    const current = () => revision === (history ? historyRevision : catalogRevision) && list.items.some(row => equal(row, summary))
    need(current(), '资料选择已过期，请重新查询')
    return read(summary.resource_id, summary.item_version_id, current)
  }
  async function selectDocument(candidate: ResourceDocumentCandidate) {
    need(!state.busy && state.owner && !state.pending && !state.storageBlocked, '请先核对个人原请求')
    const revision = documentRevision, editing = formRevision
    const current = () => revision === documentRevision && editing === formRevision && state.documents.items.some(row => equal(row, candidate))
    need(current(), '文档选择已过期，请重新查询')
    if (state.form.payload.document && !window.confirm('明确用所选固定文档替换当前五字段来源？尚未提交资料登记。')) return
    return run(async scope => {
      const owner = await fresh(scope)
      await withGenerationOwnerLock(owner, scope, async locked => {
        const db = await storage(locked); await noPending(db, owner, locked); await fresh(locked, owner)
        state.form.payload.document = { item_id: candidate.item_id, version_id: candidate.version_id, file_id: candidate.file_id,
          file_role: candidate.file_role, expected_fingerprint: candidate.fingerprint }
        state.message = '已明确选择固定文档来源；登记时服务器仍会复验来源权限与指纹'
      })
    }, false, current)
  }
  function compare() {
    need(state.record && !state.busy && !state.pending && state.record.state === 'Draft', '请先读取固定 Draft 并核对原请求')
    const form = validateResourceForm(state.form)
    need(form.number === state.record.number && form.payload.kind === state.record.kind, '修订不能更改资料编号或类别')
    state.comparison = form; state.message = '旧新内容已比较；再次编辑后必须重新比较'
  }
  async function dispatch(pending: ResourcePending, db: ResourceRecoveryStore, scope: RequestScope) {
    const owner = pending.owner, selection = clone(state.record)
    need(options.writable(), '当前资料写入未开启，原请求保留'); await fresh(scope, owner)
    need(equal(await db.getResource(owner, scope), pending), '跨页原资料请求已变化'); check(scope)
    await fresh(scope, owner); need(options.writable(), '当前资料写入未开启，原请求保留')
    const value = pending.action === 'create' ? await client.createResource(pending.body, scope)
      : await client.reviseResource(pending.resource_id, pending.body, pending.source, scope)
    check(scope); const result = validateResourceAck(value, originalOf(pending))
    await fresh(scope, owner); need(equal(await db.getResource(owner, scope), pending), '原资料记录已变化，成功回应未覆盖本页'); check(scope)
    need(await db.clearResource(pending, scope), '原资料记录未能确切清除，请保留原请求'); check(scope)
    const sent = { name: pending.body.name, number: pending.action === 'create' ? pending.body.number : pending.source.number, payload: pending.body.payload }
    const sameTarget = selection ? pending.action === 'revise' && selection.resource_id === pending.resource_id
      && selection.item_version_id === pending.source.item_version_id && selection.content_hash === pending.source.content_hash
      : presentedOriginal && equal(presentedOriginal, pending)
    state.pending = null; presentedOriginal = null
    if (sameTarget && equal(state.record, selection) && equal(state.form, sent)) {
      state.record = result; state.comparison = null; state.form = formOf(result)
      state.message = `已登记固定版本 ${result.version_label}；旧资料与计划引用保持`
    } else state.message = `原请求已确认固定版本 ${result.version_label}；后续表单输入和固定依据保持，不会被标为已登记`
  }
  async function submit() {
    need(canRequest.value, '请核对身份、原请求、写入开关及旧新比较')
    const form = validateResourceForm(state.form), source = clone(state.record), comparison = clone(state.comparison)
    return run(async scope => {
      const owner = await fresh(scope); need(owner)
      await withGenerationOwnerLock(owner, scope, async locked => {
        const db = await storage(locked); need(!await db.getResource(owner, locked), '另一页面已有原资料请求'); check(locked)
        await fresh(locked, owner)
        need(options.writable() && equal(form, state.form) && equal(source, state.record) && equal(comparison, state.comparison), '表单或选择已变化，请重新比较')
        const original = source ? { action: 'revise', resource_id: source.resource_id,
          body: { request_id: uuid(), source_version_id: source.item_version_id, expected_current_version_id: source.item_version_id,
            expected_content_hash: source.content_hash, name: form.name, payload: form.payload },
          source: { resource_id: source.resource_id, item_version_id: source.item_version_id, content_hash: source.content_hash, number: source.number, kind: source.kind } }
          : { action: 'create', resource_id: uuid(), body: { ...form, request_id: uuid() }, source: null }
        if (!source) Object.assign(original.body, { resource_id: original.resource_id })
        const pending = validateResourcePending({ schema: 'metasheet.welding_command_pending/1', kind: 'resource', owner, ...original })
        try {
          need(await db.claimResource(pending, locked), '原资料请求未能独占保存；未发送'); check(locked)
          state.pending = pending; presentedOriginal = clone(pending)
          need(equal(await db.getResource(owner, locked), pending), '原资料请求未能读回；未发送'); check(locked)
        } catch (error) { if (locked.accepts()) state.storageBlocked = true; throw error }
        await dispatch(pending, db, locked)
      })
    })
  }
  async function confirmOriginal() {
    need(state.pending && !state.storageBlocked && options.writable(), '请重新读取个人原资料请求')
    const pending = validateResourcePending(clone(state.pending))
    return run(async scope => withGenerationOwnerLock(pending.owner, scope, async locked => {
      const db = await storage(locked); await dispatch(pending, db, locked)
    }))
  }
  function storeChanged() { if (!disposed && options.active() && state.owner && !state.busy) { state.storageBlocked = true; void initialize(false) } }
  const stopForm = watch(() => state.form, () => { formRevision++; state.comparison = null; presentedOriginal = null }, { deep: true, flush: 'sync' })
  const stopCatalog = watch(() => state.catalog.filters, clearCatalog, { deep: true, flush: 'sync' })
  const stopHistory = watch(() => state.history.resourceId, clearHistory, { flush: 'sync' })
  const stopDocuments = watch(() => state.documents.query, clearDocuments, { flush: 'sync' })
  const stopFlags = watch(() => [options.active(), options.writable()], () => { if (!options.active()) invalidate(); else state.comparison = null }, { flush: 'sync' })
  const unsubscribeAuth = onAuthPrincipalChange(invalidate)
  const storageChanged = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== localStorage) return
    if (event.key === null || event.key === EXPLICIT_SESSION_ORG_KEY || (TOKEN_KEYS as readonly string[]).includes(event.key)) invalidate()
  }
  window.addEventListener('storage', storageChanged); window.addEventListener('focus', storeChanged)
  function dispose() {
    if (disposed) return
    disposed = true; epoch++; controller.abort(); stopForm(); stopCatalog(); stopHistory(); stopDocuments(); stopFlags(); unsubscribeAuth(); unsubscribeStore(); store?.close()
    window.removeEventListener('storage', storageChanged); window.removeEventListener('focus', storeChanged)
  }
  if (getCurrentScope()) onScopeDispose(dispose)
  return { state, canRequest, canConfirm, initialize, read, newResource, compare, submit, confirmOriginal, dispose,
    searchCatalog, searchHistory, searchDocuments, selectSummary, selectDocument, readDiagram,
    resourcePath: (pending: ResourcePending) => resourcePath(originalOf(pending)),
    prepareLeave: () => !state.busy && (!state.pending && equal(state.form, state.record ? formOf(state.record) : blank())
      || window.confirm('离开会丢失未登记表单；已持久化的原资料请求保留，下次须明确核对。是否继续？')) }
}
