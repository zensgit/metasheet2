"use strict";
/**
 * Views API routes
 * Handles gallery and form view configurations, data loading, and form submissions
 *
 * Phase 3: RBAC Integration
 * - Uses ViewService RBAC-aware methods for permission-controlled operations
 * - Controlled by FEATURE_TABLE_RBAC_ENABLED flag
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../db/db");
const pg_1 = require("../db/pg");
const logger_1 = require("../core/logger");
const uuid_1 = require("uuid");
const viewService = __importStar(require("../services/view-service"));
const table_perms_1 = require("../rbac/table-perms");
const router = (0, express_1.Router)();
const logger = new logger_1.Logger('ViewsAPI');
// Helper function to get user ID from request
function getUserId(req) {
    // Extract from JWT token or dev header
    return req.headers['x-user-id'] || 'dev-user';
}
async function getViewById(viewId) {
    if (!db_1.db)
        return null;
    try {
        return await db_1.db.selectFrom('views').selectAll().where('id', '=', viewId).executeTakeFirst();
    }
    catch {
        return null;
    }
}
/**
 * GET /api/views/:viewId/config
 * Get view configuration
 * Phase 3: Uses ViewService for standardized config access
 */
router.get('/:viewId/config', async (req, res) => {
    try {
        const { viewId } = req.params;
        if (!db_1.db) {
            return res.status(503).json({
                success: false,
                error: 'Database not available'
            });
        }
        const view = await getViewById(viewId);
        if (!view) {
            return res.status(404).json({ success: false, error: 'View not found' });
        }
        // Table-level RBAC
        const user = req.user || { id: getUserId(req), roles: req.user?.roles };
        const tableId = view.table_id;
        if (tableId && !(await (0, table_perms_1.canReadTable)(user, tableId))) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
        const config = {
            id: view.id,
            name: view.name,
            type: view.type,
            createdAt: view.created_at,
            updatedAt: view.updated_at,
            ...(view.config || {})
        };
        res.json({ success: true, data: config });
    }
    catch (error) {
        logger.error('Error loading view config:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to load view configuration'
        });
    }
});
/**
 * PUT /api/views/:viewId/config
 * Save view configuration
 * Phase 3: Uses ViewService RBAC-aware method for permission-controlled updates
 */
router.put('/:viewId/config', async (req, res) => {
    try {
        const { viewId } = req.params;
        const config = req.body;
        const user = getUser(req);
        if (!db_1.db) {
            return res.status(503).json({
                success: false,
                error: 'Database not available'
            });
        }
        // Table-level RBAC + update
        const current = await viewService.getViewById(viewId);
        if (!current)
            return res.status(404).json({ success: false, error: 'View not found' });
        const current = await getViewById(viewId);
        if (!current)
            return res.status(404).json({ success: false, error: 'View not found' });
        {
            const tableId = current.table_id;
            const user = req.user || { id: userId, roles: req.user?.roles };
            if (tableId && !(await (0, table_perms_1.canWriteTable)(user, tableId))) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }
        const current = await getViewById(viewId);
        if (!current)
            return res.status(404).json({ success: false, error: 'View not found' });
        {
            const tableId = current.table_id;
            const user = req.user || { id: userId, roles: req.user?.roles };
            if (tableId && !(await (0, table_perms_1.canWriteTable)(user, tableId))) {
                return res.status(403).json({ success: false, error: 'Forbidden' });
            }
        }
        const updated = await db_1.db
            .updateTable('views')
            .set({ name, type, config: configData })
            .where('id', '=', viewId)
            .returningAll()
            .executeTakeFirst();
        // Prefer RBAC-aware method if available
        const updated = await viewService.updateViewConfigWithRBAC?.(user, viewId, config)
            ?? await viewService.updateViewConfig(viewId, config);
        if (!updated)
            return res.status(404).json({ success: false, error: 'View not found' });
        res.json({ success: true, data: updated });
    }
    catch (error) {
        // Handle permission denied errors
        if (error instanceof Error && error.message.includes('Permission denied')) {
            logger.warn(`Permission denied for user ${getUser(req).id} updating view ${req.params.viewId}`);
            return res.status(403).json({
                success: false,
                error: 'Permission denied: You do not have write access to this view\'s table'
            });
        }
        logger.error('Error saving view config:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to save view configuration'
        });
    }
});
/**
 * GET /api/views/:viewId/data
 * Get view data with filtering, sorting, and pagination
 * Phase 3: Uses ViewService RBAC-aware query methods for permission-controlled data access
 */
