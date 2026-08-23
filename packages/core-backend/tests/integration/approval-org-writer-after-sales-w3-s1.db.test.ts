import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { poolManager } from '../../src/integration/db/connection-pool'
import {
  AfterSalesApprovalBridgeService,
  type AfterSalesRefundApprovalCommand,
} from '../../src/services/AfterSalesApprovalBridgeService'
import { ensureApprovalSchemaReady } from '../helpers/approval-schema-bootstrap'

// Real-DB spec: runs only with a Postgres DATABASE_URL. Excluded from the no-DB
// default test job -> the whole describe below skips there (two-point wiring: also
// excluded from packages/core-backend/vitest.config.ts so the required no-DB job
// cannot collect-and-skip-green it, and wired as a WHOLE FILE into the standalone
// .github/workflows/approval-realdb-org-writer-after-sales-w3-s1.yml lane).
const describeIfDatabase = process.env.DATABASE_URL ? describe : describe.skip

// Sentinel deliberately lives OUTSIDE describeIfDatabase (top-level `it`, gated only on
// EXPECT_DB): a sentinel nested inside `describeIfDatabase` would itself be skipped whenever
// DATABASE_URL is absent, so it could never catch the failure mode it exists to catch — a
// DB-expected CI lane (EXPECT_DB=1) whose DATABASE_URL is missing or broken silently reporting
// this whole file as skipped-green instead of red (feedback_triggered_is_not_verified). Matches
// the landed pattern in approval-org-writer-plm-mirror-s1.db.test.ts / -w1w2-s1.db.test.ts.
const itIfExpectDb = process.env.EXPECT_DB === '1' ? it : it.skip
itIfExpectDb('sentinel: EXPECT_DB lane must have DATABASE_URL (a DB-expected run must never skip-green)', () => {
  expect(process.env.DATABASE_URL).toBeTruthy()
})

function createCommand(overrides: Partial<AfterSalesRefundApprovalCommand> = {}): AfterSalesRefundApprovalCommand {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  return {
    bridge: 'after-sales-refund',
    sourceSystem: 'after-sales',
    topic: 'ticket.refundRequested',
    title: `G-W3 refund approval ${tag}`,
    businessKey: `after-sales:g-w3:${tag}:refund`,
    requester: {
      id: `g-w3-user-${tag}`,
      name: 'G-W3 Requester',
    },
    subject: {
      projectId: `g-w3-project-${tag}`,
      ticketId: `g-w3-ticket-${tag}`,
      ticketNo: `TK-${tag}`,
      title: 'G-W3 refund request',
      refundAmount: 42,
      currency: 'CNY',
    },
    policy: {
      sourceOfTruth: 'after-sales',
      rejectCommentRequired: true,
    },
    metadata: {
      projectId: `g-w3-project-${tag}`,
      ticketId: `g-w3-ticket-${tag}`,
    },
    assignmentRoles: ['finance', 'supervisor'],
    ...overrides,
  }
}

/**
 * G-W3 — writers-stamp-org (Lock-11 §10 W-3), after-sales refund bridge writer.
 *
 * Ratified design: docs/development/approval-lock11-writer-org-derivation-20260822.md
 * §10 (RATIFIED 2026-08-22) — D-2 (W-3): "(d) now — afs: rows stay NULL (dark at
 * activation) + (a)-with-validation later. The OD-S1-18 id-shape scope change
 * (plm: -> plm:/afs:) is RECORDED as an activation precondition, not executed here."
 *
 * This spec does NOT modify AfterSalesApprovalBridgeService.submitRefundApproval — it
 * pins the current (correct, per D-2(d)) behavior with a real-DB, non-vacuous
 * regression: drive a refund approval through the PUBLIC submitRefundApproval entry
 * point (not a hand-built fixture handed to a private method) and assert the
 * resulting row's org_id is NULL, alongside a same-DB non-NULL-org row so "NULL
 * everywhere" cannot pass trivially (mirrors G-W2's positive-control discipline —
 * see approval-org-writer-plm-mirror-s1.db.test.ts).
 *
 * SCOPE — no bypass exists today: readability's isPlmApprovalId check
 * (approval-instance-readability.ts) recognizes ONLY the `plm:` id prefix; an
 * `afs:` row (this writer's id shape, submitRefundApproval :508) is NOT exempted
 * by that check, so it stays subject to the ordinary org-gated predicate — which a
 * NULL org_id fails for every viewer, admins included (org sits OUTSIDE the arm
 * disjunction). Rows written here are therefore DARK at activation UNLESS the
 * OD-S1-18 plm: -> plm:/afs: scope change lands (a RECORDED activation
 * precondition, not executed by this slice). This test does not assert any afs:
 * readability bypass — none exists to assert.
 *
 * Mutation-tested manually against this file's own baseline: adding an `org_id`
 * literal to submitRefundApproval's INSERT column list (AfterSalesApprovalBridgeService.ts,
 * the INSERT at :513-536) flips the NULL assertion below red. Restored via `cp` +
 * sha256-verified diff before this file was committed — see PR body for the
 * before/after hashes and the anchor-hit-count proof. This mutation is the actual
 * load-bearing oracle; it is manual, not run in CI (same posture as G-W2).
 *
 * No (β) migration-ordering tripwire here (unlike the W-4 suite): this writer is
 * NOT an arm-(a) writer — it derives no org at all, so it has no dependency on the
 * D-8(β) zero-membership provisioning ordering. G-W2 (the sibling zero-write pin)
 * carries no such tripwire either, for the same reason.
 */
