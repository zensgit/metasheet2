import type { Injector } from '@wendellhu/redi'
import type { Request, Response } from 'express'
import { Router } from 'express'
import { IPLMAdapter } from '../di/identifiers'
import { authenticate } from '../middleware/auth'
import { rbacGuard } from '../rbac/rbac'
import { pool } from '../db/pg'
import { ApprovalBridgeService, ServiceError } from '../services/ApprovalBridgeService'
import type { ApprovalBridgePlmAdapter } from '../services/approval-bridge-types'
import { canReadApprovalInstance } from '../services/approval-instance-readability'
import { parsePagination } from '../util/response'
import { APPROVAL_POLICY_DENIED_ACTION } from '../types/approval-product'
import { isApprovalAttachmentsEnabled } from './approval-attachments'
import {
  projectCancelRoundCancellationOutcomeForReadV1,
  projectCancelRoundCloseReasonForReadV1,
} from '../core/attendance-cancellation-execution-port'

interface ApprovalHistoryRouterOptions {
  injector?: Injector
  plmAdapter?: ApprovalBridgePlmAdapter | null
}

// Exported (additive-only; no behavior change) so a Lock-10 (S1) test can gate this hand-copied
// detector's agreement with the other two shipped copies + the canonical form in
// approval-instance-readability.ts (OD-S1-18(b): "the divergence of any one of them is a P1").
export function isPlmApprovalId(id: string): boolean {
  return id.startsWith('plm:')
}

function resolvePlmAdapter(options?: ApprovalHistoryRouterOptions): ApprovalBridgePlmAdapter | null {
  if (options?.plmAdapter) {
    return options.plmAdapter
  }
  if (!options?.injector) {
    return null
  }
  return options.injector.get(IPLMAdapter) as unknown as ApprovalBridgePlmAdapter
}

function sendHistoryServiceError(res: Response, error: ServiceError): void {
  res.status(error.statusCode).json({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    },
  })
}

/** Same viewer-id derivation `routes/approvals.ts`'s private `resolveApprovalActorId` uses — kept
 *  local (not imported) so this file stays self-contained, matching its existing style of holding
 *  its own `isPlmApprovalId` copy rather than importing the sibling route's private helpers. */
function resolveApprovalActorId(req: Request): string | null {
  const candidate = req.user?.id ?? req.user?.userId ?? req.user?.sub
  if (typeof candidate !== 'string') return null
  const normalized = candidate.trim()
  return normalized.length > 0 ? normalized : null
}

/**
 * Lock-10 (S1) OD-S1-11 — the SAME envelope `routes/approvals.ts`'s `approvalErrorResponse`
 * builds for `APPROVAL_NOT_FOUND` (`{ ok:false, error:{ code, message } }`, no `details` key).
 * G-S1-5's paired test asserts equality on the parsed body across both doors — a `details` key
 * leaking onto this denial would be a values channel out of a denial path (Lock-7 OD-L7-7), and
 * this route's OWN error builder above (`sendHistoryServiceError`) forwards `error.details`, so
 * this dedicated builder exists specifically to NOT do that for the S1 denial.
 */
function approvalNotFoundResponse() {
  return {
    ok: false,
    error: {
      code: 'APPROVAL_NOT_FOUND',
      message: 'Approval instance not found',
    },
  }
}

