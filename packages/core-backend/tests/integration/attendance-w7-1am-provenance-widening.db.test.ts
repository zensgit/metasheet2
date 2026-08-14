/**
 * W7-1a-M (#4556) — the DB half of the derive-and-diff completeness check, plus
 * the real-Postgres round-trip and refusal legs.
 *
 * Ratified per #4556 comments 5293034619 + 5293478713.
 *
 * WHY THE CATALOGUE, NOT MIGRATION TEXT. `attendance_w4_records_pointer_guard`
 * is created by zzzz20260725120000 and then REPLACED by zzzz20260731120000, and
 * W7-1a-M replaces it again. Migration files are append-only history — the older
 * ones still contain the un-widened bodies forever — so scanning them would
 * force a blanket exemption for historical migrations, which is exactly the hole
 * that hides a missed point. `pg_constraint` / `pg_proc` on a migrated database
 * say what is actually live, and are complete by construction.
 *
 * INERT: nothing in this slice emits `w4_group`. The rows below are inserted BY
 * THIS TEST, never by production code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { Kysely, PostgresDialect } from 'kysely'
import { Pool, type PoolClient } from 'pg'
import {
  ATTENDANCE_PROJECTION_OWNERS_V1,
  ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_SQL_LIST_V1,
  ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_V1,
} from '../../src/attendance/w7-provenance-domain'
import { up as applyW7ProvenanceWidening } from '../../src/db/migrations/zzzz20260815120000_w7_1am_provenance_domain_widening'

const dbUrl = process.env.ATTENDANCE_TEST_DATABASE_URL || process.env.DATABASE_URL
const describeIfDatabase = dbUrl ? describe : describe.skip

const RUN = crypto.randomUUID().slice(0, 8)
const HEX64_A = 'a'.repeat(64)
const HEX64_B = 'b'.repeat(64)
const HEX64_C = 'c'.repeat(64)

const NEW_OWNER = 'w4_group'

/**
 * The pointer-coupling invariant the ratification rules SURVIVES UNCHANGED:
 * `w4_group` inherits `w4`'s non-NULL pointer semantics, and `legacy_untracked`
 * stays the only NULL-pointer member, so this predicate is already correct for
 * the widened domain. Pinned byte-for-byte as Postgres renders it.
 */
const POINTER_PAIR_INVARIANT_DEF =
  "CHECK (((projection_owner = 'legacy_untracked'::text) = (current_calculation_id IS NULL)))"

type DbRule =
  /** Must admit the new member. */
  | 'widened'
  /** Only compares against `legacy_untracked`, so the new member takes `w4`'s arm. */
  | 'legacy_polarity'
  /** Mentions the column/field but no domain literal at all — value-agnostic. */
  | 'value_agnostic'
  /** The coupled pointer-null invariant; must be UNCHANGED. */
  | 'pointer_coupling_invariant'

/** The DB-half ledger: every live catalogue object that names the domain. */
const DB_LEDGER: ReadonlyArray<{ name: string; rule: DbRule; note?: string }> = Object.freeze([
  { name: 'chk_ar_projection_owner', rule: 'widened', note: 'the closed-set CHECK' },
  { name: 'chk_ar_owner_pointer_pair', rule: 'pointer_coupling_invariant' },
  {
    name: 'attendance_w4_records_pointer_guard',
    rule: 'widened',
    note: 'narrow import-rollback restore exception gates on the OLD owner',
  },
  {
    name: 'attendance_w4c3a_restore_witness_command_guard',
    rule: 'widened',
    note: 'W4C3A_WITNESS: NOT IN membership AND the coupled pointer disjunct',
  },
  { name: 'attendance_w4c3a_witnessed_legacy_lineage_guard', rule: 'legacy_polarity' },
  { name: 'attendance_w4c3a_restore_witness_commit_guard', rule: 'value_agnostic' },
  { name: 'attendance_w4c3a_rollback_preimage_fingerprint', rule: 'value_agnostic' },
])

function quotedW4(text: string): boolean {
  return /'w4'/.test(text)
}

