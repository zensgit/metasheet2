/**
 * Redis Data Source Adapter
 * Provides access to Redis key-value store
 */
import { DataSourceAdapter, QueryParams, QueryResult, SchemaInfo } from './BaseAdapter';
export interface RedisConfig {
    host: string;
    port: number;
    password?: string;
    database?: number;
    keyPrefix?: string;
    cluster?: boolean;
    sentinels?: Array<{
        host: string;
        port: number;
    }>;
}
export declare class RedisAdapter extends DataSourceAdapter {
    private client;
    private config;
    constructor(config: RedisConfig);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    query(params: QueryParams): Promise<QueryResult[]>;
    execute(command: string, args?: any[]): Promise<any>;
    getSchema(): Promise<SchemaInfo>;
    testConnection(): Promise<boolean>;
    private filterResults;
    /**
     * Redis-specific methods
     */
    publish(channel: string, message: string): Promise<number>;
    subscribe(channel: string, callback: (message: string) => void): Promise<void>;
    setWithExpiry(key: string, value: string, ttl: number): Promise<void>;
    increment(key: string, by?: number): Promise<number>;
    addToSet(key: string, members: string[]): Promise<number>;
    getSetMembers(key: string): Promise<string[]>;
    addToSortedSet(key: string, score: number, member: string): Promise<number>;
    getSortedSetRange(key: string, start: number, stop: number): Promise<string[]>;
}
//# sourceMappingURL=RedisAdapter.d.ts.map