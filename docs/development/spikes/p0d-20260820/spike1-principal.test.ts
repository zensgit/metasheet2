/**
 * SPIKE 1 (DRAFT) — unit tests for the pure principal-lifecycle logic.
 * No DB, no wiring. vitest-style.
 *
 * Covers the acceptance criteria:
 *   (A) cross-tenant grant rejected,
 *   (B) revoke -> new writes denied BUT historical revision still resolves,
 *   (C) principal id non-reuse (historical actor keeps resolving to the
 *       original, revoked, identity).
 */
import { describe, it, expect } from 'vitest'
import {
  resolvePrincipalWritability,
  resolveHistoricalActor,
  assertGrantRebindAllowed,
  type PrincipalState,
  type WriterGrant,
} from './spike1-principal-prototype'

const principal = (over: Partial<PrincipalState> = {}): PrincipalState => ({
  id: 'p-1',
  tenantId: 'tenantA',
  kind: 'connector',
  revokedAt: null,
  ...over,
})

const grant = (over: Partial<WriterGrant> = {}): WriterGrant => ({
  id: 'g-1',
  tenantId: 'tenantA',
  principalId: 'p-1',
  targetKind: 'base',
  targetId: 'base-1',
  revokedAt: null,
  ...over,
})

describe('resolvePrincipalWritability — happy path', () => {
  it('allows an active grant for an active same-tenant principal', () => {
    const d = resolvePrincipalWritability(grant(), principal(), true)
    expect(d).toEqual({ allow: true })
  })
})

describe('(A) cross-tenant is denied', () => {
  it('denies when request tenant does not match (sameTenant=false)', () => {
    const d = resolvePrincipalWritability(grant(), principal(), false)
    expect(d.allow).toBe(false)
    if (!d.allow) expect(d.reasons).toContain('tenant_mismatch')
  })

  it('denies when the grant and principal rows disagree on tenant', () => {
    // This state cannot arise at rest (DB composite FK forbids it), but the
    // pure guard defends against a mis-constructed in-memory pair.
    const d = resolvePrincipalWritability(
      grant({ tenantId: 'tenantB' }),
      principal({ tenantId: 'tenantA' }),
      true
    )
    expect(d.allow).toBe(false)
    if (!d.allow) expect(d.reasons).toContain('tenant_mismatch')
  })
})

describe('(B) revoke invalidates authority but not history', () => {
  it('denies new writes once the principal is revoked', () => {
    const d = resolvePrincipalWritability(
      grant(),
      principal({ revokedAt: '2026-08-20T00:00:00Z' }),
      true
    )
    expect(d.allow).toBe(false)
    if (!d.allow) expect(d.reasons).toContain('principal_revoked')
  })

  it('denies new writes once the grant is revoked (principal still active)', () => {
    const d = resolvePrincipalWritability(
      grant({ revokedAt: '2026-08-20T00:00:00Z' }),
      principal(),
      true
    )
    expect(d.allow).toBe(false)
    if (!d.allow) expect(d.reasons).toContain('grant_revoked')
  })

  it('a revoked principal STILL resolves for a historical revision', () => {
    const revoked = principal({ revokedAt: '2026-08-20T00:00:00Z' })
    const registry = new Map([[revoked.id, revoked]])
    // meta_record_revisions.actor_id recorded the id at write time.
    const resolved = resolveHistoricalActor(revoked.id, registry)
    expect(resolved).toBe(revoked)
    expect('unresolved' in resolved).toBe(false)
  })

  it('accumulates all reasons when principal and grant are both revoked cross-tenant', () => {
    const d = resolvePrincipalWritability(
      grant({ tenantId: 'tenantB', revokedAt: '2026-08-20T00:00:00Z' }),
      principal({ tenantId: 'tenantA', revokedAt: '2026-08-20T00:00:00Z' }),
      false
    )
    expect(d.allow).toBe(false)
    if (!d.allow) {
      expect(new Set(d.reasons)).toEqual(
        new Set(['tenant_mismatch', 'principal_revoked', 'grant_revoked'])
      )
    }
  })
})

describe('(C) principal id non-reuse', () => {
  it('historical actor resolves to the ORIGINAL identity, not a same-named new one', () => {
    const original = principal({ id: 'p-1' })
    const registry = new Map([[original.id, original]])
    // A "new" principal is a NEW uuid; the old id is never recycled, so the
    // old actor_id can only ever resolve to the original row.
    const resolved = resolveHistoricalActor('p-1', registry)
    expect(resolved).toBe(original)
  })

  it('unknown / legacy actor id resolves as unresolved rather than throwing', () => {
    const resolved = resolveHistoricalActor('legacy-human-42', new Map())
    expect(resolved).toEqual({ unresolved: true, actorId: 'legacy-human-42' })
  })

  it('null actor id (actor-less trigger, e.g. schedule) is unresolved', () => {
    const resolved = resolveHistoricalActor(null, new Map())
    expect(resolved).toEqual({ unresolved: true, actorId: null })
  })
})

describe('mis-joined grant/principal guard', () => {
  it('denies when the grant belongs to a different principal', () => {
    const d = resolvePrincipalWritability(
      grant({ principalId: 'p-1' }),
      principal({ id: 'p-2' }),
      true
    )
    expect(d.allow).toBe(false)
    if (!d.allow) expect(d.reasons).toContain('principal_grant_id_mismatch')
  })
})

describe('rebinding forbidden (pure form of the SQL trigger)', () => {
  it('allows a no-op update (same principal & tenant)', () => {
    const r = assertGrantRebindAllowed(
      { principalId: 'p-1', tenantId: 'tenantA' },
      { principalId: 'p-1', tenantId: 'tenantA' }
    )
    expect(r).toEqual({ ok: true })
  })

  it('forbids changing principal_id (rebind)', () => {
    const r = assertGrantRebindAllowed(
      { principalId: 'p-1', tenantId: 'tenantA' },
      { principalId: 'p-2', tenantId: 'tenantA' }
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations).toContain('principal_id')
  })

  it('forbids changing tenant_id', () => {
    const r = assertGrantRebindAllowed(
      { principalId: 'p-1', tenantId: 'tenantA' },
      { principalId: 'p-1', tenantId: 'tenantB' }
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.violations).toContain('tenant_id')
  })
})
