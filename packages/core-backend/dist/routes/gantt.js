/**
 * Gantt Chart API Routes
 * Direct integration routes for gantt functionality
 */
import { Router } from 'express';
const router = Router();
/**
 * GET /api/gantt/:viewId
 * Get gantt data for a specific view
 */
router.get('/:viewId', async (req, res) => {
    try {
        const { viewId } = req.params;
        const db = req.db;
        // Get tasks
        const tasks = await db
            .selectFrom('gantt_tasks')
            .selectAll()
            .where('view_id', '=', viewId)
            .orderBy(['parent_id', 'order_index'])
            .execute();
        // Get dependencies
        const dependencies = await db
            .selectFrom('gantt_dependencies')
            .selectAll()
            .innerJoin('gantt_tasks as source', 'gantt_dependencies.source_task_id', 'source.id')
            .where('source.view_id', '=', viewId)
            .execute();
        const ganttData = {
            tasks: tasks.map(transformTask),
            dependencies: dependencies.map(transformDependency),
            timeline: calculateTimeline(tasks)
        };
        res.json({
            success: true,
            data: ganttData
        });
    }
    catch (error) {
        console.error('Error getting gantt data:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
});
/**
 * POST /api/gantt/:viewId/tasks
 * Create a new task
 */
router.post('/:viewId/tasks', async (req, res) => {
    try {
        const { viewId } = req.params;
        const userId = req.user?.id || 'test-user';
        const taskData = req.body;
        const db = req.db;
        // Validate required fields
        if (!taskData.name || !taskData.startDate || !taskData.endDate) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: name, startDate, endDate'
            });
        }
        // Create task
        const task = await db
            .insertInto('gantt_tasks')
            .values({
            view_id: viewId,
            name: taskData.name,
            description: taskData.description,
            start_date: new Date(taskData.startDate),
            end_date: new Date(taskData.endDate),
            progress: taskData.progress || 0,
            parent_id: taskData.parentId,
            order_index: taskData.orderIndex || 0,
            is_milestone: taskData.isMilestone || false,
            priority: taskData.priority,
            assigned_to: taskData.assignedTo,
            status: taskData.status || 'not_started',
            created_by: userId
        })
            .returningAll()
            .executeTakeFirst();
        res.status(201).json({
            success: true,
            data: transformTask(task)
        });
    }
    catch (error) {
        console.error('Error creating task:', error);
        res.status(500).json({
            success: false,
            error: error.message || 'Internal server error'
        });
    }
});
// Helper functions
function transformTask(task) {
    return {
        id: task.id,
        viewId: task.view_id,
        name: task.name,
        description: task.description,
        startDate: task.start_date,
        endDate: task.end_date,
        progress: task.progress,
        parentId: task.parent_id,
        orderIndex: task.order_index,
        isMilestone: task.is_milestone,
        priority: task.priority,
        assignedTo: task.assigned_to,
        status: task.status,
        createdBy: task.created_by,
        createdAt: task.created_at,
        updatedAt: task.updated_at
    };
}
function transformDependency(dependency) {
    return {
        id: dependency.id,
        sourceTaskId: dependency.source_task_id,
        targetTaskId: dependency.target_task_id,
        type: dependency.type,
        lagDays: dependency.lag_days,
        createdAt: dependency.created_at
    };
}
function calculateTimeline(tasks) {
    if (tasks.length === 0) {
        const now = new Date();
        return {
            startDate: now,
            endDate: now,
            workingDays: [1, 2, 3, 4, 5],
            hoursPerDay: 8
        };
    }
    const startDates = tasks.map(t => new Date(t.start_date));
    const endDates = tasks.map(t => new Date(t.end_date));
    return {
        startDate: new Date(Math.min(...startDates.map(d => d.getTime()))),
        endDate: new Date(Math.max(...endDates.map(d => d.getTime()))),
        workingDays: [1, 2, 3, 4, 5],
        hoursPerDay: 8
    };
}
export default router;
//# sourceMappingURL=gantt.js.map