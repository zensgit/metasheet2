// 「把系统表的英文表头改成中文」 — the browser half of the managed-table relabel (客户反馈 2026-09-24 #4a).
//
// ONE ROUTE, TWO CALLS. The same POST answers both: `{}` is the dry run (the server evaluates the
// compare-and-set plan and writes NOTHING), `{ apply: true }` executes it. The page always shows the
// dry-run plan first and only then offers 「确认执行」, so an admin sees exactly which columns will
// change before any of them does.
//
// THE BODY CARRIES AT MOST `apply` — AND NO QUERY STRING AT ALL. The tables, the target names and
// the tenant are all server-derived (the tenant from the verified token claim), and the route refuses
// any other body key and any query key with a 400. So this module deliberately does not take the
// workbench scope: there is nothing a caller could legitimately steer.
//
// VALUES-FREE BY CONSTRUCTION. The server's plan carries logical field ids, status codes and the
// template's own English/Chinese label pair — never a column's current (possibly hand-typed) name.
// On failure only the HTTP status and the error CODE are kept; the server message is not.
import { apiFetch } from '../../../utils/api'
import type { IntegrationApiEnvelope } from '../workbench'

export const STOCK_PREPARATION_MANAGED_TABLE_RELABEL_ROUTE =
  '/api/integration/stock-preparation/managed-tables/relabel-zh'

export type ManagedTableRelabelEntityStatus =
  | 'renamed'
  | 'would_rename'
  | 'already_target'
  | 'skipped_name_changed'
  | 'skipped_name_taken'
  | 'missing'

export type ManagedTableRelabelTableKind = 'main' | 'ledger' | 'sandbox'

export type ManagedTableRelabelTableStatus = 'present' | 'absent' | 'scope_unavailable'

export interface ManagedTableRelabelEntity {
  from: string
  to: string
  status: ManagedTableRelabelEntityStatus
}

export interface ManagedTableRelabelField extends ManagedTableRelabelEntity {
  fieldId: string
}

export interface ManagedTableRelabelTable {
  kind: ManagedTableRelabelTableKind
  objectId?: string
  objectIdHash?: string
  status: ManagedTableRelabelTableStatus
  sheetName: ManagedTableRelabelEntity | null
  fields: ManagedTableRelabelField[]
  counts: Record<ManagedTableRelabelEntityStatus, number>
  revisionCount: number
}

export interface ManagedTableRelabelPlan {
  mode: 'dry_run' | 'apply'
  locale: string
  tables: ManagedTableRelabelTable[]
  totals: Record<ManagedTableRelabelEntityStatus, number>
  revisionCount: number
  hasPendingRenames: boolean
}

export class ManagedTableRelabelError extends Error {
  status: number

  code: string | null

  constructor(status: number, code: string | null) {
    super(`managed-table relabel call failed (${status})`)
    this.name = 'ManagedTableRelabelError'
    this.status = status
    this.code = code
  }
}

async function readJson(response: Response | undefined): Promise<unknown> {
  try {
    return await response?.json()
  } catch {
    return null
  }
}

