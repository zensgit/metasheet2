import { webcrypto, createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWeldingPlanClient, parseWeldingEntry, validateSaveAck, validateReviewAck, generationBasis, validateWorkflowBody, validateWorkflowAck, validateWorkflowResolution, validateWorkflowState, validateWorkflowHistory, finalGenerationBasis, validateFinalAck, validateFinalGeneration, validatePublication, validateRevisionAck, validatePublicationDirectory, validatePublicationComparison, WeldingPlanError } from '../src/services/welding/planClient'
import actual17History from './fixtures/welding-history-actual17.json'
import type { PlanRecoveryRecord } from '../src/services/welding/planRecovery'
import * as reuseClient from '../src/services/welding/planClient'

const owner = { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }
const payload = { schema_version: 1 as const, product: { item_id: 'part', version_id: 'p1' }, drawing: { item_id: 'drawing', version_id: 'd1', file_id: 'f1', file_role: 'native_cad', expected_checksum: 'a'.repeat(64) }, welds: [] }
const plan = { plan_id: 'plan', item_version_id: 'v1', name: 'Plan', number: 'W1', state: 'Draft', version_label: 'A', draft_seq: 2, content_hash: 'a'.repeat(64), payload, sources: { f18: { baseline: 'keep' } } }
const record = (): PlanRecoveryRecord => {
  const localPayload = structuredClone(payload)
  return { schema: 'yuantus.welding_plan_recovery/1', recovery_id: '00000000-0000-4000-8000-000000000001', updated_at: 1, owner,
    draft: { plan_id: 'plan', version_id: 'v1', base_draft_seq: 2, base_content_hash: 'a'.repeat(64), name: 'Plan', number: 'W1', payload: localPayload },
    pending: { method: 'PUT', path: '/plan/versions/v1/draft', body: { expected_draft_seq: 2, save_id: 'original-save', payload: localPayload }, local_ahead: false } }
}
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

describe('F18b finite reuse client', () => {
  const body = () => ({ request_id: 'reuse-original', source_publication_id: 'publication', expected_draft_seq: 2, expected_content_hash: 'a'.repeat(64), selected_weld_ids: ['w1'], target_plan_id: 'target?=+&', name: 'Independent', number: 'R1', product: { item_id: 'other', version_id: 'p2' }, drawing: { ...payload.drawing }, bom: null, reason: ' 原因\n保留 ' })
  const original = () => ({ action: 'reuse' as const, plan_id: 'plan', item_version_id: 'v1', body: body() })
  const ack = () => ({ schema: 'yuantus.welding_plan_reuse_ack/1', action: 'reuse', request_id: 'reuse-original', reuse_id: 'reuse', source_plan_id: 'plan', source_version_id: 'v1', source_publication_id: 'publication', source_draft_seq: 2, source_content_hash: 'a'.repeat(64), target_plan_id: 'target?=+&', target_version_id: 'target-v1', target_version_label: 'A', target_draft_seq: 1, target_content_hash: 'b'.repeat(64), state: 'Draft', reuse_provenance_sha256: 'c'.repeat(64) })
  beforeEach(() => localStorage.setItem('auth_token', 'session-A'))
  it('accepts the independent 16-field ACK and different copied target hash', () => {
    expect(reuseClient.validateReuseAck(ack(), original())).toEqual(ack())
  })
  it.each([{ schema: 'yuantus.welding_plan_revision_ack/1' }, { request_id: 'other' }, { source_plan_id: 'other' }, { target_plan_id: 'other' }, { source_content_hash: 'b'.repeat(64) }, { target_draft_seq: 2 }, { extra: true }])('rejects mismatched reuse acknowledgement %s', patch => {
    expect(() => reuseClient.validateReuseAck({ ...ack(), ...patch }, original())).toThrow()
  })
  it('sends the exact full original for create and resolve, without a workflow envelope', async () => {
    const transport = vi.fn().mockResolvedValueOnce(response(ack())).mockResolvedValueOnce(response({ schema: 'yuantus.welding_reuse_resolution/1', command: 'reuse', request_id: 'reuse-original', status: 'committed', ack: ack() }))
    const client = createWeldingPlanClient(transport), request = body()
    await client.reusePlan('plan', 'v1', request); await client.resolveReuseReceipt(original())
    expect(transport.mock.calls.map(call => [call[0], call[1].body])).toEqual([
      ['/api/welding/plans/plan/versions/v1/reuse', JSON.stringify(request)], ['/api/welding/plans/plan/versions/v1/reuse-receipts/resolve', JSON.stringify(request)],
    ])
  })
  it.each(['a/b', 'a%2fb', '.', '..'])('rejects unsupported target %s before dispatch', async target_plan_id => {
    const transport = vi.fn(); await expect(createWeldingPlanClient(transport).reusePlan('plan', 'v1', { ...body(), target_plan_id })).rejects.toThrow(); expect(transport).not.toHaveBeenCalled()
  })
  it('allows Y source IDs without weakening routed target checks and preserves unknown-null', async () => {
    const request = { ...body(), selected_weld_ids: ['焊缝/一', '\u0001'.repeat(64)], name: '\u0001'.repeat(128), reason: '\u0001'.repeat(4000) }
    expect(reuseClient.validateReuseRequest(request)).toEqual(request)
    const transport = vi.fn().mockResolvedValue(response({ schema: 'yuantus.welding_reuse_resolution/1', command: 'reuse', request_id: request.request_id, status: 'unknown', ack: null }))
    expect(await createWeldingPlanClient(transport).resolveReuseReceipt({ ...original(), body: request })).toBeNull()
  })
  it.each(['\u001cvalue', 'value\u0085', '\ud800', 'line\nbreak', 'nul\0', 'x'.repeat(65)])('rejects invalid Y source ID %s without transport', async id => {
    const transport = vi.fn(); await expect(createWeldingPlanClient(transport).reusePlan('plan', 'v1', { ...body(), selected_weld_ids: [id] })).rejects.toThrow(); expect(transport).not.toHaveBeenCalled()
  })
  const proof = () => ({ schema: 'yuantus.welding_reuse_provenance/1', reuse_id: 'reuse', reuse_provenance_sha256: 'c'.repeat(64), basis: { schema: 'yuantus.welding_reuse/1', metadata: { id: 'reuse', tenant_id: 'tenant', org_id: 'org', source_plan_id: 'plan', source_version_id: 'v1', source_publication_id: 'publication', target_plan_id: body().target_plan_id, target_version_id: 'target-v1', request_id: 'reuse-original', request_digest: 'a'.repeat(64), reason: body().reason, actor: { auth_user_id: 77, rbac_user_id: 177, display_name: 'Historical' }, created_at: '2026-10-09T00:00:00Z' }, request: body(), source: { draft_seq: 2, content_hash: 'a'.repeat(64) }, target: { version_label: 'A', content_hash: 'b'.repeat(64), payload: { schema_version: 1, product: body().product, drawing: body().drawing, bom: null, welds: [], process_refs: [] }, sources: { reuse: { schema: 'yuantus.welding_reuse/1', reuse_id: 'reuse' } } }, mappings: [{ source_weld_id: 'w1', target_weld_id: 'new-w1', source_values: {}, copy_values: {}, process_associations: [], resource_associations: [] }] } })
  it('binds authorized provenance owner but allows historical actor and initial version for a later read', async () => {
    const transport = vi.fn().mockResolvedValue(response(proof()))
    expect(await createWeldingPlanClient(transport).readReuseProvenance(body().target_plan_id, 'later-v3', owner)).toEqual(proof())
    expect(transport.mock.calls[0][0]).toBe('/api/welding/plans/target%3F%3D%2B%26/versions/later-v3/reuse-provenance')
  })
  it.each(['owner', 'source', 'marker', 'mapping', 'extra'])('rejects mismatched provenance %s', kind => {
    const value = proof()
    if (kind === 'owner') value.basis.metadata.org_id = 'other'
    if (kind === 'source') value.basis.source.content_hash = 'f'.repeat(64)
    if (kind === 'marker') value.basis.target.sources.reuse.reuse_id = 'other'
    if (kind === 'mapping') value.basis.mappings[0].source_weld_id = 'other'
    if (kind === 'extra') Object.assign(value, { extra: true })
    expect(() => reuseClient.validateReuseProvenance(value, body().target_plan_id, 'later-v3', owner)).toThrow()
  })
})

