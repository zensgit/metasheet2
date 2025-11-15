/**
 * 甘特图视图插件 (Simplified Version)
 */
import type { PluginLifecycle, PluginContext } from '@metasheet/core-backend/src/types/plugin';
export interface GanttTask {
    id: string;
    viewId: string;
    name: string;
    description?: string;
    startDate: Date;
    endDate: Date;
    progress: number;
    status: 'not_started' | 'in_progress' | 'completed' | 'cancelled' | 'on_hold';
    createdBy: string;
    createdAt: Date;
    updatedAt: Date;
}
export interface GanttDependency {
    id: string;
    sourceTaskId: string;
    targetTaskId: string;
    type: 'finish_to_start' | 'start_to_start' | 'finish_to_finish' | 'start_to_finish';
    lagDays: number;
    createdAt: Date;
}
export interface GanttViewData {
    tasks: GanttTask[];
    dependencies: GanttDependency[];
    timeline: {
        startDate: Date;
        endDate: Date;
        workingDays: number[];
        hoursPerDay: number;
    };
}
export default class GanttPlugin implements PluginLifecycle {
    private context;
    private ganttData;
    /**
     * 插件激活
     */
    activate(context: PluginContext): Promise<void>;
    /**
     * 插件停用
     */
    deactivate(): Promise<void>;
    /**
     * 注册API路由
     */
    private registerRoutes;
    /**
     * Get gantt data for a view
     */
    getGanttData(viewId: string): Promise<GanttViewData>;
    /**
     * Load gantt data from database
     */
    private loadGanttDataFromDatabase;
    /**
     * Calculate project timeline
     */
    private calculateTimeline;
    /**
     * Create a new task
     */
    createTask(viewId: string, taskData: Partial<GanttTask>): Promise<GanttTask>;
    /**
     * Update a task
     */
    updateTask(viewId: string, taskId: string, updates: Partial<GanttTask>): Promise<void>;
    /**
     * Delete a task
     */
    deleteTask(viewId: string, taskId: string): Promise<void>;
    /**
     * Sync gantt data (clear cache and reload)
     */
    syncGanttData(viewId: string): Promise<void>;
    /**
     * Convert camelCase to snake_case
     */
    private camelToSnake;
}
//# sourceMappingURL=index.d.ts.map