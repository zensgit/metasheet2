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
import {
  BASE_ADMIN_PERMISSION_CODES,
  BASE_WRITE_PERMISSION_CODES,
  resolveBaseWritable,
} from '../../src/multitable/permission-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const OWNER = `u_bww_owner_${TS}` // owns BASE_A only
const ADMIN_CODE = `u_bww_admincode_${TS}` // holds multitable:base:admin grant → write any base
const WRITE_CODE = `u_bww_writecode_${TS}` // C3: holds ONLY multitable:base:write → write any base, NOT admin
const NOBODY = `u_bww_nobody_${TS}` // no grant, owns nothing → write nothing

const BASE_A = `base_bww_a_${TS}` // owned by OWNER
const BASE_B = `base_bww_b_${TS}` // owned by someone else
const DEL_BASE = `base_bww_del_${TS}` // SOFT-DELETED (deleted_at set), owned by OWNER

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

describeIfDatabase('②b automation — resolveBaseWritable resolver (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_A, 'BWW Base A', OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_B, 'BWW Base B', `u_bww_other_${TS}`])
    // A soft-deleted base owned by OWNER — seed `deleted_at` directly (no runtime path produces it).
    await q('INSERT INTO meta_bases (id, name, owner_id, deleted_at) VALUES ($1, $2, $3, NOW())', [DEL_BASE, 'BWW Soft-Deleted Base', OWNER])

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
    // C3 — the finer write-not-admin tier.
    await q(
      `INSERT INTO permissions (code, name, description)
       VALUES ('multitable:base:write', 'Base Write', 'C3 finer write tier')
       ON CONFLICT (code) DO NOTHING`,
    )
    await q(
      `INSERT INTO users (id, email, name, password_hash, role, permissions, is_active, is_admin)
       VALUES ($1, $2, $1, 'x', 'user', '[]'::jsonb, TRUE, FALSE)
       ON CONFLICT (id) DO UPDATE SET is_active = TRUE`,
      [WRITE_CODE, `${WRITE_CODE}@example.test`],
    )
    await q(
      `INSERT INTO user_permissions (user_id, permission_code)
       VALUES ($1, 'multitable:base:write') ON CONFLICT DO NOTHING`,
      [WRITE_CODE],
    )
  })

  afterAll(async () => {
    await q('DELETE FROM user_permissions WHERE user_id = ANY($1::text[])', [[ADMIN_CODE, WRITE_CODE]]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B, DEL_BASE]]).catch(() => {})
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

  // C3 KEYSTONE — a holder of ONLY the finer `multitable:base:write` grant can write any base.
  // RED on pre-C3 HEAD: `base:write` was in NO write set, so resolveBaseWritable returned false for
  // this holder. GREEN after C3 adds it to BASE_WRITE_PERMISSION_CODES. This is the observable effect
  // of the finer tier: write authority WITHOUT base:admin.
  test('C3: a holder of only multitable:base:write can write any base (the finer write-not-admin tier)', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    expect(await resolveBaseWritable(WRITE_CODE, query, BASE_A)).toBe(true)
    expect(await resolveBaseWritable(WRITE_CODE, query, BASE_B)).toBe(true)
  })

  // C3 — the write tier stays fail-closed on the same edges as admin/owner.
  test('C3: a base:write holder is still blocked on a soft-deleted base (existence check precedes the grant)', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    expect(await resolveBaseWritable(WRITE_CODE, query, DEL_BASE)).toBe(false)
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

  // NIT-1: the existence check must run BEFORE the admin/grant short-circuit, so even an admin/grant
  // holder is NOT writable on a soft-deleted base (the short-circuit previously returned true first).
  // RED on pre-fix HEAD (admin short-circuits before the deleted_at SELECT); GREEN after the reorder.
  test('fail-closed: a SOFT-DELETED base is not writable even for an admin-grant holder OR the owner', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    expect(await resolveBaseWritable(ADMIN_CODE, query, DEL_BASE)).toBe(false)
    expect(await resolveBaseWritable(OWNER, query, DEL_BASE)).toBe(false)
  })
})

// C3 — the permission-code SPLIT invariants (no DB needed, so CI's no-DB unit job guards them too).
// The advisor's divergence rule: after the two Sets diverge, each consumer must want the exact set it
// names. These assertions are RED on pre-C3 HEAD (where the two Sets were the SAME object).
describe('C3 — finer base:write tier: permission-code set invariants', () => {
  test('multitable:base:write is in the WRITE set (the new write-not-admin door)', () => {
    expect(BASE_WRITE_PERMISSION_CODES.has('multitable:base:write')).toBe(true)
  })

  test('multitable:base:write is NOT in the ADMIN set (a future admin-only gate must reject write-only)', () => {
    expect(BASE_ADMIN_PERMISSION_CODES.has('multitable:base:write')).toBe(false)
  })

  test('monotone: every ADMIN code still grants write (base:admin / multitable:admin imply write)', () => {
    for (const code of BASE_ADMIN_PERMISSION_CODES) {
      expect(BASE_WRITE_PERMISSION_CODES.has(code)).toBe(true)
    }
  })

  test('the two sets are now DISTINCT objects (BASE_WRITE is no longer aliased to BASE_ADMIN)', () => {
    expect(BASE_WRITE_PERMISSION_CODES).not.toBe(BASE_ADMIN_PERMISSION_CODES)
    // WRITE is a strict superset: it has exactly one code ADMIN lacks (base:write).
    expect(BASE_WRITE_PERMISSION_CODES.size).toBe(BASE_ADMIN_PERMISSION_CODES.size + 1)
  })
})