describeIfDatabase('writers-stamp-org S1 — G-W3 after-sales refund bridge writer (real DB)', () => {
  const pool = poolManager.get()
  const createdInstanceIds: string[] = []

  beforeAll(async () => {
    await ensureApprovalSchemaReady()
  })

  afterAll(async () => {
    if (createdInstanceIds.length > 0) {
      await pool.query('DELETE FROM approval_assignments WHERE instance_id = ANY($1::text[])', [createdInstanceIds])
      await pool.query('DELETE FROM approval_instances WHERE id = ANY($1::text[])', [createdInstanceIds])
    }
  })

  it('G-W3: submitRefundApproval (public entry point) writes org_id = NULL — D-2(d) "write nothing", not an unstamped hole', async () => {
    const service = new AfterSalesApprovalBridgeService()
    const command = createCommand()

    const result = await service.submitRefundApproval(command)

    // Behavioral pre-condition: the submit must actually have reached the writer
    // (a broken fixture/wiring that silently returned the existing-pending branch,
    // or failed to create at all, would make the NULL assertion below vacuously
    // true or simply never execute).
    expect(result.created).toBe(true)
    expect(result.approvalId.startsWith('afs:')).toBe(true)
    createdInstanceIds.push(result.approvalId)

    const row = await pool.query<{ org_id: string | null; source_system: string; workflow_key: string }>(
      'SELECT org_id, source_system, workflow_key FROM approval_instances WHERE id = $1',
      [result.approvalId],
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0].source_system).toBe('after-sales')
    expect(row.rows[0].workflow_key).toBe('after-sales-refund')
    // The load-bearing assertion for THIS writer path: D-2(d) "write nothing" — the
    // writer never derives or stamps an org. Does NOT establish a table-wide
    // "afs: rows stay NULL forever" invariant beyond this writer's own behavior;
    // see the SCOPE note above for why no bypass currently reads this org_id.
    expect(row.rows[0].org_id).toBeNull()
  })

  // NOTE: this control proves only that the column accepts a non-NULL org_id on
  // some row in this same DB -- nobody doubted that, and it does not discriminate
  // this writer at all. The actual load-bearing oracle for "this writer writes
  // nothing" is the manual mutation described in the file docblock (adding org_id
  // to submitRefundApproval's INSERT flips the test above red); that mutation is
  // NOT run in CI (same posture as G-W2's non-vacuity control).
  it('non-vacuity control: the same DB accepts a NON-NULL org_id on another row, so the NULL result above is not "NULL everywhere trivially passes"', async () => {
    const controlId = `platform-w3-control-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    createdInstanceIds.push(controlId)
    await pool.query(
      `INSERT INTO approval_instances (id, status, source_system, org_id) VALUES ($1, 'pending', 'platform', $2)`,
      [controlId, 'org-w3-control'],
    )
    const row = await pool.query<{ org_id: string | null }>(
      'SELECT org_id FROM approval_instances WHERE id = $1',
      [controlId],
    )
    expect(row.rows[0].org_id).toBe('org-w3-control')

    const nonNullCount = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM approval_instances WHERE org_id IS NOT NULL",
    )
    expect(Number(nonNullCount.rows[0].count)).toBeGreaterThan(0)
  })
})
