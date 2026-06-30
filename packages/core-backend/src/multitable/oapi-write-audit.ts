/**
 * OAPI-2a token-write audit — the two-layer model (design-lock
 * `docs/development/multitable-oapi2-write-designlock-20260628.md` §6 / §10.7, RATIFIED).
 *
 * Because a denial never commits, a single post-commit hook cannot capture it. So:
 *   - COMMITTED writes are audited by an INSERT **inside the mutation transaction** (the record/comment
 *     services), via {@link insertCommittedAuditInTxn} / {@link insertCommittedAuditKysely}. If that INSERT
 *     throws, the surrounding transaction rolls back → the write fails closed. The committed row IS the
 *     audit (no separate route-boundary "committed" row → no double-audit).
 *   - DENIED / ERROR / RATE_LIMITED attempts are audited best-effort at the route boundary via
 *     {@link oapiWriteAuditBoundary} (a `res.on('finish')` listener that fires after the response). A failed
 *     write here ALERTS (never silently drops) — there is no mutation txn to roll back.
 *
 * Every control here is a STRICT NO-OP for session (non-token) requests: the boundary skips when there is no
 * `req.apiTokenId`, and the in-txn insert fires only when the service receives an `OapiWriteAuditContext`.
 */
import { sql } from 'kysely'
import type { Request, Response, NextFunction } from 'express'
import { Logger } from '../core/logger'
import { db } from '../db/db'
import { redactString } from './automation-log-redact'

const logger = new Logger('OapiWriteAudit')

export type OapiWriteOperation = 'create' | 'update' | 'upsert' | 'delete'
export type OapiWriteOutcome = 'committed' | 'denied' | 'error' | 'rate_limited'

/** Fixed context for a token write, resolved at the route boundary before the mutation runs. */
export interface OapiWriteAuditContext {
  tokenId: string
  actorId: string
  operation: OapiWriteOperation
  scope: string
  sheetId?: string | null
  requestId?: string | null
}

/** Result detail available only for a committed write (already inside the txn). */
export interface OapiWriteCommittedResult {
  recordIds?: string[] | null
  batchCount?: number | null
  detail?: Record<string, unknown> | null
}

/** A raw parameterized query fn — matches the `query` handle from `pool.transaction({ query })`. */
export type TxnQuery = (text: string, params?: readonly unknown[]) => Promise<unknown>

/**
 * Build a committed-write audit context from the request. Returns `null` for non-token (session) requests,
 * which is the signal for callers to skip the in-txn audit entirely (no-op for session writes).
 */
export function buildOapiAuditContext(
  req: Request,
  operation: OapiWriteOperation,
  scope: string,
): OapiWriteAuditContext | null {
  if (!req.apiTokenId || !req.apiTokenUserId) return null
  const body = (req.body ?? {}) as Record<string, unknown>
  const params = (req.params ?? {}) as Record<string, unknown>
  const sheetId =
    (typeof body.sheetId === 'string' && body.sheetId) ||
    (typeof params.sheetId === 'string' && params.sheetId) ||
    null
  const requestId = typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : null
  return { tokenId: req.apiTokenId, actorId: req.apiTokenUserId, operation, scope, sheetId, requestId }
}

/**
 * Insert the COMMITTED audit row using a raw txn `query` handle (record services). MUST be called inside the
 * mutation transaction, after the mutation succeeds: if it throws, the transaction rolls back (fail-closed).
 */
export async function insertCommittedAuditInTxn(
  query: TxnQuery,
  ctx: OapiWriteAuditContext,
  result: OapiWriteCommittedResult,
): Promise<void> {
  await query(
    `INSERT INTO oapi_write_audit
       (token_id, actor_id, operation, scope, sheet_id, record_ids, batch_count, outcome, status_code, request_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'committed', NULL, $8, $9::jsonb)`,
    [
      ctx.tokenId,
      ctx.actorId,
      ctx.operation,
      ctx.scope,
      ctx.sheetId ?? null,
      result.recordIds && result.recordIds.length ? result.recordIds : null,
      result.batchCount ?? null,
      ctx.requestId ?? null,
      result.detail ? JSON.stringify(result.detail) : null,
    ],
  )
}

