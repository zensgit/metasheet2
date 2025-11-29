// @ts-nocheck
import { db } from '../db/db'
import { metrics } from '../metrics/metrics'
import { canReadTable, canWriteTable, type User } from '../rbac/table-perms'
import { isFeatureEnabled } from '../config/flags'

export type ViewRow = any

export async function getViewById(viewId: string): Promise<ViewRow | null> {
  if (!db) return null
  try {
    const result = await db.selectFrom('views').selectAll().where('id', '=', viewId).executeTakeFirst()
    return result ?? null
  } catch {
    return null
  }
}

export async function getViewConfig(viewId: string) {
  const view = await getViewById(viewId)
  if (!view) return null
  return {
    id: (view as any).id,
    name: (view as any).name,
    type: (view as any).type,
    createdAt: (view as any).created_at,
    updatedAt: (view as any).updated_at,
    ...((view as any).config || {})
  }
}

export async function updateViewConfig(viewId: string, config: any) {
  if (!db) return null
  const { id: _id, name, type, description, createdAt, updatedAt, createdBy, ...configData } = config || {}
  const updated = await db
    .updateTable('views')
    .set({ name, type, config: configData as any })
    .where('id', '=', viewId)
    .returningAll()
    .executeTakeFirst()
  return updated || null
}

function observe(type: 'grid' | 'kanban', status: string, startNs: bigint) {
  try {
    const dur = Number((process.hrtime.bigint() - startNs)) / 1e9
    metrics.viewDataLatencySeconds.labels(type, String(status)).observe(dur)
  } catch {}
}

export async function queryGrid(args: { view: ViewRow; page: number; pageSize: number; filters: any; sorting: any }) {
  const start = process.hrtime.bigint()
  try {
    const tableId = (args.view as any).table_id as string | undefined
    const page = Math.max(1, Number(args.page) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(args.pageSize) || 50))
    const offset = (page - 1) * pageSize

    if (!db || !tableId) {
      const result = { data: [] as any[], meta: { total: 0, page, pageSize, hasMore: false } }
      try { metrics.viewDataRequestsTotal.labels('grid', 'ok').inc() } catch {}
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
      .select((eb: any) => eb.fn.countAll().as('c'))
      .where('table_id','=', tableId)
      .executeTakeFirst()
    const total = totalObj ? Number((totalObj as any).c) : 0

    const result = { data: rows as any[], meta: { total, page, pageSize, hasMore: offset + (rows as any[]).length < total } }
    try { metrics.viewDataRequestsTotal.labels('grid', 'ok').inc() } catch {}
    observe('grid', '200', start)
    return result
  } catch (e) {
    try { metrics.viewDataRequestsTotal.labels('grid', 'error').inc() } catch {}
    observe('grid', '500', start)
    throw e
  }
}

export async function queryKanban(args: { view: ViewRow; page: number; pageSize: number; filters: any }) {
  const start = process.hrtime.bigint()
  try {
    const page = Math.max(1, Number(args.page) || 1)
    const pageSize = Math.min(200, Math.max(1, Number(args.pageSize) || 50))
    const result = { groups: [] as any[], groupBy: (args.view as any)?.config?.groupBy || 'status', meta: { total: 0, page, pageSize, hasMore: false } }
    try { metrics.viewDataRequestsTotal.labels('kanban', 'ok').inc() } catch {}
    observe('kanban', '200', start)
    return result as any
  } catch (e) {
    try { metrics.viewDataRequestsTotal.labels('kanban', 'error').inc() } catch {}
    observe('kanban', '500', start)
    throw e
  }
}

// RBAC wrapper functions

export async function queryGridWithRBAC(
  user: User,
  args: { view: ViewRow; page: number; pageSize: number; filters: any; sorting: any }
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
  args: { view: ViewRow; page: number; pageSize: number; filters: any }
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
  config: any
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
