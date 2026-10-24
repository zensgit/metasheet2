import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWeldingPlanSession } from '../src/views/welding/useWeldingPlanSession'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'
import { createWeldingPlanClient, WeldingPlanError, validateSaveAck, type WeldingPlanClient, type PlanRecord } from '../src/services/welding/planClient'
import { withGenerationOwnerLock } from '../src/services/welding/commandRecovery'
import { clone, equal, validateRecovery, type PlanRecoveryRecord, type PlanRecoveryStore } from '../src/services/welding/planRecovery'

const owner = { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }
const hash = 'a'.repeat(64), digest = 'd'.repeat(64)
const resolution = () => ({ weld_id: 'w1', expected_review_digest: digest, disposition: 'no_binding', note: '人工核对当前焊缝，保留无绑定说明' })
const payload = () => ({ schema_version: 1 as const, bom: null, process_refs: [], product: null, drawing: null, welds: [{ weld_id: 'w1', display_no: '1', location: '', joint_type: '', method: '', material_a: '', material_b: '', filler: '', thickness_a: null, thickness_b: null, manufacturing_length: null, measured_length: null, welding_requirements: '', inspection_requirements: '', passes: [] }], extension: { retained: true } })
const plan = (): PlanRecord => ({ plan_id: 'plan', item_version_id: 'v1', name: 'Plan', number: 'W1', state: 'Draft', version_label: 'A', draft_seq: 1, content_hash: hash, payload: payload(), sources: { source_review: { pending_count: 1 } } })
const review = () => ({ schema: 'yuantus.welding_source_review/1', plan_id: 'plan', item_version_id: 'v1', draft_seq: 1, content_hash: hash, can_write: true, summary: { pending_count: 1, removed_pending_count: 0 }, total: 1, limit: 50, offset: 0, items: [{ weld_id: 'w1', present: true, state: 'pending', change_id: 'change', reason_codes: ['drawing_changed'], expected_review_digest: digest, view: { present: true, weld: { display_no: '1' }, geometry: { bindings: [] } }, baseline_view: { present: true, weld: { display_no: '1' }, geometry: { bindings: [] } }, last_confirmation: null }] })
function original(): PlanRecoveryRecord {
  return { schema: 'yuantus.welding_plan_recovery/1', recovery_id: '00000000-0000-4000-8000-000000000001', updated_at: 1, owner, draft: { plan_id: 'plan', version_id: 'v1', base_draft_seq: 1, base_content_hash: hash, name: 'Plan', number: 'W1', payload: payload() }, pending: { method: 'PUT', path: '/plan/versions/v1/draft', body: { expected_draft_seq: 1, save_id: 'same-original', payload: payload(), review_resolution: resolution() }, local_ahead: false } }
}
function fixture() {
  let stored: PlanRecoveryRecord | null = null, counter = 0, writable = true
  const db: PlanRecoveryStore = {
    list: vi.fn(async value => stored && equal(stored.owner, value) ? [clone(stored)] : []),
    get: vi.fn(async (value, id) => stored && equal(stored.owner, value) && id === stored.recovery_id ? clone(stored) : null),
    claim: vi.fn(async value => { if (stored) return equal(stored, value); stored = clone(value); return true }),
    compareReplace: vi.fn(async (expected, next) => { if (!equal(expected, stored)) return false; stored = clone(next); return true }), close: vi.fn(),
  }
  const client = {
    recoveryOwner: vi.fn(async () => clone(owner)), read: vi.fn(async () => plan()), list: vi.fn(async () => ({ items: [plan()], total: 1, offset: 0, limit: 50 })),
    recover: vi.fn(async (_purpose, record: PlanRecoveryRecord) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner: clone(record.owner), record_id: record.recovery_id, current: plan(), can_write: true, conflict: false })),
    sourceReview: vi.fn(async () => review()),
    save: vi.fn(async (record: PlanRecoveryRecord) => { expect(stored).toEqual(record); return { ...plan(), draft_seq: 2, content_hash: 'b'.repeat(64), payload: clone(record.pending!.body.payload), sources: { source_review: { pending_count: 0 } } } }),
  } as unknown as WeldingPlanClient
  const session = useWeldingPlanSession({ client, openStore: async () => db, writable: () => writable, uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` })
  session.setWorkflowAdmission(async (scope, _mode, _target, action) => action(scope)); session.setGenerationAdmission(async (scope, _mode, _target, action) => action(scope))
  return { session, client, db, stored: () => clone(stored), replace: (value: PlanRecoveryRecord | null) => { stored = clone(value) }, writable: (value: boolean) => { writable = value } }
}
const sessions: Array<ReturnType<typeof fixture>['session']> = []
async function opened() { const f = fixture(); sessions.push(f.session); await f.session.initialize(); await f.session.open('plan', 'v1'); return f }
const confirm = (f: ReturnType<typeof fixture>, page = review(), value = resolution(), identity = owner) => (f.session as any).confirmSourceReview(page, value, identity)
beforeEach(() => localStorage.setItem('auth_token', 'native-A'))
afterEach(() => { sessions.splice(0).forEach(session => session.dispose()); vi.restoreAllMocks() })

describe('manual source-review confirmation original request', () => {
  it('persists before dispatch, preserves the saved payload and applies only the valid ACK', async () => {
    const f = await opened(), before = clone(f.session.state.payload)
    await confirm(f)
    expect(f.client.save).toHaveBeenCalledOnce()
    const sent = vi.mocked(f.client.save).mock.calls[0][0]
    expect(sent.pending!.body).toEqual({ expected_draft_seq: 1, save_id: expect.any(String), payload: before, review_resolution: resolution() })
    expect(f.session.state.savedPoint).toMatchObject({ draft_seq: 2, sources: { source_review: { pending_count: 0 } } }); expect(f.session.state.payload).toEqual(before)
    expect(f.stored()).toBeNull(); expect(f.session.state.pending).toBeNull()
  })
  it.each(['dirty', 'feature', 'storage', 'uncertain', 'cad', 'command', 'pending', 'released'])('does not begin confirmation when %s is blocked', async kind => {
    const f = await opened()
    if (kind === 'feature') f.writable(false)
    else if (kind === 'dirty') f.session.state.dirty = true
    else if (kind === 'storage') f.session.state.storageBlocked = true
    else if (kind === 'uncertain') f.session.state.uncertain = true
    else if (kind === 'cad') f.session.state.cadBusy = true
    else if (kind === 'command') f.session.state.commandPending = true
    else if (kind === 'pending') f.session.state.pending = original().pending
    else f.session.state.serverState = 'Released'
    await expect(confirm(f)).rejects.toThrow(); expect(f.client.save).not.toHaveBeenCalled(); expect(f.client.sourceReview).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled()
  })
  it.each(['digest', 'seq', 'hash', 'write', 'state', 'view', 'owner'])('rejects late %s changes before minting a request', async kind => {
    const f = await opened(), next = review()
    if (kind === 'digest') next.items[0].expected_review_digest = 'e'.repeat(64)
    else if (kind === 'seq') next.draft_seq++
    else if (kind === 'hash') next.content_hash = 'c'.repeat(64)
    else if (kind === 'write') next.can_write = false
    else if (kind === 'state') next.items[0].state = 'confirmed'
    else if (kind === 'view') next.items[0].view.weld.display_no = 'late'
    else vi.mocked(f.client.recoveryOwner).mockResolvedValue({ ...owner, rbac_user_id: 99 })
    vi.mocked(f.client.sourceReview).mockResolvedValue(next)
    await confirm(f); expect(f.client.save).not.toHaveBeenCalled(); expect(f.db.claim).not.toHaveBeenCalled(); expect(f.stored()).toBeNull()
  })
  it('retains the exact original on a first 409 and retries the same ID/body after a lost ACK', async () => {
    const f = await opened()
    vi.mocked(f.client.save).mockRejectedValueOnce(new WeldingPlanError('digest changed', 409)).mockRejectedValueOnce(new Error('lost ACK'))
    await confirm(f); const first = f.stored()!; expect(first.pending).not.toBeNull(); expect(f.session.state.pending).toEqual(first.pending)
    await f.session.confirmOriginal(); expect(f.stored()).toEqual(first)
    vi.mocked(f.client.recover).mockImplementation(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current: { ...plan(), draft_seq: 2 }, can_write: false, conflict: true }))
    await f.session.confirmOriginal()
    expect(vi.mocked(f.client.save).mock.calls.map(call => call[0])).toEqual([first, first, first]); expect(f.stored()).toBeNull()
  })
  it.each(['403', 'late-owner', 'ABA', 'ACK', 'other-tab'])('keeps durable pending on %s and does not accept a late result', async kind => {
    const f = await opened(); let sent!: PlanRecoveryRecord
    vi.mocked(f.client.save).mockImplementation(async record => {
      sent = clone(record); expect(f.stored()).toEqual(record)
      if (kind === '403') throw new WeldingPlanError('revoked', 403)
      if (kind === 'late-owner') vi.mocked(f.client.recoveryOwner).mockResolvedValue({ ...owner, auth_user_id: 88 })
      if (kind === 'ABA') { localStorage.setItem('auth_token', 'native-B'); notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'native-A'); notifyAuthPrincipalChange() }
      if (kind === 'other-tab') f.replace({ ...record, updated_at: record.updated_at + 1 })
      return { ...plan(), draft_seq: 2, content_hash: 'b'.repeat(64), payload: kind === 'ACK' ? { ...payload(), extension: { retained: false } } : payload() }
    })
    await confirm(f); expect(f.stored()?.pending).toEqual(sent.pending); expect(f.session.state.draftSeq).not.toBe(2)
    if (['403', 'late-owner', 'ABA'].includes(kind)) expect(f.session.state.owner).toBeNull()
  })
  it('does not dispatch when the original checkpoint fails', async () => {
    const f = await opened(); vi.mocked(f.db.claim).mockRejectedValue(new Error('quota'))
    await confirm(f); expect(f.client.save).not.toHaveBeenCalled(); expect(f.session.state.storageBlocked).toBe(true); expect(f.session.state.pending).not.toBeNull()
  })
  it('uses the same reentrant admission lease for preparation and original-request dispatch', async () => {
    const request = vi.fn(async (_name, _options, action) => action())
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } })
    try {
      const f = await opened()
      f.session.setWorkflowAdmission((scope, _mode, _target, action) => withGenerationOwnerLock(owner, scope, action))
      f.session.setGenerationAdmission((scope, _mode, _target, action) => withGenerationOwnerLock(owner, scope, action))
      await confirm(f); expect(request).toHaveBeenCalledOnce(); expect(f.client.save).toHaveBeenCalledOnce(); expect(f.stored()).toBeNull()
    } finally { delete (navigator as any).locks }
  })
})

describe('review-resolution wire and recovery validation', () => {
  it.each(['blank', 'python-space', 'oversize', 'surrogate', 'digest', 'disposition', 'combined', 'measure'])('rejects %s before persistence', kind => {
    const record = original(), body = record.pending!.body, value = body.review_resolution as ReturnType<typeof resolution>
    if (kind === 'blank') value.note = '  \n'
    else if (kind === 'python-space') value.note = '\u0085\u001c'
    else if (kind === 'oversize') value.note = '字'.repeat(4001)
    else if (kind === 'surrogate') value.note = '\ud800'
    else if (kind === 'digest') value.expected_review_digest = 'late'
    else if (kind === 'disposition') value.disposition = 'automatic'
    else if (kind === 'combined') body.source_change = { expected_content_hash: hash, preparation_digest: digest }
    else body.measure_geometry = true
    expect(() => validateRecovery(record)).toThrow()
  })
  it('retains a legitimate Unicode note verbatim and accepts an unchanged legacy ACK without save_id', () => {
    const record = original(); (record.pending!.body.review_resolution as any).note = `  ${'😀'.repeat(3996)}  `
    expect(validateRecovery(record)).toEqual(record)
    expect(validateSaveAck({ ...plan(), draft_seq: 2 }, record).draft_seq).toBe(2)
    expect(() => validateSaveAck({ ...plan(), draft_seq: 2, payload: { ...payload(), extension: { retained: false } } }, record)).toThrow()
  })
  it('uses the existing source-review GET and generic Draft PUT with the unchanged original body', async () => {
    const record = original(), transport = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(review()))).mockResolvedValueOnce(new Response(JSON.stringify({ ...plan(), draft_seq: 2 })))
    const client = createWeldingPlanClient(transport)
    expect(await client.sourceReview('plan', 'v1')).toEqual(review()); await client.save(record)
    expect(transport.mock.calls.map(([url, options]) => [url, options.method, options.body])).toEqual([
      ['/api/welding/plans/plan/versions/v1/source-review?limit=50&offset=0', 'GET', undefined],
      ['/api/welding/plans/plan/versions/v1/draft', 'PUT', JSON.stringify(record.pending!.body)],
    ])
  })
  it.each(['missing-authority', 'invalid-digest', 'duplicate-weld', 'wrong-target'])('rejects malformed source-review %s from the transport', async kind => {
    const page = review()
    if (kind === 'missing-authority') delete (page as any).can_write
    else if (kind === 'invalid-digest') page.items[0].expected_review_digest = 'unknown'
    else if (kind === 'duplicate-weld') page.items.push(clone(page.items[0]))
    else page.item_version_id = 'other'
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify(page)))
    await expect(createWeldingPlanClient(transport).sourceReview('plan', 'v1')).rejects.toThrow(); expect(transport).toHaveBeenCalledOnce()
  })
  it.each([['no_binding'], 7, { disposition: 'no_binding' }])('rejects non-string disposition %s from a durable JSON recovery record', disposition => {
    const record = JSON.parse(JSON.stringify(original())); record.pending.body.review_resolution.disposition = disposition
    expect(() => validateRecovery(record)).toThrow()
  })
  it.each([['pending'], 7, { state: 'pending' }])('rejects non-string review state %s from an actual JSON HTTP response', async state => {
    const page = review(); (page.items[0] as any).state = state
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify(page)))
    await expect(createWeldingPlanClient(transport).sourceReview('plan', 'v1')).rejects.toThrow(); expect(transport).toHaveBeenCalledOnce()
  })

})
