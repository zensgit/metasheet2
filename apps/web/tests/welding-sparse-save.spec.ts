import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWeldingPlanSession } from '../src/views/welding/useWeldingPlanSession'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { WeldingPlanError, type WeldingPlanClient, type RecoveryAuthority, type PlanRecord } from '../src/services/welding/planClient'
import { clone, equal, type PlanRecoveryRecord, type PlanRecoveryStore } from '../src/services/welding/planRecovery'

const owner = { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }
const payload = () => ({ schema_version: 1 as const, bom: null, process_refs: [], product: { item_id: 'part', version_id: 'p1' }, drawing: { item_id: 'drawing', version_id: 'd1', file_id: 'f1', file_role: 'drawing', expected_checksum: 'a'.repeat(64) }, welds: [{ weld_id: 'w1', display_no: '1', location: 'old', passes: [], joint_type: '', method: '', material_a: '', material_b: '', filler: '', thickness_a: null, thickness_b: null, manufacturing_length: null, measured_length: null, welding_requirements: '', inspection_requirements: '' }],
  overlay: { schema: 'vemcad-weld-overlay/3', opaque: { retain: true } }, assembly_source: { representation_id: 'original' } })
const plan = (): PlanRecord => ({ plan_id: 'plan', item_version_id: 'v1', name: 'Plan', number: 'W1', state: 'Draft', version_label: 'A', draft_seq: 1, content_hash: 'a'.repeat(64), payload: payload(), sources: { baseline: 'original', actor: 19 } })
function fixture() {
  let stored: PlanRecoveryRecord | null = null, counter = 0
  const db: PlanRecoveryStore = {
    list: vi.fn(async value => stored && equal(stored.owner, value) ? [clone(stored)] : []),
    get: vi.fn(async (value, id) => stored && equal(stored.owner, value) && stored.recovery_id === id ? clone(stored) : null),
    claim: vi.fn(async record => { if (stored) return equal(stored, record); stored = clone(record); return true }),
    compareReplace: vi.fn(async (expected, next) => { if (!equal(stored, expected)) return false; stored = clone(next); return true }),
    close: vi.fn(),
  }
  const client = {
    recoveryOwner: vi.fn(async () => clone(owner)),
    list: vi.fn(async () => ({ items: [plan()], total: 1, offset: 0, limit: 50 })),
    read: vi.fn(async () => plan()),
    recover: vi.fn(async (_purpose, record: PlanRecoveryRecord): Promise<RecoveryAuthority> => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner: clone(record.owner), record_id: record.recovery_id, current: record.draft.version_id === null ? null : plan(), can_write: true, conflict: false })),
    save: vi.fn(async (record: PlanRecoveryRecord): Promise<PlanRecord> => ({ ...plan(), plan_id: record.draft.plan_id, item_version_id: record.draft.version_id ?? 'allocated', draft_seq: record.draft.base_draft_seq + 1, content_hash: 'b'.repeat(64), save_id: record.pending!.body.save_id, payload: clone(record.pending!.body.payload) as PlanRecord['payload'] })),
    productCandidates: vi.fn(async () => []), drawingCandidates: vi.fn(async () => []),
    productContext: vi.fn(async product => ({ ...product, name: 'Part', number: 'P1', version_label: 'A' })), bomCandidates: vi.fn(async () => []), authority: vi.fn(async () => owner),
  } as unknown as WeldingPlanClient
  let writable = true
  const session = useWeldingPlanSession({ client, openStore: async () => db, writable: () => writable, uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` })
  session.setWorkflowAdmission(async (scope, _mode, _target, action) => action(scope)); session.setGenerationAdmission(async (scope, _mode, _target, action) => action(scope))
  return { session, client, db, getStored: () => clone(stored), setStored: (value: PlanRecoveryRecord | null) => { stored = clone(value) }, setWritable: (value: boolean) => { writable = value } }
}
describe('welding sparse saved-field recovery', () => {
  const sessions: Array<ReturnType<typeof fixture>['session']> = []
  function make() { const f = fixture(); sessions.push(f.session); return f }
  beforeEach(() => localStorage.setItem('auth_token', 'native-A'))
  afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); vi.restoreAllMocks() })
  async function opened(f: ReturnType<typeof fixture>) { await f.session.initialize(); await f.session.open('plan', 'v1') }
  function followSavedPoint(f: ReturnType<typeof fixture>) {
    let current = plan()
    vi.mocked(f.client.read).mockImplementation(async () => clone(current))
    vi.mocked(f.client.recover).mockImplementation(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current: clone(current), can_write: true, conflict: false }))
    vi.mocked(f.client.save).mockImplementation(async record => {
      const next = clone(record.pending!.body.payload) as PlanRecord['payload']
      if ('preparation_notes' in current.payload && !('preparation_notes' in next)) throw new WeldingPlanError('saved preparation omitted', 409)
      for (const row of next.welds) {
        const old = current.payload.welds.find(weld => weld.weld_id === row.weld_id)
        if (old && ['group_name', 'classification', 'included', 'welding_steps'].some(key => key in old && !(key in row))) throw new WeldingPlanError('saved field omitted', 409)
      }
      current = { ...current, draft_seq: current.draft_seq + 1, content_hash: String(current.draft_seq % 10).repeat(64), payload: next, save_id: record.pending!.body.save_id as string }
      return clone(current)
    })
  }
  const labels = { group_name: 'frame', classification: 'structural', included: false }
  async function moveHistory(f: ReturnType<typeof fixture>, direction: 'undo' | 'redo') {
    const step = f.session.historyCandidate(direction)
    await f.session.commitPayload(step.payload, f.session.capture(), step.cursor)
  }
  it('sparse save clears saved preparation and ordered steps after undo without changing history', async () => {
    const f = make(); followSavedPoint(f); await opened(f)
    const before = clone(f.session.state.payload)
    await f.session.edit(value => { value.preparation_notes = 'clean'; value.welds[0].welding_steps = ['tack', 'weld'] }); await f.session.save()
    await moveHistory(f, 'undo'); expect(f.session.state.payload).toEqual(before)
    await f.session.save(); expect(f.session.state.dirty).toBe(false)
    expect(f.session.state.payload).toEqual({ ...before, preparation_notes: '', welds: [{ ...before.welds[0], welding_steps: [] }] })
    expect(vi.mocked(f.client.save).mock.calls[1][0].draft.payload).toEqual(before)
    await moveHistory(f, 'redo')
    expect(f.session.state.payload.preparation_notes).toBe('clean'); expect(f.session.state.payload.welds[0].welding_steps).toEqual(['tack', 'weld'])
  })
  it('sparse save freezes preparation and step clears after restored undo through UNKNOWN replay', async () => {
    const f = make(); followSavedPoint(f); await opened(f)
    await f.session.edit(value => { value.preparation_notes = 'clean'; value.welds[0].welding_steps = ['tack'] }); await f.session.save()
    await moveHistory(f, 'undo'); const draft = f.getStored()!
    notifyAuthPrincipalChange(); await f.session.initialize(); await f.session.previewRecovery(draft); await f.session.restoreRecovery()
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost', 0)); await f.session.save()
    const original = f.getStored()!
    expect(original.pending!.body.payload).toMatchObject({ preparation_notes: '', welds: [{ welding_steps: [] }] })
    expect(original.draft.payload).not.toHaveProperty('preparation_notes'); expect(original.draft.payload.welds[0]).not.toHaveProperty('welding_steps')
    await f.session.confirmOriginal()
    expect(vi.mocked(f.client.save).mock.calls.slice(1).map(([record]) => record)).toEqual([original, original])
    expect(f.session.state.pending).toBeNull()
  })
  it('sparse save clears previously saved fields after undo and preserves redo snapshots', async () => {
    const f = make(); followSavedPoint(f); await opened(f)
    const before = clone(f.session.state.payload)
    await f.session.edit(value => Object.assign(value.welds[0], labels)); await f.session.save()
    expect(f.session.state.draftSeq).toBe(2)
    await moveHistory(f, 'undo'); expect(f.session.state.payload).toEqual(before)
    await f.session.save()
    expect(f.session.state.pending).toBeNull(); expect(f.session.state.dirty).toBe(false)
    expect(f.session.state.payload.welds[0]).toEqual({ ...before.welds[0], group_name: '', classification: '', included: true })
    expect(vi.mocked(f.client.save).mock.calls[1][0].draft.payload).toEqual(before)
    await moveHistory(f, 'redo'); expect(f.session.state.payload.welds[0]).toEqual({ ...before.welds[0], ...labels })
    await f.session.save(); expect(f.session.state.draftSeq).toBe(4)
    await moveHistory(f, 'undo'); expect(f.session.state.payload).toEqual(before)
  })
  it('sparse save leaves never-saved fields absent after an unrelated edit or rejected write', async () => {
    const f = make(); followSavedPoint(f); await opened(f)
    await f.session.edit(value => { value.welds[0].location = 'unrelated' }); await f.session.save()
    expect(f.session.state.payload.welds[0]).not.toHaveProperty('included')
    await f.session.edit(value => Object.assign(value.welds[0], labels))
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('rejected', 422)); await f.session.save()
    expect(f.session.state.pending).toBeNull()
    await moveHistory(f, 'undo'); await f.session.save()
    const row = f.session.state.payload.welds[0]
    expect(row.location).toBe('unrelated')
    for (const key of Object.keys(labels)) expect(row).not.toHaveProperty(key)
  })
  it('sparse save restores an exact server baseline without promoting the local draft to a saved point', async () => {
    const f = make(); followSavedPoint(f); await opened(f)
    await f.session.edit(value => Object.assign(value.welds[0], labels)); await f.session.save()
    await moveHistory(f, 'undo'); const original = f.getStored()!
    notifyAuthPrincipalChange(); await f.session.initialize()
    await f.session.previewRecovery(original); await f.session.restoreRecovery()
    expect(f.session.state.savedPoint).toBeNull(); expect(f.session.state.payload).toEqual(original.draft.payload)
    await f.session.save()
    expect(f.session.state.dirty).toBe(false)
    expect(f.session.state.payload.welds[0]).toMatchObject({ group_name: '', classification: '', included: true })
  })
  it('sparse save preserves an UNKNOWN normalized body across cold recovery and exact replay', async () => {
    const f = make(); followSavedPoint(f); await opened(f)
    await f.session.edit(value => Object.assign(value.welds[0], labels)); await f.session.save()
    await moveHistory(f, 'undo')
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('lost', 0)); await f.session.save()
    const original = f.getStored()!
    expect((original.pending!.body.payload as PlanRecord['payload']).welds[0]).toMatchObject({ group_name: '', classification: '', included: true })
    expect(original.draft.payload.welds[0]).not.toHaveProperty('included')
    notifyAuthPrincipalChange(); await f.session.initialize(); await f.session.previewRecovery(original); await f.session.restoreRecovery()
    await f.session.confirmOriginal()
    expect(vi.mocked(f.client.save).mock.calls.slice(1).map(([record]) => record)).toEqual([original, original])
    expect(f.session.state.pending).toBeNull(); expect(f.getStored()).toBeNull()
  })
  it('sparse save drops presence after a saved deletion and does not transfer fields to other weld IDs', async () => {
    const f = make(); followSavedPoint(f); await opened(f)
    const sparse = clone(f.session.state.payload.welds[0])
    await f.session.edit(value => { Object.assign(value.welds[0], labels); value.welds.push({ ...sparse, weld_id: 'w2', display_no: '2' }) }); await f.session.save()
    expect(f.session.state.payload.welds[1]).not.toHaveProperty('included')
    await f.session.edit(value => { value.welds = value.welds.filter(row => row.weld_id !== 'w1') }); await f.session.save()
    await f.session.edit(value => { value.welds.push(sparse) }); await f.session.save()
    expect(f.session.state.payload.welds.find(row => row.weld_id === 'w1')).toEqual(sparse)
  })
  it('sparse save resets recovered presence when opening another fixed target with the same weld ID', async () => {
    const f = make(); followSavedPoint(f); await opened(f)
    await f.session.edit(value => Object.assign(value.welds[0], labels)); await f.session.save()
    await moveHistory(f, 'undo'); const original = f.getStored()!
    notifyAuthPrincipalChange(); await f.session.initialize(); await f.session.previewRecovery(original); await f.session.restoreRecovery()
    const other = { ...plan(), plan_id: 'other', item_version_id: 'other-v' }
    vi.mocked(f.client.read).mockResolvedValue(other)
    vi.mocked(f.client.recover).mockImplementation(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current: other, can_write: true, conflict: false }))
    await f.session.open('other', 'other-v')
    f.setStored(null) // This single-slot fake releases the previous target recovery slot.
    await f.session.edit(value => { value.welds[0].location = 'other edit' })
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('inspect only', 0)); await f.session.save()
    const request = vi.mocked(f.client.save).mock.calls.at(-1)![0]
    expect(request.draft.plan_id).toBe('other')
    expect((request.pending!.body.payload as PlanRecord['payload']).welds[0]).not.toHaveProperty('included')
  })
})
