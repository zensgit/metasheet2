"use strict";
/**
 * Gantt Event Handlers
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GanttEventHandlers = void 0;
class GanttEventHandlers {
    context;
    plugin;
    constructor(context, plugin) {
        this.context = context;
        this.plugin = plugin;
    }
    /**
     * Handle view update events
     */
    async handleViewUpdate(data) {
        try {
            if (data.type === 'gantt') {
                const { viewId } = data;
                // Sync gantt data when view is updated
                await this.plugin.syncGanttData(viewId);
                // Broadcast update to all connected clients
                this.context.api.websocket.broadcast(`gantt:${viewId}`, 'gantt:viewUpdated', {
                    viewId,
                    timestamp: new Date().toISOString()
                });
                this.context.logger.info(`Gantt view ${viewId} updated`);
            }
        }
        catch (error) {
            this.context.logger.error('Error handling view update:', error);
        }
    }
    /**
     * Handle task created events
     */
    async handleTaskCreated(data) {
        try {
            const { viewId, task } = data;
            this.context.logger.info(`Task created in gantt view ${viewId}: ${task.name}`);
            // Automatically recalculate critical path if enabled
            const viewConfig = await this.getViewConfig(viewId);
            if (viewConfig?.autoCalculateCriticalPath) {
                const criticalPath = await this.plugin.calculateCriticalPath(viewId);
                // Broadcast critical path update
                this.context.api.websocket.broadcast(`gantt:${viewId}`, 'gantt:criticalPathUpdated', {
                    viewId,
                    criticalPath,
                    triggeredBy: 'taskCreated',
                    timestamp: new Date().toISOString()
                });
            }
            // Auto-schedule dependent tasks if enabled
            if (viewConfig?.autoSchedule) {
                await this.autoScheduleDependentTasks(viewId, task.id);
            }
            // Check for resource conflicts
            await this.checkResourceConflicts(viewId, task.id);
        }
        catch (error) {
            this.context.logger.error('Error handling task created:', error);
        }
    }
    /**
     * Handle task updated events
     */
    async handleTaskUpdated(data) {
        try {
            const { viewId, taskId, updates } = data;
            this.context.logger.info(`Task updated in gantt view ${viewId}: ${taskId}`);
            // If dates were changed, recalculate dependent tasks
            if (updates.startDate || updates.endDate) {
                const viewConfig = await this.getViewConfig(viewId);
                // Auto-schedule dependent tasks if enabled
                if (viewConfig?.autoSchedule) {
                    await this.autoScheduleDependentTasks(viewId, taskId);
                }
                // Recalculate critical path if enabled
                if (viewConfig?.autoCalculateCriticalPath) {
                    const criticalPath = await this.plugin.calculateCriticalPath(viewId);
                    // Broadcast critical path update
                    this.context.api.websocket.broadcast(`gantt:${viewId}`, 'gantt:criticalPathUpdated', {
                        viewId,
                        criticalPath,
                        triggeredBy: 'taskUpdated',
                        timestamp: new Date().toISOString()
                    });
                }
                // Check for resource conflicts
                await this.checkResourceConflicts(viewId, taskId);
            }
            // If progress was updated, check for milestone completion
            if (updates.progress !== undefined) {
                await this.checkMilestoneCompletion(viewId, taskId, updates.progress);
            }
        }
        catch (error) {
            this.context.logger.error('Error handling task updated:', error);
        }
    }
    /**
     * Handle task deleted events
     */
    async handleTaskDeleted(data) {
        try {
            const { viewId, taskId } = data;
            this.context.logger.info(`Task deleted from gantt view ${viewId}: ${taskId}`);
            // Recalculate critical path after task deletion
            const viewConfig = await this.getViewConfig(viewId);
            if (viewConfig?.autoCalculateCriticalPath) {
                const criticalPath = await this.plugin.calculateCriticalPath(viewId);
                // Broadcast critical path update
                this.context.api.websocket.broadcast(`gantt:${viewId}`, 'gantt:criticalPathUpdated', {
                    viewId,
                    criticalPath,
                    triggeredBy: 'taskDeleted',
                    timestamp: new Date().toISOString()
                });
            }
            // Auto-schedule remaining tasks if enabled
            if (viewConfig?.autoSchedule) {
                await this.rescheduleAllTasks(viewId);
            }
        }
        catch (error) {
            this.context.logger.error('Error handling task deleted:', error);
        }
    }
    /**
     * Handle dependency created events
     */
    async handleDependencyCreated(data) {
        try {
            const { viewId, dependency } = data;
            this.context.logger.info(`Dependency created in gantt view ${viewId}: ${dependency.sourceTaskId} -> ${dependency.targetTaskId}`);
            const viewConfig = await this.getViewConfig(viewId);
            // Auto-schedule dependent tasks if enabled
            if (viewConfig?.autoSchedule) {
                await this.autoScheduleDependentTasks(viewId, dependency.sourceTaskId);
            }
            // Recalculate critical path if enabled
            if (viewConfig?.autoCalculateCriticalPath) {
                const criticalPath = await this.plugin.calculateCriticalPath(viewId);
                // Broadcast critical path update
                this.context.api.websocket.broadcast(`gantt:${viewId}`, 'gantt:criticalPathUpdated', {
                    viewId,
                    criticalPath,
                    triggeredBy: 'dependencyCreated',
                    timestamp: new Date().toISOString()
                });
            }
        }
        catch (error) {
            this.context.logger.error('Error handling dependency created:', error);
        }
    }
    /**
     * Handle dependency deleted events
     */
    async handleDependencyDeleted(data) {
        try {
            const { viewId, dependencyId } = data;
            this.context.logger.info(`Dependency deleted from gantt view ${viewId}: ${dependencyId}`);
            const viewConfig = await this.getViewConfig(viewId);
            // Recalculate critical path if enabled
            if (viewConfig?.autoCalculateCriticalPath) {
                const criticalPath = await this.plugin.calculateCriticalPath(viewId);
                // Broadcast critical path update
                this.context.api.websocket.broadcast(`gantt:${viewId}`, 'gantt:criticalPathUpdated', {
                    viewId,
                    criticalPath,
                    triggeredBy: 'dependencyDeleted',
                    timestamp: new Date().toISOString()
                });
            }
        }
        catch (error) {
            this.context.logger.error('Error handling dependency deleted:', error);
        }
    }
    /**
     * Get view configuration
     */
    async getViewConfig(viewId) {
        try {
            const result = await this.context.api.database.query('SELECT config FROM views WHERE id = $1', [viewId]);
            if (result.length > 0) {
                return result[0].config || {};
            }
            return {};
        }
        catch (error) {
            this.context.logger.error('Error getting view config:', error);
            return {};
        }
    }
    /**
     * Auto-schedule dependent tasks
     */
    async autoScheduleDependentTasks(viewId, sourceTaskId) {
        try {
            const ganttData = await this.plugin.getGanttData(viewId);
            const sourceTask = ganttData.tasks.find(t => t.id === sourceTaskId);
            if (!sourceTask)
                return;
            // Find all tasks that depend on this source task
            const dependentTaskIds = ganttData.dependencies
                .filter(dep => dep.sourceTaskId === sourceTaskId)
                .map(dep => dep.targetTaskId);
            for (const dependentTaskId of dependentTaskIds) {
                const dependentTask = ganttData.tasks.find(t => t.id === dependentTaskId);
                const dependency = ganttData.dependencies.find(dep => dep.sourceTaskId === sourceTaskId && dep.targetTaskId === dependentTaskId);
                if (!dependentTask || !dependency)
                    continue;
                // Calculate new start date based on dependency type
                let newStartDate;
                switch (dependency.type) {
                    case 'finish_to_start':
                        newStartDate = new Date(sourceTask.endDate.getTime() + dependency.lagDays * 24 * 60 * 60 * 1000);
                        break;
                    case 'start_to_start':
                        newStartDate = new Date(sourceTask.startDate.getTime() + dependency.lagDays * 24 * 60 * 60 * 1000);
                        break;
                    case 'finish_to_finish':
                        // Calculate based on finish date - task duration
                        const taskDuration = dependentTask.endDate.getTime() - dependentTask.startDate.getTime();
                        const finishDate = new Date(sourceTask.endDate.getTime() + dependency.lagDays * 24 * 60 * 60 * 1000);
                        newStartDate = new Date(finishDate.getTime() - taskDuration);
                        break;
                    case 'start_to_finish':
                        const dependentDuration = dependentTask.endDate.getTime() - dependentTask.startDate.getTime();
                        newStartDate = new Date(sourceTask.startDate.getTime() + dependency.lagDays * 24 * 60 * 60 * 1000 - dependentDuration);
                        break;
                    default:
                        continue;
                }
                // Update the dependent task if the calculated date is different
                if (newStartDate.getTime() !== dependentTask.startDate.getTime()) {
                    const duration = dependentTask.endDate.getTime() - dependentTask.startDate.getTime();
                    const newEndDate = new Date(newStartDate.getTime() + duration);
                    await this.plugin.updateTask(viewId, dependentTaskId, {
                        startDate: newStartDate,
                        endDate: newEndDate
                    });
                    // Recursively schedule tasks dependent on this one
                    await this.autoScheduleDependentTasks(viewId, dependentTaskId);
                }
            }
        }
        catch (error) {
            this.context.logger.error('Error auto-scheduling dependent tasks:', error);
        }
    }
    /**
     * Check for resource conflicts
     */
    async checkResourceConflicts(viewId, taskId) {
        try {
            const ganttData = await this.plugin.getGanttData(viewId);
            const task = ganttData.tasks.find(t => t.id === taskId);
            if (!task)
                return;
            // Find all resources assigned to this task
            const taskResources = ganttData.taskResources.filter(tr => tr.taskId === taskId);
            for (const taskResource of taskResources) {
                const resource = ganttData.resources.find(r => r.id === taskResource.resourceId);
                if (!resource)
                    continue;
                // Check for overlapping tasks using the same resource
                const overlappingTasks = await this.findOverlappingTasks(ganttData, task, taskResource.resourceId);
                if (overlappingTasks.length > 0) {
                    // Calculate total allocation for the overlapping period
                    const totalAllocation = overlappingTasks.reduce((sum, t) => {
                        const tr = ganttData.taskResources.find(tr => tr.taskId === t.id && tr.resourceId === taskResource.resourceId);
                        return sum + (tr?.allocationPercent || 0);
                    }, 0) + taskResource.allocationPercent;
                    if (totalAllocation > resource.capacity) {
                        // Emit resource conflict warning
                        this.context.api.websocket.broadcast(`gantt:${viewId}`, 'gantt:resourceConflict', {
                            viewId,
                            resourceId: resource.id,
                            resourceName: resource.name,
                            conflictingTasks: [task.id, ...overlappingTasks.map(t => t.id)],
                            totalAllocation,
                            capacity: resource.capacity,
                            overallocation: totalAllocation - resource.capacity,
                            timestamp: new Date().toISOString()
                        });
                        this.context.logger.warn(`Resource conflict detected in gantt view ${viewId}: Resource ${resource.name} overallocated by ${totalAllocation - resource.capacity}%`);
                    }
                }
            }
        }
        catch (error) {
            this.context.logger.error('Error checking resource conflicts:', error);
        }
    }
    /**
     * Find tasks that overlap with the given task and use the same resource
     */
    async findOverlappingTasks(ganttData, task, resourceId) {
        const overlappingTasks = [];
        for (const otherTask of ganttData.tasks) {
            if (otherTask.id === task.id)
                continue;
            // Check if other task uses the same resource
            const hasResource = ganttData.taskResources.some(tr => tr.taskId === otherTask.id && tr.resourceId === resourceId);
            if (!hasResource)
                continue;
            // Check for date overlap
            const taskStart = new Date(task.startDate);
            const taskEnd = new Date(task.endDate);
            const otherStart = new Date(otherTask.startDate);
            const otherEnd = new Date(otherTask.endDate);
            const hasOverlap = taskStart < otherEnd && taskEnd > otherStart;
            if (hasOverlap) {
                overlappingTasks.push(otherTask);
            }
        }
        return overlappingTasks;
    }
    /**
     * Check for milestone completion
     */
    async checkMilestoneCompletion(viewId, taskId, progress) {
        try {
            const ganttData = await this.plugin.getGanttData(viewId);
            const task = ganttData.tasks.find(t => t.id === taskId);
            if (!task || !task.isMilestone)
                return;
            // Milestone is considered completed when progress reaches 100%
            if (progress >= 100 && task.status !== 'completed') {
                await this.plugin.updateTask(viewId, taskId, {
                    status: 'completed'
                });
                // Emit milestone completion event
                this.context.api.websocket.broadcast(`gantt:${viewId}`, 'gantt:milestoneCompleted', {
                    viewId,
                    milestoneId: taskId,
                    milestoneName: task.name,
                    completedAt: new Date().toISOString()
                });
                this.context.logger.info(`Milestone completed in gantt view ${viewId}: ${task.name}`);
            }
        }
        catch (error) {
            this.context.logger.error('Error checking milestone completion:', error);
        }
    }
    /**
     * Reschedule all tasks in the view
     */
    async rescheduleAllTasks(viewId) {
        try {
            const ganttData = await this.plugin.getGanttData(viewId);
            // Find all root tasks (tasks with no dependencies)
            const rootTasks = ganttData.tasks.filter(task => !ganttData.dependencies.some(dep => dep.targetTaskId === task.id));
            // Schedule each root task and its dependents
            for (const rootTask of rootTasks) {
                await this.autoScheduleDependentTasks(viewId, rootTask.id);
            }
            this.context.logger.info(`Rescheduled all tasks in gantt view ${viewId}`);
        }
        catch (error) {
            this.context.logger.error('Error rescheduling all tasks:', error);
        }
    }
}
exports.GanttEventHandlers = GanttEventHandlers;
//# sourceMappingURL=handlers.js.map