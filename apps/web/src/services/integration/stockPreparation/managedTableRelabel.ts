// 「把系统表的英文表头改成中文」 — the browser half of the managed-table relabel (客户反馈 2026-09-24 #4a).
//
// ONE ROUTE, TWO CALLS. The same POST answers both: `{}` is the dry run (the server evaluates the
// compare-and-set plan, writes NOTHING, and answers a `planDigest`), `{ apply: true, planDigest }`
// executes EXACTLY that preview — the server recomputes the plan and refuses if it moved. So the page
// always shows the plan first, and 「确认执行」 can only ever confirm the plan on screen.
//
// THE WRITE IS DEFAULT OFF ON THE SERVER. The dry run reports `applyEnabled`; while it is false the
// page shows why (the operator must turn on the server switch named in `enableWith`) instead of a
// confirm button that would be refused.
//
// THE BODY CARRIES AT MOST `apply` + `planDigest` — AND NO QUERY STRING AT ALL. The tables, the target
// names and the tenant are all server-derived (the tenant from the verified token claim), and the
// route refuses any other body key and any query key with a 400. So this module deliberately does not
// take the workbench scope: there is nothing a caller could legitimately steer.
//
// VALUES-FREE BY CONSTRUCTION. The server's plan carries logical field ids, status codes, digests and
// the template's own English/Chinese label pair — never a column's current (possibly hand-typed)
// name. On failure only the HTTP status and the error CODE are kept; the server message is not.
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

export type ManagedTableRelabelTableKind = 'main' | 'ledger' | 'sandbox' | 'mvp'

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
  label?: string
  status: ManagedTableRelabelTableStatus
  sheetName: ManagedTableRelabelEntity | null
  fields: ManagedTableRelabelField[]
  counts: Record<ManagedTableRelabelEntityStatus, number>
  revisionCount: number
}

export interface ManagedTableRelabelOutOfScope {
  objectId: string
  label: string
}

export interface ManagedTableRelabelPlan {
  mode: 'dry_run' | 'apply'
  locale: string
  applyEnabled: boolean
  enableWith: string
  planDigest: string
  tables: ManagedTableRelabelTable[]
  totals: Record<ManagedTableRelabelEntityStatus, number>
  revisionCount: number
  hasPendingRenames: boolean
  outOfScope: ManagedTableRelabelOutOfScope[]
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

/** The DRY RUN — what would change, and the digest that binds a later apply to it. Writes nothing. */
export function planManagedTableRelabel(): Promise<ManagedTableRelabelPlan> {
  return call({})
}

/** EXECUTE exactly the previewed plan — compare-and-set on the server, one config-history row per rename. */
export function applyManagedTableRelabel(planDigest: string): Promise<ManagedTableRelabelPlan> {
  return call({ apply: true, planDigest })
}

// ---------------------------------------------------------------------------
// Plain language. Keyed by the SERVER's closed vocabulary; an unknown token renders as itself.
// ---------------------------------------------------------------------------

export interface RelabelPlainText {
  zh: string
  en: string
}

export const MANAGED_TABLE_RELABEL_TABLE_NAMES: Readonly<Record<Exclude<ManagedTableRelabelTableKind, 'mvp'>, RelabelPlainText>> = Object.freeze({
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

// A SHEET-name clash is not a column clash: another TABLE in the same base (or another table of this
// same plan) already carries — or is about to carry — the name.
export const MANAGED_TABLE_RELABEL_SHEET_STATUS_OVERRIDES: Readonly<Partial<Record<ManagedTableRelabelEntityStatus, RelabelPlainText>>> = Object.freeze({
  skipped_name_taken: {
    zh: '同一个库里已有(或本次将有)同名的表,跳过以免两张表重名',
    en: 'Another table in the same base has (or is about to get) this name — skipped',
  },
  skipped_name_changed: { zh: '表名已被人改过,保持不动', en: 'The table was renamed by someone already — left as is' },
})

export const MANAGED_TABLE_RELABEL_TABLE_STATUS_TEXT: Readonly<Record<Exclude<ManagedTableRelabelTableStatus, 'present'>, RelabelPlainText>> = Object.freeze({
  absent: {
    zh: '在您当前登录的租户下没有找到这张表(本工具只处理当前租户的备料系统表)。如果您确定这张表存在,请联系运维核对。',
    en: 'This table was not found under the tenant you are signed in to (this tool only handles the current tenant\'s stock-prep system tables). If you are sure it exists, ask your operator to check.',
  },
  scope_unavailable: {
    zh: '这张表不在本系统的登记里(可能是手工建的或从备份恢复的),为安全起见不动它',
    en: 'This table is not in the system registry (hand-made or restored from a backup), so it is left alone',
  },
})

export function relabelEntityStatusText(status: string, entity: 'field' | 'sheet' = 'field'): RelabelPlainText {
  if (entity === 'sheet') {
    const override = (MANAGED_TABLE_RELABEL_SHEET_STATUS_OVERRIDES as Record<string, RelabelPlainText | undefined>)[status]
    if (override) return override
  }
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
  if (code === 'MANAGED_TABLE_RELABEL_APPLY_DISABLED') {
    return {
      zh: '服务器上的改名开关没有打开,没有改动任何表头。请运维打开开关后,重新预览再执行。',
      en: 'The rename switch is off on the server; no header was changed. Ask your operator to turn it on, then preview again.',
    }
  }
  if (code === 'MANAGED_TABLE_RELABEL_PLAN_CHANGED') {
    return {
      zh: '预览之后表头有了变化,为免改错已停止。请重新预览,确认新的计划后再执行。',
      en: 'The headers changed after the preview, so nothing further was changed. Preview again and confirm the new plan.',
    }
  }
  if (code === 'RECOVERY_IN_PROGRESS' || code === 'MANAGED_TABLE_RELABEL_CONCURRENT_CHANGE') {
    return {
      zh: '这张表正被其他操作占用,本次没有改动它。请稍后重新预览再试。',
      en: 'The table was busy with another operation and was not changed this time. Preview again shortly and retry.',
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
    zh: '操作没有全部完成。已经改好的列不会被重复改动,请重新预览查看当前状态后再试。',
    en: 'The operation did not fully complete. Columns already renamed are never renamed twice — preview again to see where things stand, then retry.',
  }
}
