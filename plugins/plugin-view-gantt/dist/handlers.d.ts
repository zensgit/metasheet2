/**
 * Gantt Event Handlers
 */
import type { PluginContext } from '@metasheet/core-backend/src/types/plugin';
import type GanttPlugin from './index';
import type { GanttDependency, GanttTask } from './index';
interface ViewUpdateEvent {
    type?: string;
    viewId?: string;
}
interface TaskCreatedEvent {
    viewId: string;
    task: GanttTask;
}
interface TaskUpdatedEvent {
    viewId: string;
    taskId: string;
    updates: Partial<GanttTask>;
}
interface TaskDeletedEvent {
    viewId: string;
    taskId: string;
}
interface DependencyCreatedEvent {
    viewId: string;
    dependency: GanttDependency;
}
interface DependencyDeletedEvent {
    viewId: string;
    dependencyId: string;
}
export declare class GanttEventHandlers {
    private readonly context;
    private readonly plugin;
    constructor(context: PluginContext, plugin: GanttPlugin);
    handleViewUpdate(data: ViewUpdateEvent): Promise<void>;
    handleTaskCreated(data: TaskCreatedEvent): Promise<void>;
    handleTaskUpdated(data: TaskUpdatedEvent): Promise<void>;
    handleTaskDeleted(data: TaskDeletedEvent): Promise<void>;
    handleDependencyCreated(data: DependencyCreatedEvent): Promise<void>;
    handleDependencyDeleted(data: DependencyDeletedEvent): Promise<void>;
    private getViewConfig;
    private autoScheduleDependentTasks;
    private checkResourceConflicts;
    private findOverlappingTasks;
    private checkMilestoneCompletion;
    private rescheduleAllTasks;
}
export {};
