/**
 * W4C-2 P1-2 (#4556) — schema/migration half of the RATIFIED scheduled-run identity
 * amendment (docs/development/attendance-issue-4556-w4c2-scheduled-run-identity-amendment-20260726.md,
 * PR #4617, owner Bundle A) against real Postgres.
 *
 * SCOPE (this segment is the static half of section 4 step 3 — no transactions land here;
 * run-creation/resume/finalization/`abandoned` are a later slice):
 *  - migration lifecycle: fresh install, upgrade (pre-existing W4C-0 outbox rows including
 *    a `delivered` one), replay, down()-empty success + revive, down()-populated refusal
 *    (four W4C-2 surfaces independently);
 *  - the outbox discriminated union (section 1.4, gate 1): FK/CHECK/NOT-NULL legs, the
 *    NULL-discriminant hole (block 6), the widened-allowlist UPDATE attack, delivered-row
 *    terminality;
 *  - closed-set parity (gate 9): the TS copy vs. THIS migration's own local eight-member
 *    literal — not the already-applied W4C-0 migration's six-member constant;
 *  - run row invariants (gate 11): at-most-one-`running`, generic-allowlist UPDATE guard
 *    (legal/illegal transitions, frozen-column drift), target immutability, frozen-count
 *    cross-check (both insert-side AND the target-side mirror trigger);
 *  - derived-identity binding (gate 12 DB half) reusing the RATIFIED W4C-0 SQL UUIDv5
 *    boundary;
 *  - the append-only per-target outcome side table and its deferred completion guard
 *    (gate 20's side-table legs, O-3=(a)): uq_asrto_target, closed reason code,
 *    still-immutable target-after-outcome, and the completion guard's three legs
 *    (missing outcome / count mismatch / label-vs-operation-state mismatch, including the
 *    LEFT-JOIN "operation row is missing entirely" leg).
 *
 * Shared-DB discipline: every fixture identity is namespaced `w4c2p12<run>`; the migration
 * lifecycle suite runs against its OWN scratch database (created/dropped by this file,
 * mirroring attendance-w4c0-db-gates-e1.db.test.ts's own pattern) so it can exercise
 * down() without touching the shared main test database other suites depend on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import {
  up as w4c0Up,
} from '../../src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage'
import {
  up,
  down,
  W4C2_OUTBOX_EVENT_KINDS_V1,
  W4C2_SCHEDULED_REVIEW_REASON_CODES_V1,
} from '../../src/db/migrations/zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union'
import { ATTENDANCE_W4_OUTBOX_EVENT_KINDS_V1 } from '../../src/attendance/w4c0-operation-contract'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const RUN = crypto.randomUUID().slice(0, 8)
const NS = 'w4c2p12' + RUN
const HEX64_A = 'a'.repeat(64)
const HEX64_B = 'b'.repeat(64)
const HEX64_C = 'c'.repeat(64)
const SCHEDULED_OP_NAMESPACE = 'e4363171-f53f-47d7-a074-607ef3fad391'

function uuid(): string {
  return crypto.randomUUID()
}

function uuidv5(nsUuid: string, nameBytes: Buffer): string {
  const nsBytes = Buffer.from(nsUuid.replace(/-/g, ''), 'hex')
  const digest = crypto.createHash('sha1').update(Buffer.concat([nsBytes, nameBytes])).digest().subarray(0, 16)
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function scheduledOperationId(runId: string, userId: string, workDate: string): string {
  const name = Buffer.concat([
    Buffer.from(runId, 'utf8'),
    Buffer.from([0]),
    Buffer.from(userId, 'utf8'),
    Buffer.from([0]),
    Buffer.from(workDate, 'utf8'),
  ])
  return uuidv5(SCHEDULED_OP_NAMESPACE, name)
}

async function catchInTxn(pool: Pool, fn: (client: PoolClient) => Promise<void>): Promise<unknown> {
  const client = await pool.connect()
  let caught: unknown
  try {
    await client.query('BEGIN')
    try {
      await fn(client)
      await client.query('COMMIT')
    } catch (error) {
      caught = error
      await client.query('ROLLBACK').catch(() => undefined)
    }
  } finally {
    client.release()
  }
  return caught
}

async function insertOperationRow(
  pool: Pool,
  orgId: string,
  operationId: string,
  state: 'claimed' | 'completed' | 'canceled',
  runId: string,
  userId: string,
  workDate: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO attendance_result_operations (
        org_id, entrypoint, operation_id, identity_source_kind, source_root_id, proof_user_id, proof_work_date,
        source_ref, actor_id, actor_posture, capability, subject_scope, command_fingerprint, accepted_write_posture,
        state, response_snapshot
      ) VALUES ($1,'scheduled',$2,'scheduled',$3,$4,$5,'ref:w4c2p12','actor-w4c2p12','scheduler','scheduled','{}'::jsonb,$6,'shadow',$7,$8)`,
    [orgId, operationId, runId, userId, workDate, HEX64_A, state, state === 'claimed' ? null : '{}'],
  )
}

/**
 * The run row's frozen-count guard is a DEFERRED constraint trigger — it only fires at
 * COMMIT of the transaction that inserted the run row. Each bare `pool.query()` call is
 * its OWN auto-committed statement, so the run row and its target rows MUST be inserted
 * inside one explicit transaction here, or the deferred check fires on the run insert's
 * own single-statement transaction before any target row exists.
 */
async function makeRunWithGenerateTargets(
  pool: Pool,
  orgId: string,
  workDate: string,
  initiator: 'cron' | 'admin_run',
  users: string[],
  reviewCount = 0,
): Promise<{ runId: string; opIds: string[] }> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const runRes = await client.query(
      `INSERT INTO attendance_scheduled_runs (org_id, entrypoint, initiator, work_date, generation, accepted_write_posture, target_set_fingerprint, expected_user_count, review_count)
       VALUES ($1,'scheduled',$2,$3,1,'shadow',$4,$5,$6) RETURNING run_id::text AS run_id`,
      [orgId, initiator, workDate, HEX64_B, users.length, reviewCount],
    )
    const runId = runRes.rows[0].run_id as string
    const opIds: string[] = []
    for (let i = 0; i < users.length; i += 1) {
      const opId = scheduledOperationId(runId, users[i], workDate)
      opIds.push(opId)
      await client.query(
        `INSERT INTO attendance_scheduled_run_targets (org_id, run_id, work_date, ordinal, user_id, target_kind, operation_id)
         VALUES ($1,$2,$3,$4,$5,'generate',$6)`,
        [orgId, runId, workDate, i, users[i], opId],
      )
    }
    await client.query('COMMIT')
    return { runId, opIds }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

