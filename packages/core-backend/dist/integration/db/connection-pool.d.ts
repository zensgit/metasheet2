import { PoolClient, PoolConfig } from 'pg';
export interface QueryOptions {
    timeoutMs?: number;
    readOnly?: boolean;
}
export interface ConnectionPoolOptions extends PoolConfig {
    slowQueryMs?: number;
    name?: string;
}
declare class ConnectionPool {
    private pool;
    private slowMs;
    readonly name: string;
    constructor(opts: ConnectionPoolOptions);
    healthCheck(): Promise<void>;
    query<T = any>(sql: string, params?: any[], _options?: QueryOptions): Promise<{
        rows: T[];
    }>;
    transaction<T>(handler: (client: {
        query: PoolClient['query'];
    }) => Promise<T>): Promise<T>;
}
declare class PoolManager {
    private main;
    private readonly pools;
    constructor();
    createPool(name: string, opts: ConnectionPoolOptions): ConnectionPool;
    get(name?: string): ConnectionPool;
    healthCheck(): Promise<void>;
}
export declare const poolManager: PoolManager;
export type { ConnectionPool };
//# sourceMappingURL=connection-pool.d.ts.map