/**
 * Lock-9 FE read-half companion (#5099 gate P1-1) — ADDITIVE ONLY. Pulls exactly ONE key,
 * `attachmentIds`, out of a `metadata->'attachmentIds'` SQL projection (never the whole `metadata`
 * object, which can carry policy/internal keys — see this route's docblock further down). The
 * platform branch's row shape stays snake_case / no other new columns; this is the sole new field.
 *
 * Field-path decision (read against `origin/claude/approval-lock9-fe-20260822` at HEAD, PR #5099):
 * `attachmentRefs.ts`'s `collectHistoryAttachmentRefIds` reads `item.metadata.attachmentIds` (an
 * object, not a top-level array) — so a bare top-level `attachmentIds` field here would silently
 * miss the FE's actual read path. This emits `metadata: { attachmentIds }` with ONLY that one key
 * inside `metadata`, and ONLY when the array is non-empty; an item with no rider ids gets no
 * `metadata` key at all (omitted, never `metadata: {}` or `metadata: { attachmentIds: [] }`) — the
 * FE's own `if (!metadata || typeof metadata !== 'object') continue` / `if (!Array.isArray(ids))
 * continue` guards treat an absent `metadata` key exactly the same as an empty one, so this omission
 * is a pure size/no-op choice, not a behavior fork.
 *
 * Defensive against the jsonb value arriving already-parsed (the common case, `pg`'s default type
 * parser) OR as a raw JSON string (driver/type-parser configuration is not re-verified here) — either
 * shape is handled, and anything else (null, object, malformed string) yields `[]`. Every element is
 * filtered to `string` — a hostile/corrupt metadata blob can never smuggle a non-string value out.
 * Fix-round P3-1 (post-#5104-gate): both branches — the array-filter AND the `JSON.parse` string
 * path — are exercised by dedicated real-DB assertions in C-18 (`approval-comments.db.test.ts`), not
 * only described here; a mutation that deletes the `.filter(...)` or the `JSON.parse` branch now
 * turns a test red.
 *
 * Gated by `isApprovalAttachmentsEnabled()` at the call site below (fix-round P2-1): this function
 * itself does no gating so it stays a pure parser, independently testable.
 */