describeIfDatabase('W4C-2 P1-2 — scheduled-run identity migration + outbox union (real DB)', () => {
  // -------------------------------------------------------------------------
  // A. Static closed-set assertions (no DB needed, kept here for co-location with the
  //    gate-9 parity leg that DOES need the DB copy).
  // -------------------------------------------------------------------------
  describe('gate 9 — closed-set parity (executed, not source regex)', () => {
    it('the TS runtime copy and this migration files own local eight-member literal are equal in membership AND order', () => {
      expect([...ATTENDANCE_W4_OUTBOX_EVENT_KINDS_V1]).toEqual([...W4C2_OUTBOX_EVENT_KINDS_V1])
    })

    it('has exactly the eight expected members (six W4C-0 + two run-level)', () => {
      expect([...W4C2_OUTBOX_EVENT_KINDS_V1]).toEqual([
        'attendance.punched',
        'attendance.requested',
        'attendance.request.updated',
        'attendance.request.cancelled',
        'attendance.resolved',
        'attendance.outdoorPunch.requested',
        'attendance.absence.generated',
        'attendance.work_date.review_required',
      ])
    })

    it('section 1.2.1: the closed review-reason set is exactly the 14 reachable members (11 unresolved + 3 literals), not the full 20-member REASON map', () => {
      expect(W4C2_SCHEDULED_REVIEW_REASON_CODES_V1.length).toBe(14)
      expect([...W4C2_SCHEDULED_REVIEW_REASON_CODES_V1]).toEqual([
        'NO_MATCHING_SHIFT',
        'FREE_TIME_NO_SHIFT',
        'UNSCHEDULED_NO_SHIFT',
        'EXPLICIT_IMPORT_REQUIRES_SHIFT',
        'EXPLICIT_SHIFT_MISMATCH',
        'MALFORMED_CROSS_ORG_REFERENCE',
        'MALFORMED_CROSS_USER_REFERENCE',
        'MALFORMED_CANDIDATE_SHAPE',
        'MALFORMED_CANDIDATE_SOURCE',
        'INVALID_INPUT',
        'NO_PUBLISHED_CANDIDATE',
        'WORK_DATE_ATTRIBUTION_MISMATCH',
        'WORK_DATE_ATTRIBUTION_AMBIGUOUS',
        'WORK_DATE_ATTRIBUTION_UNRESOLVED',
      ])
      // Excluded (resolved + ambiguous segments), confirmed absent:
      for (const excluded of [
        'OPEN_PREVIOUS_NIGHT_RECORD',
        'CURRENT_DAY_CONTAINING_SHIFT',
        'PREVIOUS_NIGHT_CONTAINING_SHIFT',
        'SINGLE_MATCHING_CANDIDATE',
        'FROZEN_ATTRIBUTION',
        'OVERTIME_EXTENDED_WINDOW',
        'POST_SHIFT_ATTRIBUTION_TAIL',
        'OVERLAPPING_SHIFT_WINDOWS',
        'MULTIPLE_PUBLISHED_CANDIDATES',
      ]) {
        expect((W4C2_SCHEDULED_REVIEW_REASON_CODES_V1 as readonly string[]).includes(excluded)).toBe(false)
      }
    })
  })

  // -------------------------------------------------------------------------
  // B. Migration lifecycle (scratch database) — fresh/upgrade/replay/down-empty/
  //    down-populated, gate 14.
  // -------------------------------------------------------------------------
  describe('migration lifecycle (scratch database)', () => {
    const scratchName = `ms2_w4c2_p12_${RUN}`
    let adminPool: Pool
    let scratchPool: Pool
    let scratchKyselyPool: Pool
    let scratchDb: Kysely<unknown>

    beforeAll(async () => {
      const adminUrl = new URL(dbUrl as string)
      adminUrl.pathname = '/postgres'
      adminPool = new Pool({ connectionString: adminUrl.toString() })
      await adminPool.query(`DROP DATABASE IF EXISTS ${scratchName}`)
      await adminPool.query(`CREATE DATABASE ${scratchName}`)
      const scratchUrl = new URL(dbUrl as string)
      scratchUrl.pathname = `/${scratchName}`
      scratchPool = new Pool({ connectionString: scratchUrl.toString() })
      scratchKyselyPool = new Pool({ connectionString: scratchUrl.toString() })
      scratchDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: scratchKyselyPool }) })
      // Minimal legacy replicas W4C-0's own migration needs (mirrors that file's own
      // scratch fixture — this migration depends on W4C-0's up() having already run).
      await scratchPool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
      await scratchPool.query(`
        CREATE TABLE attendance_records (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id text NOT NULL, work_date date NOT NULL, first_in_at timestamptz, last_out_at timestamptz,
          work_minutes integer NOT NULL DEFAULT 0, late_minutes integer NOT NULL DEFAULT 0,
          early_leave_minutes integer NOT NULL DEFAULT 0, status varchar(64) NOT NULL DEFAULT 'normal',
          org_id text NOT NULL DEFAULT 'default')`)
      await scratchPool.query(`
        CREATE TABLE attendance_requests (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id text NOT NULL, work_date date NOT NULL, request_type varchar(30) NOT NULL,
          status varchar(20) NOT NULL DEFAULT 'pending', org_id text NOT NULL DEFAULT 'default')`)
      await scratchPool.query(`
        CREATE TABLE attendance_import_jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL DEFAULT 'default',
          batch_id uuid NOT NULL, created_by text NOT NULL, idempotency_key text,
          status varchar(20) NOT NULL DEFAULT 'queued', progress integer NOT NULL DEFAULT 0,
          total integer NOT NULL DEFAULT 0, payload jsonb NOT NULL DEFAULT '{}'::jsonb)`)
    }, 60000)

    afterAll(async () => {
      for (const p of [scratchPool, scratchKyselyPool, adminPool]) p?.on('error', () => undefined)
      await scratchDb?.destroy()
      await scratchPool?.end()
      await adminPool?.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => undefined)
      await adminPool?.end()
    })

    it('fresh install: W4C-0 up() then this migration up() creates the full W4C-2 surface', async () => {
      await w4c0Up(scratchDb)
      await up(scratchDb)
      const { rows } = await scratchPool.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])`,
        [['attendance_scheduled_runs', 'attendance_scheduled_run_targets', 'attendance_scheduled_run_target_outcomes']],
      )
      expect(rows[0].n).toBe(3)
      const cols = await scratchPool.query(
        `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='attendance_result_event_outbox' AND column_name IN ('identity_kind','scheduled_run_id')`,
      )
      expect(cols.rows[0].n).toBe(2)
    }, 60000)

    it('replay: a second up() succeeds and changes nothing structural', async () => {
      await up(scratchDb)
      const { rows } = await scratchPool.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])`,
        [['attendance_scheduled_runs', 'attendance_scheduled_run_targets', 'attendance_scheduled_run_target_outcomes']],
      )
      expect(rows[0].n).toBe(3)
    }, 60000)

    it('down() on empty W4C-2 surfaces succeeds, restores the exact W4C-0 outbox shape byte-equivalently; up() revives', async () => {
      await down(scratchDb)
      const tables = await scratchPool.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])`,
        [['attendance_scheduled_runs', 'attendance_scheduled_run_targets', 'attendance_scheduled_run_target_outcomes']],
      )
      expect(tables.rows[0].n).toBe(0)
      const outboxShape = await scratchPool.query(
        `SELECT
           (SELECT count(*)::int FROM information_schema.columns WHERE table_name='attendance_result_event_outbox' AND column_name IN ('identity_kind','scheduled_run_id')) AS new_cols,
           (SELECT count(*)::int FROM pg_constraint WHERE conname='uq_areo_identity') AS orig_constraint,
           (SELECT is_nullable FROM information_schema.columns WHERE table_name='attendance_result_event_outbox' AND column_name='operation_id') AS op_nullable`,
      )
      expect(outboxShape.rows[0].new_cols).toBe(0)
      expect(outboxShape.rows[0].orig_constraint).toBe(1)
      expect(outboxShape.rows[0].op_nullable).toBe('NO')
      const kinds = await scratchPool.query(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='chk_areo_event_kind'`,
      )
      expect(String(kinds.rows[0].def)).not.toMatch(/absence\.generated/)

      await up(scratchDb)
      const revived = await scratchPool.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1::text[])`,
        [['attendance_scheduled_runs', 'attendance_scheduled_run_targets', 'attendance_scheduled_run_target_outcomes']],
      )
      expect(revived.rows[0].n).toBe(3)
    }, 60000)

    it('down() fail-closes BEFORE any DDL while rows exist in the reachable (run-row) category', async () => {
      const org = `${NS}-down-blocked`
      const workDate = '2026-09-01'
      const user1 = uuid()
      await makeRunWithGenerateTargets(scratchPool, org, workDate, 'cron', [user1])

      await expect(down(scratchDb)).rejects.toThrow(/W4C2_DOWN_BLOCKED.*attendance_scheduled_runs/s)
      const stillThere = await scratchPool.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='attendance_scheduled_runs'`,
      )
      expect(stillThere.rows[0].n).toBe(1) // zero DDL happened
    }, 60000)

    it('down() guard: each of the OTHER three category checks independently detects rows in its OWN table (fail-closed defense in depth — every generate/outcome/outbox scheduled-run row structurally requires a run row, so the run-row category always wins first in normal operation; these legs prove the later guards are not dead code by populating each table directly, bypassing FK/triggers via session_replication_role=replica, exactly as a corrupted or manually-edited database could)', async () => {
      const isolationName = `${scratchName}_isolation`
      await adminPool.query(`DROP DATABASE IF EXISTS ${isolationName}`)
      await adminPool.query(`CREATE DATABASE ${isolationName}`)
      const isolationUrl = new URL(dbUrl as string)
      isolationUrl.pathname = `/${isolationName}`
      const isolationPool = new Pool({ connectionString: isolationUrl.toString() })
      const isolationKyselyPool = new Pool({ connectionString: isolationUrl.toString() })
      const isolationDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: isolationKyselyPool }) })
      try {
        await isolationPool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
        await isolationPool.query(`CREATE TABLE attendance_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL, first_in_at timestamptz, last_out_at timestamptz, work_minutes integer NOT NULL DEFAULT 0, late_minutes integer NOT NULL DEFAULT 0, early_leave_minutes integer NOT NULL DEFAULT 0, status varchar(64) NOT NULL DEFAULT 'normal', org_id text NOT NULL DEFAULT 'default')`)
        await isolationPool.query(`CREATE TABLE attendance_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL, request_type varchar(30) NOT NULL, status varchar(20) NOT NULL DEFAULT 'pending', org_id text NOT NULL DEFAULT 'default')`)
        await isolationPool.query(`CREATE TABLE attendance_import_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL DEFAULT 'default', batch_id uuid NOT NULL, created_by text NOT NULL, idempotency_key text, status varchar(20) NOT NULL DEFAULT 'queued', progress integer NOT NULL DEFAULT 0, total integer NOT NULL DEFAULT 0, payload jsonb NOT NULL DEFAULT '{}'::jsonb)`)
        await w4c0Up(isolationDb)
        await up(isolationDb)

        const org = `${NS}-isolation`
        const client = await isolationPool.connect()
        try {
          // Category: attendance_scheduled_run_targets alone (bypass FK to a run row).
          await client.query('SET session_replication_role = replica')
          await client.query(
            `INSERT INTO attendance_scheduled_run_targets (org_id, run_id, work_date, ordinal, user_id, target_kind, review_reason_code)
             VALUES ($1, gen_random_uuid(), '2026-09-25', 0, gen_random_uuid(), 'review', 'INVALID_INPUT')`,
            [org],
          )
          await client.query('SET session_replication_role = origin')
          await expect(down(isolationDb)).rejects.toThrow(/W4C2_DOWN_BLOCKED.*attendance_scheduled_run_targets/s)

          await client.query('SET session_replication_role = replica')
          await client.query(`DELETE FROM attendance_scheduled_run_targets WHERE org_id = $1`, [org])
          await client.query('SET session_replication_role = origin')

          // Category: attendance_scheduled_run_target_outcomes alone.
          await client.query('SET session_replication_role = replica')
          await client.query(
            `INSERT INTO attendance_scheduled_run_target_outcomes (org_id, run_id, target_id, terminal_outcome)
             VALUES ($1, gen_random_uuid(), gen_random_uuid(), 'completed')`,
            [org],
          )
          await client.query('SET session_replication_role = origin')
          await expect(down(isolationDb)).rejects.toThrow(/W4C2_DOWN_BLOCKED.*attendance_scheduled_run_target_outcomes/s)

          await client.query('SET session_replication_role = replica')
          await client.query(`DELETE FROM attendance_scheduled_run_target_outcomes WHERE org_id = $1`, [org])
          await client.query('SET session_replication_role = origin')

          // Category: attendance_result_event_outbox scheduled-run rows alone.
          await client.query('SET session_replication_role = replica')
          await client.query(
            `INSERT INTO attendance_result_event_outbox (org_id, entrypoint, identity_kind, scheduled_run_id, event_kind, payload, payload_schema_version, business_key_fingerprint)
             VALUES ($1,'scheduled','scheduled_run', gen_random_uuid(), 'attendance.absence.generated','{}'::jsonb,1,$2)`,
            [org, HEX64_A],
          )
          await client.query('SET session_replication_role = origin')
          await expect(down(isolationDb)).rejects.toThrow(/W4C2_DOWN_BLOCKED.*attendance_result_event_outbox scheduled-run rows/s)
        } finally {
          client.release()
        }
      } finally {
        isolationPool.on('error', () => undefined)
        isolationKyselyPool.on('error', () => undefined)
        await isolationDb.destroy()
        await isolationPool.end()
        await adminPool.query(`DROP DATABASE IF EXISTS ${isolationName} WITH (FORCE)`).catch(() => undefined)
      }
    }, 60000)

    it('upgrade: a database stopped at W4C-0 with pre-existing delivered + pending outbox rows migrates cleanly; the delivered row is preserved byte-identically; the upgrade positive control succeeds', async () => {
      // Fresh scratch DB #2 stopped exactly at the W4C-0 shape.
      const upgradeName = `${scratchName}_upgrade`
      await adminPool.query(`DROP DATABASE IF EXISTS ${upgradeName}`)
      await adminPool.query(`CREATE DATABASE ${upgradeName}`)
      const upgradeUrl = new URL(dbUrl as string)
      upgradeUrl.pathname = `/${upgradeName}`
      const upgradePool = new Pool({ connectionString: upgradeUrl.toString() })
      const upgradeKyselyPool = new Pool({ connectionString: upgradeUrl.toString() })
      const upgradeDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: upgradeKyselyPool }) })
      try {
        await upgradePool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto')
        await upgradePool.query(`CREATE TABLE attendance_records (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL, first_in_at timestamptz, last_out_at timestamptz, work_minutes integer NOT NULL DEFAULT 0, late_minutes integer NOT NULL DEFAULT 0, early_leave_minutes integer NOT NULL DEFAULT 0, status varchar(64) NOT NULL DEFAULT 'normal', org_id text NOT NULL DEFAULT 'default')`)
        await upgradePool.query(`CREATE TABLE attendance_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id text NOT NULL, work_date date NOT NULL, request_type varchar(30) NOT NULL, status varchar(20) NOT NULL DEFAULT 'pending', org_id text NOT NULL DEFAULT 'default')`)
        await upgradePool.query(`CREATE TABLE attendance_import_jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id text NOT NULL DEFAULT 'default', batch_id uuid NOT NULL, created_by text NOT NULL, idempotency_key text, status varchar(20) NOT NULL DEFAULT 'queued', progress integer NOT NULL DEFAULT 0, total integer NOT NULL DEFAULT 0, payload jsonb NOT NULL DEFAULT '{}'::jsonb)`)
        await w4c0Up(upgradeDb)

        const org = `${NS}-upgrade`
        const opId = uuid()
        await upgradePool.query(
          `INSERT INTO attendance_result_operations (org_id, entrypoint, operation_id, identity_source_kind, source_ref, actor_id, actor_posture, capability, subject_scope, command_fingerprint, accepted_write_posture, state, response_snapshot)
           VALUES ($1,'live_punch',$2,'direct_live_punch','ref:upg','actor-upg','self','punch','{}'::jsonb,$3,'shadow','completed','{}'::jsonb)`,
          [org, opId, HEX64_A],
        )
        const delivered = await upgradePool.query(
          `INSERT INTO attendance_result_event_outbox (org_id, entrypoint, operation_id, event_kind, payload, payload_schema_version, business_key_fingerprint, delivery_state, delivered_at)
           VALUES ($1,'live_punch',$2,'attendance.punched','{"v":1}'::jsonb,1,$3,'delivered',now()) RETURNING id::text AS id, to_jsonb(attendance_result_event_outbox.*) AS snapshot`,
          [org, opId, HEX64_B],
        )
        await upgradePool.query(
          `INSERT INTO attendance_result_event_outbox (org_id, entrypoint, operation_id, event_kind, payload, payload_schema_version, business_key_fingerprint, delivery_state)
           VALUES ($1,'live_punch',$2,'attendance.requested','{"v":1}'::jsonb,1,$3,'pending')`,
          [org, opId, HEX64_C],
        )

        await up(upgradeDb)

        const after = await upgradePool.query(
          `SELECT id::text AS id, org_id, entrypoint, operation_id::text AS operation_id, identity_kind, scheduled_run_id, event_kind, payload, payload_schema_version, business_key_fingerprint, delivery_state, attempts, delivered_at
             FROM attendance_result_event_outbox WHERE id = $1::uuid`,
          [delivered.rows[0].id],
        )
        const row = after.rows[0]
        expect(row.identity_kind).toBe('operation')
        expect(row.scheduled_run_id).toBeNull()
        expect(row.delivery_state).toBe('delivered')
        expect(row.attempts).toBe(0)
        expect(row.event_kind).toBe('attendance.punched')
        expect(row.payload).toEqual({ v: 1 })
        expect(row.business_key_fingerprint).toBe(HEX64_B)
        expect(row.operation_id).toBe(opId)

        // Upgrade positive control: the eight-member chk_areo_event_kind now admits a
        // run-level insert on this upgraded (not fresh) database.
        const runRes = await upgradePool.query(
          `INSERT INTO attendance_scheduled_runs (org_id, entrypoint, initiator, work_date, generation, accepted_write_posture, target_set_fingerprint, expected_user_count, review_count)
           VALUES ($1,'scheduled','cron','2026-09-02',1,'shadow',$2,0,0) RETURNING run_id::text AS run_id`,
          [org, HEX64_A],
        )
        const controlInsert = await upgradePool.query(
          `INSERT INTO attendance_result_event_outbox (org_id, entrypoint, identity_kind, scheduled_run_id, event_kind, payload, payload_schema_version, business_key_fingerprint)
           VALUES ($1,'scheduled','scheduled_run',$2,'attendance.absence.generated','{"total":0}'::jsonb,1,$3) RETURNING id`,
          [org, runRes.rows[0].run_id, 'd'.repeat(64)],
        )
        expect(controlInsert.rows.length).toBe(1)
      } finally {
        upgradePool.on('error', () => undefined)
        upgradeKyselyPool.on('error', () => undefined)
        await upgradeDb.destroy()
        await upgradePool.end()
        await adminPool.query(`DROP DATABASE IF EXISTS ${upgradeName} WITH (FORCE)`).catch(() => undefined)
      }
    }, 60000)
  })

  // -------------------------------------------------------------------------
  // C. Behavior matrix against the shared, already-migrated main database.
  // -------------------------------------------------------------------------
  describe('behavior matrix (main database, real shapes)', () => {
    const pool = new Pool({ connectionString: dbUrl })
    let mainDb: Kysely<unknown> | undefined

    beforeAll(async () => {
      mainDb = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl }) }) })
      await w4c0Up(mainDb)
      await up(mainDb)
    }, 60000)

    afterAll(async () => {
      await mainDb?.destroy()
      await pool.end()
    })

    describe('gate 12 / derived-identity binding + gate 11 run-row invariants', () => {
      it('a target row whose operation_id is not the canonical derivation is refused (chk_asrt_derived_operation)', async () => {
        const org = `${NS}-derived`
        const workDate = '2026-09-03'
        // expected_user_count=0: this fixture never successfully inserts a valid target
        // row (the whole point of the leg), so the frozen-counts guard must not fire.
        const runRes = await pool.query(
          `INSERT INTO attendance_scheduled_runs (org_id, entrypoint, initiator, work_date, generation, accepted_write_posture, target_set_fingerprint, expected_user_count, review_count)
           VALUES ($1,'scheduled','cron',$2,1,'shadow',$3,0,0) RETURNING run_id::text AS run_id`,
          [org, workDate, HEX64_A],
        )
        const runId = runRes.rows[0].run_id
        const caught = await catchInTxn(pool, async (client) => {
          await client.query(
            `INSERT INTO attendance_scheduled_run_targets (org_id, run_id, work_date, ordinal, user_id, target_kind, operation_id)
             VALUES ($1,$2,$3,0,$4,'generate',$5)`,
            [org, runId, workDate, uuid(), uuid()],
          )
        })
        expect(String((caught as Error).message)).toMatch(/chk_asrt_derived_operation/)
      })

      it('at most one running run per (org, initiator, work_date); a second attempt fails on the partial unique index', async () => {
        const org = `${NS}-onerun`
        const workDate = '2026-09-04'
        await makeRunWithGenerateTargets(pool, org, workDate, 'cron', [])
        const caught = await catchInTxn(pool, async (client) => {
          await client.query(
            `INSERT INTO attendance_scheduled_runs (org_id, entrypoint, initiator, work_date, generation, accepted_write_posture, target_set_fingerprint, expected_user_count, review_count)
             VALUES ($1,'scheduled','cron',$2,2,'shadow',$3,0,0)`,
            [org, workDate, HEX64_B],
          )
        })
        expect(String((caught as Error).message)).toMatch(/uq_asr_one_running|duplicate key/)
      })

      it('run row: illegal transition completed->running is refused; running->running with frozen-column drift is refused; running->running with only mutable-field no-op change is permitted', async () => {
        const org = `${NS}-transitions`
        const workDate = '2026-09-05'
        const { runId } = await makeRunWithGenerateTargets(pool, org, workDate, 'cron', [])

        const illegal = await catchInTxn(pool, async (client) => {
          await client.query(
            `UPDATE attendance_scheduled_runs SET state='completed', completed_user_count=0, generated_count=0, finalized_at=now() WHERE run_id=$1`,
            [runId],
          )
          await client.query(
            `UPDATE attendance_scheduled_runs SET state='running', completed_user_count=NULL, generated_count=NULL, finalized_at=NULL WHERE run_id=$1`,
            [runId],
          )
        })
        expect(String((illegal as Error).message)).toMatch(/W4C2_RUN_STATE/)

        const { runId: runId2 } = await makeRunWithGenerateTargets(pool, `${org}-2`, workDate, 'cron', [])
        const drift = await catchInTxn(pool, async (client) => {
          await client.query(`UPDATE attendance_scheduled_runs SET accepted_write_posture='authoritative' WHERE run_id=$1`, [runId2])
        })
        expect(String((drift as Error).message)).toMatch(/W4C2_RUN_STATE/)

        // Permitted: a running->running UPDATE that changes nothing (idempotent no-op) —
        // gate 11's third leg (as distinct from the two refusal legs above).
        const noop = await catchInTxn(pool, async (client) => {
          await client.query(`UPDATE attendance_scheduled_runs SET state='running' WHERE run_id=$1`, [runId2])
        })
        expect(noop).toBeUndefined()
      })

      it('run row: DELETE and TRUNCATE are refused', async () => {
        const org = `${NS}-deltrunc`
        const { runId } = await makeRunWithGenerateTargets(pool, org, '2026-09-06', 'cron', [])
        const del = await catchInTxn(pool, async (client) => {
          await client.query(`DELETE FROM attendance_scheduled_runs WHERE run_id=$1`, [runId])
        })
        expect(String((del as Error).message)).toMatch(/W4C0_IMMUTABLE/)
      })

      it('target rows: UPDATE/DELETE refused, even after an outcome is recorded for one', async () => {
        const org = `${NS}-targetimmut`
        const workDate = '2026-09-07'
        const { runId, opIds } = await makeRunWithGenerateTargets(pool, org, workDate, 'cron', [uuid()])
        const targetRes = await pool.query(
          `SELECT id::text AS id FROM attendance_scheduled_run_targets WHERE org_id=$1 AND run_id=$2`,
          [org, runId],
        )
        const targetId = targetRes.rows[0].id

        const upd = await catchInTxn(pool, async (client) => {
          await client.query(`UPDATE attendance_scheduled_run_targets SET ordinal=999 WHERE id=$1`, [targetId])
        })
        expect(String((upd as Error).message)).toMatch(/W4C0_IMMUTABLE/)

        await pool.query(
          `INSERT INTO attendance_scheduled_run_target_outcomes (org_id, run_id, target_id, terminal_outcome) VALUES ($1,$2,$3,'completed')`,
          [org, runId, targetId],
        )
        const updAfterOutcome = await catchInTxn(pool, async (client) => {
          await client.query(`UPDATE attendance_scheduled_run_targets SET ordinal=999 WHERE id=$1`, [targetId])
        })
        expect(String((updAfterOutcome as Error).message)).toMatch(/W4C0_IMMUTABLE/)
        void opIds
      })

      it('frozen counts vs. target rows: a run created with the wrong expected_user_count is rejected at COMMIT (insert-side); a LATER extra target row is rejected at COMMIT too (target-side mirror)', async () => {
        const org = `${NS}-frozencounts`
        const workDate = '2026-09-08'

        // Insert-side: run declares expected_user_count=2 but only 1 target row exists.
        const insertSide = await catchInTxn(pool, async (client) => {
          const runRes = await client.query(
            `INSERT INTO attendance_scheduled_runs (org_id, entrypoint, initiator, work_date, generation, accepted_write_posture, target_set_fingerprint, expected_user_count, review_count)
             VALUES ($1,'scheduled','cron',$2,1,'shadow',$3,2,0) RETURNING run_id::text AS run_id`,
            [org, workDate, HEX64_A],
          )
          const runId = runRes.rows[0].run_id as string
          const u = uuid()
          await client.query(
            `INSERT INTO attendance_scheduled_run_targets (org_id, run_id, work_date, ordinal, user_id, target_kind, operation_id)
             VALUES ($1,$2,$3,0,$4,'generate',$5)`,
            [org, runId, workDate, u, scheduledOperationId(runId, u, workDate)],
          )
        })
        expect(String((insertSide as Error).message)).toMatch(/W4C2_RUN_FROZEN_COUNTS/)

        // Target-side mirror: run declares expected_user_count=1; insert exactly 1
        // matching target, then a SECOND (extra) target row in a LATER statement of the
        // same transaction — only the target-side trigger can see this.
        const targetSide = await catchInTxn(pool, async (client) => {
          const runRes = await client.query(
            `INSERT INTO attendance_scheduled_runs (org_id, entrypoint, initiator, work_date, generation, accepted_write_posture, target_set_fingerprint, expected_user_count, review_count)
             VALUES ($1,'scheduled','admin_run',$2,1,'shadow',$3,1,0) RETURNING run_id::text AS run_id`,
            [org, workDate, HEX64_B],
          )
          const runId = runRes.rows[0].run_id as string
          const u1 = uuid()
          await client.query(
            `INSERT INTO attendance_scheduled_run_targets (org_id, run_id, work_date, ordinal, user_id, target_kind, operation_id)
             VALUES ($1,$2,$3,0,$4,'generate',$5)`,
            [org, runId, workDate, u1, scheduledOperationId(runId, u1, workDate)],
          )
          const u2 = uuid()
          await client.query(
            `INSERT INTO attendance_scheduled_run_targets (org_id, run_id, work_date, ordinal, user_id, target_kind, operation_id)
             VALUES ($1,$2,$3,1,$4,'generate',$5)`,
            [org, runId, workDate, u2, scheduledOperationId(runId, u2, workDate)],
          )
        })
        expect(String((targetSide as Error).message)).toMatch(/W4C2_RUN_FROZEN_COUNTS/)
      })
    })

    describe('gate 1 — outbox discriminated union (real DB)', () => {
      it('run UUID masquerading as operation_id is refused (fk_areo_operation); operation UUID masquerading as scheduled_run_id is refused (fk_areo_scheduled_run)', async () => {
        const org = `${NS}-masq`
        const { runId, opIds } = await makeRunWithGenerateTargets(pool, org, '2026-09-09', 'cron', [uuid()])

        const asOperation = await catchInTxn(pool, async (client) => {
          await client.query(
            `INSERT INTO attendance_result_event_outbox (org_id, entrypoint, identity_kind, operation_id, event_kind, payload, payload_schema_version, business_key_fingerprint)
             VALUES ($1,'live_punch','operation',$2,'attendance.punched','{}'::jsonb,1,$3)`,
            [org, runId, HEX64_A],
          )
        })
        expect(String((asOperation as Error).message)).toMatch(/fk_areo_operation/)

        const asRun = await catchInTxn(pool, async (client) => {
          await client.query(
            `INSERT INTO attendance_result_event_outbox (org_id, entrypoint, identity_kind, scheduled_run_id, event_kind, payload, payload_schema_version, business_key_fingerprint)
             VALUES ($1,'scheduled','scheduled_run',$2,'attendance.work_date.review_required','{}'::jsonb,1,$3)`,
            [org, opIds[0], HEX64_B],
          )
        })
        expect(String((asRun as Error).message)).toMatch(/fk_areo_scheduled_run/)
      })

      it('kind<->identity map: a run-level kind with identity_kind=operation fails; a per-user kind with identity_kind=scheduled_run fails', async () => {
        const org = `${NS}-kindmap`
        const { runId, opIds } = await makeRunWithGenerateTargets(pool, org, '2026-09-10', 'cron', [uuid()])

        const runKindAsOp = await catchInTxn(pool, async (client) => {
          await client.query(
            `INSERT INTO attendance_result_event_outbox (org_id, entrypoint, identity_kind, operation_id, event_kind, payload, payload_schema_version, business_key_fingerprint)
             VALUES ($1,'live_punch','operation',$2,'attendance.absence.generated','{}'::jsonb,1,$3)`,
            [org, opIds[0], HEX64_A],
          )
        })
        expect(String((runKindAsOp as Error).message)).toMatch(/chk_areo_kind_identity_map/)

        const userKindAsRun = await catchInTxn(pool, async (client) => {
          await client.query(
            `INSERT INTO attendance_result_event_outbox (org_id, entrypoint, identity_kind, scheduled_run_id, event_kind, payload, payload_schema_version, business_key_fingerprint)
             VALUES ($1,'scheduled','scheduled_run',$2,'attendance.punched','{}'::jsonb,1,$3)`,
            [org, runId, HEX64_B],
          )
        })
        expect(String((userKindAsRun as Error).message)).toMatch(/chk_areo_kind_identity_map/)
      })

      it('entrypoint binding: identity_kind=scheduled_run with entrypoint != scheduled is refused (chk_areo_run_entrypoint)', async () => {
        const org = `${NS}-entrybind`
        const { runId } = await makeRunWithGenerateTargets(pool, org, '2026-09-11', 'cron', [])
        const caught = await catchInTxn(pool, async (client) => {
          await client.query(
            `INSERT INTO attendance_result_event_outbox (org_id, entrypoint, identity_kind, scheduled_run_id, event_kind, payload, payload_schema_version, business_key_fingerprint)
             VALUES ($1,'manual_edit','scheduled_run',$2,'attendance.absence.generated','{}'::jsonb,1,$3)`,
            [org, runId, HEX64_A],
          )
        })
        expect(String((caught as Error).message)).toMatch(/chk_areo_run_entrypoint|chk_areo_entrypoint/)
      })

      it('identity_kind: both non-null, both null, and NULL discriminant (block 6) are all refused independently', async () => {
        const org = `${NS}-exclusive`
        const { runId, opIds } = await makeRunWithGenerateTargets(pool, org, '2026-09-12', 'cron', [uuid()])

        const bothNonNull = await catchInTxn(pool, async (client) => {
          await client.query(
            `INSERT INTO attendance_result_event_outbox (org_id, entrypoint, identity_kind, operation_id, scheduled_run_id, event_kind, payload, payload_schema_version, business_key_fingerprint)
             VALUES ($1,'scheduled','scheduled_run',$2,$3,'attendance.absence.generated','{}'::jsonb,1,$4)`,
            [org, opIds[0], runId, HEX64_A],
          )
        })
        expect(String((bothNonNull as Error).message)).toMatch(/chk_areo_identity_exclusive/)

        const bothNull = await catchInTxn(pool, async (client) => {
          await client.query(
            `INSERT INTO attendance_result_event_outbox (org_id, entrypoint, identity_kind, event_kind, payload, payload_schema_version, business_key_fingerprint)
             VALUES ($1,'scheduled','scheduled_run','attendance.absence.generated','{}'::jsonb,1,$2)`,
            [org, HEX64_B],
          )
        })
        expect(String((bothNull as Error).message)).toMatch(/chk_areo_identity_exclusive|chk_areo_identity_run/)

        // A REAL backing attendance_result_operations row (not just an FK-unbacked UUID) —
        // this isolates block 6 (the NOT NULL constraint itself) from fk_areo_operation:
        // without a real backing row, a mutation that drops NOT NULL would still be
        // caught by the FK for the wrong reason, masking block 6's own absence.
        const liveOpId = uuid()
        await pool.query(
          `INSERT INTO attendance_result_operations (
              org_id, entrypoint, operation_id, identity_source_kind, source_ref, actor_id, actor_posture,
              capability, subject_scope, command_fingerprint, accepted_write_posture, state, response_snapshot
            ) VALUES ($1,'live_punch',$2,'direct_live_punch','ref:w4c2p12','actor-w4c2p12','self','punch','{}'::jsonb,$3,'shadow','completed','{}'::jsonb)`,
          [org, liveOpId, HEX64_C],
        )
        const nullDiscriminant = await catchInTxn(pool, async (client) => {
          await client.query(
            `INSERT INTO attendance_result_event_outbox (org_id, entrypoint, operation_id, event_kind, payload, payload_schema_version, business_key_fingerprint)
             VALUES ($1,'live_punch',$2,'attendance.punched','{}'::jsonb,1,$3)`,
            [org, liveOpId, HEX64_C],
          )
        })
        expect(String((nullDiscriminant as Error).message)).toMatch(/null value in column "identity_kind"|violates not-null constraint/)
      })

      it('enqueuing before the referenced operation/run row exists is refused by the FK (write-order dependency)', async () => {
        const org = `${NS}-writeorder`
        const caught = await catchInTxn(pool, async (client) => {
          await client.query(
            `INSERT INTO attendance_result_event_outbox (org_id, entrypoint, identity_kind, operation_id, event_kind, payload, payload_schema_version, business_key_fingerprint)
             VALUES ($1,'live_punch','operation',$2,'attendance.punched','{}'::jsonb,1,$3)`,
            [org, uuid(), HEX64_A],
          )
        })
        expect(String((caught as Error).message)).toMatch(/fk_areo_operation/)
      })

      it('outbox UPDATE guard: widening the mutable set by UPDATE-ing scheduled_run_id to a different run of the same org is refused (frozen); delivered rows stay terminal', async () => {
        const org = `${NS}-widen`
        const workDate = '2026-09-13'
        const { runId: run1 } = await makeRunWithGenerateTargets(pool, org, workDate, 'cron', [])
        const { runId: run2 } = await makeRunWithGenerateTargets(pool, org, '2026-09-14', 'admin_run', [])
        const inserted = await pool.query(
          `INSERT INTO attendance_result_event_outbox (org_id, entrypoint, identity_kind, scheduled_run_id, event_kind, payload, payload_schema_version, business_key_fingerprint)
           VALUES ($1,'scheduled','scheduled_run',$2,'attendance.absence.generated','{}'::jsonb,1,$3) RETURNING id::text AS id`,
          [org, run1, HEX64_A],
        )
        const outboxId = inserted.rows[0].id
        const widen = await catchInTxn(pool, async (client) => {
          await client.query(`UPDATE attendance_result_event_outbox SET scheduled_run_id=$2 WHERE id=$1`, [outboxId, run2])
        })
        expect(String((widen as Error).message)).toMatch(/W4C0_OUTBOX/)

        await pool.query(`UPDATE attendance_result_event_outbox SET delivery_state='delivered', delivered_at=now() WHERE id=$1`, [outboxId])
        const afterDelivered = await catchInTxn(pool, async (client) => {
          await client.query(`UPDATE attendance_result_event_outbox SET attempts=attempts+1 WHERE id=$1`, [outboxId])
        })
        expect(String((afterDelivered as Error).message)).toMatch(/W4C0_OUTBOX/)
      })
    })

    describe('gate 20 (O-3=(a)) — append-only outcome side table + deferred completion guard', () => {
      it('append-only: a second outcome for the same target is refused (uq_asrto_target); UPDATE/DELETE refused', async () => {
        const org = `${NS}-outcomeao`
        const workDate = '2026-09-15'
        const { runId, opIds } = await makeRunWithGenerateTargets(pool, org, workDate, 'cron', [uuid()])
        void opIds
        const targetRes = await pool.query(`SELECT id::text AS id FROM attendance_scheduled_run_targets WHERE org_id=$1 AND run_id=$2`, [org, runId])
        const targetId = targetRes.rows[0].id
        const outcome = await pool.query(
          `INSERT INTO attendance_scheduled_run_target_outcomes (org_id, run_id, target_id, terminal_outcome) VALUES ($1,$2,$3,'completed') RETURNING id::text AS id`,
          [org, runId, targetId],
        )
        const dup = await catchInTxn(pool, async (client) => {
          await client.query(
            `INSERT INTO attendance_scheduled_run_target_outcomes (org_id, run_id, target_id, terminal_outcome) VALUES ($1,$2,$3,'completed')`,
            [org, runId, targetId],
          )
        })
        expect(String((dup as Error).message)).toMatch(/uq_asrto_target/)

        const upd = await catchInTxn(pool, async (client) => {
          await client.query(`UPDATE attendance_scheduled_run_target_outcomes SET terminal_outcome='failed' WHERE id=$1`, [outcome.rows[0].id])
        })
        expect(String((upd as Error).message)).toMatch(/W4C0_IMMUTABLE/)
        const del = await catchInTxn(pool, async (client) => {
          await client.query(`DELETE FROM attendance_scheduled_run_target_outcomes WHERE id=$1`, [outcome.rows[0].id])
        })
        expect(String((del as Error).message)).toMatch(/W4C0_IMMUTABLE/)
      })

      it('closed failure_reason_code: an unlisted code is refused at the DB boundary (chk_asrto_reason_closed); NIT-1 negative-value leg included', async () => {
        const org = `${NS}-reasonclosed`
        const workDate = '2026-09-16'
        const { runId } = await makeRunWithGenerateTargets(pool, org, workDate, 'cron', [uuid()])
        const targetRes = await pool.query(`SELECT id::text AS id FROM attendance_scheduled_run_targets WHERE org_id=$1 AND run_id=$2`, [org, runId])
        for (const badCode of ['NOT_A_REAL_CODE', '']) {
          const caught = await catchInTxn(pool, async (client) => {
            await client.query(
              `INSERT INTO attendance_scheduled_run_target_outcomes (org_id, run_id, target_id, terminal_outcome, failure_reason_code) VALUES ($1,$2,$3,'failed',$4)`,
              [org, runId, targetRes.rows[0].id, badCode],
            )
          })
          expect(String((caught as Error).message)).toMatch(/chk_asrto_reason_closed|chk_asrto_reason_pair/)
        }
      })

      it('completion guard: 2/2 completed outcomes with matching operation rows commits', async () => {
        const org = `${NS}-completeok`
        const workDate = '2026-09-17'
        const u1 = uuid()
        const u2 = uuid()
        const { runId, opIds } = await makeRunWithGenerateTargets(pool, org, workDate, 'cron', [u1, u2])
        await insertOperationRow(pool, org, opIds[0], 'completed', runId, u1, workDate)
        await insertOperationRow(pool, org, opIds[1], 'completed', runId, u2, workDate)
        const targets = await pool.query(`SELECT id::text AS id FROM attendance_scheduled_run_targets WHERE org_id=$1 AND run_id=$2 ORDER BY ordinal`, [org, runId])
        for (const row of targets.rows) {
          await pool.query(
            `INSERT INTO attendance_scheduled_run_target_outcomes (org_id, run_id, target_id, terminal_outcome) VALUES ($1,$2,$3,'completed')`,
            [org, runId, row.id],
          )
        }
        const caught = await catchInTxn(pool, async (client) => {
          await client.query(
            `UPDATE attendance_scheduled_runs SET state='completed', completed_user_count=2, generated_count=2, finalized_at=now() WHERE run_id=$1`,
            [runId],
          )
        })
        expect(caught).toBeUndefined()
      })

      it('completion guard: 1 completed + 1 deterministically-failed(canceled) target with completed_user_count=1 commits (O-3=(a) shape)', async () => {
        const org = `${NS}-completefail`
        const workDate = '2026-09-18'
        const u1 = uuid()
        const u2 = uuid()
        const { runId, opIds } = await makeRunWithGenerateTargets(pool, org, workDate, 'cron', [u1, u2])
        await insertOperationRow(pool, org, opIds[0], 'completed', runId, u1, workDate)
        await insertOperationRow(pool, org, opIds[1], 'canceled', runId, u2, workDate)
        const targets = await pool.query(`SELECT id::text AS id FROM attendance_scheduled_run_targets WHERE org_id=$1 AND run_id=$2 ORDER BY ordinal`, [org, runId])
        await pool.query(
          `INSERT INTO attendance_scheduled_run_target_outcomes (org_id, run_id, target_id, terminal_outcome) VALUES ($1,$2,$3,'completed')`,
          [org, runId, targets.rows[0].id],
        )
        await pool.query(
          `INSERT INTO attendance_scheduled_run_target_outcomes (org_id, run_id, target_id, terminal_outcome, failure_reason_code) VALUES ($1,$2,$3,'failed','ATTENDANCE_SCHEDULED_TARGET_OPERATION_REJECTED')`,
          [org, runId, targets.rows[1].id],
        )
        const caught = await catchInTxn(pool, async (client) => {
          await client.query(
            `UPDATE attendance_scheduled_runs SET state='completed', completed_user_count=1, generated_count=1, finalized_at=now() WHERE run_id=$1`,
            [runId],
          )
        })
        expect(caught).toBeUndefined()
      })

      it('completion guard: a generate target with no outcome row at all blocks finalization at COMMIT (deferred trigger)', async () => {
        const org = `${NS}-missingoutcome`
        const workDate = '2026-09-19'
        const u1 = uuid()
        const u2 = uuid()
        const { runId, opIds } = await makeRunWithGenerateTargets(pool, org, workDate, 'cron', [u1, u2])
        await insertOperationRow(pool, org, opIds[0], 'completed', runId, u1, workDate)
        await insertOperationRow(pool, org, opIds[1], 'completed', runId, u2, workDate)
        const targets = await pool.query(`SELECT id::text AS id FROM attendance_scheduled_run_targets WHERE org_id=$1 AND run_id=$2 ORDER BY ordinal`, [org, runId])
        // only ONE outcome recorded, the second target has none.
        await pool.query(
          `INSERT INTO attendance_scheduled_run_target_outcomes (org_id, run_id, target_id, terminal_outcome) VALUES ($1,$2,$3,'completed')`,
          [org, runId, targets.rows[0].id],
        )
        const caught = await catchInTxn(pool, async (client) => {
          await client.query(
            `UPDATE attendance_scheduled_runs SET state='completed', completed_user_count=1, generated_count=1, finalized_at=now() WHERE run_id=$1`,
            [runId],
          )
        })
        expect(String((caught as Error).message)).toMatch(/W4C2_RUN_COMPLETION/)
      })

      it('completion guard: completed_user_count disagreeing with the recorded completed-outcome count blocks finalization', async () => {
        const org = `${NS}-countmismatch`
        const workDate = '2026-09-20'
        const u1 = uuid()
        const { runId, opIds } = await makeRunWithGenerateTargets(pool, org, workDate, 'cron', [u1])
        await insertOperationRow(pool, org, opIds[0], 'completed', runId, u1, workDate)
        const targets = await pool.query(`SELECT id::text AS id FROM attendance_scheduled_run_targets WHERE org_id=$1 AND run_id=$2`, [org, runId])
        await pool.query(
          `INSERT INTO attendance_scheduled_run_target_outcomes (org_id, run_id, target_id, terminal_outcome) VALUES ($1,$2,$3,'completed')`,
          [org, runId, targets.rows[0].id],
        )
        const caught = await catchInTxn(pool, async (client) => {
          await client.query(
            `UPDATE attendance_scheduled_runs SET state='completed', completed_user_count=0, generated_count=0, finalized_at=now() WHERE run_id=$1`,
            [runId],
          )
        })
        expect(String((caught as Error).message)).toMatch(/W4C2_RUN_COMPLETION/)
      })

      it('completion guard: an outcome label disagreeing with its operation row state blocks finalization (canceled op paired with completed outcome)', async () => {
        const org = `${NS}-labelmismatch`
        const workDate = '2026-09-21'
        const u1 = uuid()
        const { runId, opIds } = await makeRunWithGenerateTargets(pool, org, workDate, 'cron', [u1])
        await insertOperationRow(pool, org, opIds[0], 'canceled', runId, u1, workDate)
        const targets = await pool.query(`SELECT id::text AS id FROM attendance_scheduled_run_targets WHERE org_id=$1 AND run_id=$2`, [org, runId])
        await pool.query(
          `INSERT INTO attendance_scheduled_run_target_outcomes (org_id, run_id, target_id, terminal_outcome) VALUES ($1,$2,$3,'completed')`,
          [org, runId, targets.rows[0].id],
        )
        const caught = await catchInTxn(pool, async (client) => {
          await client.query(
            `UPDATE attendance_scheduled_runs SET state='completed', completed_user_count=1, generated_count=1, finalized_at=now() WHERE run_id=$1`,
            [runId],
          )
        })
        expect(String((caught as Error).message)).toMatch(/W4C2_RUN_COMPLETION/)
      })

      it('completion guard (LEFT JOIN, not INNER): an outcome row whose target has NO matching operation row at all is caught, not silently dropped from the count', async () => {
        const org = `${NS}-noopop`
        const workDate = '2026-09-22'
        const u1 = uuid()
        const { runId } = await makeRunWithGenerateTargets(pool, org, workDate, 'cron', [u1])
        // deliberately no attendance_result_operations row inserted for this target's operation_id
        const targets = await pool.query(`SELECT id::text AS id FROM attendance_scheduled_run_targets WHERE org_id=$1 AND run_id=$2`, [org, runId])
        await pool.query(
          `INSERT INTO attendance_scheduled_run_target_outcomes (org_id, run_id, target_id, terminal_outcome) VALUES ($1,$2,$3,'completed')`,
          [org, runId, targets.rows[0].id],
        )
        const caught = await catchInTxn(pool, async (client) => {
          await client.query(
            `UPDATE attendance_scheduled_runs SET state='completed', completed_user_count=1, generated_count=1, finalized_at=now() WHERE run_id=$1`,
            [runId],
          )
        })
        expect(String((caught as Error).message)).toMatch(/W4C2_RUN_COMPLETION/)
      })
    })
  })
})
