import { BaseDataAdapter, QueryOptions, QueryResult, SchemaInfo, TableInfo, ColumnInfo } from './BaseAdapter';
export declare class MongoDBAdapter extends BaseDataAdapter {
    private client;
    private db;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    isConnected(): boolean;
    testConnection(): Promise<boolean>;
    query<T = any>(collection: string, pipeline?: any[]): Promise<QueryResult<T>>;
    select<T = any>(collection: string, options?: QueryOptions): Promise<QueryResult<T>>;
    insert<T = any>(collection: string, data: Record<string, any> | Record<string, any>[]): Promise<QueryResult<T>>;
    update<T = any>(collection: string, data: Record<string, any>, where: Record<string, any>): Promise<QueryResult<T>>;
    delete<T = any>(collection: string, where: Record<string, any>): Promise<QueryResult<T>>;
    getSchema(database?: string): Promise<SchemaInfo>;
    getTableInfo(collection: string, database?: string): Promise<TableInfo>;
    getColumns(collection: string, database?: string): Promise<ColumnInfo[]>;
    tableExists(collection: string, database?: string): Promise<boolean>;
    beginTransaction(): Promise<any>;
    commit(transaction: any): Promise<void>;
    rollback(transaction: any): Promise<void>;
    inTransaction(transaction: any, callback: () => Promise<any>): Promise<any>;
    stream<T = any>(collection: string, filter?: any, options?: {
        batchSize?: number;
    }): AsyncIterableIterator<T>;
    private buildConnectionUri;
    private buildMongoFilter;
    private mapOperatorToMongo;
    private extractColumns;
    private analyzeDocument;
    private getIndexes;
}
//# sourceMappingURL=MongoDBAdapter.d.ts.map