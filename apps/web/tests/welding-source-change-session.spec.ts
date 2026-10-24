import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWeldingPlanSession } from '../src/views/welding/useWeldingPlanSession'
import { WeldingPlanError, type WeldingPlanClient } from '../src/services/welding/planClient'
import { clone, equal, type PlanRecoveryRecord, type PlanRecoveryStore } from '../src/services/welding/planRecovery'
import { sourcePreparationFixture } from './fixtures/welding-source-preparation'

const sessions: Array<ReturnType<typeof useWeldingPlanSession>> = []
function fixture(initial: PlanRecoveryRecord | null = null) {
  const f = sourcePreparationFixture(); let stored = clone(initial), counter = 0
  const db: PlanRecoveryStore = {
    list: vi.fn(async () => stored ? [clone(stored)] : []), get: vi.fn(async (_owner, id) => stored?.recovery_id === id ? clone(stored) : null),
    claim: vi.fn(async value => { if (stored) return equal(stored, value); stored = clone(value); return true }),
    compareReplace: vi.fn(async (expected, next) => { if (!equal(expected, stored)) return false; stored = clone(next); return true }), close: vi.fn(),
  }
  const client = { recoveryOwner: vi.fn(async () => clone(f.owner)), authority: vi.fn(async () => clone(f.owner)),
    list: vi.fn(async () => ({ items: [clone(f.point)], total: 1, limit: 50, offset: 0 })), read: vi.fn(async () => clone(f.point)),
    recover: vi.fn(async (_mode, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner: clone(f.owner), record_id: record.recovery_id, current: clone(f.point), can_write: true, conflict: false })),
    prepareSourceChange: vi.fn(async () => clone(f.prepared)), readSourcePreparation: vi.fn(async () => clone(f.prepared)),
    save: vi.fn(async record => ({ ...clone(f.point), draft_seq: 2, content_hash: 'f'.repeat(64), payload: clone(record.pending.body.payload), sources: clone(f.prepared.source_change.after.sources) })),
  } as unknown as WeldingPlanClient
  const s = useWeldingPlanSession({ client, openStore: async () => db, writable: () => true, uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` })
  s.setWorkflowAdmission(async (scope, _mode, _target, action) => { s.state.commandPending = true; await Promise.resolve(); s.state.commandPending = false; return action(scope) })
  s.setGenerationAdmission(async (scope, _mode, _target, action) => action(scope)); sessions.push(s)
  return { ...f, s, client, db, stored: () => clone(stored) }
}
async function opened() { const f = fixture(); await f.s.initialize(); await f.s.open('plan', 'v'); return f }
async function prepared(f: Awaited<ReturnType<typeof opened>>) { return f.s.prepareDrawing(f.next, f.s.capture()) }
beforeEach(() => localStorage.setItem('auth_token', 'native-A'))
afterEach(() => { sessions.splice(0).forEach(s => s.dispose()); vi.restoreAllMocks() })

describe('source change session durability and lifecycle', () => {
  it('prepares without modifying the draft, then persists before PUT and clears the old editor context after ACK', async () => {
    const f = await opened(), original = clone(f.s.state.payload); f.s.state.overlayContextId = 'old-editor'
    const preview = await prepared(f)
    expect(f.s.state.payload).toEqual(original); expect(f.s.state.pending).toBeNull(); expect(f.client.save).not.toHaveBeenCalled()
    vi.mocked(f.client.save).mockImplementationOnce(async record => {
      expect(f.stored()).toEqual(record); expect(record.draft.payload).toEqual(original); expect(record.pending!.local_ahead).toBe(false)
      expect(f.s.state.payload).toEqual(original)
      return { ...clone(f.point), draft_seq: 2, content_hash: 'f'.repeat(64), payload: clone(record.pending!.body.payload), sources: clone(f.prepared.source_change.after.sources) } as any
    })
    await f.s.confirmDrawing(preview, f.s.capture())
    expect(f.client.readSourcePreparation).toHaveBeenCalledOnce(); expect(f.client.save).toHaveBeenCalledOnce()
    expect(f.s.state.payload.drawing).toEqual(f.next); expect(f.s.state.pending).toBeNull(); expect(f.stored()).toBeNull()
    expect(f.s.state.overlayContextId).toBe(''); expect(f.s.historyCandidate('undo').payload).toEqual(original)
  })
  it('retains the original pending command on an unknown PUT and retries it without re-reading an expired preparation', async () => {
    const f = await opened(), preview = await prepared(f)
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('unknown', 502, 'WELDING_RESULT_UNKNOWN'))
    await f.s.confirmDrawing(preview, f.s.capture())
    const original = f.stored(); expect(original?.pending?.local_ahead).toBe(false); expect(f.s.state.payload).toEqual(f.point.payload)
    vi.mocked(f.client.readSourcePreparation).mockRejectedValue(new WeldingPlanError('expired', 409))
    await f.s.confirmOriginal()
    expect(f.client.readSourcePreparation).toHaveBeenCalledOnce()
    expect(vi.mocked(f.client.save).mock.calls[1][0]).toEqual(original); expect(f.s.state.payload.drawing).toEqual(f.next)
  })
  it('does not dispatch a PUT when durable storage fails', async () => {
    const f = await opened(), preview = await prepared(f)
    vi.mocked(f.db.claim).mockRejectedValueOnce(new Error('disk full'))
    await f.s.confirmDrawing(preview, f.s.capture())
    expect(f.client.save).not.toHaveBeenCalled(); expect(f.s.state.storageBlocked).toBe(true)
    expect(f.s.state.payload).toEqual(f.point.payload); expect(f.s.state.pending?.body.source_change).toBeTruthy()
  })
  it('replays the durable original after a cold restart without reopening expired preparation', async () => {
    const first = await opened(), preview = await prepared(first)
    vi.mocked(first.client.save).mockRejectedValueOnce(new WeldingPlanError('unknown', 502, 'WELDING_RESULT_UNKNOWN'))
    await first.s.confirmDrawing(preview, first.s.capture()); const original = first.stored()!
    first.s.dispose()
    const cold = fixture(original)
    vi.mocked(cold.client.readSourcePreparation).mockRejectedValue(new WeldingPlanError('expired', 409))
    await cold.s.initialize(); await cold.s.previewRecovery(original); await cold.s.restoreRecovery(); await cold.s.confirmOriginal()
    expect(cold.client.readSourcePreparation).not.toHaveBeenCalled(); expect(cold.client.prepareSourceChange).not.toHaveBeenCalled()
    expect(vi.mocked(cold.client.save).mock.calls[0][0]).toEqual(original)
    expect(cold.stored()).toBeNull(); expect(cold.s.state.payload.drawing).toEqual(cold.next)
    expect(cold.s.historyCandidate('undo').payload).toEqual(original.draft.payload)
  })
  it('preserves the complete source-change history after cold replay of an already represented plan', async () => {
    const first = fixture()
    for (const payload of [first.point.payload, first.prepared.source_change.before.payload, first.prepared.source_change.after.payload]) payload.overlay = { schema: 'vemcad-weld-overlay/3', bindings: [] }
    await first.s.initialize(); await first.s.open('plan', 'v')
    const preview = await prepared(first)
    vi.mocked(first.client.save).mockRejectedValueOnce(new WeldingPlanError('unknown', 502, 'WELDING_RESULT_UNKNOWN'))
    await first.s.confirmDrawing(preview, first.s.capture()); const original = first.stored()!
    expect(original.pending!.body.source_change).toBeTruthy(); first.s.dispose()
    const cold = fixture(original)
    cold.point.payload = clone(first.point.payload)
    vi.mocked(cold.client.save).mockImplementation(async record => ({ ...clone(cold.point), draft_seq: 2, content_hash: 'f'.repeat(64), save_id: record.pending!.body.save_id, payload: clone(record.pending!.body.payload) as typeof cold.point.payload, sources: clone(cold.prepared.source_change.after.sources) }))
    await cold.s.initialize(); await cold.s.previewRecovery(original); await cold.s.restoreRecovery(); await cold.s.confirmOriginal()
    expect(cold.s.state.pending, cold.s.state.message).toBeNull(); expect(cold.stored()).toBeNull()
    expect(cold.s.state.message).not.toContain('已建立多表示保存边界')
    const undo = cold.s.historyCandidate('undo'); expect(undo.payload).toEqual(original.draft.payload)
    await cold.s.commitPayload(undo.payload, cold.s.capture(), undo.cursor)
    const redo = cold.s.historyCandidate('redo'); expect(redo.payload).toEqual(original.pending!.body.payload)
    await cold.s.commitPayload(redo.payload, cold.s.capture(), redo.cursor)
    expect(cold.s.state.payload.drawing).toEqual(cold.next)
    expect(vi.mocked(cold.client.save).mock.calls[0][0]).toEqual(original)
  })
  it.each(['wrong ACK', 'CAS collision'])('preserves the original when confirmation encounters %s', async kind => {
    const f = await opened(), preview = await prepared(f)
    if (kind === 'wrong ACK') vi.mocked(f.client.save).mockResolvedValueOnce({ ...clone(f.point), draft_seq: 99 } as any)
    else vi.mocked(f.db.compareReplace).mockResolvedValueOnce(false)
    await f.s.confirmDrawing(preview, f.s.capture())
    expect(f.client.save).toHaveBeenCalledOnce(); expect(f.stored()?.pending).toBeTruthy()
    expect(f.s.state.payload).toEqual(f.point.payload); expect(f.s.state.pending).toBeTruthy(); expect(f.s.state.historyLength).toBe(0)
  })
  it('retains durable pending but sends no PUT when owner changes after checkpoint', async () => {
    const f = await opened(), preview = await prepared(f), claim = vi.mocked(f.db.claim).getMockImplementation()!
    vi.mocked(f.db.claim).mockImplementationOnce(async (...args) => {
      // Save the actual original before simulating an independently changed login mapping.
      const saved = await claim(...args)
      vi.mocked(f.client.recoveryOwner).mockResolvedValue({ ...f.owner, rbac_user_id: 999 })
      return saved
    })
    await f.s.confirmDrawing(preview, f.s.capture())
    expect(f.stored()?.pending).toBeTruthy(); expect(f.client.save).not.toHaveBeenCalled(); expect(f.s.state.owner).toBeNull()
  })
  it.each(['edit', 'point', 'owner', 'cancel'])('rejects a late preparation GET after %s changes', async kind => {
    const f = await opened(), preview = await prepared(f); let finish!: (value: any) => void, live = true
    vi.mocked(f.client.readSourcePreparation).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const scope = f.s.capture(), pending = f.s.confirmDrawing(preview, { accepts: () => live && scope.accepts() })
    for (let i = 0; i < 80 && !finish; i++) await Promise.resolve()
    expect(finish).toBeTypeOf('function')
    if (kind === 'edit') f.s.state.editSeq++
    if (kind === 'point') f.s.state.contentHash = '0'.repeat(64)
    if (kind === 'owner') f.s.state.owner!.rbac_user_id++
    if (kind === 'cancel') live = false
    finish(clone(f.prepared)); await pending
    expect(f.client.save).not.toHaveBeenCalled(); expect(f.stored()).toBeNull(); expect(f.s.state.pending).toBeNull()
  })
  it.each(['expired', 'changed'])('refuses a %s fresh preparation before making pending', async kind => {
    const f = await opened(), preview = await prepared(f)
    if (kind === 'expired') vi.mocked(f.client.readSourcePreparation).mockRejectedValueOnce(new WeldingPlanError('expired', 409))
    else vi.mocked(f.client.readSourcePreparation).mockResolvedValueOnce({ ...clone(f.prepared), context_id: 'other' } as any)
    await f.s.confirmDrawing(preview, f.s.capture())
    expect(f.client.save).not.toHaveBeenCalled(); expect(f.s.state.pending).toBeNull(); expect(f.s.state.payload).toEqual(f.point.payload)
  })
  it.each([404, 410])('keeps the durable local draft while hiding the session on preparation GET %s', async status => {
    const f = await opened(); await f.s.edit(p => { p.drawing = clone(f.next) })
    const local = f.stored(), preview = await prepared(f)
    vi.mocked(f.client.readSourcePreparation).mockRejectedValueOnce(new WeldingPlanError('unavailable', status))
    await f.s.confirmDrawing(preview, f.s.capture())
    expect(f.s.state.owner).toBeNull(); expect(f.s.state.savedPoint).toBeNull()
    expect(f.stored()).toEqual(local); expect(f.client.save).not.toHaveBeenCalled()
  })
  it.each([false, true])('checks history capacity only when confirmation adds a new undo step: matching=%s', async matching => {
    const f = fixture(), notes = 'x'.repeat(1800 * 1024)
    for (const payload of [f.point.payload, f.prepared.source_change.before.payload, f.prepared.source_change.after.payload]) Object.assign(payload, { preparation_notes: notes })
    await f.s.initialize(); await f.s.open('plan', 'v')
    for (let i = 0; i < 5; i++) await f.s.edit(p => { p.drawing = i === 4 && matching ? clone(f.next) : { ...f.next, file_id: `local-${i}` } })
    expect(f.s.state.historyLength).toBe(5); const preview = await prepared(f)
    await f.s.confirmDrawing(preview, f.s.capture())
    expect(f.s.state.historyLength).toBe(5)
    if (matching) { expect(f.client.save).toHaveBeenCalledOnce(); expect(f.s.state.pending).toBeNull(); expect(f.s.state.payload.drawing).toEqual(f.next) }
    else { expect(f.client.save).not.toHaveBeenCalled(); expect(f.s.state.pending).toBeNull(); expect(f.s.state.message).toContain('20 MiB') }
  })
  it.each(['edit', 'point', 'owner', 'cancel'])('rejects %s changes while prepare is awaiting', async kind => {
    const f = await opened(); let finish!: (value: any) => void; let live = true
    vi.mocked(f.client.prepareSourceChange).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const scope = f.s.capture(), pending = f.s.prepareDrawing(f.next, { accepts: () => live && scope.accepts() }); const caught = pending.catch(e => e)
    for (let i = 0; i < 80 && !finish; i++) await Promise.resolve()
    expect(finish).toBeTypeOf('function')
    if (kind === 'edit') f.s.state.editSeq++
    if (kind === 'point') f.s.state.contentHash = '0'.repeat(64)
    if (kind === 'owner') f.s.state.owner!.rbac_user_id++
    if (kind === 'cancel') live = false
    finish(clone(f.prepared)); expect(await caught).toBeInstanceOf(Error); expect(f.client.save).not.toHaveBeenCalled()
  })
  it('allows drawing-only undo but rejects mixed edits until explicitly adopting the saved drawing', async () => {
    const f = await opened(); await f.s.edit(p => { p.drawing = { ...f.next, file_id: 'undo' } })
    expect(f.s.canChangeDrawing.value).toBe(true)
    await prepared(f); expect(f.client.prepareSourceChange).toHaveBeenCalledWith(f.point, f.next, f.owner, expect.any(String), expect.any(Object))
    await f.s.edit(p => { p.preparation_notes = 'keep this' })
    expect(f.s.canChangeDrawing.value).toBe(false)
    await f.s.adoptSavedDrawing()
    expect(f.s.state.payload.drawing).toEqual(f.point.payload.drawing); expect(f.s.state.payload.preparation_notes).toBe('keep this')
    expect(f.s.state.dirty).toBe(true)
  })
  it('drains CAD before entering the owner admission lock', async () => {
    const f = await opened(); let locked = false
    f.s.setWorkflowAdmission(async (scope, _mode, _target, action) => { expect(locked).toBe(false); locked = true; try { return await action(scope) } finally { locked = false } })
    f.s.setCadBarrier(async () => { expect(locked).toBe(false); await Promise.resolve() })
    await prepared(f); expect(f.client.prepareSourceChange).toHaveBeenCalledOnce()
  })
  it('lets a delayed native commit acquire the same serialized owner lock, then rejects the obsolete preparation basis', async () => {
    const f = await opened(); let tail: Promise<unknown> = Promise.resolve(), release!: () => void
    f.s.setWorkflowAdmission((scope, _mode, _target, action) => {
      const next = tail.catch(() => {}).then(() => action(scope)); tail = next; return next
    })
    const ready = new Promise<void>(resolve => { release = resolve })
    const changed = { ...clone(f.point.payload), preparation_notes: 'queued native edit' }
    const nativeCommit = ready.then(() => f.s.commitPayload(changed, f.s.capture()))
    f.s.setCadBarrier(async () => { release(); await nativeCommit })
    await expect(prepared(f)).rejects.toThrow()
    expect(f.client.prepareSourceChange).not.toHaveBeenCalled(); expect(f.s.state.payload).toEqual(changed)
    expect(f.stored()?.draft.payload).toEqual(changed); expect(f.client.save).not.toHaveBeenCalled()
  })
})