describe('fixed welding plan client', () => {
  beforeEach(() => localStorage.setItem('auth_token', 'session-A'))
  it('uses only the original fixed method/path/body and accepts a bound CAS ACK', async () => {
    const transport = vi.fn().mockResolvedValue(response({ ...plan, draft_seq: 3 }))
    const value = record(), before = JSON.stringify(value)
    expect((await createWeldingPlanClient(transport).save(value)).draft_seq).toBe(3)
    expect(transport.mock.calls[0][0]).toBe('/api/welding/plans/plan/versions/v1/draft')
    expect(transport.mock.calls[0][1]).toMatchObject({ method: 'PUT', body: JSON.stringify(value.pending!.body), redirect: 'error', suppressUnauthorizedRedirect: true })
    expect(JSON.stringify(value)).toBe(before)
  })
  it.each(['../escape', 'a/b', 'a%2fb', 'a\\b', '.', 'https://evil.test'])('rejects unaddressable target %s before transport', async id => {
    const transport = vi.fn()
    await expect(createWeldingPlanClient(transport).read(id, 'v1')).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })
  it('binds exact owner identities rather than equating auth and RBAC IDs', async () => {
    const transport = vi.fn().mockResolvedValue(response({ schema: 'yuantus.welding_generation_authority/1', owner }))
    expect(await createWeldingPlanClient(transport).authority()).toEqual(owner)
  })
  it('rejects recovery responses for another owner or another fixed current version', async () => {
    for (const value of [{ owner: { ...owner, rbac_user_id: 7 }, current: plan }, { owner, current: { ...plan, item_version_id: 'v2' } }]) {
      const transport = vi.fn().mockResolvedValue(response({ schema: 'yuantus.welding_plan_recovery_authority/1', record_id: record().recovery_id, can_write: true, conflict: false, ...value }))
      await expect(createWeldingPlanClient(transport).recover('restore', record())).rejects.toThrow()
    }
  })
  it('accepts actual Y drawing checksum and preserves it for fixed selection', async () => {
    const drawing = { item_id: 'drawing', version_id: 'd1', name: 'Drawing', number: 'D1', version_label: 'A', file_id: 'f1', file_role: 'native_cad', checksum: 'a'.repeat(64) }
    const transport = vi.fn().mockResolvedValue(response({ items: [drawing] }))
    expect(await createWeldingPlanClient(transport).drawingCandidates('D1')).toEqual([drawing])
  })
  it('checks product context and pagination against the original request', async () => {
    const transport = vi.fn().mockResolvedValueOnce(response({ schema: 'yuantus.welding_plan_entry/1', product: { item_id: 'wrong', version_id: 'p1', name: '', number: '', version_label: null } }))
      .mockResolvedValueOnce(response({ items: [plan], limit: 50, offset: 50, total: 1 }))
    const client = createWeldingPlanClient(transport)
    await expect(client.productContext(payload.product)).rejects.toThrow()
    await expect(client.list(0)).rejects.toThrow()
  })
  it('rejects wrong ACK identity, sequence and hash while allowing unknown existing payload fields', () => {
    for (const bad of [{ plan_id: 'wrong' }, { item_version_id: 'wrong' }, { draft_seq: 4 }, { content_hash: 'bad' }])
      expect(() => validateSaveAck({ ...plan, draft_seq: 3, ...bad }, record())).toThrow()
    expect(validateSaveAck({ ...plan, draft_seq: 3, save_id: 'original-save', payload: { ...payload, assembly_source: { future: [1, 2] }, overlay: { schema: 'vemcad-weld-overlay/3', unknown: true } } }, record()).payload).toMatchObject({ assembly_source: { future: [1, 2] }, overlay: { unknown: true } })
  })
  it('accepts a server-assigned version for the original create and seq=1', () => {
    const value = record(); value.draft.version_id = null; value.draft.base_draft_seq = 0; value.draft.base_content_hash = null
    value.pending = { method: 'POST', path: '', body: { plan_id: 'plan', name: 'Plan', number: 'W1', save_id: 'same-create', payload }, local_ahead: false }
    expect(validateSaveAck({ ...plan, item_version_id: 'server-assigned', draft_seq: 1 }, value).item_version_id).toBe('server-assigned')
  })
  it('rejects a non-Draft save receipt despite matching plan/version/seq/hash shape', () => {
    expect(() => validateSaveAck({ ...plan, draft_seq: 3, state: 'Released' }, record())).toThrow()
  })
  it.each(['name', 'number'])('binds create receipt %s to the original pending body', field => {
    const value = record(); value.draft.version_id = null; value.draft.base_draft_seq = 0; value.draft.base_content_hash = null
    value.pending = { method: 'POST', path: '', body: { plan_id: 'plan', name: 'Plan', number: 'W1', save_id: 'same-create', payload: value.draft.payload }, local_ahead: false }
    expect(() => validateSaveAck({ ...plan, draft_seq: 1, [field]: 'wrong' }, value)).toThrow()
  })
  it.each([undefined, 'another-save'])('binds overlay/3 receipt save_id %s to the original request', save_id => {
    const value = record(), overlay = { schema: 'vemcad-weld-overlay/3', unknown_future: true }
    value.draft.payload.overlay = overlay
    expect(() => validateSaveAck({ ...plan, draft_seq: 3, ...(save_id === undefined ? {} : { save_id }), payload: { ...payload, overlay } }, value)).toThrow()
    expect(validateSaveAck({ ...plan, draft_seq: 3, save_id: 'original-save', payload: { ...payload, bom: null, process_refs: [], overlay } }, value).save_id).toBe('original-save')
    for (const schema of ['vemcad-weld-overlay/1', 'vemcad-weld-overlay/2'])
      expect(validateSaveAck({ ...plan, draft_seq: 3, payload: { ...payload, overlay: { schema } } }, record()).draft_seq).toBe(3)
  })
  it('rejects same-subject token replacement after response and after response-body await', async () => {
    let finish!: (value: Response) => void
    const transport = vi.fn(() => new Promise<Response>(resolve => { finish = resolve }))
    const result = createWeldingPlanClient(transport).read('plan', 'v1')
    localStorage.setItem('auth_token', 'session-B'); finish(response(plan))
    await expect(result).rejects.toMatchObject({ code: 'WELDING_STALE_SESSION' })
    localStorage.setItem('auth_token', 'session-A')
    let body!: ReadableStreamDefaultController<Uint8Array>
    const reading = vi.fn()
    const delayed = new Response(new ReadableStream({ start(controller) { body = controller }, pull: reading }, { highWaterMark: 0 }))
    transport.mockImplementation(async () => delayed)
    const next = createWeldingPlanClient(transport).read('plan', 'v1')
    await vi.waitFor(() => expect(reading).toHaveBeenCalled())
    localStorage.setItem('auth_token', 'session-C'); body.enqueue(new TextEncoder().encode(JSON.stringify(plan))); body.close()
    await expect(next).rejects.toMatchObject({ code: 'WELDING_STALE_SESSION' })
  })
  it('surfaces RESULT_UNKNOWN without a second business request', async () => {
    const transport = vi.fn().mockResolvedValue(response({ error: { code: 'WELDING_RESULT_UNKNOWN' } }, 502))
    await expect(createWeldingPlanClient(transport).save(record())).rejects.toEqual(expect.objectContaining({ status: 502, code: 'WELDING_RESULT_UNKNOWN' }))
    expect(transport).toHaveBeenCalledTimes(1)
  })
  it('does not request without a current native session', async () => {
    localStorage.clear(); const transport = vi.fn()
    await expect(createWeldingPlanClient(transport).authority()).rejects.toBeInstanceOf(WeldingPlanError)
    expect(transport).not.toHaveBeenCalled()
  })
  it.each(['?plan_id=p', '?plan_id=p&version_id=v&product_id=x', '?plan_id=p&plan_id=p&version_id=v', '?product_id=%GG&product_version_id=v', '?target=https://evil.test'])('rejects ambiguous entry %s', value => {
    expect(() => parseWeldingEntry(value)).toThrow()
  })
  it('accepts only either complete entry pair', () => {
    expect(parseWeldingEntry('?plan_id=p&version_id=v')).toEqual({ plan_id: 'p', version_id: 'v' })
    expect(parseWeldingEntry('?product_id=p&product_version_id=v')).toEqual({ product_id: 'p', product_version_id: 'v' })
  })
  it('keeps legitimate encoded query/fragment characters in IDs and original body-only save IDs', async () => {
    const transport = vi.fn().mockResolvedValue(response({ ...plan, plan_id: 'plan?#' }))
    expect((await createWeldingPlanClient(transport).read('plan?#', 'v1')).plan_id).toBe('plan?#')
    expect(transport.mock.calls[0][0]).toBe('/api/welding/plans/plan%3F%23/versions/v1')
    const original = record(); original.pending!.body.save_id = 'body/id%?#'
    original.draft.payload.welds = [{ weld_id: 'body/weld%?#', display_no: '1' }]
    const submit = vi.fn().mockResolvedValue(response({ ...plan, draft_seq: 3 }))
    await createWeldingPlanClient(submit).save(original)
    expect(JSON.parse(submit.mock.calls[0][1].body).save_id).toBe('body/id%?#')
  })
  it('rejects structurally malformed fixed product/drawing targets before sending', async () => {
    for (const bad of [{ product: false }, { drawing: { ...payload.drawing, file_role: 'arbitrary' } }]) {
      const value = record(); value.draft.payload = { ...value.draft.payload, ...bad } as PlanRecoveryRecord['draft']['payload']
      value.pending!.body.payload = value.draft.payload
      const transport = vi.fn().mockResolvedValue(response({ ...plan, draft_seq: 3 }))
      await expect(createWeldingPlanClient(transport).save(value)).rejects.toThrow()
      expect(transport).not.toHaveBeenCalled()
    }
  })
})

