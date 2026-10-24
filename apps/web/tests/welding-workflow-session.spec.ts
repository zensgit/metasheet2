import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { useWeldingPlanSession } from '../src/views/welding/useWeldingPlanSession'
import { useWeldingWorkflowSession } from '../src/views/welding/useWeldingWorkflowSession'
import { clone, equal, type PlanRecoveryStore } from '../src/services/welding/planRecovery'
import { validateWorkflowAck, type WeldingPlanClient, type WorkflowState, type WorkflowOriginal, type ReviewGeneration, type FinalGeneration, type FinalGenerationBasis, type FinalGenerationAck, type Publication, WeldingPlanError } from '../src/services/welding/planClient'
import type { CommandRecoveryStore, WorkflowPending, GenerationPending } from '../src/services/welding/commandRecovery'
import { notifyAuthPrincipalChange } from '../src/composables/authPrincipal'

const hash = 'a'.repeat(64), owner = { tenant_id: 'tenant', org_id: 'org', auth_user_id: 8, rbac_user_id: 20 }
const requester = { auth_user_id: 7, rbac_user_id: 19, display_name: '作者' }, reviewer = { auth_user_id: 8, rbac_user_id: 20, display_name: '评审人' }
const id = '00000000-0000-4000-8000-000000000009'
const payload = { schema_version: 1 as const, product: { item_id: 'part', version_id: 'p1' }, drawing: { item_id: 'drawing', version_id: 'd1', file_id: 'f1', file_role: 'drawing', expected_checksum: hash }, welds: [] }
const fixed = { generation_id: id, render_key: hash, plan_id: 'plan', item_version_id: 'v1', draft_seq: 1, plan_content_hash: hash, generation_content_hash: hash, purpose: 'review' as const, template: { id: 'welding-a4' as const, version: '1' as const, digest: hash } }
const ready = (): ReviewGeneration => ({ schema: 'yuantus.welding_plan_generation/1', ...fixed, status: 'Ready', attempt: 1, created_at: '2026-10-09T00:00:00Z', review: { pending_count: 0, unbound_count: 0 }, files: { pdf: { format: 'pdf', mime_type: 'application/pdf', byte_size: 1, artifact_sha256: hash }, docx: { format: 'docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byte_size: 1, artifact_sha256: hash } }, error: null })
const approval = () => ({ approval_request_id: 'approval', state: 'pending' as const, submission_hash: hash, submission: { schema: 'yuantus.welding_submission/1', tenant_id: 'tenant', org_id: 'org', plan_id: 'plan', item_version_id: 'v1', version_label: 'A', draft_seq: 1, plan_content_hash: hash, requester, reviewer, review_generation_id: id, render_key: hash, input_sha256: hash, render_profile: {}, attempt: 1, attempt_token: 'attempt', assets: [], renderer_receipt: {}, sources: {}, review: {}, included_weld_ids: [], excluded_weld_ids: [] }, decision: null })
function fixture(initial = 'InReview') {
  let pending: WorkflowPending | null = null, generation: GenerationPending | null = null
  const flags = reactive({ writable: true, active: true }), current = reactive<WorkflowState>({ schema: 'yuantus.welding_review_state/1', plan_id: 'plan', item_version_id: 'v1', state: initial, draft_seq: 1, content_hash: hash, is_current: true, approval: initial === 'InReview' ? approval() : null, final_generation: null, publication: null, final_profile: null, allowed_actions: initial === 'Draft' ? ['submit'] : ['approve', 'reject', 'withdraw'], issues: [] })
  const plan = () => ({ plan_id: 'plan', item_version_id: 'v1', name: 'Plan', number: 'W1', version_label: 'A', state: current.state, draft_seq: current.draft_seq, content_hash: hash, payload: clone(payload), sources: {} })
  const db: CommandRecoveryStore = {
    get: vi.fn(async () => clone(generation)), claim: vi.fn(async () => false), clear: vi.fn(async () => false), close: vi.fn(),
    getWorkflow: vi.fn(async () => clone(pending)), claimWorkflow: vi.fn(async value => { if (pending) return equal(pending, value); pending = clone(value); return true }),
    clearWorkflow: vi.fn(async value => { if (!equal(value, pending)) return false; pending = null; return true }),
  }
  const ack = (original: Exclude<WorkflowOriginal, { action: 'final-render' | 'final-retry' | 'release' | 'revise' }>) => {
    const action = original.action === 'review' ? original.body.decision : original.action
    const state = action === 'submit' ? 'InReview' : action === 'approve' ? 'Approved' : 'Draft'
    const value = validateWorkflowAck({ schema: 'yuantus.welding_plan_workflow_ack/1', request_id: original.body.request_id, action, plan_id: 'plan', item_version_id: 'v1', draft_seq: original.body.expected_draft_seq + (action === 'reopen' ? 1 : 0), content_hash: hash, state, approval_request_id: 'approval', publication_id: null }, original)
    current.state = state; current.draft_seq = value.draft_seq; current.allowed_actions = []
    return value
  }
  const client = {
    authority: vi.fn(async () => clone(owner)), recoveryOwner: vi.fn(async () => clone(owner)), read: vi.fn(async () => plan()),
    recover: vi.fn(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner: clone(owner), record_id: record.recovery_id, current: plan(), can_write: current.state === 'Draft', conflict: false })),
    readReviewState: vi.fn(async () => clone(current)), readReviewHistory: vi.fn(async (_plan, _version, _owner, offset) => ({ schema: 'yuantus.welding_review_history/1', plan_id: 'plan', item_version_id: 'v1', total: offset, limit: 50, offset, items: [] })),
    validateWorkflowPlan: vi.fn(async () => ({ ready: false, issues: ['source-review-or-binding-incomplete'] })),
    readReviewGeneration: vi.fn(async () => ready()),
    submitWorkflowPlan: vi.fn(async (_plan, _version, body) => ack({ plan_id: 'plan', item_version_id: 'v1', action: 'submit', body })),
    reviewWorkflowPlan: vi.fn(async (_plan, _version, body) => ack({ plan_id: 'plan', item_version_id: 'v1', action: 'review', body })),
    withdrawWorkflowPlan: vi.fn(async (_plan, _version, body) => ack({ plan_id: 'plan', item_version_id: 'v1', action: 'withdraw', body })),
    reopenWorkflowPlan: vi.fn(async (_plan, _version, body) => ack({ plan_id: 'plan', item_version_id: 'v1', action: 'reopen', body })),
    resolveWorkflowReceipt: vi.fn(async () => null),
  } as unknown as WeldingPlanClient
  const planDB = { close() {}, claim: async () => true, compareReplace: async () => true } as unknown as PlanRecoveryStore
  const session = useWeldingPlanSession({ client, writable: () => flags.writable, openStore: async () => planDB })
  session.setGenerationAdmission(async (scope, _mode, _target, action) => action(scope))
  const workflow = useWeldingWorkflowSession({ session, writable: () => flags.writable, active: () => flags.active, openStore: async () => db, uuid: () => '00000000-0000-4000-8000-000000000001' })
  return { session, workflow, client, db, flags, current, planDB, getPending: () => clone(pending), setPending: (value: WorkflowPending | null) => { pending = clone(value) }, setGeneration: (value: GenerationPending | null) => { generation = value } }
}
const fixtures: ReturnType<typeof fixture>[] = []
async function make(initial = 'InReview', attached = false) { const f = fixture(initial); fixtures.push(f); if (attached) await f.session.open('plan', 'v1'); await vi.waitFor(() => expect(f.workflow.state.working).toBe(false)); await f.workflow.setTarget('plan', 'v1'); return f }
beforeEach(() => { localStorage.setItem('auth_token', 'native-A'); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, action: () => Promise<unknown>) => action() } }) })
afterEach(() => { fixtures.splice(0).forEach(f => { f.workflow.dispose(); f.session.dispose() }); vi.restoreAllMocks(); delete (navigator as any).locks })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
describe('F18b independent reuse interaction', () => {
  async function reuseFixture() {
    const f = await make('Released', true), approved = approval()
    Object.assign(approved, { state: 'approved', decision: { decision_hash: finalBasis.decision_hash, decision: { decision: 'approve', opinion: '', reviewer, decided_at: '2026-10-09T00:00:00Z' } } })
    approved.submission.included_weld_ids = ['w1'] as never[]
    Object.assign(f.current, { allowed_actions: [], publication: formal(), approval: approved })
    const bodyAck = (body: any) => ({ schema: 'yuantus.welding_plan_reuse_ack/1', action: 'reuse', request_id: body.request_id, reuse_id: 'reuse', source_plan_id: 'plan', source_version_id: 'v1', source_publication_id: 'publication', source_draft_seq: 1, source_content_hash: hash, target_plan_id: body.target_plan_id, target_version_id: 'target-v1', target_version_label: 'A', target_draft_seq: 1, target_content_hash: 'b'.repeat(64), state: 'Draft', reuse_provenance_sha256: 'c'.repeat(64) })
    f.client.reusePlan = vi.fn(async (_p, _v, body) => { expect(f.getPending()?.body).toEqual(body); return bodyAck(body) }) as any
    f.client.resolveReuseReceipt = vi.fn(async original => bodyAck(original.body)) as any
    f.client.reuseProductCandidates = vi.fn(async () => [{ item_id: 'other', version_id: 'p2', name: 'Other', number: 'P2', version_label: 'A' }])
    f.client.reuseProductContext = vi.fn(async pair => ({ ...pair, name: 'Other', number: 'P2', version_label: 'A' }))
    f.client.reuseBomCandidates = vi.fn(async () => [])
    f.client.drawingCandidates = vi.fn(async () => [{ item_id: 'drawing', version_id: 'd2', file_id: 'f2', file_role: 'drawing', checksum: hash, name: 'Drawing', number: 'D2', version_label: 'A' }])
    await f.workflow.refresh()
    return { ...f, bodyAck }
  }
  async function choose(f: Awaited<ReturnType<typeof reuseFixture>>) {
    await f.workflow.searchReuseProducts('other'); await f.workflow.selectReuseProduct(f.workflow.reuse.products[0])
    await f.workflow.searchReuseDrawings('drawing'); f.workflow.selectReuseDrawing(f.workflow.reuse.drawings[0])
    Object.assign(f.workflow.reuse, { name: 'Independent', number: 'R1', reason: '明确复用', selectedWeldIds: ['w1'] })
  }
  describe('F18b active formal reuse with a successor Draft', () => {
    it('creates from the still Released source without editing or revising the historical version', async () => {
      const f = await reuseFixture(), source = clone(f.session.state.payload)
      Object.assign(f.current, { is_current: false, allowed_actions: ['revise'] })
      await f.workflow.refresh()
      expect(f.session.canEdit.value).toBe(false)
      expect(f.workflow.canAction('revise')).toBe(false)
      expect(f.workflow.reuseWeldIds.value).toEqual(['w1'])
      await choose(f)
      expect(f.workflow.canCreateReuse.value).toBe(true)
      await f.workflow.createReuse()
      expect(f.client.reusePlan).toHaveBeenCalledTimes(1)
      expect(f.getPending()).toMatchObject({ action: 'reuse', plan_id: 'plan', item_version_id: 'v1', body: { source_publication_id: 'publication', selected_weld_ids: ['w1'] } })
      expect(f.db.clearWorkflow).not.toHaveBeenCalled()
      expect(f.session.state.payload).toEqual(source)
      expect(f.session.canEdit.value).toBe(false)
    })
    it.each(['Superseded', 'unmatched-publication'])('rejects a noncurrent %s source without claiming or dispatching a request', async kind => {
      const f = await reuseFixture()
      f.current.is_current = false
      if (kind === 'Superseded') { f.current.state = 'Superseded'; f.current.publication!.state = 'Superseded' }
      else f.current.publication!.content_hash = 'f'.repeat(64)
      await f.workflow.refresh(); await choose(f)
      expect(f.workflow.reuseWeldIds.value).toEqual([])
      expect(f.workflow.canCreateReuse.value).toBe(false)
      await f.workflow.createReuse()
      expect(f.db.claimWorkflow).not.toHaveBeenCalled()
      expect(f.client.reusePlan).not.toHaveBeenCalled()
    })
  })
  async function adoptionFixture() {
    const f = await reuseFixture(); await choose(f); await f.workflow.createReuse()
    const original = f.getPending()!; expect(original.action).toBe('reuse')
    if (original.action !== 'reuse') throw new Error('reuse original required')
    const initialPayload = { schema_version: 1 as const, product: clone(original.body.product), drawing: clone(original.body.drawing), bom: null, welds: [], process_refs: [], reuse_format: 'yuantus.welding_reuse/1' }
    const target = { plan_id: original.body.target_plan_id, item_version_id: 'target-v1', name: 'Independent', number: 'R1', version_label: 'A', state: 'Draft', draft_seq: 2, content_hash: 'e'.repeat(64), payload: { ...clone(initialPayload), preparation_notes: 'actual advanced target' }, sources: { reuse: { schema: 'yuantus.welding_reuse/1', reuse_id: 'reuse' } } }
    const proof = { schema: 'yuantus.welding_reuse_provenance/1', reuse_id: 'reuse', reuse_provenance_sha256: 'c'.repeat(64), basis: { schema: 'yuantus.welding_reuse/1', metadata: { id: 'reuse', tenant_id: 'tenant', org_id: 'org', source_plan_id: 'plan', source_version_id: 'v1', source_publication_id: 'publication', target_plan_id: target.plan_id, target_version_id: 'target-v1', request_id: original.body.request_id, request_digest: hash, reason: original.body.reason, actor: requester, created_at: '2026-10-09T00:00:00Z' }, request: clone(original.body), source: { draft_seq: 1, content_hash: hash }, target: { version_label: 'A', payload: initialPayload, sources: clone(target.sources), content_hash: 'b'.repeat(64) }, mappings: [{ source_weld_id: 'w1', target_weld_id: 'new-w1', source_values: {}, copy_values: {}, process_associations: [], resource_associations: [] }] } }
    f.client.readReuseProvenance = vi.fn(async () => clone(proof)) as any
    vi.mocked(f.client.read).mockResolvedValue(target)
    vi.mocked(f.client.recover).mockImplementation(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current: clone(target), can_write: target.state === 'Draft', conflict: false }))
    vi.mocked(f.db.getWorkflow).mockImplementation(async (_o, p, v) => p === 'plan' && v === 'v1' ? f.getPending() : null)
    Object.assign(f.planDB, { list: vi.fn(async () => []) })
    vi.mocked(f.client.readReviewState).mockImplementation(async (p, v) => p === 'plan' ? clone(f.current) : { ...clone(f.current), plan_id: p, item_version_id: v, state: target.state, draft_seq: target.draft_seq, content_hash: target.content_hash, approval: null, publication: null, allowed_actions: [] })
    return { ...f, original, target, proof }
  }
  it('uses bound included welds without a nonexistent allowed_actions reuse permission and keeps source selections unchanged', async () => {
    const f = await reuseFixture(), source = clone(f.session.state.payload)
    expect(f.workflow.reuseWeldIds.value).toEqual(['w1']); await choose(f)
    expect(f.session.state.payload).toEqual(source); expect(f.workflow.canCreateReuse.value).toBe(true)
    await f.workflow.createReuse(); expect(f.client.reusePlan).toHaveBeenCalledTimes(1)
    expect(f.getPending()?.action).toBe('reuse'); expect(f.workflow.state.reuseAck?.target_content_hash).toBe('b'.repeat(64))
    expect(f.db.clearWorkflow).not.toHaveBeenCalled(); expect(f.session.state.planId).toBe('plan')
  })
  it('F18b canonicalizes an uppercase drawing candidate locally before claim without mutating the candidate or source', async () => {
    const f = await reuseFixture(), source = clone(f.session.state.payload)
    vi.mocked(f.client.drawingCandidates).mockResolvedValue([{ item_id: 'drawing', version_id: 'd2', file_id: 'f2', file_role: 'drawing', checksum: hash.toUpperCase(), name: 'Drawing', number: 'D2', version_label: 'A' }])
    await choose(f)
    expect(f.session.state.payload).toEqual(source); expect(f.workflow.reuse.drawings[0].checksum).toBe(hash.toUpperCase())
    expect(f.workflow.reuse.drawing?.expected_checksum).toBe(hash)
    expect(f.db.claimWorkflow).not.toHaveBeenCalled(); await f.workflow.createReuse()
    expect(f.client.reusePlan).toHaveBeenCalledWith('plan', 'v1', expect.objectContaining({ drawing: expect.objectContaining({ expected_checksum: hash }) }), expect.anything())
  })
  it.each(['uppercase', 'omitted-bom', 'both'])('F18b opens historical %s original against Y-normalized provenance without changing original bytes', async variant => {
    const f = await adoptionFixture(), historical = clone(f.original)
    if (variant !== 'omitted-bom') historical.body.drawing.expected_checksum = hash.toUpperCase()
    if (variant !== 'uppercase') delete historical.body.bom
    // Y DrawingTarget lowercases checksum and ReusePlanRequest supplies absent bom=null.
    expect(f.proof.basis.request.drawing.expected_checksum).toBe(hash); expect(f.proof.basis.request.bom).toBeNull()
    f.setPending(historical); const raw = JSON.stringify(historical)
    await f.workflow.refresh(); await f.workflow.resolveReuse()
    expect(f.client.resolveReuseReceipt).toHaveBeenLastCalledWith(historical, expect.anything())
    await f.workflow.openReuseTarget(); await vi.waitFor(() => expect(f.workflow.state.working).toBe(false))
    expect(JSON.stringify(f.getPending())).toBe(raw); expect(f.client.reusePlan).toHaveBeenCalledTimes(1); expect(f.db.clearWorkflow).not.toHaveBeenCalled()
    expect(f.session.state.planId).toBe(f.target.plan_id); expect(f.workflow.state.reuseCleanup?.original).toEqual(historical)
  })
  it.each(['publication', 'generation', 'savepoint', 'selected'])('rejects mismatched source evidence %s before claim', async mismatch => {
    const f = await reuseFixture(); await choose(f)
    if (mismatch === 'publication') f.current.publication!.submission_hash = 'b'.repeat(64)
    if (mismatch === 'generation') f.current.approval!.submission.review_generation_id = 'wrong'
    if (mismatch === 'savepoint') f.current.approval!.submission.draft_seq = 2
    if (mismatch === 'selected') f.workflow.reuse.selectedWeldIds = ['excluded']
    await f.workflow.createReuse(); expect(f.db.claimWorkflow).not.toHaveBeenCalled(); expect(f.client.reusePlan).not.toHaveBeenCalled()
  })
  it('recreates from exact durable original, resolves with write OFF and advanced source, and never auto posts', async () => {
    const f = await reuseFixture(); await choose(f); vi.mocked(f.client.reusePlan).mockRejectedValue(new Error('lost reply'))
    await f.workflow.createReuse(); const original = f.getPending()!; expect(original.action).toBe('reuse')
    f.workflow.dispose(); f.flags.writable = false; f.current.state = 'Superseded'; f.current.is_current = false
    const recreated = useWeldingWorkflowSession({ session: f.session, active: () => f.flags.active, writable: () => f.flags.writable, openStore: async () => f.db })
    try {
      await recreated.setTarget('plan', 'v1'); expect(recreated.state.pending).toEqual(original); expect(f.client.reusePlan).toHaveBeenCalledTimes(1)
      await recreated.resolveReuse(); expect(f.client.resolveReuseReceipt).toHaveBeenCalledWith(original, expect.anything())
      expect(recreated.state.reuseAck).not.toBeNull(); expect(f.getPending()).toEqual(original); expect(f.client.reusePlan).toHaveBeenCalledTimes(1)
    } finally { recreated.dispose() }
  })
  it.each(['Draft', 'InReview', 'Released'])('F18b actual advanced %s target opens only after GET/provenance/restore and preserves source original until separate CAS', async state => {
    const f = await adoptionFixture(), source = clone(f.session.state.payload); f.target.state = state
    const barrier = vi.fn(async () => {}); f.session.setCadBarrier(barrier); f.session.state.overlayContextId = 'old-context'; f.session.state.historyLength = 3; f.session.state.historyCursor = 2
    await f.workflow.openReuseTarget(); await vi.waitFor(() => expect(f.workflow.state.working).toBe(false))
    expect(f.client.read).toHaveBeenLastCalledWith(f.target.plan_id, 'target-v1', expect.anything())
    expect(f.client.readReuseProvenance).toHaveBeenCalledWith(f.target.plan_id, 'target-v1', owner, expect.anything()); expect(barrier).toHaveBeenCalledOnce()
    expect(f.session.state.payload).toEqual(f.target.payload); expect(source).toEqual(payload)
    expect(f.session.state).toMatchObject({ planId: f.target.plan_id, versionId: 'target-v1', draftSeq: 2, contentHash: 'e'.repeat(64), blocked: state !== 'Draft', overlayContextId: '', historyLength: 0, historyCursor: 0, pending: null, uncertain: false, preview: null })
    expect(f.getPending()).toEqual(f.original); expect(f.db.clearWorkflow).not.toHaveBeenCalled(); expect(f.workflow.state.reuseCleanup?.opened.draft_seq).toBe(2)
    expect(f.session.canEdit.value).toBe(state === 'Draft')
    vi.mocked(f.db.clearWorkflow).mockRejectedValueOnce(new Error('native abort')); await f.workflow.cleanupReuse(); expect(f.getPending()).toEqual(f.original); expect(f.workflow.state.reuseCleanup).not.toBeNull()
    await f.workflow.cleanupReuse(); expect(f.getPending()).toBeNull(); expect(f.workflow.state.reuseCleanup).toBeNull(); expect(f.db.clearWorkflow).toHaveBeenLastCalledWith(f.original, expect.anything())
  })
  it.each(['workflow-before', 'generation-before', 'plan-before', 'workflow-after', 'generation-after', 'plan-after', 'source-raw', 'source-raw-order'])('F18b target pending or changed source %s prevents staged adoption and cleanup', async kind => {
    const f = await adoptionFixture(), before = clone(f.session.state.payload)
    const targetPending = { ...f.original, plan_id: f.target.plan_id, item_version_id: f.target.item_version_id }
    let after = false
    vi.mocked(f.client.recover).mockImplementation(async (_purpose, record) => { after = true; return { schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current: clone(f.target), can_write: true, conflict: false } })
    vi.mocked(f.db.getWorkflow).mockImplementation(async (_o, p) => {
      if (p === 'plan') { if (kind === 'source-raw' && after) return { ...f.original, body: { ...f.original.body, reason: 'changed' } }; if (kind === 'source-raw-order' && after) return { ...f.original, body: Object.fromEntries(Object.entries(f.original.body).reverse()) } as WorkflowPending; return f.getPending() }
      return kind === 'workflow-before' || kind === 'workflow-after' && after ? targetPending : null
    })
    vi.mocked(f.db.get).mockImplementation(async () => kind === 'generation-before' || kind === 'generation-after' && after ? { plan_id: f.target.plan_id, item_version_id: 'target-v1' } as any : null)
    vi.mocked(f.planDB.list).mockImplementation(async () => kind === 'plan-before' || kind === 'plan-after' && after ? [{ pending: {}, draft: { plan_id: f.target.plan_id, version_id: 'target-v1' } }] as any : [])
    await f.workflow.openReuseTarget(); expect(f.session.state.planId).toBe('plan'); expect(f.session.state.payload).toEqual(before); expect(f.getPending()).toEqual(f.original); expect(f.db.clearWorkflow).not.toHaveBeenCalled(); expect(f.workflow.state.reuseCleanup).toBeNull()
  })
  it.each(['owner', 'provenance', 'initial-hash', 'restore-current', 'restore-id', 'conflict'])('F18b mismatched %s keeps source and target unapplied', async kind => {
    const f = await adoptionFixture()
    if (kind === 'owner') vi.mocked(f.client.authority).mockResolvedValue({ ...owner, rbac_user_id: 999 })
    if (kind === 'provenance') f.proof.reuse_provenance_sha256 = 'f'.repeat(64)
    if (kind === 'initial-hash') f.target.draft_seq = 1
    if (kind.startsWith('restore') || kind === 'conflict') vi.mocked(f.client.recover).mockImplementation(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: kind === 'restore-id' ? 'wrong' : record.recovery_id, current: kind === 'restore-current' ? { ...f.target, draft_seq: 3 } : f.target, can_write: true, conflict: kind === 'conflict' }))
    await f.workflow.openReuseTarget(); expect(f.session.state.planId).not.toBe(f.target.plan_id); expect(f.getPending()).toEqual(f.original); expect(f.db.clearWorkflow).not.toHaveBeenCalled()
  })
  it.each(['auth', 'target-ABA'])('F18b held actual target GET after %s cannot adopt or clear', async change => {
    const f = await adoptionFixture(), held = deferred<any>(); vi.mocked(f.client.read).mockReturnValueOnce(held.promise)
    const job = f.workflow.openReuseTarget(); await vi.waitFor(() => expect(f.client.read).toHaveBeenCalledWith(f.target.plan_id, 'target-v1', expect.anything()))
    if (change === 'auth') { localStorage.setItem('auth_token', 'native-B'); notifyAuthPrincipalChange() }
    else { await f.workflow.setTarget('other', 'v9'); await f.workflow.setTarget('plan', 'v1') }
    held.resolve(f.target); await job; expect(f.session.state.planId).not.toBe(f.target.plan_id); expect(f.getPending()).toEqual(f.original); expect(f.workflow.state.reuseCleanup).toBeNull()
  })
  it('F18b explicit replay retains the exact original despite changed form and Superseded source', async () => {
    const f = await reuseFixture(); await choose(f); vi.mocked(f.client.reusePlan).mockRejectedValueOnce(new Error('lost'))
    await f.workflow.createReuse(); const original = f.getPending()!; f.current.state = 'Superseded'; f.current.is_current = false; f.workflow.reuse.reason = 'changed form'
    await f.workflow.replayReuse(); expect(f.client.reusePlan).toHaveBeenCalledTimes(2); expect(vi.mocked(f.client.reusePlan).mock.calls.map(call => JSON.stringify(call[2]))).toEqual([JSON.stringify(original.body), JSON.stringify(original.body)])
  })
  it('F18b accepts a service-authorized workflow advance at unchanged initial sequence and hash', async () => {
    const f = await adoptionFixture(); f.target.draft_seq = 1; f.target.content_hash = 'b'.repeat(64); f.target.state = 'Released'
    await f.workflow.openReuseTarget(); await vi.waitFor(() => expect(f.workflow.state.working).toBe(false))
    expect(f.session.state).toMatchObject({ planId: f.target.plan_id, draftSeq: 1, serverState: 'Released', blocked: true }); expect(f.getPending()).toEqual(f.original)
  })
  it.each(['claim', 'owner', 'write-off', 'reread'])('F18b %s failure suppresses POST and never clears durable source', async kind => {
    const f = await reuseFixture(); await choose(f)
    if (kind === 'claim') vi.mocked(f.db.claimWorkflow).mockRejectedValueOnce(new Error('quota abort'))
    else {
      const claim = vi.mocked(f.db.claimWorkflow).getMockImplementation()!
      vi.mocked(f.db.claimWorkflow).mockImplementation(async (...args) => { const result = await claim(...args); if (kind === 'owner') vi.mocked(f.client.authority).mockResolvedValue({ ...owner, rbac_user_id: 999 }); if (kind === 'write-off') f.flags.writable = false; if (kind === 'reread') vi.mocked(f.db.getWorkflow).mockResolvedValue(null); return result })
    }
    await f.workflow.createReuse(); expect(f.client.reusePlan).not.toHaveBeenCalled(); expect(f.db.clearWorkflow).not.toHaveBeenCalled(); if (kind !== 'claim') expect(f.getPending()?.action).toBe('reuse')
  })
  it.each(['denied', 'auth', 'target-ABA'])('F18b cold provenance %s never exposes stale basis or edits the target', async kind => {
    const f = await adoptionFixture(); f.flags.writable = false; vi.mocked(f.client.recoveryOwner).mockRejectedValue(new Error('editor unavailable'))
    await f.workflow.setTarget(f.target.plan_id, 'later-authorized-version'); const before = clone(f.session.state.payload)
    if (kind === 'denied') { vi.mocked(f.client.readReuseProvenance).mockRejectedValue(new WeldingPlanError('denied', 403)); await f.workflow.readReuseProvenance() }
    else {
      const held = deferred<any>(); vi.mocked(f.client.readReuseProvenance).mockReturnValueOnce(held.promise)
      const job = f.workflow.readReuseProvenance(); await vi.waitFor(() => expect(f.client.readReuseProvenance).toHaveBeenCalledOnce())
      if (kind === 'auth') { localStorage.setItem('auth_token', 'native-B'); notifyAuthPrincipalChange() }
      else { await f.workflow.setTarget('other', 'v9'); await f.workflow.setTarget(f.target.plan_id, 'later-authorized-version') }
      held.resolve(f.proof); await job
    }
    expect(f.workflow.provenance.current).toBeNull(); expect(f.getPending()).toEqual(f.original)
    if (kind !== 'auth') expect(f.session.state.payload).toEqual(before)
  })
  it('F18b cold later-version provenance permits historical actor and initial adoption version without editor recovery', async () => {
    const f = await adoptionFixture(); f.flags.writable = false; vi.mocked(f.client.recoveryOwner).mockClear().mockRejectedValue(new Error('editor unavailable'))
    await f.workflow.setTarget(f.target.plan_id, 'later-authorized-version'); await f.workflow.readReuseProvenance()
    expect(f.workflow.provenance.current?.basis.metadata.target_version_id).toBe('target-v1'); expect(f.workflow.provenance.current?.basis.metadata.actor).toEqual(requester); expect(f.client.recoveryOwner).not.toHaveBeenCalled(); expect(f.getPending()).toEqual(f.original)
  })
  it('F18b source cleanup is informational: target edit/save works, while its own pending remains a real barrier', async () => {
    const f = await adoptionFixture(); await f.workflow.openReuseTarget(); await vi.waitFor(() => expect(f.workflow.state.working).toBe(false))
    f.client.save = vi.fn(async record => ({ ...clone(f.target), payload: clone(record.pending!.body.payload) as typeof f.target.payload, draft_seq: 3, content_hash: 'f'.repeat(64) }))
    expect(f.session.canEdit.value).toBe(true); await f.session.edit(next => { next.preparation_notes = 'target-only change' }); await f.session.save()
    expect(f.client.save).toHaveBeenCalledOnce(); expect(vi.mocked(f.client.save).mock.calls[0][0].draft).toMatchObject({ plan_id: f.target.plan_id, version_id: 'target-v1' })
    expect(f.session.state.payload.preparation_notes).toBe('target-only change'); expect(f.getPending()).toEqual(f.original); expect(f.workflow.state.reuseCleanup).not.toBeNull()
    const before = clone(f.session.state.payload); vi.mocked(f.db.getWorkflow).mockImplementation(async (_o, p) => p === 'plan' ? f.getPending() : { ...f.original, plan_id: f.target.plan_id, item_version_id: 'target-v1' })
    await f.session.edit(next => { next.preparation_notes = 'must not apply' }); expect(f.session.state.payload).toEqual(before); expect(f.getPending()).toEqual(f.original)
  })
  it('F18b held cleanup loses authorization without deleting source and late completion cannot restore context', async () => {
    const f = await adoptionFixture(); await f.workflow.openReuseTarget(); await vi.waitFor(() => expect(f.workflow.state.working).toBe(false))
    const held = deferred<typeof owner>(); vi.mocked(f.client.authority).mockReturnValueOnce(held.promise)
    const job = f.workflow.cleanupReuse(); localStorage.setItem('auth_token', 'native-B'); notifyAuthPrincipalChange(); held.resolve(owner); await job
    expect(f.db.clearWorkflow).not.toHaveBeenCalled(); expect(f.getPending()).toEqual(f.original); expect(f.workflow.state.reuseCleanup).toBeNull()
  })
})
describe('finite workflow consumer', () => {
  it('cold reads and validates with write OFF without personal recovery or CAD', async () => {
    const f = await make(); f.flags.writable = false; vi.mocked(f.client.recoveryOwner).mockRejectedValue(new Error('plugin absent'))
    await f.workflow.refresh(); await f.workflow.validate()
    expect(f.workflow.state.current?.state).toBe('InReview'); expect(f.workflow.state.validation?.ready).toBe(false)
    expect(f.client.recoveryOwner).not.toHaveBeenCalled(); expect(f.workflow.canAction('approve')).toBe(false)
  })
  it('storage failure closes mutations while independently readable state/history remain available', async () => {
    const f = await make(); vi.mocked(f.db.getWorkflow).mockRejectedValue(new Error('storage unavailable')); await f.workflow.refresh()
    expect(f.workflow.state.current?.state).toBe('InReview'); expect(f.workflow.state.history).not.toBeNull(); expect(f.workflow.state.storageBlocked).toBe(true)
    expect(f.workflow.canAction('approve')).toBe(false); await f.workflow.command('approve', { opinion: '' }); expect(f.client.reviewWorkflowPlan).not.toHaveBeenCalled()
  })
  it('cold reviewer approves with no editor initialization, personal authority or CAD barrier', async () => {
    const f = await make(); expect(f.session.canEdit.value).toBe(false)
    vi.mocked(f.client.recoveryOwner).mockRejectedValue(new Error('plugin absent'))
    await f.workflow.command('approve', { opinion: '冷评审' })
    expect(f.client.reviewWorkflowPlan).toHaveBeenCalledTimes(1); expect(f.client.recoveryOwner).not.toHaveBeenCalled(); expect(f.client.read).not.toHaveBeenCalled(); expect(f.getPending()).toBeNull()
  })
  it('a body readonly reviewer approves using both identities and actual reloaded body', async () => {
    const f = await make('InReview', true); expect(f.session.canEdit.value).toBe(false); expect(f.workflow.canAction('approve')).toBe(true)
    await f.workflow.command('approve', { opinion: '认可' })
    expect(f.client.reviewWorkflowPlan).toHaveBeenCalledTimes(1); expect(f.getPending()).toBeNull()
    expect(f.session.state.serverState).toBe('Approved'); expect(f.session.state.blocked).toBe(true); expect(f.session.state.commandBusy).toBe(false)
  })
  it('refreshes an approved read-only body even when reviewer draft recovery update authority is denied', async () => {
    const f = await make('InReview', true), claim = vi.spyOn(f.planDB, 'claim'), replace = vi.spyOn(f.planDB, 'compareReplace')
    vi.mocked(f.client.recover).mockClear().mockRejectedValue(new WeldingPlanError('update denied', 404))
    await f.workflow.command('approve', { opinion: '认可' })
    expect(f.client.reviewWorkflowPlan).toHaveBeenCalledTimes(1); expect(f.getPending()).toBeNull()
    expect(f.session.state.serverState).toBe('Approved'); expect(f.session.state.blocked).toBe(true); expect(f.session.canEdit.value).toBe(false)
    expect(f.client.recover).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled()
    expect(f.workflow.state.message).toBe('评审动作已确认：Approved')
  })
  it('does not apply a reopened Draft body when draft recovery update authority is denied', async () => {
    const f = await make('Approved', true); f.current.approval = approval(); f.current.allowed_actions = ['reopen']; await f.workflow.refresh()
    vi.mocked(f.client.recover).mockClear().mockRejectedValue(new WeldingPlanError('update denied', 404))
    await f.workflow.command('reopen', { reason: '重新编制' })
    expect(f.client.reopenWorkflowPlan).toHaveBeenCalledTimes(1); expect(f.getPending()).toBeNull()
    expect(f.client.recover).toHaveBeenCalledTimes(1); expect(f.session.state.serverState).toBe('Approved'); expect(f.session.state.blocked).toBe(true)
    expect(f.session.canEdit.value).toBe(false); expect(f.workflow.state.message).toContain('动作已确认，正文或评审资料尚未刷新')
  })
  it('rejects an auth-only or RBAC-only reviewer and a publisher without reopen permission', async () => {
    const f = await make()
    for (const patch of [{ auth_user_id: 9 }, { rbac_user_id: 21 }]) { vi.mocked(f.client.authority).mockResolvedValueOnce({ ...owner, ...patch }); await f.workflow.command('approve', { opinion: '' }); expect(f.client.reviewWorkflowPlan).not.toHaveBeenCalled(); expect(f.workflow.state.current).toBeNull(); await f.workflow.refresh() }
    f.current.state = 'Approved'; f.current.allowed_actions = []; await f.workflow.refresh(); await f.workflow.command('reopen', { reason: '修改' }); expect(f.client.reopenWorkflowPlan).not.toHaveBeenCalled()
  })
  it('reject requires an opinion before claim or POST', async () => {
    const f = await make(); await f.workflow.command('reject', { opinion: '  ' })
    expect(f.db.claimWorkflow).not.toHaveBeenCalled(); expect(f.client.reviewWorkflowPlan).not.toHaveBeenCalled()
  })
  it('submit uses a clean saved point and a freshly read Ready review generation', async () => {
    const f = await make('Draft', true); await f.workflow.command('submit', { reviewer: 19, generation: ready() })
    expect(f.client.submitWorkflowPlan).toHaveBeenCalledTimes(1); expect(f.client.readReviewGeneration).toHaveBeenCalledWith(id, expect.anything()); expect(f.getPending()).toBeNull()
  })
  it('does not claim a submission addressed to the same RBAC identity', async () => {
    const f = await make('Draft', true); await f.workflow.command('submit', { reviewer: owner.rbac_user_id, generation: ready() })
    expect(f.db.claimWorkflow).not.toHaveBeenCalled(); expect(f.client.submitWorkflowPlan).not.toHaveBeenCalled()
  })
  it('withdraw and authorized reopen preserve the original submission basis, with reopen seq+1', async () => {
    const withdraw = await make(); await withdraw.workflow.command('withdraw', { reason: '修改' })
    expect(withdraw.client.withdrawWorkflowPlan).toHaveBeenCalledWith('plan', 'v1', expect.objectContaining({ approval_request_id: 'approval', expected_submission_hash: hash, expected_draft_seq: 1, reason: '修改' }), expect.anything()); expect(withdraw.getPending()).toBeNull()
    const reopen = await make(); reopen.current.state = 'Approved'; reopen.current.allowed_actions = ['reopen']; await reopen.workflow.refresh(); await reopen.workflow.command('reopen', { reason: '重新编制' })
    expect(reopen.client.reopenWorkflowPlan).toHaveBeenCalledTimes(1); expect(reopen.workflow.state.current?.draft_seq).toBe(2); expect(reopen.getPending()).toBeNull()
  })
  it.each([{ status: 'Queued' }, { item_version_id: 'other' }, { draft_seq: 2 }, { plan_content_hash: 'b'.repeat(64) }])('rejects a noncurrent or unfinished generation %s', async patch => {
    const f = await make('Draft', true), selected = { ...ready(), ...patch } as ReviewGeneration
    vi.mocked(f.client.readReviewGeneration).mockResolvedValue(selected); await f.workflow.command('submit', { reviewer: 19, generation: selected })
    expect(f.client.submitWorkflowPlan).not.toHaveBeenCalled(); expect(f.db.claimWorkflow).not.toHaveBeenCalled()
  })
  it('fresh allowed actions revoke a previously shown approve before claim', async () => {
    const f = await make(); f.current.allowed_actions = []; await f.workflow.command('approve', { opinion: '' })
    expect(f.db.claimWorkflow).not.toHaveBeenCalled(); expect(f.client.reviewWorkflowPlan).not.toHaveBeenCalled()
  })
  it('UNKNOWN remains durable through read-only resolve; explicit replay keeps original identity/body', async () => {
    const f = await make(); vi.mocked(f.client.reviewWorkflowPlan).mockRejectedValueOnce(new Error('connection lost'))
    await f.workflow.command('approve', { opinion: '认可' }); const original = f.getPending(); expect(original).not.toBeNull()
    await f.workflow.resolve(); expect(f.client.reviewWorkflowPlan).toHaveBeenCalledTimes(1); expect(f.getPending()).toEqual(original)
    f.flags.writable = false; await f.workflow.replay(); expect(f.client.reviewWorkflowPlan).toHaveBeenCalledTimes(1)
    f.flags.writable = true; await f.workflow.replay(); expect(f.client.reviewWorkflowPlan).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.client.reviewWorkflowPlan).mock.calls[1][2]).toEqual(original!.body); expect(f.getPending()).toBeNull()
  })
  it('waits for claim completion and retains the original after stale CAS', async () => {
    const f = await make(), claim = deferred<boolean>(), actual = vi.mocked(f.db.claimWorkflow).getMockImplementation()!
    vi.mocked(f.db.claimWorkflow).mockImplementationOnce(async value => { await actual(value); return claim.promise }); vi.mocked(f.db.clearWorkflow).mockResolvedValue(false)
    const job = f.workflow.command('approve', { opinion: '' }); await vi.waitFor(() => expect(f.db.claimWorkflow).toHaveBeenCalled())
    expect(f.client.reviewWorkflowPlan).not.toHaveBeenCalled(); claim.resolve(true); await job
    expect(f.client.reviewWorkflowPlan).toHaveBeenCalledTimes(1); expect(f.getPending()).not.toBeNull(); expect(f.workflow.state.message).toContain('原记录已变化')
  })
  it('hides late token ABA / target / owner work without dispatch or clearing originals', async () => {
    for (const change of ['token', 'target', 'owner']) {
      const f = await make(), gate = deferred<WorkflowState>(); vi.mocked(f.client.readReviewState).mockReturnValueOnce(gate.promise)
      const job = f.workflow.command('approve', { opinion: '' }); await vi.waitFor(() => expect(f.client.readReviewState).toHaveBeenCalledTimes(2))
      if (change === 'token') { localStorage.setItem('auth_token', 'B'); notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'native-A'); notifyAuthPrincipalChange() }
      if (change === 'target') void f.workflow.setTarget('other', 'v2')
      if (change === 'owner') vi.mocked(f.client.authority).mockResolvedValue({ ...owner, rbac_user_id: 22 })
      gate.resolve(clone(f.current)); await job
      expect(f.client.reviewWorkflowPlan).not.toHaveBeenCalled(); expect(f.getPending()).toBeNull()
    }
  })
  it('readonly resolution is not gated by a local dirty body and reload failure leaves it readonly', async () => {
    const f = await make('InReview', true); vi.mocked(f.client.reviewWorkflowPlan).mockRejectedValueOnce(new Error('lost'))
    await f.workflow.command('approve', { opinion: '' }); const original = f.getPending()!; f.session.state.dirty = true
    vi.mocked(f.client.resolveWorkflowReceipt).mockResolvedValue(validateWorkflowAck({ schema: 'yuantus.welding_plan_workflow_ack/1', request_id: original.body.request_id, action: 'approve', plan_id: 'plan', item_version_id: 'v1', draft_seq: 1, content_hash: hash, state: 'Approved', approval_request_id: 'approval', publication_id: null }, original))
    await f.workflow.resolve(); expect(f.getPending()).toBeNull(); expect(f.session.state.dirty).toBe(true); expect(f.session.state.blocked).toBe(true); expect(f.workflow.state.message).toContain('尚未刷新')
  })
  it('fails closed without locks before workflow claim or POST', async () => {
    const f = await make(); Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); await f.workflow.command('approve', { opinion: '' })
    expect(f.db.claimWorkflow).not.toHaveBeenCalled(); expect(f.client.reviewWorkflowPlan).not.toHaveBeenCalled(); expect(f.workflow.state.message).toContain('当前浏览器')
  })
})

