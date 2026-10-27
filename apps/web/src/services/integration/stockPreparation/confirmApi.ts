// Stock Preparation MVP (#3751 — docs/development/stock-preparation-mvp-design-20260707.md).
// Shared response parser for the W3 confirmation endpoints (material-mapping / unit-conversion
// confirm reads + human confirm writes, FE views 3/4).
//
// Why not parseIntegrationResponse (workbench.ts): it collapses an error body into Error.message and
// DROPS the machine-readable code, but views 3/4 must branch on specific server codes —
// 409 CONFIRM_UNIT_CANDIDATE_NOT_FOUND means the candidate view is STALE (refresh + re-read), and the
// 400 *_FIELDS_INVALID family carries the offending field NAME in error.details.field.
//
// VALUES-FREE error surface (same discipline as readSourceConfigs.ts ReadSourceApiError): everything
// lifted from the response body into the error object is CLAMPED to an enum-shaped pattern first, so
// a value-carrying string (a drawing number, a unit symbol, a connection string) can never reach the
// DOM through the error path. The raw error message is deliberately NOT propagated.
import type { IntegrationApiEnvelope } from '../workbench'

const ERROR_CODE_PATTERN = /^[A-Z0-9_]{1,80}$/
const ERROR_FIELD_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/
// 备料分批拉取第一期 step 4 PR-7: the server's `details.reason` / `details.status` are closed lower_snake vocabularies
// (the export gate's `lease_in_flight` / `not_settled`, a refresh status token, …) — carried so the copy can say
// which state it is. Anything else (a project number, a message fragment) is dropped, never carried.
const ERROR_DETAIL_TOKEN_PATTERN = /^[a-z][a-z0-9_]{0,47}$/

/** A server `details.reason` / `details.status`, clamped to a lower_snake token; null otherwise. */
export function clampStockPreparationErrorDetailToken(value: unknown): string | null {
  return typeof value === 'string' && ERROR_DETAIL_TOKEN_PATTERN.test(value) ? value : null
}

/** Extra clamped tokens a refusal carries; every existing three-argument construction stays valid. */
export interface StockPreparationConfirmApiErrorDetail {
  reason?: unknown
  status?: unknown
}

export class StockPreparationConfirmApiError extends Error {
  /** HTTP status of the failed request (e.g. 409 for a stale unit candidate). */
  status: number
  /** Clamped server error code (falls back to a fixed local code when absent/non-enum-shaped). */
  code: string
  /** Clamped offending field NAME from error.details.field — null when the error names no field. */
  field: string | null
  /** PR-7: the clamped `details.reason` token (e.g. `lease_in_flight`), null when absent or not token-shaped. */
  reason: string | null
  /** PR-7: the clamped `details.status` token (a refresh status on an export refusal), null otherwise. */
  refreshStatus: string | null

  constructor(status: number, code: string, field: string | null, detail: StockPreparationConfirmApiErrorDetail = {}) {
    super(`stock-preparation confirm request failed (${code}${field ? `/${field}` : ''})`)
    this.name = 'StockPreparationConfirmApiError'
    this.status = status
    this.code = code
    this.field = field
    this.reason = clampStockPreparationErrorDetailToken(detail.reason)
    this.refreshStatus = clampStockPreparationErrorDetailToken(detail.status)
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export async function parseStockPreparationConfirmResponse<T>(response: Response): Promise<T> {
  let payload: IntegrationApiEnvelope<T> | null = null
  try {
    payload = await response.json() as IntegrationApiEnvelope<T>
  } catch {
    payload = null
  }
  if (!response.ok || payload?.ok === false) {
    const error: Record<string, unknown> = isPlainObject(payload?.error) ? payload.error : {}
    const details: Record<string, unknown> = isPlainObject(error.details) ? error.details : {}
    const code = typeof error.code === 'string' && ERROR_CODE_PATTERN.test(error.code)
      ? error.code
      : 'STOCK_PREPARATION_CONFIRM_REQUEST_FAILED'
    const field = typeof details.field === 'string' && ERROR_FIELD_PATTERN.test(details.field)
      ? details.field
      : null
    throw new StockPreparationConfirmApiError(response.status, code, field, { reason: details.reason, status: details.status })
  }
  return payload?.data as T
}
