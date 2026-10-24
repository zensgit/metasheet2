import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWeldingPlanClient, validateAssemblyPreview, validateBomProjection, validateSaveAck } from '../src/services/welding/planClient'
import { clone, validatePayload, validateRecovery, type AssemblySide, type PlanPayload, type PlanRecoveryRecord } from '../src/services/welding/planRecovery'

const hash = 'a'.repeat(64), from = 'b'.repeat(64), to = 'c'.repeat(64)
const owner = { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }
const product = { item_id: 'product', version_id: 'product-v1' }
const side = (path: string[]): AssemblySide => ({ role: '人工命名侧', path, item_id: 'same-part', version_id: 'part-v1' })
const payload = (): PlanPayload => ({ schema_version: 1, product, drawing: { item_id: 'drawing', version_id: 'drawing-v1', file_id: 'file', file_role: 'drawing', expected_checksum: 'D'.repeat(64) },
  assembly_format: 'yuantus.welding_assembly/1', bom: { baseline_id: 'new-bom', expected_fingerprint: to }, welds: [{ weld_id: 'w1', display_no: '1', assembly: { a: side(['rel-a']), b: side(['rel-b']) } }] })
const body = () => ({ expected_draft_seq: 2, save_id: '00000000-0000-4000-8000-000000000002', payload: payload(), assembly_change: { expected_content_hash: hash, from_fingerprint: from, to_fingerprint: to } })
const record = (): PlanRecoveryRecord => ({ schema: 'yuantus.welding_plan_recovery/1', recovery_id: '00000000-0000-4000-8000-000000000001', updated_at: 1, owner,
  draft: { plan_id: 'plan?=+&', version_id: 'v1', base_draft_seq: 2, base_content_hash: hash, name: 'Plan', number: 'W1', payload: payload() },
  pending: { method: 'POST', path: '/plan%3F%3D%2B%26/versions/v1/assembly-apply', body: body(), local_ahead: false } })
// Candidate Y model_dump fixture; the companion oracle script must verify this before claiming qualification.
const canonical = (): PlanPayload => ({ ...payload(), process_refs: [], drawing: { ...payload().drawing!, expected_checksum: 'd'.repeat(64) },
  welds: [{ ...payload().welds[0], location: '', joint_type: '', method: '', material_a: '', material_b: '', filler: '', thickness_a: null, thickness_b: null,
    manufacturing_length: null, measured_length: null, welding_requirements: '', inspection_requirements: '', passes: [] }] })
const ack = () => ({ plan_id: 'plan?=+&', item_version_id: 'v1', draft_seq: 3, content_hash: 'e'.repeat(64), name: 'Plan', number: 'W1', state: 'Draft', version_label: 'A', payload: canonical(), sources: {} })
const bom = () => ({ baseline_id: 'bom', fingerprint: to, name: '装配', number: '', captured_depth: 50,
  root: { path: [], ...product, name: '', number: '', version_label: '' },
  occurrences: ['rel-a', 'rel-b'].map(rel => ({ path: [rel], item_id: 'same-part', version_id: 'part-v1', name: '', number: '', version_label: '', quantity: '1e1000', uom: '', find_number: '' })) })
const view = () => ({ sides: { a: { selection: side(['rel-a']), facts: null, provenance: null, unknown: ['missing_occurrence', 'missing_witness'] },
  b: { selection: side(['rel-b']), facts: { path: ['rel-b'], item_id: 'same-part', version_id: 'part-v1', quantity: '1', uom: '', find_number: '' }, provenance: null, unknown: ['missing_witness'] } }, unknown: ['missing_occurrence', 'missing_witness'] })
const preview = () => ({ schema: 'yuantus.welding_assembly_preview/1', plan_id: 'plan?=+&', item_version_id: 'v1', draft_seq: 2, content_hash: hash,
  from_fingerprint: from, to_fingerprint: to, affected_welds: [{ weld_id: 'w1', reason_codes: ['assembly_adopted', 'missing_occurrence', 'missing_witness'], before: null, after: view(), state: 'unknown' }] })
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
beforeEach(() => localStorage.setItem('auth_token', 'session-A'))

