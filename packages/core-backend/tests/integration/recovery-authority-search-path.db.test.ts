import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'

/**
 * LOAD-BEARING counterexample for the CVE-2018-1058-shaped shadow on the recovery-authority lease
 * functions, and the mutation matrix that proves WHICH hardening defeats it.
 *
 * The finding: the trigger functions installed by
 * `zzzz20260721121000_add_recovery_authority_locks.ts` call the lease helpers by BARE name with no
 * fixed `SET search_path`, so a same-signature `metasheet_try_recovery_authority_user(text, boolean)`
 * planted in a schema EARLIER on the caller's search_path runs INSTEAD of the real helper in `public`.
 * A shadow that returns TRUE unconditionally makes an EXCLUSIVE recovery-authority lease stop refusing
 * the platform write — the exact protection the lease exists to provide. The L1 shadow census only
 * PROVES "no pollution at check time"; it does not defeat the shadow. `zzzz20260821120000` does, with
 * two independently-sufficient hardenings: (a) schema-qualified helper calls and (b) a fixed
 * `SET search_path = pg_catalog, public`.
 *
 * This suite reproduces the shadow on a REAL migrated DB and proves, behaviorally:
 *   1. SHIPPED (as-migrated, both hardenings): the shadow is DEFEATED — the write raises 40001, and
 *      the shadow function is never entered (its rollback-surviving call counter does not advance).
 *   2. OLD (bare call, no SET, reproduced in-test): the shadow WINS — the write lands with no 40001
 *      AND the shadow's call counter advances (positive control: the shadow really was in the
 *      resolution path, not merely "something returned TRUE").
 *   3. OLD + no shadow on the path (same body, same arming, same held lease, search_path WITHOUT the
 *      shadow schema): the write raises 40001 (positive control: the arming and the exclusive lease
 *      are genuinely in force, so "no 40001" in case 2 is attributable to the shadow, not a limp
 *      fixture).
 *   4. MUTATION MATRIX — each cell installs one function variant and drives the shadowed write:
 *        (a) qualified + SET   -> 40001 (shipped; defended)
 *        (b) qualified, no SET -> 40001 (schema-qualification alone is sufficient)
 *        (c) bare, SET only    -> 40001 (fixed search_path alone is sufficient)
 *        (d) bare, no SET      -> NO 40001 + shadow counter advances (the only exploitable cell)
 *      i.e. reverting EITHER hardening alone stays defended; reverting BOTH is what re-opens the hole.
 *
 * The exclusive lease is taken by calling `public.metasheet_try_recovery_authority_user($1, true)` on
 * a separate open transaction — schema-qualified, independent of the runtime lease helper — so the
 * proof never depends on the very resolution path under test. Every phase drives its write on a FRESH
 * connection with search_path set before the first trigger fire, so PL/pgSQL's per-session resolved-
 * callee cache cannot leak a stale resolution between cells.
 *
 * CI: DATABASE_URL-gated; excluded from the no-DB default vitest config (so `describeIfDatabase`
 * cannot skip-green it) and wired as a WHOLE FILE into .github/workflows/multitable-recovery-schema-
 * drift.yml alongside recovery-schema-drift.db.test.ts. EXPECT_DB=1 arms the anti-skip sentinel.
 */

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const USER_A = `user_recovery_searchpath_${TS}`
const SHADOW_SCHEMA = `recovery_shadow_${TS}`
const SHADOW_SEQ = `recovery_shadow_calls_${TS}`
const USER_PERM_TRIGGER = 'trg_user_permissions_recovery_authority_lock'
const RECORD_PERM_TRIGGER = 'trg_record_permissions_recovery_authority_lock'
const USER_TRIGGER_FN = 'metasheet_recovery_authority_user_trigger'

const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)

type Conn = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  release: () => void
}

function internalPool() {
  const internal = poolManager.get().getInternalPool()
  if (!internal) throw new Error('internal pool unavailable')
  return internal
}

