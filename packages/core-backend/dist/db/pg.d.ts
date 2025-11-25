import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
export declare const pool: Pool | undefined;
export declare function query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>>;
export declare function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
export declare function getPoolStats(): {
    total: number;
    idle: number;
    waiting: number;
} | null;
//# sourceMappingURL=pg.d.ts.map