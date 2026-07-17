import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { getOrCreateLocalIntegration } from '../../src/directory/directory-sync'
import { createLocalDepartment } from '../../src/directory/local-directory-org'
import {
  suggestDepartmentBindings,
  sweepStaleDepartmentBindings,
} from '../../src/directory/department-binding-reconciliation'

/**
 * Canonical Org MVP — B7 (external-provider reconciliation, SUGGEST-ONLY), §9 + §5.5, real DB.
 *
 *   A. HEADLINE (the B7 done-gate): the remote department disappears (archive-not-delete,
 *      `is_active=false`) → the sweep marks the BINDING `stale` — and the LOCAL department stays
 *      `is_active=true` with its row BYTE-IDENTICAL (jsonb-free column compare incl. updated_at):
 *      a provider-side disappearance never damages the canonical local org.
 *   B. HEAL + IDEMPOTENCE: remote reappears → binding back to `active`; a second sweep in the same
 *      state changes nothing ({staled:0, healed:0}).
 *   C. ORG SCOPE: another org's bindings are untouched by this org's sweep.
 *   D. SUGGESTIONS (§9): a unique exact-name match (case/whitespace-insensitive) yields ONE
 *      suggestion; a remote name matching TWO local departments yields an `ambiguous` entry that
 *      is deliberately NOT appliable (no localDepartmentId) — never auto-matched; a no-match
 *      remote is `unmatched`; an ALREADY-BOUND remote is excluded entirely.
 *   E. SUGGEST IS READ-ONLY: binding rows byte-identical before/after the call.
 *
 * Load-bearing mutations (out-of-band, each reds this file):
 *   - drop the sweep's `rd.is_active = false` predicate → B reds (a healthy binding gets staled).
 *   - auto-pick the first candidate on ambiguity     → D reds (ambiguous becomes a suggestion).
 *   - make the sweep ALSO archive the local department (inject) → A reds (the headline pin).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()
const orgId = (suffix: string): string => `b7-${STAMP}-${suffix}`

async function dingtalkIntegration(org: string, tag: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
     VALUES ($1, 'dingtalk', $2, 'active', $3, '{}'::jsonb) RETURNING id`,
    [org, `DT b7 ${tag}`, `corp-b7-${STAMP}-${tag}`],
  )
  return r.rows[0].id
}
async function dtDept(integrationId: string, extId: string, name: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw)
     VALUES ($1, 'dingtalk', $2, $3, true, '{}'::jsonb) RETURNING id`,
    [integrationId, extId, name],
  )
  return r.rows[0].id
}
async function bind(org: string, localInt: string, localDept: string, remoteInt: string, remoteDept: string): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO directory_department_bindings
       (org_id, local_integration_id, local_department_id, local_provider,
        remote_integration_id, remote_department_id, remote_provider, status)
     VALUES ($1, $2, $3, 'local', $4, $5, 'dingtalk', 'active') RETURNING id`,
    [org, localInt, localDept, remoteInt, remoteDept],
  )
  return r.rows[0].id
}
async function bindingStatus(id: string): Promise<string> {
  const r = await query<{ status: string }>(`SELECT status FROM directory_department_bindings WHERE id = $1`, [id])
  return r.rows[0].status
}
/** Whole-row fingerprint of a department (every column) — byte-level "untouched" evidence. */
async function deptFingerprint(id: string): Promise<string> {
  const r = await query<{ fp: string }>(`SELECT to_jsonb(d)::text AS fp FROM directory_departments d WHERE d.id = $1`, [id])
  return r.rows[0].fp
}