router.get('/:viewId/data', async (req, res) => {
    try {
        const { viewId } = req.params;
        const { page = '1', pageSize = '50', filters = '{}', sorting = '[]' } = req.query;
        const user = getUser(req);
        const pageNum = parseInt(page, 10);
        const pageSizeNum = parseInt(pageSize, 10);
        const filtersObj = JSON.parse(filters);
        const sortingArr = JSON.parse(sorting);
        if (!db_1.db) {
            return res.status(503).json({
                success: false,
                data: [],
                meta: { total: 0, page: pageNum, pageSize: pageSizeNum, hasMore: false },
                error: 'Database not available'
            });
        }
        // Ensure view exists and check RBAC
        const view = await getViewById(viewId);
        if (!view) {
            return res.status(404).json({
                success: false,
                data: [],
                meta: { total: 0, page: pageNum, pageSize: pageSizeNum, hasMore: false },
                error: 'View not found'
            });
        }
        {
            const user = req.user || { id: getUserId(req), roles: req.user?.roles };
            const tableId = view.table_id;
            if (tableId && !(await (0, table_perms_1.canReadTable)(user, tableId))) {
                return res.status(403).json({ success: false, data: [], meta: { total: 0, page: pageNum, pageSize: pageSizeNum, hasMore: false }, error: 'Forbidden' });
            }
        }
        {
            const user = req.user || { id: getUserId(req), roles: req.user?.roles };
            const tableId = view.table_id;
            if (tableId && !(await (0, table_perms_1.canReadTable)(user, tableId))) {
                return res.status(403).json({ success: false, data: [], meta: { total: 0, page: pageNum, pageSize: pageSizeNum, hasMore: false }, error: 'Forbidden' });
            }
        }
        // Delegate to ViewService based on view type
        const vtype = view.type;
        if (vtype === 'grid') {
            const r = await viewService.queryGrid({ view, page: pageNum, pageSize: pageSizeNum, filters: filtersObj, sorting: sortingArr });
            return res.json({ success: true, ...r });
        }
        else if (vtype === 'kanban') {
            const r = await viewService.queryKanban({ view, page: pageNum, pageSize: pageSizeNum, filters: filtersObj });
            return res.json({ success: true, ...r });
        }
        else {
            return res.status(501).json({ success: false, error: 'Not implemented' });
        }
    }
    catch (error) {
        // Handle permission denied errors
        if (error instanceof Error && error.message.includes('Permission denied')) {
            logger.warn(`Permission denied for user ${getUser(req).id} accessing view ${req.params.viewId} data`);
            return res.status(403).json({
                success: false,
                data: [],
                meta: { total: 0, page: parseInt(req.query.page || '1', 10), pageSize: parseInt(req.query.pageSize || '50', 10), hasMore: false },
                error: 'Permission denied: You do not have read access to this view\'s table'
            });
        }
        logger.error('Error loading view data:', error);
        res.status(500).json({
            success: false,
            data: [],
            meta: { total: 0, page: 1, pageSize: 50, hasMore: false },
            error: 'Failed to load view data'
        });
    }
});
/**
 * GET /api/views/:viewId/state
 * GET user's view state (filters, sorting, etc.)
 */
router.get('/:viewId/state', async (req, res) => {
    try {
        const { viewId } = req.params;
        const userId = getUserId(req);
        if (!db_1.db) {
            return res.status(404).json({});
        }
        const row = await db_1.db
            .selectFrom('view_states')
            .select(['state'])
            .where('view_id', '=', viewId)
            .where('user_id', '=', userId)
            .executeTakeFirst();
        if (!row) {
            return res.status(404).json({});
        }
        res.json(row.state);
    }
    catch (error) {
        logger.error('Error loading view state:', error);
        res.status(404).json({});
    }
});
/**
 * POST /api/views/:viewId/state
 * Save user's view state
 */
