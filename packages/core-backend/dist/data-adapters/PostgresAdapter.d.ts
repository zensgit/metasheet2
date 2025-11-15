import { Client } from 'pg';
import { BaseDataAdapter, QueryOptions, QueryResult, SchemaInfo, TableInfo, ColumnInfo } from './BaseAdapter';
export declare class PostgresAdapter extends BaseDataAdapter {
    private pool;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    isConnected(): boolean;
    testConnection(): Promise<boolean>;
    query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
    select<T = any>(table: string, options?: QueryOptions): Promise<QueryResult<T>>;
    insert<T = any>(table: string, data: Record<string, any> | Record<string, any>[]): Promise<QueryResult<T>>;
    update<T = any>(table: string, data: Record<string, any>, where: Record<string, any>): Promise<QueryResult<T>>;
    delete<T = any>(table: string, where: Record<string, any>): Promise<QueryResult<T>>;
    getSchema(schema?: string): Promise<SchemaInfo>;
    getTableInfo(table: string, schema?: string): Promise<TableInfo>;
    getColumns(table: string, schema?: string): Promise<ColumnInfo[]>;
    tableExists(table: string, schema?: string): Promise<boolean>;
    beginTransaction(): Promise<Client>;
    commit(transaction: Client): Promise<void>;
    rollback(transaction: Client): Promise<void>;
    inTransaction(transaction: Client, callback: () => Promise<any>): Promise<any>;
    stream<T = any>(sql: string, params?: any[], options?: {
        highWaterMark?: number;
        objectMode?: boolean;
    }): AsyncIterableIterator<T>;
    private mapPostgresType;
    private formatColumnType;
}
//# sourceMappingURL=PostgresAdapter.d.ts.map