// The request-side comparison must retain all business and future fields.
describe('represented save acknowledgement', () => {
  it('rejects a changed business body even with the exact save id', () => {
    const original = record()
    original.pending!.body.payload = { ...payload, overlay: { schema: 'vemcad-weld-overlay/3' }, future: 'original' }
    expect(() => validateSaveAck({ ...plan, draft_seq: 3, save_id: 'original-save', payload: { ...payload, bom: null, process_refs: [], overlay: { schema: 'vemcad-weld-overlay/3' }, future: 'changed' } }, original)).toThrow()
  })
})

describe('bounded additional welding methods', () => {
  beforeEach(() => localStorage.setItem('auth_token', 'session-A'))
  it('uses genuine DELETE without fallback and fixed context path', async () => {
    const transport = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await createWeldingPlanClient(transport).revokeCadContext('p', 'v', 'c')
    expect(transport).toHaveBeenCalledWith('/api/welding/plans/p/versions/v/cad-contexts/c', expect.objectContaining({ method: 'DELETE', bypassDeleteFallback: true }))
    expect(transport.mock.calls[0][1]).not.toHaveProperty('body')
  })
  it('allows a legitimate fixed resource beyond the ordinary JSON bound only for this method', async () => {
    const large = { resource_id: 'r', item_version_id: 'v', content_hash: 'b'.repeat(64), kind: 'wps', payload: { schema_version: 1, kind: 'wps', suggested_fields: { method: 'a' } }, sources: { title: 'x'.repeat(14 * 1024 * 1024) } }
    const transport = vi.fn().mockImplementation(async () => response(large))
    expect((await createWeldingPlanClient(transport).resource('r', 'v')).resource_id).toBe('r')
    await expect(createWeldingPlanClient(transport).read('r', 'v')).rejects.toThrow()
    await expect(createWeldingPlanClient(transport).resource('other', 'v')).rejects.toThrow()
  })
  it('accepts only the qualified exact ticket path and rejects stale/old pin', async () => {
    const pin = 'b05b3684664f215ced015f09f23d300fcccf8ba49ea4e8826e1a373070083bb8'
    for (const wrong of [false, true]) {
      const transport = vi.fn().mockResolvedValue(response({ asset_url: `/welding-cad/${pin}/welding-frame.html`, bundle_sha256: wrong ? 'a'.repeat(64) : pin, expires_at: new Date(Date.now() + 30000).toISOString() }))
      const job = createWeldingPlanClient(transport).cadTicket({ purpose: 'editor', plan_id: 'p', version_id: 'v', context_id: 'c' })
      if (wrong) await expect(job).rejects.toThrow(); else expect((await job).bundle_sha256).toBe(pin)
    }
    for (const oldPin of ['3c508996368f7f13c1c41f59abf0a1cdd69db2d5269a4c3c9a8c58c903db7b9f', '80987ef161c03eb97fe113a387427f32368a74b10f105f55299a81331b77f441', '84a099a4cc4a13a76fe74f71aa79954b43eb9d8e2cfc00a2fd9cf721dcb86b8c', '69b6adcc23c0123e64571242c70819be89ef0a6048235e4ffabcd48c7c5761bd']) {
      const stale = vi.fn().mockResolvedValue(response({ asset_url: `/welding-cad/${oldPin}/welding-frame.html`, bundle_sha256: oldPin, expires_at: new Date(Date.now() + 30000).toISOString() }))
      await expect(createWeldingPlanClient(stale).cadTicket({ purpose: 'editor', plan_id: 'p', version_id: 'v', context_id: 'c' })).rejects.toThrow()
    }
  })
  it('canonicalizes only actual default/empty refs/checksum/selected fields on request copies', () => {
    const r = record(), original = { ...payload, drawing: { ...payload.drawing, expected_checksum: 'AB'.repeat(32) }, overlay: { schema: 'vemcad-weld-overlay/3' }, resource_refs: [] }
    r.pending!.body.payload = original
    const ack = { ...plan, draft_seq: 3, save_id: 'original-save', payload: { ...payload, bom: null, process_refs: [], drawing: { ...payload.drawing, expected_checksum: 'ab'.repeat(32) }, overlay: { schema: 'vemcad-weld-overlay/3' } } }
    const before = JSON.stringify(r); expect(validateSaveAck(ack, r).draft_seq).toBe(3); expect(JSON.stringify(r)).toBe(before)
    for (const patch of [{ bom: {} }, { process_refs: [{}] }, { overlay: { schema: 'vemcad-weld-overlay/2' } }, { unknown: true }]) expect(() => validateSaveAck({ ...ack, payload: { ...ack.payload, ...patch } }, r)).toThrow()
    const missing = structuredClone(ack); delete (missing.payload as any).bom; expect(() => validateSaveAck(missing, r)).toThrow()
  })
})

describe('captured actual Pydantic model_dump oracle', () => {
  it('accepts all 25 actual canonical shapes without mutating request or ACK', async () => {
    const { readFileSync, readdirSync } = await import('node:fs'), { resolve } = await import('node:path')
    const directory = resolve('../../artifacts/welding-f15b/workbench-cad-fields-1/schema-oracle')
    const files = readdirSync(directory).filter(name => name.endsWith('.input.json')); expect(files).toHaveLength(25)
    for (const file of files) {
      const { request, canonical } = JSON.parse(readFileSync(resolve(directory, file), 'utf8'))
      const r = record(); r.pending!.body.payload = request
      const ack = { ...plan, draft_seq: 3, save_id: 'original-save', payload: canonical }, before = JSON.stringify({ r, ack })
      expect(validateSaveAck(ack, r).payload, file).toEqual(canonical); expect(JSON.stringify({ r, ack }), file).toBe(before)
    }
  })
})

