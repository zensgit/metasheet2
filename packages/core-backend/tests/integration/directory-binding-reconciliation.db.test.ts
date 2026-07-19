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
 *   E. SUGGEST IS READ-ONLY (zero-write): org-scoped binding count + complete binding fingerprint
 *      set are byte-identical before/after; the exact suggested local/remote pair has no binding
 *      row either before or after (suggest never creates a binding for its own proposal).
 *
 * Load-bearing mutations (out-of-band, each reds this file):
 *   - drop the sweep's `rd.is_active = false` predicate → B reds (a healthy binding gets staled).
 *   - auto-pick the first candidate on ambiguity     → D reds (ambiguous becomes a suggestion).
 *   - make the sweep ALSO archive the local department (inject) → A reds (the headline pin).
 *   - inject an INSERT of the suggested (local, remote) binding inside suggest → E reds
 *     (count/fingerprint/pair-absence all fail — proves the zero-write pin is load-bearing).
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

/** Org-scoped binding write surface: count + ordered whole-row fingerprints (complete set). */
async function orgBindingsSnapshot(org: string): Promise<{ count: number; fingerprints: string[] }> {
  const r = await query<{ fp: string }>(
    `SELECT to_jsonb(b)::text AS fp
       FROM directory_department_bindings b
      WHERE b.org_id = $1
      ORDER BY b.id ASC`,
    [org],
  )
  return { count: r.rows.length, fingerprints: r.rows.map((row) => row.fp) }
}

