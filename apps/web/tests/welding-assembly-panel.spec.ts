import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, createApp, nextTick, reactive, ref, type App } from 'vue'
import WeldingAssemblyPanel from '../src/views/welding/WeldingAssemblyPanel.vue'
import type { useWeldingPlanSession } from '../src/views/welding/useWeldingPlanSession'
import type { AssemblySide } from '../src/services/welding/planRecovery'

const product = { item_id: 'part', version_id: 'p1' }
const bom = (next = false) => ({ baseline_id: next ? 'new-bom' : 'old-bom', fingerprint: (next ? 'c' : 'b').repeat(64), name: '装配', number: next ? 'B2' : 'B1', captured_depth: 2,
  root: { path: [], ...product, name: '产品', number: 'P1', version_label: 'A' },
  occurrences: ['rel-a', 'rel-b'].map(rel => ({ path: [rel], item_id: 'same-part', version_id: 'part-v1', name: '同零件', number: 'P2', version_label: 'A', quantity: '1e1000', uom: '', find_number: '' })) })
let app: App | null = null, root: HTMLDivElement
function fixture() {
  let counter = 0; vi.stubGlobal('crypto', { randomUUID: () => `manual-${++counter}` })
  const enabled = ref(true)
  const state = reactive({ owner: { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }, planId: 'plan', versionId: 'v1', draftSeq: 1, contentHash: 'a'.repeat(64), editSeq: 0,
    serverState: 'Draft', dirty: false, blocked: false, pending: null, commandPending: false, busy: false, assemblyCandidates: [bom(), bom(true)], assemblyPreview: null as any,
    payload: { schema_version: 1, product, bom: { baseline_id: 'old-bom', expected_fingerprint: 'b'.repeat(64) }, welds: [{ weld_id: 'w1', display_no: '1', assembly: { a: { role: '旧人工角色', path: ['rel-a'], item_id: 'same-part', version_id: 'part-v1' }, b: { role: '旧另一侧', path: ['rel-b'], item_id: 'same-part', version_id: 'part-v1' } } }] } })
  const session = { state, canAssembly: computed(() => enabled.value), clearAssemblyPreview: vi.fn(() => { state.assemblyPreview = null }),
    readAssemblyCandidates: vi.fn(async () => {}), saveAssembly: vi.fn(async (_bom: ReturnType<typeof bom>, _weld: string, _connection: { a: AssemblySide; b: AssemblySide }) => {}), cancelAssembly: vi.fn(async (_weld: string, _reason: string) => {}), applyAssembly: vi.fn(async () => {}),
    previewAssembly: vi.fn(async (_bom, _weld, connection: { a: AssemblySide; b: AssemblySide }, _staged?: Array<{ weldId: string; connection: { a: AssemblySide; b: AssemblySide } }>) => {
      state.assemblyPreview = { impact: { affected_welds: [{ weld_id: 'w1', state: 'unknown', reason_codes: ['missing_witness'], before: null,
        after: { sides: { a: { selection: connection.a, facts: null }, b: { selection: connection.b, facts: null } } } }] } }
    }) }
  return { session, state, enabled }
}
async function mount(f: ReturnType<typeof fixture>) { root = document.createElement('div'); document.body.appendChild(root); app = createApp(WeldingAssemblyPanel, { session: f.session as unknown as ReturnType<typeof useWeldingPlanSession> }); app.mount(root); await nextTick() }
function field(label: string, within: Element = root) { return [...within.querySelectorAll('label')].find(value => value.childNodes[0]?.textContent?.trim() === label)!.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input,select,textarea')! }
async function enter(label: string, value: string, within: Element = root) { const el = field(label, within); el.value = value; el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); await nextTick() }
const button = (label: string) => [...root.querySelectorAll('button')].find(value => value.textContent?.trim() === label)!
async function select(next = false) {
  await enter('固定 BOM', next ? 'new-bom' : 'old-bom'); await enter('关联焊缝', 'w1')
  const sides = root.querySelectorAll('fieldset')
  await enter('装配位置', '["rel-a"]', sides[0]); await enter('装配位置', '["rel-b"]', sides[1])
  await enter('人工角色名称', '人工 A 侧', sides[0]); await enter('人工角色名称', '人工 B 侧', sides[1]); return sides
}
afterEach(() => { app?.unmount(); app = null; root?.remove(); vi.unstubAllGlobals() })

