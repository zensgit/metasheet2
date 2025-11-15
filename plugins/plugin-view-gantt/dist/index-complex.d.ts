/**
 * 甘特图视图插件
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
    parentId?: string;
    orderIndex: number;
    isMilestone: boolean;
    priority?: 'low' | 'normal' | 'high' | 'critical';
    assignedTo?: string;
    estimatedHours?: number;
    actualHours?: number;
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
export interface GanttResource {
    id: string;
    viewId: string;
    name: string;
    type: 'person' | 'equipment' | 'material';
    capacity: number;
    costPerHour?: number;
    createdAt: Date;
    updatedAt: Date;
}
export interface GanttTaskResource {
    id: string;
    taskId: string;
    resourceId: string;
    allocationPercent: number;
    assignedAt: Date;
}
export interface CriticalPath {
    tasks: string[];
    totalDuration: number;
    startDate: Date;
    endDate: Date;
}
export interface GanttViewData {
    tasks: GanttTask[];
    dependencies: GanttDependency[];
    resources: GanttResource[];
    taskResources: GanttTaskResource[];
    criticalPath?: CriticalPath;
    timeline: {
        startDate: Date;
        endDate: Date;
        workingDays: number[];
        hoursPerDay: number;
    };
}
export default class GanttPlugin implements PluginLifecycle {
    private context;
    private apiHandler;
    private eventHandlers;
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
     * 注册事件监听
     */
    private registerEventListeners;
    /**
     * 注册插件API
     */
    private registerPluginAPI;
    /**
     * 注册WebSocket事件
     */
    private registerWebSocketEvents;
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
     * Create a dependency
     */
    createDependency(viewId: string, dependencyData: Partial<GanttDependency>): Promise<GanttDependency>;
    /**
     * Calculate critical path
     */
    calculateCriticalPath(viewId: string): Promise<CriticalPath | null>;
    /**
     * Find longest path from a start task
     */
    private findLongestPath;
    /**
     * Calculate duration of a path
     */
    private calculatePathDuration;
    /**
     * Sync gantt data (clear cache and reload)
     */
    syncGanttData(viewId: string): Promise<void>;
    /**
     * Convert camelCase to snake_case
     */
    private camelToSnake;
    /**
     * Get gantt data cache
     */
    getGanttDataCache(): Map<string, GanttViewData>;
}
//# sourceMappingURL=index-complex.d.ts.map