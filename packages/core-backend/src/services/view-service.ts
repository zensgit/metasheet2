import { db } from '../db/db'
import { metrics } from '../metrics/metrics'
import { canReadTable, canWriteTable, type User } from '../rbac/table-perms'
import { isFeatureEnabled } from '../config/flags'

// Type definitions for view-related data structures
// ViewRow represents the SELECT return type from views table
export interface ViewRow {
  id: string
  table_id: string
  name: string
  type: 'grid' | 'kanban' | 'calendar' | 'gallery' | 'form' | 'gantt'
  config: Record<string, unknown> | null
  filters: Record<string, unknown> | null
  sort_order: number
  is_default: boolean
  created_by: string
  created_at: Date
  updated_at: Date
}

export interface ViewConfig {
  id: string
  name: string
  type: 'grid' | 'kanban' | 'gantt' | 'form' | 'calendar' | 'gallery'
  createdAt: Date | string
  updatedAt: Date | string
  [key: string]: unknown // For additional config properties
}

export interface UpdateViewConfigInput {
  id?: string
  name?: string
  type?: 'grid' | 'kanban' | 'gantt' | 'form' | 'calendar' | 'gallery'
  description?: string
  createdAt?: Date | string
  updatedAt?: Date | string
  createdBy?: string
  [key: string]: unknown // For additional config properties
}

export interface ViewFilters {
  [key: string]: unknown
}

export interface ViewSorting {
  [key: string]: unknown
}

export interface TableRowData {
  id: string
  data: unknown
  created_at: Date | string
  updated_at: Date | string
}

export interface GridQueryResult {
  data: TableRowData[]
  meta: {
    total: number
    page: number
    pageSize: number
    hasMore: boolean
  }
}

export interface KanbanGroup {
  [key: string]: unknown
}

export interface KanbanQueryResult {
  groups: KanbanGroup[]
  groupBy: string
  meta: {
    total: number
    page: number
    pageSize: number
    hasMore: boolean
  }
}

export async function getViewById(viewId: string): Promise<ViewRow | null> {
  if (!db) return null
  try {
    const result = await db.selectFrom('views').selectAll().where('id', '=', viewId).executeTakeFirst()
    return (result as ViewRow | undefined) ?? null
  } catch {
    return null
  }
}

export async function getViewConfig(viewId: string): Promise<ViewConfig | null> {
  const view = await getViewById(viewId)
  if (!view) return null

  const config = (view.config as Record<string, unknown>) || {}

  // Convert Generated types to their runtime values through unknown
  const createdAt = view.created_at as unknown as Date | string
  const updatedAt = view.updated_at as unknown as Date | string

  return {
    id: String(view.id),
    name: view.name,
    type: view.type,
    createdAt,
    updatedAt,
    ...config
  }
}

export async function updateViewConfig(viewId: string, config: UpdateViewConfigInput): Promise<ViewRow | null> {
  if (!db) return null
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { id: _id, name, type, description: _description, createdAt: _createdAt, updatedAt: _updatedAt, createdBy: _createdBy, ...configData } = config || {}
  const updated = await db
    .updateTable('views')
    .set({ name, type, config: JSON.stringify(configData) })
    .where('id', '=', viewId)
    .returningAll()
    .executeTakeFirst()
  return updated as ViewRow | undefined ?? null
}

function observe(type: 'grid' | 'kanban', status: string, startNs: bigint) {
  try {
    const dur = Number((process.hrtime.bigint() - startNs)) / 1e9
    metrics.viewDataLatencySeconds.labels(type, String(status)).observe(dur)
  } catch { /* metrics unavailable */ }
}

interface GridQueryArgs {
  view: ViewRow
  page: number
  pageSize: number
  filters: ViewFilters
  sorting: ViewSorting
}