const reviewBody = { request_id: '00000000-0000-4000-8000-000000000001', expected_draft_seq: 2, expected_content_hash: 'a'.repeat(64), purpose: 'review', template_id: 'welding-a4', template_version: '1', template_digest: 'b'.repeat(64), template_options: { organization_name: '', header_text: '', footer_text: '', optional_columns: [], logo: null } } as const
const fixed = { generation_id: '00000000-0000-4000-8000-000000000009', render_key: 'c'.repeat(64), plan_id: 'plan', item_version_id: 'v1', draft_seq: 2, plan_content_hash: 'a'.repeat(64), generation_content_hash: 'd'.repeat(64), purpose: 'review', template: { id: 'welding-a4', version: '1', digest: 'b'.repeat(64) } } as const
const ack = { schema: 'yuantus.welding_generation_ack/1', request_id: reviewBody.request_id, ...fixed }
describe('named review generation client and bounded files', () => {
  beforeEach(() => { localStorage.setItem('auth_token', 'session-A'); vi.stubGlobal('crypto', webcrypto) })
  afterEach(() => vi.unstubAllGlobals())
  it('uses review POST with exact body and accepts actual server-generated identifiers', async () => {
    const transport = vi.fn().mockResolvedValue(response(ack, 202))
    expect(await createWeldingPlanClient(transport).createReviewGeneration('plan', 'v1', { ...reviewBody, template_options: { ...reviewBody.template_options, optional_columns: [] } })).toEqual(ack)
    expect(transport.mock.calls[0]).toEqual(['/api/welding/plans/plan/versions/v1/renders', expect.objectContaining({ method: 'POST', body: JSON.stringify(reviewBody), redirect: 'error', cache: 'no-store' })])
  })
  it('does not accept a successful HTTP 200 in place of the named 202 ACK', async () => {
    await expect(createWeldingPlanClient(vi.fn(async () => response(ack))).createReviewGeneration('plan', 'v1', { ...reviewBody, template_options: { ...reviewBody.template_options, optional_columns: [] } })).rejects.toThrow()
  })
  it.each(['plan_id', 'item_version_id', 'draft_seq', 'plan_content_hash', 'render_key', 'generation_content_hash', 'generation_id', 'purpose', 'template'])('binds retry ACK fixed field %s', field => {
    const patch = field === 'draft_seq' ? 3 : field === 'template' ? { ...fixed.template, version: '2' } : field === 'generation_id' ? '00000000-0000-4000-8000-000000000008' : field === 'purpose' ? 'final' : 'e'.repeat(64)
    expect(() => validateReviewAck({ ...ack, [field]: patch }, { request_id: reviewBody.request_id, expected_attempt: 1 }, generationBasis(fixed))).toThrow()
  })
  it('uses the fixed retry endpoint with only original request and expected attempt', async () => {
    const transport = vi.fn().mockResolvedValue(response(ack, 202)), body = { request_id: reviewBody.request_id, expected_attempt: 1 }
    await createWeldingPlanClient(transport).retryReviewGeneration(generationBasis(fixed), body)
    expect(transport.mock.calls[0][0]).toBe(`/api/welding/artifacts/${fixed.generation_id}/retry`)
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual(body)
  })
  it('rejects an oversized template stream before parsing, without relying on Content-Length', async () => {
    const cancelled = vi.fn(), stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)) }, cancel: cancelled })
    await expect(createWeldingPlanClient(vi.fn(async () => new Response(stream))).renderTemplates()).rejects.toThrow('容量')
    expect(cancelled).toHaveBeenCalledTimes(1)
  })
  it.each(['pdf', 'docx'] as const)('verifies actual %s bytes before returning a Blob', async format => {
    const data = new TextEncoder().encode('fixed review file'), mime = format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    const descriptor = { format, mime_type: mime, byte_size: data.length, artifact_sha256: createHash('sha256').update(data).digest('hex') }
    const transport = vi.fn(async () => new Response(data, { headers: { 'Content-Type': mime, 'Content-Length': String(data.length), 'X-Artifact-SHA256': descriptor.artifact_sha256 } }))
    const blob = await createWeldingPlanClient(transport).downloadReviewFile(fixed.generation_id, descriptor)
    expect(blob.size).toBe(data.length); expect(blob.type).toBe(mime)
    expect(transport.mock.calls[0][0]).toBe(`/api/welding/artifacts/${fixed.generation_id}/files/${format}`)
  })
  it.each(['content-type', 'content-length', 'X-Artifact-SHA256', 'actual-bytes'])('rejects wrong file %s', async wrong => {
    const data = new TextEncoder().encode('abc'), descriptor = { format: 'pdf' as const, mime_type: 'application/pdf', byte_size: 3, artifact_sha256: createHash('sha256').update(data).digest('hex') }
    const headers = { 'content-type': descriptor.mime_type, 'content-length': '3', 'X-Artifact-SHA256': descriptor.artifact_sha256, ...(wrong === 'actual-bytes' ? {} : { [wrong]: 'wrong' }) }
    await expect(createWeldingPlanClient(vi.fn(async () => new Response(wrong === 'actual-bytes' ? new TextEncoder().encode('xyz') : data, { headers }))).downloadReviewFile(fixed.generation_id, descriptor)).rejects.toThrow()
  })
  it('refuses a late file chunk after native session replacement and cancels the reader', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>; const cancel = vi.fn(), reading = vi.fn()
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value }, pull: reading, cancel }, { highWaterMark: 0 })
    const descriptor = { format: 'pdf' as const, mime_type: 'application/pdf', byte_size: 3, artifact_sha256: createHash('sha256').update('abc').digest('hex') }
    const job = createWeldingPlanClient(vi.fn(async () => new Response(stream, { headers: { 'Content-Type': descriptor.mime_type, 'Content-Length': '3', 'X-Artifact-SHA256': descriptor.artifact_sha256 } }))).downloadReviewFile(fixed.generation_id, descriptor)
    await vi.waitFor(() => expect(reading).toHaveBeenCalled()); localStorage.setItem('auth_token', 'session-B'); controller.enqueue(new TextEncoder().encode('abc'))
    await expect(job).rejects.toMatchObject({ code: 'WELDING_STALE_SESSION' }); expect(cancel).toHaveBeenCalled()
  })
})


describe('closed C1 workflow wire', () => {
  const basis = { expected_draft_seq: 1, expected_content_hash: 'a'.repeat(64) }
  const original = { plan_id: 'plan', item_version_id: 'v1', action: 'review' as const, body: { ...basis, request_id: 'wire-original', approval_request_id: 'approval', expected_submission_hash: 'b'.repeat(64), decision: 'approve' as const, opinion: '' } }
  const ack = () => ({ schema: 'yuantus.welding_plan_workflow_ack/1', request_id: 'wire-original', action: 'approve', plan_id: 'plan', item_version_id: 'v1', draft_seq: 1, content_hash: 'a'.repeat(64), state: 'Approved', approval_request_id: 'approval', publication_id: null })
  const state = () => ({ schema: 'yuantus.welding_review_state/1', plan_id: 'plan', item_version_id: 'v1', state: 'Draft', draft_seq: 1, content_hash: 'a'.repeat(64), is_current: true, approval: null, final_generation: null, publication: null, final_profile: null, allowed_actions: ['submit', 'final-render', 'final-retry', 'release', 'revise'], issues: [] })
  it('accepts all existing service actions while only C1 bodies are dispatchable', () => {
    expect(validateWorkflowState(state(), 'plan', 'v1', owner).allowed_actions).toHaveLength(5)
    expect(() => validateWorkflowBody('final-render' as any, original.body)).toThrow()
    expect(() => validateWorkflowState({ ...state(), allowed_actions: ['submit', 'unknown'] }, 'plan', 'v1', owner)).toThrow()
    expect(() => validateWorkflowState({ ...state(), allowed_actions: ['submit', 'submit'] }, 'plan', 'v1', owner)).toThrow()
  })
  it.each([{ request_id: 'wrong' }, { action: 'reject' }, { approval_request_id: 'other' }, { draft_seq: 2 }, { state: 'Draft' }, { content_hash: 'c'.repeat(64) }, { plan_id: 'other' }, { publication_id: 'published' }, { extra: true }])('does not accept an ACK mismatch %s', patch => {
    expect(() => validateWorkflowAck({ ...ack(), ...patch }, original)).toThrow()
  })
  it('binds committed receipt to the full original and unknown requires a null ACK', () => {
    const resolution = { schema: 'yuantus.welding_workflow_resolution/1', command: 'review', request_id: 'wire-original', status: 'committed', ack: ack() }
    expect(validateWorkflowResolution(resolution, original)).toEqual(ack())
    expect(() => validateWorkflowResolution({ ...resolution, status: 'unknown' }, original)).toThrow()
    expect(validateWorkflowResolution({ ...resolution, status: 'unknown', ack: null }, original)).toBeNull()
    expect(() => validateWorkflowResolution({ ...resolution, command: 'withdraw' }, original)).toThrow()
  })
  it('reopen alone advances seq and keeps original submission, reason, content hash', () => {
    const reopen = { ...original, action: 'reopen' as const, body: { ...basis, request_id: 'wire-original', approval_request_id: 'approval', expected_submission_hash: 'b'.repeat(64), reason: '重新编制' } }
    expect(validateWorkflowAck({ ...ack(), action: 'reopen', state: 'Draft', draft_seq: 2 }, reopen).draft_seq).toBe(2)
    expect(() => validateWorkflowAck({ ...ack(), action: 'reopen', state: 'Draft' }, reopen)).toThrow()
  })
  it.each(['\0', '\ud800', 'x'.repeat(4001)])('rejects an unsafe long opinion before transport', opinion => {
    expect(() => validateWorkflowBody('review', { ...original.body, opinion })).toThrow()
  })
  it('history validates actual pagination and each immutable actor/event rather than current draft basis', () => {
    const history = { schema: 'yuantus.welding_review_history/1', plan_id: 'plan', item_version_id: 'v1', total: 1, limit: 50, offset: 0, items: [{ event_id: 'created', approval: null, action: 'created', from_state: null, to_state: 'draft', note: null, actor: { auth_user_id: 7, rbac_user_id: 19, display_name: 'Author' }, created_at: '2026-10-09T00:00:00Z' }] }
    expect(validateWorkflowHistory(history, 'plan', 'v1', owner, 0).total).toBe(1)
    expect(() => validateWorkflowHistory({ ...history, offset: 50 }, 'plan', 'v1', owner, 0)).toThrow()
    expect(() => validateWorkflowHistory({ ...history, items: [{ ...history.items[0], actor: { auth_user_id: true, rbac_user_id: 19, display_name: 'Author' } }] }, 'plan', 'v1', owner, 0)).toThrow()
  })
})

