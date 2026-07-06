/**
 * B3 — W1-2 permission-matrix: management-surface 403 matrix (G-6, real DB).
 * Spec: docs/development/multitable-w1-2-permission-matrix-spec-20260705.md §3 gap G-6 / §5 batch B3.
 *
 * Enumerates (actor-tier × management-route): does a NON-manager get 403 on schema/access-control
 * MUTATION routes (field CRUD, view CRUD, permission CRUD, sheet_config CRUD)? Actor tiers (permission-
 * service.ts:65-108 code table):
 *  - A3 global multitable:read only (no write) — granted via `req.user.perms` directly: no DB row
 *    needed. `resolveRequestAccess` (multitable/access.ts:51-84) uses a non-empty `req.user.perms` /
 *    `.permissions` AS-IS, bypassing the `listUserPermissions` DB call entirely — the SAME short-circuit
 *    B1-G3's base-write golden (multitable-permmatrix-b1-basewrite-no-sheet-write-realdb.test.ts) relies
 *    on for its REST-route actors.
 *  - A4 sheet-scoped FULL write only (`spreadsheet:write` row in `spreadsheet_permissions`, no global
 *    perm) — sheet scope is ALWAYS DB-resolved (`loadSheetPermissionScopeMap`), no req.user short-circuit.
 *  - A5 sheet-scoped write-OWN only (`spreadsheet:write-own`, no global perm).
 *  - A6 no permissions at all (no users row, no grants — natural zero-permission fallback of
 *    `listUserPermissions`/`isAdmin` against a completely unknown actor id).
 * Tier-seeding mirrors multitable-permmatrix-b1-yjs-bridge-flush-realdb.test.ts exactly (same fixture
 * shapes, same "globally unique id, never reused with a different permission shape" discipline so the
 * in-process RBAC cache never serves a stale result).
 *
 * GROUNDING CORRECTION (re-anchored against current main — read before touching this matrix): A4 is NOT
 * denied on every management route. REST routes resolve capabilities via `resolveSheetCapabilities`
 * (multitable/permission-service.ts:1472), which composes `deriveCapabilities` (multitable/access.ts:92-
 * 127) with `applyContextSheetSchemaWriteGrant` (permission-service.ts:1297-1316 — byte-identical to its
 * sheet-capabilities.ts:139-158 counterpart used by the Yjs bridge, verified line-by-line). That grant
 * flips `canManageFields`/`canManageViews` to true whenever `scope.canRead && scope.canWrite` — which a
 * PLAIN sheet-scoped `spreadsheet:write` grant satisfies WITHOUT `scope.canAdmin`. This is existing,
 * intentionally-documented behavior (the function's own comment: "Sheet-scoped FULL write ... also
 * grants the sheet-level notify capability ... parity with canEditRecord/canManageViews") — a sheet-
 * scoped full-write editor may manage that sheet's field/view SCHEMA, just not its ACCESS CONTROL
 * (permissions / sheet_config), which additionally require `scope.canAdmin` (`spreadsheet:admin`) or the
 * global `multitable:share` code. This is NOT a runtime gap: the identical derivation already backs the
 * MERGED B1-G1 golden (#3649), where A4 is used as a POSITIVE control (Yjs-bridge flush ALLOWED) for the
 * same reason. Independently cross-validated by the existing (mock-pool, NOT real-DB) unit-style coverage
 * in multitable-sheet-permissions.api.test.ts ("allows field and view management when sheet permission is
 * write without global multitable permission" / "rejects field, view, person preset, and sheet management
 * when sheet permission is read-only") — same truth table, different (non-real-DB) layer. So:
 *   - field CRUD (canManageFields) and view CRUD (canManageViews): A3/A5/A6 DENIED, A4 documented ALLOWED
 *     (a positive control, not a gap — mirrors the B1-G1 A4 pattern on the Yjs-bridge path).
 *   - permission CRUD (sheet-permission grant, canManageSheetAccess) and sheet_config CRUD (both the
 *     row-level-read-deny flag and the conditional-rules routes, canManageSheetAccess): ALL FOUR tiers
 *     DENIED — canManageSheetAccess needs `scope.canAdmin`/`multitable:share`, which none of A3-A6 hold.
 *
 * ALREADY LOCKED (real-DB) — referenced, NOT duplicated here:
 *   - A3 × PUT /sheets/:sheetId/conditional-rules → 403 : multitable-conditional-rules-api.test.ts
 *     ("non-manager (read-only) PUT → 403, rules unchanged")
 *   - A3 × PUT /sheets/:sheetId/row-level-read-deny → 403 : multitable-rowlevel-readdeny-flag-endpoint.test.ts
 *     ("non-manager (read-only) PUT → 403, flag UNCHANGED")
 *   Both use a GLOBAL multitable:read reader — exactly this file's A3. Neither file covers A4/A5/A6 for
 *   its PUT route (only a no-perms 403 on the unrelated GET/read side) — those cells are NEW here. Kept
 *   as `test.skip` below (not silently omitted) so the drop is visible in the run report.
 *
 * OUT OF SCOPE for this batch (same capability gate as an already-tested route in this file — DRY, not
 * an oversight; noted here for the record rather than re-tested):
 *   - PUT /sheets/:sheetId/field-permissions/:fieldId/:subjectType/:subjectId (canManageFields — same
 *     gate as R1; the A4 documented-ALLOWED finding generalizes here too, by the same derivation).
 *   - PUT /views/:viewId/permissions/:subjectType/:subjectId (canManageViews — same gate as R2).
 *   - PUT /sheets/:sheetId/records/:recordId/permissions + DELETE .../permissions/:permissionId
 *     (canManageSheetAccess — same all-tiers-denied gate as R3).
 *   multitable-fieldperm-write-gate-patch-realdb.test.ts covers a DIFFERENT surface (whether a granted
 *   field_permissions.read_only entry blocks an interactive record PATCH) — not who may SET that entry —
 *   so it is adjacent, not overlapping.
 *
 * Zero side effects on every DENIED cell: the attempted field/view/permission-row/flag/rules mutation is
 * verified ABSENT/UNCHANGED in the DB, not just the status code.
 *
 * Runs only with DATABASE_URL (sentinel fails-not-skips in CI per the suite convention).
 */
