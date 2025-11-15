/**
 * Gantt API Handlers
 */
import type { PluginContext } from '@metasheet/core-backend/src/types/plugin';
import type { Request, Response } from 'express';
import type GanttPlugin from './index';
export declare class GanttAPIHandler {
    private context;
    private plugin;
    constructor(context: PluginContext, plugin: GanttPlugin);
    /**
     * Get gantt data for a view
     */
    getGanttData(req: Request, res: Response): Promise<void>;
    /**
     * Create a new task
     */
    createTask(req: Request, res: Response): Promise<void>;
    /**
     * Update a task
     */
    updateTask(req: Request, res: Response): Promise<void>;
    /**
     * Delete a task
     */
    deleteTask(req: Request, res: Response): Promise<void>;
    /**
     * Create a dependency
     */
    createDependency(req: Request, res: Response): Promise<void>;
    /**
     * Delete a dependency
     */
    deleteDependency(req: Request, res: Response): Promise<void>;
    /**
     * Calculate critical path
     */
    calculateCriticalPath(req: Request, res: Response): Promise<void>;
    /**
     * Get resources for a view
     */
    getResources(req: Request, res: Response): Promise<void>;
    /**
     * Create a resource
     */
    createResource(req: Request, res: Response): Promise<void>;
    /**
     * Update a resource
     */
    updateResource(req: Request, res: Response): Promise<void>;
    /**
     * Delete a resource
     */
    deleteResource(req: Request, res: Response): Promise<void>;
    /**
     * Assign resource to task
     */
    assignResource(req: Request, res: Response): Promise<void>;
    /**
     * Unassign resource from task
     */
    unassignResource(req: Request, res: Response): Promise<void>;
    /**
     * Export project data
     */
    exportProject(req: Request, res: Response): Promise<void>;
    /**
     * Check if user has permission to access view
     */
    private checkViewPermission;
    /**
     * Check if creating a dependency would cause a circular reference
     */
    private wouldCreateCircularDependency;
    /**
     * Convert camelCase to snake_case
     */
    private camelToSnake;
}
//# sourceMappingURL=api.d.ts.map