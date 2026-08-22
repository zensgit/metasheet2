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
      // Lock-9 FE read-half companion — the ONLY new projection is `metadata->'attachmentIds'`
      // (a single jsonb key path, never `metadata` itself). This changes neither the WHERE clause
      // (S2's pointer-row exclusion, `metadata->>'commentId' IS NULL`, is untouched on both queries
      // above/below) nor the row set nor the ORDER/LIMIT/OFFSET — only one additional expression is
      // read per row, aliased so it never collides with a real column name.
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
           metadata->'attachmentIds' AS lock9_attachment_ids_raw
         FROM approval_records
         WHERE instance_id = $1
           AND action <> $4
           AND metadata->>'commentId' IS NULL
         ORDER BY occurred_at DESC
         LIMIT $2 OFFSET $3`,
        [id, pageSize, offset, APPROVAL_POLICY_DENIED_ACTION],
      )

      // The row shape is bounded by the explicit SELECT list above (no bare `metadata` column is
      // ever projected there) — the destructure below only strips the ONE internal
      // `lock9_attachment_ids_raw` alias so it can never itself leak onto the wire; it is not what
      // keeps other metadata keys out (the SELECT list already never asked the DB for them).
      //
      // Fix-round P2-1: gated on `isApprovalAttachmentsEnabled()`, checked ONCE per request (the
      // flag can't change mid-request) so that with the flag OFF this map produces byte-for-byte
      // the SAME `item` shape as before this field existed — no `metadata` key is ever attached,
      // regardless of what a row's `lock9_attachment_ids_raw` holds. This matches the "Flag OFF
      // remains a byte-for-byte no-op" doctrine this route's SQL comment above already claimed but
      // did not, until now, enforce in code (see `isApprovalAttachmentsEnabled` in
      // `./approval-attachments`, the SAME flag `/refs`, `/download` and `dispatchAction` gate on).
      const attachmentsEnabled = isApprovalAttachmentsEnabled()
      const items = rows.map((row) => {
        const {
          lock9_attachment_ids_raw: attachmentIdsRaw,
          ...item
        } = row as Record<string, unknown> & { lock9_attachment_ids_raw?: unknown }
        if (!attachmentsEnabled) return item
        const attachmentIds = extractRiderAttachmentIds(attachmentIdsRaw)
        return attachmentIds.length > 0 ? { ...item, metadata: { attachmentIds } } : item
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
