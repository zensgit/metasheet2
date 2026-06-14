/**
 * ②a 2a.1 SCAFFOLD — base-level readability resolver (real DB, unwired).
 *
 * §2a.1 adds the base-level permission primitive that ②b will build on: the `multitable:base:read` /
 * `multitable:base:admin` codes plus `resolveBaseReadable(req, query, baseId)`, mirroring
 * `resolveReadableSheetIds`. It derives from `meta_bases.owner_id` (+ admin role / global base-read
 * grant) — there is no `base_permissions` table at this stage.
 *
 * This is a THIN, UNWIRED scaffold: the §2a.2 wall compares two base_id strings and does NOT consult
 * this resolver. The full perm-check wiring defers to ②b (when an opt-in cross-base READ path opens).
 * This suite locks the resolver in isolation so ②b can rely on it.
 *
 * 2a.1-T: an actor who owns base A but not base B → resolveBaseReadable returns true for A, false for B.
 *
 * Real DB (describeIfDatabase) — the resolver queries meta_bases.
 */
import express, { type Request } from 'express'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { resolveBaseReadable } from '../../src/multitable/permission-service'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

const TS = Date.now()
const OWNER = `u_brr_owner_${TS}`
const OTHER = `u_brr_other_${TS}`
const ADMIN = `u_brr_admin_${TS}`

const BASE_A = `base_brr_a_${TS}` // owned by OWNER
const BASE_B = `base_brr_b_${TS}` // owned by someone else
const DEL_BASE = `base_brr_del_${TS}` // SOFT-DELETED (deleted_at set), owned by OWNER

const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

// A minimal Request stub carrying just the auth identity resolveRequestAccess reads.
function reqAs(userId: string, opts: { admin?: boolean; perms?: string[] } = {}): Request {
  const a = express()
  const req = Object.create(a.request) as Request
  ;(req as { user?: unknown }).user = {
    id: userId,
    roles: opts.admin ? ['admin'] : ['member'],
    perms: opts.perms ?? ['multitable:read', 'multitable:write'],
    permissions: opts.perms ?? ['multitable:read', 'multitable:write'],
  }
  return req
}

describeIfDatabase('②a 2a.1 — resolveBaseReadable scaffold (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_A, 'BRR Base A', OWNER])
    await q('INSERT INTO meta_bases (id, name, owner_id) VALUES ($1, $2, $3)', [BASE_B, 'BRR Base B', OTHER])
    // A soft-deleted base owned by OWNER — seed `deleted_at` directly; no runtime path produces this
    // state today, so it must be SQL-injected to exercise the resolver's `deleted_at IS NULL` filter.
    await q('INSERT INTO meta_bases (id, name, owner_id, deleted_at) VALUES ($1, $2, $3, NOW())', [DEL_BASE, 'BRR Soft-Deleted Base', OWNER])
  })

  afterAll(async () => {
    await q('DELETE FROM meta_bases WHERE id = ANY($1::text[])', [[BASE_A, BASE_B, DEL_BASE]]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set', () => { expect(process.env.DATABASE_URL).toBeTruthy() })

  // 2a.1-T: owner of A (but not B) → readable A, NOT readable B.
  test('2a.1-T: an actor who owns base A but not base B → readable A, excludes B', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    expect(await resolveBaseReadable(reqAs(OWNER), query, BASE_A)).toBe(true)
    expect(await resolveBaseReadable(reqAs(OWNER), query, BASE_B)).toBe(false)
  })

  test('a non-owner without a base grant cannot read either base', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    const nobody = `u_brr_nobody_${TS}`
    expect(await resolveBaseReadable(reqAs(nobody), query, BASE_A)).toBe(false)
    expect(await resolveBaseReadable(reqAs(nobody), query, BASE_B)).toBe(false)
  })

  test('an admin can read any base', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    expect(await resolveBaseReadable(reqAs(ADMIN, { admin: true }), query, BASE_B)).toBe(true)
  })

  test('a holder of the global multitable:base:read grant can read any base', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    const grantee = `u_brr_grant_${TS}`
    expect(await resolveBaseReadable(reqAs(grantee, { perms: ['multitable:base:read'] }), query, BASE_B)).toBe(true)
  })

  test('a missing / soft-deleted base is not readable (no null-deref)', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    expect(await resolveBaseReadable(reqAs(OWNER), query, `base_brr_missing_${TS}`)).toBe(false)
  })

  // NIT-1 (symmetry with resolveBaseWritable): the target-base existence SELECT (`deleted_at IS NULL`)
  // must run BEFORE the admin / base-read-grant short-circuit, so a soft-deleted base is NOT readable for
  // ANYONE — including an admin OR a global multitable:base:read grant holder. Under the OLD ordering both
  // short-circuited to `true` ahead of the SELECT (this canary is RED on that ordering: admin + grant flip
  // true→false here). OWNER returns false under either ordering (its derivation also needs the now-missing
  // row), so the discriminating flips are the admin and grant assertions.
  test('NIT-1: a SOFT-DELETED base is not readable even for an admin OR a base-read-grant holder (nor its owner)', async () => {
    const query = poolManager.get().query.bind(poolManager.get())
    const grantee = `u_brr_delgrant_${TS}`
    expect(await resolveBaseReadable(reqAs(ADMIN, { admin: true }), query, DEL_BASE)).toBe(false)
    expect(await resolveBaseReadable(reqAs(grantee, { perms: ['multitable:base:read'] }), query, DEL_BASE)).toBe(false)
    expect(await resolveBaseReadable(reqAs(OWNER), query, DEL_BASE)).toBe(false)
  })
})
