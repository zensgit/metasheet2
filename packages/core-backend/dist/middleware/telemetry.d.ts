/**
 * Telemetry middleware for Express
 */
import { Request, Response, NextFunction } from 'express';
import { StructuredLogger } from '../services/TelemetryService';
declare global {
    namespace Express {
        interface Request {
            span?: any;
            correlationId?: string;
            logger?: StructuredLogger;
        }
    }
}
/**
 * Telemetry middleware
 * Adds tracing, logging, and metrics to HTTP requests
 */
export declare function telemetryMiddleware(): (req: Request, res: Response, next: NextFunction) => void;
/**
 * Error handling middleware with telemetry
 */
export declare function telemetryErrorHandler(): (err: Error, req: Request, res: Response, next: NextFunction) => void;
/**
 * Database query tracing helper
 */
export declare function traceDbQuery<T>(operation: string, table: string, queryFn: () => Promise<T>): Promise<T>;
/**
 * Cache operation tracing helper
 */
export declare function traceCacheOperation<T>(operation: 'get' | 'set' | 'delete', key: string, operationFn: () => Promise<T>): Promise<T>;
/**
 * Async operation tracing helper
 */
export declare function traceAsync<T>(name: string, fn: () => Promise<T>, attributes?: Record<string, any>): Promise<T>;
//# sourceMappingURL=telemetry.d.ts.map