/** The reproduced OLD body (bare call) vs the qualified body, each with/without the fixed search_path. */
function userTriggerVariant(options: { qualified: boolean; setSearchPath: boolean }): string {
  const call = options.qualified
    ? 'public.metasheet_try_recovery_authority_user'
    : 'metasheet_try_recovery_authority_user'
  const pathClause = options.setSearchPath
    ? 'SET search_path = pg_catalog, public'
    : 'RESET search_path'
  return `
    CREATE OR REPLACE FUNCTION public.${USER_TRIGGER_FN}()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    ${pathClause}
    AS $$
    DECLARE
      authority_user_id text;
    BEGIN
      FOR authority_user_id IN
        SELECT DISTINCT btrim(candidate)
          FROM unnest(ARRAY[
            CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) ->> TG_ARGV[0] END,
            CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) ->> TG_ARGV[0] END
          ]) AS candidates(candidate)
         WHERE candidate IS NOT NULL AND btrim(candidate) <> ''
         ORDER BY 1
      LOOP
        IF NOT ${call}(authority_user_id, FALSE) THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'METASHEET_RECOVERY_AUTHORITY_BUSY';
        END IF;
      END LOOP;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END;
    $$`
}

test('sentinel: the real-DB allowlist step must have DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery-authority search-path real-DB step is missing DATABASE_URL')
  }
  expect(true).toBe(true)
})

