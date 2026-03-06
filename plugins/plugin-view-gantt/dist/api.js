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
    async getGanttData(req, res) {
        try {
            const { viewId } = req.params;
            const userId = this.getUserId(req);
            if (!(await this.checkViewPermission(viewId, userId, 'read'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            const ganttData = await this.plugin.getGanttData(viewId);
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
            res.status(500).json({ success: false, error: this.toErrorMessage(error) });
        }
    }
    async createTask(req, res) {
        try {
            const { viewId } = req.params;
            const userId = this.getUserId(req);
            const taskData = req.body;
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            if (!taskData.name || !taskData.startDate || !taskData.endDate) {
                res.status(400).json({
                    success: false,
                    error: 'Missing required fields: name, startDate, endDate',
                });
                return;
            }
            const startDate = new Date(taskData.startDate);
            const endDate = new Date(taskData.endDate);
            if (startDate >= endDate) {
                res.status(400).json({
                    success: false,
                    error: 'Start date must be before end date',
                });
                return;
            }
            taskData.createdBy = userId;
            const task = await this.plugin.createTask(viewId, taskData);
            this.context.api.websocket.broadcast('gantt:taskCreated', {
                viewId,
                task,
            });
            res.status(201).json({ success: true, data: task });
        }
        catch (error) {
            this.context.logger.error('Error creating task:', error);
            res.status(500).json({ success: false, error: this.toErrorMessage(error) });
        }
    }
    async updateTask(req, res) {
        try {
            const { viewId, taskId } = req.params;
            const userId = this.getUserId(req);
            const updates = req.body;
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            if (updates.startDate || updates.endDate) {
                const currentData = await this.plugin.getGanttData(viewId);
                const currentTask = currentData.tasks.find((task) => task.id === taskId);
                if (!currentTask) {
                    res.status(404).json({ success: false, error: 'Task not found' });
                    return;
                }
                const startDate = new Date(updates.startDate ?? currentTask.startDate);
                const endDate = new Date(updates.endDate ?? currentTask.endDate);
                if (startDate >= endDate) {
                    res.status(400).json({
                        success: false,
                        error: 'Start date must be before end date',
                    });
                    return;
                }
            }
            await this.plugin.updateTask(viewId, taskId, updates);
            this.context.api.websocket.broadcast('gantt:taskUpdated', {
                viewId,
                taskId,
                updates,
            });
            res.json({ success: true });
        }
        catch (error) {
            this.context.logger.error('Error updating task:', error);
            res.status(500).json({ success: false, error: this.toErrorMessage(error) });
        }
    }
    async deleteTask(req, res) {
        try {
            const { viewId, taskId } = req.params;
            const userId = this.getUserId(req);
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            await this.plugin.deleteTask(viewId, taskId);
            this.context.api.websocket.broadcast('gantt:taskDeleted', {
                viewId,
                taskId,
            });
            res.json({ success: true });
        }
        catch (error) {
            this.context.logger.error('Error deleting task:', error);
            res.status(500).json({ success: false, error: this.toErrorMessage(error) });
        }
    }
    async createDependency(req, res) {
        try {
            const { viewId } = req.params;
            const userId = this.getUserId(req);
            const dependencyData = req.body;
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            if (!dependencyData.sourceTaskId || !dependencyData.targetTaskId) {
                res.status(400).json({
                    success: false,
                    error: 'Missing required fields: sourceTaskId, targetTaskId',
                });
                return;
            }
            if (dependencyData.sourceTaskId === dependencyData.targetTaskId) {
                res.status(400).json({
                    success: false,
                    error: 'Task cannot depend on itself',
                });
                return;
            }
            if (await this.wouldCreateCircularDependency(viewId, dependencyData.sourceTaskId, dependencyData.targetTaskId)) {
                res.status(400).json({
                    success: false,
                    error: 'This dependency would create a circular reference',
                });
                return;
            }
            const dependency = await this.plugin.createDependency(viewId, dependencyData);
            this.context.api.websocket.broadcast('gantt:dependencyCreated', {
                viewId,
                dependency,
            });
            res.status(201).json({ success: true, data: dependency });
        }
        catch (error) {
            this.context.logger.error('Error creating dependency:', error);
            res.status(500).json({ success: false, error: this.toErrorMessage(error) });
        }
    }
    async deleteDependency(req, res) {
        try {
            const { viewId, dependencyId } = req.params;
            const userId = this.getUserId(req);
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            await this.context.api.database.query('DELETE FROM gantt_dependencies WHERE id = $1', [dependencyId]);
            await this.plugin.syncGanttData(viewId);
            this.context.api.websocket.broadcast('gantt:dependencyDeleted', {
                viewId,
                dependencyId,
            });
            res.json({ success: true });
        }
        catch (error) {
            this.context.logger.error('Error deleting dependency:', error);
            res.status(500).json({ success: false, error: this.toErrorMessage(error) });
        }
    }
    async calculateCriticalPath(req, res) {
        try {
            const { viewId } = req.params;
            const userId = this.getUserId(req);
            if (!(await this.checkViewPermission(viewId, userId, 'read'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            const criticalPath = await this.plugin.calculateCriticalPath(viewId);
            res.json({ success: true, data: criticalPath });
        }
        catch (error) {
            this.context.logger.error('Error calculating critical path:', error);
            res.status(500).json({ success: false, error: this.toErrorMessage(error) });
        }
    }
    async getResources(req, res) {
        try {
            const { viewId } = req.params;
            const userId = this.getUserId(req);
            if (!(await this.checkViewPermission(viewId, userId, 'read'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            const ganttData = await this.plugin.getGanttData(viewId);
            res.json({ success: true, data: ganttData.resources });
        }
        catch (error) {
            this.context.logger.error('Error getting resources:', error);
            res.status(500).json({ success: false, error: this.toErrorMessage(error) });
        }
    }
    async createResource(req, res) {
        try {
            const { viewId } = req.params;
            const userId = this.getUserId(req);
            const resourceData = req.body;
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            if (!resourceData.name || !resourceData.type) {
                res.status(400).json({
                    success: false,
                    error: 'Missing required fields: name, type',
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
                resourceData.capacity ?? 100,
                resourceData.costPerHour,
            ];
            const result = await this.context.api.database.query(query, values);
            const resource = result[0];
            await this.plugin.syncGanttData(viewId);
            res.status(201).json({ success: true, data: resource });
        }
        catch (error) {
            this.context.logger.error('Error creating resource:', error);
            res.status(500).json({ success: false, error: this.toErrorMessage(error) });
        }
    }
    async updateResource(req, res) {
        try {
            const { viewId, resourceId } = req.params;
            const userId = this.getUserId(req);
            const updates = req.body;
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            const fields = [];
            const values = [];
            let index = 1;
            Object.entries(updates).forEach(([key, value]) => {
                if (value !== undefined && key !== 'id' && key !== 'viewId' && key !== 'createdAt') {
                    fields.push(`${this.camelToSnake(key)} = $${index}`);
                    values.push(value);
                    index += 1;
                }
            });
            if (fields.length === 0) {
                res.json({ success: true });
                return;
            }
            fields.push('updated_at = NOW()');
            values.push(resourceId, viewId);
            const query = `
        UPDATE gantt_resources
        SET ${fields.join(', ')}
        WHERE id = $${index} AND view_id = $${index + 1}
      `;
            await this.context.api.database.query(query, values);
            await this.plugin.syncGanttData(viewId);
            res.json({ success: true });
        }
        catch (error) {
            this.context.logger.error('Error updating resource:', error);
            res.status(500).json({ success: false, error: this.toErrorMessage(error) });
        }
    }
    async deleteResource(req, res) {
        try {
            const { viewId, resourceId } = req.params;
            const userId = this.getUserId(req);
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            await this.context.api.database.query('DELETE FROM gantt_resources WHERE id = $1 AND view_id = $2', [resourceId, viewId]);
            await this.plugin.syncGanttData(viewId);
            res.json({ success: true });
        }
        catch (error) {
            this.context.logger.error('Error deleting resource:', error);
            res.status(500).json({ success: false, error: this.toErrorMessage(error) });
        }
    }
    async assignResource(req, res) {
        try {
            const { viewId, taskId } = req.params;
            const userId = this.getUserId(req);
            const { resourceId, allocationPercent } = req.body;
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
            const result = await this.context.api.database.query(query, [
                taskId,
                resourceId,
                allocationPercent ?? 100,
            ]);
            await this.plugin.syncGanttData(viewId);
            res.json({ success: true, data: result[0] });
        }
        catch (error) {
            this.context.logger.error('Error assigning resource:', error);
            res.status(500).json({ success: false, error: this.toErrorMessage(error) });
        }
    }
    async unassignResource(req, res) {
        try {
            const { viewId, taskId, resourceId } = req.params;
            const userId = this.getUserId(req);
            if (!(await this.checkViewPermission(viewId, userId, 'write'))) {
                res.status(403).json({ success: false, error: 'Access denied' });
                return;
            }
            await this.context.api.database.query('DELETE FROM gantt_task_resources WHERE task_id = $1 AND resource_id = $2', [taskId, resourceId]);
            await this.plugin.syncGanttData(viewId);
            res.json({ success: true });
        }
        catch (error) {
            this.context.logger.error('Error unassigning resource:', error);
            res.status(500).json({ success: false, error: this.toErrorMessage(error) });
        }
    }
    async exportProject(req, res) {
        try {
            const { viewId } = req.params;
            const userId = this.getUserId(req);
            const format = typeof req.query.format === 'string' ? req.query.format : 'json';
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
                exportedBy: userId,
            };
            if (format.toLowerCase() !== 'json') {
                res.status(400).json({
                    success: false,
                    error: 'Unsupported format. Supported formats: json',
                });
                return;
            }
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', `attachment; filename="gantt-${viewId}.json"`);
            res.json(exportData);
        }
        catch (error) {
            this.context.logger.error('Error exporting project:', error);
            res.status(500).json({ success: false, error: this.toErrorMessage(error) });
        }
    }
    async checkViewPermission(_viewId, _userId, _action) {
        return true;
    }
    async wouldCreateCircularDependency(viewId, sourceTaskId, targetTaskId) {
        try {
            const ganttData = await this.plugin.getGanttData(viewId);
            const dependencies = ganttData.dependencies;
            const visited = new Set();
            const recursionStack = new Set();
            const hasCycle = (taskId) => {
                if (recursionStack.has(taskId)) {
                    return true;
                }
                if (visited.has(taskId)) {
                    return false;
                }
                visited.add(taskId);
                recursionStack.add(taskId);
                const dependents = dependencies
                    .filter((dependency) => dependency.sourceTaskId === taskId)
                    .map((dependency) => dependency.targetTaskId);
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
            return true;
        }
    }
    getUserId(req) {
        const headerUserId = req.headers['x-user-id'];
        return req.user?.id ?? (typeof headerUserId === 'string' ? headerUserId : 'test-user');
    }
    toErrorMessage(error) {
        return error instanceof Error ? error.message : 'Internal error';
    }
    camelToSnake(str) {
        return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    }
}
exports.GanttAPIHandler = GanttAPIHandler;
//# sourceMappingURL=api.js.map