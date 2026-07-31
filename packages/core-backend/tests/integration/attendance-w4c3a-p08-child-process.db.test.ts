/**
 * P08 blueprint candidate A/B — structural compliance.
 *
 * Two isolated DBs, identical schemas + deterministic plan fixture helper.
 *
 * Candidate A (DB A, parent process):
 *   enqueue via production surface + execute via canonical processor
 *   → golden = readP08DeterministicProjection (not a handwritten object)
 *
 * Candidate B (DB B):
 *   Child A (fresh module graph): enqueueP08FullPlanV1 itself, print jobId only
 *   Parent: poison current rule/settings/profile/group mapping
 *   Child B (fresh module graph): processLegacyImportPlanV1(jobId only)
 *   → projection must equal golden A
 *   Second child B: terminal replay, no double DML
 *   Org B: zero influencing writes
 *
 * Discriminators: child A fails if parent already enqueued on B; golden is
 * DB-read after process on A; source forbids handwritten golden literals for B.
 */
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import {
  createP08BaseSchema,
  enqueueP08FullPlanV1,
  migrateP08Schema,
  poisonP08CurrentConfig,
  processP08JobId,
  readP08DeterministicProjection,
  seedP08ActorsAndConfig,
  type P08DeterministicProjection,
  type P08FixtureIds,
} from '../utils/attendance-w4c3a-p08-fixture'

const dbUrl = process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const run = crypto.randomUUID().replace(/-/g, '').slice(0, 12)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(HERE, '../..')
const TSX = path.join(PKG_ROOT, 'node_modules/.bin/tsx')
const CHILD_ENQUEUE = path.join(HERE, '../utils/attendance-w4c3a-p08-child-enqueue.ts')
const CHILD_EXECUTE = path.join(HERE, '../utils/attendance-w4c3a-p08-child-execute.ts')

function requireTsx(): string {
  if (!fs.existsSync(TSX)) {
    throw new Error(`local tsx missing at ${TSX} (no npx fallback)`)
  }
  return TSX
}

function spawnChild(
  script: string,
  args: string[],
  env: Record<string, string | undefined>,
): { status: number | null; stdout: string; stderr: string } {
  const tsx = requireTsx()
  const proc = spawnSync(tsx, [script, ...args], {
    cwd: PKG_ROOT,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_PATH: path.join(PKG_ROOT, 'node_modules'),
      ...env,
    },
    encoding: 'utf8',
    timeout: 180_000,
  })
  if (proc.error) {
    throw new Error(`spawn failed for ${script}: ${String(proc.error)}`)
  }
  return {
    status: proc.status,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
  }
}

async function createIsolatedDb(
  adminPool: Pool,
  name: string,
): Promise<{ url: string; pool: Pool }> {
  await adminPool.query(`DROP DATABASE IF EXISTS ${name}`)
  await adminPool.query(`CREATE DATABASE ${name}`)
  const u = new URL(dbUrl as string)
  u.pathname = `/${name}`
  const url = u.toString()
  const pool = new Pool({ connectionString: url })
  await createP08BaseSchema(pool)
  await migrateP08Schema(url)
  return { url, pool }
}

