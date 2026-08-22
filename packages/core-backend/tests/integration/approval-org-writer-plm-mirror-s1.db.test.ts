import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import { ApprovalBridgeService } from '../../src/services/ApprovalBridgeService'
import type { ApprovalBridgePlmAdapter } from '../../src/services/approval-bridge-types'
import type { ApprovalRequest } from '../../src/data-adapters/PLMAdapter'
import type { QueryResult } from '../../src/data-adapters/BaseAdapter'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

// Real-DB spec: runs only with a Postgres DATABASE_URL. Excluded from the no-DB
// default test job -> the whole describe below skips there.
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// Sentinel deliberately lives OUTSIDE describeIfDatabase (top-level `it`, gated only on
// EXPECT_DB): a sentinel nested inside `describeIfDatabase` would itself be skipped whenever
// DATABASE_URL is absent, so it could never catch the failure mode it exists to catch — a
// DB-expected CI lane (EXPECT_DB=1) whose DATABASE_URL is missing or broken silently reporting
// this whole file as skipped-green instead of red (feedback_triggered_is_not_verified).
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

/**
 * G-W2 — writers-stamp-org (S1 closeout slice 1), PLM mirror writer.
 *
 * Per the session-authored per-writer analysis for this slice (PR body has the
 * full escalation table): the mechanical census finds SIX `approval_instances`
 * writer sites in total: FOUR reachable from a shipped runtime path —
 * ApprovalProductService createApproval's INSERT (reached by BOTH the HTTP
 * create route and the multitable automation bridge, a second call path into
 * the SAME site, not a distinct site), ApprovalBridgeService.upsertPlmMirror
 * (this file's subject), the after-sales refund bridge's INSERT, and the
 * attendance plugin's INSERT — plus TWO non-runtime scripts, counted INSIDE
 * the six per the landed migration's own docblock. The other three
 * runtime-reachable sites remain ESCALATE; THIS site is the only one with a
 * derivation this slice treats as settled, and that derivation is "write
 * nothing":
 *
 *   OD-S1-18(b) (Lock-10 S1.2.4a): "org_id is NULLABLE for plm: rows only,
 *   enforced by CHECK (org_id IS NOT NULL OR id LIKE 'plm:%')" (Phase 3, not
 *   landed yet — see the landed migration's own docblock, which explicitly
 *   defers the presence CHECK). NOTE: OD-S1-18 is recorded in the lock
 *   (approval-lock10-instance-readability-20260821.md:820) as SESSION DESIGN
 *   AUTHORITY (created by the independent review; never put to the owner) —
 *   it is not an owner ratification, unlike OD-S1-9(f)/OD-S1-17(b), which are.
 *   S1 lock §2.2(b) class 5: "NONE EXISTS. The mirror writer stamps no org and
 *   derives none; plm:-prefixed ids carry no tenant."
 *
 * This spec does NOT modify `ApprovalBridgeService.upsertPlmMirror` — it pins
 * the current (correct, per that derivation) behavior with a real-DB,
 * non-vacuous regression: drive a PLM sync through the PUBLIC
 * `syncPlmApprovals` entry point (not a hand-built fixture handed to a private
 * method) and assert the landed `approval_instance_org_nonblank` CHECK is
 * satisfied by a NULL org_id on the resulting row, alongside a same-DB
 * non-NULL-org row so "NULL everywhere" cannot pass trivially (feedback:
 * mutation testing / positive control discipline).
 *
 * SCOPE (this gate is narrower than "plm: rows stay NULL forever"): this pins
 * only `upsertPlmMirror`'s fresh-INSERT path. No landed or planned constraint
 * forbids a non-NULL org_id on a `plm:` row — the landed class-2 backfill
 * (`zzzz20260821100000_add_approval_instance_org_id.ts:143-152`) carries no
 * `id NOT LIKE 'plm:%'` guard, and the eventual Phase-3 CHECK would accept a
 * stamped `plm:` row. Reachability is barred today only by service-layer
 * attachment-binding routing, not by anything this test or that CHECK
 * enforces — see PR body's deferred-work list.
 *
 * Also note: two of the six sites sit outside any runtime path
 * (`src/seeds/seed-approvals.ts:6`, a demo seed, and
 * `packages/core-backend/scripts/test-approvals-contract.mjs:138`, a
 * manually-invoked contract-test script) and are not analyzed here — they are
 * counted IN the six above, not in addition to it; both will need attention at
 * Phase 3 — see PR body's deferred-work list.
 *
 * Mutation-tested manually against this baseline (357be6b0c5/5b924da3a4): adding
 * `org_id` (any literal) to the mirror INSERT's column list flips this test red
 * (`org_id` no longer NULL). Restored via `cp` + sha256-verified diff before
 * this file was committed — see PR body for the before/after hashes. The
 * non-vacuity control below does NOT discriminate this writer — it only
 * proves the column/CHECK accepts a non-NULL value on some row, which nobody
 * doubted. This mutation is the actual load-bearing oracle, and it is manual,
 * not run in CI.
 */