describe('workflow history action state domains', () => {
  const actualOwner = { tenant_id: actual17History.items[0].approval.submission.tenant_id, org_id: actual17History.items[0].approval.submission.org_id, auth_user_id: 6, rbac_user_id: 106 }
  const history = (action: string, from_state: string | null, to_state: string) => ({ schema: 'yuantus.welding_review_history/1', plan_id: 'plan', item_version_id: 'v1', total: 1, limit: 50, offset: 0, items: [{ event_id: 'event', approval: null, action, from_state, to_state, note: null, actor: { auth_user_id: 7, rbac_user_id: 19, display_name: 'Author' }, created_at: '2026-10-09T00:00:00Z' }] })
  it('accepts the actual17 created and submit event projection with the full frozen submission', () => {
    expect(validateWorkflowHistory(actual17History, actual17History.plan_id, actual17History.item_version_id, actualOwner, 0).items.map(item => [item.action, item.from_state, item.to_state])).toEqual([['created', null, 'draft'], ['submit', 'draft', 'pending']])
  })
  it.each([['created', null, 'draft'], ['submit', 'draft', 'pending'], ['approve', 'pending', 'approved'], ['reject', 'pending', 'rejected'], ['withdraw', 'pending', 'cancelled'], ['reopen', 'approved', 'approved']])('accepts approval event %s %s -> %s', (action, from, to) => {
    expect(validateWorkflowHistory(history(action!, from, to!), 'plan', 'v1', owner, 0).items).toHaveLength(1)
  })
  it.each([['created', null, 'Draft'], ['submit', 'Draft', 'InReview'], ['approve', 'InReview', 'Approved'], ['reject', 'InReview', 'Draft'], ['withdraw', 'InReview', 'Draft'], ['reopen', 'Approved', 'Draft'], ['submit', 'pending', 'approved'], ['approve', 'draft', 'approved'], ['reject', 'pending', 'approved'], ['withdraw', 'approved', 'cancelled'], ['reopen', 'approved', 'cancelled']])('rejects cross-domain or wrong transition %s %s -> %s', (action, from, to) => {
    expect(() => validateWorkflowHistory(history(action!, from, to!), 'plan', 'v1', owner, 0)).toThrow()
  })
  it('retains created/submit approval states when their embedded current approval is approved', () => {
    const approval = { ...structuredClone(actual17History.items[0].approval), state: 'approved', decision: { decision_hash: 'a'.repeat(64), decision: { schema: 'yuantus.welding_decision/1', approval_request_id: actual17History.items[0].approval.approval_request_id, submission_hash: actual17History.items[0].approval.submission_hash, request_id: 'decision-request', decision: 'approve', opinion: '认可', reviewer: actual17History.items[0].approval.submission.reviewer, decided_at: '2026-10-12T04:00:00Z' } } }
    const value = { ...structuredClone(actual17History), items: actual17History.items.map(item => ({ ...structuredClone(item), approval })) }
    expect(validateWorkflowHistory(value, value.plan_id, value.item_version_id, actualOwner, 0).items.map(item => item.to_state)).toEqual(['draft', 'pending'])
  })
})

describe('closed C2 final and publication wire', () => {
  const hash = 'a'.repeat(64), id = '00000000-0000-4000-8000-000000000010'
  const template = { id: 'welding-approval-appendix' as const, version: '1' as const, digest: 'b'.repeat(64) }
  const basis = { generation_id: id, render_key: 'c'.repeat(64), plan_id: 'plan', item_version_id: 'v1', draft_seq: 1, plan_content_hash: hash, generation_content_hash: 'd'.repeat(64), purpose: 'final' as const, approval_request_id: 'approval', submission_hash: 'e'.repeat(64), decision_hash: 'f'.repeat(64), template }
  const create = { request_id: 'final-create', expected_draft_seq: 1, expected_content_hash: hash, approval_request_id: 'approval', expected_submission_hash: basis.submission_hash, expected_decision_hash: basis.decision_hash, template_id: template.id, template_version: template.version, template_digest: template.digest }
  const ack = (request = create.request_id) => ({ schema: 'yuantus.welding_final_generation_ack/1', request_id: request, ...basis })
  const bytes = new TextEncoder().encode('bounded formal file'), digest = createHash('sha256').update(bytes).digest('hex')
  const file = (format: 'pdf' | 'docx') => ({ format, mime_type: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byte_size: bytes.length, artifact_sha256: digest })
  const final = () => ({ schema: 'yuantus.welding_final_generation/1', ...basis, status: 'Ready', state: 'Approved', attempt: 1, created_at: '2026-10-09T00:00:00Z', files: { pdf: file('pdf'), docx: file('docx') }, error: null })
  const actor = { auth_user_id: 7, rbac_user_id: 19, display_name: 'Actor' }
  const publication = (state = 'Released') => ({ schema: 'yuantus.welding_plan_publication/1', publication_id: 'publication', plan_id: 'plan', item_version_id: 'v1', state, draft_seq: 1, content_hash: hash, version_label: 'A', name: 'Plan', number: 'W1', approval_request_id: 'approval', submission_hash: basis.submission_hash, decision_hash: basis.decision_hash, review_generation_id: '00000000-0000-4000-8000-000000000009', final_generation_id: id, generation_content_hash: basis.generation_content_hash, requester: actor, reviewer: { ...actor, auth_user_id: 8, rbac_user_id: 20 }, opinion: '', approved_at: '2026-10-09T00:00:00Z', published_at: '2026-10-09T01:00:00Z', publisher: { ...actor, auth_user_id: 9, rbac_user_id: 21 }, files: { pdf: file('pdf'), docx: file('docx') } })
  it('keeps release and revise history in their exact plan lifecycle state pairs', () => {
    const release = { event_id: 'release', approval: null, action: 'release', from_state: 'Approved', to_state: 'Released', note: null, actor, created_at: '2026-10-09T01:00:00Z', publication: publication() }
    const revision = { schema: 'yuantus.welding_plan_revision_ack/1', request_id: 'revision-request', action: 'revise', plan_id: 'plan', source_version_id: 'v0', source_publication_id: 'publication', source_draft_seq: 1, source_content_hash: hash, target_version_id: 'v1', target_version_label: 'B', target_draft_seq: 1, target_content_hash: hash, inheritance_id: 'revision', inheritance_sha256: hash, state: 'Draft' }
    const revise = { event_id: 'revision', approval: null, action: 'revise', from_state: 'Released', to_state: 'Draft', note: '正常修订', actor, created_at: '2026-10-09T02:00:00Z', revision }
    for (const item of [release, revise]) {
      const history = { schema: 'yuantus.welding_review_history/1', plan_id: 'plan', item_version_id: 'v1', total: 1, limit: 50, offset: 0, items: [item] }
      expect(validateWorkflowHistory(history, 'plan', 'v1', owner, 0).items).toHaveLength(1)
      expect(() => validateWorkflowHistory({ ...history, items: [{ ...item, from_state: item.from_state.toLowerCase(), to_state: item.to_state.toLowerCase() }] }, 'plan', 'v1', owner, 0)).toThrow()
      expect(() => validateWorkflowHistory({ ...history, items: [{ ...item, from_state: 'Draft' }] }, 'plan', 'v1', owner, 0)).toThrow()
    }
  })
  beforeEach(() => { localStorage.setItem('auth_token', 'native-final'); vi.stubGlobal('crypto', webcrypto) })
  afterEach(() => vi.unstubAllGlobals())
  it('uses the named final route and consumes a server-assigned ACK without invented attempt or files', async () => {
    const transport = vi.fn(async () => response(ack(), 202)), client = createWeldingPlanClient(transport)
    expect(await client.createFinalGeneration('plan', 'v1', create)).toEqual(ack())
    expect(transport.mock.calls[0][0]).toBe('/api/welding/plans/plan/versions/v1/final-renders')
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual(create)
    expect(finalGenerationBasis(ack())).toEqual(basis)
    expect(() => validateReviewAck(ack(), create as any, basis as any)).toThrow()
  })
  it.each([{ request_id: 'other' }, { plan_id: 'other' }, { item_version_id: 'other' }, { draft_seq: 2 }, { plan_content_hash: 'b'.repeat(64) }, { approval_request_id: 'other' }, { submission_hash: 'b'.repeat(64) }, { decision_hash: 'b'.repeat(64) }, { template: { ...template, digest: 'c'.repeat(64) } }, { attempt: 1 }])('rejects unbound final create ACK %s', patch => {
    expect(() => validateFinalAck({ ...ack(), ...patch }, { plan_id: 'plan', item_version_id: 'v1', action: 'final-render', body: create })).toThrow()
  })
  it('retry and its resolver preserve named G and the original attempt without an attempt increment ACK', async () => {
    const body = { request_id: 'same-retry', expected_attempt: 2 }, original = { plan_id: 'plan', item_version_id: 'v1', action: 'final-retry' as const, body, basis }
    const resolved = { schema: 'yuantus.welding_workflow_resolution/1', command: 'final-retry', request_id: body.request_id, status: 'committed', ack: ack(body.request_id) }
    const transport = vi.fn().mockResolvedValueOnce(response(ack(body.request_id), 202)).mockResolvedValueOnce(response(resolved)), client = createWeldingPlanClient(transport)
    expect(await client.retryFinalGeneration(basis, body)).toEqual(ack(body.request_id))
    expect(await client.resolveWorkflowReceipt(original)).toEqual(ack(body.request_id))
    expect(transport.mock.calls.map(call => call[0])).toEqual([`/api/welding/artifacts/${id}/retry`, '/api/welding/plans/plan/versions/v1/workflow-receipts/resolve'])
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual(body)
    expect(JSON.parse(transport.mock.calls[1][1].body)).toEqual({ command: 'final-retry', generation_id: id, body })
    expect(() => validateWorkflowResolution({ ...resolved, ack: { ...ack(body.request_id), generation_id: '00000000-0000-4000-8000-000000000011' } }, original)).toThrow()
    expect(() => validateWorkflowResolution({ ...resolved, status: 'unknown' }, original)).toThrow()
    expect(validateWorkflowResolution({ ...resolved, status: 'unknown', ack: null }, original)).toBeNull()
  })
  it('fixed final status rejects a changed G or immutable basis and does not accept review purpose', async () => {
    const transport = vi.fn(async () => response(final()))
    expect(await createWeldingPlanClient(transport).readFinalGeneration(basis)).toEqual(final())
    for (const patch of [{ generation_id: '00000000-0000-4000-8000-000000000011' }, { decision_hash: hash }, { purpose: 'review' }, { schema: 'yuantus.welding_plan_generation/1' }]) expect(() => validateFinalGeneration({ ...final(), ...patch }, basis)).toThrow()
    expect(() => validateFinalGeneration({ ...final(), status: 'Failed' }, basis)).toThrow()
    expect(() => validateFinalGeneration({ ...final(), files: { ...final().files, pdf: { ...file('pdf'), byte_size: 128 * 1024 * 1024 } } }, basis)).toThrow()
  })
  it('release retains both Ready hashes and alone accepts a non-null publication ID', async () => {
    const { template_id, template_version, template_digest, ...point } = create
    const body = { ...point, request_id: 'release-1', final_generation_id: id, expected_final_pdf_sha256: digest, expected_final_docx_sha256: digest }
    const released = { schema: 'yuantus.welding_plan_workflow_ack/1', request_id: body.request_id, action: 'release', plan_id: 'plan', item_version_id: 'v1', draft_seq: 1, content_hash: hash, state: 'Released', approval_request_id: 'approval', publication_id: 'publication' }
    const transport = vi.fn(async () => response(released)), client = createWeldingPlanClient(transport)
    expect(await client.releaseWorkflowPlan('plan', 'v1', body)).toEqual(released)
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual(body)
    expect(() => validateWorkflowAck({ ...released, publication_id: null }, { plan_id: 'plan', item_version_id: 'v1', action: 'release', body })).toThrow()
  })
  it('rejects publication review/final identity collapse and a final status from review R', () => {
    const value = publication()
    expect(value.review_generation_id).not.toBe(value.final_generation_id)
    expect(() => validatePublication({ ...value, final_generation_id: value.review_generation_id }, 'plan', 'v1')).toThrow()
    expect(() => validateFinalGeneration({ ...final(), generation_id: value.review_generation_id }, basis)).toThrow()
  })
  it.each(['Released', 'Superseded'])('reads fixed %s publication without editor/profile calls', async state => {
    const transport = vi.fn(async () => response(publication(state)))
    expect(await createWeldingPlanClient(transport).readPublication('plan', 'v1')).toEqual(publication(state))
    expect(transport.mock.calls).toHaveLength(1)
    expect(transport.mock.calls[0][0]).toBe('/api/welding/plans/plan/versions/v1/publication')
    expect(() => validatePublication(publication(state), 'plan', 'other')).toThrow()
  })
  it.each(['pdf', 'docx'] as const)('verifies actual formal %s bytes on the fixed publication route', async format => {
    const descriptor = file(format), transport = vi.fn(async () => new Response(bytes, { headers: { 'Content-Type': descriptor.mime_type, 'Content-Length': String(bytes.length), 'X-Artifact-SHA256': digest } }))
    const blob = await createWeldingPlanClient(transport).downloadPublicationFile(validatePublication(publication(), 'plan', 'v1'), format)
    expect(blob.size).toBe(bytes.length); expect(blob.type).toBe(descriptor.mime_type)
    expect(transport.mock.calls[0][0]).toBe(`/api/welding/plans/plan/versions/v1/publication/files/${format}`)
  })
  it.each(['content-type', 'content-length', 'X-Artifact-SHA256', 'actual-bytes'])('rejects formal file mismatch %s', async wrong => {
    const headers = { 'content-type': file('pdf').mime_type, 'content-length': String(bytes.length), 'X-Artifact-SHA256': digest, ...(wrong === 'actual-bytes' ? {} : { [wrong]: 'wrong' }) }
    const transport = vi.fn(async () => new Response(wrong === 'actual-bytes' ? new Uint8Array(bytes.length) : bytes, { headers }))
    await expect(createWeldingPlanClient(transport).downloadPublicationFile(validatePublication(publication(), 'plan', 'v1'), 'pdf')).rejects.toThrow()
  })
  it('caps a streamed final status before JSON and rejects original injection before POST', async () => {
    const cancel = vi.fn(), stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)) }, cancel })
    await expect(createWeldingPlanClient(vi.fn(async () => new Response(stream))).readFinalGeneration(basis)).rejects.toThrow()
    expect(cancel).toHaveBeenCalled()
    const transport = vi.fn(), client = createWeldingPlanClient(transport)
    await expect(client.createFinalGeneration('plan', 'v1', { ...create, purpose: 'review' } as any)).rejects.toThrow()
    await expect(client.retryFinalGeneration({ ...basis, generation_id: '../other' }, { request_id: 'same', expected_attempt: 1 })).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })
})