describeIfDatabase('W4C-3a P08 candidate A/B (blueprint-structural)', () => {
  const nameA = `ms2_p08a_${run}`
  const nameB = `ms2_p08b_${run}`
  const nameC = `ms2_p08c_${run}`
  const ids: P08FixtureIds = {
    orgId: crypto.randomUUID(),
    orgBId: crypto.randomUUID(),
    adminId: `w4c3a-p08-admin-${run}`,
    targetUserId: crypto.randomUUID(),
    sourceRef: `w4c3a-p08-source-${run}`,
    // Distinct batchIds per DB so enqueue identities do not collide conceptually
    // (each DB is isolated; batchId is still deterministic per-DB via assignment).
    batchId: crypto.randomUUID(),
  }
  let adminPool: Pool
  let poolA: Pool
  let poolB: Pool
  let poolC: Pool
  let urlA: string
  let urlB: string
  let urlC: string
  let goldenA: P08DeterministicProjection
  let jobIdA: string
  let jobIdB: string

  beforeAll(async () => {
    if (!fs.existsSync(CHILD_ENQUEUE) || !fs.existsSync(CHILD_EXECUTE)) {
      throw new Error('P08 child scripts missing under tests/utils')
    }
    requireTsx()
    const adminUrl = new URL(dbUrl as string)
    adminUrl.pathname = '/postgres'
    adminPool = new Pool({ connectionString: adminUrl.toString() })

    const a = await createIsolatedDb(adminPool, nameA)
    const b = await createIsolatedDb(adminPool, nameB)
    const c = await createIsolatedDb(adminPool, nameC)
    poolA = a.pool
    poolB = b.pool
    poolC = c.pool
    urlA = a.url
    urlB = b.url
    urlC = c.url

    // Identical seed shape on both candidates (distinct physical DBs).
    await seedP08ActorsAndConfig(poolA, ids)
    await seedP08ActorsAndConfig(poolB, ids)
    await seedP08ActorsAndConfig(poolC, ids)

    // --- Candidate A: parent enqueue + execute → golden from actual projection ---
    jobIdA = await enqueueP08FullPlanV1(poolA, ids)
    const processedA = await processP08JobId(urlA, jobIdA)
    if (processedA.kind !== 'completed') {
      throw new Error(`candidate A process failed: ${JSON.stringify(processedA)}`)
    }
    goldenA = await readP08DeterministicProjection(poolA, jobIdA)
    // Guard: golden must look like a real completed first-execution, not empty defaults.
    if (
      goldenA.status !== 'completed' ||
      goldenA.terminals !== 1 ||
      goldenA.records !== 1 ||
      goldenA.groupCreated !== 1
    ) {
      throw new Error(`candidate A golden not usable: ${JSON.stringify(goldenA)}`)
    }
  }, 300_000)

  afterAll(async () => {
    await poolA?.end().catch(() => undefined)
    await poolB?.end().catch(() => undefined)
    await poolC?.end().catch(() => undefined)
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${nameA}`).catch(() => undefined)
      await adminPool.query(`DROP DATABASE IF EXISTS ${nameB}`).catch(() => undefined)
      await adminPool.query(`DROP DATABASE IF EXISTS ${nameC}`).catch(() => undefined)
      await adminPool.end().catch(() => undefined)
    }
  })

  it('child A enqueues on B; child B first-exec equals A golden after poison; replay once', async () => {
    // Precondition: DB B has zero V1 jobs before child A.
    const before = await poolB.query(
      `SELECT count(*)::int AS n FROM attendance_import_jobs WHERE w4_contract_version = 1`,
    )
    expect(Number(before.rows[0].n)).toBe(0)

    // --- Child A: genuine enqueue on DB B ---
    // Use a distinct batchId for B so the fixture's batch identity is DB-local.
    const idsB: P08FixtureIds = { ...ids, batchId: crypto.randomUUID() }
    const childA = spawnChild(CHILD_ENQUEUE, [], {
      DATABASE_URL: urlB,
      P08_FIXTURE_JSON: JSON.stringify(idsB),
    })
    if (childA.status !== 0) {
      throw new Error(
        `Child A enqueue failed status=${childA.status} stderr=${childA.stderr.slice(0, 1200)} stdout=${childA.stdout.slice(0, 400)}`,
      )
    }
    const printed = childA.stdout.trim().split('\n').filter(Boolean).pop()
    if (!printed || !/^[0-9a-f-]{36}$/i.test(printed)) {
      throw new Error(`Child A did not print a jobId: ${childA.stdout}`)
    }
    jobIdB = printed

    // Prove child A actually inserted (not a parent enqueue on B).
    const afterEnqueue = await poolB.query(
      `SELECT id::text AS id, status, w4_contract_version
         FROM attendance_import_jobs WHERE id = $1::uuid`,
      [jobIdB],
    )
    expect(afterEnqueue.rows.length).toBe(1)
    expect(Number(afterEnqueue.rows[0].w4_contract_version)).toBe(1)
    expect(afterEnqueue.rows[0].status).toBe('queued')

    // Discriminator: a second child-A enqueue must refuse when a V1 job already exists
    // (would catch a parent that enqueued before spawning child A).
    const childAReject = spawnChild(CHILD_ENQUEUE, [], {
      DATABASE_URL: urlB,
      P08_FIXTURE_JSON: JSON.stringify({ ...idsB, batchId: crypto.randomUUID() }),
    })
    expect(childAReject.status).toBe(4)
    expect(childAReject.stderr).toMatch(/parent_already_enqueued/)

    // Parent mutates current config on B only (not A golden DB).
    await poisonP08CurrentConfig(poolB, ids.orgId)
    const decoyRecordId = crypto.randomUUID()
    const decoyGroupId = crypto.randomUUID()
    await poolB.query(
      `INSERT INTO attendance_records (
         id, user_id, work_date, work_minutes, status, meta,
         source_batch_id, org_id, timezone
       ) VALUES ($1::uuid, $2, $3::date, 999, 'poisoned', $4::jsonb, $5::uuid, $6, 'Pacific/Honolulu')`,
      [
        decoyRecordId,
        ids.targetUserId,
        '2026-07-30',
        JSON.stringify({ crossOrgDecoy: true }),
        idsB.batchId,
        ids.orgBId,
      ],
    )
    await poolB.query(
      `INSERT INTO attendance_groups (
         id, org_id, name, code, timezone, description
       ) VALUES ($1::uuid, $2, $3, 'POISON', 'Pacific/Honolulu', 'cross-org decoy')`,
      [decoyGroupId, ids.orgBId, 'P08 Engineering'],
    )
    const decoysBefore = await poolB.query(
      `SELECT 'record' AS kind, id::text, org_id, user_id AS value_a,
              work_minutes::text AS value_b, status AS value_c,
              timezone AS value_d, meta::text AS value_e
         FROM attendance_records WHERE id = $1::uuid
       UNION ALL
       SELECT 'group' AS kind, id::text, org_id, name AS value_a,
              code AS value_b, timezone AS value_c,
              description AS value_d, NULL::text AS value_e
         FROM attendance_groups WHERE id = $2::uuid
       ORDER BY kind`,
      [decoyRecordId, decoyGroupId],
    )

    // --- Child B: first execution ---
    const childB1 = spawnChild(CHILD_EXECUTE, [jobIdB], {
      DATABASE_URL: urlB,
    })
    if (childB1.status !== 0) {
      throw new Error(
        `Child B first execution failed status=${childB1.status} stderr=${childB1.stderr.slice(0, 1200)} stdout=${childB1.stdout.slice(0, 600)}`,
      )
    }
    const line1 = childB1.stdout.trim().split('\n').filter(Boolean).pop()
    if (!line1) throw new Error('Child B produced no JSON')
    const projectionB = JSON.parse(line1) as P08DeterministicProjection & {
      ok?: boolean
    }
    if (projectionB.ok === false) {
      throw new Error(`Child B not ok: ${line1}`)
    }

    // Exact equality of all governed deterministic fields (no handwritten golden).
    expect({
      status: projectionB.status,
      terminals: projectionB.terminals,
      batches: projectionB.batches,
      items: projectionB.items,
      records: projectionB.records,
      groups: projectionB.groups,
      members: projectionB.members,
      processedRows: projectionB.processedRows,
      failedRows: projectionB.failedRows,
      groupCreated: projectionB.groupCreated,
      groupMembersAdded: projectionB.groupMembersAdded,
      recordTimezone: projectionB.recordTimezone,
      workMinutes: projectionB.workMinutes,
      recordStatus: projectionB.recordStatus,
      itemUserId: projectionB.itemUserId,
      itemWorkDate: projectionB.itemWorkDate,
      groupNormalizedName: projectionB.groupNormalizedName,
      batchEngine: projectionB.batchEngine,
      resultKind: projectionB.resultKind,
    }).toEqual(goldenA)

    // Second fresh B: terminal replay, no double DML.
    const childB2 = spawnChild(CHILD_EXECUTE, [jobIdB], {
      DATABASE_URL: urlB,
    })
    if (childB2.status !== 0) {
      throw new Error(
        `Child B replay failed status=${childB2.status} stderr=${childB2.stderr.slice(0, 800)}`,
      )
    }
    const line2 = childB2.stdout.trim().split('\n').filter(Boolean).pop()
    const projectionB2 = JSON.parse(line2 || '{}') as P08DeterministicProjection
    expect(projectionB2.status).toBe('completed')
    expect(projectionB2.terminals).toBe(1)
    expect(projectionB2.batches).toBe(1)
    expect(projectionB2.items).toBe(1)
    expect(projectionB2.records).toBe(1)
    expect(projectionB2.groups).toBe(1)
    expect(projectionB2.members).toBe(1)

    // Same-user/date and same-normalized-group decoys in org B neither influence
    // the recovered result nor receive any write.
    const decoysAfter = await poolB.query(
      `SELECT 'record' AS kind, id::text, org_id, user_id AS value_a,
              work_minutes::text AS value_b, status AS value_c,
              timezone AS value_d, meta::text AS value_e
         FROM attendance_records WHERE id = $1::uuid
       UNION ALL
       SELECT 'group' AS kind, id::text, org_id, name AS value_a,
              code AS value_b, timezone AS value_c,
              description AS value_d, NULL::text AS value_e
         FROM attendance_groups WHERE id = $2::uuid
       ORDER BY kind`,
      [decoyRecordId, decoyGroupId],
    )
    expect(decoysAfter.rows).toEqual(decoysBefore.rows)
    const orgBEffects = await poolB.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_import_jobs WHERE org_id = $1) AS jobs,
         (SELECT count(*)::int FROM attendance_import_batches WHERE org_id = $1) AS batches,
         (SELECT count(*)::int FROM attendance_group_members WHERE org_id = $1) AS members`,
      [ids.orgBId],
    )
    expect(orgBEffects.rows[0]).toEqual({ jobs: 0, batches: 0, members: 0 })

    // Poison present on B but frozen plan timezone won.
    const poison = await poolB.query(
      `SELECT config->>'poisoned' AS p FROM attendance_rule_sets WHERE org_id = $1`,
      [ids.orgId],
    )
    expect(poison.rows[0].p).toBe('true')
    expect(projectionB.recordTimezone).toBe(goldenA.recordTimezone)

    // --- Discriminating seams ---
    // Strip line comments so this suite's own prose cannot false-match the ban.
    const suiteSource = fs
      .readFileSync(path.join(HERE, 'attendance-w4c3a-p08-child-process.db.test.ts'), 'utf8')
      .replace(/\/\/.*$/gm, '')
    // Parent must enqueue only on DB A (golden). Forbidden: enqueue helper on poolB.
    expect(suiteSource).not.toMatch(/enqueueP08FullPlanV1\(\s*poolB\b/)
    // Golden must come from DB-read projection, not a handwritten object for B.
    expect(suiteSource).toMatch(/goldenA\s*=\s*await\s+readP08DeterministicProjection/)
    expect(suiteSource).toMatch(/\.toEqual\(\s*goldenA\s*\)/)
    // Child A must use the production enqueue helper and refuse parent pre-enqueue.
    const childASource = fs.readFileSync(CHILD_ENQUEUE, 'utf8')
    expect(childASource).toMatch(/enqueueP08FullPlanV1/)
    expect(childASource).toMatch(/parent_already_enqueued/)
    // Child B is jobId + DATABASE_URL only (no enqueue / no fixture env consumption).
    const childBSource = fs.readFileSync(CHILD_EXECUTE, 'utf8')
    expect(childBSource).toMatch(/processP08JobId/)
    expect(childBSource).not.toMatch(/enqueueP08FullPlanV1/)
    expect(childBSource).not.toMatch(/buildP08FullPlanInput/)
    expect(childBSource).not.toMatch(/process\.env\.P08_FIXTURE/)

    // Discriminator mutation: forged handwritten golden would fail equality.
    const forged: P08DeterministicProjection = {
      ...goldenA,
      workMinutes: goldenA.workMinutes + 1,
    }
    expect(projectionB.workMinutes).not.toBe(forged.workMinutes)
    expect(() => {
      expect({
        status: projectionB.status,
        terminals: projectionB.terminals,
        batches: projectionB.batches,
        items: projectionB.items,
        records: projectionB.records,
        groups: projectionB.groups,
        members: projectionB.members,
        processedRows: projectionB.processedRows,
        failedRows: projectionB.failedRows,
        groupCreated: projectionB.groupCreated,
        groupMembersAdded: projectionB.groupMembersAdded,
        recordTimezone: projectionB.recordTimezone,
        workMinutes: projectionB.workMinutes,
        recordStatus: projectionB.recordStatus,
        itemUserId: projectionB.itemUserId,
        itemWorkDate: projectionB.itemWorkDate,
        groupNormalizedName: projectionB.groupNormalizedName,
        batchEngine: projectionB.batchEngine,
        resultKind: projectionB.resultKind,
      }).toEqual(forged)
    }).toThrow()
  }, 300_000)

  it('fresh worker preserves suspended jobs, then fails closed after resume with authorization loss', async () => {
    const idsC: P08FixtureIds = { ...ids, batchId: crypto.randomUUID() }
    const jobIdC = await enqueueP08FullPlanV1(poolC, idsC)
    await poolC.query(
      `INSERT INTO attendance_calculation_rollout_state (
         org_id, state, engine_version, reason_code, actor_id, version, prior_state
       ) VALUES ($1, 'legacy', 'w4c1-v1', 'test', $2, 1, NULL)`,
      [ids.orgId, ids.adminId],
    )
    for (const [state, priorState, version] of [
      ['shadow', 'legacy', 2],
      ['eligible', 'shadow', 3],
      ['authoritative', 'eligible', 4],
      ['suspended', 'authoritative', 5],
    ] as const) {
      await poolC.query(
        `UPDATE attendance_calculation_rollout_state
            SET state = $2, prior_state = $3, version = $4,
                reason_code = 'test', actor_id = $5, changed_at = now()
          WHERE org_id = $1`,
        [ids.orgId, state, priorState, version, ids.adminId],
      )
    }

    const suspended = spawnChild(CHILD_EXECUTE, [jobIdC], {
      DATABASE_URL: urlC,
    })
    expect(suspended.status).toBe(5)
    const suspendedResult = JSON.parse(
      suspended.stdout.trim().split('\n').filter(Boolean).pop() || '{}',
    ) as Record<string, unknown>
    expect(suspendedResult).toMatchObject({
      ok: false,
      resultKind: 'suspended',
      status: 'queued',
      reason: 'SEGMENT_CALCULATION_SUSPENDED',
    })
    const suspendedFootprint = await poolC.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_import_batches WHERE id = $1::uuid) AS batches,
         (SELECT count(*)::int FROM attendance_import_items WHERE batch_id = $1::uuid) AS items,
         (SELECT count(*)::int FROM attendance_records WHERE source_batch_id = $1::uuid) AS records,
         (SELECT count(*)::int FROM attendance_groups WHERE org_id = $2 AND lower(btrim(name)) = $3) AS groups,
         (SELECT count(*)::int FROM attendance_group_members WHERE org_id = $2) AS members,
         (SELECT count(*)::int FROM attendance_import_legacy_terminal_responses WHERE job_id = $4::uuid) AS terminals,
         (SELECT count(*)::int FROM attendance_import_upload_cleanup_commands WHERE job_id = $4::uuid) AS cleanups`,
      [idsC.batchId, ids.orgId, 'p08 engineering', jobIdC],
    )
    expect(suspendedFootprint.rows[0]).toEqual({
      batches: 0,
      items: 0,
      records: 0,
      groups: 0,
      members: 0,
      terminals: 0,
      cleanups: 0,
    })

    await poolC.query(
      `UPDATE attendance_calculation_rollout_state
          SET state = 'authoritative', prior_state = 'suspended', version = 6,
              reason_code = 'test-resume', actor_id = $2, changed_at = now()
        WHERE org_id = $1`,
      [ids.orgId, ids.adminId],
    )
    await poolC.query('UPDATE users SET is_active = false WHERE id = $1', [
      ids.adminId,
    ])

    const resumed = spawnChild(CHILD_EXECUTE, [jobIdC], {
      DATABASE_URL: urlC,
    })
    expect(resumed.status).toBe(5)
    const resumedResult = JSON.parse(
      resumed.stdout.trim().split('\n').filter(Boolean).pop() || '{}',
    ) as Record<string, unknown>
    expect(resumedResult).toMatchObject({
      ok: false,
      resultKind: 'failed',
      status: 'failed',
      reason: 'ATTENDANCE_IMPORT_LEGACY_PLAN_AUTHORIZATION_REJECTED',
    })
    const failedFootprint = await poolC.query(
      `SELECT
         (SELECT count(*)::int FROM attendance_import_batches WHERE id = $1::uuid) AS batches,
         (SELECT count(*)::int FROM attendance_import_items WHERE batch_id = $1::uuid) AS items,
         (SELECT count(*)::int FROM attendance_records WHERE source_batch_id = $1::uuid) AS records,
         (SELECT count(*)::int FROM attendance_groups WHERE org_id = $2 AND lower(btrim(name)) = $3) AS groups,
         (SELECT count(*)::int FROM attendance_group_members WHERE org_id = $2) AS members,
         (SELECT count(*)::int FROM attendance_import_legacy_terminal_responses WHERE job_id = $4::uuid) AS terminals,
         (SELECT count(*)::int FROM attendance_import_upload_cleanup_commands WHERE job_id = $4::uuid) AS cleanups`,
      [idsC.batchId, ids.orgId, 'p08 engineering', jobIdC],
    )
    expect(failedFootprint.rows[0]).toEqual(suspendedFootprint.rows[0])
  }, 300_000)
})