router.post('/:viewId/state', async (req, res) => {
    try {
        const { viewId } = req.params;
        const state = req.body;
        const userId = getUserId(req);
        if (!db_1.db) {
            return res.status(503).json({
                success: false,
                error: 'Database not available'
            });
        }
        await (0, pg_1.query)(`INSERT INTO view_states (view_id, user_id, state, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (view_id, user_id)
       DO UPDATE SET state = $3, updated_at = NOW()`, [viewId, userId, JSON.stringify(state)]);
        res.status(204).send();
    }
    catch (error) {
        logger.error('Error saving view state:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to save view state'
        });
    }
});
/**
 * POST /api/views
 * Create a new view
 */
router.post('/', async (req, res) => {
    try {
        const { tableId, type, name, description, ...configData } = req.body;
        const user = req.user || { id: getUserId(req), roles: req.user?.roles };
        const viewId = (0, uuid_1.v4)();
        if (!db_1.db) {
            return res.status(503).json({
                success: false,
                error: 'Database not available'
            });
        }
        if (!tableId)
            return res.status(400).json({ success: false, error: 'tableId required' });
        if (!(await (0, table_perms_1.canWriteTable)(user, String(tableId))))
            return res.status(403).json({ success: false, error: 'Forbidden' });
        const inserted = await db_1.db
            .insertInto('views')
            .values({ id: viewId, table_id: String(tableId), name, type, config: configData, created_at: new Date(), updated_at: new Date() })
            .returningAll()
            .executeTakeFirst();
        res.status(201).json({ success: true, data: inserted });
    }
    catch (error) {
        logger.error('Error creating view:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create view'
        });
    }
});
/**
 * DELETE /api/views/:viewId
 * Delete a view (soft delete)
 */
router.delete('/:viewId', async (req, res) => {
    try {
        const { viewId } = req.params;
        const user = req.user || { id: getUserId(req), roles: req.user?.roles };
        if (!db_1.db) {
            return res.status(503).json({ success: false, error: 'Database not available' });
        }
        const current = await getViewById(viewId);
        if (!current)
            return res.status(404).json({ success: false, error: 'View not found' });
        const tableId = current.table_id;
        if (tableId && !(await (0, table_perms_1.canWriteTable)(user, tableId))) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
        }
        const del = await db_1.db.deleteFrom('views').where('id', '=', viewId).executeTakeFirst();
        const affected = del?.numDeletedRows ? Number(del.numDeletedRows) : 1;
        if (!affected) {
            return res.status(404).json({ success: false, error: 'View not found or access denied' });
        }
        res.json({ success: true });
    }
    catch (error) {
        logger.error('Error deleting view:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to delete view'
        });
    }
});
/**
 * POST /api/views/:viewId/submit
 * Submit a form
 */
router.post('/:viewId/submit', async (req, res) => {
    try {
        const { viewId } = req.params;
        const { data } = req.body;
        const userId = getUserId(req);
        const responseId = (0, uuid_1.v4)();
        if (!db_1.db) {
            return res.status(503).json({
                success: false,
                error: 'Database not available'
            });
        }
        // Verify view exists and is a form
        const viewResult = await db_1.db.query('SELECT * FROM view_configs WHERE id = $1 AND type = $2 AND deleted_at IS NULL', [viewId, 'form']);
        if (viewResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                error: 'Form not found'
            });
        }
        const view = viewResult.rows[0];
        const config = JSON.parse(view.config_data || '{}');
        // Check if authentication is required
        if (config.settings?.requireAuth && !userId) {
            return res.status(401).json({
                success: false,
                error: 'Authentication required'
            });
        }
        // Get client info
        const ipAddress = req.ip || req.connection.remoteAddress;
        const userAgent = req.headers['user-agent'];
        // Save form response
        await db_1.db.query(`INSERT INTO form_responses (id, form_id, response_data, submitted_by, ip_address, user_agent, submitted_at, status)
       VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'submitted')`, [responseId, viewId, JSON.stringify(data), userId, ipAddress, userAgent]);
        res.json({
            success: true,
            data: {
                id: responseId,
                message: 'Form submitted successfully'
            }
        });
    }
    catch (error) {
        logger.error('Error submitting form:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to submit form'
        });
    }
});
/**
 * GET /api/views/:viewId/responses
 * Get form responses (admin only)
 */
