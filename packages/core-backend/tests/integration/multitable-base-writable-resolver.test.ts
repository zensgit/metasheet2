/**
 * ②b automation slice — base-level WRITE resolver `resolveBaseWritable` in isolation (real DB).
 *
 * The write-side counterpart of `resolveBaseReadable`. Unlike the read resolver it takes an
 * already-resolved `userId` (NOT a Request) because the automation executor has no `req` — it derives
 * write authority from `BASE_WRITE_PERMISSION_CODES` (= `multitable:base:admin` / `multitable:admin`)
 * via the effective-permission-codes SQL (user_permissions ∪ role_permissions, narrowed by namespace
 * admission) OR from base ownership (`meta_bases.owner_id`). FAIL-CLOSED: no userId → false; a
 * missing / soft-deleted base → false.
 *
 * Real DB (describeIfDatabase) — the resolver queries user_permissions / role_permissions / user_roles /
 * meta_bases directly.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { resolveBaseWritable } from '../../src/multitable/permission-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const OWNER = `u_bww_owner_${TS}` // owns BASE_A only
const ADMIN_CODE = `u_bww_admincode_${TS}` // holds multitable:base:admin grant → write any base
const NOBODY = `u_bww_nobody_${TS}` // no grant, owns nothing → write nothing

const BASE_A = `base_bww_a_${TS}` // owned by OWNER
const BASE_B = `base_bww_b_${TS}` // owned by someone else

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

describeIfDatabase('②b automation — resolveBaseWritable resolver (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_A, 'BWW Base A', OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_B, 'BWW Base B', `u_bww_other_${TS}`])

    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('multitable:base:admin', 'Base Admin', 'resolveBaseWritable tests')
       ON CONFLICT (code) DO NOTHING`,
    )
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
      [ADMIN_CODE, `${ADMIN_CODE}@example.test`],
    )
    await q(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES ($1, 'multitable:base:admin') ON CONFLICT DO NOTHING`,
      [ADMIN_CODE],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[ADMIN_CODE]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  test('base owner can write its OWN base only (not a base owned by someone else)', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    expect(await resolveBaseWritable(OWNER, query, BASE_A)).toBe(true)
    expect(await resolveBaseWritable(OWNER, query, BASE_B)).toBe(false)
  })

  test('a holder of the global multitable:base:admin grant can write any base', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    expect(await resolveBaseWritable(ADMIN_CODE, query, BASE_A)).toBe(true)
    expect(await resolveBaseWritable(ADMIN_CODE, query, BASE_B)).toBe(true)
  })

  test('a non-owner without a base grant cannot write either base', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    expect(await resolveBaseWritable(NOBODY, query, BASE_A)).toBe(false)
    expect(await resolveBaseWritable(NOBODY, query, BASE_B)).toBe(false)
  })

  test('fail-closed: null/empty userId → false (no identity, no write)', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    expect(await resolveBaseWritable(null, query, BASE_A)).toBe(false)
    expect(await resolveBaseWritable(undefined, query, BASE_A)).toBe(false)
    expect(await resolveBaseWritable('   ', query, BASE_A)).toBe(false)
  })

  test('fail-closed: a missing / soft-deleted base is not writable (no null-deref)', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    // OWNER owns NO record for this id → owner derivation finds nothing → false.
    expect(await resolveBaseWritable(OWNER, query, `base_bww_missing_${TS}`)).toBe(false)
  })
})
