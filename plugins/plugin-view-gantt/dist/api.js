"use strict";
/**
 * Gantt API Handlers
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GanttAPIHandler = void 0;
class GanttAPIHandler {
    context;
    plugin;
    constructor(context, plugin) {
        this.context = context;
        this.plugin = plugin;
    }
    /**
     * Get gantt data for a view
     */
    async getGanttData(req, res) {
        try {
            const { viewId } = req.params;
            const userId = req.user?.id || req.headers['x-user-id'] || 'test-user';
            // Check if user has permission to view this gantt chart
            if (!(await this.checkViewPermission(viewId, userId, 'read'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            const ganttData = await this.plugin.getGanttData(viewId);
            // Calculate ETag for caching
            const etag = Buffer.from(JSON.stringify(ganttData)).toString('base64');
            if (req.headers['if-none-match'] === etag) {
                res.status(304).end();
                return;
            }
            res.setHeader('ETag', etag);
            res.json({ success: true, data: ganttData });
        }
        catch (error) {
            this.context.logger.error('Error getting gantt data:', error);
            res.status(500).json({ success: false, error: error?.message || 'Internal error' });
        }
    }
    /**
     * Create a new task
     */
    async createTask(req, res) {
        try {
            const { viewId } = req.params;
            const userId = req.user?.id || req.headers['x-user-id'] || 'test-user';
            const taskData = req.body;
            // Check permissions
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            // Validate required fields
            if (!taskData.name || !taskData.startDate || !taskData.endDate) {
                res.status(400).json({
                    success: false,
                    error: 'Missing required fields: name, startDate, endDate'
                });
                return;
            }
            // Validate date range
            const startDate = new Date(taskData.startDate);
            const endDate = new Date(taskData.endDate);
            if (startDate >= endDate) {
                res.status(400).json({
                    success: false,
                    error: 'Start date must be before end date'
                });
                return;
            }
            // Set created by
            taskData.createdBy = userId;
            const task = await this.plugin.createTask(viewId, taskData);
            // Broadcast update
            this.context.api.websocket.broadcast('gantt:taskCreated', {
                viewId,
                task
            });
            res.status(201).json({ success: true, data: task });
        }
        catch (error) {
            this.context.logger.error('Error creating task:', error);
            res.status(500).json({ success: false, error: error?.message || 'Internal error' });
        }
    }
    /**
     * Update a task
     */
    async updateTask(req, res) {
        try {
            const { viewId, taskId } = req.params;
            const userId = req.user?.id || req.headers['x-user-id'] || 'test-user';
            const updates = req.body;
            // Check permissions
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            // Validate date range if dates are being updated
            if (updates.startDate || updates.endDate) {
                const currentData = await this.plugin.getGanttData(viewId);
                const currentTask = currentData.tasks.find(t => t.id === taskId);
                if (!currentTask) {
                    res.status(404).json({ success: false, error: 'Task not found' });
                    return;
                }
                const startDate = new Date(updates.startDate || currentTask.startDate);
                const endDate = new Date(updates.endDate || currentTask.endDate);
                if (startDate >= endDate) {
                    res.status(400).json({
                        success: false,
                        error: 'Start date must be before end date'
                    });
                    return;
                }
            }
            await this.plugin.updateTask(viewId, taskId, updates);
            // Broadcast update
            this.context.api.websocket.broadcast('gantt:taskUpdated', {
                viewId,
                taskId,
                updates
            });
            res.json({ success: true });
        }
        catch (error) {
            this.context.logger.error('Error updating task:', error);
            res.status(500).json({ success: false, error: error?.message || 'Internal error' });
        }
    }
    /**
     * Delete a task
     */
    async deleteTask(req, res) {
        try {
            const { viewId, taskId } = req.params;
            const userId = req.user?.id || req.headers['x-user-id'] || 'test-user';
            // Check permissions
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            await this.plugin.deleteTask(viewId, taskId);
            // Broadcast update
            this.context.api.websocket.broadcast('gantt:taskDeleted', {
                viewId,
                taskId
            });
            res.json({ success: true });
        }
        catch (error) {
            this.context.logger.error('Error deleting task:', error);
            res.status(500).json({ success: false, error: error?.message || 'Internal error' });
        }
    }
    /**
     * Create a dependency
     */
    async createDependency(req, res) {
        try {
            const { viewId } = req.params;
            const userId = req.user?.id || req.headers['x-user-id'] || 'test-user';
            const dependencyData = req.body;
            // Check permissions
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            // Validate required fields
            if (!dependencyData.sourceTaskId || !dependencyData.targetTaskId) {
                res.status(400).json({
                    success: false,
                    error: 'Missing required fields: sourceTaskId, targetTaskId'
                });
                return;
            }
            // Check for self-dependency
            if (dependencyData.sourceTaskId === dependencyData.targetTaskId) {
                res.status(400).json({
                    success: false,
                    error: 'Task cannot depend on itself'
                });
                return;
            }
            // Check for circular dependencies
            if (await this.wouldCreateCircularDependency(viewId, dependencyData.sourceTaskId, dependencyData.targetTaskId)) {
                res.status(400).json({
                    success: false,
                    error: 'This dependency would create a circular reference'
                });
                return;
            }
            const dependency = await this.plugin.createDependency(viewId, dependencyData);
            // Broadcast update
            this.context.api.websocket.broadcast('gantt:dependencyCreated', {
                viewId,
                dependency
            });
            res.status(201).json({ success: true, data: dependency });
        }
        catch (error) {
            this.context.logger.error('Error creating dependency:', error);
            res.status(500).json({ success: false, error: error?.message || 'Internal error' });
        }
    }
    /**
     * Delete a dependency
     */
    async deleteDependency(req, res) {
        try {
            const { viewId, dependencyId } = req.params;
            const userId = req.user?.id || req.headers['x-user-id'] || 'test-user';
            // Check permissions
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            await this.context.api.database.query('DELETE FROM gantt_dependencies WHERE id = $1', [dependencyId]);
            // Update cache
            await this.plugin.syncGanttData(viewId);
            // Broadcast update
            this.context.api.websocket.broadcast('gantt:dependencyDeleted', {
                viewId,
                dependencyId
            });
            res.json({ success: true });
        }
        catch (error) {
            this.context.logger.error('Error deleting dependency:', error);
            res.status(500).json({ success: false, error: error?.message || 'Internal error' });
        }
    }
    /**
     * Calculate critical path
     */
    async calculateCriticalPath(req, res) {
        try {
            const { viewId } = req.params;
            const userId = req.user?.id || req.headers['x-user-id'] || 'test-user';
            // Check permissions
            if (!(await this.checkViewPermission(viewId, userId, 'read'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            const criticalPath = await this.plugin.calculateCriticalPath(viewId);
            res.json({ success: true, data: criticalPath });
        }
        catch (error) {
            this.context.logger.error('Error calculating critical path:', error);
            res.status(500).json({ success: false, error: error?.message || 'Internal error' });
        }
    }
    /**
     * Get resources for a view
     */
    async getResources(req, res) {
        try {
            const { viewId } = req.params;
            const userId = req.user?.id || req.headers['x-user-id'] || 'test-user';
            // Check permissions
            if (!(await this.checkViewPermission(viewId, userId, 'read'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            const ganttData = await this.plugin.getGanttData(viewId);
            res.json({ success: true, data: ganttData.resources });
        }
        catch (error) {
            this.context.logger.error('Error getting resources:', error);
            res.status(500).json({ success: false, error: error?.message || 'Internal error' });
        }
    }
    /**
     * Create a resource
     */
    async createResource(req, res) {
        try {
            const { viewId } = req.params;
            const userId = req.user?.id || req.headers['x-user-id'] || 'test-user';
            const resourceData = req.body;
            // Check permissions
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            // Validate required fields
            if (!resourceData.name || !resourceData.type) {
                res.status(400).json({
                    success: false,
                    error: 'Missing required fields: name, type'
                });
                return;
            }
            const query = `
        INSERT INTO gantt_resources (view_id, name, type, capacity, cost_per_hour)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *
      `;
            const values = [
                viewId,
                resourceData.name,
                resourceData.type,
                resourceData.capacity || 100,
                resourceData.costPerHour
            ];
            const result = await this.context.api.database.query(query, values);
            const resource = result[0];
            // Update cache
            await this.plugin.syncGanttData(viewId);
            res.status(201).json({ success: true, data: resource });
        }
        catch (error) {
            this.context.logger.error('Error creating resource:', error);
            res.status(500).json({ success: false, error: error?.message || 'Internal error' });
        }
    }
    /**
     * Update a resource
     */
    async updateResource(req, res) {
        try {
            const { viewId, resourceId } = req.params;
            const userId = req.user?.id || req.headers['x-user-id'] || 'test-user';
            const updates = req.body;
            // Check permissions
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            const fields = [];
            const values = [];
            let index = 1;
            Object.entries(updates).forEach(([key, value]) => {
                if (value !== undefined && key !== 'id' && key !== 'viewId' && key !== 'createdAt') {
                    fields.push(`${this.camelToSnake(key)} = $${index++}`);
                    values.push(value);
                }
            });
            if (fields.length === 0) {
                res.json({ success: true });
                return;
            }
            fields.push(`updated_at = NOW()`);
            values.push(resourceId, viewId);
            const query = `
        UPDATE gantt_resources
        SET ${fields.join(', ')}
        WHERE id = $${index} AND view_id = $${index + 1}
      `;
            await this.context.api.database.query(query, values);
            // Update cache
            await this.plugin.syncGanttData(viewId);
            res.json({ success: true });
        }
        catch (error) {
            this.context.logger.error('Error updating resource:', error);
            res.status(500).json({ success: false, error: error?.message || 'Internal error' });
        }
    }
    /**
     * Delete a resource
     */
    async deleteResource(req, res) {
        try {
            const { viewId, resourceId } = req.params;
            const userId = req.user?.id || req.headers['x-user-id'] || 'test-user';
            // Check permissions
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            await this.context.api.database.query('DELETE FROM gantt_resources WHERE id = $1 AND view_id = $2', [resourceId, viewId]);
            // Update cache
            await this.plugin.syncGanttData(viewId);
            res.json({ success: true });
        }
        catch (error) {
            this.context.logger.error('Error deleting resource:', error);
            res.status(500).json({ success: false, error: error?.message || 'Internal error' });
        }
    }
    /**
     * Assign resource to task
     */
    async assignResource(req, res) {
        try {
            const { viewId, taskId } = req.params;
            const userId = req.user?.id || req.headers['x-user-id'] || 'test-user';
            const { resourceId, allocationPercent } = req.body;
            // Check permissions
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            const query = `
        INSERT INTO gantt_task_resources (task_id, resource_id, allocation_percent)
        VALUES ($1, $2, $3)
        ON CONFLICT (task_id, resource_id)
        DO UPDATE SET allocation_percent = EXCLUDED.allocation_percent
        RETURNING *
      `;
            const values = [taskId, resourceId, allocationPercent || 100];
            const result = await this.context.api.database.query(query, values);
            // Update cache
            await this.plugin.syncGanttData(viewId);
            res.json({ success: true, data: result[0] });
        }
        catch (error) {
            this.context.logger.error('Error assigning resource:', error);
            res.status(500).json({ success: false, error: error?.message || 'Internal error' });
        }
    }
    /**
     * Unassign resource from task
     */
    async unassignResource(req, res) {
        try {
            const { viewId, taskId, resourceId } = req.params;
            const userId = req.user?.id || req.headers['x-user-id'] || 'test-user';
            // Check permissions
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            await this.context.api.database.query('DELETE FROM gantt_task_resources WHERE task_id = $1 AND resource_id = $2', [taskId, resourceId]);
            // Update cache
            await this.plugin.syncGanttData(viewId);
            res.json({ success: true });
        }
        catch (error) {
            this.context.logger.error('Error unassigning resource:', error);
            res.status(500).json({ success: false, error: error?.message || 'Internal error' });
        }
    }
    /**
     * Export project data
     */
    async exportProject(req, res) {
        try {
            const { viewId } = req.params;
            const userId = req.user?.id || req.headers['x-user-id'] || 'test-user';
            const format = req.query.format || 'json';
            // Check permissions
            if (!(await this.checkViewPermission(viewId, userId, 'read'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            const ganttData = await this.plugin.getGanttData(viewId);
            const criticalPath = await this.plugin.calculateCriticalPath(viewId);
            const exportData = {
                ...ganttData,
                criticalPath,
                exportedAt: new Date().toISOString(),
                exportedBy: userId
            };
            switch (format.toLowerCase()) {
                case 'json':
                    res.setHeader('Content-Type', 'application/json');
                    res.setHeader('Content-Disposition', `attachment; filename="gantt-${viewId}.json"`);
                    res.json(exportData);
                    break;
                default:
                    res.status(400).json({
                        success: false,
                        error: 'Unsupported format. Supported formats: json'
                    });
            }
        }
        catch (error) {
            this.context.logger.error('Error exporting project:', error);
            res.status(500).json({ success: false, error: error?.message || 'Internal error' });
        }
    }
    /**
     * Check if user has permission to access view
     */
    async checkViewPermission(viewId, userId, action) {
        try {
            // For MVP, allow all access
            // In production, implement proper permission checking
            return true;
            // Example implementation:
            // const result = await this.context.api.database.query(
            //   'SELECT * FROM view_permissions WHERE view_id = $1 AND user_id = $2',
            //   [viewId, userId]
            // )
            //
            // return result.length > 0 && result[0][action] === true
        }
        catch (error) {
            this.context.logger.error('Error checking view permission:', error);
            return false;
        }
    }
    /**
     * Check if creating a dependency would cause a circular reference
     */
    async wouldCreateCircularDependency(viewId, sourceTaskId, targetTaskId) {
        try {
            const ganttData = await this.plugin.getGanttData(viewId);
            const dependencies = ganttData.dependencies;
            // Simple cycle detection using DFS
            const visited = new Set();
            const recursionStack = new Set();
            const hasCycle = (taskId) => {
                if (recursionStack.has(taskId))
                    return true;
                if (visited.has(taskId))
                    return false;
                visited.add(taskId);
                recursionStack.add(taskId);
                // Get all tasks that depend on this task
                const dependents = dependencies
                    .filter(dep => dep.sourceTaskId === taskId)
                    .map(dep => dep.targetTaskId);
                // Add the new dependency we're about to create
                if (taskId === sourceTaskId) {
                    dependents.push(targetTaskId);
                }
                for (const dependentId of dependents) {
                    if (hasCycle(dependentId)) {
                        return true;
                    }
                }
                recursionStack.delete(taskId);
                return false;
            };
            return hasCycle(sourceTaskId);
        }
        catch (error) {
            this.context.logger.error('Error checking circular dependency:', error);
            return true; // Assume circular to be safe
        }
    }
    /**
     * Convert camelCase to snake_case
     */
    camelToSnake(str) {
        return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    }
}
exports.GanttAPIHandler = GanttAPIHandler;
//# sourceMappingURL=api.js.map