describeIfDatabase('writers-stamp-org S1 slice 1 — G-W2 PLM mirror writer (real DB)', () => {
  const pool = poolManager.get()
  const createdInstanceIds: string[] = []

  beforeAll(async () => {
    await ensureApprovalSchemaReady()
  })

  afterAll(async () => {
    if (createdInstanceIds.length > 0) {
      await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [createdInstanceIds])
    }
  })

  it('G-W2: upsertPlmMirror (via the public syncPlmApprovals entry point) writes org_id = NULL — the landed CHECK permits NULL on any row, not only plm: ones, so this does not by itself prove a plm:-specific carve-out', async () => {
    const externalId = `w2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const instanceId = `plm:${externalId}`
    createdInstanceIds.push(instanceId)

    const fixture: ApprovalRequest = {
      id: externalId,
      request_type: 'eco',
      title: 'G-W2 mirror fixture',
      requester_id: 'user-w2',
      requester_name: 'W2 Requester',
      status: 'pending',
      version: 1,
      created_at: new Date().toISOString(),
      product_id: 'prod-w2',
      product_number: 'PN-W2',
      product_name: 'W2 fixture product',
    }

    const plmAdapter: ApprovalBridgePlmAdapter = {
      getApprovals: async (): Promise<QueryResult<ApprovalRequest>> => ({
        data: [fixture],
        metadata: { totalCount: 1 },
      }),
      getApprovalById: async (): Promise<QueryResult<ApprovalRequest>> => ({ data: [], metadata: { totalCount: 0 } }),
      getApprovalHistory: async () => ({ data: [], metadata: { totalCount: 0 } }),
      approveApproval: async () => ({ data: [], metadata: { totalCount: 0 } }),
      rejectApproval: async () => ({ data: [], metadata: { totalCount: 0 } }),
    }

    const service = new ApprovalBridgeService(plmAdapter)
    const syncResult = await service.syncPlmApprovals({ limit: 10 })

    // Behavioral pre-condition: the sync must actually have reached the writer
    // (a broken fixture/adapter wiring that silently synced 0 rows would make
    // the NULL assertion below vacuously true).
    expect(syncResult.errors).toEqual([])
    expect(syncResult.synced).toBe(1)

    const row = await pool.query<{ org_id: string | null; source_system: string }>(
      'SELECT org_id, source_system FROM approval_instances WHERE id = $1',
      [instanceId],
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0].source_system).toBe('plm')
    // The load-bearing assertion for THIS writer path: the CHECK `org_id ~ '[!-~]'`
    // permits NULL, and this is the writer path where that is intentional per
    // this slice's derivation (OD-S1-18(b), SESSION DESIGN AUTHORITY — see
    // docblock) rather than an unstamped hole to be closed later. This does NOT
    // establish a table-wide "plm: rows stay NULL" invariant — see the SCOPE
    // note in the file docblock for why (the class-2 backfill on main has no
    // `plm:` guard, and no CHECK forbids a non-NULL org_id on a plm: row).
    expect(row.rows[0].org_id).toBeNull()
  })

  // NOTE: this control proves only that the column/CHECK accepts a non-NULL
  // org_id on some row -- nobody doubted that, and it does not discriminate
  // this writer at all. The actual load-bearing oracle for "this writer stamps
  // nothing" is the manual mutation described in the file docblock (adding
  // org_id to upsertPlmMirror's INSERT flips the test above red); that
  // mutation is NOT run in CI.
  it('non-vacuity control: the same DB/CHECK accepts a NON-NULL org_id on another row, so the NULL result above is not "NULL everywhere trivially passes"', async () => {
    const controlId = `platform-w2-control-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    createdInstanceIds.push(controlId)
    await pool.query(
      `INSERT INTO approval_instances (id, status, source_system, org_id) VALUES ($1, 'pending', 'platform', $2)`,
      [controlId, 'org-w2-control'],
    )
    const row = await pool.query<{ org_id: string | null }>(
      'SELECT org_id FROM approval_instances WHERE id = $1',
      [controlId],
    )
    expect(row.rows[0].org_id).toBe('org-w2-control')

    const nonNullCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM approval_instances WHERE org_id IS NOT NULL",
    )
    expect(Number(nonNullCount.rows[0].count)).toBeGreaterThan(0)
  })
})