describe('C3 strict revision and official contracts', () => {
  const original = { plan_id: 'plan', item_version_id: 'v1', action: 'revise' as const, body: { request_id: 'revision-original', source_publication_id: 'publication', expected_draft_seq: 2, expected_content_hash: 'a'.repeat(64), reason: ' 原因 ' } }
  const ack = () => ({ schema: 'yuantus.welding_plan_revision_ack/1', request_id: original.body.request_id, action: 'revise', plan_id: 'plan', source_version_id: 'v1', source_publication_id: 'publication', source_draft_seq: 2, source_content_hash: 'a'.repeat(64), target_version_id: 'v2', target_version_label: 'B', target_draft_seq: 1, target_content_hash: 'a'.repeat(64), inheritance_id: 'inheritance', inheritance_sha256: 'b'.repeat(64), state: 'Draft' })
  beforeEach(() => localStorage.setItem('auth_token', 'session-A'))
  it('binds all 15 ACK fields and keeps the exact five body fields on POST and resolve', async () => {
    expect(Object.keys(validateRevisionAck(ack(), original))).toHaveLength(15)
    const transport = vi.fn().mockResolvedValueOnce(response(ack())).mockResolvedValueOnce(response({ schema: 'yuantus.welding_workflow_resolution/1', command: 'revise', request_id: original.body.request_id, status: 'committed', ack: ack() }))
    const client = createWeldingPlanClient(transport)
    await client.reviseWorkflowPlan('plan', 'v1', original.body); await client.resolveWorkflowReceipt(original)
    expect(transport.mock.calls[0][0]).toBe('/api/welding/plans/plan/versions/v1/revise')
    expect(JSON.parse(transport.mock.calls[0][1].body)).toEqual(original.body)
    expect(JSON.parse(transport.mock.calls[1][1].body)).toEqual({ command: 'revise', body: original.body })
  })
  it('rejects missing/extra and every broken revision binding, ordinary ACKs and malformed reasons', () => {
    for (const key of Object.keys(ack())) { const bad = { ...ack() }; delete bad[key as keyof typeof bad]; expect(() => validateRevisionAck(bad, original)).toThrow() }
    for (const patch of [{ payload: {} }, { request_id: 'other' }, { source_version_id: 'v2' }, { source_publication_id: 'other' }, { source_draft_seq: 1 }, { source_content_hash: 'b'.repeat(64) }, { target_version_id: 'v1' }, { target_draft_seq: 2 }, { target_content_hash: 'b'.repeat(64) }, { state: 'Released' }, { inheritance_sha256: 'BAD' }, { target_version_label: 'x'.repeat(129) }]) expect(() => validateRevisionAck({ ...ack(), ...patch }, original)).toThrow()
    expect(() => validateWorkflowAck(ack(), original)).toThrow()
    for (const patch of [{ reason: '  ' }, { reason: '😀'.repeat(4001) }, { generation_id: 'fake' }, { basis: {} }]) expect(() => validateWorkflowBody('revise', { ...original.body, ...patch })).toThrow()
    expect(validateWorkflowBody('revise', { ...original.body, reason: '😀'.repeat(4000) })).toHaveProperty('reason')
  })
  const entry = (version: string, state = 'Superseded') => ({ publication_id: `publication-${version}`, item_version_id: version, version_label: version, state, published_at: '2026-10-09T00:00:00Z', content_hash: 'a'.repeat(64) })
  it('C3 independent-audit rejects negative empty generation totals and preserves legal beyond-total empty pages', async () => {
    const transport = vi.fn().mockResolvedValueOnce(response({ items: [], total: -1, limit: 20, offset: 20 })).mockResolvedValueOnce(response({ items: [], total: 0, limit: 20, offset: 20 }))
    const client = createWeldingPlanClient(transport)
    await expect(client.listReviewGenerations('plan', 'v1', 20)).rejects.toThrow()
    await expect(client.listReviewGenerations('plan', 'v1', 20)).resolves.toEqual({ items: [], total: 0, limit: 20, offset: 20 })
  })
  it('C3 root follow-up rejects nonempty pages beyond total while allowing a real empty page beyond total', () => {
    const directory = { schema: 'yuantus.welding_publication_directory/1', plan_id: 'plan', total: 1, limit: 20, offset: 20, items: [entry('v1')], current_publication: null }
    expect(() => validatePublicationDirectory(directory, 'plan', 20)).toThrow()
    expect(validatePublicationDirectory({ ...directory, items: [] }, 'plan', 20).items).toEqual([])
  })
  it('C3 root follow-up binds nonempty review-history pages to offset plus actual rows', () => {
    const history = { schema: 'yuantus.welding_review_history/1', plan_id: 'plan', item_version_id: 'v1', total: 1, limit: 50, offset: 20, items: [{ event_id: 'event', approval: null, action: 'created', from_state: null, to_state: 'Draft', note: null, actor: { auth_user_id: owner.auth_user_id, rbac_user_id: owner.rbac_user_id, display_name: '作者' }, created_at: '2026-10-09T00:00:00Z' }] }
    expect(() => validateWorkflowHistory(history, 'plan', 'v1', owner, 20)).toThrow()
    expect(validateWorkflowHistory({ ...history, items: [] }, 'plan', 'v1', owner, 20).items).toEqual([])
  })
  it('reads a real limit20 page with independent current and validates comparison categories only', async () => {
    const directory = { schema: 'yuantus.welding_publication_directory/1', plan_id: 'plan', total: 51, limit: 20, offset: 20, items: [entry('v2'), entry('v1')], current_publication: entry('v3', 'Released') }
    expect(validatePublicationDirectory(directory, 'plan', 20).current_publication?.item_version_id).toBe('v3')
    const side = (version: string) => { const { state: _state, published_at: _date, ...fixed } = entry(version); return fixed }
    const comparison = { schema: 'yuantus.welding_publication_comparison/1', plan_id: 'plan', from: side('v1'), to: side('v2'), summary: { added: 0, removed: 0, changed: 1, unchanged: 0 }, welds: [{ weld_id: 'w1', kind: 'changed', changed_fields: ['parameters', 'geometry'] }], plan_changes: ['drawing'] }
    expect(validatePublicationComparison(comparison, 'plan', 'v1', 'v2')).toEqual(comparison)
    for (const patch of [{ limit: 51 }, { items: [entry('v1'), entry('v1')] }, { current_publication: entry('v2', 'Released') }]) expect(() => validatePublicationDirectory({ ...directory, ...patch }, 'plan', 20)).toThrow()
    for (const patch of [{ from: side('wrong') }, { summary: { ...comparison.summary, changed: 2 } }, { welds: [{ ...comparison.welds[0], old_value: 1 }] }, { plan_changes: ['overlay', 'drawing'] }]) expect(() => validatePublicationComparison({ ...comparison, ...patch }, 'plan', 'v1', 'v2')).toThrow()
    const transport = vi.fn().mockResolvedValueOnce(response(directory)).mockResolvedValueOnce(response(comparison)), client = createWeldingPlanClient(transport)
    await client.readPublications('plan', 20); await client.comparePublications('plan', 'v1', 'v2')
    expect(transport.mock.calls.map(c => c[0])).toEqual(['/api/welding/plans/plan/publications?limit=20&offset=20', '/api/welding/plans/plan/publication-comparison?from_version_id=v1&to_version_id=v2'])
  })
})