/** Whether a binding exists for the exact (local, remote) department pair. */
async function bindingExistsForPair(org: string, localDeptId: string, remoteDeptId: string): Promise<boolean> {
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM directory_department_bindings
      WHERE org_id = $1
        AND local_department_id = $2
        AND remote_department_id = $3`,
    [org, localDeptId, remoteDeptId],
  )
  return (r.rows[0]?.n ?? 0) > 0
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

    // Zero-write baseline for the unique-name pair (proved load-bearing in E; asserted here so the
    // suggestion fixture itself cannot silently apply the proposed binding).
    expect(await bindingExistsForPair(org, lUnique.id, rFinance)).toBe(false)
    const beforeSnap = await orgBindingsSnapshot(org)

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

    // Suggest never materializes the unique-name proposal: exact pair still unbound, and the full
    // org binding surface (count + ordered whole-row fingerprints) is unchanged.
    expect(await bindingExistsForPair(org, lUnique.id, rFinance)).toBe(false)
    const afterSnap = await orgBindingsSnapshot(org)
    expect(afterSnap.count).toBe(beforeSnap.count)
    expect(afterSnap.fingerprints).toEqual(beforeSnap.fingerprints)
  })

  it('F. candidate guards (gate P3): an ARCHIVED local dept and a dept under an INACTIVE local integration never count as candidates', async () => {
    const org = orgId('guards')
    seededOrgIds.push(org)
    const local = await getOrCreateLocalIntegration(org)
    const dt = await dingtalkIntegration(org, 'gd')

    // (a) archived local dept with a matching name → remote must land UNMATCHED, never a suggestion
    const archived = await createLocalDepartment({ orgId: org, name: 'Legal' })
    await query(`UPDATE directory_departments SET is_active = false WHERE id = $1`, [archived.id])
    const rLegal = await dtDept(dt, `gd-legal-${STAMP}`, 'Legal')

    // (b) a matching-name dept under an INACTIVE local integration → must not count either
    const inactiveLocal = await query<{ id: string }>(
      `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
       VALUES ($1, 'local', 'Local organization (old)', 'inactive', $2, '{"mode":"editable","source":"local"}'::jsonb)
       RETURNING id`,
      [org, `local:${org}`],
    )
    await query(
      `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw)
       VALUES ($1, 'local', $2, 'HR', true, '{}'::jsonb)`,
      [inactiveLocal.rows[0].id, `local:old-hr-${STAMP}`],
    )
    const rHr = await dtDept(dt, `gd-hr-${STAMP}`, 'HR')

    // positive control in the same fixture: a live dept under the ACTIVE local integration matches
    const live = await createLocalDepartment({ orgId: org, name: 'Live' })
    const rLive = await dtDept(dt, `gd-live-${STAMP}`, 'Live')

    const res = await suggestDepartmentBindings(org)
    expect(res.unmatched.map((u) => u.remoteDepartmentId)).toEqual(expect.arrayContaining([rLegal, rHr]))
    expect(res.suggestions.map((s) => s.remoteDepartmentId)).toEqual([rLive])
    expect(res.suggestions[0].localDepartmentId).toBe(live.id)
    expect(res.ambiguous).toHaveLength(0)
  })

  it('G. remote-INTEGRATION guard (owner #4436): a disabled remote integration is frozen — its bindings neither stale nor heal until re-enabled', async () => {
    const { org, dt, rDept, binding } = await boundFixture('ig')
    // archive the remote dept AND disable the whole remote integration
    await query(`UPDATE directory_departments SET is_active = false WHERE id = $1`, [rDept])
    await query(`UPDATE directory_integrations SET status = 'disabled' WHERE id = $1`, [dt])

    expect(await sweepStaleDepartmentBindings(org)).toEqual({ staled: 0, healed: 0 }) // frozen: no churn
    expect(await bindingStatus(binding)).toBe('active')

    // positive control: re-enable the integration → the SAME sweep now stales the binding
    await query(`UPDATE directory_integrations SET status = 'active' WHERE id = $1`, [dt])
    expect(await sweepStaleDepartmentBindings(org)).toEqual({ staled: 1, healed: 0 })
    expect(await bindingStatus(binding)).toBe('stale')

    // Gate P2 (restack round): the HEAL direction must honor the same freeze — 'nor heal until
    // live again'. Revive the remote dept (heal would now fire), then disable the integration:
    // the stale binding must NOT heal off a frozen snapshot. Neutering the healed-UPDATE's
    // ri.status='active' predicate turns exactly this leg red.
    await query(`UPDATE directory_departments SET is_active = true WHERE id = $1`, [rDept])
    await query(`UPDATE directory_integrations SET status = 'disabled' WHERE id = $1`, [dt])
    expect(await sweepStaleDepartmentBindings(org)).toEqual({ staled: 0, healed: 0 }) // frozen: no heal either
    expect(await bindingStatus(binding)).toBe('stale')

    // positive control: re-enable → the SAME sweep heals it back to active
    await query(`UPDATE directory_integrations SET status = 'active' WHERE id = $1`, [dt])
    expect(await sweepStaleDepartmentBindings(org)).toEqual({ staled: 0, healed: 1 })
    expect(await bindingStatus(binding)).toBe('active')
  })

  it('H. Q6 narrowing: a sweep narrowed to integration X leaves integration Y bindings untouched in the SAME org', async () => {
    const org = orgId('narrow')
    seededOrgIds.push(org)
    const local = await getOrCreateLocalIntegration(org)
    const lD1 = await createLocalDepartment({ orgId: org, name: 'N1' })
    const lD2 = await createLocalDepartment({ orgId: org, name: 'N2' })
    const dtX = await dingtalkIntegration(org, 'nx')
    const dtY = await dingtalkIntegration(org, 'ny')
    const rX = await dtDept(dtX, `n-x-${STAMP}`, 'N1')
    const rY = await dtDept(dtY, `n-y-${STAMP}`, 'N2')
    const bX = await bind(org, local.id, lD1.id, dtX, rX)
    const bY = await bind(org, local.id, lD2.id, dtY, rY)
    await query(`UPDATE directory_departments SET is_active = false WHERE id IN ($1, $2)`, [rX, rY])

    expect(await sweepStaleDepartmentBindings(org, { remoteIntegrationId: dtX })).toEqual({ staled: 1, healed: 0 })
    expect(await bindingStatus(bX)).toBe('stale')
    expect(await bindingStatus(bY)).toBe('active') // narrowed out — the sync hook's exact scope
  })

  it('E. suggest is READ-ONLY zero-write: org binding count+fingerprint set unchanged; suggested pair never gains a row', async () => {
    // Unique-name fixture only (no pre-bound row): the zero-write pin must cover the exact
    // suggested local/remote pair, not merely leave an unrelated already-bound row untouched.
    const org = orgId('ro-pair')
    seededOrgIds.push(org)
    const local = await getOrCreateLocalIntegration(org)
    const dt = await dingtalkIntegration(org, 'ro')
    const lDept = await createLocalDepartment({ orgId: org, name: `Treasury ${STAMP}` })
    const rDept = await dtDept(dt, `ro-treas-${STAMP}`, `Treasury ${STAMP}`)

    expect(await bindingExistsForPair(org, lDept.id, rDept)).toBe(false)
    const before = await orgBindingsSnapshot(org)
    expect(before.count).toBe(0)

    const res = await suggestDepartmentBindings(org)
    expect(res.suggestions).toEqual([
      {
        remoteIntegrationId: dt,
        remoteDepartmentId: rDept,
        remoteDepartmentName: `Treasury ${STAMP}`,
        localDepartmentId: lDept.id,
        matchStrategy: 'exact-name',
      },
    ])

    // Complete surface: count, full ordered fingerprint set, and the exact pair row.
    // Injecting an INSERT of (lDept, rDept) inside suggestDepartmentBindings reds all three.
    expect(await bindingExistsForPair(org, lDept.id, rDept)).toBe(false)
    const after = await orgBindingsSnapshot(org)
    expect(after.count).toBe(0)
    expect(after.count).toBe(before.count)
    expect(after.fingerprints).toEqual(before.fingerprints)
    // local integration id is live and unused by the write surface — silence unused-binding noise
    expect(local.id).toBeTruthy()
  })
})
