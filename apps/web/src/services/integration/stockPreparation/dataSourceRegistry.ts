// BOM备料 接入向导第①a 步「登记外接数据源」的真实检测 (向导①拆分, 2026-09-10).
//
// THE QUESTION THIS ANSWERS, AND WHY IT NEEDED ITS OWN READ.
// 整合切片 (2026-09-09) folded 外接数据源 into 数据工厂's 连接管理 section, which made the wizard's
// old step ① 「接一条只读连接」 describe TWO separate acts that are done by two different controls on
// two halves of one section:
//
//     ①a 在「连接管理」顶部登记一条外接数据源(物理连接 + 凭据,写 `data_sources`);
//     ①b 在同一分区下方「新增连接草稿」建一条 SQL 只读绑定,用 `connectionId` 引用①a 那条。
//
// The source-binding envelope this page already reads (`sourceBinding.ts`) answers ①b and ONLY ①b:
// `eligibleSources` enumerates EXTERNAL SYSTEMS — the bindings — not the data sources behind them.
// Its emptiness is therefore silent about ①a: a deployment can have a perfectly good SQL Server
// registered and simply not have wired a binding to it yet, and reading that envelope as an answer
// about ①a would report 「还没登记」 to an administrator who registered one an hour ago.
//
// So ①a gets the one read that can answer it, on the same terms as ⑤「谁能用」: issued by the wizard
// component, never rejecting, and collapsing every unanswerable outcome into ONE `unknown` state.
//
// D6 IS UNTOUCHED (源预检永不随页面自动跑). D6 is about probing the CUSTOMER's database. This route
// does not: `packages/core-backend/src/routes/data-sources.ts` `GET /api/data-sources` calls
// `DataSourceManager.listDataSources`, which walks the in-process adapter map and reads
// `adapter.isConnected()` — a flag, not a connection attempt. Nothing here opens a socket to a
// customer host, so it is safe to run unprompted on mount, and it is the only reason this step can
// have an answer before anyone presses anything.
//
// VALUES-FREE, AND NARROWER THAN THE PAYLOAD. The route returns `{ id, name, type, connected }` per
// source (and `ownerId` for a platform admin). NOTHING below reads `id`, `name` or `ownerId`, and
// nothing below returns them: the projection is narrowed to a STATE plus two integer COUNTS before
// it leaves this file, so the view physically cannot render a connection name it was never handed.
// A customer's connection names are values — 「用友U8生产库」 names a system, a vendor and a purpose —
// and this wizard has no sentence that needs one.
//
// OWNER-SCOPED BY THE SERVER, AND SAID SO. `listDataSources({ actor })` shows an owner their own
// sources and a platform admin every source (#5401 — the data plane has no admin bypass for USE, only
// for management metadata). So a count of 0 means 「本账号看不到可用的数据源」, not 「这台机器上没有
// 数据源」, and the view's wording must not promote the first into the second.
//
// 「看不到」≠「没完成」 (G4). 403 (this caller holds no `data_sources:read`), 401, 500, a network
// drop, an HTML sign-in page wearing a 200, a payload whose shape this file does not recognise — all
// collapse to `unknown`. `absent` remains reachable, and is correct, when the list IS read and holds
// no SQL-capable source.
import { apiFetch } from '../../../utils/api'

/** Asserted literally in this module's spec, so a route rename cannot pass unnoticed. */
export const STOCK_PREP_DATA_SOURCE_REGISTRY_ROUTE = '/api/data-sources'

/**
 * The connector types ①a can be satisfied by — the RELATIONAL ones, because ①b's binding kind
 * (`data-source:sql-readonly`) is a SQL read-only bridge and the BOM expander issues SQL against it.
 *
 * Mirrored from `DEFAULT_ADAPTER_REGISTRY` in
 * `packages/core-backend/src/data-adapters/DataSourceManager.ts`, minus the two that cannot back a
 * SQL binding: `http` (a REST adapter — registering one is real work, and it is not work toward
 * THIS step) and `plm` (the managed adapter, which is not an operator-registered external source).
 * `postgresql` and `postgres` are both listed because the backend registry accepts both spellings
 * for the same adapter class and either may come back on the wire.
 */