describeIfDatabase('W7-1a-M provenance widening — live catalogue + real Postgres', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const org = `w7-1am-org-${RUN}`
  let constraints: Array<{ name: string; def: string }> = []
  let functions: Array<{ name: string; src: string }> = []
  let migrationDb: Kysely<unknown> | undefined

  beforeAll(async () => {
    // SHARED-DB REPLAY HAZARD (pre-existing, disclosed not introduced by W7-1a-M).
    // Sibling suites re-run HISTORICAL migrations' `up()` against this same
    // database — `attendance-w4c0-db-gates-e1.db.test.ts` calls
    // `zzzz20260725120000.up()`, which `CREATE OR REPLACE`s the SHARED function
    // `attendance_w4_records_pointer_guard` with its 2026-07-25 body. That
    // silently reverts both W7-1a-M's widening AND zzzz20260731120000's
    // witness-restore exception for whatever runs afterwards, so the live
    // catalogue depends on suite ORDER rather than on migration order.
    //
    // Production is unaffected: migrations there apply in order and this slice's
    // is last. Re-applying our own `up()` here (the same thing e1 does for its
    // migration, and idempotent by construction) makes these assertions measure
    // THIS migration's effect instead of the ambient order of the run.
    migrationDb = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: dbUrl }) }),
    })
    await applyW7ProvenanceWidening(migrationDb)

    const constraintRows = await pool.query(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE pg_get_constraintdef(oid) ILIKE '%projection_owner%'
           OR pg_get_constraintdef(oid) ILIKE '%projectionOwner%'
        ORDER BY conname`,
    )
    constraints = constraintRows.rows.map((row) => ({ name: String(row.name), def: String(row.def) }))

    const functionRows = await pool.query(
      `SELECT p.proname AS name, p.prosrc AS src
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND (p.prosrc ILIKE '%projection_owner%' OR p.prosrc ILIKE '%projectionOwner%')
        ORDER BY p.proname`,
    )
    functions = functionRows.rows.map((row) => ({ name: String(row.name), src: String(row.src) }))
  }, 60000)

  afterAll(async () => {
    await migrationDb?.destroy()
    await pool.end()
  })

  // -------------------------------------------------------------------------
  // Derive-and-diff over the live catalogue.
  // -------------------------------------------------------------------------

  it('non-vacuity: the catalogue derivation actually found the DB surface', () => {
    expect(constraints.length).toBeGreaterThanOrEqual(2)
    expect(functions.length).toBeGreaterThanOrEqual(5)
    expect(constraints.map((c) => c.name)).toContain('chk_ar_projection_owner')
    expect(constraints.map((c) => c.name)).toContain('chk_ar_owner_pointer_pair')
    expect(functions.map((f) => f.name)).toContain('attendance_w4_records_pointer_guard')
    expect(functions.map((f) => f.name)).toContain('attendance_w4c3a_restore_witness_command_guard')
  })

  it('every live catalogue object naming the domain is widened or has a satisfied rule', () => {
    const derived = [
      ...constraints.map((c) => ({ name: c.name, text: c.def })),
      ...functions.map((f) => ({ name: f.name, text: f.src })),
    ]
    const byName = new Map(DB_LEDGER.map((entry) => [entry.name, entry]))
    const violations: string[] = []
    const seen = new Set<string>()

    for (const object of derived) {
      const entry = byName.get(object.name)
      if (!entry) {
        violations.push(`unledgered_object: ${object.name}`)
        continue
      }
      seen.add(object.name)
      switch (entry.rule) {
        case 'widened':
          if (!object.text.includes(NEW_OWNER)) violations.push(`not_widened: ${object.name}`)
          break
        case 'legacy_polarity':
          if (!object.text.includes('legacy_untracked') || quotedW4(object.text)) {
            violations.push(`legacy_polarity_failed: ${object.name}`)
          }
          break
        case 'value_agnostic':
          if (object.text.includes("'legacy_untracked'") || quotedW4(object.text)) {
            violations.push(`value_agnostic_failed: ${object.name}`)
          }
          break
        case 'pointer_coupling_invariant':
          if (object.text !== POINTER_PAIR_INVARIANT_DEF) {
            violations.push(`invariant_changed: ${object.name} -> ${object.text}`)
          }
          break
      }
    }
    for (const entry of DB_LEDGER) {
      if (!seen.has(entry.name)) violations.push(`stale_ledger_entry: ${entry.name}`)
    }
    expect(violations).toEqual([])
  })

  it('the closed-set CHECK admits exactly the widened domain', () => {
    const check = constraints.find((c) => c.name === 'chk_ar_projection_owner')
    expect(check).toBeDefined()
    for (const owner of ATTENDANCE_PROJECTION_OWNERS_V1) {
      expect(check?.def).toContain(`'${owner}'`)
    }
    // Negative control: the pin really discriminates.
    expect(check?.def).not.toContain("'w4_team'")
  })

  it('the coupled pointer invariant is UNCHANGED by this slice', () => {
    const pair = constraints.find((c) => c.name === 'chk_ar_owner_pointer_pair')
    expect(pair?.def).toBe(POINTER_PAIR_INVARIANT_DEF)
    // It names only `legacy_untracked` — which is precisely why it keeps forcing
    // a NON-NULL pointer for every other member, `w4_group` included.
    expect(quotedW4(String(pair?.def))).toBe(false)
  })

  // -------------------------------------------------------------------------
  // The widened trigger predicates, evaluated as LIVE TEXT in real Postgres.
  // Extracting the list from `prosrc` and running it means the assertion is
  // about the deployed predicate, not about a copy retyped in this file.
  // -------------------------------------------------------------------------

  async function evaluateInList(source: string, marker: RegExp, value: string): Promise<boolean> {
    const match = marker.exec(source)
    expect(match, `predicate not found in live prosrc: ${marker}`).not.toBeNull()
    const list = (match as RegExpExecArray)[1]
    const { rows } = await pool.query(`SELECT ($1::text IN (${list})) AS hit`, [value])
    return rows[0].hit as boolean
  }

  it('W4C3A_WITNESS membership list (live text) admits w4_group and refuses novel values', async () => {
    const guard = functions.find((f) => f.name === 'attendance_w4c3a_restore_witness_command_guard')
    const marker = /->> 'projectionOwner' NOT IN \(([^)]*)\)/
    expect(await evaluateInList(String(guard?.src), marker, NEW_OWNER)).toBe(true)
    expect(await evaluateInList(String(guard?.src), marker, 'legacy_untracked')).toBe(true)
    expect(await evaluateInList(String(guard?.src), marker, 'w4')).toBe(true)
    for (const novel of ['w4_team', 'w5', 'group', 'W4_GROUP']) {
      expect(await evaluateInList(String(guard?.src), marker, novel)).toBe(false)
    }
  })

  it('W4C3A_WITNESS coupled pointer disjunct (live text) puts w4_group on the NON-NULL side', async () => {
    const guard = functions.find((f) => f.name === 'attendance_w4c3a_restore_witness_command_guard')
    const marker = /->> 'projectionOwner' IN \(([^)]*)\)/
    for (const owner of ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_V1) {
      expect(await evaluateInList(String(guard?.src), marker, owner)).toBe(true)
    }
    expect(await evaluateInList(String(guard?.src), marker, 'legacy_untracked')).toBe(false)
    expect(await evaluateInList(String(guard?.src), marker, 'w4_team')).toBe(false)
  })

  it('pointer-guard restore eligibility (live text) admits w4_group', async () => {
    const guard = functions.find((f) => f.name === 'attendance_w4_records_pointer_guard')
    const marker = /AND OLD\.projection_owner IN \(([^)]*)\)/
    for (const owner of ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_V1) {
      expect(await evaluateInList(String(guard?.src), marker, owner)).toBe(true)
    }
    expect(await evaluateInList(String(guard?.src), marker, 'legacy_untracked')).toBe(false)
  })

  it('the interpolated closure predicate is valid SQL and selects exactly the pointer owners', async () => {
    // `w4c3a-import-rollback-boundary.ts` builds its closure precondition by
    // interpolating this list. Executing the same rendered fragment proves the
    // text Postgres will actually parse, which no source-level check can.
    const { rows } = await pool.query(
      `SELECT v AS owner,
              (v IN (${ATTENDANCE_PROJECTION_OWNERS_WITH_CALCULATION_POINTER_SQL_LIST_V1})) AS hit
         FROM unnest($1::text[]) AS v`,
      [['legacy_untracked', 'w4', NEW_OWNER, 'w4_team']],
    )
    const hits = new Map(rows.map((row) => [String(row.owner), row.hit as boolean]))
    expect(hits.get('w4')).toBe(true)
    expect(hits.get(NEW_OWNER)).toBe(true)
    expect(hits.get('legacy_untracked')).toBe(false)
    expect(hits.get('w4_team')).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Real round-trip: a w4_group row through CHECK + coupled CHECK + the
  // pointer-guard constraint trigger.
  // -------------------------------------------------------------------------

  async function insertRecord(): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO attendance_records
         (user_id, work_date, org_id, status, work_minutes, late_minutes, early_leave_minutes)
       VALUES ($1, '2026-08-15', $2, 'normal', 480, 0, 0)
       RETURNING id::text AS id`,
      [`w7-1am-user-${crypto.randomUUID()}`, org],
    )
    return rows[0].id as string
  }

  /** One authoritative `set_active` calculation with its exact direct segment. */
  async function insertAuthoritativeCalc(client: PoolClient, recordId: string): Promise<string> {
    const id = crypto.randomUUID()
    await client.query(
      `INSERT INTO attendance_record_calculations
         (id, org_id, attendance_record_id, version, calculation_kind, mode, entrypoint, engine_version,
          snapshot_schema_version, operation_id, semantic_input_fingerprint, provenance_fingerprint,
          source_definition_fingerprint, attribution_snapshot, context_snapshot, segment_snapshot,
          evidence_snapshot, approved_facts_snapshot, input_provenance, merge_policy, calculation_tier,
          outcome, outcome_reason_code, projection_effect, expected_segment_count,
          projected_status, projected_work_minutes, projected_late_minutes, projected_early_leave_minutes,
          actor_id, correlation_id)
       VALUES ($1::uuid, $2, $3::uuid, 1, 'calculation', 'authoritative', 'live', 'w7-1am', 1,
               $4::uuid, $5, $6, $7, '{"posture":"resolved_v2"}'::jsonb, '{"tz":"UTC"}'::jsonb,
               '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{"transport":"live_punch"}'::jsonb, 'append',
               'segment_authoritative', 'completed', 'calculated', 'set_active', 1,
               'normal', 480, 0, 0, 'w7-1am-actor', $8)`,
      [id, org, recordId, crypto.randomUUID(), HEX64_A, HEX64_B, HEX64_C, `corr-w7-1am-${RUN}`],
    )
    await client.query(
      `INSERT INTO attendance_record_segments
         (org_id, record_id, calculation_id, segment_index, expected_start_at, expected_end_at,
          work_minutes, late_minutes, early_leave_minutes, status, status_reasons,
          matched_evidence_refs, unmatched_evidence_refs)
       VALUES ($1, $2::uuid, $3::uuid, 0, '2026-08-15T01:00:00Z', '2026-08-15T09:00:00Z',
               480, 0, 0, 'normal', '["within_window"]'::jsonb, '[]'::jsonb, '[]'::jsonb)`,
      [org, recordId, id],
    )
    return id
  }

  async function seedPointerOwningRecord(): Promise<{ recordId: string; calcId: string }> {
    const recordId = await insertRecord()
    const client = await pool.connect()
    let calcId = ''
    try {
      await client.query('BEGIN')
      calcId = await insertAuthoritativeCalc(client, recordId)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
    return { recordId, calcId }
  }

  it('a w4_group row ROUND-TRIPS through the CHECK, the coupled CHECK and the pointer guard', async () => {
    const { recordId, calcId } = await seedPointerOwningRecord()
    await pool.query(
      `UPDATE attendance_records
          SET projection_owner = $2, current_calculation_id = $3::uuid,
              status = 'normal', work_minutes = 480, late_minutes = 0, early_leave_minutes = 0,
              visibility_state = 'active', visibility_reason = 'active'
        WHERE id = $1::uuid`,
      [recordId, NEW_OWNER, calcId],
    )
    const { rows } = await pool.query(
      `SELECT projection_owner, current_calculation_id::text AS current_calculation_id
         FROM attendance_records WHERE id = $1::uuid`,
      [recordId],
    )
    // Stored verbatim — no downgrade to legacy on the way in or out.
    expect(rows[0].projection_owner).toBe(NEW_OWNER)
    expect(rows[0].current_calculation_id).toBe(calcId)
  })

  it('SEMANTIC RULING: a w4_group row with a NULL pointer is still REFUSED', async () => {
    const { recordId, calcId } = await seedPointerOwningRecord()
    await pool.query(
      `UPDATE attendance_records
          SET projection_owner = $2, current_calculation_id = $3::uuid
        WHERE id = $1::uuid`,
      [recordId, NEW_OWNER, calcId],
    )
    await expect(
      pool.query(
        `UPDATE attendance_records SET current_calculation_id = NULL WHERE id = $1::uuid`,
        [recordId],
      ),
    ).rejects.toThrow(/chk_ar_owner_pointer_pair/)

    // And the same refusal on the INSERT path, so this is not an update-only artefact.
    await expect(
      pool.query(
        `INSERT INTO attendance_records
           (user_id, work_date, org_id, status, work_minutes, late_minutes, early_leave_minutes,
            projection_owner, current_calculation_id)
         VALUES ($1, '2026-08-16', $2, 'normal', 0, 0, 0, $3, NULL)`,
        [`w7-1am-nullptr-${crypto.randomUUID()}`, org, NEW_OWNER],
      ),
    ).rejects.toThrow(/chk_ar_owner_pointer_pair/)
  })

  it('legacy_untracked remains the ONLY member allowed a NULL pointer', async () => {
    const { rows } = await pool.query(
      `INSERT INTO attendance_records
         (user_id, work_date, org_id, status, work_minutes, late_minutes, early_leave_minutes,
          projection_owner, current_calculation_id)
       VALUES ($1, '2026-08-17', $2, 'normal', 0, 0, 0, 'legacy_untracked', NULL)
       RETURNING projection_owner`,
      [`w7-1am-legacy-${crypto.randomUUID()}`, org],
    )
    expect(rows[0].projection_owner).toBe('legacy_untracked')
  })

  it('NOVEL values are still refused everywhere — the domain did not open generally', async () => {
    for (const novel of ['w4_team', 'w5', 'group', 'W4_GROUP', 'w4_group_x', '']) {
      await expect(
        pool.query(
          `INSERT INTO attendance_records
             (user_id, work_date, org_id, status, work_minutes, late_minutes, early_leave_minutes,
              projection_owner, current_calculation_id)
           VALUES ($1, '2026-08-18', $2, 'normal', 0, 0, 0, $3, NULL)`,
          [`w7-1am-novel-${crypto.randomUUID()}`, org, novel],
        ),
        `novel value must be refused: ${JSON.stringify(novel)}`,
      ).rejects.toThrow(/chk_ar_projection_owner|chk_ar_owner_pointer_pair/)
    }
  })

  it('a novel value is refused even WITH a valid pointer (the closed-set CHECK, not the pair)', async () => {
    const { recordId, calcId } = await seedPointerOwningRecord()
    await expect(
      pool.query(
        `UPDATE attendance_records
            SET projection_owner = 'w4_team', current_calculation_id = $2::uuid
          WHERE id = $1::uuid`,
        [recordId, calcId],
      ),
    ).rejects.toThrow(/chk_ar_projection_owner/)
  })
})