const finalBasis: FinalGenerationBasis = { ...fixed, generation_id: '00000000-0000-4000-8000-000000000010', purpose: 'final', approval_request_id: 'approval', submission_hash: hash, decision_hash: 'd'.repeat(64), template: { id: 'welding-approval-appendix', version: '1', digest: hash } }
const finalRecord = (status: 'Queued' | 'Running' | 'Ready' | 'Failed' = 'Ready'): FinalGeneration => ({ schema: 'yuantus.welding_final_generation/1', ...finalBasis, status, state: 'Approved', attempt: 2, created_at: '2026-10-09T00:00:00Z', files: status === 'Ready' ? ready().files : { pdf: null, docx: null }, error: status === 'Failed' ? { stage: 'render', code: 'FAILED', message: 'finite failure' } : null })
const finalAck = (request: string): FinalGenerationAck => ({ schema: 'yuantus.welding_final_generation_ack/1', request_id: request, ...finalBasis })
const formal = (state: 'Released' | 'Superseded' = 'Released'): Publication => ({ schema: 'yuantus.welding_plan_publication/1', publication_id: 'publication', plan_id: 'plan', item_version_id: 'v1', state, draft_seq: 1, content_hash: hash, version_label: 'A', name: 'Plan', number: 'W1', approval_request_id: 'approval', submission_hash: hash, decision_hash: finalBasis.decision_hash, review_generation_id: id, final_generation_id: finalBasis.generation_id, generation_content_hash: hash, requester, reviewer, opinion: '', approved_at: '2026-10-09T00:00:00Z', published_at: '2026-10-09T01:00:00Z', publisher: reviewer, files: ready().files as Publication['files'] })
async function finalFixture(status: 'Queued' | 'Running' | 'Ready' | 'Failed' = 'Ready') {
  const f = await make()
  f.current.state = 'Approved'; f.current.approval = { ...approval(), state: 'approved', decision: { decision_hash: finalBasis.decision_hash, decision: { decision: 'approve', opinion: '', reviewer, decided_at: '2026-10-09T00:00:00Z' } } }
  f.current.final_generation = finalRecord(status); f.current.final_profile = finalBasis.template; f.current.allowed_actions = ['final-render', status === 'Ready' ? 'release' : 'final-retry']
  f.client.readFinalGeneration = vi.fn(async () => clone(f.current.final_generation as FinalGeneration))
  f.client.createFinalGeneration = vi.fn(async (_plan, _version, body) => { f.current.final_generation = finalRecord('Queued'); return finalAck(body.request_id) })
  f.client.retryFinalGeneration = vi.fn(async (_basis, body) => { f.current.final_generation = finalRecord('Queued'); return finalAck(body.request_id) })
  f.client.releaseWorkflowPlan = vi.fn(async (_plan, _version, body) => {
    f.current.state = 'Released'; f.current.allowed_actions = []; f.current.publication = formal(); f.current.final_generation = { ...finalRecord(), state: 'Released' }
    return { schema: 'yuantus.welding_plan_workflow_ack/1', request_id: body.request_id, action: 'release', plan_id: 'plan', item_version_id: 'v1', draft_seq: 1, content_hash: hash, state: 'Released', approval_request_id: 'approval', publication_id: 'publication' }
  })
  f.client.readPublication = vi.fn(async () => clone(f.current.publication as Publication))
  f.client.downloadPublicationFile = vi.fn(async (_publication, format) => new Blob(['x'], { type: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
  await f.workflow.refresh()
  return f
}
describe('finite C2 workflow consumer', () => {
  it('starts fixed-G polling after history holds the initial read beyond two seconds', async () => {
    const f = await finalFixture('Queued'), held = deferred<Awaited<ReturnType<WeldingPlanClient['readReviewHistory']>>>()
    vi.useFakeTimers()
    try {
      vi.mocked(f.client.readReviewHistory).mockReturnValueOnce(held.promise)
      const reading = f.workflow.refresh()
      await vi.advanceTimersByTimeAsync(2100)
      expect(f.workflow.state.working).toBe(true); expect(f.client.readFinalGeneration).not.toHaveBeenCalled()
      held.resolve({ schema: 'yuantus.welding_review_history/1', plan_id: 'plan', item_version_id: 'v1', total: 0, limit: 50, offset: 0, items: [] }); await reading
      expect(f.workflow.state.working).toBe(false)
      await vi.advanceTimersByTimeAsync(2100)
      expect(f.client.readFinalGeneration).toHaveBeenCalledTimes(1)
      expect(vi.mocked(f.client.readFinalGeneration).mock.calls[0][0]).toEqual(finalBasis)
    } finally { f.workflow.dispose(); vi.useRealTimers() }
  })
  it.each(['target', 'generation', 'tenant_id', 'org_id', 'auth_user_id', 'rbac_user_id', 'token-ABA'])('discards held fixed-G polling after %s changes', async change => {
    const f = await finalFixture('Queued'), held = deferred<FinalGeneration>()
    vi.mocked(f.client.readFinalGeneration).mockReturnValueOnce(held.promise)
    const job = f.workflow.refreshFinal(); await vi.waitFor(() => expect(f.client.readFinalGeneration).toHaveBeenCalledTimes(1))
    expect(vi.mocked(f.client.readFinalGeneration).mock.calls[0][0]).toEqual(finalBasis)
    if (change === 'target') await f.workflow.setTarget('other', 'v2')
    else if (change === 'generation') f.workflow.state.current!.final_generation = { ...finalRecord('Queued'), generation_id: '00000000-0000-4000-8000-000000000011' }
    else if (change === 'token-ABA') { localStorage.setItem('auth_token', 'B'); notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'native-A'); notifyAuthPrincipalChange() }
    else vi.mocked(f.client.authority).mockResolvedValue({ ...owner, [change]: typeof owner[change as keyof typeof owner] === 'number' ? 99 : 'other' })
    held.resolve(finalRecord()); await job
    expect(f.workflow.state.current?.final_generation?.status).not.toBe('Ready')
    expect(f.client.createFinalGeneration).not.toHaveBeenCalled(); expect(f.client.retryFinalGeneration).not.toHaveBeenCalled(); expect(f.db.clearWorkflow).not.toHaveBeenCalled()
  })
  it.each(['Ready', 'Failed', 'error'] as const)('stops automatic fixed-G reads at %s without any automatic POST', async terminal => {
    const f = await finalFixture('Queued'); vi.useFakeTimers()
    try {
      await f.workflow.refresh()
      if (terminal === 'error') vi.mocked(f.client.readFinalGeneration).mockRejectedValueOnce(new Error('status unavailable'))
      else { f.current.final_generation = finalRecord(terminal); vi.mocked(f.client.readFinalGeneration).mockResolvedValueOnce(finalRecord(terminal)) }
      await vi.advanceTimersByTimeAsync(2000)
      expect(f.client.readFinalGeneration).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(6000)
      expect(f.client.readFinalGeneration).toHaveBeenCalledTimes(1)
      expect(f.client.createFinalGeneration).not.toHaveBeenCalled(); expect(f.client.retryFinalGeneration).not.toHaveBeenCalled()
    } finally { f.workflow.dispose(); vi.useRealTimers() }
  })
  it('fixed final polling is single-flight and discards a response after read OFF', async () => {
    const f = await finalFixture('Queued'), held = deferred<FinalGeneration>()
    vi.mocked(f.client.readFinalGeneration).mockReturnValueOnce(held.promise)
    const first = f.workflow.refreshFinal(); await vi.waitFor(() => expect(f.client.readFinalGeneration).toHaveBeenCalledTimes(1))
    await f.workflow.refreshFinal(); expect(f.client.readFinalGeneration).toHaveBeenCalledTimes(1)
    f.flags.active = false; await Promise.resolve(); held.resolve(finalRecord()); await first
    expect(f.workflow.state.current).toBeNull(); expect(f.client.createFinalGeneration).not.toHaveBeenCalled(); expect(f.client.retryFinalGeneration).not.toHaveBeenCalled()
  })
  it('an overlapping poll cannot revoke an explicit final command or clear its durable original', async () => {
    const f = await finalFixture('Queued'), poll = deferred<FinalGeneration>(), command = deferred<FinalGenerationAck>()
    vi.mocked(f.client.readFinalGeneration).mockReturnValueOnce(poll.promise)
    const reading = f.workflow.refreshFinal(); await vi.waitFor(() => expect(f.client.readFinalGeneration).toHaveBeenCalledTimes(1))
    vi.mocked(f.client.createFinalGeneration).mockReturnValueOnce(command.promise)
    const creating = f.workflow.command('final-render', {}); await vi.waitFor(() => expect(f.client.createFinalGeneration).toHaveBeenCalledTimes(1))
    const original = f.getPending(); poll.resolve(finalRecord()); await reading
    expect(f.getPending()).toEqual(original); expect(vi.mocked(f.client.createFinalGeneration).mock.calls[0][3]!.accepts()).toBe(true)
    command.resolve(finalAck(original!.body.request_id)); await creating; expect(f.getPending()).toBeNull()
  })
  it('final create uses the approved fixed point and profile only after durable admission', async () => {
    const f = await finalFixture(), held = deferred<boolean>(), claim = vi.mocked(f.db.claimWorkflow).getMockImplementation()!
    vi.mocked(f.db.claimWorkflow).mockImplementationOnce(async value => { await claim(value); return held.promise })
    const work = f.workflow.command('final-render', {}); await vi.waitFor(() => expect(f.getPending()?.action).toBe('final-render'))
    expect(f.client.createFinalGeneration).not.toHaveBeenCalled(); held.resolve(true); await work
    expect(f.client.createFinalGeneration).toHaveBeenCalledWith('plan', 'v1', expect.objectContaining({ expected_draft_seq: 1, expected_content_hash: hash, approval_request_id: 'approval', expected_submission_hash: hash, expected_decision_hash: finalBasis.decision_hash, template_id: finalBasis.template.id }), expect.anything())
    expect(f.getPending()).toBeNull()
  })
  it('retries Failed with null profile using its existing G and attempt without creating a new generation', async () => {
    const f = await finalFixture('Failed'); f.current.final_profile = null; f.current.allowed_actions = ['final-retry']; await f.workflow.refresh()
    expect(f.workflow.canAction('final-retry')).toBe(true); await f.workflow.command('final-retry', {})
    expect(f.client.retryFinalGeneration).toHaveBeenCalledWith(finalBasis, { request_id: '00000000-0000-4000-8000-000000000001', expected_attempt: 2 }, expect.anything())
    expect(f.client.createFinalGeneration).not.toHaveBeenCalled(); expect(f.getPending()).toBeNull()
  })
  it('releases Ready with null profile using freshly verified final files', async () => {
    const f = await finalFixture(); f.current.final_profile = null; f.current.allowed_actions = ['release']; await f.workflow.refresh()
    expect(f.workflow.canAction('release')).toBe(true); await f.workflow.command('release', {})
    expect(f.client.releaseWorkflowPlan).toHaveBeenCalledWith('plan', 'v1', expect.objectContaining({ final_generation_id: finalBasis.generation_id, expected_final_pdf_sha256: hash, expected_final_docx_sha256: hash, expected_decision_hash: finalBasis.decision_hash }), expect.anything())
    expect(f.workflow.state.current?.state).toBe('Released'); expect(f.getPending()).toBeNull()
  })
  it.each(['final-render', 'final-retry', 'release'] as const)('UNKNOWN %s remains original across denial and resolves committed after lifecycle/profile/action changes', async action => {
    const f = await finalFixture(action === 'final-retry' ? 'Failed' : 'Ready')
    const dispatch = action === 'final-render' ? vi.mocked(f.client.createFinalGeneration) : action === 'final-retry' ? vi.mocked(f.client.retryFinalGeneration) : vi.mocked(f.client.releaseWorkflowPlan)
    dispatch.mockRejectedValueOnce(new Error('RESULT_UNKNOWN')); await f.workflow.command(action, {})
    const original = f.getPending()!; expect(original.action).toBe(action); expect(dispatch).toHaveBeenCalledTimes(1)
    vi.mocked(f.client.resolveWorkflowReceipt).mockRejectedValueOnce(new Error('403 current role denied')); await f.workflow.resolve(); expect(f.getPending()).toEqual(original)
    f.current.state = 'Superseded'; f.current.is_current = false; f.current.allowed_actions = []; f.current.final_profile = null
    const ack = action === 'release' ? { schema: 'yuantus.welding_plan_workflow_ack/1' as const, request_id: original.body.request_id, action, plan_id: 'plan', item_version_id: 'v1', draft_seq: 1, content_hash: hash, state: 'Released', approval_request_id: 'approval', publication_id: 'publication' } : finalAck(original.body.request_id)
    vi.mocked(f.client.resolveWorkflowReceipt).mockResolvedValue(ack); await f.workflow.resolve()
    expect(f.getPending()).toBeNull(); expect(dispatch).toHaveBeenCalledTimes(1)
  })
  it('a fresh final identity or descriptor change prevents release before claim', async () => {
    const f = await finalFixture(); vi.mocked(f.client.readFinalGeneration).mockResolvedValue({ ...finalRecord(), generation_id: '00000000-0000-4000-8000-000000000011' })
    await f.workflow.command('release', {}); expect(f.db.claimWorkflow).not.toHaveBeenCalled(); expect(f.client.releaseWorkflowPlan).not.toHaveBeenCalled()
  })
  it.each(['final-render', 'final-retry', 'release'] as const)('same-target original and unavailable owner locks block %s before side effects', async action => {
    const f = await finalFixture(action === 'final-retry' ? 'Failed' : 'Ready')
    const original = { schema: 'metasheet.welding_command_pending/1' as const, kind: 'workflow' as const, owner, plan_id: 'plan', item_version_id: 'v1', action: 'final-retry' as const, body: { request_id: 'other-original', expected_attempt: 2 }, basis: finalBasis }
    f.setPending(original); await f.workflow.command(action, {}); expect(f.db.claimWorkflow).not.toHaveBeenCalled(); expect(f.getPending()).toEqual(original)
    f.setPending(null); await f.workflow.refresh(); Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); await f.workflow.command(action, {})
    expect(f.db.claimWorkflow).not.toHaveBeenCalled(); expect(f.client.createFinalGeneration).not.toHaveBeenCalled(); expect(f.client.retryFinalGeneration).not.toHaveBeenCalled(); expect(f.client.releaseWorkflowPlan).not.toHaveBeenCalled()
  })
  it.each(['Released', 'Superseded'] as const)('cold %s publication downloads independently of editor/write/action/profile and preserves UNKNOWN', async state => {
    const f = await finalFixture(); f.current.state = state; f.current.is_current = state === 'Released'; f.current.allowed_actions = []; f.current.final_profile = null; f.current.publication = formal(state)
    f.flags.writable = false; vi.mocked(f.client.recoveryOwner).mockRejectedValue(new Error('editor 503'))
    const original = { schema: 'metasheet.welding_command_pending/1' as const, kind: 'workflow' as const, owner, plan_id: 'plan', item_version_id: 'v1', action: 'final-retry' as const, body: { request_id: 'archived-original', expected_attempt: 2 }, basis: finalBasis }; f.setPending(original)
    await f.workflow.refresh(); const createURL = vi.fn(() => 'blob:formal-' + crypto.randomUUID()), revokeURL = vi.fn(); Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createURL }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeURL }); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await f.workflow.downloadPublication('pdf'); await f.workflow.downloadPublication('docx')
    expect(f.client.downloadPublicationFile).toHaveBeenCalledTimes(2); expect(f.client.recoveryOwner).not.toHaveBeenCalled(); expect(f.getPending()).toEqual(original); expect(createURL).toHaveBeenCalledTimes(2)
    f.workflow.dispose(); expect(revokeURL).toHaveBeenCalledTimes(2)
  })
  it('held publication bytes do not take command ownership or prevent original resolution', async () => {
    const f = await finalFixture(); f.current.state = 'Released'; f.current.allowed_actions = []; f.current.publication = formal()
    const original = { schema: 'metasheet.welding_command_pending/1' as const, kind: 'workflow' as const, owner, plan_id: 'plan', item_version_id: 'v1', action: 'final-retry' as const, body: { request_id: 'held-original', expected_attempt: 2 }, basis: finalBasis }; f.setPending(original); await f.workflow.refresh()
    const held = deferred<Blob>(); vi.mocked(f.client.downloadPublicationFile).mockReturnValueOnce(held.promise)
    const download = f.workflow.downloadPublication('pdf'); await vi.waitFor(() => expect(f.client.downloadPublicationFile).toHaveBeenCalledTimes(1))
    expect(f.workflow.canResolve.value).toBe(true); vi.mocked(f.client.resolveWorkflowReceipt).mockResolvedValue(finalAck(original.body.request_id)); await f.workflow.resolve(); expect(f.getPending()).toBeNull()
    f.flags.active = false; held.resolve(new Blob(['x'])); await download; expect(f.workflow.state.working).toBe(false)
  })
})


