/**
 * OD-W4C-58 §7.3 — deterministic 4×2 two-connection matrix.
 *
 * Branches:
 *  1. existing-group update/delete
 *  2. existing-member delete
 *  3. missing-group name-key insert
 *  4. missing-member pair insert
 *
 * Orders:
 *  A. mutator-first  → worker recheck fails closed, zero residue
 *  B. worker-lock/commit-first → mutator blocks on lock; worker succeeds;
 *     mutator then observes the post-commit world (no stale-plan effect)
 *
 * Also: SQL-order evidence + mutation legs for revision-before-business,
 * members-before-groups, skip existence recheck, and 40001/40P01 swallow.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool, type PoolClient } from 'pg'
import {
  computeLegacyImportGroupStateFingerprintV1,
} from '../../src/attendance/w4c3a-legacy-execution-plan'
import {
  lockAndRecheckAttendanceLegacyGroupPreconditionsV1,
} from '../../src/attendance/w4c3a-legacy-plan-preconditions'
import type { VerifiedAttendanceLegacyPlanV1 } from '../../src/attendance/w4c3a-legacy-plan-worker'
import type { AttendanceW4TransactionClientV1 } from '../../src/attendance/w4c0-identity'
import { isRetryableSqlState } from '../../src/attendance/w4c0-operation-registry'

const dbUrl =
  process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip
const run = crypto.randomUUID().replace(/-/g, '').slice(0, 12)

function trx(client: PoolClient): AttendanceW4TransactionClientV1 {
  return {
    query: (text, values) =>
      client.query(text, values as unknown[]) as unknown as Promise<{
        rows: Array<Record<string, unknown>>
      }>,
  }
}

function tracingTrx(client: PoolClient, sqlLog: string[]): AttendanceW4TransactionClientV1 {
  return {
    query: async (text, values) => {
      sqlLog.push(String(text).replace(/\s+/g, ' ').trim())
      return client.query(text, values as unknown[]) as unknown as {
        rows: Array<Record<string, unknown>>
      }
    },
  }
}

function groupPlan(input: {
  orgId: string
  groupRevision: number
  groupStateFingerprint: string
  groupEffects: VerifiedAttendanceLegacyPlanV1['groupEffects']
}): VerifiedAttendanceLegacyPlanV1 {
  return {
    manifest: {
      orgId: input.orgId,
      groupRevision: input.groupRevision,
      groupStateFingerprint: input.groupStateFingerprint,
    },
    chunks: [],
    items: [],
    recordWrites: [],
    groupEffects: input.groupEffects,
  } as unknown as VerifiedAttendanceLegacyPlanV1
}

async function createBase(pool: Pool): Promise<void> {
  await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
  await pool.query(`
    CREATE TABLE attendance_records (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL, work_date date NOT NULL, org_id text NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id text NOT NULL, work_date date NOT NULL,
      request_type varchar(30) NOT NULL, status varchar(20) NOT NULL DEFAULT 'pending',
      org_id text NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL, name text NOT NULL, code text,
      timezone text NOT NULL DEFAULT 'UTC', rule_set_id uuid, description text,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      UNIQUE (org_id, name)
    )`)
  await pool.query(`
    CREATE TABLE attendance_group_members (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL, group_id uuid NOT NULL, user_id text NOT NULL,
      created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
      UNIQUE (org_id, group_id, user_id)
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_jobs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL, batch_id uuid NOT NULL, created_by text NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'queued',
      payload jsonb NOT NULL DEFAULT '{}'::jsonb
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL, status text NOT NULL DEFAULT 'committed',
      row_count integer NOT NULL DEFAULT 0, meta jsonb NOT NULL DEFAULT '{}'::jsonb
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id uuid NOT NULL, org_id text NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_group_effect_revisions (
      org_id text PRIMARY KEY, revision bigint NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_legacy_terminal_responses (
      job_id uuid PRIMARY KEY, org_id text NOT NULL,
      response jsonb NOT NULL DEFAULT '{}'::jsonb
    )`)
  await pool.query(`
    CREATE TABLE attendance_import_upload_cleanup_commands (
      job_id uuid PRIMARY KEY, org_id text NOT NULL, file_id uuid NOT NULL
    )`)
  await pool.query(`
    CREATE TABLE attendance_result_operations (
      operation_id uuid PRIMARY KEY, org_id text NOT NULL
    )`)
}

async function waitUntilLockBlocked(pool: Pool, pid: number): Promise<void> {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const state = await pool.query(
      `SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`,
      [pid],
    )
    if (state.rows[0]?.wait_event_type === 'Lock') return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`backend ${pid} did not block on a lock`)
}

async function zeroResidue(pool: Pool, orgId: string): Promise<void> {
  const residue = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM attendance_import_batches WHERE org_id = $1) AS batches,
       (SELECT count(*)::int FROM attendance_import_items WHERE org_id = $1) AS items,
       (SELECT count(*)::int FROM attendance_result_operations WHERE org_id = $1) AS ops,
       (SELECT count(*)::int FROM attendance_import_legacy_terminal_responses
         WHERE org_id = $1) AS terminals,
       (SELECT count(*)::int FROM attendance_import_upload_cleanup_commands
         WHERE org_id = $1) AS cleanups`,
    [orgId],
  )
  expect(Number(residue.rows[0].batches)).toBe(0)
  expect(Number(residue.rows[0].items)).toBe(0)
  expect(Number(residue.rows[0].ops)).toBe(0)
  expect(Number(residue.rows[0].terminals)).toBe(0)
  expect(Number(residue.rows[0].cleanups)).toBe(0)
}

describeIfDatabase('W4C-3a group precondition 4×2 matrix (real PostgreSQL)', () => {
  const scratchName = `ms2_w4c3a_gpre2_${run}`
  const orgId = `w4c3a-gpre2-org-${run}`
  let adminPool: Pool
  let pool: Pool

  beforeAll(async () => {
    const adminUrl = new URL(dbUrl as string)
    adminUrl.pathname = '/postgres'
    adminPool = new Pool({ connectionString: adminUrl.toString() })
    await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
    await adminPool.query(`CREATE DATABASE ${scratchName}`)
    const scratchUrl = new URL(dbUrl as string)
    scratchUrl.pathname = `/${scratchName}`
    pool = new Pool({ connectionString: scratchUrl.toString() })
    await createBase(pool)
    await pool.query(
      `INSERT INTO attendance_group_effect_revisions (org_id, revision) VALUES ($1, 0)`,
      [orgId],
    )
  }, 120_000)

  afterAll(async () => {
    await pool?.end().catch(() => undefined)
    if (adminPool) {
      await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`).catch(() => undefined)
      await adminPool.end().catch(() => undefined)
    }
  })

  it('SQL order: existing groups FOR UPDATE → members FOR UPDATE → revision FOR UPDATE', async () => {
    const groupId = crypto.randomUUID()
    const userId = `order-user-${run}`
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, timezone) VALUES ($1,$2,'Order Group','UTC')`,
      [groupId, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1,$2,$3)`,
      [orgId, groupId, userId],
    )
    const fp = computeLegacyImportGroupStateFingerprintV1({
      groups: [{
        id: groupId, orgId, name: 'Order Group', code: null, timezone: 'UTC', ruleSetId: null,
      }],
      memberships: [{ orgId, groupId, userId, exists: true }],
    })
    const plan = groupPlan({
      orgId,
      groupRevision: 0,
      groupStateFingerprint: fp,
      groupEffects: [
        {
          kind: 'ensure_group', groupId, normalizedName: 'order group',
          displayName: 'Order Group', code: null, timezone: 'UTC', ruleSetId: null,
          groupExistedAtPrepare: true,
        },
        {
          kind: 'ensure_member', memberId: crypto.randomUUID(), groupRef: groupId,
          userId, membershipExistedAtPrepare: true,
        },
      ],
    })
    const sqlLog: string[] = []
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      expect(
        await lockAndRecheckAttendanceLegacyGroupPreconditionsV1(
          tracingTrx(client, sqlLog),
          plan,
        ),
      ).toBe(true)
      const g = sqlLog.findIndex((s) => s.includes('FROM attendance_groups') && s.includes('FOR UPDATE'))
      const m = sqlLog.findIndex((s) => s.includes('FROM attendance_group_members') && s.includes('FOR UPDATE'))
      const r = sqlLog.findIndex((s) => s.includes('FROM attendance_group_effect_revisions') && s.includes('FOR UPDATE'))
      expect(g).toBeGreaterThanOrEqual(0)
      expect(m).toBeGreaterThan(g)
      expect(r).toBeGreaterThan(m)
      // Mutation legs: these inverted orders must NOT match production log.
      expect(r < g).toBe(false) // revision-before-business-row
      expect(m < g).toBe(false) // members-before-groups
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  it('locks existing members by UTF-8 (groupRef,userId), not UTF-16 code units', async () => {
    const groupId = crypto.randomUUID()
    const bmpUser = '\uFFFF'
    const astralUser = '\u{10000}'
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, timezone)
       VALUES ($1, $2, $3, 'UTC')`,
      [groupId, orgId, `UTF8 ${run}`],
    )
    await pool.query(
      `INSERT INTO attendance_group_members (org_id, group_id, user_id)
       VALUES ($1, $2, $3), ($1, $2, $4)`,
      [orgId, groupId, bmpUser, astralUser],
    )
    const revision = Number(
      (
        await pool.query(
          `SELECT revision FROM attendance_group_effect_revisions WHERE org_id = $1`,
          [orgId],
        )
      ).rows[0].revision,
    )
    const fingerprint = computeLegacyImportGroupStateFingerprintV1({
      groups: [
        {
          id: groupId,
          orgId,
          name: `UTF8 ${run}`,
          code: null,
          timezone: 'UTC',
          ruleSetId: null,
        },
      ],
      memberships: [
        { orgId, groupId, userId: bmpUser, exists: true },
        { orgId, groupId, userId: astralUser, exists: true },
      ],
    })
    const plan = groupPlan({
      orgId,
      groupRevision: revision,
      groupStateFingerprint: fingerprint,
      groupEffects: [
        {
          kind: 'ensure_member',
          memberId: crypto.randomUUID(),
          groupRef: groupId,
          userId: astralUser,
          membershipExistedAtPrepare: true,
        },
        {
          kind: 'ensure_member',
          memberId: crypto.randomUUID(),
          groupRef: groupId,
          userId: bmpUser,
          membershipExistedAtPrepare: true,
        },
      ],
    })
    const lockedUsers: string[] = []
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const traced: AttendanceW4TransactionClientV1 = {
        query: async (text, values) => {
          if (
            String(text).includes('FROM attendance_group_members') &&
            String(text).includes('FOR UPDATE')
          ) {
            lockedUsers.push(String(values?.[2]))
          }
          return client.query(text, values as unknown[]) as unknown as {
            rows: Array<Record<string, unknown>>
          }
        },
      }
      expect(
        await lockAndRecheckAttendanceLegacyGroupPreconditionsV1(traced, plan),
      ).toBe(true)
      expect(lockedUsers).toEqual([bmpUser, astralUser])
      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
  })

  // -------------------------------------------------------------------------
  // Branch 1: existing-group update/delete
  // -------------------------------------------------------------------------

  it('1A mutator-first: existing-group delete → worker fails, zero residue', async () => {
    const groupId = crypto.randomUUID()
    const name = `EG-Del ${run}`
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, timezone) VALUES ($1,$2,$3,'UTC')`,
      [groupId, orgId, name],
    )
    const fp = computeLegacyImportGroupStateFingerprintV1({
      groups: [{ id: groupId, orgId, name, code: null, timezone: 'UTC', ruleSetId: null }],
      memberships: [],
    })
    const plan = groupPlan({
      orgId, groupRevision: 0, groupStateFingerprint: fp,
      groupEffects: [{
        kind: 'ensure_group', groupId, normalizedName: name.toLowerCase(),
        displayName: name, code: null, timezone: 'UTC', ruleSetId: null,
        groupExistedAtPrepare: true,
      }],
    })
    // Mutator commits delete first.
    await pool.query(`DELETE FROM attendance_groups WHERE id = $1`, [groupId])
    const worker = await pool.connect()
    try {
      await worker.query('BEGIN')
      const ok = await lockAndRecheckAttendanceLegacyGroupPreconditionsV1(trx(worker), plan)
      expect(ok).toBe(false)
      await worker.query('ROLLBACK')
    } finally {
      worker.release()
    }
    await zeroResidue(pool, orgId)
  })

  it('1B worker-lock-first: existing-group held → mutator blocks; worker commits true', async () => {
    const groupId = crypto.randomUUID()
    const name = `EG-Hold ${run}`
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, timezone) VALUES ($1,$2,$3,'UTC')`,
      [groupId, orgId, name],
    )
    const fp = computeLegacyImportGroupStateFingerprintV1({
      groups: [{ id: groupId, orgId, name, code: null, timezone: 'UTC', ruleSetId: null }],
      memberships: [],
    })
    const plan = groupPlan({
      orgId, groupRevision: 0, groupStateFingerprint: fp,
      groupEffects: [{
        kind: 'ensure_group', groupId, normalizedName: name.toLowerCase(),
        displayName: name, code: null, timezone: 'UTC', ruleSetId: null,
        groupExistedAtPrepare: true,
      }],
    })
    const worker = await pool.connect()
    const mutator = await pool.connect()
    try {
      await worker.query('BEGIN')
      const ok = await lockAndRecheckAttendanceLegacyGroupPreconditionsV1(trx(worker), plan)
      expect(ok).toBe(true)
      const mutPromise = (async () => {
        await mutator.query('BEGIN')
        await mutator.query(`DELETE FROM attendance_groups WHERE id = $1`, [groupId])
        await mutator.query('COMMIT')
      })()
      await waitUntilLockBlocked(pool, mutator.processID)
      // Worker still holds locks; group still present.
      const still = await worker.query(`SELECT 1 FROM attendance_groups WHERE id = $1`, [groupId])
      expect(still.rows.length).toBe(1)
      await worker.query('COMMIT')
      await mutPromise
      // After worker release, mutator delete lands — group gone.
      const gone = await pool.query(`SELECT 1 FROM attendance_groups WHERE id = $1`, [groupId])
      expect(gone.rows.length).toBe(0)
    } finally {
      await worker.query('ROLLBACK').catch(() => undefined)
      await mutator.query('ROLLBACK').catch(() => undefined)
      worker.release()
      mutator.release()
    }
  })

  // -------------------------------------------------------------------------
  // Branch 2: existing-member delete
  // -------------------------------------------------------------------------

  it('2A mutator-first: existing-member delete → worker fails, zero residue', async () => {
    const groupId = crypto.randomUUID()
    const userId = `em-del-${run}`
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, timezone) VALUES ($1,$2,'EM Del','UTC')`,
      [groupId, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1,$2,$3)`,
      [orgId, groupId, userId],
    )
    const fp = computeLegacyImportGroupStateFingerprintV1({
      groups: [{ id: groupId, orgId, name: 'EM Del', code: null, timezone: 'UTC', ruleSetId: null }],
      memberships: [{ orgId, groupId, userId, exists: true }],
    })
    const plan = groupPlan({
      orgId, groupRevision: 0, groupStateFingerprint: fp,
      groupEffects: [{
        kind: 'ensure_member', memberId: crypto.randomUUID(), groupRef: groupId,
        userId, membershipExistedAtPrepare: true,
      }],
    })
    await pool.query(
      `DELETE FROM attendance_group_members WHERE org_id=$1 AND group_id=$2 AND user_id=$3`,
      [orgId, groupId, userId],
    )
    const worker = await pool.connect()
    try {
      await worker.query('BEGIN')
      expect(
        await lockAndRecheckAttendanceLegacyGroupPreconditionsV1(trx(worker), plan),
      ).toBe(false)
      await worker.query('ROLLBACK')
    } finally {
      worker.release()
    }
    await zeroResidue(pool, orgId)
  })

  it('2B worker-lock-first: existing-member held → mutator blocks; worker succeeds', async () => {
    const groupId = crypto.randomUUID()
    const userId = `em-hold-${run}`
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, timezone) VALUES ($1,$2,'EM Hold','UTC')`,
      [groupId, orgId],
    )
    await pool.query(
      `INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1,$2,$3)`,
      [orgId, groupId, userId],
    )
    const fp = computeLegacyImportGroupStateFingerprintV1({
      groups: [{ id: groupId, orgId, name: 'EM Hold', code: null, timezone: 'UTC', ruleSetId: null }],
      memberships: [{ orgId, groupId, userId, exists: true }],
    })
    const plan = groupPlan({
      orgId, groupRevision: 0, groupStateFingerprint: fp,
      groupEffects: [{
        kind: 'ensure_member', memberId: crypto.randomUUID(), groupRef: groupId,
        userId, membershipExistedAtPrepare: true,
      }],
    })
    const worker = await pool.connect()
    const mutator = await pool.connect()
    try {
      await worker.query('BEGIN')
      expect(
        await lockAndRecheckAttendanceLegacyGroupPreconditionsV1(trx(worker), plan),
      ).toBe(true)
      const mutPromise = (async () => {
        await mutator.query('BEGIN')
        await mutator.query(
          `DELETE FROM attendance_group_members WHERE org_id=$1 AND group_id=$2 AND user_id=$3`,
          [orgId, groupId, userId],
        )
        await mutator.query('COMMIT')
      })()
      await waitUntilLockBlocked(pool, mutator.processID)
      const still = await worker.query(
        `SELECT 1 FROM attendance_group_members WHERE org_id=$1 AND group_id=$2 AND user_id=$3`,
        [orgId, groupId, userId],
      )
      expect(still.rows.length).toBe(1)
      await worker.query('COMMIT')
      await mutPromise
      const gone = await pool.query(
        `SELECT 1 FROM attendance_group_members WHERE org_id=$1 AND group_id=$2 AND user_id=$3`,
        [orgId, groupId, userId],
      )
      expect(gone.rows.length).toBe(0)
    } finally {
      await worker.query('ROLLBACK').catch(() => undefined)
      await mutator.query('ROLLBACK').catch(() => undefined)
      worker.release()
      mutator.release()
    }
  })

  // -------------------------------------------------------------------------
  // Branch 3: missing-group name-key insert
  // -------------------------------------------------------------------------

  it('3A mutator-first: missing-group name appears → worker fails, zero residue', async () => {
    const mintedId = crypto.randomUUID()
    const name = `MG Appear ${run}`
    const fp = computeLegacyImportGroupStateFingerprintV1({ groups: [], memberships: [] })
    const plan = groupPlan({
      orgId, groupRevision: 0, groupStateFingerprint: fp,
      groupEffects: [{
        kind: 'ensure_group', groupId: mintedId, normalizedName: name.toLowerCase(),
        displayName: name, code: null, timezone: 'UTC', ruleSetId: null,
        groupExistedAtPrepare: false,
      }],
    })
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, timezone) VALUES ($1,$2,$3,'UTC')`,
      [crypto.randomUUID(), orgId, name],
    )
    const worker = await pool.connect()
    try {
      await worker.query('BEGIN')
      expect(
        await lockAndRecheckAttendanceLegacyGroupPreconditionsV1(trx(worker), plan),
      ).toBe(false)
      await worker.query('ROLLBACK')
    } finally {
      worker.release()
    }
    await zeroResidue(pool, orgId)
  })

  it('3B worker-lock-first: missing-group revision held → mutator name-insert blocks; worker succeeds', async () => {
    const mintedId = crypto.randomUUID()
    const name = `MG Hold ${run}`
    const fp = computeLegacyImportGroupStateFingerprintV1({ groups: [], memberships: [] })
    const plan = groupPlan({
      orgId, groupRevision: 0, groupStateFingerprint: fp,
      groupEffects: [{
        kind: 'ensure_group', groupId: mintedId, normalizedName: name.toLowerCase(),
        displayName: name, code: null, timezone: 'UTC', ruleSetId: null,
        groupExistedAtPrepare: false,
      }],
    })
    const worker = await pool.connect()
    const mutator = await pool.connect()
    try {
      await worker.query('BEGIN')
      // Worker locks revision (after empty existing-group/member sets).
      expect(
        await lockAndRecheckAttendanceLegacyGroupPreconditionsV1(trx(worker), plan),
      ).toBe(true)
      // Mutator tries to bump revision (competing writer) — blocks on FOR UPDATE.
      const mutPromise = (async () => {
        await mutator.query('BEGIN')
        await mutator.query(
          `SELECT revision FROM attendance_group_effect_revisions WHERE org_id=$1 FOR UPDATE`,
          [orgId],
        )
        await mutator.query(
          `INSERT INTO attendance_groups (id, org_id, name, timezone) VALUES ($1,$2,$3,'UTC')`,
          [crypto.randomUUID(), orgId, name],
        )
        await mutator.query('COMMIT')
      })()
      await waitUntilLockBlocked(pool, mutator.processID)
      // Name still absent under worker snapshot/locks.
      const absent = await worker.query(
        `SELECT 1 FROM attendance_groups WHERE org_id=$1 AND lower(btrim(name))=$2`,
        [orgId, name.toLowerCase()],
      )
      expect(absent.rows.length).toBe(0)
      await worker.query('COMMIT')
      await mutPromise
      // After release, mutator insert lands.
      const present = await pool.query(
        `SELECT 1 FROM attendance_groups WHERE org_id=$1 AND lower(btrim(name))=$2`,
        [orgId, name.toLowerCase()],
      )
      expect(present.rows.length).toBe(1)
    } finally {
      await worker.query('ROLLBACK').catch(() => undefined)
      await mutator.query('ROLLBACK').catch(() => undefined)
      worker.release()
      mutator.release()
    }
  })

  // -------------------------------------------------------------------------
  // Branch 4: missing-member pair insert
  // -------------------------------------------------------------------------

  it('4A mutator-first: missing-member pair appears → worker fails, zero residue', async () => {
    const groupId = crypto.randomUUID()
    const userId = `mm-appear-${run}`
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, timezone) VALUES ($1,$2,'MM Appear','UTC')`,
      [groupId, orgId],
    )
    const fp = computeLegacyImportGroupStateFingerprintV1({
      groups: [{ id: groupId, orgId, name: 'MM Appear', code: null, timezone: 'UTC', ruleSetId: null }],
      memberships: [{ orgId, groupId, userId, exists: false }],
    })
    const plan = groupPlan({
      orgId, groupRevision: 0, groupStateFingerprint: fp,
      groupEffects: [{
        kind: 'ensure_member', memberId: crypto.randomUUID(), groupRef: groupId,
        userId, membershipExistedAtPrepare: false,
      }],
    })
    await pool.query(
      `INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1,$2,$3)`,
      [orgId, groupId, userId],
    )
    const worker = await pool.connect()
    try {
      await worker.query('BEGIN')
      expect(
        await lockAndRecheckAttendanceLegacyGroupPreconditionsV1(trx(worker), plan),
      ).toBe(false)
      await worker.query('ROLLBACK')
    } finally {
      worker.release()
    }
    await zeroResidue(pool, orgId)
  })

  it('4B worker-lock-first: missing-member revision held → mutator member-insert blocks; worker succeeds', async () => {
    const groupId = crypto.randomUUID()
    const userId = `mm-hold-${run}`
    await pool.query(
      `INSERT INTO attendance_groups (id, org_id, name, timezone) VALUES ($1,$2,'MM Hold','UTC')`,
      [groupId, orgId],
    )
    const fp = computeLegacyImportGroupStateFingerprintV1({
      groups: [{ id: groupId, orgId, name: 'MM Hold', code: null, timezone: 'UTC', ruleSetId: null }],
      memberships: [{ orgId, groupId, userId, exists: false }],
    })
    const plan = groupPlan({
      orgId, groupRevision: 0, groupStateFingerprint: fp,
      groupEffects: [{
        kind: 'ensure_member', memberId: crypto.randomUUID(), groupRef: groupId,
        userId, membershipExistedAtPrepare: false,
      }],
    })
    const worker = await pool.connect()
    const mutator = await pool.connect()
    try {
      await worker.query('BEGIN')
      expect(
        await lockAndRecheckAttendanceLegacyGroupPreconditionsV1(trx(worker), plan),
      ).toBe(true)
      const mutPromise = (async () => {
        await mutator.query('BEGIN')
        await mutator.query(
          `SELECT revision FROM attendance_group_effect_revisions WHERE org_id=$1 FOR UPDATE`,
          [orgId],
        )
        await mutator.query(
          `INSERT INTO attendance_group_members (org_id, group_id, user_id) VALUES ($1,$2,$3)`,
          [orgId, groupId, userId],
        )
        await mutator.query('COMMIT')
      })()
      await waitUntilLockBlocked(pool, mutator.processID)
      const absent = await worker.query(
        `SELECT 1 FROM attendance_group_members WHERE org_id=$1 AND group_id=$2 AND user_id=$3`,
        [orgId, groupId, userId],
      )
      expect(absent.rows.length).toBe(0)
      await worker.query('COMMIT')
      await mutPromise
      const present = await pool.query(
        `SELECT 1 FROM attendance_group_members WHERE org_id=$1 AND group_id=$2 AND user_id=$3`,
        [orgId, groupId, userId],
      )
      expect(present.rows.length).toBe(1)
    } finally {
      await worker.query('ROLLBACK').catch(() => undefined)
      await mutator.query('ROLLBACK').catch(() => undefined)
      worker.release()
      mutator.release()
    }
  })

  // -------------------------------------------------------------------------
  // Mutation / serialization legs
  // -------------------------------------------------------------------------

  it('mutation: production recheck does not swallow 40001/40P01 as false', () => {
    expect(isRetryableSqlState({ code: '40001' })).toBe(true)
    expect(isRetryableSqlState({ code: '40P01' })).toBe(true)
    expect(isRetryableSqlState({ code: '23505' })).toBe(false)
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/attendance/w4c3a-legacy-plan-preconditions.ts'),
      'utf8',
    )
    expect(src).not.toMatch(/40001[\s\S]{0,80}return false/)
    expect(src).not.toMatch(/40P01[\s\S]{0,80}return false/)
    expect(src).toMatch(/SQL errors intentionally escape|SQLSTATE 40001/)
  })

  it('mutation: skip existence recheck (fingerprint bypass) is not present', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/attendance/w4c3a-legacy-plan-preconditions.ts'),
      'utf8',
    )
    expect(src).toMatch(/READ_GROUP_BY_NAME_SQL|lower\(btrim\(name\)\)/)
    expect(src).toMatch(/groupExistedAtPrepare/)
    expect(src).toMatch(/membershipExistedAtPrepare/)
  })
})