describe('F18b P2 finite read-only reuse selection client', () => {
  const product = { item_id: 'part/焊?+%&', version_id: 'version/一?+%&', version_label: '历史版', name: 'Frame', number: 'P1' }
  const bom = { baseline_id: 'bom/焊?+%&', fingerprint: 'a'.repeat(64), name: 'Assembly', number: 'B1' }
  beforeEach(() => localStorage.setItem('auth_token', 'session-A'))
  // These named methods are the accepted new API; an absent method must fail a positive read.
  const selection = (transport: ReturnType<typeof vi.fn>) => createWeldingPlanClient(transport) as ReturnType<typeof createWeldingPlanClient> & {
    reuseProductCandidates(query: string): Promise<typeof product[]>
    reuseProductContext(pair: { item_id: string; version_id: string }): Promise<typeof product>
    reuseBomCandidates(pair: { item_id: string; version_id: string }): Promise<typeof bom[]>
  }
  it('uses three fixed GETs with source IDs as values, exact metadata and no original-body mutation', async () => {
    const transport = vi.fn().mockResolvedValueOnce(response({ items: [product] }))
      .mockResolvedValueOnce(response({ schema: 'yuantus.welding_plan_entry/1', product }))
      .mockResolvedValueOnce(response({ items: [bom] }))
    const client = selection(transport), source = structuredClone(payload), before = JSON.stringify(source)
    expect(await client.reuseProductCandidates('焊?+%&')).toEqual([product])
    expect(await client.reuseProductContext(product)).toEqual(product)
    expect(await client.reuseBomCandidates(product)).toEqual([bom])
    const urls = transport.mock.calls.map(call => new URL(call[0], 'https://frontend.invalid'))
    expect(urls.map(url => url.pathname)).toEqual(['/api/welding/plans/reuse-product-candidates', '/api/welding/plans/reuse-product-context', '/api/welding/plans/reuse-bom-candidates'])
    expect(urls[0].searchParams.get('query')).toBe('焊?+%&')
    for (const url of urls.slice(1)) expect(Object.fromEntries(url.searchParams)).toEqual({ product_id: product.item_id, product_version_id: product.version_id })
    for (const [, options] of transport.mock.calls) { expect(options).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error' }); expect(options.body).toBeUndefined() }
    expect(JSON.stringify(source)).toBe(before)
    transport.mockClear()
    await expect(client.productContext(product)).rejects.toThrow()
    expect(transport).not.toHaveBeenCalled()
  })
  it('counts Unicode codepoints at exact ID/query/metadata bounds and preserves Python-nonspace BOM', async () => {
    const fixed = { ...product, item_id: '😀'.repeat(64), version_id: '\u0001'.repeat(64), version_label: '😀'.repeat(64), name: '😀'.repeat(256), number: '😀'.repeat(128) }
    const assembly = { ...bom, baseline_id: '😀'.repeat(64), name: '😀'.repeat(256), number: '😀'.repeat(256) }
    const twentyProducts = Array.from({ length: 20 }, (_, i) => ({ ...fixed, version_id: '😀'.repeat(62) + String(i).padStart(2, '0') }))
    const twentyBoms = Array.from({ length: 20 }, (_, i) => ({ ...assembly, baseline_id: '😀'.repeat(62) + String(i).padStart(2, '0') }))
    const transport = vi.fn().mockResolvedValueOnce(response({ items: [fixed] }))
      .mockResolvedValueOnce(response({ items: twentyProducts }))
      .mockResolvedValueOnce(response({ schema: 'yuantus.welding_plan_entry/1', product: fixed }))
      .mockResolvedValueOnce(response({ items: twentyBoms }))
    const client = selection(transport)
    expect(await client.reuseProductCandidates('😀'.repeat(100))).toEqual([fixed])
    expect(await client.reuseProductCandidates('\ufeffframe')).toEqual(twentyProducts)
    expect(await client.reuseProductContext(fixed)).toEqual(fixed)
    expect(await client.reuseBomCandidates(fixed)).toEqual(twentyBoms)
  })
  it.each(['', ' space', 'line\nbreak', 'nul\0', '\ud800', '😀'.repeat(65), '\u001cpart', 'part\u0085'])('rejects invalid source pair %j after positive controls without dispatch', async bad => {
    const transport = vi.fn().mockResolvedValueOnce(response({ schema: 'yuantus.welding_plan_entry/1', product }))
      .mockResolvedValueOnce(response({ items: [bom] }))
    const client = selection(transport)
    expect(await client.reuseProductContext(product)).toEqual(product)
    expect(await client.reuseBomCandidates(product)).toEqual([bom])
    transport.mockClear()
    for (const pair of [{ item_id: bad, version_id: product.version_id }, { item_id: product.item_id, version_id: bad }]) {
      await expect(client.reuseProductContext(pair)).rejects.toThrow()
      await expect(client.reuseBomCandidates(pair)).rejects.toThrow()
    }
    expect(transport).not.toHaveBeenCalled()
  })
  it.each(['', ' frame', 'frame\u0085', 'line\nbreak', '\ud800', '😀'.repeat(101)])('rejects invalid reuse query %j after a positive read without dispatch', async query => {
    const transport = vi.fn().mockResolvedValue(response({ items: [product] })), client = selection(transport)
    expect(await client.reuseProductCandidates('frame')).toEqual([product]); transport.mockClear()
    await expect(client.reuseProductCandidates(query)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled()
  })
  it.each(['product-extra', 'product-missing', 'product-name', 'product-number', 'product-label', 'product-type', 'product-duplicate', 'product-count', 'context-pair', 'context-schema', 'bom-extra', 'bom-hash', 'bom-duplicate', 'bom-count', 'bom-name', 'bom-id'])('rejects malformed %s after that method succeeds', async damage => {
    const kind = damage.startsWith('bom-') ? 'bom' : damage.startsWith('context-') ? 'context' : 'product'
    let bad: unknown
    if (kind === 'product') {
      let items: unknown[] = [{ ...product }]
      if (damage === 'product-extra') items = [{ ...product, private_path: '/hidden' }]
      if (damage === 'product-missing') { const { version_label: _label, ...missing } = product; items = [missing] }
      if (damage === 'product-name') items = [{ ...product, name: '😀'.repeat(257) }]
      if (damage === 'product-number') items = [{ ...product, number: 'x'.repeat(129) }]
      if (damage === 'product-label') items = [{ ...product, version_label: 'x'.repeat(65) }]
      if (damage === 'product-type') items = [{ ...product, name: 4 }]
      if (damage === 'product-duplicate') items = [product, { ...product }]
      if (damage === 'product-count') items = Array.from({ length: 21 }, (_, i) => ({ ...product, version_id: 'v' + i }))
      bad = { items }
    } else if (kind === 'context') bad = { schema: damage === 'context-schema' ? 'unknown' : 'yuantus.welding_plan_entry/1', product: { ...product, ...(damage === 'context-pair' ? { version_id: 'other' } : {}) } }
    else {
      let items: unknown[] = [{ ...bom }]
      if (damage === 'bom-extra') items = [{ ...bom, occurrences: [] }]
      if (damage === 'bom-hash') items = [{ ...bom, fingerprint: 'A'.repeat(64) }]
      if (damage === 'bom-duplicate') items = [bom, { ...bom }]
      if (damage === 'bom-count') items = Array.from({ length: 21 }, (_, i) => ({ ...bom, baseline_id: 'b' + i }))
      if (damage === 'bom-name') items = [{ ...bom, name: 'x'.repeat(257) }]
      if (damage === 'bom-id') items = [{ ...bom, baseline_id: 'x'.repeat(65) }]
      bad = { items }
    }
    const good = kind === 'bom' ? { items: [bom] } : kind === 'context' ? { schema: 'yuantus.welding_plan_entry/1', product } : { items: [product] }
    const transport = vi.fn().mockResolvedValueOnce(response(good)).mockResolvedValueOnce(response(bad)), client = selection(transport)
    const read = () => kind === 'bom' ? client.reuseBomCandidates(product) : kind === 'context' ? client.reuseProductContext(product) : client.reuseProductCandidates('frame')
    expect(await read()).toEqual(kind === 'bom' ? [bom] : kind === 'context' ? product : [product])
    await expect(read()).rejects.toThrow(); expect(transport).toHaveBeenCalledTimes(2)
  })
})

describe('fixed joint diagram bounded binary client', () => {
  const bytes = new TextEncoder().encode('qualified-image-bytes')
  const sha = createHash('sha256').update(bytes).digest('hex')
  const fixed = () => ({ resource_id: 'diagram', item_version_id: 'diagram-v1', name: 'Joint', number: 'J1', kind: 'joint_diagram' as const, content_hash: 'a'.repeat(64), state: 'Draft', version_label: 'A',
    payload: { schema_version: 1 as const, kind: 'joint_diagram' as const, suggested_fields: {}, document: { item_id: 'doc', version_id: 'dv', file_id: 'f', file_role: 'reference' as const, expected_fingerprint: 'c'.repeat(64) } },
    sources: { document: { item_id: 'doc', version_id: 'dv', file_id: 'f', file_role: 'reference', fingerprint: 'c'.repeat(64), checksum: sha, title: 'Joint', file_name: 'joint.png', version_label: 'A', state: 'Released', is_released: true },
      diagram: { schema: 'yuantus.welding_joint_diagram/1', actual_sha256: sha, byte_size: bytes.length, mime_type: 'image/png', format: 'png', width: 2, height: 3, exif_orientation: 6 } } })
  const headers = () => ({ 'Content-Type': 'image/png', 'Content-Length': String(bytes.length), 'X-Content-SHA256': sha })
  const auth = (value = owner) => response({ schema: 'yuantus.welding_generation_authority/1', owner: value })
  beforeEach(() => { localStorage.setItem('auth_token', 'diagram-native'); vi.stubGlobal('crypto', webcrypto) })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
  it('uses only the fixed version binary route and verifies bytes between fresh owner checks', async () => {
    const transport = vi.fn().mockResolvedValueOnce(auth()).mockResolvedValueOnce(new Response(bytes, { headers: headers() })).mockResolvedValueOnce(auth())
    const result = await createWeldingPlanClient(transport).readResourceDiagram(fixed())
    expect(result.size).toBe(bytes.length); expect(result.type).toBe('image/png')
    expect(transport.mock.calls.map(call => call[0])).toEqual(['/api/welding/authority', '/api/welding/resources/diagram/versions/diagram-v1/diagram', '/api/welding/authority'])
    expect(transport.mock.calls[1][1]).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store', suppressUnauthorizedRedirect: true })
  })
  it.each(['kind', 'descriptor', 'route'])('rejects invalid %s before transport', async wrong => {
    const value = fixed()
    if (wrong === 'kind') Object.assign(value, { kind: 'material' })
    if (wrong === 'descriptor') value.sources.diagram.byte_size = 5 * 1024 * 1024 + 1
    if (wrong === 'route') value.resource_id = 'a/b'
    const transport = vi.fn(); await expect(createWeldingPlanClient(transport).readResourceDiagram(value)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled()
  })
  it.each(['mime', 'declared-length', 'header-sha', 'actual-sha', 'short', 'long', 'encoding', 'status'])('rejects %s and never returns a Blob', async wrong => {
    const h: Record<string, string> = headers(); let body = bytes
    if (wrong === 'mime') h['Content-Type'] = 'image/svg+xml'
    if (wrong === 'declared-length') h['Content-Length'] = '1'
    if (wrong === 'header-sha') h['X-Content-SHA256'] = 'b'.repeat(64)
    if (wrong === 'actual-sha') body = new Uint8Array(bytes.length)
    if (wrong === 'short') body = bytes.slice(1)
    if (wrong === 'long') body = new Uint8Array(bytes.length + 1)
    if (wrong === 'encoding') h['Content-Encoding'] = 'gzip'
    const transport = vi.fn().mockResolvedValueOnce(auth()).mockResolvedValueOnce(new Response(body, { headers: h, status: wrong === 'status' ? 201 : 200 }))
    await expect(createWeldingPlanClient(transport).readResourceDiagram(fixed())).rejects.toThrow()
    expect(transport).toHaveBeenCalledTimes(2)
  })
  it('rejects same-token owner drift after complete bytes', async () => {
    const transport = vi.fn().mockResolvedValueOnce(auth()).mockResolvedValueOnce(new Response(bytes, { headers: headers() })).mockResolvedValueOnce(auth({ ...owner, rbac_user_id: 20 }))
    await expect(createWeldingPlanClient(transport).readResourceDiagram(fixed())).rejects.toThrow('身份')
  })
  it('rejects a late response after selection invalidation or token replacement', async () => {
    let finish!: (value: Response) => void, current = true
    const transport = vi.fn().mockResolvedValueOnce(auth()).mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
    const job = createWeldingPlanClient(transport).readResourceDiagram(fixed(), { accepts: () => current })
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2)); current = false
    const assertion = expect(job).rejects.toThrow(); finish(new Response(bytes, { headers: headers() })); await assertion
    const changed = vi.fn().mockResolvedValueOnce(auth()).mockImplementationOnce(async () => { localStorage.setItem('auth_token', 'another'); return new Response(bytes, { headers: headers() }) })
    await expect(createWeldingPlanClient(changed).readResourceDiagram(fixed())).rejects.toThrow()
  })
  it.each(['authority', 'body', 'final-authority'])('bounds the whole operation while %s never completes', async stage => {
    vi.useFakeTimers(); const cancel = vi.fn()
    const transport = vi.fn().mockImplementation((path: string): Promise<Response> => {
      if (path.endsWith('/authority')) return stage === 'authority' || stage === 'final-authority' && transport.mock.calls.length === 3 ? new Promise<Response>(() => {}) : Promise.resolve(auth())
      return Promise.resolve(new Response(stage === 'body' ? new ReadableStream({ cancel }) : bytes, { headers: headers() }))
    })
    const job = createWeldingPlanClient(transport).readResourceDiagram(fixed()), assertion = expect(job).rejects.toThrow('30 秒')
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(stage === 'authority' ? 1 : stage === 'body' ? 2 : 3))
    await vi.advanceTimersByTimeAsync(30001); await assertion
    if (stage === 'body') expect(cancel).toHaveBeenCalled()
  })
})