export const STOCK_PREP_SQL_DATA_SOURCE_TYPES: readonly string[] = Object.freeze([
  'postgres',
  'postgresql',
  'sqlserver',
  'mysql',
])

export type StockPrepDataSourceRegistryState =
  /** 至少有一条本账号能看见的关系型数据源 —— ①a 有实证。 */
  | 'present'
  /** 名单读到了,里面没有关系型数据源 —— 这是真答案,不是「读不到」。 */
  | 'absent'
  /** 读不到 / 形状不认识 —— 判断不了,不是「没完成」。 */
  | 'unknown'

export interface StockPrepDataSourceRegistry {
  state: StockPrepDataSourceRegistryState
  /** How many listed sources are of a SQL type. Integer only — never a name, never an id. */
  sqlCount: number
  /** How many sources were listed in total, SQL or not. Lets the view say 「有源,但都不是数据库」. */
  totalCount: number
  /** HTTP status when the read did not answer, `null` when it did (or when there was no response). */
  status: number | null
}

/** The one shape every failure collapses to. Exported so callers never retype the literal. */
export function stockPrepDataSourceRegistryUnknown(status: number | null): StockPrepDataSourceRegistry {
  return { state: 'unknown', sqlCount: 0, totalCount: 0, status }
}

/** Is this row's `type` one of the relational kinds a SQL read-only binding can sit on? */
export function stockPrepIsSqlDataSourceType(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  return STOCK_PREP_SQL_DATA_SOURCE_TYPES.includes(raw.trim().toLowerCase())
}

/**
 * THE PROJECTION, as a pure function over whatever `data` the route returned.
 *
 * `data.items` missing or not an array is `unknown`, NOT `absent`: an unrecognised shape means the
 * question was not answered, and answering it anyway with a confident 「还没登记」 would send an
 * administrator to redo work that may well be done. An `items: []` that IS an array is a real
 * answer — this account can see no data source at all.
 *
 * Rows that are not objects are skipped rather than counted, and a row with an unreadable `type` is
 * counted in `totalCount` but not in `sqlCount`: it exists, and this file will not guess what it is.
 */
export function stockPrepDataSourceRegistryFromPayload(data: unknown): StockPrepDataSourceRegistry {
  if (!data || typeof data !== 'object') return stockPrepDataSourceRegistryUnknown(null)
  const items = (data as { items?: unknown }).items
  if (!Array.isArray(items)) return stockPrepDataSourceRegistryUnknown(null)

  let sqlCount = 0
  let totalCount = 0
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue
    totalCount += 1
    if (stockPrepIsSqlDataSourceType((entry as { type?: unknown }).type)) sqlCount += 1
  }

  return {
    state: sqlCount > 0 ? 'present' : 'absent',
    sqlCount,
    totalCount,
    status: null,
  }
}

/**
 * THE READ. One GET, no query string: the route takes no filter and scopes itself by actor.
 *
 * `suppressUnauthorizedRedirect` is deliberate, for the same reason `onboardingReadiness.ts` sets
 * it: this is a PRELOAD on a page the caller is already authorised to be on, and bouncing them to
 * the sign-in screen because a background probe came back 401 is a worse lie than 「看不到」. G3 —
 * a preload's refusal degrades to a state, never to navigation and never to a banner.
 *
 * Never rejects. Every throw — fetch failure, a mocked client returning nothing, a body that is not
 * JSON — is caught and reported as `unknown`.
 */
export async function readStockPrepDataSourceRegistry(): Promise<StockPrepDataSourceRegistry> {
  try {
    const response = await apiFetch(STOCK_PREP_DATA_SOURCE_REGISTRY_ROUTE, { suppressUnauthorizedRedirect: true })
    const status = typeof response?.status === 'number' ? response.status : null
    if (!response || response.ok !== true) return stockPrepDataSourceRegistryUnknown(status)
    let body: unknown = null
    try {
      body = await response.json()
    } catch {
      // A 200 carrying an HTML sign-in page is a refusal wearing a success code.
      return stockPrepDataSourceRegistryUnknown(status)
    }
    if (!body || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
      return stockPrepDataSourceRegistryUnknown(status)
    }
    return stockPrepDataSourceRegistryFromPayload((body as { data?: unknown }).data)
  } catch {
    return stockPrepDataSourceRegistryUnknown(null)
  }
}
