import { db } from '../db/db';
import { metrics } from '../metrics/metrics';
export async function getViewById(viewId) {
    if (!db)
        return null;
    try {
        return await db.selectFrom('views').selectAll().where('id', '=', viewId).executeTakeFirst();
    }
    catch {
        return null;
    }
}
export async function getViewConfig(viewId) {
    const view = await getViewById(viewId);
    if (!view)
        return null;
    return {
        id: view.id,
        name: view.name,
        type: view.type,
        createdAt: view.created_at,
        updatedAt: view.updated_at,
        ...(view.config || {})
    };
}
export async function updateViewConfig(viewId, config) {
    if (!db)
        return null;
    const { id: _id, name, type, description, createdAt, updatedAt, createdBy, ...configData } = config || {};
    const updated = await db
        .updateTable('views')
        .set({ name, type, config: configData })
        .where('id', '=', viewId)
        .returningAll()
        .executeTakeFirst();
    return updated || null;
}
function observe(type, status, startNs) {
    try {
        const dur = Number((process.hrtime.bigint() - startNs)) / 1e9;
        metrics.viewDataLatencySeconds.labels(type, String(status)).observe(dur);
    }
    catch { }
}
export async function queryGrid(args) {
    const start = process.hrtime.bigint();
    try {
        const tableId = args.view.table_id;
        const page = Math.max(1, Number(args.page) || 1);
        const pageSize = Math.min(200, Math.max(1, Number(args.pageSize) || 50));
        const offset = (page - 1) * pageSize;
        if (!db || !tableId) {
            const result = { data: [], meta: { total: 0, page, pageSize, hasMore: false } };
            try {
                metrics.viewDataRequestsTotal.labels('grid', 'ok').inc();
            }
            catch { }
            observe('grid', '200', start);
            return result;
        }
        // MVP: basic page reads without filters/sorting (to be added next)
        const rows = await db
            .selectFrom('table_rows')
            .select(['id', 'data', 'created_at', 'updated_at'])
            .where('table_id', '=', tableId)
            .orderBy('created_at desc')
            .limit(pageSize)
            .offset(offset)
            .execute();
        const totalObj = await db
            .selectFrom('table_rows')
            .select((eb) => eb.fn.countAll().as('c'))
            .where('table_id', '=', tableId)
            .executeTakeFirst();
        const total = totalObj ? Number(totalObj.c) : 0;
        const result = { data: rows, meta: { total, page, pageSize, hasMore: offset + rows.length < total } };
        try {
            metrics.viewDataRequestsTotal.labels('grid', 'ok').inc();
        }
        catch { }
        observe('grid', '200', start);
        return result;
    }
    catch (e) {
        try {
            metrics.viewDataRequestsTotal.labels('grid', 'error').inc();
        }
        catch { }
        observe('grid', '500', start);
        throw e;
    }
}
export async function queryKanban(args) {
    const start = process.hrtime.bigint();
    try {
        const page = Math.max(1, Number(args.page) || 1);
        const pageSize = Math.min(200, Math.max(1, Number(args.pageSize) || 50));
        const result = { groups: [], groupBy: args.view?.config?.groupBy || 'status', meta: { total: 0, page, pageSize, hasMore: false } };
        try {
            metrics.viewDataRequestsTotal.labels('kanban', 'ok').inc();
        }
        catch { }
        observe('kanban', '200', start);
        return result;
    }
    catch (e) {
        try {
            metrics.viewDataRequestsTotal.labels('kanban', 'error').inc();
        }
        catch { }
        observe('kanban', '500', start);
        throw e;
    }
}
//# sourceMappingURL=view-service.js.map