describe('F18 assembly original codec and acknowledgement', () => {
  it('retains exact POST path, full original body and omission of missing witnesses', () => {
    const original = record(); expect(validateRecovery(original)).toEqual(original)
    expect(validateSaveAck(ack(), original).draft_seq).toBe(3)
    expect(Object.hasOwn(ack(), 'save_id')).toBe(false)
    expect(Object.hasOwn(side(['rel-a']), 'witness')).toBe(false)
  })
  it.each([
    { method: 'PUT', path: '/plan%3F%3D%2B%26/versions/v1/assembly-apply' },
    { path: '/plan%3F%3D%2B%26/versions/v1/assembly-preview' }, { path: '/plan%3F%3D%2B%26/versions/v1/assembly-apply?x=1' },
    { path: '/plan%3F%3D%2B%26/versions/v1/assembly-apply/' }, { path: '/plan%253F%253D%252B%2526/versions/v1/assembly-apply' },
  ])('rejects an altered transport envelope %s', patch => { const value = record(); Object.assign(value.pending!, patch); expect(() => validateRecovery(value)).toThrow() })
  it.each(['missing', 'null', 'seq', 'hash', 'source', 'review', 'cancel', 'extra'])('rejects %s apply before transport', async kind => {
    const value = record(), command = { ...body().assembly_change }
    if (kind === 'missing') delete value.pending!.body.assembly_change
    else if (kind === 'null') value.pending!.body.assembly_change = null
    else if (kind === 'seq') value.pending!.body.expected_draft_seq = 3
    else if (kind === 'hash') value.pending!.body.assembly_change = { ...command, expected_content_hash: 'f'.repeat(64) }
    else value.pending!.body[kind === 'source' ? 'source_change' : kind === 'review' ? 'review_resolution' : kind === 'cancel' ? 'assembly_cancel' : 'extra'] = {}
    const transport = vi.fn(); await expect(createWeldingPlanClient(transport).save(value)).rejects.toThrow(); expect(transport).not.toHaveBeenCalled()
  })
  it.each([{ witness_id: 'manual', source: 'manual' }, { witness_id: 'manual', source: 'manual', material: '人工声明' }, { witness_id: 'manual', source: 'manual', thickness: { value: 2, unit: 'in' } }])('preserves lawful partial witness %s without inserting null', witness => {
    const value = payload(); value.welds[0].assembly = { a: { ...side(['rel-a']), witness }, b: side(['rel-b']) }
    expect(validatePayload(value)).toEqual(value)
  })
  it.each([null, { witness_id: 'manual', source: 'manual', material: null }, { witness_id: 'manual', source: 'manual', thickness: null },
    { witness_id: 'manual', source: 'automatic' }, { witness_id: 'manual', source: 'manual', thickness: { value: 1, unit: ['mm'] } },
    { witness_id: 'manual', source: 'manual', thickness: { value: 1, unit: ['in'] } },
    { witness_id: 'manual', source: 'manual', thickness: { value: 1, unit: { value: 'mm' } } },
    { witness_id: 'manual', source: 'manual', thickness: { value: 1, unit: 1 } },
    { witness_id: 'manual', source: 'manual', thickness: { value: 0, unit: 'mm' } },
    { witness_id: 'manual', source: 'manual', thickness: { value: Infinity, unit: 'mm' } }])('rejects invalid witness %s', witness => {
    const value = payload(); value.welds[0].assembly = { a: { ...side(['rel-a']), witness }, b: side(['rel-b']) }
    expect(() => validatePayload(value)).toThrow()
  })
  it('allows same item in two full paths but rejects equal paths and null format', () => {
    const value = payload(); expect(validatePayload(value)).toEqual(value)
    value.welds[0].assembly = { a: side(['rel-a']), b: side(['rel-a']) }; expect(() => validatePayload(value)).toThrow()
    value.welds = []; value.assembly_format = null; expect(() => validatePayload(value)).toThrow()
  })
  it.each(['adopt', 'same-bom', 'cancel'])('keeps %s as PUT draft and checks canonical full payload', kind => {
    const value = record(); value.pending!.method = 'PUT'; value.pending!.path = '/plan%3F%3D%2B%26/versions/v1/draft'; delete value.pending!.body.assembly_change
    const result = ack()
    if (kind === 'cancel') {
      const selected = payload(); delete selected.welds[0].assembly
      value.pending!.body.payload = selected; value.pending!.body.assembly_cancel = { weld_id: 'w1', reason: '明确取消' }; delete result.payload.welds[0].assembly
    }
    expect(validateRecovery(value)).toEqual(value); expect(validateSaveAck(result, value).draft_seq).toBe(3)
    result.payload.welds[0].material_a = 'unrequested'; expect(() => validateSaveAck(result, value)).toThrow()
  })
  it.each(['seq', 'plan', 'version', 'state', 'witness-null', 'body'])('retains original on malformed %s ACK', kind => {
    const original = record(), before = JSON.stringify(original), result = ack()
    if (kind === 'seq') result.draft_seq = 1
    else if (kind === 'plan') result.plan_id = 'other'
    else if (kind === 'version') result.item_version_id = 'other'
    else if (kind === 'state') result.state = 'Released'
    else if (kind === 'witness-null') result.payload.welds[0].assembly = { a: { ...side(['rel-a']), witness: null }, b: side(['rel-b']) }
    else result.payload.welds[0].material_a = 'changed'
    expect(() => validateSaveAck(result, original)).toThrow(); expect(JSON.stringify(original)).toBe(before)
  })
  it('uses POST apply 200 and POST create 201 while rejecting each wrong status', async () => {
    const original = record(), create = record(), plain = payload(); delete plain.assembly_format; plain.welds = []
    Object.assign(create.draft, { version_id: null, base_draft_seq: 0, base_content_hash: null, payload: plain })
    create.pending = { method: 'POST', path: '', body: { plan_id: create.draft.plan_id, name: 'Plan', number: 'W1', save_id: 'same-create', payload: plain }, local_ahead: false }
    const created = { ...ack(), draft_seq: 1, payload: plain }, transport = vi.fn().mockResolvedValueOnce(response(ack())).mockResolvedValueOnce(response(created, 201))
    await createWeldingPlanClient(transport).save(original); await createWeldingPlanClient(transport).save(create)
    expect(transport.mock.calls.map(call => [call[0], call[1].method, call[1].body])).toEqual([
      ['/api/welding/plans/plan%3F%3D%2B%26/versions/v1/assembly-apply', 'POST', JSON.stringify(original.pending!.body)], ['/api/welding/plans', 'POST', JSON.stringify(create.pending!.body)],
    ])
    for (const [value, result, status] of [[original, ack(), 201], [create, created, 200]] as const) {
      const before = JSON.stringify(value); await expect(createWeldingPlanClient(vi.fn().mockResolvedValue(response(result, status))).save(value)).rejects.toThrow(); expect(JSON.stringify(value)).toBe(before)
    }
  })
})

