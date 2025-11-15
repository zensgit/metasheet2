/**
 * Gantt Event Handlers
 */
import type { PluginContext } from '@metasheet/core-backend/src/types/plugin';
import type GanttPlugin from './index';
export declare class GanttEventHandlers {
    private context;
    private plugin;
    constructor(context: PluginContext, plugin: GanttPlugin);
    /**
     * Handle view update events
     */
    handleViewUpdate(data: any): Promise<void>;
    /**
     * Handle task created events
     */
    handleTaskCreated(data: any): Promise<void>;
    /**
     * Handle task updated events
     */
    handleTaskUpdated(data: any): Promise<void>;
    /**
     * Handle task deleted events
     */
    handleTaskDeleted(data: any): Promise<void>;
    /**
     * Handle dependency created events
     */
    handleDependencyCreated(data: any): Promise<void>;
    /**
     * Handle dependency deleted events
     */
    handleDependencyDeleted(data: any): Promise<void>;
    /**
     * Get view configuration
     */
    private getViewConfig;
    /**
     * Auto-schedule dependent tasks
     */
    private autoScheduleDependentTasks;
    /**
     * Check for resource conflicts
     */
    private checkResourceConflicts;
    /**
     * Find tasks that overlap with the given task and use the same resource
     */
    private findOverlappingTasks;
    /**
     * Check for milestone completion
     */
    private checkMilestoneCompletion;
    /**
     * Reschedule all tasks in the view
     */
    private rescheduleAllTasks;
}
//# sourceMappingURL=handlers.d.ts.map