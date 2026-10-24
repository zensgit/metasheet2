import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { useWeldingCadSession } from '../src/views/welding/useWeldingCadSession'
import { useWeldingPlanSession } from '../src/views/welding/useWeldingPlanSession'
import { clone, equal, type PlanRecoveryRecord, type PlanRecoveryStore } from '../src/services/welding/planRecovery'
import { withGenerationOwnerLock } from '../src/services/welding/commandRecovery'
import { WELDING_CAD_PIN, WeldingPlanError, type WeldingPlanClient } from '../src/services/welding/planClient'
import { summarizeWelds } from '../src/services/welding/measurements'
const native = vi.hoisted(() => ({ ws: null as any, action: Promise.resolve(), options: null as any, context: null as any, mutate: null as null | ((value: any) => void) }))
vi.mock('/welding-cad/b05b3684664f215ced015f09f23d300fcccf8ba49ea4e8826e1a373070083bb8/helpers/welding_measurement.js', async () => { const { createRequire } = await import('node:module'); return createRequire(import.meta.url)(`${(await import('./utils/weldingNativeOracle')).nativeOracleRoot()}/tools/web_viewer/helpers/welding_measurement.js`) })
vi.mock('../src/services/welding/cadBridge', async () => {
  const actual = await vi.importActual<typeof import('../src/services/welding/cadBridge')>('../src/services/welding/cadBridge')
  const { createRequire } = await import('node:module')
  const { workspace, context } = createRequire(import.meta.url)(`${(await import('./utils/weldingNativeOracle')).nativeOracleRoot()}/tools/web_viewer/tests/helpers/welding_entry_harness.js`); native.context = context
  return { ...actual, createCadBridge(options: any) {
    const ws = workspace(); native.ws = ws; native.options = options
    ws.configureWeldingHost({ onAction(action: any) { const copy = structuredClone(action); native.mutate?.(copy); native.action = options.onAction({ ...copy, action_id: crypto.randomUUID(), base_local_seq: options.getLocalSeq() }).then(() => ws.acceptWeldingAction(action.native_ticket)); void native.action.catch(() => {}) }, onIntentCancelled: options.onIntentCancelled, onHistoryRequest: options.onHistoryRequest })
    async function operation(fn: () => any) { native.action = Promise.resolve(); const result = fn(); if (result?.ok === false) throw new Error(result.message ?? result.error ?? 'native rejected'); await native.action; return { changed: true } }
    return {
      async load(c: any, overlay: any) { ws.loadWeldingContext({ context_key: c.context_id, base_snapshot: context().overlay.snapshot, overlay: JSON.parse(JSON.stringify(overlay)) }, { expected_context_key: null }); return { snapshot: ws.getOverlaySnapshot() } },
      async snapshot() { return { snapshot: ws.snapshotWeldingOverlay(), local_seq: options.getLocalSeq() } },
      async restore(overlay: any, next: number) { ws.restoreWeldingOverlay(overlay, { expected_context_key: ws.getWeldingContext().context_key, expected_edit_revision: ws.getWeldingContext().edit_revision }); return { snapshot: ws.getOverlaySnapshot(), local_seq: next } },
      async select(ids: number[], primary: number | null) { options.onSelection({ entity_ids: ids, primary_id: primary }); return {} },
      bind: (bindings: any) => operation(() => ws.commands.execute('welding.bindings.set', { bindings })),
      armDraw: async (value: any) => { ws.armWeldingDraw(value); return {} },
      copyWeld: (value: any) => operation(() => ws.copyWeldingBinding(value)),
      annotateWeld: (value: any) => operation(() => ws.annotateWeldingBinding(value)),
      representation: (value: any) => operation(() => ws.changeWeldingRepresentation(value)), destroy() {},
    }
  } }
})
const owner = { tenant_id: 't', org_id: 'o', auth_user_id: 7, rbac_user_id: 19 }
const cleanups: Array<() => void> = []
async function setup() {
  const input = native.context(), payload = { schema_version: 1, product: { item_id: 'p', version_id: 'pv' }, drawing: { item_id: 'd', version_id: 'dv', file_id: 'f', file_role: 'drawing', expected_checksum: 'a'.repeat(64) }, welds: [{ weld_id: 'weld-1', display_no: 'W1', method: 'M', welding_steps: ['step'], passes: [], future: 'keep' }], overlay: input.overlay }
  const plan = { plan_id: 'p', item_version_id: 'v', draft_seq: 1, content_hash: 'a'.repeat(64), state: 'Draft', name: 'P', number: '1', payload, sources: {}, version_label: 'A' }
  const cadContext = { context_id: 'ctx', plan_id: 'p', item_version_id: 'v', draft_seq: 1, expires_at: new Date(Date.now() + 60000).toISOString(), unit: 'mm', cadgf_document: input.cadgf_document, input_sha256: 'a'.repeat(64), document_sha256: 'b'.repeat(64), source: {}, editor_url: `/welding-cad/${WELDING_CAD_PIN}/welding-frame.html`, origin: { schema: 'yuantus.welding_plan_cad_origin/1', context_id: 'ctx', owner_auth_user_id: 7, rbac_user_id: 19, bundle_sha256: WELDING_CAD_PIN, unit: 'mm', basis: { product: payload.product, drawing: payload.drawing }, input: { sha256: 'a'.repeat(64) }, document: { sha256: 'b'.repeat(64) }, source: {} } }
  const client = { recoveryOwner: vi.fn(async () => clone(owner)), read: vi.fn(async () => clone(plan)), recover: vi.fn(async (_p, r) => ({ owner, record_id: r.recovery_id, current: clone(plan), can_write: true, conflict: false })), list: vi.fn(async () => ({ items: [], total: 0, offset: 0 })), createCadContext: vi.fn(async () => clone(cadContext)), cadTicket: vi.fn(async () => ({ asset_url: cadContext.editor_url })), revokeCadContext: vi.fn(async () => null) } as unknown as WeldingPlanClient
  let stored: PlanRecoveryRecord | null = null
  const db: PlanRecoveryStore = { list: async () => [], get: async () => clone(stored), claim: vi.fn(async r => { stored = clone(r); return true }), compareReplace: vi.fn(async (old, next) => { if (!equal(old, stored)) return false; stored = clone(next); return true }), close() {} }
  const scope = effectScope(), session = scope.run(() => useWeldingPlanSession({ client, openStore: async () => db, writable: () => true }))!
  session.setWorkflowAdmission(async (scope, _mode, _target, action) => action(scope)); session.setGenerationAdmission(async (scope, _mode, _target, action) => withGenerationOwnerLock(owner, scope, action))
  await session.initialize(); await session.open('p', 'v'); const cad = scope.run(() => useWeldingCadSession(session))!
  const frame = document.createElement('iframe'); document.body.appendChild(frame)
  cleanups.push(() => { scope.stop(); frame.remove() }); await cad.open(frame)
  return { session, cad, client, db, cadContext, stored: () => stored, frame }
}
beforeEach(() => { const tails = new Map<string, Promise<unknown>>(); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request(name: string, _options: unknown, action: () => Promise<unknown>) { const job = (tails.get(name) ?? Promise.resolve()).catch(() => {}).then(action); tails.set(name, job); return job } } }); localStorage.setItem('auth_token', 'native'); native.mutate = null })
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); delete (navigator as any).locks })
describe('actual CAD business consumer with native controller (transport substituted)', () => {
  it('deletes one weld and all its roles and references atomically, with undo', async () => {
    const f = await setup()
    await f.cad.representation({ mode: 'upgrade', names: [{ weld_id: 'weld-1', representation_id: 'front', view_name: '主视图' }] })
    await f.cad.select('weld-1'); f.cad.state.representationId = 'front'; await f.cad.annotate('label'); await f.cad.annotate('leader')
    await f.session.edit(p => { p.resource_refs = [{ reference_id: 'joint-original', weld_id: 'weld-1', resource_id: 'joint', version_id: 'joint-v1', expected_content_hash: 'd'.repeat(64), purpose: 'joint_diagram', selected_fields: [] }] })
    await f.cad.copy('W2', true, true, { x: 10, y: 10 })
    await f.cad.representation({ mode: 'copy', weld_id: 'weld-1', source_representation_id: 'front', representation_id: 'side', view_name: '侧视图', delta: { x: 20, y: 20 } })
    const before = clone(f.session.state.payload), expected = clone(before), overlay = expected.overlay as any
    const target = overlay.bindings.find((b: any) => b.weld_id === 'weld-1')
    const removed = new Set(target.representations.flatMap((r: any) => [...r.entity_ids, r.label_id, r.leader_id].filter((id: any) => id !== null)))
    expected.welds = expected.welds.filter(w => w.weld_id !== 'weld-1'); expected.resource_refs = (expected.resource_refs as any[]).filter(r => r.weld_id !== 'weld-1')
    overlay.bindings = overlay.bindings.filter((b: any) => b.weld_id !== 'weld-1'); overlay.snapshot.entities = overlay.snapshot.entities.filter((e: any) => !removed.has(e.id))
    const cursor = f.session.state.historyCursor
    await f.cad.removeWeld('weld-1')
    expect(f.session.state.payload).toEqual(expected); expect(native.ws.getOverlaySnapshot()).toEqual(expected.overlay)
    expect(f.session.state.historyCursor).toBe(cursor + 1); expect(f.stored()?.draft.payload).toEqual(expected)
    await f.cad.history('undo'); expect(f.session.state.payload).toEqual(before); expect(native.ws.getOverlaySnapshot()).toEqual(before.overlay)
  })
  it('deletes without a live CAD frame and preserves the fixed basis and undo', async () => {
    const f = await setup(), before = clone(f.session.state.payload); f.cad.close()
    await f.cad.removeWeld('weld-1')
    expect(f.session.state.payload.welds).toEqual([]); expect((f.session.state.payload.overlay as any).bindings).toEqual([])
    expect(f.session.state.payload.product).toEqual(before.product); expect(f.session.state.payload.drawing).toEqual(before.drawing)
    await f.cad.history('undo'); expect(f.session.state.payload).toEqual(before)
  })
  it('keeps the business payload when identity changes during native deletion restore', async () => {
    const f = await setup(), before = clone(f.session.state.payload), restore = native.ws.restoreWeldingOverlay.bind(native.ws)
    vi.spyOn(native.ws, 'restoreWeldingOverlay').mockImplementationOnce((...args: any[]) => { const value = restore(...args); localStorage.setItem('auth_token', 'changed'); return value })
    await expect(f.cad.removeWeld('weld-1')).rejects.toThrow()
    expect(f.session.state.payload).toEqual(before); expect(f.cad.state.ready).toBe(false)
  })
  it('rejects an unknown deletion target without changing either snapshot', async () => {
    const f = await setup(), before = clone(f.session.state.payload), restore = vi.spyOn(native.ws, 'restoreWeldingOverlay')
    await expect(f.cad.removeWeld('unknown')).rejects.toThrow('焊缝')
    expect(f.session.state.payload).toEqual(before); expect(native.ws.getOverlaySnapshot()).toEqual(before.overlay); expect(restore).not.toHaveBeenCalled()
  })
  it('keeps the live CAD context when unchanged reference objects have reordered keys', async () => {
    const f = await setup(), original = clone(f.session.state.payload)
    f.session.state.payload.product = Object.fromEntries(Object.entries(original.product!).reverse()) as typeof original.product
    f.session.state.payload.drawing = Object.fromEntries(Object.entries(original.drawing!).reverse()) as typeof original.drawing
    expect(f.session.state.payload.product).toEqual(original.product); expect(f.session.state.payload.drawing).toEqual(original.drawing)
    expect(f.cad.state.ready, f.cad.state.message).toBe(true); expect(f.session.state.overlayContextId).toBe('ctx')
    expect(f.cad.canAct.value).toBe(true)
  })
  it('closes the context when the fixed drawing checksum changes', async () => {
    const f = await setup()
    await f.session.edit(p => { p.drawing = { ...p.drawing!, expected_checksum: 'b'.repeat(64) } })
    expect(f.cad.state.ready).toBe(false); expect(f.session.state.overlayContextId).toBe('')
  })
  it('closes the old CAD frame and clears its context immediately when the drawing basis changes', async () => {
    const f = await setup(); expect(f.cad.state.ready).toBe(true); expect(f.session.state.overlayContextId).toBe('ctx')
    await f.session.edit(p => { p.drawing = { ...p.drawing!, file_id: 'other-drawing' } })
    expect(f.cad.state.ready).toBe(false); expect(f.session.state.overlayContextId).toBe('')
    expect(f.stored()?.draft.payload.drawing?.file_id).toBe('other-drawing')
  })
  it('keeps identity across fresh owner reads and applies upgrade/copy/rename/primary/remove as complete atomic payloads', async () => {
    const f = await setup(); expect(f.cad.state.ready).toBe(true); const original = clone(f.session.state.payload)
    for (const operation of [
      { mode: 'upgrade', names: [{ weld_id: 'weld-1', representation_id: 'front', view_name: '主视图' }] },
      { mode: 'copy', weld_id: 'weld-1', source_representation_id: 'front', representation_id: 'back', view_name: '背视图', delta: { x: 0, y: 50 } },
      { mode: 'rename', weld_id: 'weld-1', representation_id: 'back', view_name: '背视图二' },
      { mode: 'primary', weld_id: 'weld-1', representation_id: 'back' },
      { mode: 'remove', weld_id: 'weld-1', representation_id: 'back', replacement_primary_id: 'front' },
    ]) { await f.cad.representation(operation); expect(f.stored()?.draft.payload).toEqual(f.session.state.payload); expect(f.cad.state.ready).toBe(true) }
    expect(f.session.state.historyLength).toBe(5); expect(f.session.state.payload.welds).toEqual(original.welds); expect(f.cad.state.measurement!.rows).toHaveLength(1)
    await f.cad.representation({ mode: 'remove', weld_id: 'weld-1', representation_id: 'front', replacement_primary_id: null }); expect((f.session.state.payload.overlay as any).schema).toBe('vemcad-weld-overlay/3'); expect((f.session.state.payload.overlay as any).bindings).toEqual([])
  })
  it('restores native snapshots while the first upgrade save is UNKNOWN and replays the unchanged request', async () => {
    const f = await setup(), before = clone(f.session.state.payload)
    f.client.save = vi.fn(async original => ({ ...clone(f.session.state.savedPoint!), draft_seq: original.draft.base_draft_seq + 1,
      content_hash: 'c'.repeat(64), save_id: original.pending!.body.save_id, payload: { bom: null, process_refs: [], ...clone(original.pending!.body.payload) as typeof before, welds: (original.pending!.body.payload as typeof before).welds.map(weld => ({ location: '', joint_type: '', method: '', material_a: '', material_b: '', filler: '', thickness_a: null, thickness_b: null, manufacturing_length: null, measured_length: null, welding_requirements: '', inspection_requirements: '', passes: [], ...weld })) } }))
    await f.cad.representation({ mode: 'upgrade', names: [{ weld_id: 'weld-1', representation_id: 'front', view_name: '主视图' }] })
    const upgraded = clone(f.session.state.payload)
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost', 0)); await f.session.save()
    const pending = clone(f.session.state.pending!)
    expect(pending).not.toBeNull(); expect(f.cad.canAct.value).toBe(false)
    await expect(f.cad.barrier()).rejects.toThrow()
    await expect(f.cad.draw('line', '')).rejects.toThrow()
    await f.cad.history('undo')
    expect(f.session.state.payload).toEqual(before); expect(native.ws.getOverlaySnapshot()).toEqual(before.overlay)
    expect(f.stored()!.pending).toEqual({ ...pending, local_ahead: true }); expect(f.cad.state.ready).toBe(true)
    await f.cad.history('redo')
    expect(f.session.state.payload).toEqual(upgraded); expect(native.ws.getOverlaySnapshot()).toEqual(upgraded.overlay)
    expect(f.stored()!.pending).toEqual(pending); expect(f.cad.canAct.value).toBe(false)
    await f.session.confirmOriginal()
    expect(vi.mocked(f.client.save).mock.calls[1][0].pending).toEqual(pending)
    expect(f.session.state.pending, f.session.state.message).toBeNull(); expect(f.session.state.historyLength).toBe(0)
    expect(f.session.state.message).toContain('已建立多表示保存边界')
    await expect(f.cad.history('undo')).rejects.toThrow()
  })
  it('draws a native line and commits the new business weld in the same durable history step; explicit cancel adds nothing', async () => {
    const f = await setup(); await f.cad.draw('line', ''); expect(f.session.state.payload.welds).toHaveLength(1); expect(await f.session.prepareLeave()).toBe(false)
    const result = native.ws.commands.execute('entity.create', { entity: { type: 'line', layerId: 0, start: { x: 10, y: 10 }, end: { x: 20, y: 10 } } }); expect(result.ok).toBe(true); await native.action
    expect(f.session.state.payload.welds).toHaveLength(2); expect(f.session.state.historyLength).toBe(1); expect(f.stored()?.draft.payload).toEqual(f.session.state.payload)
    await f.cad.draw('line', ''); await f.cad.cancel(); expect(f.session.state.payload.welds).toHaveLength(2); expect(f.session.state.historyLength).toBe(1)
  })
  it.each([[false, false], [false, true], [true, false], [true, true]])('copies business fields and restores complete history: represented=%s, parameters=%s', async (represented, copyParams) => {
    const f = await setup()
    await f.session.edit(p => Object.assign(p.welds[0], { group_name: 'FRAME', classification: 'BUTT', included: false,
      manufacturing_length: { value: 2, unit: 'in' }, measured_length: { value: 40, unit: 'mm' } }))
    if (represented) await f.cad.representation({ mode: 'upgrade', names: [{ weld_id: 'weld-1', representation_id: 'front', view_name: 'Front' }] })
    await f.cad.select('weld-1')
    const before = clone(f.session.state.payload), length = f.cad.state.measurement!.rows[0].length_mm, history = f.session.state.historyLength
    await f.cad.copy('W2', copyParams, false, { x: 10, y: 10 })
    const after = clone(f.session.state.payload), copied = after.welds[1]
    expect(after.welds).toHaveLength(2); expect(after.welds[0]).toEqual(before.welds[0])
    expect(copied.weld_id).not.toBe(before.welds[0].weld_id); expect(copied.display_no).toBe('W2')
    expect(copied.included).toBe(true); expect(copied.measured_length).toBeNull()
    expect(copied.manufacturing_length).toEqual(copyParams ? { value: 2, unit: 'in' } : null)
    for (const key of ['group_name', 'classification']) {
      if (copyParams) expect(copied[key]).toBe(before.welds[0][key])
      else expect(Object.hasOwn(copied, key)).toBe(false)
    }
    const totals = summarizeWelds(after, f.cad.state.measurement!.rows).totals
    expect(totals).toMatchObject({ weld_count: 2, included_count: 1,
      geometry: { known_count: 1, missing_count: 0, value_mm: length, complete: true },
      manufacturing: { known_count: copyParams ? 1 : 0, missing_count: copyParams ? 0 : 1, value_mm: copyParams ? 50.8 : 0, complete: copyParams },
      manual: { known_count: 0, missing_count: 1, value_mm: 0, complete: false } })
    expect(f.session.state.historyLength).toBe(history + 1); expect(f.stored()?.draft.payload).toEqual(after)
    await f.cad.history('undo'); expect(f.session.state.payload).toEqual(before); expect(f.stored()?.draft.payload).toEqual(before)
    expect(native.ws.getOverlaySnapshot()).toEqual(before.overlay)
    await f.cad.history('redo'); expect(f.session.state.payload).toEqual(after); expect(f.stored()?.draft.payload).toEqual(after)
    expect(native.ws.getOverlaySnapshot()).toEqual(after.overlay)
  })
  it.each([false, true])('preserves sparse legacy business fields when copying parameters=%s', async copyParams => {
    const f = await setup(); await f.cad.select('weld-1')
    const original = clone(f.session.state.payload.welds[0])
    await f.cad.copy('W2', copyParams, false, { x: 10, y: 10 })
    expect(f.session.state.payload.welds[0]).toEqual(original)
    for (const key of ['group_name', 'classification', 'included']) expect(Object.hasOwn(f.session.state.payload.welds[1], key)).toBe(false)
    expect(summarizeWelds(f.session.state.payload, f.cad.state.measurement!.rows).totals.included_count).toBe(2)
  })
  it('copies fixed joint diagrams only with copyRefs and assigns a new reference identity', async () => {
    const f = await setup()
    const source = { reference_id: 'joint-original', weld_id: 'weld-1', resource_id: 'joint', version_id: 'joint-v1', expected_content_hash: 'd'.repeat(64), purpose: 'joint_diagram', selected_fields: [] }
    await f.session.edit(p => { p.resource_refs = [source] }); await f.cad.select('weld-1'); await f.cad.copy('W2', true, true, { x: 10, y: 10 })
    const refs = f.session.state.payload.resource_refs as Record<string, unknown>[]
    expect(refs).toHaveLength(2); expect(refs[0]).toEqual(source)
    expect(refs[1]).toEqual({ ...source, reference_id: expect.any(String), weld_id: f.session.state.payload.welds[1].weld_id })
    expect(refs[1].reference_id).not.toBe(source.reference_id); expect(f.stored()?.draft.payload.resource_refs).toEqual(refs)
    await f.cad.select('weld-1'); await f.cad.copy('W3', true, false, { x: 20, y: 20 })
    expect(f.session.state.payload.resource_refs).toEqual(refs); expect(f.session.state.payload.welds).toHaveLength(3)
  })
  it('annotations and complete business copy preserve original roles and create fresh fixed resource references', async () => {
    const f = await setup(); await f.session.edit(p => { p.resource_refs = [{ reference_id: 'ref', weld_id: 'weld-1', resource_id: 'r', version_id: 'v', expected_content_hash: 'c'.repeat(64), selected_fields: ['method'] }] }); await f.cad.select('weld-1')
    for (const mode of ['label', 'leader', 'removeLeader'] as const) await f.cad.annotate(mode)
    await f.cad.copy('W2', true, true, { x: 10, y: 10 })
    expect(f.session.state.payload.welds).toHaveLength(2); expect(f.session.state.payload.welds[1]).toMatchObject({ method: 'M', welding_steps: ['step'] }); const refs = f.session.state.payload.resource_refs as any[]; expect(refs).toHaveLength(2); expect(refs[1].reference_id).not.toBe('ref'); expect(refs[1].weld_id).toBe(f.session.state.payload.welds[1].weld_id)
  })
  it('rejects wrong representation primary/roles, quota and same native-token mapped owner changes without business publication', async () => {
    const f = await setup(); const before = clone(f.session.state.payload)
    native.mutate = action => { action.after.bindings[0].primary_representation_id = 'absent' }
    await expect(f.cad.representation({ mode: 'upgrade', names: [{ weld_id: 'weld-1', representation_id: 'front', view_name: '主视图' }] })).rejects.toThrow(); expect(f.session.state.payload).toEqual(before)
    native.mutate = null; await f.cad.open(f.frame); vi.mocked(f.db.claim).mockRejectedValueOnce(new Error('quota'))
    await expect(f.cad.representation({ mode: 'upgrade', names: [{ weld_id: 'weld-1', representation_id: 'front', view_name: '主视图' }] })).rejects.toThrow('quota'); expect(f.session.state.payload).toEqual(before)
    await f.cad.open(f.frame); vi.mocked(f.client.recoveryOwner).mockResolvedValue({ ...owner, rbac_user_id: 20 })
    await expect(f.cad.representation({ mode: 'upgrade', names: [{ weld_id: 'weld-1', representation_id: 'front', view_name: '主视图' }] })).rejects.toThrow(); expect(f.session.state.owner).toBeNull()
  })
  it('rejects wrong context pin before ticket/frame and explicitly revokes valid context', async () => {
    const f = await setup(); await f.cad.revoke(); expect(f.client.revokeCadContext).toHaveBeenCalled(); expect(f.cad.state.ready).toBe(false)
    f.cadContext.origin.bundle_sha256 = 'a'.repeat(64); vi.mocked(f.client.cadTicket).mockClear(); await expect(f.cad.open(f.frame)).rejects.toThrow(); expect(f.client.cadTicket).not.toHaveBeenCalled()
  })
  it('binds/unbinds native selection, renumbers labels and atomically restores full undo/redo payloads', async () => {
    const f = await setup(); await f.cad.select('weld-1')
    await f.cad.bind(true); expect((f.session.state.payload.overlay as any).bindings).toEqual([])
    f.cad.state.selectedEntities = [101, 102]; await f.cad.bind(); expect((f.session.state.payload.overlay as any).bindings[0].entity_ids).toEqual([101, 102])
    await f.cad.annotate('label'); const measured = JSON.parse(JSON.stringify(f.cad.state.measurement!.rows))
    await f.cad.renumber([{ weld_id: 'weld-1', old_no: 'W1', new_no: 'W9' }]); expect(f.session.state.payload.welds[0].display_no).toBe('W9')
    expect(f.cad.state.measurement!.overlay).toEqual(f.session.state.payload.overlay)
    expect(f.cad.state.measurement!.rows).toEqual(measured)
    await f.cad.history('undo'); expect(f.session.state.payload.welds[0].display_no).toBe('W1'); expect(native.ws.getOverlaySnapshot()).toEqual(f.session.state.payload.overlay)
    await f.cad.history('redo'); expect(f.session.state.payload.welds[0].display_no).toBe('W9'); expect(f.stored()?.draft.payload).toEqual(f.session.state.payload)
    await expect(f.cad.renumber([{ weld_id: 'weld-1', old_no: 'W1', new_no: 'wrong' }])).rejects.toThrow()
  })
  it('adds only unowned geometry as a representation and measures exactly the primary representation', async () => {
    const f = await setup(), initial = f.cad.state.measurement!.rows[0].length_mm
    await f.cad.representation({ mode: 'upgrade', names: [{ weld_id: 'weld-1', representation_id: 'front', view_name: '主视图' }] })
    const command = native.ws.commands.execute('entity.create', { entity: { type: 'line', layerId: 0, start: { x: 0, y: 0 }, end: { x: 300, y: 0 } } }); expect(command.ok).toBe(true); await native.action
    const entity = native.ws.getOverlaySnapshot().snapshot.entities.at(-1).id
    await f.cad.representation({ mode: 'add', weld_id: 'weld-1', representation_id: 'second', view_name: '侧视图', entity_ids: [entity] })
    expect(f.cad.state.measurement!.rows[0].length_mm).toBe(initial)
    await f.cad.representation({ mode: 'primary', weld_id: 'weld-1', representation_id: 'second' }); expect(f.cad.state.measurement!.rows[0].length_mm).toBe(300)
    await expect(f.cad.representation({ mode: 'add', weld_id: 'weld-1', representation_id: 'steal', view_name: '重复', entity_ids: [entity] })).rejects.toThrow()
    await expect(f.cad.representation({ mode: 'remove', weld_id: 'weld-1', representation_id: 'second', replacement_primary_id: null })).rejects.toThrow()
  })

  it('checks admission before an already open native CAD consumer dispatches any mutation', async () => {
    const f = await setup(); await f.cad.select('weld-1')
    const before = clone(native.ws.getOverlaySnapshot()), payload = clone(f.session.state.payload)
    const effects = ['armWeldingDraw', 'copyWeldingBinding', 'annotateWeldingBinding', 'changeWeldingRepresentation', 'restoreWeldingOverlay'].map(name => vi.spyOn(native.ws, name))
    const binding = vi.spyOn(native.ws.commands, 'execute'); vi.mocked(f.client.createCadContext).mockClear(); vi.mocked(f.client.revokeCadContext).mockClear()
    f.session.setGenerationAdmission(async (scope, _mode, _target, _action) => withGenerationOwnerLock(owner, scope, async () => { throw new Error('pending gate') }))
    for (const action of [
      () => f.cad.open(f.frame), () => f.cad.draw('line', ''), () => f.cad.copy('W2', true, false, { x: 1, y: 1 }),
      () => f.cad.annotate('label'), () => f.cad.representation({ mode: 'upgrade', names: [{ weld_id: 'weld-1', representation_id: 'front', view_name: '主视图' }] }),
      () => f.cad.removeWeld('weld-1'), () => f.cad.bind(true), () => f.cad.history('undo'), () => f.cad.renumber([{ weld_id: 'weld-1', old_no: 'W1', new_no: 'W9' }]), () => f.cad.revoke(),
    ]) await expect(action()).rejects.toThrow('pending gate')
    for (const effect of [...effects, binding]) expect(effect).not.toHaveBeenCalled()
    expect(f.client.createCadContext).not.toHaveBeenCalled(); expect(f.client.revokeCadContext).not.toHaveBeenCalled(); expect(native.ws.getOverlaySnapshot()).toEqual(before)
    expect(f.session.state.payload).toEqual(payload); expect(f.cad.state.intent).toBe('')
  })

})