function extractRiderAttachmentIds(raw: unknown): string[] {
  let value: unknown = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

export function approvalHistoryRouter(options?: ApprovalHistoryRouterOptions): Router {
  const r = Router()

  // Guard alignment: matches GET /api/approvals/:id (routes/approvals.ts), which applies
  // authenticate + rbacGuard('approvals', 'read') ahead of its handler. This guard sits before the
  // `isPlmApprovalId` branch below, so both id shapes reach the same FIRST gate.
  //
  // #5024 (a0edbe39a4) brought this route to PERMISSION parity with the detail route — its own
  // body said "neither this route nor its sibling adds a per-instance predicate on top of
  // rbacGuard". Lock-10 (S1) is the per-instance predicate #5024 deferred: for PLATFORM ids (not
  // `plm:`), AFTER this guard and after the plm: branch below, `canReadApprovalInstance` now
  // decides per-instance admission — a principal WITHOUT `approvals:read` still gets 403 (this
  // guard, unchanged, is leg-1 and runs first); a principal WITH it who is not a participant now
  // gets 404 `APPROVAL_NOT_FOUND` (OD-S1-11/OD-S1-12), matching the sibling detail route exactly
  // (G-S1-5 pins this pairing). `approval-history-authz-guard.db.test.ts` is the regression harness
  // for both: this guard's two 403s and its 401 are unchanged; four of its previously-200 cases are
  // re-cast for the new per-instance narrowing.
  r.get('/api/approvals/:id/history', authenticate, rbacGuard('approvals', 'read'), async (req: Request, res: Response) => {
    try {
      const id = req.params.id
      if (isPlmApprovalId(id)) {
        const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>)
        const plmAdapter = resolvePlmAdapter(options)
        if (!plmAdapter) {
          return res.status(503).json({
            ok: false,
            error: {
              code: 'PLM_APPROVAL_BRIDGE_UNAVAILABLE',
              message: 'PLM approval bridge is not configured',
            },
          })
        }

        const history = await new ApprovalBridgeService(plmAdapter).getApprovalHistory(id)
        const items = history.slice(offset, offset + pageSize)
        return res.json({
          ok: true,
          data: {
            items,
            page,
            pageSize,
            total: history.length,
          },
        })
      }

      if (!pool) {
        return res.status(503).json({
          ok: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'DB not configured',
          },
        })
      }

      // Lock-10 (S1) OD-S1-1/OD-S1-12 — per-instance admission for PLATFORM ids only (the `plm:`
      // branch above already returned). Same values-free 404 the sibling detail route gives a
      // non-participant (OD-S1-11) — see approvalNotFoundResponse's docblock for why this is a
      // dedicated builder rather than sendHistoryServiceError.
      const viewerId = resolveApprovalActorId(req)
      const readable = viewerId ? await canReadApprovalInstance(pool, viewerId, id) : false
      if (!readable) {
        return res.status(404).json(approvalNotFoundResponse())
      }

      const { page, pageSize, offset } = parsePagination(req.query as Record<string, unknown>)
      // Lock-5 §1.4 fact 2 / gate D-3 — this is one of the TWO unfiltered full-timeline readers, and
      // the ONLY one that paginates. A refused member operation writes an `action:'policy_denied'`
      // audit row (§1.4); without this exclusion a click the server REFUSED would appear in the
      // member timeline as if something had happened, and — because the count below is the same
      // unfiltered predicate — would silently shift `total` and therefore the page boundaries. The
      // exclusion is applied to BOTH the count and the page query, with the same literal, so the two
      // can never disagree.
      //
      // Lock-10 (S2) HISTORY-TIMELINE arm (i) (owner-ruled 2026-08-21, ledger `:91` / Lock-10
      // §5.1.1 closing paragraph): this reader ALSO excludes the comment audit-pointer rows S2's
      // dual-write inserts (`action:'comment'`, `metadata:{commentId}`, `comment` column ALWAYS
      // NULL) — `metadata->>'commentId' IS NULL` on BOTH queries, same literal, no bound parameter.
      // The DISCRIMINATOR IS THE METADATA KEY, NEVER `action <> 'comment'` — the legacy act-path
      // comment row (body in the `comment` column, `metadata:{nodeKey}`, no `commentId`) is shipped
      // member-visible history and MUST stay in the timeline; `action <> 'comment'` would silently
      // hide it too. `metadata` is nullable (no `NOT NULL` in the migrations/bootstrap); a NULL
      // `metadata` correctly stays INCLUDED because `NULL->>'commentId' IS NULL` is TRUE.
      const countRes = await pool.query(
        "SELECT COUNT(*)::int AS c FROM approval_records WHERE instance_id = $1 AND action <> $2 AND metadata->>'commentId' IS NULL",
        [id, APPROVAL_POLICY_DENIED_ACTION],
      )
      const total = Number(countRes.rows[0]?.c || 0)
      // Lock-9 FE read-half companion + the owner's 2026-09-20 ruling on the cancel-round durable
      // read — every metadata projection here is a SINGLE JSONB KEY PATH, never `metadata` itself.
      // THREE key paths now (`attachmentIds`, `cancellationOutcome`, `cancelRoundCloseReason`), and
      // the list is exhaustive at this head: no other metadata key is asked of the DB, so the
      // internal ones (`w4ActorPosture`, `parallelCancelledAssignees`, `cancelRoundBlockDetail`,
      // `approvalThreshold`, `channel`/`cardDeliveryId`, …) cannot reach a client from this route
      // even if the map below were wrong. This changes neither the WHERE clause (S2's pointer-row
      // exclusion, `metadata->>'commentId' IS NULL`, is untouched on both queries above/below) nor
      // the row set nor the ORDER/LIMIT/OFFSET — only three additional expressions are read per
      // row, each aliased so it never collides with a real column name.
      const { rows } = await pool.query(
        `SELECT
           id,
           occurred_at,
           actor_id,
           actor_name,
           action,
           comment,
           from_status,
           to_status,
           COALESCE(to_version, version) AS version,
           from_version,
           to_version,
           metadata->'attachmentIds' AS lock9_attachment_ids_raw,
           metadata->'cancellationOutcome' AS cancel_round_outcome_raw,
           metadata->>'cancelRoundCloseReason' AS cancel_round_close_reason_raw
         FROM approval_records
         WHERE instance_id = $1
           AND action <> $4
           AND metadata->>'commentId' IS NULL
         ORDER BY occurred_at DESC
         LIMIT $2 OFFSET $3`,
        [id, pageSize, offset, APPROVAL_POLICY_DENIED_ACTION],
      )

      // The row shape is bounded by the explicit SELECT list above (no bare `metadata` column is
      // ever projected there) — the destructure below only strips the THREE internal `*_raw`
      // aliases so they can never themselves leak onto the wire; it is not what keeps other
      // metadata keys out (the SELECT list already never asked the DB for them). Each projector
      // then REBUILDS its value field by field from a fixed key set (see
      // `projectCancelRoundCancellationOutcomeForReadV1`), so a key nested INSIDE a whitelisted
      // object — which the SELECT list cannot exclude on its own — is dropped here.
      //
      // TWO INDEPENDENT GATES, deliberately not one:
      //  - `attachmentIds` stays gated on `isApprovalAttachmentsEnabled()`, checked ONCE per
      //    request (the flag can't change mid-request) — the SAME flag `/refs`, `/download` and
      //    `dispatchAction` gate on (`./approval-attachments`).
      //  - the cancel-round keys are NOT gated on it. The attachments flag is a different feature
      //    and reusing it would make the durable read of a cancellation outcome depend on whether
      //    approval attachments happen to be switched on (`M-1`'s own warning in
      //    `verify-c2-history-dto-cancellation-outcome-20260920.md` §5: 「不该复用(语义无关)」).
      //
      // ⚠️ CORRECTED CLAIM (owner ruling 2026-09-20). Until this change the comment here said the
      // flag-OFF map produces 「byte-for-byte the SAME `item` shape as before this field existed」.
      // That was true while `attachmentIds` was the only projected key and is NOT true any more:
      // a row carrying `cancellationOutcome` or `cancelRoundCloseReason` now gets a `metadata` key
      // with the flag OFF. What remains exactly true, and is what the flag is for, is narrower:
      // with the flag OFF no `attachmentIds` key is ever attached, regardless of what a row's
      // `lock9_attachment_ids_raw` holds.
      //
      // A row with none of the three whitelisted values gets NO `metadata` key at all (omitted,
      // never `metadata: {}`) — Lock-9's original shape choice, preserved.
      const attachmentsEnabled = isApprovalAttachmentsEnabled()
      const items = rows.map((row) => {
        const {
          lock9_attachment_ids_raw: attachmentIdsRaw,
          cancel_round_outcome_raw: cancellationOutcomeRaw,
          cancel_round_close_reason_raw: cancelRoundCloseReasonRaw,
          ...item
        } = row as Record<string, unknown> & {
          lock9_attachment_ids_raw?: unknown
          cancel_round_outcome_raw?: unknown
          cancel_round_close_reason_raw?: unknown
        }
        const metadata: Record<string, unknown> = {}
        const cancellationOutcome = projectCancelRoundCancellationOutcomeForReadV1(cancellationOutcomeRaw)
        if (cancellationOutcome) metadata.cancellationOutcome = cancellationOutcome
        const cancelRoundCloseReason = projectCancelRoundCloseReasonForReadV1(cancelRoundCloseReasonRaw)
        if (cancelRoundCloseReason !== null) metadata.cancelRoundCloseReason = cancelRoundCloseReason
        if (attachmentsEnabled) {
          const attachmentIds = extractRiderAttachmentIds(attachmentIdsRaw)
          if (attachmentIds.length > 0) metadata.attachmentIds = attachmentIds
        }
        return Object.keys(metadata).length > 0 ? { ...item, metadata } : item
      })

      return res.json({
        ok: true,
        data: {
          items,
          page,
          pageSize,
          total,
        },
      })
    } catch (error) {
      if (error instanceof ServiceError) {
        sendHistoryServiceError(res, error)
        return
      }

      return res.status(500).json({
        ok: false,
        error: {
          code: 'APPROVAL_HISTORY_FETCH_FAILED',
          message: 'Failed to load approval history',
        },
      })
    }
  })

  return r
}
