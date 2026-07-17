import { afterEach, describe, expect, it } from 'vitest'
import { query } from '../../src/db/pg'
import { getOrCreateLocalIntegration } from '../../src/directory/directory-sync'
import { createLocalDepartment } from '../../src/directory/local-directory-org'

/**
 * Canonical Org MVP — B4 (department binding table), #4215 §5.5, real DB.
 *
 * `directory_department_bindings` binds a local department to an external-provider department. The
 * owner done-gate is that a CROSS-ORG binding is IMPOSSIBLE TO INSERT — enforced by the schema's
 * buildable FK chain, not by service code. This proves that against real Postgres:
 *
 *   A. positive control — a same-org local↔dingtalk binding inserts fine (the guard rejects the
 *      cross-org case, not all bindings).
 *   B. cross-org is FK-impossible FOR THE RIGHT REASON — a binding whose local and remote
 *      integrations live in different orgs is rejected specifically by the org-chain FK
 *      (`ddb_*_int_org_fk`), by constraint name — not incidentally by the provider CHECK or a dept
 *      FK. Both org_id choices are covered (each fails the opposite side's org FK).
 *   C. provider-role — local side must be `provider='local'`, remote side must NOT be; a local↔local
 *      or dingtalk↔dingtalk binding is rejected (CHECK or provider FK).
 *   D. NOT NULL closes the MATCH SIMPLE hole — the same cross-org binding with `org_id = NULL` is
 *      rejected by NOT NULL (23502). This is load-bearing: Postgres composite FKs are MATCH SIMPLE,
 *      so a NULL in any FK column skips the FK entirely; without the NOT NULL a NULL-org_id cross-org
 *      binding would slip past the org chain (proven by the drop-NOT-NULL mutation below).
 *   E. a department must belong to its named integration (`ddb_*_dept_fk`).
 *   F. schema contract — the six FKs + provider CHECK + three parent UNIQUE constraints exist.
 *
 * Load-bearing mutations (out-of-band, each reds this file):
 *   - `ALTER … org_id DROP NOT NULL`                     → D reds (NULL-org_id cross-org insert now
 *                                                          slips past the org chain via MATCH SIMPLE).
 *   - `ALTER … DROP CONSTRAINT ddb_remote_int_org_fk`    → B reds (the cross-org binding inserts).
 */
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const STAMP = Date.now()
const orgId = (suffix: string): string => `b4-${STAMP}-${suffix}`

interface Side {
  intId: string
  deptId: string
  provider: string
}

async function localSide(org: string): Promise<Side> {
  const int = await getOrCreateLocalIntegration(org)
  const dept = await createLocalDepartment({ orgId: org, name: 'Local Dept' })
  return { intId: int.id, deptId: dept.id, provider: 'local' }
}

async function dingtalkSide(org: string, tag: string): Promise<Side> {
  const int = await query<{ id: string }>(
    `INSERT INTO directory_integrations (org_id, provider, name, status, corp_id, config)
     VALUES ($1, 'dingtalk', $2, 'active', $3, '{}'::jsonb) RETURNING id`,
    [org, `DingTalk ${tag}`, `corp-${STAMP}-${tag}`],
  )
  const intId = int.rows[0].id
  const dept = await query<{ id: string }>(
    `INSERT INTO directory_departments (integration_id, provider, external_department_id, name, is_active, raw)
     VALUES ($1, 'dingtalk', $2, $3, true, '{}'::jsonb) RETURNING id`,
    [intId, `dt:${STAMP}:${tag}`, `DT Dept ${tag}`],
  )
  return { intId, deptId: dept.rows[0].id, provider: 'dingtalk' }
}

interface BindingCols {
  org_id: string | null
  local_integration_id: string
  local_department_id: string
  local_provider: string
  remote_integration_id: string
  remote_department_id: string
  remote_provider: string
  status?: string
}