import express, { type Express } from 'express'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { poolManager } from '../../src/integration/db/connection-pool'
import { univerMetaRouter } from '../../src/routes/univer-meta'

const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip
const q = (sql: string, params?: unknown[]) => poolManager.get().query(sql, params)

const TS = Date.now()
const BASE_ID = `base_b3_${TS}`
const SHEET_ID = `sheet_b3_${TS}`

type TierId = 'A3' | 'A4' | 'A5' | 'A6'
const TIERS: TierId[] = ['A3', 'A4', 'A5', 'A6']

const TIER_USER: Record<TierId, string> = {
  A3: `u_b3_a3_${TS}`,
  A4: `u_b3_a4_${TS}`,
  A5: `u_b3_a5_${TS}`,
  A6: `u_b3_a6_${TS}`,
}

// A3's grant lives in req.user.perms (global, no DB row). A4/A5's grants are seeded as real
// spreadsheet_permissions rows in beforeAll (sheet scope is always DB-resolved). A6 gets neither.
const TIER_GLOBAL_PERMS: Record<TierId, string[]> = { A3: ['multitable:read'], A4: [], A5: [], A6: [] }

const TIER_LABEL: Record<TierId, string> = {
  A3: 'A3 (global multitable:read only, no write)',
  A4: 'A4 (sheet-scoped spreadsheet:write only, no global perm)',
  A5: 'A5 (sheet-scoped spreadsheet:write-own only, no global perm)',
  A6: 'A6 (no permissions at all)',
}

function appFor(tier: TierId): Express {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any).user = { id: TIER_USER[tier], roles: [], perms: TIER_GLOBAL_PERMS[tier] }
    next()
  })
  app.use('/api/multitable', univerMetaRouter())
  return app
}

const FORBIDDEN_BODY = { ok: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }

type RouteMatrixConfig = {
  /** tiers that are documented-ALLOWED positive controls instead of DENIED (empty = all 4 tiers denied) */
  allowedTiers: TierId[]
  /** tiers already real-DB-locked elsewhere — rendered as test.skip with a pointer, not silently dropped */
  skipTiers?: Partial<Record<TierId, string>>
  successStatus: number
  makeRequest: (app: Express, tier: TierId) => Promise<{ status: number; body: unknown }>
  expectAllowedEffect: (tier: TierId) => Promise<void>
  expectDeniedNoEffect: (tier: TierId) => Promise<void>
}

