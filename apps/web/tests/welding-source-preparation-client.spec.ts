import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWeldingPlanClient, validateSourcePreparation } from '../src/services/welding/planClient'
import { sourcePreparationFixture } from './fixtures/welding-source-preparation'

beforeEach(() => localStorage.setItem('auth_token', 'native-A'))
afterEach(() => vi.restoreAllMocks())
describe('source preparation client', () => {
  it('accepts the exact save point and new drawing with an old origin pin', () => {
    const f = sourcePreparationFixture()
    expect(validateSourcePreparation(f.prepared, f.point, f.next, f.owner, 'prep')).toEqual(f.prepared)
  })
  it.each(['context', 'owner', 'base', 'before', 'after', 'origin', 'viewer', 'expired', 'digest', 'document'])(
    'rejects changed preparation %s', damage => {
      const f = sourcePreparationFixture(), v = f.prepared
      if (damage === 'context') v.context_id = 'other'
      if (damage === 'owner') v.origin.owner_auth_user_id++
      if (damage === 'base') v.source_change.expected_content_hash = '0'.repeat(64)
      if (damage === 'before') Object.assign(v.source_change.before.payload, { preparation_notes: 'other' })
      if (damage === 'after') Object.assign(v.source_change.after.payload, { preparation_notes: 'other' })
      if (damage === 'origin') v.source_change.after.document.origin = { ...v.origin, context_id: 'other' }
      if (damage === 'viewer') v.source_change.before.document.view_bundle_sha256 = '0'.repeat(64)
      if (damage === 'expired') v.expires_at = '2000-01-01T00:00:00Z'
      if (damage === 'digest') v.source_change.preparation_digest = 'invalid'
      if (damage === 'document') v.source_change.after.document.cadgf_document = { fixture: 'mismatch' }
      expect(() => validateSourcePreparation(v, f.point, f.next, f.owner, 'prep')).toThrow()
    })
  it.each(['create', 'read'])('uses a fixed %s route and accepts a response larger than 13 MiB', async mode => {
    const f = sourcePreparationFixture()
    Object.assign(f.prepared.source_change.before.document.cadgf_document, { padding: 'x'.repeat(14 * 1024 * 1024) })
    const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(f.prepared), { status: mode === 'create' ? 201 : 200 }))
    const client = createWeldingPlanClient(transport)
    const result = mode === 'create' ? await client.prepareSourceChange(f.point, f.next, f.owner, 'open') : await client.readSourcePreparation(f.point, f.next, f.owner, 'prep')
    expect(result.context_id).toBe('prep')
    expect(transport.mock.calls[0][0]).toBe('/api/welding/plans/plan/versions/v/source-change-preparations' + (mode === 'read' ? '/prep' : ''))
  })
  it('requests only the preparation readonly ticket', async () => {
    const f = sourcePreparationFixture(), pin = f.prepared.origin.bundle_sha256
    const transport = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ asset_url: `/welding-cad/${pin}/welding-history.html`, bundle_sha256: pin, expires_at: f.prepared.expires_at }), { status: 201 }))
    const client = createWeldingPlanClient(transport)
    await client.cadTicket({ purpose: 'preparation', plan_id: 'plan', version_id: 'v', context_id: 'prep', side: 'before' })
    expect(JSON.parse(transport.mock.calls[0][1]?.body as string).purpose).toBe('preparation')
  })
})
