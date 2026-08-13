import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { RECOVERY_AUTHORITY_TRIGGERS } from '../../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks'
import { acquireRecoveryAuthorityLease } from '../../src/multitable/recovery-authorization-stability'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()
const USER_A = `user_recovery_auth_a_${TS}`
const USER_B = `user_recovery_auth_b_${TS}`
const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)
const asQuery = (client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) =>
  (sql: string, params?: unknown[]) => client.query(sql, params) as never

test('sentinel: the real-DB allowlist step must have DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery-authority real-DB step is missing DATABASE_URL')
  }
  expect(true).toBe(true)
})

describeIfDatabase.sequential('exact-anchor recovery authority stability', () => {
  let initialTriggerStates: string[] = []

  beforeAll(async () => {
    await q(
      `INSERT INTO users (id, password_hash)
       VALUES ($1,'x'),($2,'x')
       ON CONFLICT (id) DO NOTHING`,
      [USER_A, USER_B],
    )
    initialTriggerStates = (
      await q(
        `SELECT tgenabled
           FROM pg_trigger
          WHERE NOT tgisinternal
            AND tgname = ANY($1::text[])
          ORDER BY tgname`,
        [[...RECOVERY_AUTHORITY_TRIGGERS].map(([, trigger]) => trigger)],
      )
    ).rows.map((row) => String((row as { tgenabled: unknown }).tgenabled))
    for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
      await q(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
    }
  })

  afterAll(async () => {
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[USER_A, USER_B]]).catch(() => {})
    await q('DELETE FROM users WHERE id = ANY($1::text[])', [[USER_A, USER_B]]).catch(() => {})
    for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
      await q(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`).catch(() => {})
    }
  })

  test('migration posture is default-inert: all nine writer triggers start disabled', () => {
    expect(initialTriggerStates).toHaveLength(RECOVERY_AUTHORITY_TRIGGERS.length)
    expect(new Set(initialTriggerStates)).toEqual(new Set(['D']))
  })

  test('ordinary cross-subject permission writes remain compatible (shared/shared, no ABBA)', async () => {
    const internal = poolManager.get().getInternalPool()
    expect(internal).toBeTruthy()
    const first = await internal!.connect()
    const second = await internal!.connect()
    try {
      await first.query('BEGIN')
      await second.query('BEGIN')
      await first.query(
        'INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,$2)',
        [USER_A, 'demo:read'],
      )
      await second.query(
        'INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,$2)',
        [USER_B, 'demo:read'],
      )
      await Promise.all([
        first.query(
          'INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,$2)',
          [USER_B, 'demo:write'],
        ),
        second.query(
          'INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,$2)',
          [USER_A, 'demo:write'],
        ),
      ])
      await first.query('COMMIT')
      await second.query('COMMIT')
      expect(Number(
        ((await q(
          'SELECT count(*)::int AS c FROM user_permissions WHERE user_id = ANY($1::text[])',
          [[USER_A, USER_B]],
        )).rows[0] as { c: number }).c,
      )).toBe(4)
    } finally {
      await first.query('ROLLBACK').catch(() => {})
      await second.query('ROLLBACK').catch(() => {})
      first.release()
      second.release()
      await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[USER_A, USER_B]]).catch(() => {})
    }
  })

  test('writer shared lease makes a related recovery return busy immediately, never wait', async () => {
    const internal = poolManager.get().getInternalPool()
    expect(internal).toBeTruthy()
    const writer = await internal!.connect()
    const recovery = await internal!.connect()
    try {
      await writer.query('BEGIN')
      await writer.query(
        'INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,$2)',
        [USER_A, 'demo:read'],
      )
      await recovery.query('BEGIN')
      await recovery.query("SET LOCAL lock_timeout = '250ms'")
      expect(await acquireRecoveryAuthorityLease(asQuery(recovery), [USER_A])).toBe('busy')
      await recovery.query('ROLLBACK')
      await writer.query('ROLLBACK')
    } finally {
      await recovery.query('ROLLBACK').catch(() => {})
      await writer.query('ROLLBACK').catch(() => {})
      recovery.release()
      writer.release()
    }
  })

  test('recovery exclusive lease makes the related writer fail-fast with the fixed retry marker', async () => {
    const internal = poolManager.get().getInternalPool()
    expect(internal).toBeTruthy()
    const recovery = await internal!.connect()
    const writer = await internal!.connect()
    try {
      await recovery.query('BEGIN')
      expect(await acquireRecoveryAuthorityLease(asQuery(recovery), [USER_A])).toBe('ready')
      await writer.query('BEGIN')
      await expect(
        writer.query(
          'INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,$2)',
          [USER_A, 'demo:read'],
        ),
      ).rejects.toMatchObject({
        code: '40001',
        message: 'METASHEET_RECOVERY_AUTHORITY_BUSY',
      })
      await writer.query('ROLLBACK')
      await recovery.query('COMMIT')
    } finally {
      await writer.query('ROLLBACK').catch(() => {})
      await recovery.query('ROLLBACK').catch(() => {})
      writer.release()
      recovery.release()
    }
  })

  test('schema lease permits ordinary DML but blocks trigger DDL until recovery completes', async () => {
    const internal = poolManager.get().getInternalPool()
    expect(internal).toBeTruthy()
    const recovery = await internal!.connect()
    const writer = await internal!.connect()
    const ddl = await internal!.connect()
    const [table, trigger] = RECOVERY_AUTHORITY_TRIGGERS.find(
      ([candidate]) => candidate === 'user_permissions',
    )!
    try {
      await recovery.query('BEGIN')
      expect(await acquireRecoveryAuthorityLease(asQuery(recovery), [USER_A])).toBe('ready')

      await writer.query('BEGIN')
      await writer.query("SET LOCAL lock_timeout = '250ms'")
      await writer.query(
        'INSERT INTO user_permissions (user_id, permission_code) VALUES ($1,$2)',
        [USER_B, 'demo:read'],
      )
      await writer.query('ROLLBACK')

      await ddl.query('BEGIN')
      await ddl.query("SET LOCAL lock_timeout = '250ms'")
      await expect(ddl.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)).rejects.toMatchObject(
        {
          code: '55P03',
        },
      )
      await ddl.query('ROLLBACK')
      await recovery.query('COMMIT')
    } finally {
      await ddl.query('ROLLBACK').catch(() => {})
      await writer.query('ROLLBACK').catch(() => {})
      await recovery.query('ROLLBACK').catch(() => {})
      ddl.release()
      writer.release()
      recovery.release()
    }
  })

  test('schema lease does not globally serialize recoveries for disjoint authority subjects', async () => {
    const internal = poolManager.get().getInternalPool()
    expect(internal).toBeTruthy()
    const first = await internal!.connect()
    const second = await internal!.connect()
    try {
      await first.query('BEGIN')
      await second.query('BEGIN')
      expect(await acquireRecoveryAuthorityLease(asQuery(first), [USER_A])).toBe('ready')
      expect(await acquireRecoveryAuthorityLease(asQuery(second), [USER_B])).toBe('ready')
      await first.query('COMMIT')
      await second.query('COMMIT')
    } finally {
      await first.query('ROLLBACK').catch(() => {})
      await second.query('ROLLBACK').catch(() => {})
      first.release()
      second.release()
    }
  })

  test('transient authority-table DDL contention reports busy, not substrate-unavailable', async () => {
    const internal = poolManager.get().getInternalPool()
    expect(internal).toBeTruthy()
    const ddl = await internal!.connect()
    const recovery = await internal!.connect()
    try {
      await ddl.query('BEGIN')
      await ddl.query('LOCK TABLE user_permissions IN ACCESS EXCLUSIVE MODE')
      await recovery.query('BEGIN')
      expect(await acquireRecoveryAuthorityLease(asQuery(recovery), [USER_A])).toBe('busy')
      await recovery.query('ROLLBACK')
      await ddl.query('ROLLBACK')
    } finally {
      await recovery.query('ROLLBACK').catch(() => {})
      await ddl.query('ROLLBACK').catch(() => {})
      recovery.release()
      ddl.release()
    }
  })

  test('partial/disabled trigger posture makes recovery fail closed before taking a lease', async () => {
    const [table, trigger] = RECOVERY_AUTHORITY_TRIGGERS[0]
    await q(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`)
    try {
      const result = await poolManager.get().transaction(async ({ query }) =>
        acquireRecoveryAuthorityLease(query as never, [USER_A]),
      )
      expect(result).toBe('unavailable')
    } finally {
      await q(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
    }
  })

  test('a same-name trigger on the wrong table cannot spoof the runtime completeness check', async () => {
    const [table, trigger] = RECOVERY_AUTHORITY_TRIGGERS[0]
    const spoofTable = `recovery_authority_spoof_${TS}`
    await q(`DROP TRIGGER ${trigger} ON ${table}`)
    await q(`CREATE TABLE ${spoofTable} (subject_type text, subject_id text)`)
    await q(
      `CREATE TRIGGER ${trigger}
       BEFORE INSERT OR UPDATE OR DELETE ON ${spoofTable}
       FOR EACH ROW EXECUTE FUNCTION metasheet_recovery_authority_subject_trigger('subject_type', 'subject_id')`,
    )
    try {
      const result = await poolManager.get().transaction(async ({ query }) =>
        acquireRecoveryAuthorityLease(query as never, [USER_A]),
      )
      expect(result).toBe('unavailable')
    } finally {
      await q(`DROP TABLE ${spoofTable} CASCADE`).catch(() => {})
      await q(
        `CREATE TRIGGER ${trigger}
         BEFORE INSERT OR UPDATE OR DELETE ON ${table}
         FOR EACH ROW EXECUTE FUNCTION metasheet_recovery_authority_subject_trigger('subject_type', 'subject_id')`,
      )
      await q(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
    }
  })

  test('a same-table/same-name trigger with drifted arguments cannot spoof the runtime check', async () => {
    const table = 'record_permissions'
    const trigger = 'trg_record_permissions_recovery_authority_lock'
    await q(`DROP TRIGGER ${trigger} ON ${table}`)
    await q(
      `CREATE TRIGGER ${trigger}
       BEFORE INSERT OR UPDATE OR DELETE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION metasheet_recovery_authority_subject_trigger('subject_type', 'missing_subject_id')`,
    )
    try {
      const result = await poolManager.get().transaction(async ({ query }) =>
        acquireRecoveryAuthorityLease(query as never, [USER_A]),
      )
      expect(result).toBe('unavailable')
    } finally {
      await q(`DROP TRIGGER ${trigger} ON ${table}`).catch(() => {})
      await q(
        `CREATE TRIGGER ${trigger}
         BEFORE INSERT OR UPDATE OR DELETE ON ${table}
         FOR EACH ROW EXECUTE FUNCTION metasheet_recovery_authority_subject_trigger('subject_type', 'subject_id')`,
      )
      await q(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
    }
  })

  test('a same-table/same-name trigger wired to the wrong function cannot spoof the runtime check', async () => {
    const table = 'record_permissions'
    const trigger = 'trg_record_permissions_recovery_authority_lock'
    const decoy = `metasheet_recovery_authority_decoy_${TS}`
    await q(
      `CREATE FUNCTION ${decoy}()
       RETURNS trigger AS $$
       BEGIN
         IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
    )
    await q(`DROP TRIGGER ${trigger} ON ${table}`)
    await q(
      `CREATE TRIGGER ${trigger}
       BEFORE INSERT OR UPDATE OR DELETE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION ${decoy}('subject_type', 'subject_id')`,
    )
    try {
      const result = await poolManager.get().transaction(async ({ query }) =>
        acquireRecoveryAuthorityLease(query as never, [USER_A]),
      )
      expect(result).toBe('unavailable')
    } finally {
      await q(`DROP TRIGGER ${trigger} ON ${table}`).catch(() => {})
      await q(`DROP FUNCTION ${decoy}()`).catch(() => {})
      await q(
        `CREATE TRIGGER ${trigger}
         BEFORE INSERT OR UPDATE OR DELETE ON ${table}
         FOR EACH ROW EXECUTE FUNCTION metasheet_recovery_authority_subject_trigger('subject_type', 'subject_id')`,
      )
      await q(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
    }
  })

  test('a canonical function signature with drifted executable body fails closed', async () => {
    const row = (
      await q(
        `SELECT pg_catalog.pg_get_functiondef(
           'public.metasheet_try_recovery_authority_user(text, boolean)'::regprocedure
         ) AS definition`,
      )
    ).rows[0] as { definition?: unknown } | undefined
    const originalDefinition = String(row?.definition ?? '')
    expect(originalDefinition).toContain('pg_try_advisory_xact_lock_shared')
    await q(
      `CREATE OR REPLACE FUNCTION metasheet_try_recovery_authority_user(
         authority_user_id text,
         exclusive boolean
       )
       RETURNS boolean AS $$
       BEGIN
         RETURN TRUE;
       END;
       $$ LANGUAGE plpgsql`,
    )
    try {
      const result = await poolManager.get().transaction(async ({ query }) =>
        acquireRecoveryAuthorityLease(query as never, [USER_A]),
      )
      expect(result).toBe('unavailable')
    } finally {
      await q(originalDefinition)
    }
  })
})