describe('C3 explicit revision target and cleanup', () => {
  async function revisionFixture() {
    const f = await make('Released', true)
    f.current.allowed_actions = ['revise']; f.current.publication = formal(); await f.workflow.refresh()
    const revision = (body: any) => ({ schema: 'yuantus.welding_plan_revision_ack/1', request_id: body.request_id, action: 'revise', plan_id: 'plan', source_version_id: 'v1', source_publication_id: 'publication', source_draft_seq: 1, source_content_hash: hash, target_version_id: 'v2', target_version_label: 'B', target_draft_seq: 1, target_content_hash: hash, inheritance_id: 'inheritance', inheritance_sha256: 'b'.repeat(64), state: 'Draft' })
    f.client.reviseWorkflowPlan = vi.fn(async (_p, _v, body) => revision(body)) as any
    const target = { plan_id: 'plan', item_version_id: 'v2', name: 'Plan', number: 'W1', version_label: 'B', state: 'InReview', draft_seq: 2, content_hash: 'c'.repeat(64), payload: { ...clone(payload), preparation_notes: 'actual target' }, sources: {} }
    vi.mocked(f.client.read).mockImplementation(async (_p, v) => v === 'v2' ? target : { ...target, item_version_id: 'v1', version_label: 'A', state: 'Released', draft_seq: 1, content_hash: hash })
    vi.mocked(f.client.recover).mockImplementation(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner, record_id: record.recovery_id, current: target, can_write: false, conflict: false }))
    vi.mocked(f.db.getWorkflow).mockImplementation(async (_o, _p, v) => v === 'v1' ? f.getPending() : null)
    vi.mocked(f.client.readReviewState).mockImplementation(async (_p, v) => v === 'v2' ? { ...clone(f.current), item_version_id: 'v2', state: target.state, draft_seq: target.draft_seq, content_hash: target.content_hash, allowed_actions: [], publication: null } : clone(f.current))
    let targetOriginal: WorkflowPending | null = null
    const sourceClaim = vi.mocked(f.db.claimWorkflow).getMockImplementation()!, sourceClear = vi.mocked(f.db.clearWorkflow).getMockImplementation()!
    vi.mocked(f.db.claimWorkflow).mockImplementation(async original => { if (original.item_version_id !== 'v2') return sourceClaim(original); if (targetOriginal) return equal(targetOriginal, original); targetOriginal = clone(original); return true })
    vi.mocked(f.db.clearWorkflow).mockImplementation(async original => { if (original.item_version_id !== 'v2') return sourceClear(original); if (!equal(targetOriginal, original)) return false; targetOriginal = null; return true })
    vi.mocked(f.db.getWorkflow).mockImplementation(async (_o, _p, v) => v === 'v1' ? f.getPending() : clone(targetOriginal))
    Object.assign(f.planDB, { list: vi.fn(async () => []) })
    return { ...f, target, revision }
  }
  it('keeps the durable original through ACK, real target open and failed cleanup; clears only explicitly', async () => {
    const f = await revisionFixture(); await f.workflow.command('revise', { reason: ' 原因 ' })
    const original = f.getPending(); expect(original?.action).toBe('revise'); expect(f.db.clearWorkflow).not.toHaveBeenCalled(); expect(f.session.state.versionId).toBe('v1')
    expect(f.workflow.state.revisionAck?.target_draft_seq).toBe(1)
    await f.workflow.openRevisionTarget(); await vi.waitFor(() => { expect(f.workflow.state.versionId).toBe('v2'); expect(f.workflow.state.working).toBe(false) })
    expect(f.session.state.versionId).toBe('v2'); expect(f.session.state.draftSeq).toBe(2); expect(f.session.state.payload.preparation_notes).toBe('actual target'); expect(f.getPending()).toEqual(original)
    expect(f.workflow.state.revisionCleanup?.original).toEqual(original); expect(f.workflow.state.pending).toBeNull()
    vi.mocked(f.db.clearWorkflow).mockResolvedValueOnce(false); await f.workflow.cleanupRevision()
    expect(f.getPending()).toEqual(original); expect(f.session.state.versionId).toBe('v2'); expect(f.workflow.state.message).toContain('目标已打开')
    await f.workflow.cleanupRevision(); expect(f.getPending()).toBeNull(); expect(f.client.reviseWorkflowPlan).toHaveBeenCalledTimes(1)
  })
  it.each(['read', 'restore', 'other-pending', 'generation', 'personal-save', 'pending-read', 'apply'])('opening failure %s preserves source and the exact original', async failure => {
    const f = await revisionFixture(); await f.workflow.command('revise', { reason: '原文' }); const original = f.getPending()
    if (failure === 'read') vi.mocked(f.client.read).mockRejectedValue(new Error('target denied'))
    if (failure === 'restore') vi.mocked(f.client.recover).mockRejectedValue(new Error('source denied'))
    if (failure === 'other-pending') vi.mocked(f.db.getWorkflow).mockImplementation(async (_o, _p, v) => v === 'v2' ? { ...original!, item_version_id: 'v2' } : f.getPending())
    if (failure === 'pending-read') vi.mocked(f.db.getWorkflow).mockImplementation(async (_o, _p, v) => { if (v === 'v2') throw new Error('storage failure'); return f.getPending() })
    if (failure === 'generation') f.setGeneration({ schema: 'metasheet.welding_command_pending/1', kind: 'generation', action: 'create', owner, plan_id: 'plan', item_version_id: 'v2', body: {} as any, basis: null })
    if (failure === 'personal-save') Object.assign(f.planDB, { list: async () => [{ draft: { plan_id: 'plan', version_id: 'v2' }, pending: {} }] })
    if (failure === 'apply') vi.spyOn(f.session, 'applyRevisionTarget').mockImplementation(() => { throw new Error('apply refused') })
    await f.workflow.openRevisionTarget()
    expect(f.getPending()).toEqual(original); expect(f.session.state.versionId).toBe('v1'); expect(f.db.clearWorkflow).not.toHaveBeenCalled(); expect(f.workflow.state.revisionCleanup).toBeNull()
  })
  it('C3 different-target generation does not become a cross-target cleanup lock', async () => {
    const f = await revisionFixture(); await f.workflow.command('revise', { reason: '原文' }); const original = f.getPending()
    f.setGeneration({ schema: 'metasheet.welding_command_pending/1', kind: 'generation', action: 'create', owner, plan_id: 'other', item_version_id: 'other-v', body: {} as any, basis: null })
    await f.workflow.openRevisionTarget(); await vi.waitFor(() => expect(f.workflow.state.working).toBe(false))
    expect(f.session.state.versionId).toBe('v2'); expect(f.getPending()).toEqual(original); expect(f.session.state.commandPending).toBe(false)
    f.current.state = 'InReview'; f.current.approval = approval(); f.current.allowed_actions = ['approve']; vi.mocked(f.client.readReviewState).mockImplementation(async (_p, v) => ({ ...clone(f.current), item_version_id: v, draft_seq: f.target.draft_seq, content_hash: f.target.content_hash }))
    await f.workflow.refresh(); expect(f.workflow.canAction('approve')).toBe(true)
    f.client.reviewWorkflowPlan = vi.fn(async (_p, v, body) => { f.target.state = 'Approved'; return validateWorkflowAck({ schema: 'yuantus.welding_plan_workflow_ack/1', request_id: body.request_id, action: 'approve', plan_id: 'plan', item_version_id: v, draft_seq: 2, content_hash: 'c'.repeat(64), state: 'Approved', approval_request_id: 'approval', publication_id: null }, { action: 'review', plan_id: 'plan', item_version_id: v, body }) })
    await f.workflow.command('approve', { opinion: 'target review' }); expect(f.client.reviewWorkflowPlan).toHaveBeenCalledOnce(); expect(f.getPending()).toEqual(original)
  })
  it('C3 identity change aborts held cleanup and retains the original', async () => {
    const f = await revisionFixture(); await f.workflow.command('revise', { reason: '原文' }); await f.workflow.openRevisionTarget(); await vi.waitFor(() => expect(f.workflow.state.working).toBe(false))
    const original = f.getPending(), held = deferred<void>()
    vi.mocked(f.db.clearWorkflow).mockImplementationOnce(async (_value, scope) => { await held.promise; expect(scope?.signal?.aborted).toBe(true); throw new Error('cleanup aborted') })
    const job = f.workflow.cleanupRevision(); await vi.waitFor(() => expect(f.db.clearWorkflow).toHaveBeenCalledOnce()); notifyAuthPrincipalChange(); held.resolve(); await job
    expect(f.getPending()).toEqual(original); expect(f.workflow.state.revisionCleanup).toBeNull()
  })
  it('C3 old cleanup finally cannot unlock a newer target refresh', async () => {
    const f = await revisionFixture(); await f.workflow.command('revise', { reason: '原文' }); await f.workflow.openRevisionTarget(); await vi.waitFor(() => expect(f.workflow.state.working).toBe(false))
    const old = deferred<WorkflowPending | null>(), fresh = deferred<WorkflowState>(), original = f.getPending()
    vi.mocked(f.db.getWorkflow).mockReturnValueOnce(old.promise); const cleanup = f.workflow.cleanupRevision(); await vi.waitFor(() => expect(f.workflow.state.working).toBe(true))
    vi.mocked(f.client.readReviewState).mockReturnValueOnce(fresh.promise); const next = f.workflow.setTarget('other', 'v9'); await vi.waitFor(() => expect(f.workflow.state.planId).toBe('other'))
    old.resolve(original); await cleanup; expect(f.workflow.state.working).toBe(true); expect(f.getPending()).toEqual(original)
    fresh.resolve({ ...clone(f.current), plan_id: 'other', item_version_id: 'v9' }); await next; expect(f.workflow.state.working).toBe(false)
  })
  it('C3 a nonintentional cleared editor selection hides cleanup context and preserves the source original', async () => {
    const f = await revisionFixture(); await f.workflow.command('revise', { reason: '原文' }); await f.workflow.openRevisionTarget(); await vi.waitFor(() => expect(f.workflow.state.working).toBe(false))
    const original = f.getPending(); f.session.resetEntry(); await vi.waitFor(() => expect(f.workflow.state.revisionCleanup).toBeNull())
    expect(f.getPending()).toEqual(original); expect(f.db.clearWorkflow).not.toHaveBeenCalled()
  })
  it('read-only committed resolve stays durable and never opens automatically', async () => {
    const f = await revisionFixture(); vi.mocked(f.client.reviseWorkflowPlan).mockRejectedValue(new Error('lost'))
    await f.workflow.command('revise', { reason: '原文' }); const original = f.getPending()!; f.flags.writable = false
    vi.mocked(f.client.resolveWorkflowReceipt).mockResolvedValue(f.revision(original.body) as any)
    await f.workflow.resolve(); expect(f.getPending()).toEqual(original); expect(f.session.state.versionId).toBe('v1'); expect(f.workflow.state.revisionAck).not.toBeNull(); expect(f.db.clearWorkflow).not.toHaveBeenCalled()
  })
  it('late target response after auth ABA cannot apply or clear', async () => {
    const f = await revisionFixture(); await f.workflow.command('revise', { reason: '原文' }); const original = f.getPending(), held = deferred<any>()
    vi.mocked(f.client.read).mockReturnValueOnce(held.promise); const job = f.workflow.openRevisionTarget(); await vi.waitFor(() => expect(f.client.read).toHaveBeenCalledTimes(2))
    notifyAuthPrincipalChange(); held.resolve(f.target); await job
    expect(f.getPending()).toEqual(original); expect(f.session.state.versionId).not.toBe('v2'); expect(f.db.clearWorkflow).not.toHaveBeenCalled(); expect(f.workflow.state.revisionCleanup).toBeNull()
  })
})