/**
 * Insert the COMMITTED audit row using a Kysely transaction handle (CommentService). Same fail-closed
 * contract: a throw rolls back the comment-create transaction.
 */
export async function insertCommittedAuditKysely(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  trx: any,
  ctx: OapiWriteAuditContext,
  result: OapiWriteCommittedResult,
): Promise<void> {
  const detail = result.detail ? JSON.stringify(result.detail) : null
  await sql`
    INSERT INTO oapi_write_audit
      (token_id, actor_id, operation, scope, sheet_id, record_ids, batch_count, outcome, status_code, request_id, detail)
    VALUES (${ctx.tokenId}, ${ctx.actorId}, ${ctx.operation}, ${ctx.scope}, ${ctx.sheetId ?? null},
            NULL, ${result.batchCount ?? null}, 'committed', NULL, ${ctx.requestId ?? null}, ${detail}::jsonb)
  `.execute(trx)
}

/**
 * Best-effort route-boundary writer for a NON-committed attempt (denied / error / rate_limited), via the
 * global Kysely `db`. Never throws into the request path; a write failure ALERTS (the lost abuse-signal must
 * not be silent).
 */
export async function recordOapiWriteAttempt(
  ctx: OapiWriteAuditContext,
  outcome: Exclude<OapiWriteOutcome, 'committed'>,
  statusCode: number,
  reason?: string,
): Promise<void> {
  try {
    // OAPI-4a: a 403-issuing guard (oapiScopeGuard / requireScope) sets a fixed, enum-like reason
    // (`out_of_base_sheet_scope` / `insufficient_scope`); persist it value-scrubbed as `detail.reason`.
    const detail = reason ? JSON.stringify({ reason: redactString(reason) }) : null
    await sql`
      INSERT INTO oapi_write_audit
        (token_id, actor_id, operation, scope, sheet_id, record_ids, batch_count, outcome, status_code, request_id, detail)
      VALUES (${ctx.tokenId}, ${ctx.actorId}, ${ctx.operation}, ${ctx.scope}, ${ctx.sheetId ?? null},
              NULL, NULL, ${outcome}, ${statusCode}, ${ctx.requestId ?? null}, ${detail}::jsonb)
    `.execute(db)
  } catch (err) {
    logger.error(
      `[ALERT] failed to persist ${outcome} OAPI write attempt (token=${ctx.tokenId} op=${ctx.operation} status=${statusCode}); abuse-signal lost`,
      err instanceof Error ? err : undefined,
    )
  }
}

/**
 * Outermost route middleware: registers a `res.on('finish')` listener that audits a NON-2xx token-write
 * outcome (denied 403 / rate_limited 429 / error 5xx) at the boundary. A 2xx is skipped — that committed
 * write was already audited in-txn by the service (mutual exclusivity → no double-audit). No-op for session
 * (non-token) requests. Mount AFTER `apiTokenAuth` (so `apiTokenId` is set) and BEFORE `requireScope` /
 * the limiter (so their 403/429 are observed).
 */
export function oapiWriteAuditBoundary(operation: OapiWriteOperation, scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ctx = buildOapiAuditContext(req, operation, scope)
    if (!ctx) {
      next()
      return
    }
    res.on('finish', () => {
      const sc = res.statusCode
      if (sc >= 200 && sc < 300) return // committed — audited in-txn
      const outcome: Exclude<OapiWriteOutcome, 'committed'> =
        sc === 429 ? 'rate_limited' : sc === 403 ? 'denied' : 'error'
      // `req.oapiAuditReason` is set synchronously by the guard before the 403 is sent, so it is
      // observable here at finish-time (undefined for rate_limited/error — bare outcome row, as before).
      void recordOapiWriteAttempt(ctx, outcome, sc, req.oapiAuditReason)
    })
    next()
  }
}
