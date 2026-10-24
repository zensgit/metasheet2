import { describe, expect, it } from 'vitest'
import { validateRecovery, type PlanPayload, type PlanRecoveryRecord } from '../src/services/welding/planRecovery'
import { validateSaveAck } from '../src/services/welding/planClient'

function fixture(schema: string | null = null) {
  const owner = { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }
  const payload: PlanPayload = { schema_version: 1, product: { item_id: 'part', version_id: 'pv' }, drawing: { item_id: 'drawing', version_id: 'dv', file_id: 'old', file_role: 'native_cad', expected_checksum: 'a'.repeat(64) }, welds: [], bom: null, process_refs: [], ...(schema ? { overlay: { schema } } : {}) }
  const next = { ...structuredClone(payload), drawing: { ...payload.drawing!, file_id: 'next', expected_checksum: 'b'.repeat(64) } }
  const original: PlanRecoveryRecord = { schema: 'yuantus.welding_plan_recovery/1', recovery_id: '00000000-0000-4000-8000-000000000001', updated_at: 1, owner,
    draft: { plan_id: 'plan', version_id: 'v', base_draft_seq: 2, base_content_hash: 'c'.repeat(64), name: 'Plan', number: 'W1', payload },
    pending: { method: 'PUT', path: '/plan/versions/v/draft', local_ahead: false, body: { expected_draft_seq: 2, save_id: 'original', payload: next, overlay_context_id: 'prepared', source_change: { expected_content_hash: 'c'.repeat(64), preparation_digest: 'd'.repeat(64) } } } }
  const ack = { plan_id: 'plan', item_version_id: 'v', version_label: 'A', name: 'Plan', number: 'W1', state: 'Draft', draft_seq: 3, content_hash: 'e'.repeat(64), ...(schema === 'vemcad-weld-overlay/3' ? { save_id: 'original' } : {}), payload: structuredClone(next),
    sources: { overlay_origin: { schema: 'yuantus.welding_plan_cad_origin/1', context_id: 'prepared', owner_auth_user_id: 7, rbac_user_id: 19, basis: { product: next.product, drawing: next.drawing } } } }
  return { original, ack }
}

describe('source-change durable command and acknowledgement contract', () => {
  it.each(['null', 'extra', 'digest', 'missing-digest', 'hash', 'missing-context', 'measure'])('rejects malformed preparation command: %s', damage => {
    const { original } = fixture(), body = original.pending!.body
    if (damage === 'null') body.source_change = null
    if (damage === 'extra') Object.assign(body.source_change!, { actor_id: 7 })
    if (damage === 'digest') Object.assign(body.source_change!, { preparation_digest: 'bad' })
    if (damage === 'missing-digest') delete (body.source_change as Record<string, unknown>).preparation_digest
    if (damage === 'hash') Object.assign(body.source_change!, { expected_content_hash: 'f'.repeat(64) })
    if (damage === 'missing-context') delete body.overlay_context_id
    if (damage === 'measure') body.measure_geometry = true
    expect(() => validateRecovery(original)).toThrow()
  })
  for (const schema of [null, 'vemcad-weld-overlay/1', 'vemcad-weld-overlay/2', 'vemcad-weld-overlay/3']) {
    it(`keeps the original draft and accepts only the exact new drawing acknowledgement: ${schema}`, () => {
      const { original, ack } = fixture(schema), before = JSON.stringify(original)
      expect(validateRecovery(original)).toEqual(original)
      expect(validateSaveAck(ack, original)).toEqual(ack)
      expect(JSON.stringify(original)).toBe(before)
      expect(original.draft.payload.drawing!.file_id).toBe('old')
      expect(original.pending!.local_ahead).toBe(false)
    })
    it.each(['old-drawing', 'body', 'missing-origin', 'context', 'actor', 'rbac', 'basis'])(`rejects mismatched source-change ACK (${schema}): %s`, damage => {
      const { original, ack } = fixture(schema)
      if (damage === 'old-drawing') ack.payload = structuredClone(original.draft.payload) as typeof ack.payload
      if (damage === 'body') Object.assign(ack.payload, { unexpected: true })
      if (damage === 'missing-origin') delete (ack.sources as Record<string, unknown>).overlay_origin
      if (damage === 'context') ack.sources.overlay_origin.context_id = 'old-context'
      if (damage === 'actor') ack.sources.overlay_origin.owner_auth_user_id = 8
      if (damage === 'rbac') ack.sources.overlay_origin.rbac_user_id = 20
      if (damage === 'basis') ack.sources.overlay_origin.basis = { product: ack.payload.product, drawing: original.draft.payload.drawing! }
      const before = JSON.stringify(original)
      expect(() => validateSaveAck(ack, original)).toThrow()
      expect(JSON.stringify(original)).toBe(before)
    })
  }
})
