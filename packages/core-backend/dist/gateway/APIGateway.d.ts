import { Application, Request, Response, NextFunction } from 'express';
import { EventEmitter } from 'events';
import { RateLimitConfig } from './RateLimiter';
export interface APIEndpoint {
    path: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    handler?: (req: Request, res: Response, next: NextFunction) => void;
    upstream?: string;
    rateLimits?: RateLimitConfig;
    circuitBreaker?: boolean;
    authentication?: AuthenticationType;
    authorization?: string[];
    validation?: ValidationSchema;
    cache?: CacheConfig;
    transform?: TransformConfig;
    timeout?: number;
    retries?: number;
    version?: string;
    deprecated?: boolean;
    description?: string;
}
export type AuthenticationType = 'jwt' | 'api-key' | 'oauth' | 'basic' | 'none';
export interface ValidationSchema {
    query?: Record<string, any>;
    body?: Record<string, any>;
    params?: Record<string, any>;
    headers?: Record<string, any>;
}
export interface CacheConfig {
    enabled: boolean;
    ttl: number;
    keyGenerator?: (req: Request) => string;
    invalidateOn?: string[];
}
export interface TransformConfig {
    request?: (req: Request) => Request | Promise<Request>;
    response?: (data: any, req: Request) => any | Promise<any>;
}
export interface GatewayConfig {
    basePath?: string;
    defaultRateLimit?: RateLimitConfig;
    enableCircuitBreaker?: boolean;
    enableMetrics?: boolean;
    enableLogging?: boolean;
    enableCors?: boolean;
    corsOptions?: CorsOptions;
    timeout?: number;
    retries?: number;
}
export interface CorsOptions {
    origin?: string | string[] | ((origin: string) => boolean);
    methods?: string[];
    allowedHeaders?: string[];
    exposedHeaders?: string[];
    credentials?: boolean;
    maxAge?: number;
}
export interface APIMetrics {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageResponseTime: number;
    endpoints: Map<string, EndpointMetrics>;
}
export interface EndpointMetrics {
    requests: number;
    successes: number;
    failures: number;
    totalTime: number;
    averageTime: number;
    lastAccess: Date;
}
export declare class APIGateway extends EventEmitter {
    private app;
    private router;
    private config;
    private endpoints;
    private rateLimiters;
    private circuitBreakers;
    private cache;
    private metrics;
    constructor(app: Application, config?: GatewayConfig);
    private setupMiddleware;
    private corsMiddleware;
    private requestIdMiddleware;
    private loggingMiddleware;
    private metricsMiddleware;
    registerEndpoint(endpoint: APIEndpoint): void;
    private createAuthMiddleware;
    private createAuthzMiddleware;
    private createValidationMiddleware;
    private validateObject;
    private createCacheMiddleware;
    private createProxyHandler;
    private wrapHandler;
    private setupCleanupTimer;
    getMetrics(): APIMetrics;
    getEndpoint(method: string, path: string): APIEndpoint | undefined;
    removeEndpoint(method: string, path: string): boolean;
    clearCache(pattern?: string): number;
    registerEndpoints(endpoints: APIEndpoint[]): void;
    registerVersionedEndpoint(endpoint: APIEndpoint, version: string): void;
}
//# sourceMappingURL=APIGateway.d.ts.map