describe('F18 single assembly panel manual choices', () => {

  it('shows copied source roles without choosing target positions or entering target roles', async () => {
    const f = fixture(); Object.assign(f.state.payload.welds[0], { assembly_role_hints: { a: '来源支撑', b: '来源底板' } })
    delete (f.state.payload.welds[0] as Record<string, unknown>).assembly
    const before = JSON.stringify(f.state.payload); await mount(f)
    await enter('固定 BOM', 'old-bom'); await enter('关联焊缝', 'w1')
    const note = root.querySelector('[role="note"]')
    expect(note?.textContent).toContain('来源支撑'); expect(note?.textContent).toContain('来源底板')
    expect(note?.textContent).toContain('人工选择目标位置')
    for (const side of root.querySelectorAll('fieldset')) {
      expect(field('装配位置', side).value).toBe(''); expect(field('人工角色名称', side).value).toBe('')
    }
    expect(button('明确保存装配关联').disabled).toBe(true)
    expect(f.session.saveAssembly).not.toHaveBeenCalled(); expect(JSON.stringify(f.state.payload)).toBe(before)
  })
  it('clears source role hints when the selected weld or owner changes', async () => {
    const f = fixture(); f.state.payload.welds.push({ ...f.state.payload.welds[0], weld_id: 'w2', display_no: '2' })
    Object.assign(f.state.payload.welds[0], { assembly_role_hints: { a: '<b>来源A</b>', b: '来源B' } })
    await mount(f); await enter('固定 BOM', 'old-bom'); await enter('关联焊缝', 'w1')
    expect(root.querySelector('[role="note"]')?.textContent).toContain('<b>来源A</b>')
    expect(root.querySelector('[role="note"] b')).toBeNull()
    await enter('关联焊缝', 'w2'); expect(root.querySelector('[role="note"]')).toBeNull()
    await enter('关联焊缝', 'w1'); expect(root.querySelector('[role="note"]')).not.toBeNull()
    f.state.owner = { ...f.state.owner, auth_user_id: 88 }; await nextTick()
    expect(root.querySelector('[role="note"]')).toBeNull()
    expect(f.session.saveAssembly).not.toHaveBeenCalled()
  })


  it('stages another weld without saving and submits both proposals in one preview', async () => {
    const f = fixture(); f.state.payload.welds.push({ ...f.state.payload.welds[0], weld_id: 'w2', display_no: '2' }); await mount(f)
    const before = JSON.stringify(f.state.payload); await select(true); button('暂存此焊缝拟改').click(); await nextTick()
    expect(root.querySelector('[aria-label="已暂存装配拟改"]')?.textContent).toContain('1')
    expect(f.session.saveAssembly).not.toHaveBeenCalled(); expect(f.session.previewAssembly).not.toHaveBeenCalled(); expect(JSON.stringify(f.state.payload)).toBe(before)
    await enter('关联焊缝', 'w2'); const sides = root.querySelectorAll('fieldset')
    await enter('装配位置', '["rel-a"]', sides[0]); await enter('装配位置', '["rel-b"]', sides[1])
    await enter('人工角色名称', 'second A', sides[0]); await enter('人工角色名称', 'second B', sides[1])
    button('比较固定 BOM 变化').click(); await vi.waitFor(() => expect(f.session.previewAssembly).toHaveBeenCalledOnce())
    const args = f.session.previewAssembly.mock.calls[0]; expect(args[1]).toBe('w2'); expect(args[2].a.role).toBe('second A')
    expect(args[3]).toHaveLength(1); expect(args[3]![0]).toMatchObject({ weldId: 'w1', connection: { a: { role: '人工 A 侧' } } })
    expect(JSON.stringify(f.state.payload)).toBe(before)
  })
  it.each(['owner', 'baseline', 'savepoint', 'edit', 'server-state'])('discards staged proposals when %s changes', async kind => {
    const f = fixture(); await mount(f); await select(true); button('暂存此焊缝拟改').click(); await nextTick()
    expect(root.querySelector('[aria-label="已暂存装配拟改"]')).not.toBeNull()
    if (kind === 'owner') f.state.owner = { ...f.state.owner, auth_user_id: 88 }
    if (kind === 'baseline') await enter('固定 BOM', 'old-bom')
    if (kind === 'savepoint') f.state.draftSeq++
    if (kind === 'edit') f.state.editSeq++
    if (kind === 'server-state') f.state.serverState = 'InReview'
    await nextTick(); expect(root.querySelector('[aria-label="已暂存装配拟改"]')).toBeNull(); expect(f.session.saveAssembly).not.toHaveBeenCalled()
  })
  it('retains same-item positions as different full paths and displays raw BOM quantity', async () => {
    const f = fixture(); await mount(f); await enter('固定 BOM', 'old-bom')
    const select = field('装配位置', root.querySelector('fieldset')!) as HTMLSelectElement
    expect([...select.options].map(option => option.value)).toEqual(['', '[]', '["rel-a"]', '["rel-b"]'])
    expect(select.textContent).toContain('1e1000'); expect(select.textContent).toContain('rel-a'); expect(select.textContent).toContain('rel-b')
    expect(field('人工角色名称', root.querySelector('fieldset')!).value).toBe(''); expect(field('人工材料见证（可空）', root.querySelector('fieldset')!).value).toBe('')
  })
  it('does not dispatch until two different positions and both explicit human roles are chosen', async () => {
    const f = fixture(); await mount(f); await enter('固定 BOM', 'old-bom'); await enter('关联焊缝', 'w1')
    expect(button('明确保存装配关联').disabled).toBe(true); const sides = await select()
    await enter('装配位置', '["rel-a"]', sides[1]); expect(button('明确保存装配关联').disabled).toBe(true); expect(f.session.saveAssembly).not.toHaveBeenCalled()
  })
  it('submits exact full-path side identity while omitting absent optional witness fields', async () => {
    const f = fixture(); await mount(f); await select(); button('明确保存装配关联').click(); await vi.waitFor(() => expect(f.session.saveAssembly).toHaveBeenCalledOnce())
    expect(f.session.saveAssembly).toHaveBeenCalledWith(bom(), 'w1', { a: { role: '人工 A 侧', path: ['rel-a'], item_id: 'same-part', version_id: 'part-v1' }, b: { role: '人工 B 侧', path: ['rel-b'], item_id: 'same-part', version_id: 'part-v1' } })
    expect(f.session.previewAssembly).not.toHaveBeenCalled(); expect(f.session.applyAssembly).not.toHaveBeenCalled()
  })
  it('records only human-entered material with no invented thickness or default unit', async () => {
    const f = fixture(); await mount(f); const sides = await select(); expect(field('厚度单位', sides[0]).value).toBe('')
    await enter('人工材料见证（可空）', '人工材料记录', sides[0]); button('明确保存装配关联').click(); await vi.waitFor(() => expect(f.session.saveAssembly).toHaveBeenCalledOnce())
    const a = f.session.saveAssembly.mock.calls[0][2].a
    expect(a.witness).toEqual({ witness_id: 'manual-1', source: 'manual', material: '人工材料记录' }); expect(Object.hasOwn(a.witness!, 'thickness')).toBe(false)
  })
  it('requires a complete thickness entry and never sends a half measure', async () => {
    const f = fixture(); await mount(f); const sides = await select(); await enter('人工厚度见证（可空）', '2', sides[0]); button('明确保存装配关联').click(); await vi.waitFor(() => expect(root.textContent).toContain('同时填写'))
    expect(f.session.saveAssembly).not.toHaveBeenCalled()
    await enter('厚度单位', 'mm', sides[0]); expect(button('明确保存装配关联').disabled).toBe(false); button('明确保存装配关联').click(); await vi.waitFor(() => expect(f.session.saveAssembly).toHaveBeenCalledOnce())
    expect(f.session.saveAssembly.mock.calls[0][2].a.witness).toEqual({ witness_id: 'manual-1', source: 'manual', thickness: { value: 2, unit: 'mm' } })
  })
  it('changing occurrence clears old witness inputs and generates a new witness identity', async () => {
    const f = fixture(); await mount(f); const sides = await select(); await enter('人工材料见证（可空）', '第一次人工记录', sides[0]); button('明确保存装配关联').click(); await vi.waitFor(() => expect(f.session.saveAssembly).toHaveBeenCalledOnce())
    await enter('装配位置', '[]', sides[0]); expect(field('人工材料见证（可空）', sides[0]).value).toBe(''); expect(field('人工厚度见证（可空）', sides[0]).value).toBe(''); expect(field('厚度单位', sides[0]).value).toBe('')
    await enter('人工材料见证（可空）', '新位置人工记录', sides[0]); button('明确保存装配关联').click(); await vi.waitFor(() => expect(f.session.saveAssembly).toHaveBeenCalledTimes(2))
    const old = f.session.saveAssembly.mock.calls[0][2].a, next = f.session.saveAssembly.mock.calls[1][2].a
    expect(next.path).toEqual([]); expect(next.item_id).toBe('part'); expect(next.witness!.witness_id).not.toBe(old.witness!.witness_id)
  })
  it('compares a changed fixed BOM without applying, shows unknown, and requires a separate explicit apply click', async () => {
    const f = fixture(); await mount(f); await select(true); expect(button('明确保存装配关联')).toBeUndefined()
    button('比较固定 BOM 变化').click(); await vi.waitFor(() => expect(root.textContent).toContain('装配变化比较'))
    expect(f.session.previewAssembly).toHaveBeenCalledOnce(); expect(f.session.saveAssembly).not.toHaveBeenCalled(); expect(f.session.applyAssembly).not.toHaveBeenCalled()
    expect(root.textContent).toContain('待核对的事实不能视为没有影响'); expect(root.textContent).toContain('人工材料待核对')
    button('明确应用装配变化').click(); await vi.waitFor(() => expect(f.session.applyAssembly).toHaveBeenCalledOnce())
  })
  it('closing a comparison sends no domain cancellation, and changing BOM clears all human choices', async () => {
    const f = fixture(); await mount(f); const sides = await select(true); await enter('人工材料见证（可空）', '记录', sides[0]); button('比较固定 BOM 变化').click(); await vi.waitFor(() => expect(f.state.assemblyPreview).not.toBeNull())
    button('关闭本次比较').click(); await nextTick(); expect(f.state.assemblyPreview).toBeNull(); expect(f.session.cancelAssembly).not.toHaveBeenCalled()
    await enter('固定 BOM', 'old-bom'); expect(field('装配位置', sides[0]).value).toBe(''); expect(field('人工角色名称', sides[0]).value).toBe(''); expect(field('人工材料见证（可空）', sides[0]).value).toBe('')
  })
  it('cancellation requires a selected existing weld and explicit nonblank reason', async () => {
    const f = fixture(); await mount(f); expect(button('明确取消装配关联').disabled).toBe(true)
    await enter('取消关联的焊缝', 'w1'); await enter('取消原因', '人工决定取消'); button('明确取消装配关联').click(); await vi.waitFor(() => expect(f.session.cancelAssembly).toHaveBeenCalledWith('w1', '人工决定取消'))
    expect(f.session.applyAssembly).not.toHaveBeenCalled()
  })
  it('preserves human BOM/path/roles/witness inputs and displayed preview through equal owner clones', async () => {
    const f = fixture(); await mount(f); const sides = await select(true)
    await enter('人工材料见证（可空）', '人工材料记录', sides[0]); await enter('人工厚度见证（可空）', '2', sides[0]); await enter('厚度单位', 'mm', sides[0])
    button('比较固定 BOM 变化').click(); await vi.waitFor(() => expect(f.state.assemblyPreview).not.toBeNull()); const displayed = f.state.assemblyPreview
    f.state.owner = { ...f.state.owner }; await nextTick()
    expect(field('固定 BOM').value).toBe('new-bom'); expect(field('关联焊缝').value).toBe('w1')
    expect(field('装配位置', sides[0]).value).toBe('["rel-a"]'); expect(field('装配位置', sides[1]).value).toBe('["rel-b"]')
    expect(field('人工角色名称', sides[0]).value).toBe('人工 A 侧'); expect(field('人工材料见证（可空）', sides[0]).value).toBe('人工材料记录')
    expect(field('人工厚度见证（可空）', sides[0]).value).toBe('2'); expect(field('厚度单位', sides[0]).value).toBe('mm'); expect(f.state.assemblyPreview).toBe(displayed)
    expect(button('明确应用装配变化').disabled).toBe(false); button('明确应用装配变化').click(); await vi.waitFor(() => expect(f.session.applyAssembly).toHaveBeenCalledOnce())
  })
  it.each(['tenant_id', 'org_id', 'auth_user_id', 'rbac_user_id'])('clears manual selections and preview when owner %s actually changes', async fieldName => {
    const f = fixture(); await mount(f); const sides = await select(true); await enter('人工材料见证（可空）', '待核人工记录', sides[0])
    button('比较固定 BOM 变化').click(); await vi.waitFor(() => expect(f.state.assemblyPreview).not.toBeNull())
    const next = { ...f.state.owner }
    if (fieldName === 'tenant_id') next.tenant_id = 'other-tenant'
    else if (fieldName === 'org_id') next.org_id = 'other-org'
    else if (fieldName === 'auth_user_id') next.auth_user_id++
    else next.rbac_user_id++
    f.state.owner = next; await nextTick()
    expect(field('固定 BOM').value).toBe(''); expect(field('关联焊缝').value).toBe(''); expect(field('人工角色名称', sides[0]).value).toBe('')
    expect(field('人工材料见证（可空）', sides[0]).value).toBe(''); expect(f.state.assemblyPreview).toBeNull(); expect(f.session.applyAssembly).not.toHaveBeenCalled()
  })
  it('does not restore human inputs after synchronous owner ABA', async () => {
    const f = fixture(); await mount(f); const sides = await select(true), initial = { ...f.state.owner }
    await enter('人工材料见证（可空）', '待核人工记录', sides[0]); f.state.owner = { ...initial, rbac_user_id: 99 }; f.state.owner = initial; await nextTick()
    expect(field('固定 BOM').value).toBe(''); expect(field('人工材料见证（可空）', sides[0]).value).toBe(''); expect(f.session.applyAssembly).not.toHaveBeenCalled()
  })
  it('clears a displayed preview and human selections when the selected candidate is removed', async () => {
    const f = fixture(); await mount(f); const sides = await select(true); await enter('人工材料见证（可空）', '待核人工记录', sides[0])
    button('比较固定 BOM 变化').click(); await vi.waitFor(() => expect(f.state.assemblyPreview).not.toBeNull()); f.state.assemblyCandidates = [bom()]; await nextTick()
    expect(field('固定 BOM').value).toBe(''); expect(field('人工材料见证（可空）', sides[0]).value).toBe(''); expect(f.state.assemblyPreview).toBeNull(); expect(button('明确应用装配变化')).toBeUndefined()
  })
  it('turning write eligibility off disables every new assembly action', async () => {
    const f = fixture(); await mount(f); await select(); f.enabled.value = false; await nextTick()
    expect(button('读取固定 BOM 装配位置').disabled).toBe(true); expect(button('明确保存装配关联').disabled).toBe(true); expect(button('明确取消装配关联').disabled).toBe(true)
    expect([...root.querySelectorAll('fieldset')].every(value => value.disabled)).toBe(true); expect(f.session.saveAssembly).not.toHaveBeenCalled()
  })
})