export async function queryGrid(args: GridQueryArgs): Promise<GridQueryResult> {
  const start = process.hrtime.bigint()
  try {
    const tableId = args.view.table_id
    const page = Math.max(1, Number(args.page) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(args.pageSize) || 50))
    const offset = (page - 1) * pageSize

    if (!db || !tableId) {
      const result: GridQueryResult = {
        data: [],
        meta: { total: 0, page, pageSize, hasMore: false }
      }
      try { metrics.viewDataRequestsTotal.labels('grid', 'ok').inc() } catch { /* metrics unavailable */ }
      observe('grid', '200', start)
      return result
    }

    // MVP: basic page reads without filters/sorting (to be added next)
    const rows = await db
      .selectFrom('table_rows')
      .select(['id','data','created_at','updated_at'])
      .where('table_id','=', tableId)
      .orderBy('created_at desc')
      .limit(pageSize)
      .offset(offset)
      .execute()

    const totalObj = await db
      .selectFrom('table_rows')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .select((eb: any) => eb.fn.countAll().as('c'))
      .where('table_id','=', tableId)
      .executeTakeFirst()
    const total = totalObj ? Number((totalObj as { c: string | number }).c) : 0

    const result: GridQueryResult = {
      data: rows as TableRowData[],
      meta: { total, page, pageSize, hasMore: offset + rows.length < total }
    }
    try { metrics.viewDataRequestsTotal.labels('grid', 'ok').inc() } catch { /* metrics unavailable */ }
    observe('grid', '200', start)
    return result
  } catch (e) {
    try { metrics.viewDataRequestsTotal.labels('grid', 'error').inc() } catch { /* metrics unavailable */ }
    observe('grid', '500', start)
    throw e
  }
}

interface KanbanQueryArgs {
  view: ViewRow
  page: number
  pageSize: number
  filters: ViewFilters
}

export async function queryKanban(args: KanbanQueryArgs): Promise<KanbanQueryResult> {
  const start = process.hrtime.bigint()
  try {
    const page = Math.max(1, Number(args.page) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(args.pageSize) || 50))

    const viewConfig = (args.view.config as Record<string, unknown>) || {}
    const groupBy = (viewConfig.groupBy as string) || 'status'

    const result: KanbanQueryResult = {
      groups: [],
      groupBy,
      meta: { total: 0, page, pageSize, hasMore: false }
    }
    try { metrics.viewDataRequestsTotal.labels('kanban', 'ok').inc() } catch { /* metrics unavailable */ }
    observe('kanban', '200', start)
    return result
  } catch (e) {
    try { metrics.viewDataRequestsTotal.labels('kanban', 'error').inc() } catch { /* metrics unavailable */ }
    observe('kanban', '500', start)
    throw e
  }
}

// RBAC wrapper functions

export async function queryGridWithRBAC(
  user: User,
  args: GridQueryArgs
) {
  if (isFeatureEnabled('FEATURE_TABLE_RBAC_ENABLED')) {
    const tableId = args.view?.table_id
    if (tableId) {
      const allowed = await canReadTable(user, tableId)
      if (!allowed) {
        throw new Error('Permission denied')
      }
    }
  }
  return queryGrid(args)
}

export async function queryKanbanWithRBAC(
  user: User,
  args: KanbanQueryArgs
) {
  if (isFeatureEnabled('FEATURE_TABLE_RBAC_ENABLED')) {
    const tableId = args.view?.table_id
    if (tableId) {
      const allowed = await canReadTable(user, tableId)
      if (!allowed) {
        throw new Error('Permission denied')
      }
    }
  }
  return queryKanban(args)
}

export async function updateViewConfigWithRBAC(
  user: User,
  viewId: string,
  config: UpdateViewConfigInput
) {
  const view = await getViewById(viewId)
  if (!view) {
    throw new Error(`View ${viewId} not found`)
  }

  if (isFeatureEnabled('FEATURE_TABLE_RBAC_ENABLED')) {
    const tableId = view?.table_id
    if (tableId) {
      const allowed = await canWriteTable(user, tableId)
      if (!allowed) {
        throw new Error('Permission denied')
      }
    }
  }
  return updateViewConfig(viewId, config)
}
