import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { getOrCreateLocalIntegration } from '../../src/directory/directory-sync'

/**
 * Canonical Org MVP — B5-a (routing policy SCHEMA), design lock Lock 1, real DB.
 *
 * `org_directory_routing_policy` is the §6 owner-ruled explicit `(org, purpose)` policy store.
 * This file proves the SCHEMA invariants only (the resolver is B5-b):
 *
 *   A. positive control — a same-org policy (canonical = the org's local integration) inserts.
 *   B. CROSS-ORG POLICY IS FK-IMPOSSIBLE — canonical from another org → 23503 BY the org-chain FK
 *      name (`orp_canonical_int_org_fk`), for the right reason (not the CHECK / not the UNIQUE).
 *   C. one policy per (org, purpose) — duplicate → 23505 by `orp_org_purpose_uniq`.
 *   D. closed purpose set — unknown purpose → 23514 by `orp_purpose_chk`.
 *   E. RESTRICT posture — deleting an integration a policy references → 23503 (loud, forces an
 *      explicit policy edit first); after deleting the policy row the delete SUCCEEDS (positive
 *      control: RESTRICT protects exactly while referenced, not forever).
 *   F. fallback chain — a cross-org fallback → 23503 by `orp_fallback_int_org_fk`; a NULL fallback
 *      is fine (NULL = no fallback, not a MATCH SIMPLE bypass: org integrity is still carried by
 *      the canonical FK on the same org_id column).
 *   G. schema contract — constraints exist BY NAME pinned to conrelid, and both org FKs are
 *      TWO-column (id, org_id) — arity asserted so a single-column regression can't fake existence.
 *
 * Load-bearing mutations (out-of-band, each reds this file):
 *   - drop `orp_canonical_int_org_fk`  → B reds (the cross-org policy inserts).
 *   - drop `orp_org_purpose_uniq`      → C reds (the duplicate inserts).
 *
 * Fixture IDs are namespaced with this file's STAMP — integration specs share one Postgres in CI.
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()
const orgId = (suffix: string): string => `b5a-${STAMP}-${suffix}`

interface PgError extends Error {
  code?: string
  constraint?: string
}

async function reject(fn: () => Promise<unknown>): Promise<PgError | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return e as PgError
  }
}

async function insertPolicy(input: {
  org: string
  purpose?: string
  canonical: string
  fallback?: string | null
}): Promise<{ id: string }> {
  const r = await query<{ id: string }>(
    `INSERT INTO org_directory_routing_policy (org_id, purpose, canonical_integration_id, fallback_integration_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.org, input.purpose ?? 'approval_routing', input.canonical, input.fallback ?? null],
  )
  return r.rows[0]
}

async function dingtalkIntegration(org: string, tag: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
     VALUES ($1, 'dingtalk', $2, 'active', $3, '{}'::jsonb) RETURNING id`,
    [org, `DT ${tag}`, `corp-${STAMP}-${tag}`],
  )
  return r.rows[0].id
}

describeIfDatabase('Canonical Org MVP — B5-a routing policy schema (real DB)', () => {
  const seededOrgIds: string[] = []

  afterEach(async () => {
    for (const org of seededOrgIds.splice(0)) {
      // policies first (RESTRICT would block the integration delete otherwise)
      await query(`DELETE FROM org_directory_routing_policy WHERE org_id = $1`, [org])
      await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [org])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('A. positive control: a same-org policy inserts (canonical = the org local integration)', async () => {
    const org = orgId('pos')
    seededOrgIds.push(org)
    const local = await getOrCreateLocalIntegration(org)
    const row = await insertPolicy({ org, canonical: local.id })
    expect(row.id).toBeTruthy()
  })

  it('B. cross-org policy is FK-impossible — rejected by the org-chain FK by name', async () => {
    const orgA = orgId('xo-A')
    const orgB = orgId('xo-B')
    seededOrgIds.push(orgA, orgB)
    await getOrCreateLocalIntegration(orgA)
    const foreign = await dingtalkIntegration(orgB, 'xb')

    const err = await reject(() => insertPolicy({ org: orgA, canonical: foreign }))
    expect(err?.code).toBe('23503') // foreign_key_violation — not the CHECK, not the UNIQUE
    expect(err?.constraint).toBe('orp_canonical_int_org_fk')
  })

  it('C. one policy per (org, purpose): duplicate rejected by orp_org_purpose_uniq', async () => {
    const org = orgId('dup')
    seededOrgIds.push(org)
    const local = await getOrCreateLocalIntegration(org)
    const dt = await dingtalkIntegration(org, 'dup')
    await insertPolicy({ org, canonical: local.id })

    const err = await reject(() => insertPolicy({ org, canonical: dt }))
    expect(err?.code).toBe('23505')
    expect(err?.constraint).toBe('orp_org_purpose_uniq')
  })

  it('D. closed purpose set: an unknown purpose is rejected by orp_purpose_chk', async () => {
    const org = orgId('chk')
    seededOrgIds.push(org)
    const local = await getOrCreateLocalIntegration(org)

    const err = await reject(() => insertPolicy({ org, purpose: 'coffee_routing', canonical: local.id }))
    expect(err?.code).toBe('23514')
    expect(err?.constraint).toBe('orp_purpose_chk')
  })

  it('E. RESTRICT: deleting a policy-referenced integration is a loud 23503; after removing the policy it succeeds', async () => {
    const org = orgId('restrict')
    seededOrgIds.push(org)
    const dt = await dingtalkIntegration(org, 'r')
    const policy = await insertPolicy({ org, canonical: dt })

    const err = await reject(() => query(`DELETE FROM directory_integrations WHERE id = $1`, [dt]))
    expect(err?.code).toBe('23503') // policy must be edited first — no silent target loss

    // positive control: drop the policy, then the integration delete succeeds
    await query(`DELETE FROM org_directory_routing_policy WHERE id = $1`, [policy.id])
    const gone = await query(`DELETE FROM directory_integrations WHERE id = $1`, [dt])
    expect(gone.rowCount).toBe(1)
  })

  it('F. fallback chain: cross-org fallback rejected by name; NULL fallback is fine', async () => {
    const orgA = orgId('fb-A')
    const orgB = orgId('fb-B')
    seededOrgIds.push(orgA, orgB)
    const localA = await getOrCreateLocalIntegration(orgA)
    const foreignB = await dingtalkIntegration(orgB, 'fb')

    const err = await reject(() => insertPolicy({ org: orgA, canonical: localA.id, fallback: foreignB }))
    expect(err?.code).toBe('23503')
    expect(err?.constraint).toBe('orp_fallback_int_org_fk')

    // NULL fallback (the default) inserts fine — proven implicitly by A, pinned explicitly here
    const ok = await insertPolicy({ org: orgA, canonical: localA.id, fallback: null })
    expect(ok.id).toBeTruthy()
  })

  it('G. schema contract: named constraints exist on THIS table and both org FKs are two-column', async () => {
    const own = await query<{ conname: string; ncols: number | null }>(
      `SELECT conname, array_length(conkey, 1) AS ncols FROM pg_constraint
        WHERE conrelid = 'org_directory_routing_policy'::regclass`,
    )
    const byName = new Map(own.rows.map((r) => [r.conname, r.ncols]))
    expect(byName.has('orp_org_purpose_uniq')).toBe(true)
    expect(byName.has('orp_purpose_chk')).toBe(true)
    expect(byName.get('orp_canonical_int_org_fk')).toBe(2) // (canonical_integration_id, org_id)
    expect(byName.get('orp_fallback_int_org_fk')).toBe(2) // (fallback_integration_id, org_id)
  })
})
