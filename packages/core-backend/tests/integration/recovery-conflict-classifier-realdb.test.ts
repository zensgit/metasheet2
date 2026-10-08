/**
 * O2-S2 — real-Postgres proof that the single recovery-conflict classifier
 * (src/db/recovery-conflict.ts) matches the PRODUCTION error shape, not just the unit
 * fixtures: the marker 40001 asserted here is raised by the real recovery-authority
 * trigger under a genuinely held exclusive lease.
 *
 * Mirrors the harness of multitable-recovery-authority-stability-realdb.test.ts
 * (DATABASE_URL-gated; triggers enabled for the suite and restored after).
 *
 * Positive controls: the same write SUCCEEDS once the lease is released, and a real
 * non-40001 failure (FK violation) passes through translateRecoveryConflict as the SAME
 * pg error object — nothing outside the marker family is reclassified.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { RECOVERY_AUTHORITY_TRIGGERS } from '../../src/db/migrations/zzzz20260721121000_add_recovery_authority_locks'
import { acquireRecoveryAuthorityLease } from '../../src/multitable/recovery-authorization-stability'
import {
  classifyRecoveryConflict,
  RECOVERY_CONFLICT_HTTP_CODE,
  RecoveryConflictError,
  translateRecoveryConflict,
} from '../../src/db/recovery-conflict'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const TS = Date.now()

// Fail-not-skip sentinel (skip-when-unreachable blind spot): inside the CI real-DB
// allowlist step, a missing DATABASE_URL must be a FAILURE, never a silent skip-green.
test('sentinel: the real-DB allowlist step must have DATABASE_URL', () => {
  if (process.env.METASHEET_REAL_DB_TEST_STEP === '1' && !process.env.DATABASE_URL) {
    throw new Error('recovery-conflict real-DB step is missing DATABASE_URL')
  }
  expect(true).toBe(true)
})

const USER_A = `user_o2s2_conflict_${TS}`
const ROLE_A = `role_o2s2_conflict_${TS}`
const q = (sql: string, params: unknown[] = []) => poolManager.get().query(sql, params)
const asQuery = (client: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) =>
  (sql: string, params?: unknown[]) => client.query(sql, params) as never

describeIfDatabase.sequential('O2-S2 classifier vs the real recovery-authority 40001', () => {
  beforeAll(async () => {
    await q(
      `INSERT INTO users (id, password_hash) VALUES ($1,'x') ON CONFLICT (id) DO NOTHING`,
      [USER_A],
    )
    await q(
      `INSERT INTO roles (id, name) VALUES ($1,$1) ON CONFLICT (id) DO NOTHING`,
      [ROLE_A],
    )
    for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
      await q(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`)
    }
  })

  afterAll(async () => {
    for (const [table, trigger] of RECOVERY_AUTHORITY_TRIGGERS) {
      await q(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`).catch(() => {})
    }
    await q('DELETE FROM user_roles WHERE user_id = $1', [USER_A]).catch(() => {})
    await q('DELETE FROM roles WHERE id = $1', [ROLE_A]).catch(() => {})
    await q('DELETE FROM users WHERE id = $1', [USER_A]).catch(() => {})
  })

  test('the trigger-raised 40001 classifies as recovery_conflict; released lease → write succeeds', async () => {
    const internal = poolManager.get().getInternalPool()
    expect(internal).toBeTruthy()
    const recovery = await internal!.connect()
    const writer = await internal!.connect()
    try {
      await recovery.query('BEGIN')
      expect(await acquireRecoveryAuthorityLease(asQuery(recovery), [USER_A])).toBe('ready')

      await writer.query('BEGIN')
      const raised = await writer
        .query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [USER_A, ROLE_A])
        .then(
          () => null,
          (error: unknown) => error,
        )
      await writer.query('ROLLBACK')
      expect(raised).not.toBeNull()
      // THE production shape, classified by THE single classifier.
      expect(classifyRecoveryConflict(raised)).toBe('recovery_conflict')
      expect((raised as { code?: string }).code).toBe('40001')

      await recovery.query('COMMIT')

      // Positive control: with the lease released the SAME write succeeds — the
      // classification above came from the lease, not from ambient breakage.
      await writer.query('BEGIN')
      await writer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [USER_A, ROLE_A])
      await writer.query('ROLLBACK')
      expect(classifyRecoveryConflict(null)).toBeNull()
    } finally {
      await writer.query('ROLLBACK').catch(() => {})
      await recovery.query('ROLLBACK').catch(() => {})
      writer.release()
      recovery.release()
    }
  })

  test('translateRecoveryConflict re-raises the REAL trigger 40001 as the named retryable error', async () => {
    const internal = poolManager.get().getInternalPool()
    expect(internal).toBeTruthy()
    const recovery = await internal!.connect()
    const writer = await internal!.connect()
    try {
      await recovery.query('BEGIN')
      expect(await acquireRecoveryAuthorityLease(asQuery(recovery), [USER_A])).toBe('ready')

      await writer.query('BEGIN')
      const caught = await translateRecoveryConflict(async () => {
        await writer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [USER_A, ROLE_A])
      }).then(
        () => null,
        (error: unknown) => error,
      )
      await writer.query('ROLLBACK')
      await recovery.query('COMMIT')

      expect(caught).toBeInstanceOf(RecoveryConflictError)
      expect((caught as RecoveryConflictError).code).toBe(RECOVERY_CONFLICT_HTTP_CODE)
      expect((caught as RecoveryConflictError).retryable).toBe(true)
    } finally {
      await writer.query('ROLLBACK').catch(() => {})
      await recovery.query('ROLLBACK').catch(() => {})
      writer.release()
      recovery.release()
    }
  })

  test('a REAL non-40001 failure (duplicate key) passes through as the SAME pg error', async () => {
    const internal = poolManager.get().getInternalPool()
    expect(internal).toBeTruthy()
    const writer = await internal!.connect()
    try {
      await writer.query('BEGIN')
      await writer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [USER_A, ROLE_A])
      const caught = await translateRecoveryConflict(async () => {
        // Second identical INSERT violates the (user_id, role_id) primary key: a REAL
        // 23505, raised with no recovery lease held anywhere.
        await writer.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2)', [USER_A, ROLE_A])
      }).then(
        () => null,
        (error: unknown) => error,
      )
      await writer.query('ROLLBACK')

      expect(caught).not.toBeNull()
      expect(caught).not.toBeInstanceOf(RecoveryConflictError)
      expect((caught as { code?: string }).code).toBe('23505')
      expect(classifyRecoveryConflict(caught)).toBeNull()
    } finally {
      await writer.query('ROLLBACK').catch(() => {})
      writer.release()
    }
  })
})