describe('C3 independent official reader', () => {
  const archive = (version: string): Publication => ({ ...formal(), publication_id: `pub-${version}`, item_version_id: version, version_label: version, state: version === 'v51' ? 'Released' : 'Superseded' })
  const entry = (version: string) => { const p = archive(version); return { publication_id: p.publication_id, item_version_id: p.item_version_id, version_label: p.version_label, state: p.state, published_at: p.published_at, content_hash: p.content_hash } }
  async function officialFixture() {
    const f = await make(); f.flags.writable = false
    vi.mocked(f.client.readReviewState).mockRejectedValue(new Error('editor and review unavailable'))
    f.client.readPublication = vi.fn(async (_p, version) => archive(version))
    f.client.readPublications = vi.fn(async (_p, offset = 0) => ({ schema: 'yuantus.welding_publication_directory/1', plan_id: 'plan', total: 51, limit: 20, offset, items: Array.from({ length: 51 }, (_, i) => entry(`v${51 - i}`)).slice(offset, offset + 20), current_publication: entry('v51') }))
    f.client.comparePublications = vi.fn(async (_p, from, to) => ({ schema: 'yuantus.welding_publication_comparison/1', plan_id: 'plan', from: { item_version_id: from, version_label: from, publication_id: `pub-${from}`, content_hash: hash }, to: { item_version_id: to, version_label: to, publication_id: `pub-${to}`, content_hash: hash }, summary: { added: 0, removed: 0, changed: 1, unchanged: 0 }, welds: [{ weld_id: 'w1', kind: 'changed', changed_fields: ['parameters', 'geometry'] }], plan_changes: ['drawing'] }))
    f.client.downloadPublicationFile = vi.fn(async (_p, format) => new Blob([format], { type: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }))
    await f.workflow.setFormalTarget('plan', 'v1'); return f
  }
  it.each(['auth', 'different-target', 'same-target-ABA', 'dispose'])('C3 independent-audit late initial publication after %s cannot republish hidden content', async change => {
    const f = await officialFixture(), held = deferred<Publication>(), calls = vi.mocked(f.client.readPublication).mock.calls.length
    vi.mocked(f.client.readPublication).mockReturnValueOnce(held.promise)
    const job = f.workflow.setFormalTarget('plan', 'cold-v'); await vi.waitFor(() => expect(f.client.readPublication).toHaveBeenCalledTimes(calls + 1))
    if (change === 'auth') notifyAuthPrincipalChange()
    if (change === 'different-target' || change === 'same-target-ABA') await f.workflow.setFormalTarget('plan', 'v2')
    if (change === 'same-target-ABA') await f.workflow.setFormalTarget('plan', 'cold-v')
    if (change === 'dispose') f.workflow.dispose()
    held.resolve({ ...archive('cold-v'), publication_id: 'stale-pub' }); await job
    if (change === 'auth' || change === 'dispose') expect(f.workflow.formal.selected).toBeNull()
    else expect(f.workflow.formal.selected?.publication_id).toBe(change === 'different-target' ? 'pub-v2' : 'pub-cold-v')
  })
  it('C3 independent-audit stages initial publication until fresh final authority succeeds', async () => {
    const f = await officialFixture(), held = deferred<typeof owner>(), originalAuthority = vi.mocked(f.client.authority).getMockImplementation()!, calls = vi.mocked(f.client.authority).mock.calls.length
    vi.mocked(f.client.authority).mockImplementationOnce(originalAuthority).mockReturnValueOnce(held.promise)
    const job = f.workflow.setFormalTarget('plan', 'cold-v'); await vi.waitFor(() => expect(f.client.authority).toHaveBeenCalledTimes(calls + 2))
    expect(f.workflow.formal.selected).toBeNull(); expect(f.workflow.formal.directory).toBeNull()
    held.resolve(owner); await job; expect(f.workflow.formal.selected?.publication_id).toBe('pub-cold-v')
  })
  it('C3 a draft target with publication404 still reads authorized historical directory, with no guessed current', async () => {
    const f = await officialFixture(); vi.mocked(f.client.readPublication).mockRejectedValue(new WeldingPlanError('no visible publication', 404))
    vi.mocked(f.client.readPublications).mockResolvedValue({ schema: 'yuantus.welding_publication_directory/1', plan_id: 'plan', total: 1, limit: 20, offset: 0, items: [entry('v1')], current_publication: null })
    await f.workflow.setFormalTarget('plan', 'draft-target')
    expect(f.workflow.formal.directory?.items).toHaveLength(1); expect(f.workflow.formal.directory?.current_publication).toBeNull(); expect(f.workflow.formal.selected).toBeNull(); expect(f.workflow.formal.message).toContain('没有可见正式文件')
  })
  it('pages 51 visible records, keeps chosen historical sides, and compares both directions without editor recovery', async () => {
    const f = await officialFixture(); expect(f.workflow.formal.selected?.item_version_id).toBe('v1')
    await f.workflow.selectFormal(entry('v2'), 'from'); await f.workflow.selectFormal(entry('v3'), 'to')
    for (const offset of [20, 40]) { await f.workflow.refreshFormal(offset); expect(f.workflow.formal.directory?.offset).toBe(offset); expect(f.workflow.formal.from?.item_version_id).toBe('v2'); expect(f.workflow.formal.selected?.item_version_id).toBe('v1') }
    expect(f.workflow.formal.directory?.items).toHaveLength(11); expect(f.workflow.formal.directory?.current_publication?.item_version_id).toBe('v51')
    await f.workflow.compareFormal(); expect(f.workflow.formal.comparison?.welds[0].changed_fields).toEqual(['parameters', 'geometry'])
    await f.workflow.selectFormal(entry('v3'), 'from'); await f.workflow.selectFormal(entry('v2'), 'to'); await f.workflow.compareFormal(); expect(f.client.comparePublications).toHaveBeenLastCalledWith('plan', 'v3', 'v2', expect.anything())
    expect(f.client.recoveryOwner).not.toHaveBeenCalled(); expect(f.client.read).not.toHaveBeenCalled(); expect(f.client.recover).not.toHaveBeenCalled()
    vi.mocked(f.client.comparePublications).mockRejectedValueOnce(new Error('403 hidden side')); await f.workflow.compareFormal(); expect(f.workflow.formal.comparison).toBeNull(); expect(f.workflow.formal.from).toBeNull(); expect(f.workflow.formal.to).toBeNull()
  })
  it('offers both sides PDF and DOCX only after fresh archives and authority, and releases all object URLs', async () => {
    const f = await officialFixture(); await f.workflow.selectFormal(entry('v2'), 'from'); await f.workflow.selectFormal(entry('v3'), 'to')
    const create = vi.fn(() => 'blob:formal'), revoke = vi.fn(); Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create }); Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke }); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    for (const side of ['from', 'to'] as const) for (const format of ['pdf', 'docx'] as const) await f.workflow.downloadFormal(format, side)
    expect(f.client.downloadPublicationFile).toHaveBeenCalledTimes(4); expect(create).toHaveBeenCalledTimes(4)
    f.workflow.dispose(); expect(revoke).toHaveBeenCalled()
  })
  it('C3 changing official selection invalidates an in-flight download without leaving a stuck download gate', async () => {
    const f = await officialFixture(), held = deferred<Blob>(), create = vi.fn(() => 'blob:stale')
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create })
    vi.mocked(f.client.downloadPublicationFile).mockReturnValueOnce(held.promise)
    const job = f.workflow.downloadFormal('pdf'); await vi.waitFor(() => expect(f.client.downloadPublicationFile).toHaveBeenCalledOnce())
    await f.workflow.selectFormal(entry('v2'), 'selected'); expect(f.workflow.formal.downloading).toBe(false)
    held.resolve(new Blob(['old'])); await job; expect(create).not.toHaveBeenCalled(); expect(f.workflow.formal.selected?.item_version_id).toBe('v2')
  })
  it('late official directory response after auth notification cannot disclose old archives', async () => {
    const f = await officialFixture(), held = deferred<any>(); vi.mocked(f.client.readPublications).mockReturnValueOnce(held.promise)
    const job = f.workflow.refreshFormal(20); await vi.waitFor(() => expect(f.client.readPublications).toHaveBeenCalledTimes(2)); notifyAuthPrincipalChange()
    held.resolve({ schema: 'yuantus.welding_publication_directory/1', plan_id: 'plan', total: 0, limit: 20, offset: 20, items: [], current_publication: null }); await job
    expect(f.workflow.formal.selected).toBeNull(); expect(f.workflow.formal.directory).toBeNull(); expect(f.workflow.formal.comparison).toBeNull()
  })
})