async function call(body: Record<string, unknown>): Promise<ManagedTableRelabelPlan> {
  const response = await apiFetch(STOCK_PREPARATION_MANAGED_TABLE_RELABEL_ROUTE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await readJson(response) as IntegrationApiEnvelope<ManagedTableRelabelPlan> | null
  if (!response?.ok || payload?.ok === false || !payload?.data || !Array.isArray(payload.data.tables)) {
    const code = typeof payload?.error?.code === 'string' ? payload.error.code : null
    throw new ManagedTableRelabelError(typeof response?.status === 'number' ? response.status : 0, code)
  }
  return payload.data
}

/** The DRY RUN — what would change. Writes nothing. */
export function planManagedTableRelabel(): Promise<ManagedTableRelabelPlan> {
  return call({})
}

/** EXECUTE — compare-and-set on the server, one config-history row per rename. */
export function applyManagedTableRelabel(): Promise<ManagedTableRelabelPlan> {
  return call({ apply: true })
}

// ---------------------------------------------------------------------------
// Plain language. Keyed by the SERVER's closed vocabulary; an unknown token renders as itself.
// ---------------------------------------------------------------------------

export interface RelabelPlainText {
  zh: string
  en: string
}

export const MANAGED_TABLE_RELABEL_TABLE_NAMES: Readonly<Record<ManagedTableRelabelTableKind, RelabelPlainText>> = Object.freeze({
  main: { zh: '备料主表', en: 'Stock preparation main table' },
  ledger: { zh: '备料确认账本', en: 'Confirmation ledger' },
  sandbox: { zh: '备料主表(沙箱)', en: 'Sandbox main table' },
})

export const MANAGED_TABLE_RELABEL_ENTITY_STATUS_TEXT: Readonly<Record<ManagedTableRelabelEntityStatus, RelabelPlainText>> = Object.freeze({
  would_rename: { zh: '将改成中文', en: 'Will be renamed' },
  renamed: { zh: '已改成中文', en: 'Renamed' },
  already_target: { zh: '已经是中文', en: 'Already in Chinese' },
  skipped_name_changed: { zh: '已被人改过名,保持不动', en: 'Renamed by someone already — left as is' },
  skipped_name_taken: { zh: '同表已有同名列,跳过以免重名', en: 'Another column already has this name — skipped' },
  missing: { zh: '这张表没有这一列', en: 'This table has no such column' },
})

export const MANAGED_TABLE_RELABEL_TABLE_STATUS_TEXT: Readonly<Record<Exclude<ManagedTableRelabelTableStatus, 'present'>, RelabelPlainText>> = Object.freeze({
  absent: { zh: '这套部署还没有这张表,无需处理', en: 'This deployment does not have this table — nothing to do' },
  scope_unavailable: {
    zh: '这张表不在本系统的登记里(可能是手工建的或从备份恢复的),为安全起见不动它',
    en: 'This table is not in the system registry (hand-made or restored from a backup), so it is left alone',
  },
})

export function relabelEntityStatusText(status: string): RelabelPlainText {
  return (MANAGED_TABLE_RELABEL_ENTITY_STATUS_TEXT as Record<string, RelabelPlainText>)[status] ?? { zh: status, en: status }
}

export function relabelTableStatusText(status: string): RelabelPlainText | null {
  if (status === 'present') return null
  return (MANAGED_TABLE_RELABEL_TABLE_STATUS_TEXT as Record<string, RelabelPlainText>)[status] ?? { zh: status, en: status }
}

/** The failure sentence for a refused call — by HTTP status and code, never by server message. */
export function relabelFailureText(error: unknown): RelabelPlainText {
  const status = error instanceof ManagedTableRelabelError ? error.status : 0
  const code = error instanceof ManagedTableRelabelError ? error.code : null
  if (code === 'TENANT_CLAIM_REQUIRED' || code === 'TENANT_MISMATCH') {
    return {
      zh: '当前登录没有带上所属租户,无法确定要改哪一套表。请重新登录后再试。',
      en: 'Your sign-in does not carry a tenant, so the tables to rename cannot be determined. Sign in again and retry.',
    }
  }
  if (status === 403) return { zh: '只有备料管理员可以执行这一步。', en: 'Only a stock-preparation admin can do this.' }
  if (status === 501) {
    return { zh: '服务器版本过旧,还不支持这一步,需要先升级。', en: 'The server is too old for this step and needs upgrading first.' }
  }
  // Honest about partial progress: each table is its own transaction, so a failure on the second
  // table leaves the first one's renames committed. Re-running is safe (compare-and-set), and a fresh
  // preview shows exactly where things stand.
  return {
    zh: '操作没有全部完成。已经改好的列不会被重复改动,可以重新预览查看当前状态后再试。',
    en: 'The operation did not fully complete. Columns already renamed are never renamed twice — preview again to see where things stand, then retry.',
  }
}
