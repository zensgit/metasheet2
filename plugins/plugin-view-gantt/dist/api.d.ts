/**
 * Gantt API Handlers
 */
import type { Request, Response } from 'express';
import type { PluginContext } from '@metasheet/core-backend/src/types/plugin';
import type GanttPlugin from './index';
type AuthenticatedRequest = Request & {
    user?: {
        id?: string;
    };
};
export declare class GanttAPIHandler {
    private readonly context;
    private readonly plugin;
    constructor(context: PluginContext, plugin: GanttPlugin);
    getGanttData(req: AuthenticatedRequest, res: Response): Promise<void>;
    createTask(req: AuthenticatedRequest, res: Response): Promise<void>;
    updateTask(req: AuthenticatedRequest, res: Response): Promise<void>;
    deleteTask(req: AuthenticatedRequest, res: Response): Promise<void>;
    createDependency(req: AuthenticatedRequest, res: Response): Promise<void>;
    deleteDependency(req: AuthenticatedRequest, res: Response): Promise<void>;
    calculateCriticalPath(req: AuthenticatedRequest, res: Response): Promise<void>;
    getResources(req: AuthenticatedRequest, res: Response): Promise<void>;
    createResource(req: AuthenticatedRequest, res: Response): Promise<void>;
    updateResource(req: AuthenticatedRequest, res: Response): Promise<void>;
    deleteResource(req: AuthenticatedRequest, res: Response): Promise<void>;
    assignResource(req: AuthenticatedRequest, res: Response): Promise<void>;
    unassignResource(req: AuthenticatedRequest, res: Response): Promise<void>;
    exportProject(req: AuthenticatedRequest, res: Response): Promise<void>;
    private checkViewPermission;
    private wouldCreateCircularDependency;
    private getUserId;
    private toErrorMessage;
    private camelToSnake;
}
export {};