describe('F18b P2 explicit reuse target selection', () => {
  const products = [{ item_id: 'other', version_id: 'p2', name: 'Other', number: 'P2', version_label: 'A' }, { item_id: 'third', version_id: 'p3', name: 'Third', number: 'P3', version_label: 'B' }]
  const bom = { baseline_id: 'selected-bom', fingerprint: hash, name: 'Assembly', number: 'B1' }
  async function selectionFixture() {
    const f = await make('Released', true), approved = approval()
    Object.assign(approved, { state: 'approved', decision: { decision_hash: finalBasis.decision_hash, decision: { decision: 'approve', opinion: '', reviewer, decided_at: '2026-10-09T00:00:00Z' } } })
    approved.submission.included_weld_ids = ['w1'] as never[]
    Object.assign(f.current, { allowed_actions: [], publication: formal(), approval: approved })
    const client = Object.assign(f.client, {
      reuseProductCandidates: vi.fn(async () => clone(products)),
      reuseProductContext: vi.fn(async (pair: { item_id: string; version_id: string }) => clone(products.find(p => p.item_id === pair.item_id && p.version_id === pair.version_id)!)),
      reuseBomCandidates: vi.fn(async () => [clone(bom)]),
    })
    client.productCandidates = vi.fn(async () => { throw new WeldingPlanError('ordinary update required', 404) })
    client.productContext = vi.fn(async () => { throw new WeldingPlanError('ordinary update required', 404) })
    client.bomCandidates = vi.fn(async () => { throw new WeldingPlanError('ordinary update required', 404) })
    client.drawingCandidates = vi.fn(async () => [{ item_id: 'drawing', version_id: 'd2', file_id: 'f2', file_role: 'drawing', checksum: hash, name: 'Drawing', number: 'D2', version_label: 'A' }])
    client.reusePlan = vi.fn(async (_p, _v, body) => {
      expect(f.getPending()?.body).toEqual(body)
      return { schema: 'yuantus.welding_plan_reuse_ack/1' as const, action: 'reuse' as const, request_id: body.request_id, reuse_id: 'reuse', source_plan_id: 'plan', source_version_id: 'v1', source_publication_id: 'publication', source_draft_seq: 1, source_content_hash: hash, target_plan_id: body.target_plan_id, target_version_id: 'target-v1', target_version_label: 'A', target_draft_seq: 1 as const, target_content_hash: 'b'.repeat(64), state: 'Draft' as const, reuse_provenance_sha256: 'c'.repeat(64) }
    })
    await f.workflow.refresh()
    // Accepted new action and local optional-read status are absent on the RED product.
    const workflow = f.workflow as typeof f.workflow & { loadReuseBoms(): Promise<void> }
    const reuse = workflow.reuse as typeof workflow.reuse & { bomWorking: boolean; bomMessage: string }
    return { ...f, client, workflow, reuse }
  }
  async function confirm(f: Awaited<ReturnType<typeof selectionFixture>>) {
    await f.workflow.searchReuseProducts('other')
    expect(f.workflow.reuse.products).toEqual(products)
    await f.workflow.selectReuseProduct(f.workflow.reuse.products[0])
    expect(f.workflow.reuse.product).toEqual({ item_id: 'other', version_id: 'p2' })
    expect(f.client.reuseBomCandidates).not.toHaveBeenCalled()
    await f.workflow.searchReuseDrawings('drawing'); f.workflow.selectReuseDrawing(f.workflow.reuse.drawings[0])
    Object.assign(f.workflow.reuse, { name: 'Independent', number: 'R1', reason: 'explicit reuse', selectedWeldIds: ['w1'] })
    expect(f.workflow.canCreateReuse.value).toBe(true)
  }
  it('confirms with reuse-only reads and creates no-BOM once from a durable exact original without editing source', async () => {
    const f = await selectionFixture(), source = clone(f.session.state.payload)
    await confirm(f)
    expect(f.client.reuseProductCandidates).toHaveBeenCalledWith('other', expect.anything())
    expect(f.client.reuseProductContext).toHaveBeenCalledWith(expect.objectContaining({ item_id: 'other', version_id: 'p2' }), expect.anything())
    expect(f.client.productCandidates).not.toHaveBeenCalled(); expect(f.client.productContext).not.toHaveBeenCalled(); expect(f.client.bomCandidates).not.toHaveBeenCalled()
    expect(f.workflow.reuse.boms).toEqual([]); expect(f.workflow.reuse.bom).toBeNull()
    await f.workflow.createReuse()
    expect(f.client.reusePlan).toHaveBeenCalledTimes(1)
    expect(f.getPending()).toMatchObject({ owner, action: 'reuse', plan_id: 'plan', item_version_id: 'v1', body: { product: { item_id: 'other', version_id: 'p2' }, bom: null, source_publication_id: 'publication', expected_draft_seq: 1, expected_content_hash: hash, selected_weld_ids: ['w1'] } })
    expect(f.session.state.payload).toEqual(source); expect(f.session.state.planId).toBe('plan')
    expect(f.db.clearWorkflow).not.toHaveBeenCalled()
  })
  it('loads optional BOM only explicitly, clears a prior choice on reload and preserves only ID/hash in original', async () => {
    const f = await selectionFixture(); await confirm(f)
    await f.workflow.loadReuseBoms()
    expect(f.client.reuseBomCandidates).toHaveBeenCalledWith({ item_id: 'other', version_id: 'p2' }, expect.anything())
    expect(f.workflow.reuse.boms).toEqual([bom]); f.workflow.selectReuseBom(f.workflow.reuse.boms[0])
    expect(f.workflow.reuse.bom).toEqual({ baseline_id: bom.baseline_id, expected_fingerprint: hash })
    const held = deferred<typeof bom[]>(); f.client.reuseBomCandidates.mockReturnValueOnce(held.promise)
    const loading = f.workflow.loadReuseBoms()
    await vi.waitFor(() => expect(f.client.reuseBomCandidates).toHaveBeenCalledTimes(2))
    expect(f.workflow.reuse.boms).toEqual([]); expect(f.workflow.reuse.bom).toBeNull()
    held.resolve([bom]); await loading
    expect(f.workflow.reuse.bom).toBeNull(); f.workflow.selectReuseBom(f.workflow.reuse.boms[0])
    await f.workflow.createReuse()
    expect(f.getPending()?.body).toMatchObject({ bom: { baseline_id: bom.baseline_id, expected_fingerprint: hash } })
    expect(f.client.reusePlan).toHaveBeenCalledTimes(1); expect(f.db.clearWorkflow).not.toHaveBeenCalled()
  })
  it.each([403, 404])('optional BOM %s keeps confirmed product, source evidence and deliberate no-BOM creation', async status => {
    const f = await selectionFixture(); await confirm(f); await f.workflow.loadReuseBoms(); f.workflow.selectReuseBom(f.workflow.reuse.boms[0])
    const source = clone(f.session.state.payload), current = clone(f.workflow.state.current)
    f.client.reuseBomCandidates.mockRejectedValueOnce(new WeldingPlanError('optional BOM unavailable', status))
    await f.workflow.loadReuseBoms()
    expect(f.workflow.reuse.product).toEqual({ item_id: 'other', version_id: 'p2' })
    expect(f.workflow.reuse.boms).toEqual([]); expect(f.workflow.reuse.bom).toBeNull()
    expect(f.workflow.state.current).toEqual(current); expect(f.session.state.payload).toEqual(source)
    expect(f.reuse.bomMessage).toBeTruthy(); expect(f.reuse.bomWorking).toBe(false)
    expect(f.workflow.canCreateReuse.value).toBe(true); await f.workflow.createReuse()
    expect(f.getPending()?.body).toMatchObject({ bom: null }); expect(f.client.reusePlan).toHaveBeenCalledTimes(1)
  })
  it.each(['product-ABA', 'auth-ABA', 'source-ABA', 'owner', 'publication'])('does not expose a late optional BOM after %s', async change => {
    const f = await selectionFixture(); await confirm(f); await f.workflow.loadReuseBoms()
    expect(f.workflow.reuse.boms).toEqual([bom])
    const source = clone(f.session.state.payload), held = deferred<typeof bom[]>()
    f.client.reuseBomCandidates.mockReturnValueOnce(held.promise)
    const loading = f.workflow.loadReuseBoms()
    await vi.waitFor(() => expect(f.client.reuseBomCandidates).toHaveBeenCalledTimes(2))
    if (change === 'product-ABA') { await f.workflow.selectReuseProduct(products[1]); expect(f.workflow.reuse.product?.item_id).toBe('third'); await f.workflow.selectReuseProduct(products[0]); expect(f.workflow.reuse.product?.item_id).toBe('other') }
    if (change === 'auth-ABA') { localStorage.setItem('auth_token', 'native-B'); notifyAuthPrincipalChange(); localStorage.setItem('auth_token', 'native-A'); notifyAuthPrincipalChange() }
    if (change === 'source-ABA') { await f.workflow.setTarget('', ''); await f.workflow.setTarget('plan', 'v1') }
    if (change === 'owner') vi.mocked(f.client.authority).mockResolvedValue({ ...owner, org_id: 'other-org' })
    if (change === 'publication') f.workflow.state.current!.publication!.publication_id = 'changed-publication'
    held.resolve([{ ...bom, baseline_id: 'stale-bom' }]); await loading
    expect(f.workflow.reuse.boms).toEqual([]); expect(f.workflow.reuse.bom).toBeNull()
    if (change === 'auth-ABA') expect(f.session.state.payload.product).toBeNull()
    else expect(f.session.state.payload).toEqual(source)
    expect(f.client.reusePlan).not.toHaveBeenCalled(); expect(f.db.claimWorkflow).not.toHaveBeenCalled()
    if (change === 'product-ABA') expect(f.workflow.reuse.product).toEqual({ item_id: 'other', version_id: 'p2' })
    if (change === 'auth-ABA' || change === 'owner') expect(f.workflow.state.current).toBeNull()
  })
})