router.get('/:viewId/responses', async (req, res) => {
    try {
        const { viewId } = req.params;
        const { page = '1', pageSize = '20' } = req.query;
        const userId = getUserId(req);
        const pageNum = parseInt(page, 10);
        const pageSizeNum = parseInt(pageSize, 10);
        const offset = (pageNum - 1) * pageSizeNum;
        if (!db_1.db) {
            return res.status(503).json({
                success: false,
                data: [],
                meta: { total: 0, page: pageNum, pageSize: pageSizeNum, hasMore: false },
                error: 'Database not available'
            });
        }
        // Verify user has access to view responses (form creator)
        const viewResult = await db_1.db.query('SELECT * FROM view_configs WHERE id = $1 AND created_by = $2 AND deleted_at IS NULL', [viewId, userId]);
        if (viewResult.rows.length === 0) {
            return res.status(403).json({
                success: false,
                data: [],
                meta: { total: 0, page: pageNum, pageSize: pageSizeNum, hasMore: false },
                error: 'Access denied'
            });
        }
        // Get total count
        const countResult = await db_1.db.query('SELECT COUNT(*) FROM form_responses WHERE form_id = $1', [viewId]);
        const total = parseInt(countResult.rows[0].count, 10);
        // Get responses
        const responsesResult = await db_1.db.query(`SELECT id, response_data, submitted_by, ip_address, submitted_at, status
       FROM form_responses
       WHERE form_id = $1
       ORDER BY submitted_at DESC
       LIMIT $2 OFFSET $3`, [viewId, pageSizeNum, offset]);
        const responses = responsesResult.rows.map(row => ({
            id: row.id,
            formId: viewId,
            data: JSON.parse(row.response_data || '{}'),
            submittedAt: row.submitted_at,
            submittedBy: row.submitted_by,
            ipAddress: row.ip_address,
            status: row.status
        }));
        const hasMore = offset + pageSizeNum < total;
        res.json({
            success: true,
            data: responses,
            meta: {
                total,
                page: pageNum,
                pageSize: pageSizeNum,
                hasMore
            }
        });
    }
    catch (error) {
        logger.error('Error loading form responses:', error);
        res.status(500).json({
            success: false,
            data: [],
            meta: { total: 0, page: 1, pageSize: 20, hasMore: false },
            error: 'Failed to load form responses'
        });
    }
});
/**
 * POST /api/views/gallery
 * Create a gallery view
 */
router.post('/gallery', async (req, res) => {
    try {
        const config = req.body;
        const user = req.user || { id: getUserId(req), roles: req.user?.roles };
        const viewId = (0, uuid_1.v4)();
        if (!db_1.db) {
            return res.status(503).json({
                success: false,
                error: 'Database not available'
            });
        }
        if (!config.tableId)
            return res.status(400).json({ success: false, error: 'tableId required' });
        if (!(await (0, table_perms_1.canWriteTable)(user, String(config.tableId))))
            return res.status(403).json({ success: false, error: 'Forbidden' });
        const inserted = await db_1.db
            .insertInto('views')
            .values({ id: viewId, table_id: String(config.tableId), name: config.name, type: 'gallery', config: config, created_at: new Date(), updated_at: new Date() })
            .returningAll()
            .executeTakeFirst();
        res.status(201).json({ success: true, data: inserted });
    }
    catch (error) {
        logger.error('Error creating gallery view:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create gallery view'
        });
    }
});
/**
 * POST /api/views/form
 * Create a form view
 */
router.post('/form', async (req, res) => {
    try {
        const config = req.body;
        const user = req.user || { id: getUserId(req), roles: req.user?.roles };
        const viewId = (0, uuid_1.v4)();
        if (!db_1.db) {
            return res.status(503).json({
                success: false,
                error: 'Database not available'
            });
        }
        if (!config.tableId)
            return res.status(400).json({ success: false, error: 'tableId required' });
        if (!(await (0, table_perms_1.canWriteTable)(user, String(config.tableId))))
            return res.status(403).json({ success: false, error: 'Forbidden' });
        const inserted = await db_1.db
            .insertInto('views')
            .values({ id: viewId, table_id: String(config.tableId), name: config.name, type: 'form', config: config, created_at: new Date(), updated_at: new Date() })
            .returningAll()
            .executeTakeFirst();
        res.status(201).json({ success: true, data: inserted });
    }
    catch (error) {
        logger.error('Error creating form view:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create form view'
        });
    }
});
exports.default = router;
//# sourceMappingURL=views.js.map