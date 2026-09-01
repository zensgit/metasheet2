// BOM备料 数据来源 — the browser side of 工作台里选源.
//
// WHAT THIS REPLACES. Until now, pointing 备料 at a customer's own PLM meant an implementer opened a
// shell on the server, edited INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON, and restarted
// the backend — because the source was read once at plugin activation. The two routes below make it
// a name in a dropdown, and the server resolves the binding per request, so the change is live on
// the next 同步 with no restart.
//
// TWO CALLS, both at the integration ADMIN tier:
//
//     GET  /api/integration/stock-preparation/source-binding   —— current + eligible candidates
//     POST /api/integration/stock-preparation/source-binding   —— bind one of them
//
// The GET is admin-tier deliberately, and the view mirrors that rather than working around it: it
// enumerates exactly the sources whose Save would succeed, which is the POST's own authority stated
// in advance. R-11 — what is not permitted must not be visible — so a non-admin is shown the
// read-only explanation and this module is never called for them.
//
// THE SERVER DECIDES ELIGIBILITY, NOT THIS FILE. `eligibleSources` arrives already filtered: only
// the two BOM read kinds, only active, only non-write roles, and only data sources this principal
// may actually use (#5401 is owner-only on the data plane — being an admin does not make a
// colleague's connection yours). Re-deriving any of that here would be a second, drifting authority;
// the view renders what it is given.
//
// VALUES-FREE. Ids, connector kinds, status enums, the operator-authored system name, and the
// 对接总览 register's plain-language kind labels. Nothing off a system's config — no host, no data
// source pointer, no credential — is on the wire, and errors carry an HTTP STATUS only, never a
// server message that could quote one.
import { apiFetch } from '../../../utils/api'
import { buildQueryString, type IntegrationApiEnvelope, type IntegrationScope } from '../workbench'

export const STOCK_PREPARATION_SOURCE_BINDING_ROUTE = '/api/integration/stock-preparation/source-binding'

/** The frozen table action whose source this binds. Shown so an implementer can grep for it. */
export const STOCK_PREPARATION_PULL_ACTION_ID = 'plm.stock-preparation.pull-bom.v1'

/** The 对接总览 register's bilingual label for a connector kind, served rather than re-tabled here. */
export interface StockPreparationSourceKindLabel {
  zh: string
  en: string
}

export interface StockPreparationSourceCandidate {
  externalSystemId: string
  /** Operator-authored connection name — what an admin actually recognises. */
  name: string | null
  /** The raw connector token, for the 技术详情 line. Never "prettified". */
  kind: string | null
  kindLabel: StockPreparationSourceKindLabel | null
  status: string | null
  role: string | null
}

export interface StockPreparationPersistedBinding {
  tenantId: string
  workspaceId: string | null
  actionId: string
  externalSystemId: string
  updatedBy: string | null
  createdAt: string | null
  updatedAt: string | null
}

/**
 * `origin` is the whole point of the screen:
 *   'persisted'      —— an admin chose this source here; it is live.
 *   'deploy_default' —— nothing is bound, so the server's deploy-time default stands.
 *   'unconfigured'   —— neither exists; 备料 has no source at all.
 */
export type StockPreparationSourceOrigin = 'persisted' | 'deploy_default' | 'unconfigured'

export interface StockPreparationSourceBindingView {
  actionId: string
  effectiveExternalSystemId: string | null
  effectiveSourceKind: string | null
  origin: StockPreparationSourceOrigin
  persistedBinding: StockPreparationPersistedBinding | null
  takesEffectWithoutRestart: boolean
  eligibleSources: StockPreparationSourceCandidate[]
}

export interface StockPreparationSourceBindingSaveResult {
  actionId: string
  binding: StockPreparationPersistedBinding
  /** False when the admin re-confirmed the source that was already bound. */
  changed: boolean
  takesEffectWithoutRestart: boolean
}

/**
 * A failed call, carrying the HTTP status and — when the server named one — the values-free refusal
 * REASON token, which is what lets the view say which property disqualified the pick instead of
 * "something went wrong". No server message text is ever kept: a message could quote a value.
 */
export class StockPreparationSourceBindingError extends Error {
  status: number

  code: string | null

  reason: string | null

  constructor(status: number, code: string | null, reason: string | null) {
    super(`stock-preparation source binding call failed (${status})`)
    this.name = 'StockPreparationSourceBindingError'
    this.status = status
    this.code = code
    this.reason = reason
  }
}

async function readJson(response: Response | undefined): Promise<unknown> {
  try {
    return await response?.json()
  } catch {
    return null
  }
}

function statusOf(response: Response | undefined): number {
  return typeof response?.status === 'number' ? response.status : 0
}

/** Pull ONLY the two values-free tokens off an error envelope; never `message`. */
function refusalOf(payload: unknown): { code: string | null; reason: string | null } {
  const error = (payload as { error?: { code?: unknown; details?: { reason?: unknown } } } | null)?.error
  const code = typeof error?.code === 'string' ? error.code : null
  const reason = typeof error?.details?.reason === 'string' ? error.details.reason : null
  return { code, reason }
}