function describeManagementRoute(routeLabel: string, capability: string, cfg: RouteMatrixConfig) {
  describe(`${routeLabel} (${capability})`, () => {
    for (const tier of TIERS) {
      const skipReason = cfg.skipTiers?.[tier]
      if (skipReason) {
        test.skip(`${TIER_LABEL[tier]}: SKIPPED — already real-DB-locked by ${skipReason}`, () => {})
        continue
      }
      const isAllowed = cfg.allowedTiers.includes(tier)
      const title = isAllowed
        ? `${TIER_LABEL[tier]}: ALLOWED (${cfg.successStatus}) — documented positive control (sheet-scoped full write grants schema-manage)`
        : `${TIER_LABEL[tier]}: DENIED (403), zero side effects`
      test(title, async () => {
        const res = await cfg.makeRequest(appFor(tier), tier)
        if (isAllowed) {
          expect(res.status).toBe(cfg.successStatus)
          await cfg.expectAllowedEffect(tier)
        } else {
          expect(res.status).toBe(403)
          expect(res.body).toEqual(FORBIDDEN_BODY)
          await cfg.expectDeniedNoEffect(tier)
        }
      })
    }
  })
}

const fieldNameFor = (tier: TierId) => `fld_b3_r1_${tier}_${TS}`
const viewNameFor = (tier: TierId) => `view_b3_r2_${tier}_${TS}`
const permTargetFor = (tier: TierId) => `u_b3_r3_target_${tier}_${TS}`