async function insertBinding(b: BindingCols): Promise<{ id: string }> {
  const r = await query<{ id: string }>(
    `INSERT INTO directory_department_bindings
       (org_id, local_integration_id, local_department_id, local_provider,
        remote_integration_id, remote_department_id, remote_provider, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      b.org_id,
      b.local_integration_id,
      b.local_department_id,
      b.local_provider,
      b.remote_integration_id,
      b.remote_department_id,
      b.remote_provider,
      b.status ?? 'active',
    ],
  )
  return r.rows[0]
}

interface PgError extends Error {
  code?: string
  constraint?: string
  column?: string
}

async function reject(fn: () => Promise<unknown>): Promise<PgError | null> {
  try {
    await fn()
    return null
  } catch (e) {
    return e as PgError
  }
}

describeIfDatabase('Canonical Org MVP — B4 department binding table (real DB)', () => {
  const seededOrgIds: string[] = []

  afterEach(async () => {
    // bindings + departments cascade on integration delete
    for (const org of seededOrgIds.splice(0)) {
      await query(`DELETE FROM directory_integrations WHERE org_id = $1`, [org])
    }
  })

  it('sentinel: DATABASE_URL is set (DB-backed lane must not silently skip)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  it('A. positive control: a same-org local↔dingtalk binding inserts', async () => {
    const org = orgId('pos')
    seededOrgIds.push(org)
    const local = await localSide(org)
    const remote = await dingtalkSide(org, 'pos')

    const inserted = await insertBinding({
      org_id: org,
      local_integration_id: local.intId,
      local_department_id: local.deptId,
      local_provider: 'local',
      remote_integration_id: remote.intId,
      remote_department_id: remote.deptId,
      remote_provider: 'dingtalk',
    })
    expect(inserted.id).toBeTruthy()
  })

  it('B. cross-org binding is FK-impossible — rejected by the org-chain FK (right reason), both org_id choices', async () => {
    const orgA = orgId('xo-A')
    const orgB = orgId('xo-B')
    seededOrgIds.push(orgA, orgB)
    const local = await localSide(orgA) // local int+dept in A
    const remote = await dingtalkSide(orgB, 'B') // dingtalk int+dept in B

    // org_id = A → the REMOTE integration (in B) fails its (id, A) org FK
    const errA = await reject(() =>
      insertBinding({
        org_id: orgA,
        local_integration_id: local.intId,
        local_department_id: local.deptId,
        local_provider: 'local',
        remote_integration_id: remote.intId,
        remote_department_id: remote.deptId,
        remote_provider: 'dingtalk',
      }),
    )
    expect(errA?.code).toBe('23503') // foreign_key_violation, NOT 23514 (check) / not a dept FK
    expect(errA?.constraint).toBe('ddb_remote_int_org_fk')

    // org_id = B → the LOCAL integration (in A) fails its (id, B) org FK
    const errB = await reject(() =>
      insertBinding({
        org_id: orgB,
        local_integration_id: local.intId,
        local_department_id: local.deptId,
        local_provider: 'local',
        remote_integration_id: remote.intId,
        remote_department_id: remote.deptId,
        remote_provider: 'dingtalk',
      }),
    )
    expect(errB?.code).toBe('23503')
    expect(errB?.constraint).toBe('ddb_local_int_org_fk')
  })

  it('C. provider-role: local↔local and dingtalk↔dingtalk bindings are rejected', async () => {
    const org = orgId('role')
    seededOrgIds.push(org)
    const local = await localSide(org)
    const local2 = await createLocalDepartment({ orgId: org, name: 'Local Dept 2' })
    const dt = await dingtalkSide(org, 'role')

    // local↔local: remote side is the local integration → cannot be a valid remote (CHECK or FK)
    const errLL = await reject(() =>
      insertBinding({
        org_id: org,
        local_integration_id: local.intId,
        local_department_id: local.deptId,
        local_provider: 'local',
        remote_integration_id: local.intId, // local integration as the "remote" side
        remote_department_id: local2.id,
        remote_provider: 'local', // honest → CHECK(remote_provider<>'local') fails
      }),
    )
    expect(errLL).toBeTruthy()
    expect(['23514', '23503']).toContain(errLL?.code) // provider-role CHECK or provider FK

    // dingtalk↔dingtalk: local side is a dingtalk integration → cannot be a valid local side
    const dt2 = await dingtalkSide(org, 'role2')
    const errDD = await reject(() =>
      insertBinding({
        org_id: org,
        local_integration_id: dt.intId, // dingtalk integration as the "local" side
        local_department_id: dt.deptId,
        local_provider: 'local', // lie → provider FK (dt.intId,'local') fails
        remote_integration_id: dt2.intId,
        remote_department_id: dt2.deptId,
        remote_provider: 'dingtalk',
      }),
    )
    expect(errDD).toBeTruthy()
    expect(['23514', '23503']).toContain(errDD?.code)
  })

  it('D. NOT NULL closes the MATCH SIMPLE hole: the cross-org binding with org_id=NULL is rejected by NOT NULL', async () => {
    const orgA = orgId('null-A')
    const orgB = orgId('null-B')
    seededOrgIds.push(orgA, orgB)
    const local = await localSide(orgA)
    const remote = await dingtalkSide(orgB, 'nb')

    const err = await reject(() =>
      query(
        `INSERT INTO directory_department_bindings
           (org_id, local_integration_id, local_department_id, local_provider,
            remote_integration_id, remote_department_id, remote_provider, status)
         VALUES (NULL, $1, $2, 'local', $3, $4, 'dingtalk', 'active')`,
        [local.intId, local.deptId, remote.intId, remote.deptId],
      ),
    )
    expect(err?.code).toBe('23502') // not_null_violation — org_id may not be NULL
    expect(err?.column).toBe('org_id')
  })

  it('E. a department must belong to its named integration', async () => {
    const org = orgId('dept')
    seededOrgIds.push(org)
    const local = await localSide(org)
    const remote = await dingtalkSide(org, 'dept')

    // local_department_id is the DINGTALK dept, but local_integration_id is the local int → dept FK fails
    const err = await reject(() =>
      insertBinding({
        org_id: org,
        local_integration_id: local.intId,
        local_department_id: remote.deptId, // wrong: belongs to the dingtalk integration
        local_provider: 'local',
        remote_integration_id: remote.intId,
        remote_department_id: remote.deptId,
        remote_provider: 'dingtalk',
      }),
    )
    expect(err?.code).toBe('23503')
    expect(err?.constraint).toBe('ddb_local_dept_fk')
  })

  it('G. UPDATE path cannot bypass the chain: repoint-remote / rewrite-org_id / NULL-org_id / parent-org rewrite all rejected', async () => {
    // FKs re-check on UPDATE of referencing columns — but that is an ASSERTED invariant until
    // pinned. Owner review focus: "无 NULL、更新或 raw SQL 绕过". Four legs, each by exact cause.
    const orgA = orgId('upd-A')
    const orgB = orgId('upd-B')
    seededOrgIds.push(orgA, orgB)
    const local = await localSide(orgA)
    const remoteA = await dingtalkSide(orgA, 'updA')
    const remoteB = await dingtalkSide(orgB, 'updB')
    const binding = await insertBinding({
      org_id: orgA,
      local_integration_id: local.intId,
      local_department_id: local.deptId,
      local_provider: 'local',
      remote_integration_id: remoteA.intId,
      remote_department_id: remoteA.deptId,
      remote_provider: 'dingtalk',
    })

    // (a) repoint the remote side to an org-B integration → remote org FK rejects
    const errA = await reject(() =>
      query(
        `UPDATE directory_department_bindings SET remote_integration_id=$1, remote_department_id=$2 WHERE id=$3`,
        [remoteB.intId, remoteB.deptId, binding.id],
      ),
    )
    expect(errA?.code).toBe('23503')
    expect(errA?.constraint).toBe('ddb_remote_int_org_fk')

    // (b) rewrite org_id alone → the LOCAL org FK rejects (both sides re-check)
    const errB = await reject(() =>
      query(`UPDATE directory_department_bindings SET org_id=$1 WHERE id=$2`, [orgB, binding.id]),
    )
    expect(errB?.code).toBe('23503')
    expect(errB?.constraint).toBe('ddb_local_int_org_fk')

    // (c) NULL org_id via UPDATE → NOT NULL rejects (the MATCH SIMPLE closer holds on UPDATE too)
    const errC = await reject(() =>
      query(`UPDATE directory_department_bindings SET org_id=NULL WHERE id=$1`, [binding.id]),
    )
    expect(errC?.code).toBe('23502')

    // (d) PARENT-side rewrite: moving a BOUND integration to another org is rejected — the chain
    // also pins the parent's org while a binding references it (a transfer must handle bindings
    // first; it cannot silently drag a binding cross-org from the parent side).
    const errD = await reject(() =>
      query(`UPDATE directory_integrations SET org_id=$1 WHERE id=$2`, [orgB, remoteA.intId]),
    )
    expect(errD?.code).toBe('23503')
    expect(errD?.constraint).toBe('ddb_remote_int_org_fk')
  })

  it('H. CASCADE radius: deleting the remote integration removes the binding ONLY — local integration and department survive', async () => {
    const org = orgId('casc')
    seededOrgIds.push(org)
    const local = await localSide(org)
    const remote = await dingtalkSide(org, 'casc')
    const binding = await insertBinding({
      org_id: org,
      local_integration_id: local.intId,
      local_department_id: local.deptId,
      local_provider: 'local',
      remote_integration_id: remote.intId,
      remote_department_id: remote.deptId,
      remote_provider: 'dingtalk',
    })

    await query(`DELETE FROM directory_integrations WHERE id = $1`, [remote.intId])

    const gone = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM directory_department_bindings WHERE id = $1`,
      [binding.id],
    )
    expect(gone.rows[0].n).toBe(0) // binding cascaded away
    const localInt = await query<{ n: number }>(`SELECT count(*)::int AS n FROM directory_integrations WHERE id = $1`, [local.intId])
    const localDept = await query<{ n: number }>(`SELECT count(*)::int AS n FROM directory_departments WHERE id = $1`, [local.deptId])
    expect(localInt.rows[0].n).toBe(1) // local parents untouched
    expect(localDept.rows[0].n).toBe(1)
  })

  it('F. schema contract: the six FKs + provider CHECK + three parent UNIQUE constraints exist', async () => {
    const own = await query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'directory_department_bindings'::regclass`,
    )
    const names = own.rows.map((r) => r.conname)
    for (const c of [
      'ddb_local_int_org_fk',
      'ddb_remote_int_org_fk',
      'ddb_local_int_provider_fk',
      'ddb_remote_int_provider_fk',
      'ddb_local_dept_fk',
      'ddb_remote_dept_fk',
      'ddb_provider_role_chk',
    ]) {
      expect(names).toContain(c)
    }

    // conname is NOT database-unique (same lesson as the migration's own probes): pin each parent
    // constraint to ITS table via conrelid, so a same-named constraint elsewhere can't fake the 3.
    const parents = await query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE contype = 'u'
          AND ((conname = 'uq_directory_integrations_id_org'      AND conrelid = 'directory_integrations'::regclass)
            OR (conname = 'uq_directory_integrations_id_provider' AND conrelid = 'directory_integrations'::regclass)
            OR (conname = 'uq_directory_departments_id_integration' AND conrelid = 'directory_departments'::regclass))`,
    )
    expect(parents.rows.length).toBe(3)
  })
})