describe('F18b P2 source-selection and mandatory-authority race guards', () => {
  const product = { item_id: 'other', version_id: 'p2', name: 'Other', number: 'P2', version_label: 'A' }
  const bom = { baseline_id: 'selected-bom', fingerprint: hash, name: 'Assembly', number: 'B1' }
  async function raceFixture() {
    const f = await make('Released', true), approved = approval(), publication = formal()
    Object.assign(approved, { state: 'approved', decision: { decision_hash: finalBasis.decision_hash, decision: { decision: 'approve', opinion: '', reviewer, decided_at: '2026-10-09T00:00:00Z' } } })
    approved.submission.included_weld_ids = ['w1'] as never[]
    Object.assign(f.current, { allowed_actions: [], publication, approval: approved })
    const client = Object.assign(f.client, {
      reuseProductCandidates: vi.fn(async () => [clone(product)]),
      reuseProductContext: vi.fn(async () => clone(product)),
      reuseBomCandidates: vi.fn(async () => [clone(bom)]),
    })
    client.productCandidates = vi.fn(async () => { throw new WeldingPlanError('ordinary update required', 404) })
    client.productContext = vi.fn(async () => { throw new WeldingPlanError('ordinary update required', 404) })
    client.bomCandidates = vi.fn(async () => { throw new WeldingPlanError('ordinary update required', 404) })
    client.drawingCandidates = vi.fn(async () => [{ item_id: 'drawing', version_id: 'd2', file_id: 'f2', file_role: 'drawing' as const, checksum: hash, name: 'Drawing', number: 'D2', version_label: 'A' }])
    client.reusePlan = vi.fn(async () => { throw new Error('unexpected reuse POST') })
    const entry = { publication_id: publication.publication_id, item_version_id: publication.item_version_id, version_label: publication.version_label, state: publication.state, content_hash: publication.content_hash, published_at: publication.published_at }
    client.readPublication = vi.fn(async () => clone(publication))
    client.readPublications = vi.fn(async () => ({ schema: 'yuantus.welding_publication_directory/1' as const, plan_id: 'plan', total: 1, limit: 20, offset: 0, items: [clone(entry)], current_publication: clone(entry) }))
    await f.workflow.refresh(); await f.workflow.setFormalTarget('plan', 'v1')
    await f.workflow.searchReuseProducts('other'); await f.workflow.selectReuseProduct(f.workflow.reuse.products[0])
    expect(f.workflow.reuse.product).toEqual({ item_id: 'other', version_id: 'p2' })
    await f.workflow.searchReuseDrawings('drawing'); f.workflow.selectReuseDrawing(f.workflow.reuse.drawings[0])
    Object.assign(f.workflow.reuse, { name: 'Independent', number: 'R1', reason: 'explicit reuse', selectedWeldIds: ['w1'] })
    const workflow = f.workflow as typeof f.workflow & { loadReuseBoms(): Promise<void> }
    const reuse = workflow.reuse as typeof workflow.reuse & { bomWorking: boolean; bomMessage: string }
    expect(workflow.canCreateReuse.value).toBe(true)
    await workflow.loadReuseBoms(); expect(reuse.boms).toEqual([bom]); workflow.selectReuseBom(reuse.boms[0])
    return { ...f, client, workflow, reuse }
  }
  it('drops held product confirmation after the actual editor reset without erasing the workflow source', async () => {
    const f = await raceFixture(), displayed = clone(f.workflow.state.current), held = deferred<typeof product>()
    const calls = f.client.reuseProductContext.mock.calls.length
    f.client.reuseProductContext.mockReturnValueOnce(held.promise)
    const selecting = f.workflow.selectReuseProduct(product)
    await vi.waitFor(() => expect(f.client.reuseProductContext).toHaveBeenCalledTimes(calls + 1))
    f.session.resetEntry()
    expect(f.session.state.savedPoint).toBeNull()
    held.resolve(clone(product)); await selecting
    expect(f.workflow.reuse.product).toBeNull(); expect(f.workflow.reuse.boms).toEqual([]); expect(f.workflow.reuse.bom).toBeNull()
    expect(f.workflow.state.current).toEqual(displayed); expect(f.workflow.state.working).toBe(false)
    expect(f.workflow.canCreateReuse.value).toBe(false)
    await f.workflow.createReuse()
    expect(f.client.reusePlan).not.toHaveBeenCalled(); expect(f.db.claimWorkflow).not.toHaveBeenCalled()
  })
  it.each(['publication', 'pending'])('drops held product confirmation after %s changes without clearing that newer evidence', async change => {
    const f = await raceFixture(), source = clone(f.session.state.payload), held = deferred<typeof product>()
    const calls = f.client.reuseProductContext.mock.calls.length
    f.client.reuseProductContext.mockReturnValueOnce(held.promise)
    const selecting = f.workflow.selectReuseProduct(product)
    await vi.waitFor(() => expect(f.client.reuseProductContext).toHaveBeenCalledTimes(calls + 1))
    if (change === 'publication') f.workflow.state.current!.publication!.publication_id = 'new-publication'
    else {
      const pending: WorkflowPending = { schema: 'metasheet.welding_command_pending/1', kind: 'workflow', owner: clone(owner), action: 'revise', plan_id: 'plan', item_version_id: 'v1', body: { request_id: 'existing-request', source_publication_id: 'publication', expected_draft_seq: 1, expected_content_hash: hash, reason: 'existing revision' } }
      f.setPending(pending); window.dispatchEvent(new Event('focus'))
      await vi.waitFor(() => expect(f.workflow.state.pending).toEqual(pending))
    }
    const current = clone(f.workflow.state.current)
    held.resolve(clone(product)); await selecting
    expect(f.workflow.reuse.product).toBeNull(); expect(f.workflow.state.current).toEqual(current)
    expect(f.workflow.state.working).toBe(false); expect(f.session.state.payload).toEqual(source)
    if (change === 'pending') expect(f.workflow.state.pending).toEqual(f.getPending())
    expect(f.workflow.canCreateReuse.value).toBe(false)
    expect(f.client.reusePlan).not.toHaveBeenCalled(); expect(f.db.claimWorkflow).not.toHaveBeenCalled()
  })
  it('does not revive a held BOM after selected welds change and return to the same choice', async () => {
    const f = await raceFixture(), source = clone(f.session.state.payload), current = clone(f.workflow.state.current), held = deferred<typeof bom[]>()
    const calls = f.client.reuseBomCandidates.mock.calls.length
    f.client.reuseBomCandidates.mockReturnValueOnce(held.promise)
    const loading = f.workflow.loadReuseBoms()
    await vi.waitFor(() => expect(f.client.reuseBomCandidates).toHaveBeenCalledTimes(calls + 1))
    expect(f.reuse.boms).toEqual([]); expect(f.reuse.bom).toBeNull()
    f.reuse.selectedWeldIds = []; f.reuse.selectedWeldIds = ['w1']
    held.resolve([{ ...bom, baseline_id: 'late-bom' }]); await loading
    expect(f.reuse.boms).toEqual([]); expect(f.reuse.bom).toBeNull(); expect(f.reuse.bomWorking).toBe(false)
    expect(f.reuse.product).toEqual({ item_id: 'other', version_id: 'p2' }); expect(f.workflow.canCreateReuse.value).toBe(true)
    expect(f.workflow.state.current).toEqual(current); expect(f.session.state.payload).toEqual(source)
    expect(f.client.reusePlan).not.toHaveBeenCalled(); expect(f.db.claimWorkflow).not.toHaveBeenCalled()
  })
  it('does not revive a held BOM after actual same-target recovery loses and rereads an equal saved point', async () => {
    const f = await raceFixture(), point = clone(f.session.state.savedPoint!), editSeq = f.session.state.editSeq
    const record = { schema: 'yuantus.welding_plan_recovery/1' as const, recovery_id: id, updated_at: Date.now(), owner: clone(owner), draft: { plan_id: point.plan_id, version_id: point.item_version_id, base_draft_seq: point.draft_seq, base_content_hash: point.content_hash, name: point.name, number: point.number, payload: clone(point.payload) }, pending: null }
    Object.assign(f.planDB, { get: vi.fn(async () => clone(record)) })
    await f.session.previewRecovery(record); expect(f.session.state.preview?.record).toEqual(record)
    const held = deferred<typeof bom[]>(), calls = f.client.reuseBomCandidates.mock.calls.length
    f.client.reuseBomCandidates.mockReturnValueOnce(held.promise)
    const loading = f.workflow.loadReuseBoms()
    await vi.waitFor(() => expect(f.client.reuseBomCandidates).toHaveBeenCalledTimes(calls + 1))
    await f.session.restoreRecovery()
    expect(f.session.state.savedPoint).toBeNull(); expect(f.session.state.editSeq).toBeGreaterThan(editSeq)
    await f.session.open('plan', 'v1')
    expect(f.session.state.savedPoint).toEqual(point); expect(f.session.state.editSeq).toBe(editSeq)
    expect(f.workflow.state.planId).toBe('plan'); expect(f.workflow.state.versionId).toBe('v1')
    held.resolve([{ ...bom, baseline_id: 'late-bom' }]); await loading
    expect(f.reuse.boms).toEqual([]); expect(f.reuse.bom).toBeNull(); expect(f.reuse.bomWorking).toBe(false)
    expect(f.reuse.product).toEqual({ item_id: 'other', version_id: 'p2' }); expect(f.workflow.canCreateReuse.value).toBe(true)
    expect(f.session.state.payload).toEqual(point.payload)
    expect(f.client.reusePlan).not.toHaveBeenCalled(); expect(f.db.claimWorkflow).not.toHaveBeenCalled()
  })
  it.each([403, 503])('hides reuse and formal targets when final mandatory authority returns %s rather than an optional BOM error', async status => {
    const f = await raceFixture(), source = clone(f.session.state.payload), held = deferred<typeof bom[]>()
    expect(f.workflow.formal.selected).not.toBeNull(); expect(f.workflow.formal.directory).not.toBeNull()
    const calls = f.client.reuseBomCandidates.mock.calls.length
    f.client.reuseBomCandidates.mockReturnValueOnce(held.promise)
    const loading = f.workflow.loadReuseBoms()
    await vi.waitFor(() => expect(f.client.reuseBomCandidates).toHaveBeenCalledTimes(calls + 1))
    vi.mocked(f.client.authority).mockRejectedValueOnce(new WeldingPlanError('mandatory authority unavailable', status))
    held.resolve([clone(bom)]); await loading
    expect(f.workflow.state.current).toBeNull(); expect(f.workflow.state.owner).toBeNull()
    expect(f.workflow.formal.selected).toBeNull(); expect(f.workflow.formal.directory).toBeNull(); expect(f.workflow.formal.owner).toBeNull()
    expect(f.reuse.product).toBeNull(); expect(f.reuse.boms).toEqual([]); expect(f.reuse.bom).toBeNull()
    expect(f.reuse.bomWorking).toBe(false); expect(f.workflow.canCreateReuse.value).toBe(false)
    expect(f.workflow.state.message).toBeTruthy(); expect(f.session.state.payload).toEqual(source)
    await f.workflow.createReuse()
    expect(f.client.reusePlan).not.toHaveBeenCalled(); expect(f.db.claimWorkflow).not.toHaveBeenCalled()
  })
})