describe('F18 exact BOM and read-only preview response', () => {
  it('retains two same-item positions, full facts, depth -1/50 and raw quantity text', async () => {
    for (const captured_depth of [-1, 50]) expect(validateBomProjection({ ...bom(), captured_depth }, product).occurrences).toHaveLength(2)
    const transport = vi.fn().mockResolvedValue(response({ items: [bom()] })); expect(await createWeldingPlanClient(transport).bomCandidates(product)).toEqual([bom()])
  })
  it.each(['root', 'duplicate', 'parent', 'path', 'count', 'extra'])('rejects malformed %s projection', kind => {
    const value = bom()
    if (kind === 'root') value.root.item_id = 'other'
    else if (kind === 'duplicate') value.occurrences[1].path = ['rel-a']
    else if (kind === 'parent') value.occurrences[1].path = ['missing', 'nested']
    else if (kind === 'path') value.occurrences[1].path = Array(21).fill('rel')
    else if (kind === 'count') value.occurrences = Array.from({ length: 1000 }, (_, i) => ({ ...value.occurrences[0], path: [`rel-${i}`] }))
    else Object.assign(value, { extra: true })
    expect(() => validateBomProjection(value, product)).toThrow()
  })
  function boundedProjection(bytes = 1024 * 1024, index = 0) {
    const value = bom(); value.baseline_id = `bom-${String(index).padStart(2, '0')}`
    value.occurrences = Array.from({ length: 999 }, (_, i) => ({ ...value.occurrences[0], path: [`rel-${i}`], name: '', number: '', uom: '', find_number: '' }))
    let remaining = bytes - new TextEncoder().encode(JSON.stringify(value)).byteLength
    for (const row of value.occurrences) for (const key of ['name', 'number', 'uom', 'find_number'] as const) {
      const amount = Math.min(256, remaining); row[key] = 'x'.repeat(amount); remaining -= amount
    }
    if (remaining !== 0) throw new Error('Boundary fixture exceeds its lawful metadata capacity')
    return value
  }
  it('accepts exact UTF8 1 MiB projections and the full legal 20-projection envelope', async () => {
    const items = Array.from({ length: 20 }, (_, i) => boundedProjection(1024 * 1024, i))
    expect(new TextEncoder().encode(JSON.stringify(items[0])).byteLength).toBe(1024 * 1024)
    const raw = JSON.stringify({ items }); expect(new TextEncoder().encode(raw).byteLength).toBe(20 * 1024 * 1024 + 31)
    const transport = vi.fn().mockResolvedValue(new Response(raw, { status: 200 }))
    expect(await createWeldingPlanClient(transport).bomCandidates(product)).toHaveLength(20)
  })
  it('rejects 21 choices, duplicate baselines and one projection above 1 MiB', async () => {
    for (const items of [Array.from({ length: 21 }, (_, i) => ({ ...bom(), baseline_id: `bom-${i}` })), [bom(), bom()], [boundedProjection(1024 * 1024 + 1)]]) {
      await expect(createWeldingPlanClient(vi.fn().mockResolvedValue(response({ items }))).bomCandidates(product)).rejects.toThrow()
    }
  })
  it('rejects declared and streamed bytes above 21 MiB for a 20-choice transport', async () => {
    const items = Array.from({ length: 20 }, (_, i) => boundedProjection(1024 * 1024, i)), raw = JSON.stringify({ items }), limit = 21 * 1024 * 1024
    await expect(createWeldingPlanClient(vi.fn().mockResolvedValue(new Response(raw, { headers: { 'content-length': String(limit + 1) } }))).bomCandidates(product)).rejects.toThrow()
    const padded = raw + ' '.repeat(limit + 1 - new TextEncoder().encode(raw).byteLength)
    await expect(createWeldingPlanClient(vi.fn().mockResolvedValue(new Response(padded))).bomCandidates(product)).rejects.toThrow()
  })
  it('does not deduplicate affected same-item welds and allows union of old/new 500-weld payloads', () => {
    const row = preview().affected_welds[0], requested = body()
    requested.payload.welds = Array.from({ length: 500 }, (_, i) => ({ ...requested.payload.welds[0], weld_id: `new-${i}`, display_no: String(i + 1) }))
    const value = { ...preview(), affected_welds: [
      ...Array.from({ length: 500 }, (_, i) => ({ ...row, weld_id: `new-${i}` })),
      ...Array.from({ length: 500 }, (_, i) => ({ ...row, weld_id: `old-${i}`, reason_codes: ['weld_removed'], state: 'known', before: view(), after: null })),
    ] }
    expect(validateAssemblyPreview(value, record().draft.plan_id, 'v1', requested).affected_welds).toHaveLength(1000)
  })
  it.each(['known', 'unknown'])('rejects array-valued %s state even when after is null', state => {
    const value = preview(), requested = body(); delete requested.payload.welds[0].assembly
    Object.assign(value.affected_welds[0], { before: view(), after: null, reason_codes: ['assembly_cancelled'], state: [state] })
    expect(() => validateAssemblyPreview(value, record().draft.plan_id, 'v1', requested)).toThrow()
  })
  it('rejects null after for an original weld that still has an assembly', () => {
    const value = preview(); Object.assign(value.affected_welds[0], { after: null, state: 'known' })
    expect(() => validateAssemblyPreview(value, record().draft.plan_id, 'v1', body())).toThrow()
  })
  it('rejects a nonnull after view for an original weld without an assembly', () => {
    const requested = body(); delete requested.payload.welds[0].assembly
    expect(() => validateAssemblyPreview(preview(), record().draft.plan_id, 'v1', requested)).toThrow()
  })
  it.each(['cancelled', 'removed'])('allows null after for a lawfully %s association', kind => {
    const requested = body(), value = preview()
    if (kind === 'removed') requested.payload.welds = []
    else delete requested.payload.welds[0].assembly
    Object.assign(value.affected_welds[0], { before: view(), after: null, reason_codes: [kind === 'removed' ? 'weld_removed' : 'assembly_cancelled'], state: 'known' })
    expect(validateAssemblyPreview(value, record().draft.plan_id, 'v1', requested)).toEqual(value)
  })
  it('retains an after view with null facts when the selected occurrences are missing', () => {
    const value = preview(), after = view()
    Object.assign(after.sides.b, { facts: null, unknown: ['missing_occurrence', 'missing_witness'] })
    Object.assign(value.affected_welds[0], { after })
    expect(validateAssemblyPreview(value, record().draft.plan_id, 'v1', body())).toEqual(value)
  })
  it('allows the actual stage missing_mapping row with null before and after', () => {
    const requested = body(); delete requested.payload.welds[0].assembly
    const value = preview(); Object.assign(value.affected_welds[0], { reason_codes: ['missing_mapping'], before: null, after: null, state: 'unknown' })
    expect(validateAssemblyPreview(value, record().draft.plan_id, 'v1', requested)).toEqual(value)
  })
  it.each(['role', 'path', 'item', 'version', 'witness-added', 'witness-omitted', 'material-omitted', 'weld', 'assembly-missing'])('rejects unrequested after selection %s', kind => {
    const value = preview(), requested = body(), selected = value.affected_welds[0].after.sides.a.selection
    if (kind === 'role') selected.role = '另一个角色'
    else if (kind === 'path') selected.path = ['different-position']
    else if (kind === 'item') selected.item_id = 'different-part'
    else if (kind === 'version') selected.version_id = 'different-version'
    else if (kind === 'witness-added') selected.witness = { witness_id: 'added', source: 'manual' }
    else if (kind === 'witness-omitted' || kind === 'material-omitted') {
      requested.payload.welds[0].assembly = { a: { ...side(['rel-a']), witness: { witness_id: 'original', source: 'manual', material: '人工声明' } }, b: side(['rel-b']) }
      if (kind === 'material-omitted') selected.witness = { witness_id: 'original', source: 'manual' }
    } else if (kind === 'weld') value.affected_welds[0].weld_id = 'not-requested'
    else delete requested.payload.welds[0].assembly
    expect(() => validateAssemblyPreview(value, record().draft.plan_id, 'v1', requested)).toThrow()
  })
  it('binds pending after selections while allowing lawful old before selections', () => {
    const value = preview(), before = view()
    before.sides.a.selection = { ...side(['old-position']), role: '旧角色', item_id: 'old-part', version_id: 'old-version', witness: { witness_id: 'old-witness', source: 'manual', material: '旧声明' } }
    Object.assign(value.affected_welds[0], { before })
    expect(validateAssemblyPreview(value, record().draft.plan_id, 'v1', body())).toEqual(value)
  })
  it.each(['plan', 'version', 'seq', 'hash', 'from', 'to', 'duplicate', 'state', 'view', 'unknown'])('rejects mismatched %s preview', kind => {
    const value = preview()
    if (kind === 'plan') value.plan_id = 'other'
    else if (kind === 'version') value.item_version_id = 'other'
    else if (kind === 'seq') value.draft_seq++
    else if (kind === 'hash') value.content_hash = 'f'.repeat(64)
    else if (kind === 'from') value.from_fingerprint = 'f'.repeat(64)
    else if (kind === 'to') value.to_fingerprint = 'f'.repeat(64)
    else if (kind === 'duplicate') value.affected_welds.push(clone(value.affected_welds[0]))
    else if (kind === 'state') value.affected_welds[0].state = 'known'
    else if (kind === 'view') value.affected_welds[0].after.sides.b.facts.path = ['wrong']
    else value.affected_welds[0].after.unknown = []
    expect(() => validateAssemblyPreview(value, record().draft.plan_id, 'v1', body())).toThrow()
  })
  it('calls only fixed POST preview with unchanged body and does not dispatch apply', async () => {
    const original = record(), before = JSON.stringify(original), transport = vi.fn().mockResolvedValue(response(preview()))
    expect(await createWeldingPlanClient(transport).assemblyPreview(original)).toEqual(preview())
    expect(transport).toHaveBeenCalledOnce(); expect(transport.mock.calls[0][0]).toBe('/api/welding/plans/plan%3F%3D%2B%26/versions/v1/assembly-preview')
    expect(transport.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify(original.pending!.body), cache: 'no-store' }); expect(JSON.stringify(original)).toBe(before)
  })
})
