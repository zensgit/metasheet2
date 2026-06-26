import type { Kysely } from 'kysely'
import { sql } from 'kysely'

// 加班银行 v1-5a — the period-end settlement snapshot table (design-lock
// attendance-overtime-bank-v1-5-settlement-snapshot-designlock-20260625, §2).
//
// DORMANT: nothing writes this table until v1-5b's snapshot-at-close. Typed rows (NOT a cycle.metadata blob)
// so settlement facts are queryable + assertable.
//
// The 3 owner-review (#3206) constraints are baked into the schema:
//   [P1] frozen period: period_start_date / period_end_date / closed_at are copied from the cycle AT CLOSE, so
//        the snapshot carries its own period and a later cycle PUT cannot hang an old snapshot under a new
//        month. The read-out keys off THESE columns, not the cycle's current dates.
//   [P2] source NOT NULL: a NULL overtime_source (v1-1b dormant/legacy lots) is COALESCEd to 'legacy_unsourced'
//        at settlement BEFORE it enters the UNIQUE key — Postgres treats NULLs as non-equal, so a nullable
//        source would let the idempotency key be bypassed (duplicate writes on replay-close) and drop dormant
//        balance from the group.
//   The UNIQUE (org_id, cycle_id, user_id, source) is the idempotency key (replay-close = ON CONFLICT DO NOTHING).
//   [P2 owner #3211] the cycle FK is ON DELETE RESTRICT, NOT CASCADE: a closed settlement snapshot is an
//        immutable accounting fact (#3206) — deleting its cycle must be REFUSED while settlement rows exist, so
//        a cycle delete can't cascade-wipe the snapshots and bypass the archive/reopen-recompute discipline.
//        (v1-5b adds the route-layer closed-cycle delete/update guard; this FK is the DB-level backstop.)
//
// NO amounts: convertible_minutes / must_pay_minutes are MINUTES only; 倍率 / 工资基数 / 金额 = payroll.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS attendance_payroll_cycle_settlements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      org_id text NOT NULL,
      cycle_id uuid NOT NULL REFERENCES attendance_payroll_cycles(id) ON DELETE RESTRICT,
      period_start_date date NOT NULL,
      period_end_date date NOT NULL,
      closed_at timestamptz NOT NULL,
      user_id text NOT NULL,
      source text NOT NULL,
      convertible_minutes integer NOT NULL DEFAULT 0,
      must_pay_minutes integer NOT NULL DEFAULT 0,
      snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT attendance_payroll_cycle_settlements_unique UNIQUE (org_id, cycle_id, user_id, source)
    )
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_attendance_payroll_cycle_settlements_cycle
    ON attendance_payroll_cycle_settlements(org_id, cycle_id)
  `.execute(db)

  await sql`
    CREATE INDEX IF NOT EXISTS idx_attendance_payroll_cycle_settlements_user
    ON attendance_payroll_cycle_settlements(org_id, user_id)
  `.execute(db)
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX IF EXISTS idx_attendance_payroll_cycle_settlements_user`.execute(db)
  await sql`DROP INDEX IF EXISTS idx_attendance_payroll_cycle_settlements_cycle`.execute(db)
  await sql`DROP TABLE IF EXISTS attendance_payroll_cycle_settlements`.execute(db)
}
