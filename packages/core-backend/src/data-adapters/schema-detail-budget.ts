/**
 * Wall-clock budget for the EXPENSIVE schema listing (getSchema({ includeColumns: true })).
 *
 * Background (2026-09-10 222 PLM 504): `getSchema()` used to read every table's columns/keys/indexes, i.e. 4N+2
 * round trips. On the customer PLM SQL Server (222, 2026-09-10) `GET /api/data-sources/plm/schema`
 * ran past nginx's proxy_read_timeout four times in a row — `upstream timed out (10060)` → 504 with
 * an HTML error body the UI cannot explain. The listing itself is now list-only by default; the
 * old fan-out survives behind `includeColumns` and is bounded here so the SERVER answers a coded,
 * actionable refusal BEFORE the proxy gives up on us.
 *
 * The refusal carries `status`/`code` so routes/data-sources.ts `codedGateRefusal()` forwards it
 * verbatim (504 SCHEMA_DETAIL_TIMEOUT), exactly like the other coded gate refusals.
 */

export const SCHEMA_DETAIL_BUDGET_ENV = 'DATA_SOURCE_SCHEMA_DETAIL_BUDGET_MS'

/**
 * Default budget for the OPT-IN route path (`?includeColumns=1` / `?detail=full`).
 *
 * Sizing, stated as what is actually checkable: the proxy configs IN THIS REPO are
 * `proxy_read_timeout 300s` (docker/nginx.conf:63, ops/nginx/multitable-onprem.conf.example:20).
 * The 222 deployment's effective value has NOT been read off that machine — do not treat 25s as
 * "just under the proxy". It is a deliberately small default for a route nothing in-tree calls:
 * a caller that opts into the several-hundred-round-trip listing gets a coded, explainable refusal
 * quickly instead of holding a pooled connection for minutes. Raise it per deployment with
 * DATA_SOURCE_SCHEMA_DETAIL_BUDGET_MS (or pass budgetMs explicitly; <= 0 disables it, which is what
 * the plugin facade does to keep its pre-existing unbounded behaviour — see data-source-plugin-facade.ts).
 */
export const DEFAULT_SCHEMA_DETAIL_BUDGET_MS = 25_000

/**
 * Explicit "no budget" value. Passing this is how a caller says "I am NOT behind the /schema route
 * and I keep the pre-change unbounded behaviour" — an in-range (25s–300s) listing that used to
 * succeed must not start hard-failing just because a budget was introduced elsewhere.
 */
export const SCHEMA_DETAIL_BUDGET_DISABLED = 0

export const SCHEMA_DETAIL_TIMEOUT_CODE = 'SCHEMA_DETAIL_TIMEOUT'

export interface SchemaDetailBudget {
  /**
   * Call BEFORE starting work on the next entry. Throws the coded 504 once the budget is spent.
   * `loaded`/`total` are counts only — never table names, never connection values.
   */
  assertWithinBudget(loaded: number, total: number): void
  readonly budgetMs: number
}

/**
 * Resolution order: explicit option → env override → default. A non-finite or unparsable value
 * falls back to the default (never to "unbounded" by accident); an explicit <= 0 disables the
 * budget, which is the documented escape hatch for offline scripts.
 */
export function resolveSchemaDetailBudgetMs(explicit?: number, env: NodeJS.ProcessEnv = process.env): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit)) return explicit
  const raw = env[SCHEMA_DETAIL_BUDGET_ENV]
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw)
    if (Number.isFinite(parsed)) return parsed
  }
  return DEFAULT_SCHEMA_DETAIL_BUDGET_MS
}

export function schemaDetailTimeoutError(loaded: number, total: number, budgetMs: number): Error {
  const message =
    `读取全库字段超时（已读 ${loaded}/${total} 张表，预算 ${budgetMs}ms），` +
    `请改用逐表读取字段（GET /api/data-sources/:id/tables/:table） / ` +
    `Reading columns for every table exceeded the ${budgetMs}ms budget after ${loaded}/${total} tables; ` +
    `read columns one table at a time instead`
  return Object.assign(new Error(message), {
    status: 504,
    code: SCHEMA_DETAIL_TIMEOUT_CODE,
  })
}

export function startSchemaDetailBudget(budgetMs?: number, now: () => number = Date.now): SchemaDetailBudget {
  const resolved = resolveSchemaDetailBudgetMs(budgetMs)
  const startedAt = now()
  return {
    budgetMs: resolved,
    assertWithinBudget(loaded: number, total: number): void {
      if (!(resolved > 0)) return
      if (now() - startedAt >= resolved) throw schemaDetailTimeoutError(loaded, total, resolved)
    },
  }
}