describeIfDatabase('B3 permission golden — management-surface 403 matrix (real DB)', () => {
  beforeAll(async () => {
    await q('INSERT INTO meta_bases (id, name) VALUES ($1,$2)', [BASE_ID, 'B3 Mgmt-403 Base'])
    await q('INSERT INTO meta_sheets (id, base_id, name) VALUES ($1,$2,$3)', [SHEET_ID, BASE_ID, 'B3 Mgmt-403 Sheet'])
    // Explicit baseline (mirrors multitable-rowlevel-readdeny-flag-endpoint.test.ts /
    // multitable-conditional-rules-api.test.ts's own beforeEach reset) rather than relying on column defaults.
    await q('UPDATE meta_sheets SET row_level_read_permissions_enabled = false, conditional_read_rules = $2::jsonb WHERE id = $1', [SHEET_ID, '[]'])

    // A4 — sheet-scoped FULL write (no global perm, no users row needed: spreadsheet_permissions.subject_id
    // carries no FK, mirroring B1-G1 / d3d2's write-intersection fixtures).
    await q('INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4)', [SHEET_ID, 'user', TIER_USER.A4, 'spreadsheet:write'])
    // A5 — sheet-scoped write-OWN only.
    await q('INSERT INTO spreadsheet_permissions (sheet_id, subject_type, subject_id, perm_code) VALUES ($1,$2,$3,$4)', [SHEET_ID, 'user', TIER_USER.A5, 'spreadsheet:write-own'])
    // A3 needs no DB row (global grant flows through req.user.perms); A6 needs no row (zero-permission fallback).
  })

  afterAll(async () => {
    await q('DELETE FROM meta_config_revisions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_fields WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_views WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM spreadsheet_permissions WHERE sheet_id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_sheets WHERE id = $1', [SHEET_ID]).catch(() => {})
    await q('DELETE FROM meta_bases WHERE id = $1', [BASE_ID]).catch(() => {})
  })

  test('sentinel: DATABASE_URL set (real DB run, not skipped)', () => {
    expect(process.env.DATABASE_URL).toBeTruthy()
  })

  // ── R1 — field CRUD: POST /fields ──
  describeManagementRoute('R1 field CRUD — POST /fields', 'canManageFields', {
    allowedTiers: ['A4'],
    successStatus: 201,
    makeRequest: async (app, tier) =>
      request(app).post('/api/multitable/fields').send({ sheetId: SHEET_ID, name: fieldNameFor(tier), type: 'string' }),
    expectAllowedEffect: async (tier) => {
      const row = await q('SELECT id FROM meta_fields WHERE sheet_id = $1 AND name = $2', [SHEET_ID, fieldNameFor(tier)])
      expect(row.rows.length).toBe(1)
    },
    expectDeniedNoEffect: async (tier) => {
      const row = await q('SELECT id FROM meta_fields WHERE sheet_id = $1 AND name = $2', [SHEET_ID, fieldNameFor(tier)])
      expect(row.rows.length).toBe(0)
    },
  })

  // ── R2 — view CRUD: POST /views ──
  describeManagementRoute('R2 view CRUD — POST /views', 'canManageViews', {
    allowedTiers: ['A4'],
    successStatus: 201,
    makeRequest: async (app, tier) =>
      request(app).post('/api/multitable/views').send({ sheetId: SHEET_ID, name: viewNameFor(tier), type: 'grid' }),
    expectAllowedEffect: async (tier) => {
      const row = await q('SELECT id FROM meta_views WHERE sheet_id = $1 AND name = $2', [SHEET_ID, viewNameFor(tier)])
      expect(row.rows.length).toBe(1)
    },
    expectDeniedNoEffect: async (tier) => {
      const row = await q('SELECT id FROM meta_views WHERE sheet_id = $1 AND name = $2', [SHEET_ID, viewNameFor(tier)])
      expect(row.rows.length).toBe(0)
    },
  })

  // ── R3 — permission CRUD: PUT /sheets/:sheetId/permissions/:subjectType/:subjectId ──
  // canManageSheetAccess needs scope.canAdmin/multitable:share — none of A3-A6 hold either, so ALL
  // FOUR tiers are denied here (no A4 exception, unlike R1/R2's schema-manage grant).
  describeManagementRoute('R3 permission CRUD — PUT /sheets/:sheetId/permissions/:subjectType/:subjectId', 'canManageSheetAccess', {
    allowedTiers: [],
    successStatus: 200,
    // The capability gate runs BEFORE the target-subject-existence check (univer-meta.ts), so a
    // nonexistent target subjectId still reaches — and is rejected by — the capability gate.
    makeRequest: async (app, tier) =>
      request(app).put(`/api/multitable/sheets/${SHEET_ID}/permissions/user/${permTargetFor(tier)}`).send({ accessLevel: 'read' }),
    expectAllowedEffect: async () => {},
    expectDeniedNoEffect: async (tier) => {
      // spreadsheet_permissions has no surrogate `id` — its PK is (sheet_id, subject_type, subject_id, perm_code).
      const row = await q('SELECT perm_code FROM spreadsheet_permissions WHERE sheet_id = $1 AND subject_type = $2 AND subject_id = $3', [SHEET_ID, 'user', permTargetFor(tier)])
      expect(row.rows.length).toBe(0)
    },
  })

  // ── R4 — sheet_config CRUD: PUT /sheets/:sheetId/row-level-read-deny ──
  describeManagementRoute('R4 sheet_config CRUD — PUT /sheets/:sheetId/row-level-read-deny', 'canManageSheetAccess', {
    allowedTiers: [],
    successStatus: 200,
    skipTiers: { A3: 'multitable-rowlevel-readdeny-flag-endpoint.test.ts ("non-manager (read-only) PUT → 403, flag UNCHANGED")' },
    makeRequest: async (app) =>
      request(app).put(`/api/multitable/sheets/${SHEET_ID}/row-level-read-deny`).send({ enabled: true }),
    expectAllowedEffect: async () => {},
    expectDeniedNoEffect: async () => {
      const row = await q('SELECT row_level_read_permissions_enabled AS e FROM meta_sheets WHERE id = $1', [SHEET_ID])
      expect((row.rows[0] as { e?: boolean } | undefined)?.e).toBe(false)
    },
  })

  // ── R5 — sheet_config CRUD: PUT /sheets/:sheetId/conditional-rules ──
  describeManagementRoute('R5 sheet_config CRUD — PUT /sheets/:sheetId/conditional-rules', 'canManageSheetAccess', {
    allowedTiers: [],
    successStatus: 200,
    skipTiers: { A3: 'multitable-conditional-rules-api.test.ts ("non-manager (read-only) PUT → 403, rules unchanged")' },
    // A non-empty, structurally-VALID rule (not []): an empty array would look identical to the ('[]')
    // baseline even if a denied write somehow landed, which would make the no-side-effect check vacuous.
    makeRequest: async (app) =>
      request(app)
        .put(`/api/multitable/sheets/${SHEET_ID}/conditional-rules`)
        .send({ rules: [{ id: 'r1_b3', fieldId: 'fld_status', operator: 'eq', value: 'secret', effect: 'deny_read' }] }),
    expectAllowedEffect: async () => {},
    expectDeniedNoEffect: async () => {
      const row = await q('SELECT conditional_read_rules AS r FROM meta_sheets WHERE id = $1', [SHEET_ID])
      expect((row.rows[0] as { r?: unknown } | undefined)?.r).toEqual([])
    },
  })
})