describe('CAD focus refresh admission', () => {
  it('keeps editing available after an admitted CAD module failure with no workflow original', async () => {
    const f = await make('Draft', true), before = clone(f.session.state.payload)
    const action = vi.fn(async () => { throw new Error('measurement module unavailable') })
    await expect(f.session.withTargetMutation(action)).rejects.toThrow('measurement module unavailable')
    expect(action).toHaveBeenCalledOnce(); expect(f.getPending()).toBeNull()
    expect(f.session.state.payload).toEqual(before); expect(f.session.state.commandPending).toBe(false)
    expect(f.session.canEdit.value).toBe(true)
    const next = vi.fn(async () => {})
    await f.session.withTargetMutation(next); expect(next).toHaveBeenCalledOnce()
  })
  it.each(['storage', 'authority', 'state'])('still blocks an action after workflow admission %s failure', async failure => {
    const f = await make('Draft', true), action = vi.fn(async () => {})
    if (failure === 'storage') vi.mocked(f.db.getWorkflow).mockRejectedValue(new Error('storage unavailable'))
    if (failure === 'authority') vi.mocked(f.client.authority).mockRejectedValue(new WeldingPlanError('authority unavailable', 503))
    if (failure === 'state') vi.mocked(f.client.readReviewState).mockRejectedValue(new Error('state unavailable'))
    await expect(f.session.withTargetMutation(action)).rejects.toThrow()
    expect(action).not.toHaveBeenCalled(); expect(f.session.state.commandPending).toBe(true)
    expect(f.session.canEdit.value).toBe(false); expect(f.db.clearWorkflow).not.toHaveBeenCalled()
  })
  it('preserves a gate explicitly raised by the admitted action on an unknown request', async () => {
    const f = await make('Draft', true)
    const original: WorkflowPending = { schema: 'metasheet.welding_command_pending/1', kind: 'workflow', action: 'revise', owner: clone(owner), plan_id: 'plan', item_version_id: 'v1', body: { request_id: 'unknown-action', source_publication_id: 'publication', expected_draft_seq: 1, expected_content_hash: hash, reason: 'retain original' } }
    await expect(f.session.withTargetMutation(async scope => {
      f.setPending(original); f.session.setWorkflowPending(scope, true)
      throw new Error('result unknown')
    })).rejects.toThrow('result unknown')
    expect(f.getPending()).toEqual(original); expect(f.session.state.commandPending).toBe(true)
    expect(f.session.canEdit.value).toBe(false); expect(f.db.clearWorkflow).not.toHaveBeenCalled()
  })

  it('keeps the initiating click enabled while a clean focus read is held', async () => {
    const f = await make('Draft', true), held = deferred<WorkflowPending | null>()
    vi.mocked(f.db.getWorkflow).mockReturnValueOnce(held.promise)
    window.dispatchEvent(new Event('focus'))
    expect(f.session.canEdit.value).toBe(true)
    let left = false
    const leaving = f.session.prepareLeave().then(value => { left = true; return value })
    await new Promise(resolve => setTimeout(resolve, 0)); expect(left).toBe(false)
    held.resolve(null); expect(await leaving).toBe(true)
    const action = vi.fn(async () => {})
    await f.session.withTargetMutation(action); expect(action).toHaveBeenCalledOnce()
  })
  it.each(['leave', 'new', 'open'])('waits for a hidden original before %s and preserves its exact body', async target => {
    const f = await make('Draft', true), held = deferred<WorkflowPending | null>()
    const original: WorkflowPending = { schema: 'metasheet.welding_command_pending/1', kind: 'workflow', action: 'revise', owner: clone(owner), plan_id: 'plan', item_version_id: 'v1', body: { request_id: 'external-request', source_publication_id: 'publication', expected_draft_seq: 1, expected_content_hash: hash, reason: 'existing original' } }
    f.setPending(original); vi.mocked(f.db.getWorkflow).mockReturnValueOnce(held.promise)
    window.dispatchEvent(new Event('focus'))
    expect(f.session.canEdit.value).toBe(true)
    let done = false
    const moving = (target === 'leave' ? f.session.prepareLeave() : target === 'new' ? f.session.newDraft() : f.session.open('other', 'v2')).then(value => { done = true; return value })
    await new Promise(resolve => setTimeout(resolve, 0)); expect(done).toBe(false)
    held.resolve(clone(original)); const result = await moving
    if (target === 'leave') expect(result).toBe(false)
    expect(f.session.state.planId).toBe('plan'); expect(f.session.state.versionId).toBe('v1')
    expect(f.getPending()).toEqual(original); expect(f.session.canEdit.value).toBe(false)
    const action = vi.fn(async () => {})
    await expect(f.session.withTargetMutation(action)).rejects.toThrow()
    expect(action).not.toHaveBeenCalled(); expect(f.getPending()).toEqual(original)
  })
  it('does not admit a mutation while another page has an undiscovered original', async () => {
    const f = await make('Draft', true), held = deferred<WorkflowPending | null>()
    const original: WorkflowPending = { schema: 'metasheet.welding_command_pending/1', kind: 'workflow', action: 'revise', owner: clone(owner), plan_id: 'plan', item_version_id: 'v1', body: { request_id: 'external-request', source_publication_id: 'publication', expected_draft_seq: 1, expected_content_hash: hash, reason: 'existing original' } }
    f.setPending(original); vi.mocked(f.db.getWorkflow).mockReturnValueOnce(held.promise)
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(vi.mocked(f.db.getWorkflow).mock.results.at(-1)?.value).toBe(held.promise))
    const action = vi.fn(async () => {})
    await expect(f.session.withTargetMutation(action)).rejects.toThrow()
    expect(action).not.toHaveBeenCalled(); expect(f.getPending()).toEqual(original)
    held.resolve(clone(original))
    await vi.waitFor(() => expect(f.session.canEdit.value).toBe(false))
  })
  it('blocks leave and mutation on a focus storage error', async () => {
    const f = await make('Draft', true)
    vi.mocked(f.db.getWorkflow).mockRejectedValue(new Error('focus storage unavailable'))
    window.dispatchEvent(new Event('focus'))
    expect(await f.session.prepareLeave()).toBe(false)
    expect(f.session.canEdit.value).toBe(false)
    const action = vi.fn(async () => {})
    await expect(f.session.withTargetMutation(action)).rejects.toThrow()
    expect(action).not.toHaveBeenCalled()
  })
  it('discards a held focus read after an authentication epoch change', async () => {
    const f = await make('Draft', true), held = deferred<WorkflowPending | null>()
    vi.mocked(f.db.getWorkflow).mockReturnValueOnce(held.promise)
    window.dispatchEvent(new Event('focus'))
    const leaving = f.session.prepareLeave()
    localStorage.setItem('auth_token', 'native-B'); window.dispatchEvent(new StorageEvent('storage', { key: 'auth_token' }))
    held.resolve(null); expect(await leaving).toBe(false)
    expect(f.session.state.owner).toBeNull(); expect(f.session.state.planId).toBe('')
    expect(f.session.canEdit.value).toBe(false)
  })
  it.each(['leave', 'new', 'open', 'open-readonly', 'restore'])('rejects a late focus read started inside the final %s await', async target => {
    const f = await make('Draft', true), heldRead = deferred<WorkflowPending | null>(), heldStep = deferred<any>()
    const original: WorkflowPending = { schema: 'metasheet.welding_command_pending/1', kind: 'workflow', action: 'revise', owner: clone(owner), plan_id: 'plan', item_version_id: 'v1', body: { request_id: 'late-original', source_publication_id: 'publication', expected_draft_seq: 1, expected_content_hash: hash, reason: 'external original' } }
    const point = clone(f.session.state.savedPoint!)
    const targetRecord = { ...clone(point), plan_id: 'other', item_version_id: 'v2', state: target === 'open-readonly' ? 'Released' : point.state }
    const recovery = { schema: 'yuantus.welding_plan_recovery/1' as const, recovery_id: id, updated_at: Date.now(), owner: clone(owner), draft: { plan_id: 'other', version_id: 'v2', base_draft_seq: point.draft_seq, base_content_hash: point.content_hash, name: point.name, number: point.number, payload: clone(point.payload) }, pending: null }
    const step = vi.fn(() => heldStep.promise)
    if (target === 'restore') {
      f.planDB.get = vi.fn(async () => clone(recovery))
      vi.mocked(f.client.recover).mockImplementation(async (_purpose, record) => ({ schema: 'yuantus.welding_plan_recovery_authority/1', owner: clone(owner), record_id: record.recovery_id, current: clone(targetRecord), can_write: true, conflict: false }))
      await f.session.previewRecovery(recovery)
      vi.mocked(f.planDB.get).mockImplementationOnce(step)
    }
    if (target === 'leave') { f.session.state.dirty = true; f.planDB.claim = step }
    else if (target === 'new') vi.mocked(f.client.recoveryOwner).mockImplementationOnce(step)
    else if (target.startsWith('open')) vi.mocked(f.client.read).mockImplementationOnce(step)
    const moving = target === 'leave' ? f.session.prepareLeave() : target === 'new' ? f.session.newDraft() : target === 'restore' ? f.session.restoreRecovery() : f.session.open('other', 'v2')
    await vi.waitFor(() => expect(step).toHaveBeenCalledOnce())
    f.setPending(original); vi.mocked(f.db.getWorkflow).mockReturnValueOnce(heldRead.promise)
    window.dispatchEvent(new Event('focus'))
    await vi.waitFor(() => expect(vi.mocked(f.db.getWorkflow).mock.results.at(-1)?.value).toBe(heldRead.promise))
    heldStep.resolve(target === 'leave' ? true : target === 'new' ? clone(owner) : target === 'restore' ? clone(recovery) : clone(targetRecord))
    try {
      const result = await moving
      if (target === 'leave') expect(result).toBe(false)
      expect(f.session.state.planId).toBe('plan'); expect(f.session.state.versionId).toBe('v1')
      expect(f.getPending()).toEqual(original); expect(f.session.state.savedPoint).toEqual(point)
    } finally { heldRead.resolve(clone(original)) }
  })
})
