import { computed, getCurrentScope, onScopeDispose, reactive, watch } from 'vue'
import { TOKEN_KEYS, onAuthPrincipalChange, readAuthSessionSignature, readStoredToken } from '../../composables/authPrincipal'
import { EXPLICIT_SESSION_ORG_KEY } from '../../utils/explicitSessionOrg'
import { clone, equal, need, type WeldingOwner } from '../../services/welding/planRecovery'
import { createWeldingPlanClient, WeldingResourceImportError, type RequestScope, type WeldingPlanClient } from '../../services/welding/planClient'
import { validateResourceMaintenanceRecord, type ResourceMaintenanceRecord } from '../../services/welding/resourceContracts'
import { openGenerationRecoveryStore, withGenerationOwnerLock, type ResourceImportRecoveryStore } from '../../services/welding/commandRecovery'
import { copyImportBytes, equalImportPending, hashImportBytes, importFormat, importIdentities, importMetadata, validateImportPending,
  validateImportPreview, validateImportReceipt, IMPORT_RAW_BYTES, type ResourceImportFormat, type ResourceImportIssue, type ResourceImportItem,
  type ResourceImportPending, type ResourceImportPreview, type ResourceImportReceipt } from '../../services/welding/resourceImportContracts'

type Phase = 'unadmitted' | 'selection' | 'reading' | 'preview' | 'ready' | 'issues' | 'saving' | 'sending' | 'unknown' | 'confirmed' | 'blocked'
export function useWeldingResourceImportSession(options: {
  active: () => boolean; writable: () => boolean; client?: WeldingPlanClient
  openStore?: () => Promise<ResourceImportRecoveryStore>; uuid?: () => string
}) {
  const client = options.client ?? createWeldingPlanClient(), uuid = options.uuid ?? (() => crypto.randomUUID())
  const state = reactive({ owner: null as WeldingOwner | null, format: 'csv' as ResourceImportFormat, fileName: '', fileSize: 0, rawHash: '',
    preview: null as ResourceImportPreview | null, pending: null as Omit<ResourceImportPending, 'bytes'> | null,
    receipt: null as ResourceImportReceipt | null, detail: null as ResourceMaintenanceRecord | null, issues: [] as ResourceImportIssue[],
    pendingBytes: 0, responseStatus: 0, responseCode: '', busy: false, storageBlocked: true, phase: 'unadmitted' as Phase, message: '' })
  let selected: ArrayBuffer | null = null, original: ResourceImportPending | null = null
  let epoch = 0, revision = 0, operation = 0, disposed = false, signature = '', controller = new AbortController(), reread = false
  let store: ResourceImportRecoveryStore | null = null, storePromise: Promise<ResourceImportRecoveryStore> | null = null, unsubscribeStore = () => {}
  const canSelect = computed(() => Boolean(options.active() && state.owner && !state.storageBlocked && !state.pending && !['saving', 'sending'].includes(state.phase)))
  const canPreview = computed(() => canSelect.value && !state.busy && !!selected && !!state.rawHash)
  const canCommit = computed(() => canPreview.value && options.writable() && state.preview?.ready === true && state.phase === 'ready')
  const canReplay = computed(() => Boolean(options.active() && options.writable() && state.owner && state.pending && !state.storageBlocked && !state.busy))
  function setPending(value: ResourceImportPending | null) {
    original = value ? validateImportPending(value) : null
    state.pending = original ? importMetadata(original) : null
    state.pendingBytes = original?.bytes.byteLength ?? 0
  }
  function resetSelection() {
    revision++; operation++; controller.abort(); controller = new AbortController(); selected = null
    Object.assign(state, { fileName: '', fileSize: 0, rawHash: '', preview: null, receipt: null, detail: null, issues: [], responseStatus: 0, responseCode: '', busy: false, phase: state.pending ? 'unknown' : 'selection', message: '' })
  }
  function invalidate() {
    epoch++; signature = ''; resetSelection(); setPending(null)
    Object.assign(state, { owner: null, storageBlocked: true, phase: 'unadmitted', message: '会话或开关已变化，旧导入资料隐藏；原请求仍归原身份保留' })
  }
  function capture(initializing = false): RequestScope {
    const current = readAuthSessionSignature()
    if (signature && signature !== current) invalidate()
    need(initializing || state.owner && signature === current, '请先核对整批导入身份与原请求')
    const captured = epoch, selection = revision, admitted = signature || current
    return { signal: controller.signal, accepts: () => !disposed && captured === epoch && selection === revision && options.active()
      && Boolean(readStoredToken()) && admitted === readAuthSessionSignature() && (signature === admitted || initializing && !signature) }
  }
  function check(scope: RequestScope) {
    need(scope.accepts() && !scope.signal?.aborted, '会话或文件选择已变化，原整批请求保留')
  }
  async function fresh(scope: RequestScope, expected = state.owner) {
    check(scope); const owner = await client.authority(scope); check(scope)
    if (expected && !equal(owner, expected)) { invalidate(); throw new Error('整批身份已变化，原请求仍归原身份保留') }
    return owner
  }
  async function storage(scope: RequestScope) {
    check(scope)
    if (!storePromise) storePromise = (options.openStore ?? openGenerationRecoveryStore)().then(value => {
      if (disposed) { value.close(); throw new Error('页面已关闭') }
      store = value; unsubscribeStore = value.subscribe?.(storeChanged) ?? (() => {}); return value
    }).catch(error => { storePromise = null; throw error })
    try { const value = await storePromise; check(scope); return value }
    catch (error) { if (scope.accepts()) { state.storageBlocked = true; state.phase = 'blocked' }; throw error }
  }
  async function run(action: (scope: RequestScope) => Promise<void>, initializing = false) {
    if (disposed || state.busy || !options.active()) return
    const scope = capture(initializing), serial = ++operation; state.busy = true
    if (!initializing) { state.message = ''; state.issues = []; state.responseStatus = 0; state.responseCode = '' }
    try { await action(scope) }
    catch (error) {
      if (serial === operation) {
        if (signature && signature !== readAuthSessionSignature()) invalidate()
        else if (scope.accepts()) {
          state.message = error instanceof Error ? error.message : '整批请求未确认，原请求保留'
          if (error instanceof WeldingResourceImportError) { state.issues = clone(error.issues); state.responseStatus = error.status; state.responseCode = error.code }
          if (state.phase === 'preview' || state.phase === 'reading') state.phase = 'issues'
          if (state.phase === 'saving') { state.phase = 'blocked'; state.storageBlocked = true }
        }
      }
    } finally {
      if (serial === operation) {
        state.busy = false
        if (reread && state.owner && options.active() && !disposed) { reread = false; void initialize() }
      }
    }
  }
  async function initialize() {
    return run(async scope => {
      const owner = await fresh(scope); state.owner = clone(owner); signature = readAuthSessionSignature()
      await withGenerationOwnerLock(owner, scope, async locked => {
        await fresh(locked, owner)
        try {
          const db = await storage(locked), pending = await db.getResourceImport(owner, locked); check(locked); await fresh(locked, owner)
          setPending(pending); state.storageBlocked = false
          if (pending) { state.phase = 'unknown'; state.message = '原整批请求已读取；服务器可能已提交，请核对原件后明确重放。当前选件保留，未自动预检或发送。' }
          else if (state.phase === 'unadmitted' || state.phase === 'blocked' || state.phase === 'unknown') state.phase = state.preview?.ready ? 'ready' : 'selection'
        } catch (error) { if (locked.accepts()) { state.storageBlocked = true; state.phase = 'blocked' }; throw error }
      })
    }, true)
  }
  function selectFormat(format: ResourceImportFormat) {
    need(canSelect.value, '请先核对原整批请求'); importFormat(format)
    if (state.format !== format) { resetSelection(); state.format = format }
  }
  async function selectFile(file: File | null) {
    need(canSelect.value, '请先核对原整批请求'); resetSelection()
    if (!file) return
    state.fileName = file.name; state.fileSize = file.size
    return run(async scope => {
      state.phase = 'reading'; need(file.size > 0 && file.size <= IMPORT_RAW_BYTES, '原文件须为 1 字节至 5 MiB')
      const bytes = copyImportBytes(await file.arrayBuffer()); check(scope)
      need(bytes.byteLength === file.size, '文件读取长度不符')
      const hash = await hashImportBytes(bytes); check(scope)
      selected = copyImportBytes(bytes); state.rawHash = hash; state.phase = 'selection'
    })
  }
  async function downloadTemplate(format: ResourceImportFormat) {
    return run(async scope => {
      const owner = await fresh(scope), result = await client.resourceImportTemplate(format, scope); check(scope); await fresh(scope, owner)
      const url = URL.createObjectURL(result.blob), anchor = document.createElement('a')
      try { check(scope); anchor.href = url; anchor.download = result.filename; anchor.click() }
      finally { URL.revokeObjectURL(url) }
    })
  }
  async function noPending(db: ResourceImportRecoveryStore, owner: WeldingOwner, scope: RequestScope) {
    const pending = await db.getResourceImport(owner, scope); check(scope)
    if (pending) { setPending(pending); state.phase = 'unknown'; throw new Error('另一页面已有整批原请求；本页选件保留，请明确核对原请求') }
  }
  async function preview() {
    need(canPreview.value && selected, '请先选择文件并核对原请求')
    const bytes = copyImportBytes(selected), format = state.format, rawHash = state.rawHash
    state.preview = null; state.receipt = null; state.detail = null
    return run(async scope => {
      state.phase = 'preview'; const owner = await fresh(scope)
      await withGenerationOwnerLock(owner, scope, async locked => {
        const db = await storage(locked); await noPending(db, owner, locked); await fresh(locked, owner)
        const value = validateImportPreview(await client.previewResourceImport(format, copyImportBytes(bytes), rawHash, locked), format, rawHash)
        check(locked); await fresh(locked, owner); await noPending(db, owner, locked)
        state.preview = value; state.issues = clone(value.errors); state.phase = value.ready ? 'ready' : 'issues'
        state.message = value.ready ? '全部行预检通过；请阅读所有字段和固定来源，再明确确认整批新建 Draft' : '整批预检未通过；全部有效行与问题如下，未发送提交'
      })
    })
  }
  async function dispatch(pending: ResourceImportPending, db: ResourceImportRecoveryStore, scope: RequestScope) {
    let sent = false
    try {
      need(options.writable(), '整批写入未开启，原请求保留'); await fresh(scope, pending.owner)
      need(equalImportPending(await db.getResourceImport(pending.owner, scope), pending), '跨页整批原请求已变化，未发送'); check(scope)
      await fresh(scope, pending.owner); need(options.writable(), '整批写入未开启，原请求保留'); check(scope)
      state.phase = 'sending'; sent = true
      const receipt = validateImportReceipt(await client.commitResourceImport(validateImportPending(pending), scope), pending); check(scope)
      await fresh(scope, pending.owner)
      need(equalImportPending(await db.getResourceImport(pending.owner, scope), pending), '已发送，原请求记录已变化；完整回执未应用'); check(scope)
      need(await db.clearResourceImport(pending, scope), '已发送，但原请求未能确切清除；结果仍待核对'); check(scope)
      setPending(null); state.receipt = receipt; state.detail = null
      if (selected && (state.format !== pending.format || state.rawHash !== pending.raw_sha256)) {
        state.phase = state.preview?.ready ? 'ready' : 'selection'
        state.message = `原批次 ${receipt.total_rows} 条 Draft 已取得完整确认；当前选件保留，未作为该批次登记，请核对后明确提交`
      } else {
        state.phase = 'confirmed'
        // The consumed selection cannot be committed again under a new import ID.
        selected = null; state.preview = null; state.fileName = ''; state.fileSize = 0; state.rawHash = ''
        state.message = `整批 ${receipt.total_rows} 条 Draft 已取得完整确认；可逐项明确鲜读固定版本`
      }
    } catch (error) {
      if (scope.accepts()) {
        state.phase = 'unknown'
        if (sent) throw new WeldingResourceImportError(`已发送，未完成可信整批确认；服务器可能已提交，原请求保留。${error instanceof Error ? error.message : ''}`, error instanceof WeldingResourceImportError ? error.status : 0,
          error instanceof WeldingResourceImportError && error.status >= 400 ? error.code : 'WELDING_RESULT_UNKNOWN', error instanceof WeldingResourceImportError ? error.issues : [])
      }
      throw error
    }
  }
  async function commit() {
    need(canCommit.value && selected && state.preview, '请先完成当前文件的全部预检')
    const bytes = copyImportBytes(selected), previewed = clone(state.preview)
    if (!window.confirm(`确认整批新建 ${previewed.total_rows} 条 Draft？任一失败整体不创建。提交后断线不表示未提交，须保留原请求核对。`)) return
    return run(async scope => {
      state.phase = 'saving'; const owner = await fresh(scope)
      await withGenerationOwnerLock(owner, scope, async locked => {
        const db = await storage(locked); await noPending(db, owner, locked); await fresh(locked, owner)
        need(options.writable() && equal(previewed, state.preview), '预检或写入开关已变化')
        const pending = validateImportPending({ schema: 'metasheet.welding_resource_import_pending/1', kind: 'resource-import', owner,
          import_id: uuid(), format: previewed.format, bytes, raw_sha256: previewed.raw_sha256, normalized_sha256: previewed.normalized_sha256,
          preview_digest: previewed.preview_digest, total_rows: previewed.total_rows, rows: importIdentities(previewed.rows) })
        try {
          need(await db.claimResourceImport(pending, locked), '整批原请求未能独占保存，未发送'); check(locked)
          setPending(pending)
          need(equalImportPending(await db.getResourceImport(owner, locked), pending), '整批原件未能完整读回，未发送'); check(locked)
        } catch (error) { if (locked.accepts()) { state.storageBlocked = true; state.phase = 'blocked' }; throw error }
        await dispatch(pending, db, locked)
      })
    })
  }
  async function replay() {
    need(canReplay.value && original, '请先核对同一身份的完整原请求')
    const pending = validateImportPending(original)
    if (!window.confirm(`明确重放原批次 ${pending.import_id}（${pending.total_rows} 条）？保持原件、格式及摘要；服务器可能已提交。`)) return
    return run(scope => withGenerationOwnerLock(pending.owner, scope, async locked => { const db = await storage(locked); await dispatch(pending, db, locked) }))
  }
  async function readItem(item: ResourceImportItem) {
    need(state.receipt?.items.some(row => equal(row, item)), '固定回执选择已变化')
    const receipt = clone(state.receipt), fixed = clone(item); state.detail = null
    return run(async scope => {
      const owner = await fresh(scope), record = validateResourceMaintenanceRecord(await client.readResource(fixed.resource_id, fixed.item_version_id, scope), fixed.resource_id, fixed.item_version_id)
      check(scope); await fresh(scope, owner)
      need(equal(receipt, state.receipt) && ['content_hash', 'name', 'number', 'kind', 'version_label'].every(key => record[key as keyof ResourceMaintenanceRecord] === fixed[key as keyof ResourceImportItem]), '固定详情与回执身份或内容摘要不符')
      state.detail = record; state.message = '已鲜读所选固定版本，身份与内容摘要符合回执；不推断 current 或专业适用性'
    })
  }
  function storeChanged() {
    if (disposed || !options.active() || !state.owner) return
    if (state.busy) { reread = true; return }
    state.storageBlocked = true; void initialize()
  }
  const stopFlags = watch(() => [options.active(), options.writable()], invalidate, { flush: 'sync' })
  const unsubscribeAuth = onAuthPrincipalChange(invalidate)
  const storageChanged = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== localStorage) return
    if (event.key === null || event.key === EXPLICIT_SESSION_ORG_KEY || (TOKEN_KEYS as readonly string[]).includes(event.key)) invalidate()
  }
  window.addEventListener('storage', storageChanged); window.addEventListener('focus', storeChanged)
  function prepareLeave() {
    if (state.busy) return false
    if (state.pending) return window.confirm('服务器可能已经提交整批。离开后原请求仍保留，下次须以同一身份明确核对或重放。是否离开？')
    return !state.fileName && !state.preview || window.confirm('离开会丢弃尚未提交的原文件选择与整批预检，是否继续？')
  }
  function dispose() {
    if (disposed) return
    disposed = true; epoch++; controller.abort(); stopFlags(); unsubscribeAuth(); unsubscribeStore(); store?.close()
    selected = null; original = null; window.removeEventListener('storage', storageChanged); window.removeEventListener('focus', storeChanged)
  }
  if (getCurrentScope()) onScopeDispose(dispose)
  return { state, canSelect, canPreview, canCommit, canReplay, initialize, selectFormat, selectFile, downloadTemplate, preview, commit, replay, readItem,
    prepareLeave, resetEntry: resetSelection, dispose }
}
