import { BaseDataAdapter, QueryOptions, QueryResult, SchemaInfo, TableInfo, ColumnInfo } from './BaseAdapter';
interface HTTPQueryOptions extends QueryOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    headers?: Record<string, string>;
    params?: Record<string, any>;
    data?: any;
    endpoint?: string;
}
export declare class HTTPAdapter extends BaseDataAdapter {
    private client;
    private endpoints;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    isConnected(): boolean;
    testConnection(): Promise<boolean>;
    registerEndpoint(name: string, config: {
        url: string;
        method: string;
        headers?: Record<string, string>;
        transformRequest?: (data: any) => any;
        transformResponse?: (data: any) => any;
    }): void;
    query<T = any>(endpoint: string, params?: any[]): Promise<QueryResult<T>>;
    select<T = any>(endpoint: string, options?: HTTPQueryOptions): Promise<QueryResult<T>>;
    insert<T = any>(endpoint: string, data: Record<string, any> | Record<string, any>[]): Promise<QueryResult<T>>;
    update<T = any>(endpoint: string, data: Record<string, any>, where: Record<string, any>): Promise<QueryResult<T>>;
    delete<T = any>(endpoint: string, where: Record<string, any>): Promise<QueryResult<T>>;
    getSchema(schema?: string): Promise<SchemaInfo>;
    getTableInfo(table: string, schema?: string): Promise<TableInfo>;
    getColumns(table: string, schema?: string): Promise<ColumnInfo[]>;
    tableExists(table: string, schema?: string): Promise<boolean>;
    beginTransaction(): Promise<any>;
    commit(transaction: any): Promise<void>;
    rollback(transaction: any): Promise<void>;
    inTransaction(transaction: any, callback: () => Promise<any>): Promise<any>;
    stream<T = any>(endpoint: string, params?: any[], options?: {
        highWaterMark?: number;
    }): AsyncIterableIterator<T>;
    private extractColumns;
    batchRequest<T = any>(requests: Array<{
        method: string;
        endpoint: string;
        data?: any;
        params?: any;
    }>): Promise<QueryResult<T>[]>;
}
export {};
//# sourceMappingURL=HTTPAdapter.d.ts.map