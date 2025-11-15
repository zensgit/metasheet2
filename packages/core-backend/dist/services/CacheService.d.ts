/**
 * 缓存服务实现
 * 支持 Redis 和内存缓存，提供完整的缓存操作
 */
import { EventEmitter } from 'eventemitter3';
import type { CacheService, CacheSetOptions } from '../types/plugin';
/**
 * 缓存提供者接口
 */
interface CacheProvider {
    get(key: string): Promise<any>;
    set(key: string, value: any, options?: CacheSetOptions): Promise<void>;
    delete(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    mget(keys: string[]): Promise<(any | null)[]>;
    mset(pairs: Array<{
        key: string;
        value: any;
        options?: CacheSetOptions;
    }>): Promise<void>;
    mdel(keys: string[]): Promise<void>;
    increment(key: string, value?: number): Promise<number>;
    expire(key: string, seconds: number): Promise<void>;
    ttl(key: string): Promise<number>;
    size(): Promise<number>;
    clear(): Promise<void>;
    invalidateByPattern(pattern: string): Promise<void>;
}
/**
 * 内存缓存提供者
 */
declare class MemoryCacheProvider implements CacheProvider {
    private cache;
    private tagIndex;
    private logger;
    constructor();
    get(key: string): Promise<any>;
    set(key: string, value: any, options?: CacheSetOptions): Promise<void>;
    delete(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    mget(keys: string[]): Promise<(any | null)[]>;
    mset(pairs: Array<{
        key: string;
        value: any;
        options?: CacheSetOptions;
    }>): Promise<void>;
    mdel(keys: string[]): Promise<void>;
    increment(key: string, value?: number): Promise<number>;
    expire(key: string, seconds: number): Promise<void>;
    ttl(key: string): Promise<number>;
    size(): Promise<number>;
    clear(): Promise<void>;
    invalidateByPattern(pattern: string): Promise<void>;
    private cleanExpired;
}
/**
 * Redis 缓存提供者
 */
declare class RedisCacheProvider implements CacheProvider {
    private redis;
    private logger;
    constructor(redisClient: any);
    get(key: string): Promise<any>;
    set(key: string, value: any, options?: CacheSetOptions): Promise<void>;
    delete(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    mget(keys: string[]): Promise<(any | null)[]>;
    mset(pairs: Array<{
        key: string;
        value: any;
        options?: CacheSetOptions;
    }>): Promise<void>;
    mdel(keys: string[]): Promise<void>;
    increment(key: string, value?: number): Promise<number>;
    expire(key: string, seconds: number): Promise<void>;
    ttl(key: string): Promise<number>;
    size(): Promise<number>;
    clear(): Promise<void>;
    invalidateByPattern(pattern: string): Promise<void>;
}
/**
 * 统一缓存服务实现
 */
export declare class CacheServiceImpl extends EventEmitter implements CacheService {
    private provider;
    private logger;
    private metrics;
    constructor(provider?: CacheProvider);
    get<T = any>(key: string): Promise<T | null>;
    set<T = any>(key: string, value: T, options?: CacheSetOptions): Promise<void>;
    delete(key: string): Promise<void>;
    exists(key: string): Promise<boolean>;
    mget<T = any>(keys: string[]): Promise<(T | null)[]>;
    mset<T = any>(pairs: Array<{
        key: string;
        value: T;
        options?: CacheSetOptions;
    }>): Promise<void>;
    mdel(keys: string[]): Promise<void>;
    invalidateByTag(tag: string): Promise<void>;
    invalidateByPattern(pattern: string): Promise<void>;
    increment(key: string, value?: number): Promise<number>;
    expire(key: string, seconds: number): Promise<void>;
    ttl(key: string): Promise<number>;
    size(): Promise<number>;
    clear(): Promise<void>;
    /**
     * 获取缓存统计信息
     */
    getMetrics(): {
        hitRate: number;
        hits: number;
        misses: number;
        operations: number;
    };
    /**
     * 重置统计信息
     */
    resetMetrics(): void;
    /**
     * 创建 Redis 缓存服务
     */
    static createRedisService(redisClient: any): CacheServiceImpl;
    /**
     * 创建内存缓存服务
     */
    static createMemoryService(): CacheServiceImpl;
}
export { MemoryCacheProvider, RedisCacheProvider };
//# sourceMappingURL=CacheService.d.ts.map