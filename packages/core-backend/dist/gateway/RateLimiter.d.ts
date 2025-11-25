import { Request, Response, NextFunction } from 'express';
import EventEmitter from 'events';
export interface RateLimitConfig {
    windowMs?: number;
    maxRequests?: number;
    keyGenerator?: (req: Request) => string;
    skipSuccessfulRequests?: boolean;
    skipFailedRequests?: boolean;
    standardHeaders?: boolean;
    legacyHeaders?: boolean;
    handler?: (req: Request, res: Response) => void;
    onLimitReached?: (req: Request, res: Response) => void;
    store?: RateLimitStore;
    weight?: (req: Request) => number;
    skipIf?: (req: Request) => boolean | Promise<boolean>;
}
export interface RateLimitInfo {
    limit: number;
    remaining: number;
    resetTime: Date;
    retryAfter?: number;
}
export interface RateLimitStore {
    get(key: string): Promise<RateLimitEntry | null>;
    set(key: string, entry: RateLimitEntry, ttlMs: number): Promise<void>;
    increment(key: string, weight: number): Promise<RateLimitEntry>;
    reset(key: string): Promise<void>;
    resetAll(): Promise<void>;
}
export interface RateLimitEntry {
    count: number;
    resetTime: Date;
    firstRequest: Date;
}
export declare class MemoryRateLimitStore implements RateLimitStore {
    private store;
    private timers;
    get(key: string): Promise<RateLimitEntry | null>;
    set(key: string, entry: RateLimitEntry, ttlMs: number): Promise<void>;
    increment(key: string, weight?: number): Promise<RateLimitEntry>;
    reset(key: string): Promise<void>;
    resetAll(): Promise<void>;
}
export declare class RedisRateLimitStore implements RateLimitStore {
    private redis;
    constructor(redisClient: any);
    get(key: string): Promise<RateLimitEntry | null>;
    set(key: string, entry: RateLimitEntry, ttlMs: number): Promise<void>;
    increment(key: string, weight?: number): Promise<RateLimitEntry>;
    reset(key: string): Promise<void>;
    resetAll(): Promise<void>;
}
export declare class RateLimiter extends EventEmitter {
    private config;
    private store;
    constructor(config?: RateLimitConfig);
    private defaultKeyGenerator;
    private defaultHandler;
    middleware(): (req: Request, res: Response, next: NextFunction) => Promise<any>;
    reset(key?: string): Promise<void>;
    getInfo(key: string): Promise<RateLimitInfo | null>;
}
export declare function createRateLimiter(options: RateLimitConfig): RateLimiter;
export declare function createStrictRateLimiter(): RateLimiter;
export declare function createModerateRateLimiter(): RateLimiter;
export declare function createRelaxedRateLimiter(): RateLimiter;
export declare function createApiRateLimiter(): RateLimiter;
export declare function createUserRateLimiter(): RateLimiter;
//# sourceMappingURL=RateLimiter.d.ts.map