/**
 * Permission Metrics Middleware
 * Issue #35: Integrates permission checking with metrics collection
 */
import { Request, Response, NextFunction } from 'express';
export interface AuthenticatedRequest extends Request {
    user?: {
        id: string;
        role: string;
        department?: string;
        permissions?: string[];
    };
    startTime?: number;
}
/**
 * Middleware to track permission metrics
 */
export declare class PermissionMetricsMiddleware {
    /**
     * Track request timing
     */
    static startTimer(req: AuthenticatedRequest, res: Response, next: NextFunction): void;
    /**
     * Track authentication failures
     */
    static trackAuthFailure(req: AuthenticatedRequest, res: Response, next: NextFunction): void;
    /**
     * Track token validation
     */
    static validateToken(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void>;
    /**
     * Check RBAC permissions
     */
    static checkPermission(requiredPermission: string): (req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
    /**
     * Check department-based access
     */
    static checkDepartmentAccess(allowedDepartments: string[]): (req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
    /**
     * Export metrics endpoint
     */
    static metricsEndpoint(req: Request, res: Response): void;
    /**
     * Session tracking
     */
    static trackSession(action: 'login' | 'logout'): void;
}
export default PermissionMetricsMiddleware;
//# sourceMappingURL=permission-metrics-middleware.d.ts.map