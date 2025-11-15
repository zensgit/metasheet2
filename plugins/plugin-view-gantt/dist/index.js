"use strict";
/**
 * 甘特图视图插件 (Simplified Version)
 */
Object.defineProperty(exports, "__esModule", { value: true });
class GanttPlugin {
    context;
    ganttData = new Map();
    /**
     * 插件激活
     */
    async activate(context) {
        this.context = context;
        // Register basic API routes
        this.registerRoutes();
        context.logger.info('Gantt plugin activated successfully');
    }
    /**
     * 插件停用
     */
    async deactivate() {
        this.ganttData.clear();
        this.context.logger.info('Gantt plugin deactivated');
    }
    /**
     * 注册API路由
     */
    registerRoutes() {
        const { api } = this.context;
        // Get gantt data for a view
        api.http.addRoute('GET', '/api/gantt/:viewId', async (req, res) => {
            try {
                const { viewId } = req.params;
                const ganttData = await this.getGanttData(viewId);
                res.json({ success: true, data: ganttData });
            }
            catch (error) {
                this.context.logger.error('Error getting gantt data:', error);
                res.status(500).json({ success: false, error: error?.message || 'Internal error' });
            }
        });
        // Create task
        api.http.addRoute('POST', '/api/gantt/:viewId/tasks', async (req, res) => {
            try {
                const { viewId } = req.params;
                const userId = req.user?.id || 'test-user';
                const taskData = req.body;
                if (!taskData.name || !taskData.startDate || !taskData.endDate) {
                    return res.status(400).json({
                        success: false,
                        error: 'Missing required fields: name, startDate, endDate'
                    });
                }
                taskData.createdBy = userId;
                const task = await this.createTask(viewId, taskData);
                res.status(201).json({ success: true, data: task });
            }
            catch (error) {
                this.context.logger.error('Error creating task:', error);
                res.status(500).json({ success: false, error: error?.message || 'Internal error' });
            }
        });
        // Update task
        api.http.addRoute('PUT', '/api/gantt/:viewId/tasks/:taskId', async (req, res) => {
            try {
                const { viewId, taskId } = req.params;
                const updates = req.body;
                await this.updateTask(viewId, taskId, updates);
                res.json({ success: true });
            }
            catch (error) {
                this.context.logger.error('Error updating task:', error);
                res.status(500).json({ success: false, error: error?.message || 'Internal error' });
            }
        });
        // Delete task
        api.http.addRoute('DELETE', '/api/gantt/:viewId/tasks/:taskId', async (req, res) => {
            try {
                const { viewId, taskId } = req.params;
                await this.deleteTask(viewId, taskId);
                res.json({ success: true });
            }
            catch (error) {
                this.context.logger.error('Error deleting task:', error);
                res.status(500).json({ success: false, error: error?.message || 'Internal error' });
            }
        });
        this.context.logger.info('Gantt routes registered');
    }
    /**
     * Get gantt data for a view
     */
    async getGanttData(viewId) {
        if (this.ganttData.has(viewId)) {
            return this.ganttData.get(viewId);
        }
        const data = await this.loadGanttDataFromDatabase(viewId);
        this.ganttData.set(viewId, data);
        return data;
    }
    /**
     * Load gantt data from database
     */
    async loadGanttDataFromDatabase(viewId) {
        const { api } = this.context;
        // Load tasks
        const tasksQuery = `
      SELECT * FROM gantt_tasks
      WHERE view_id = $1
      ORDER BY order_index ASC
    `;
        const tasks = await api.database.query(tasksQuery, [viewId]);
        // Load dependencies
        const dependenciesQuery = `
      SELECT * FROM gantt_dependencies
      WHERE source_task_id IN (
        SELECT id FROM gantt_tasks WHERE view_id = $1
      )
    `;
        const dependencies = await api.database.query(dependenciesQuery, [viewId]);
        return {
            tasks: tasks,
            dependencies: dependencies,
            timeline: this.calculateTimeline(tasks)
        };
    }
    /**
     * Calculate project timeline
     */
    calculateTimeline(tasks) {
        if (tasks.length === 0) {
            const now = new Date();
            return {
                startDate: now,
                endDate: now,
                workingDays: [1, 2, 3, 4, 5],
                hoursPerDay: 8
            };
        }
        const startDates = tasks.map(t => new Date(t.startDate));
        const endDates = tasks.map(t => new Date(t.endDate));
        return {
            startDate: new Date(Math.min(...startDates.map(d => d.getTime()))),
            endDate: new Date(Math.max(...endDates.map(d => d.getTime()))),
            workingDays: [1, 2, 3, 4, 5],
            hoursPerDay: 8
        };
    }
    /**
     * Create a new task
     */
    async createTask(viewId, taskData) {
        const { api } = this.context;
        const query = `
      INSERT INTO gantt_tasks (
        view_id, name, description, start_date, end_date,
        progress, status, created_by
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8
      ) RETURNING *
    `;
        const values = [
            viewId,
            taskData.name,
            taskData.description,
            taskData.startDate,
            taskData.endDate,
            taskData.progress || 0,
            taskData.status || 'not_started',
            taskData.createdBy
        ];
        const result = await api.database.query(query, values);
        const task = result[0];
        // Update cache
        await this.syncGanttData(viewId);
        return task;
    }
    /**
     * Update a task
     */
    async updateTask(viewId, taskId, updates) {
        const { api } = this.context;
        const fields = [];
        const values = [];
        let index = 1;
        Object.entries(updates).forEach(([key, value]) => {
            if (value !== undefined && key !== 'id' && key !== 'viewId' && key !== 'createdAt' && key !== 'createdBy') {
                fields.push(`${this.camelToSnake(key)} = $${index++}`);
                values.push(value);
            }
        });
        if (fields.length === 0)
            return;
        fields.push(`updated_at = NOW()`);
        values.push(taskId, viewId);
        const query = `
      UPDATE gantt_tasks
      SET ${fields.join(', ')}
      WHERE id = $${index} AND view_id = $${index + 1}
    `;
        await api.database.query(query, values);
        await this.syncGanttData(viewId);
    }
    /**
     * Delete a task
     */
    async deleteTask(viewId, taskId) {
        const { api } = this.context;
        await api.database.query('DELETE FROM gantt_tasks WHERE id = $1 AND view_id = $2', [taskId, viewId]);
        await this.syncGanttData(viewId);
    }
    /**
     * Sync gantt data (clear cache and reload)
     */
    async syncGanttData(viewId) {
        this.ganttData.delete(viewId);
        await this.getGanttData(viewId);
    }
    /**
     * Convert camelCase to snake_case
     */
    camelToSnake(str) {
        return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    }
}
exports.default = GanttPlugin;
//# sourceMappingURL=index.js.map