async function readEnvelope<T>(response: Response | undefined): Promise<T> {
  const payload = await readJson(response) as IntegrationApiEnvelope<T> | null
  if (!response?.ok || payload?.ok === false || !payload?.data) {
    const { code, reason } = refusalOf(payload)
    throw new StockPreparationSourceBindingError(statusOf(response), code, reason)
  }
  return payload.data
}

function scopeSuffix(scope: IntegrationScope): string {
  const query = buildQueryString({ tenantId: scope.tenantId, workspaceId: scope.workspaceId })
  return query ? `?${query}` : ''
}

/** The current binding plus the candidates whose Save would succeed. Reads only; changes nothing. */
export async function readStockPreparationSourceBinding(
  scope: IntegrationScope,
): Promise<StockPreparationSourceBindingView> {
  const response = await apiFetch(`${STOCK_PREPARATION_SOURCE_BINDING_ROUTE}${scopeSuffix(scope)}`)
  return readEnvelope<StockPreparationSourceBindingView>(response)
}

/**
 * Bind the source.
 *
 * The body carries an external-system id and NOTHING else — the server's allowlist rejects any other
 * key with a 400, so a click here can move WHERE 备料 reads and never what it reads or how. The
 * tenant is derived server-side from the authenticated principal on this write route, which is why
 * the scope only rides the query string (compatibility) and never the body.
 */
export async function setStockPreparationSourceBinding(
  scope: IntegrationScope,
  externalSystemId: string,
): Promise<StockPreparationSourceBindingSaveResult> {
  const response = await apiFetch(`${STOCK_PREPARATION_SOURCE_BINDING_ROUTE}${scopeSuffix(scope)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ externalSystemId }),
  })
  return readEnvelope<StockPreparationSourceBindingSaveResult>(response)
}

// ---------------------------------------------------------------------------
// Plain language (#5391 register). Committed constants keyed by a token the SERVER emits — this adds
// no new source of text and invents no vocabulary. An unknown token falls back to the raw token
// rather than to a blank line, so a server that grows a new reason degrades to today's rendering.
// ---------------------------------------------------------------------------

export const STOCK_PREP_SOURCE_ORIGIN_TEXT: Readonly<Record<StockPreparationSourceOrigin, { zh: string; en: string }>> = Object.freeze({
  persisted: Object.freeze({
    zh: '已在本页选定 —— 这就是「同步这个项目」当前实际读取的库。',
    en: 'Chosen on this page — this is the database 同步这个项目 actually reads right now.',
  }),
  deploy_default: Object.freeze({
    zh: '尚未选择,当前用的是部署时写死的默认源。选一个下面的连接即可切换。',
    en: 'Nothing chosen yet, so the deploy-time default is in use. Pick one of the connections below to switch.',
  }),
  unconfigured: Object.freeze({
    zh: '这套部署还没有任何数据来源 —— 请先在「对接」里登记一个只读数据库连接。',
    en: 'This deployment has no data source at all — register a read-only database connection under 对接 first.',
  }),
})

/** Why a pick was refused, in words. Keyed by the server's own closed reason vocabulary. */
export const STOCK_PREP_SOURCE_REFUSAL_TEXT: Readonly<Record<string, { zh: string; en: string }>> = Object.freeze({
  not_found: Object.freeze({
    zh: '找不到这个连接 —— 它可能已经被删除,或者不属于本租户。',
    en: 'That connection does not exist — it may have been deleted, or it belongs to another tenant.',
  }),
  kind_ineligible: Object.freeze({
    zh: '这个连接不是只读数据库类型,备料只能从只读库取数,不能从写入类接口取数。',
    en: 'That connection is not a read-only database. 备料 reads from read-only databases only, never from a write-capable endpoint.',
  }),
  role_ineligible: Object.freeze({
    zh: '这个连接登记的用途是「写入目标」,不能当作取数来源。',
    en: 'That connection is registered as a write TARGET, so it cannot be used as a source.',
  }),
  not_active: Object.freeze({
    zh: '这个连接还没有启用。请先在「对接」里把它测试通过并启用,再回来选。',
    en: 'That connection is not active yet. Test and activate it under 对接 first, then come back.',
  }),
  data_source_not_accessible: Object.freeze({
    zh: '这个连接背后的数据库不归您管理,只有它的所有者能把它用作备料来源。',
    en: 'The database behind that connection is not yours to manage; only its owner can use it as a 备料 source.',
  }),
})

export function stockPrepSourceRefusalText(reason: string | null): { zh: string; en: string } | null {
  if (!reason) return null
  return STOCK_PREP_SOURCE_REFUSAL_TEXT[reason] || null
}

/** The line the whole feature exists to be able to say. Stated once, rendered by the view. */
export const STOCK_PREP_SOURCE_NO_RESTART = Object.freeze({
  zh: '保存后立即生效,不需要重启后台,也不需要改服务器上的配置文件。',
  en: 'Takes effect immediately after saving — no backend restart, and no editing a config file on the server.',
})

/** Who may change it, for the read-only rendering a non-admin gets. */
export const STOCK_PREP_SOURCE_ADMIN_ONLY = Object.freeze({
  zh: '只有平台管理员可以更改数据来源。',
  en: 'Only a platform administrator can change the data source.',
})