describeIfDatabase('Canonical Org MVP — B7 suggest-only reconciliation (real DB)', () => {
  const seededOrgIds: string[] = []

  afterEach(async () => {
    for (const org of seededOrgIds.splice(0)) {
      await query(`DELETE FROM directory_department_bindings WHERE org_id = $1`, [org])
      await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [org])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  async function boundFixture(tag: string) {
    const org = orgId(tag)
    seededOrgIds.push(org)
    const local = await getOrCreateLocalIntegration(org)
    const lDept = await createLocalDepartment({ orgId: org, name: `Engineering ${tag}` })
    const dt = await dingtalkIntegration(org, tag)
    const rDept = await dtDept(dt, `b7:${STAMP}:${tag}`, `Engineering ${tag}`)
    const binding = await bind(org, local.id, lDept.id, dt, rDept)
    return { org, localInt: local.id, lDept: lDept.id, dt, rDept, binding }
  }

  it('A. HEADLINE: remote disappearance stales the BINDING only — the local department row stays byte-identical and active', async () => {
    const { org, lDept, rDept, binding } = await boundFixture('headline')
    const before = await deptFingerprint(lDept)

    await query(`UPDATE directory_departments SET is_active = false, updated_at = NOW() WHERE id = $1`, [rDept])
    const sweep = await sweepStaleDepartmentBindings(org)
    expect(sweep).toEqual({ staled: 1, healed: 0 })
    expect(await bindingStatus(binding)).toBe('stale')

    // the LOCAL department is untouched — active, and the WHOLE ROW byte-identical
    const after = await deptFingerprint(lDept)
    expect(after).toBe(before)
    const active = await query<{ is_active: boolean }>(`SELECT is_active FROM directory_departments WHERE id = $1`, [lDept])
    expect(active.rows[0].is_active).toBe(true)
  })

  it('B. heal + idempotence: remote reappears → binding active again; a settled sweep changes nothing', async () => {
    const { org, rDept, binding } = await boundFixture('heal')
    await query(`UPDATE directory_departments SET is_active = false WHERE id = $1`, [rDept])
    expect(await sweepStaleDepartmentBindings(org)).toEqual({ staled: 1, healed: 0 })

    await query(`UPDATE directory_departments SET is_active = true WHERE id = $1`, [rDept])
    expect(await sweepStaleDepartmentBindings(org)).toEqual({ staled: 0, healed: 1 })
    expect(await bindingStatus(binding)).toBe('active')

    expect(await sweepStaleDepartmentBindings(org)).toEqual({ staled: 0, healed: 0 }) // idempotent
  })

  it('C. org scope: sweeping org A leaves org B bindings untouched', async () => {
    const a = await boundFixture('scope-A')
    const b = await boundFixture('scope-B')
    await query(`UPDATE directory_departments SET is_active = false WHERE id = $1`, [a.rDept])
    await query(`UPDATE directory_departments SET is_active = false WHERE id = $1`, [b.rDept])

    expect(await sweepStaleDepartmentBindings(a.org)).toEqual({ staled: 1, healed: 0 })
    expect(await bindingStatus(a.binding)).toBe('stale')
    expect(await bindingStatus(b.binding)).toBe('active') // B's org was not swept
  })

  it('D. suggestions: unique name → suggestion; duplicate local names → ambiguous (never auto-appliable); no match → unmatched; bound remotes excluded', async () => {
    const org = orgId('suggest')
    seededOrgIds.push(org)
    const local = await getOrCreateLocalIntegration(org)
    const dt = await dingtalkIntegration(org, 'sg')

    const lUnique = await createLocalDepartment({ orgId: org, name: 'Finance' })
    await createLocalDepartment({ orgId: org, name: 'Sales' })
    await createLocalDepartment({ orgId: org, name: 'sales ' }) // second candidate after case/trim folding
    const lBound = await createLocalDepartment({ orgId: org, name: 'Ops' })

    const rFinance = await dtDept(dt, `sg-fin-${STAMP}`, ' finance ') // case+whitespace insensitive match
    const rSales = await dtDept(dt, `sg-sales-${STAMP}`, 'Sales') // TWO local candidates → ambiguous
    const rGhost = await dtDept(dt, `sg-ghost-${STAMP}`, 'Warehouse') // no local counterpart
    const rBound = await dtDept(dt, `sg-ops-${STAMP}`, 'Ops')
    await bind(org, local.id, lBound.id, dt, rBound) // already bound → excluded from proposals

    const res = await suggestDepartmentBindings(org)
    expect(res.suggestions).toEqual([
      {
        remoteIntegrationId: dt,
        remoteDepartmentId: rFinance,
        remoteDepartmentName: ' finance ',
        localDepartmentId: lUnique.id,
        matchStrategy: 'exact-name',
      },
    ])
    expect(res.ambiguous).toHaveLength(1)
    expect(res.ambiguous[0].remoteDepartmentId).toBe(rSales)
    expect(res.ambiguous[0].candidateLocalDepartmentIds).toHaveLength(2)
    expect(res.ambiguous[0].reason).toBe('ambiguous-name')
    expect((res.ambiguous[0] as Record<string, unknown>).localDepartmentId).toBeUndefined() // NOT appliable
    expect(res.unmatched).toEqual([
      { remoteIntegrationId: dt, remoteDepartmentId: rGhost, remoteDepartmentName: 'Warehouse' },
    ])
    expect([...res.suggestions, ...res.ambiguous, ...res.unmatched].map((e) => e.remoteDepartmentId)).not.toContain(rBound)
  })

  it('E. suggest is READ-ONLY: binding rows byte-identical before and after', async () => {
    const { org, binding } = await boundFixture('ro')
    const before = await query<{ fp: string }>(`SELECT to_jsonb(b)::text AS fp FROM directory_department_bindings b WHERE id = $1`, [binding])
    await suggestDepartmentBindings(org)
    const after = await query<{ fp: string }>(`SELECT to_jsonb(b)::text AS fp FROM directory_department_bindings b WHERE id = $1`, [binding])
    expect(after.rows[0].fp).toBe(before.rows[0].fp)
  })
})
