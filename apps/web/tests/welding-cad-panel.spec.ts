import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, h, nextTick, reactive, type App } from 'vue'
import Panel from '../src/views/welding/WeldingCadPanel.vue'
const mocks = vi.hoisted(() => ({ cad: null as any, views: [] as any[], failView: false, loads: [] as Promise<void>[] }))
vi.mock('../src/views/welding/useWeldingCadSession', () => ({ useWeldingCadSession: () => mocks.cad }))
vi.mock('../src/services/welding/cadBridge', async () => ({ ...await vi.importActual<any>('../src/services/welding/cadBridge'), loadReadOnlyCad: vi.fn((frame, url, doc, accepts) => { const v = { loaded: mocks.loads.shift() ?? (mocks.failView ? Promise.reject(new Error('wrong unit')) : Promise.resolve()), destroy: vi.fn() }; mocks.views.push({ frame, url, doc, accepts, v }); return v }) }))
let app: App<Element>, root: HTMLDivElement
async function mount() {
  mocks.views = []; mocks.failView = false; mocks.loads = []
  const state = reactive({ owner: { tenant_id: 't', org_id: 'o', auth_user_id: 7, rbac_user_id: 19 }, planId: 'p', versionId: 'v', recoveryId: 'r', draftSeq: 1, contentHash: 'a'.repeat(64), storageBlocked: false, uncertain: false, dirty: false, pending: null, editSeq: 0, historyCursor: 1, historyLength: 2, payload: { welds: [{ weld_id: 'w', display_no: 'W1' }], overlay: { schema: 'vemcad-weld-overlay/3', bindings: [{ weld_id: 'w', primary_representation_id: 'front', representations: [{ representation_id: 'front', view_name: '主视图' }, { representation_id: 'back', view_name: '后视图' }] }] } } })
  const allowed = reactive({ value: true }), methods = Object.fromEntries(['open', 'close', 'revoke', 'history', 'cancel', 'draw', 'copy', 'annotate', 'representation', 'bind', 'renumber', 'select', 'barrier'].map(name => [name, vi.fn(async () => {})]))
  mocks.cad = { ...methods, state: reactive({ ready: true, busy: false, intent: '', message: '', selectedWeld: 'w', representationId: 'front', selectedEntities: [55], measurement: null }), canAct: computed(() => allowed.value) }
  const payload = { welds: [{ weld_id: 'w', display_no: 'W1' }] }
  const client = { sourceReview: vi.fn(async () => ({ schema: 'yuantus.welding_source_review/1', plan_id: 'p', item_version_id: 'v', draft_seq: 1, content_hash: 'a'.repeat(64), can_write: true, offset: 0, limit: 50, summary: { pending_count: 1, removed_pending_count: 1 }, items: [{ weld_id: 'gone', present: false, state: 'pending', reason_codes: ['removed'], expected_review_digest: 'd'.repeat(64), view: { present: false }, baseline_view: { present: true, weld: { display_no: '旧焊缝' } } }], total: 1 })), sourceChanges: vi.fn(async () => ({ items: [{ change_id: 'change', draft_seq: 1 }], total: 1 })), sourceChange: vi.fn(async () => ({ change_id: 'change', kind: 'drawing', before: { payload }, after: { payload }, events: ['immutable'] })), sourceDocument: vi.fn(async (_p, _v, _c, side) => ({ side, payload, cadgf_document: { fixed: true }, origin: { unit: 'mm' } })), cadTicket: vi.fn(async () => ({ asset_url: '/fixed-history.html' })) }
  let valid = true
  const session = { state, upgradeReviewBasis: () => (state as any).savedPoint?.payload ?? null, canChangeDrawing: computed(() => false), canEdit: computed(() => allowed.value), canHistory: computed(() => allowed.value || Boolean((state as any).pendingHistory)), capture: () => ({ accepts: () => valid }), check: (scope: any) => { if (!scope.accepts()) throw new Error('stale') }, fresh: vi.fn(async () => state.owner), client, confirmSourceReview: vi.fn(async () => {}) }
  root = document.createElement('div'); document.body.appendChild(root); app = createApp({ render: () => h(Panel, { session: session as any }) }); app.mount(root); await nextTick()
  return { session, client, methods, allowed, invalidate: () => { valid = false } }
}
const button = (text: string) => [...root.querySelectorAll('button')].find(b => b.textContent?.trim() === text)!
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
async function click(text: string) { button(text).click(); for (let i = 0; i < 80; i++) await Promise.resolve(); await nextTick() }
async function input(label: string, value: string) { const el = [...root.querySelectorAll('label')].find(l => l.childNodes[0].textContent?.trim() === label)!.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')!; el.value = value; el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await nextTick() }
afterEach(() => { app?.unmount(); root?.remove(); vi.restoreAllMocks() })
describe('CAD action panel actual UI wiring and read-only history', () => {
  it('discards a stale overlay measurement in both the row table and statistics', async () => {
    const f = await mount(), overlay = JSON.parse(JSON.stringify(f.session.state.payload.overlay))
    mocks.cad.state.measurement = { schema: 'vemcad-weld-measurement/1', algorithm: 'vemcad-weld-length/1', source_unit: 'mm', overlay,
      rows: [{ weld_id: 'w', status: 'measured', length_mm: 123, reason: null }] }
    await nextTick(); expect(root.textContent).toContain('123.000'); expect(root.textContent).toContain('主表示几何长度 mm')
    f.session.state.payload.overlay.bindings[0].primary_representation_id = 'back'; await nextTick()
    expect(root.textContent).not.toContain('123.000'); expect(root.textContent).not.toContain('主表示几何长度 mm')
    expect(root.textContent).toContain('当前几何量未知')
  })
  it('requires the exact saved plan version sequence and hash before displaying verification', async () => {
    const f = await mount(), state = f.session.state as any
    state.savedPoint = { plan_id: state.planId, item_version_id: state.versionId, draft_seq: state.draftSeq, content_hash: state.contentHash,
      payload: JSON.parse(JSON.stringify(state.payload)), sources: { geometry_measurement: { schema: 'yuantus.welding_geometry_measurement/1', algorithm: 'vemcad-weld-length/1', source_unit: 'mm',
        bundle_sha256: 'b'.repeat(64), geometry_basis_sha256: 'c'.repeat(64), rows: [{ weld_id: 'w', status: 'measured', length_mm: 123, reason: null }] } } }
    await nextTick(); expect(root.textContent).toContain('已保存核验')
    for (const key of ['plan_id', 'item_version_id', 'draft_seq', 'content_hash']) {
      const before = state.savedPoint[key]; state.savedPoint[key] = key === 'draft_seq' ? before + 1 : 'other'
      await nextTick(); expect(root.textContent).not.toContain('已保存核验'); expect(root.textContent).not.toContain('123.000')
      state.savedPoint[key] = before; await nextTick(); expect(root.textContent).toContain('已保存核验')
    }
  })
  it('connects every editor action to its bounded consumer with explicit values', async () => {
    const f = await mount(); await click('打开固定图纸'); expect(f.methods.open).toHaveBeenCalledWith(expect.any(HTMLIFrameElement))
    for (const [label, tool] of [['直线', 'line'], ['圆弧', 'arc'], ['多段线', 'polyline']]) { await input('新图形视图名称', '人工视图'); await click(`绘制${label}焊缝`); expect(f.methods.draw).toHaveBeenLastCalledWith(tool, '人工视图') }
    await click('将所选几何绑定焊缝'); expect(f.methods.bind).toHaveBeenLastCalledWith(); await click('解除旧格式几何绑定'); expect(f.methods.bind).toHaveBeenLastCalledWith(true)
    await input('复制新编号', 'W2'); await click('完整复制焊缝'); expect(f.methods.copy).toHaveBeenCalledWith('W2', true, false, { x: 10, y: 10 })
    for (const [label, mode] of [['生成编号', 'label'], ['生成或更新引线', 'leader'], ['移除引线', 'removeLeader']]) { await click(label); expect(f.methods.annotate).toHaveBeenLastCalledWith(mode) }
    await input('表示名称', '新视图'); await input('新增表示目标焊缝', 'w')
    for (const [label, mode] of [['所选几何新增表示', 'add'], ['复制当前表示', 'copy'], ['重命名表示', 'rename'], ['设为主表示', 'primary'], ['删除当前表示', 'remove']]) { await click(label); expect(f.methods.representation).toHaveBeenLastCalledWith(expect.objectContaining({ mode, weld_id: 'w' })) }
    await click('撤销'); expect(f.methods.history).toHaveBeenLastCalledWith('undo'); await click('重做'); expect(f.methods.history).toHaveBeenLastCalledWith('redo')
    mocks.cad.state.intent = 'draw'; await nextTick(); await click('明确取消绘制'); expect(f.methods.cancel).toHaveBeenCalledOnce()
    mocks.cad.state.intent = ''; await nextTick(); await click('撤销编辑上下文'); expect(f.methods.revoke).toHaveBeenCalledOnce(); await click('关闭图纸'); expect(f.methods.close).toHaveBeenCalled()
  })
  it('adds unbound geometry to an explicit target without replacing the native selection', async () => {
    const f = await mount(); f.session.state.payload.welds.push({ weld_id: 'other', display_no: 'W2' })
    mocks.cad.state.selectedWeld = ''; mocks.cad.state.selectedEntities = [88, 89]; await nextTick()
    await input('新增表示目标焊缝', 'other'); await input('表示名称', '侧视图')
    expect(f.methods.select).not.toHaveBeenCalled(); expect(mocks.cad.state.selectedEntities).toEqual([88, 89])
    f.session.state.editSeq++; await nextTick(); await click('所选几何新增表示')
    expect(f.methods.representation).toHaveBeenCalledOnce()
    expect(f.methods.representation).toHaveBeenCalledWith({ mode: 'add', weld_id: 'other', representation_id: expect.any(String), view_name: '侧视图', entity_ids: [88, 89] })
  })
  it('requires a target and geometry and refuses add when editing is disabled', async () => {
    const f = await mount(); await click('所选几何新增表示'); expect(f.methods.representation).not.toHaveBeenCalled()
    await input('新增表示目标焊缝', 'w'); mocks.cad.state.selectedEntities = []; await nextTick()
    await click('所选几何新增表示'); expect(f.methods.representation).not.toHaveBeenCalled()
    mocks.cad.state.selectedEntities = [88]; await nextTick(); f.allowed.value = false
    button('所选几何新增表示').click(); await nextTick(); expect(f.methods.representation).not.toHaveBeenCalled()
  })
  it('clears a removed target synchronously and never reuses it after undo restores the weld', async () => {
    const f = await mount(); await input('新增表示目标焊缝', 'w')
    f.session.state.payload.welds = []; button('所选几何新增表示').click(); await nextTick()
    expect(f.methods.representation).not.toHaveBeenCalled()
    f.session.state.payload.welds = [{ weld_id: 'w', display_no: 'W1' }]; await nextTick()
    expect(button('所选几何新增表示').disabled).toBe(true)
  })
  it('drops the add target synchronously when owner plan version or recovery scope changes', async () => {
    const f = await mount(), s = f.session.state
    for (const change of [() => { s.owner = { ...s.owner, rbac_user_id: 20 } }, () => { s.planId = 'p2' }, () => { s.versionId = 'v2' }, () => { s.recoveryId = 'r2' }]) {
      await input('新增表示目标焊缝', 'w'); change(); button('所选几何新增表示').click(); await nextTick()
      expect(f.methods.representation).not.toHaveBeenCalled(); expect(button('所选几何新增表示').disabled).toBe(true)
    }
  })
  it('shows every bound weld in the upgrade review preview before applying it', async () => {
    const f = await mount(); (f.session.state.payload.overlay as any) = { schema: 'vemcad-weld-overlay/2', bindings: [{ weld_id: 'w', entity_ids: [1] }] }
    await nextTick(); expect(root.textContent).toContain('升级复核预览')
    expect(root.querySelector('[aria-label="升级需复核焊缝"]')?.textContent).toContain('W1')
    expect(root.textContent).toContain('首次保存确认后，之前的撤销历史将清除')
    expect(f.methods.representation).not.toHaveBeenCalled()
  })
  it('includes saved bindings removed locally in upgrade obligations but only names current representations', async () => {
    const f = await mount(), s = f.session.state as any
    s.savedPoint = { payload: { welds: [{ weld_id: 'removed', display_no: 'Saved W2' }], overlay: { schema: 'vemcad-weld-overlay/2', bindings: [{ weld_id: 'removed' }, { weld_id: 'w' }] } } }
    s.payload.overlay = { schema: 'vemcad-weld-overlay/2', bindings: [{ weld_id: 'w', entity_ids: [1] }] }
    s.payload.welds.push({ weld_id: 'unbound', display_no: 'W3' })
    await nextTick()
    const preview = root.querySelector('[aria-label="升级需复核焊缝"]')!
    expect(preview.textContent).toContain('Saved W2'); expect(preview.textContent).toContain('W1')
    expect(preview.querySelectorAll('li')).toHaveLength(2); expect(preview.textContent).not.toContain('W3')
    expect([...root.querySelectorAll('label')].filter(el => el.textContent?.includes('人工视图名称'))).toHaveLength(1)
  })
  it('enables retained history without enabling ordinary CAD mutations while pending', async () => {
    const f = await mount(); f.allowed.value = false; (f.session.state as any).pendingHistory = true
    await nextTick(); expect(root.querySelector('fieldset')!.disabled).toBe(true)
    expect(button('打开固定图纸').disabled).toBe(true)
    expect(button('撤销').disabled).toBe(false); expect(button('重做').disabled).toBe(false)
    await click('撤销'); expect(f.methods.history).toHaveBeenLastCalledWith('undo')
    await click('重做'); expect(f.methods.history).toHaveBeenLastCalledWith('redo')
  })
  it('offers whole upgrade and explicit renumber, without dispatching disabled draw controls', async () => {
    const f = await mount(); (f.session.state.payload.overlay as any) = { schema: 'vemcad-weld-overlay/2', bindings: [{ weld_id: 'w', entity_ids: [1] }] }; await nextTick()
    await input('焊缝 w 的人工视图名称', '前视图'); await click('明确升级为多表示'); expect(f.methods.representation).toHaveBeenLastCalledWith({ mode: 'upgrade', names: [{ weld_id: 'w', representation_id: expect.any(String), view_name: '前视图' }] })
    const renumber = [...root.querySelectorAll('label')].find(l => l.textContent?.includes('W1 →'))!.querySelector('input')!; renumber.value = 'W9'; renumber.dispatchEvent(new Event('input', { bubbles: true })); await nextTick(); await click('确认编号变更'); expect(f.methods.renumber).toHaveBeenCalledWith([{ weld_id: 'w', old_no: 'W1', new_no: 'W9' }])
    f.allowed.value = false; await nextTick(); expect(root.querySelector('fieldset')!.disabled).toBe(true)
  })
  it('reads actual obligation methods and sequential before/after history, with no local disposition mutation', async () => {
    const f = await mount(); await click('读取复核义务'); expect(f.client.sourceReview).toHaveBeenCalledWith('p', 'v', 0, expect.anything()); expect(root.textContent).toContain('已删除待处理 1')
    await click('读取来源历史'); await click('保存序号 1 · change'); expect(f.client.sourceDocument.mock.calls.map(c => c[3])).toEqual(['before', 'after']); expect(mocks.views).toHaveLength(2); expect(root.textContent).toContain('immutable')
    f.session.state.owner = { ...f.session.state.owner, rbac_user_id: 20 }; await nextTick(); expect(root.textContent).not.toContain('immutable'); expect(mocks.views.every(v => v.v.destroy.mock.calls.length)).toBe(true)
  })
  it('hides both history sides on a failed viewer and suppresses stale read publication', async () => {
    const f = await mount(); await click('读取来源历史'); mocks.failView = true; await click('保存序号 1 · change'); expect(root.textContent).toContain('wrong unit'); expect(root.textContent).not.toContain('immutable'); expect(mocks.views).toHaveLength(1)
    f.invalidate(); await click('读取复核义务'); expect(root.textContent).toContain('stale'); expect(root.textContent).not.toContain('已删除待处理 1')
  })
  it('does not restore a history list after the current draft was edited while the read was pending', async () => {
    const f = await mount(), reply = await f.client.sourceChanges(), held = deferred<typeof reply>()
    f.client.sourceChanges.mockClear().mockReturnValueOnce(held.promise)
    button('读取来源历史').click(); await vi.waitFor(() => expect(f.client.sourceChanges).toHaveBeenCalledOnce())
    f.session.state.editSeq++; await nextTick(); held.resolve(reply)
    await vi.waitFor(() => expect(button('读取来源历史').disabled).toBe(false))
    expect(root.textContent).not.toContain('保存序号 1 · change')
    await click('读取来源历史'); expect(root.textContent).toContain('保存序号 1 · change')
  })
  it('does not restore old review obligations after a local edit without a server CAS change', async () => {
    const f = await mount(), reply = await f.client.sourceReview(), held = deferred<typeof reply>()
    f.client.sourceReview.mockClear().mockReturnValueOnce(held.promise)
    button('读取复核义务').click(); await vi.waitFor(() => expect(f.client.sourceReview).toHaveBeenCalledOnce())
    f.session.state.editSeq++; f.session.state.dirty = true; await nextTick(); held.resolve(reply)
    await vi.waitFor(() => expect(button('读取复核义务').disabled).toBe(false))
    expect(root.textContent).not.toContain('已删除待处理 1')
    f.session.state.dirty = false; await click('读取复核义务'); expect(root.textContent).toContain('已删除待处理 1')
  })
  it('rejects the old history list even if a changed saved basis returns to its original value in one turn', async () => {
    const f = await mount(), reply = await f.client.sourceChanges(), held = deferred<typeof reply>()
    f.client.sourceChanges.mockClear().mockReturnValueOnce(held.promise)
    button('读取来源历史').click(); await vi.waitFor(() => expect(f.client.sourceChanges).toHaveBeenCalledOnce())
    f.session.state.contentHash = 'b'.repeat(64); f.session.state.contentHash = 'a'.repeat(64); held.resolve(reply)
    await vi.waitFor(() => expect(button('读取来源历史').disabled).toBe(false))
    expect(root.textContent).not.toContain('保存序号 1 · change')
  })
  it('does not request history documents after an obsolete detail response arrives', async () => {
    const f = await mount(); await click('读取来源历史')
    const reply = await f.client.sourceChange(), held = deferred<typeof reply>(); f.client.sourceChange.mockClear().mockReturnValueOnce(held.promise)
    button('保存序号 1 · change').click(); await vi.waitFor(() => expect(f.client.sourceChange).toHaveBeenCalledOnce())
    f.session.state.editSeq++; await nextTick(); held.resolve(reply)
    await vi.waitFor(() => expect(button('读取来源历史').disabled).toBe(false))
    expect(f.client.sourceDocument).not.toHaveBeenCalled(); expect(mocks.views).toHaveLength(0)
  })
  it('does not create a history viewer from a ticket returned after the draft was edited', async () => {
    const f = await mount(); await click('读取来源历史')
    const held = deferred<{ asset_url: string }>(); f.client.cadTicket.mockReturnValueOnce(held.promise)
    button('保存序号 1 · change').click(); await vi.waitFor(() => expect(f.client.cadTicket).toHaveBeenCalledOnce())
    f.session.state.editSeq++; await nextTick(); held.resolve({ asset_url: '/fixed-history.html' })
    await vi.waitFor(() => expect(button('读取来源历史').disabled).toBe(false))
    expect(mocks.views).toHaveLength(0); expect(root.textContent).not.toContain('immutable')
  })
  it('does not continue with the after side when the before viewer completed just before scope invalidation', async () => {
    const f = await mount(); await click('读取来源历史')
    const held = deferred<void>(); mocks.loads.push(held.promise)
    button('保存序号 1 · change').click(); await vi.waitFor(() => expect(mocks.views).toHaveLength(1))
    held.resolve(); f.session.state.editSeq++; await nextTick()
    await vi.waitFor(() => expect(button('读取来源历史').disabled).toBe(false))
    expect(f.client.sourceDocument.mock.calls.map(call => call[3])).toEqual(['before'])
    expect(mocks.views[0].v.destroy).toHaveBeenCalled(); expect(root.textContent).not.toContain('immutable')
  })
  it('requires an explicit human selection, disposition and explanation before confirmation', async () => {
    const f = await mount(); await click('读取复核义务'); expect(f.session.confirmSourceReview).not.toHaveBeenCalled()
    expect(button('确认此焊缝复核并保存').disabled).toBe(true)
    await input('复核焊缝', 'gone'); expect(root.textContent).toContain('已删除焊缝 gone'); expect(root.textContent).toContain('d'.repeat(64)); expect(root.textContent).toContain('旧焊缝')
    await input('人工处置', 'remove_weld'); await input('复核解释', '  '); expect(button('确认此焊缝复核并保存').disabled).toBe(true)
    await input('复核解释', '确认图纸变更已删除此焊缝'); await click('确认此焊缝复核并保存')
    expect(f.session.confirmSourceReview).toHaveBeenCalledWith(expect.objectContaining({ draft_seq: 1 }), { weld_id: 'gone', expected_review_digest: 'd'.repeat(64), disposition: 'remove_weld', note: '确认图纸变更已删除此焊缝' }, f.session.state.owner)
  })
  it('never dispatches disabled confirmation and invalidates its form when the saved CAS changes', async () => {
    const f = await mount(); await click('读取复核义务'); await input('复核焊缝', 'gone'); await input('人工处置', 'remove_weld'); await input('复核解释', '人工核对')
    f.allowed.value = false; await nextTick(); await click('确认此焊缝复核并保存'); expect(f.session.confirmSourceReview).not.toHaveBeenCalled()
    f.allowed.value = true; f.session.state.dirty = true; await nextTick(); expect(button('确认此焊缝复核并保存').disabled).toBe(true)
    f.session.state.dirty = false; f.session.state.draftSeq = 2; await nextTick(); expect(root.textContent).not.toContain('d'.repeat(64)); expect(root.querySelector('textarea')).toBeNull()
  })
  it('keeps a read-only obligation visible while disabling every confirmation control', async () => {
    const f = await mount(); f.client.sourceReview.mockResolvedValue({ ...await f.client.sourceReview(), can_write: false }); await click('读取复核义务')
    expect(root.textContent).toContain('已删除待处理 1'); expect(button('确认此焊缝复核并保存').disabled).toBe(true)
    await click('确认此焊缝复核并保存'); expect(f.session.confirmSourceReview).not.toHaveBeenCalled()
  })

})
