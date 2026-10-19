import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseNativeSnapshotShareExport, type SnapshotShareAuthority } from '../../src/services/plm-managed-snapshot-share-wire'

const authority: SnapshotShareAuthority = {
  intentId: '11111111-1111-4111-8111-111111111111', operationId: '22222222-2222-4222-8222-222222222222',
  source: { tenant_id: 'native-tenant', org_id: 'native-org', auth_user_id: '42', part_id: 'P' },
  target: { tenant_id: 'meta-tenant', org_id: 'meta-org', user_id: 'meta-person', base_id: 'base', sheet_id: 'sheet',
    source_id: 'source', binding_id: 'binding', binding_generation: 3, session_id: 'session', audience: 'Design team' },
}
function body() {
  return { source: { ...authority.source }, context: {
    part: { part_id: 'P', item_number: 'P1', name: 'Native part', state: null, generation: 1 }, lines: [],
    source_version: 1, source_updated_at: '2026-10-19T00:00:00Z', sync_status: 'snapshot', template_key: 'bom_review',
  } }
}
function receipt(payload = body()) {
  const bytes = Buffer.from(JSON.stringify(payload))
  return { contract: 'bom_snapshot_share.v1', policy: 'authorized_snapshot_target_acl.v1', intent_id: authority.intentId,
    operation_id: authority.operationId, target: { ...authority.target }, confirmed_at: '2026-10-19T00:00:00Z',
    expires_at: '2026-10-19T00:05:00Z', snapshot_base64: bytes.toString('base64'), snapshot_hash: createHash('sha256').update(bytes).digest('hex') }
}

describe('independent native snapshot share response', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T00:01:00Z')) })
  afterEach(() => vi.useRealTimers())
  it('keeps native and Meta identities separate and preserves confirmed content', () => {
    const result = parseNativeSnapshotShareExport(receipt(), authority)
    expect(result.snapshot.projection_contract).toBe('bom_review_share.v1')
    expect(result.snapshot.source.auth_user_id).toBe('42')
    expect(result.snapshot.context.part.part_id).toBe('P')
    expect(result.nativeSnapshotHash).toBe(receipt().snapshot_hash)
  })
  it.each(Object.keys(authority.target))('refuses changed target %s', key => {
    const value = receipt()
    Object.assign(value.target, { [key]: key === 'binding_generation' ? 4 : 'different' })
    expect(() => parseNativeSnapshotShareExport(value, authority)).toThrow('PLM_SNAPSHOT_SHARE_TARGET_CHANGED')
  })
  it.each(['tenant_id', 'org_id', 'auth_user_id', 'part_id'] as const)('rejects changed native %s with a correct hash', key => {
    const payload = body()
    payload.source[key] = key === 'auth_user_id' ? '900' : 'different'
    expect(() => parseNativeSnapshotShareExport(receipt(payload), authority)).toThrow('SOURCE_AUTHORITY_MISMATCH')
  })
  it('rejects a mismatched context root with a correct hash', () => {
    const payload = body()
    payload.context.part.part_id = 'OTHER'
    expect(() => parseNativeSnapshotShareExport(receipt(payload), authority)).toThrow('SOURCE_AUTHORITY_MISMATCH')
  })
  it.each(['intent_id', 'operation_id'] as const)('refuses another %s', key => {
    expect(() => parseNativeSnapshotShareExport({ ...receipt(), [key]: '33333333-3333-4333-8333-333333333333' }, authority)).toThrow('PLM_SNAPSHOT_SHARE_TARGET_CHANGED')
  })
  it('does not accept read projections or approval/write credentials', () => {
    for (const input of ['yur_fake', 'yua_fake', 'yuw_fake', { projection_contract: 'bom_review_managed.v1', ...body() }]) {
      expect(() => parseNativeSnapshotShareExport(input, authority)).toThrow('PLM_SNAPSHOT_SHARE_INVALID')
    }
  })
  it.each(['expired', 'wrong-purpose', 'tampered-bytes', 'invalid-base64', 'extra-target', 'coerced-generation'])('refuses %s', kind => {
    const value = receipt()
    if (kind === 'expired') value.expires_at = '2026-10-19T00:00:30Z'
    if (kind === 'wrong-purpose') value.contract = 'bom_review_managed.v1'
    if (kind === 'tampered-bytes') value.snapshot_base64 = Buffer.from('{}').toString('base64')
    if (kind === 'invalid-base64') value.snapshot_base64 += '\n'
    if (kind === 'extra-target') Object.assign(value.target, { ignored: true })
    if (kind === 'coerced-generation') Object.assign(value.target, { binding_generation: '3' })
    expect(() => parseNativeSnapshotShareExport(value, authority)).toThrow()
  })
  it.each(['target-user', 'native-org', 'missing-target'])('refuses an incomplete locked authority %s', kind => {
    const incomplete = structuredClone(authority) as unknown as Record<string, unknown>
    if (kind === 'missing-target') delete incomplete.target
    if (kind === 'target-user') delete (incomplete.target as Record<string, unknown>).user_id
    if (kind === 'native-org') delete (incomplete.source as Record<string, unknown>).org_id
    expect(() => parseNativeSnapshotShareExport(receipt(), incomplete as unknown as SnapshotShareAuthority)).toThrow('PLM_SNAPSHOT_SHARE_TARGET_CHANGED')
  })
  it('hashes original bytes before normalization', () => {
    const value = receipt(), bytes = Buffer.from(JSON.stringify(body(), null, 2))
    value.snapshot_base64 = bytes.toString('base64')
    value.snapshot_hash = createHash('sha256').update(bytes).digest('hex')
    expect(parseNativeSnapshotShareExport(value, authority).nativeSnapshotHash).toBe(value.snapshot_hash)
  })
})