describeIfDatabase.sequential('recovery-authority search-path shadow (real DB)', () => {
  let pristineUserTriggerDef = ''

  // Rollback-surviving witness that the shadow ran: sequences are non-transactional, so a nextval
  // inside a rolled-back writer transaction still advances last_value/is_called. Reading the pair
  // before and after a drive tells us whether the shadow's body executed on that drive.
  async function readShadowCounter(): Promise<string> {
    const row = (await q(`SELECT last_value, is_called FROM ${SHADOW_SEQ}`)).rows[0] as {
      last_value: unknown
      is_called: unknown
    }
    return `${String(row.last_value)}/${String(row.is_called)}`
  }

  /**
   * Hold an EXCLUSIVE authority lease on USER_A in its own open transaction, run `body` (which drives
   * the platform write on a DIFFERENT fresh connection), then release the lease. Returns whether the
   * write raised 40001 and whether the shadow counter advanced during the write.
   */
  // The two writes that fire an authority trigger which calls metasheet_try_recovery_authority_user
  // for USER_A. user_permissions → metasheet_recovery_authority_user_trigger; record_permissions with
  // subject_type='user' → metasheet_recovery_authority_subject_trigger. Both route the SAME shadowed
  // helper, so a defended write proves the qualified call site in EACH of those two functions.
  const USER_PERM_WRITE = {
    sql: 'INSERT INTO user_permissions (user_id, permission_code) VALUES ($1, $2)',
    params: [USER_A, 'recovery:searchpath:probe'] as unknown[],
  }
  const RECORD_PERM_SUBJECT_USER_WRITE = {
    sql: 'INSERT INTO record_permissions (sheet_id, record_id, subject_type, subject_id, access_level) VALUES ($1,$2,$3,$4,$5)',
    params: [`sheet_${TS}`, `record_${TS}`, 'user', USER_A, 'read'] as unknown[],
  }

  async function withHeldLease(
    searchPath: string,
    write: { sql: string; params: unknown[] } = USER_PERM_WRITE,
  ): Promise<{ raised40001: boolean; shadowAdvanced: boolean; otherError: string | null }> {
    const pool = internalPool()
    const lease = (await pool.connect()) as unknown as Conn
    const writer = (await pool.connect()) as unknown as Conn
    let raised40001 = false
    let otherError: string | null = null
    const before = await readShadowCounter()
    try {
      await lease.query('BEGIN')
      const leased = (await lease.query('SELECT public.metasheet_try_recovery_authority_user($1, true) AS ok', [
        USER_A,
      ])).rows[0] as { ok: unknown }
      expect(leased.ok).toBe(true) // exclusive lease genuinely acquired

      await writer.query('BEGIN')
      await writer.query(`SET LOCAL search_path = ${searchPath}`)
      await writer.query("SET LOCAL lock_timeout = '2s'")
      try {
        await writer.query(write.sql, write.params)
      } catch (error) {
        const code = (error as { code?: string }).code
        const message = (error as { message?: string }).message ?? ''
        if (code === '40001' && message.includes('METASHEET_RECOVERY_AUTHORITY_BUSY')) {
          raised40001 = true
        } else {
          otherError = `${code ?? '?'}: ${message}`
        }
      }
      await writer.query('ROLLBACK')
      await lease.query('ROLLBACK')
    } finally {
      await lease.query('ROLLBACK').catch(() => {})
      await writer.query('ROLLBACK').catch(() => {})
      lease.release()
      writer.release()
    }
    const after = await readShadowCounter()
    return { raised40001, shadowAdvanced: after !== before, otherError }
  }

  beforeAll(async () => {
    // Capture the AS-MIGRATED (shipped) user-trigger function so it can be restored byte-for-byte.
    pristineUserTriggerDef = String(
      (
        await q(
          `SELECT pg_get_functiondef('public.${USER_TRIGGER_FN}()'::regprocedure) AS def`,
        )
      ).rows[0].def,
    )

    await q(`INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING`, [USER_A])
    // A hermetic permission_code so the probe INSERT can LAND CLEANLY when the shadow wins (the
    // user_permissions.permission_code FK references permissions.code); we do not rely on seed rows.
    await q(
      `INSERT INTO permissions (code, name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`,
      ['recovery:searchpath:probe', 'recovery search-path shadow probe'],
    )

    // The shadow: EARLIER on the search_path than public, same signature, returns TRUE always, and
    // bumps a non-transactional sequence so we can PROVE it was entered even after the writer rolls back.
    await q(`CREATE SCHEMA IF NOT EXISTS ${SHADOW_SCHEMA}`)
    await q(`CREATE SEQUENCE IF NOT EXISTS ${SHADOW_SEQ}`)
    await q(
      `CREATE OR REPLACE FUNCTION ${SHADOW_SCHEMA}.metasheet_try_recovery_authority_user(authority_user_id text, exclusive boolean)
       RETURNS boolean
       LANGUAGE plpgsql
       AS $$
       BEGIN
         PERFORM nextval('${SHADOW_SEQ}');
         RETURN TRUE;
       END;
       $$`,
    )

    // Arm the two authority triggers this suite drives: user_permissions (user-trigger function) and
    // record_permissions (subject-trigger function). Both route the shadowed metasheet_try_recovery_
    // authority_user helper for USER_A.
    await q(`ALTER TABLE user_permissions ENABLE TRIGGER ${USER_PERM_TRIGGER}`)
    await q(`ALTER TABLE record_permissions ENABLE TRIGGER ${RECORD_PERM_TRIGGER}`)
  })

  afterAll(async () => {
    // Restore the shipped function byte-for-byte, disarm the trigger, drop the shadow, clean rows.
    await q(pristineUserTriggerDef).catch(() => {})
    await q(`ALTER TABLE user_permissions DISABLE TRIGGER ${USER_PERM_TRIGGER}`).catch(() => {})
    await q(`ALTER TABLE record_permissions DISABLE TRIGGER ${RECORD_PERM_TRIGGER}`).catch(() => {})
    await q('DELETE FROM record_permissions WHERE subject_id = $1', [USER_A]).catch(() => {})
    await q(`DROP SCHEMA IF EXISTS ${SHADOW_SCHEMA} CASCADE`).catch(() => {})
    await q(`DROP SEQUENCE IF EXISTS ${SHADOW_SEQ}`).catch(() => {})
    await q('DELETE FROM user_permissions WHERE user_id = $1', [USER_A]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [USER_A]).catch(() => {})
    // ON DELETE CASCADE from permissions clears any lingering user_permissions probe rows too.
    await q('DELETE FROM permissions WHERE code = $1', ['recovery:searchpath:probe']).catch(() => {})
  })

  test('SHIPPED function defeats the shadow: write raises 40001 and the shadow is never entered', async () => {
    // No CREATE OR REPLACE — this exercises the AS-MIGRATED function (qualified + SET search_path).
    const result = await withHeldLease(`${SHADOW_SCHEMA}, public`)
    expect(result.otherError).toBeNull()
    expect(result.raised40001).toBe(true)
    // The migrated function resolved public.* directly; the shadow body never ran.
    expect(result.shadowAdvanced).toBe(false)
  })

  // Second function proven behaviorally: metasheet_recovery_authority_subject_trigger. A
  // record_permissions row with subject_type='user' routes through the SHIPPED subject trigger, which
  // calls public.metasheet_try_recovery_authority_user (one of its three qualified call sites) — the
  // SAME helper shadowed above. Defended here ⇒ the subject trigger's user branch reaches public too.
  // RESIDUAL (disclosed, not covered here): the subject trigger's role/group branches and
  // metasheet_recovery_role_permission_trigger call the *_role / *_group helpers; exercising those
  // behaviorally would need a second shadow on each of those helpers. They are covered by the body
  // fingerprint (drift lane + containment) — a text-level assertion — not by a live shadow here.
  test('SHIPPED subject trigger (record_permissions, subject_type=user) also defeats the shadow', async () => {
    const result = await withHeldLease(`${SHADOW_SCHEMA}, public`, RECORD_PERM_SUBJECT_USER_WRITE)
    expect(result.otherError).toBeNull()
    expect(result.raised40001).toBe(true)
    expect(result.shadowAdvanced).toBe(false)
  })

  test('OLD function is exploitable: shadow wins — no 40001, and the shadow WAS on the resolution path', async () => {
    await q(userTriggerVariant({ qualified: false, setSearchPath: false }))
    const result = await withHeldLease(`${SHADOW_SCHEMA}, public`)
    expect(result.otherError).toBeNull()
    // The exclusive lease is held, yet the write is NOT refused: the shadow returned TRUE.
    expect(result.raised40001).toBe(false)
    // Positive control #1: the shadow's body actually executed (counter advanced across the write).
    expect(result.shadowAdvanced).toBe(true)
  })

  test('OLD function + no shadow on the path still raises 40001 (arming + lease are genuinely in force)', async () => {
    // Same OLD body as the previous test; only the writer search_path changes (shadow schema absent).
    await q(userTriggerVariant({ qualified: false, setSearchPath: false }))
    const result = await withHeldLease('pg_catalog, public')
    expect(result.otherError).toBeNull()
    // Positive control #2: with the shadow off the path the bare call reaches the real helper, which
    // refuses under the held exclusive lease. Proves the previous test's "no 40001" was the shadow.
    expect(result.raised40001).toBe(true)
    expect(result.shadowAdvanced).toBe(false)
  })

  // --- Mutation matrix: which single hardening is load-bearing? Each cell drives the SHADOWED write. ---

  test('MUTATION (a) qualified + SET search_path -> defended (40001), shadow never entered', async () => {
    await q(userTriggerVariant({ qualified: true, setSearchPath: true }))
    const result = await withHeldLease(`${SHADOW_SCHEMA}, public`)
    expect(result.otherError).toBeNull()
    expect(result.raised40001).toBe(true)
    expect(result.shadowAdvanced).toBe(false)
  })

  test('MUTATION (b) qualified only (SET reverted) -> STILL defended: schema-qualification alone suffices', async () => {
    await q(userTriggerVariant({ qualified: true, setSearchPath: false }))
    const result = await withHeldLease(`${SHADOW_SCHEMA}, public`)
    expect(result.otherError).toBeNull()
    expect(result.raised40001).toBe(true)
    expect(result.shadowAdvanced).toBe(false)
  })

  test('MUTATION (c) SET search_path only (qualification reverted) -> STILL defended: fixed search_path alone suffices', async () => {
    await q(userTriggerVariant({ qualified: false, setSearchPath: true }))
    const result = await withHeldLease(`${SHADOW_SCHEMA}, public`)
    expect(result.otherError).toBeNull()
    expect(result.raised40001).toBe(true)
    // The function's own fixed path excludes the shadow schema, so even the bare call reaches public.
    expect(result.shadowAdvanced).toBe(false)
  })

  test('MUTATION (d) both reverted (bare + no SET) -> EXPLOITABLE: the only cell that re-opens the hole', async () => {
    await q(userTriggerVariant({ qualified: false, setSearchPath: false }))
    const result = await withHeldLease(`${SHADOW_SCHEMA}, public`)
    expect(result.otherError).toBeNull()
    expect(result.raised40001).toBe(false)
    expect(result.shadowAdvanced).toBe(true)
  })
})
