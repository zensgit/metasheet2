import { clone } from '../../src/services/welding/planRecovery'
import { WELDING_CAD_PIN, type PlanRecord } from '../../src/services/welding/planClient'

export function sourcePreparationFixture() {
  const owner = { tenant_id: 'tenant', org_id: 'org', auth_user_id: 7, rbac_user_id: 19 }
  const product = { item_id: 'part', version_id: 'pv' }
  const drawing = { item_id: 'd1', version_id: 'dv1', file_id: 'f1', file_role: 'native_cad', expected_checksum: 'a'.repeat(64) }
  const next = { ...drawing, item_id: 'd2', version_id: 'dv2', file_id: 'f2', expected_checksum: 'b'.repeat(64) }
  const source = (d: typeof drawing) => ({ item_id: d.item_id, version_id: d.version_id, file_id: d.file_id, file_role: d.file_role, checksum: d.expected_checksum, fingerprint: 'f'.repeat(64) })
  const point: PlanRecord = { plan_id: 'plan', item_version_id: 'v', name: 'Plan', number: 'W1', state: 'Draft', version_label: 'A', draft_seq: 1, content_hash: 'c'.repeat(64),
    payload: { schema_version: 1, product, drawing, bom: null, welds: [], process_refs: [] }, sources: { product, drawing: source(drawing) } }
  const origin = { schema: 'yuantus.welding_plan_cad_origin/1', context_id: 'prep', owner_auth_user_id: 7, rbac_user_id: 19,
    basis: { product, drawing: next }, source: source(next), input: { sha256: next.expected_checksum, bytes: 42 },
    document: { sha256: 'd'.repeat(64), bytes: 42 }, unit: 'mm', bundle_sha256: WELDING_CAD_PIN }
  const oldOrigin = { ...origin, schema: 'yuantus.welding_plan_cad_review_origin/1', basis: { product, drawing },
    source: source(drawing), input: { sha256: drawing.expected_checksum, bytes: 42 }, bundle_sha256: '9'.repeat(64) }
  const prepared = { context_id: 'prep', plan_id: 'plan', item_version_id: 'v', draft_seq: 1, expires_at: new Date(Date.now() + 600000).toISOString(),
    unit: 'mm', editor_url: `/welding-cad/${WELDING_CAD_PIN}/welding-frame.html`, cadgf_document: { fixture: 'new' }, origin,
    input_sha256: next.expected_checksum, document_sha256: origin.document.sha256, source: source(next),
    source_change: { expected_content_hash: point.content_hash, preparation_digest: 'e'.repeat(64),
      before: { payload: point.payload, sources: point.sources, document: { cadgf_document: { fixture: 'old' }, origin: oldOrigin, view_bundle_sha256: WELDING_CAD_PIN } },
      after: { payload: { ...point.payload, drawing: next }, sources: { product, drawing: source(next), overlay_origin: origin },
        document: { cadgf_document: { fixture: 'new' }, origin, view_bundle_sha256: WELDING_CAD_PIN } } } }
  return clone({ owner, point, next, prepared })
}
