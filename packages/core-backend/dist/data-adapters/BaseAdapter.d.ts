import { EventEmitter } from 'eventemitter3';
export interface DataSourceConfig {
    id: string;
    name: string;
    type: string;
    connection: Record<string, any>;
    options?: Record<string, any>;
    credentials?: Record<string, any>;
    poolConfig?: {
        min?: number;
        max?: number;
        idleTimeout?: number;
        acquireTimeout?: number;
    };
}
export interface QueryOptions {
    limit?: number;
    offset?: number;
    orderBy?: Array<{
        column: string;
        direction: 'asc' | 'desc';
    }>;
    where?: Record<string, any>;
    select?: string[];
    joins?: Array<{
        table: string;
        on: string;
        type?: 'inner' | 'left' | 'right' | 'full';
    }>;
    raw?: boolean;
}
export interface QueryResult<T = any> {
    data: T[];
    metadata?: {
        totalCount?: number;
        pageCount?: number;
        currentPage?: number;
        columns?: Array<{
            name: string;
            type: string;
            nullable?: boolean;
        }>;
    };
    error?: Error;
}
export interface SchemaInfo {
    tables: TableInfo[];
    views?: ViewInfo[];
    procedures?: ProcedureInfo[];
}
export interface TableInfo {
    name: string;
    schema?: string;
    columns: ColumnInfo[];
    primaryKey?: string[];
    indexes?: IndexInfo[];
    foreignKeys?: ForeignKeyInfo[];
}
export interface ColumnInfo {
    name: string;
    type: string;
    nullable: boolean;
    defaultValue?: any;
    primaryKey?: boolean;
    autoIncrement?: boolean;
    comment?: string;
}
export interface IndexInfo {
    name: string;
    columns: string[];
    unique: boolean;
    type?: string;
}
export interface ForeignKeyInfo {
    name: string;
    column: string;
    referencedTable: string;
    referencedColumn: string;
    onUpdate?: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'NO ACTION';
    onDelete?: 'CASCADE' | 'RESTRICT' | 'SET NULL' | 'NO ACTION';
}
export interface ViewInfo {
    name: string;
    schema?: string;
    definition?: string;
    columns: ColumnInfo[];
}
export interface ProcedureInfo {
    name: string;
    schema?: string;
    parameters?: Array<{
        name: string;
        type: string;
        direction: 'IN' | 'OUT' | 'INOUT';
    }>;
}
export declare abstract class BaseDataAdapter extends EventEmitter {
    protected config: DataSourceConfig;
    protected connected: boolean;
    protected pool: any;
    constructor(config: DataSourceConfig);
    abstract connect(): Promise<void>;
    abstract disconnect(): Promise<void>;
    abstract isConnected(): boolean;
    abstract testConnection(): Promise<boolean>;
    abstract query<T = any>(sql: string, params?: any[]): Promise<QueryResult<T>>;
    abstract select<T = any>(table: string, options?: QueryOptions): Promise<QueryResult<T>>;
    abstract insert<T = any>(table: string, data: Record<string, any> | Record<string, any>[]): Promise<QueryResult<T>>;
    abstract update<T = any>(table: string, data: Record<string, any>, where: Record<string, any>): Promise<QueryResult<T>>;
    abstract delete<T = any>(table: string, where: Record<string, any>): Promise<QueryResult<T>>;
    abstract getSchema(schema?: string): Promise<SchemaInfo>;
    abstract getTableInfo(table: string, schema?: string): Promise<TableInfo>;
    abstract getColumns(table: string, schema?: string): Promise<ColumnInfo[]>;
    abstract tableExists(table: string, schema?: string): Promise<boolean>;
    abstract beginTransaction(): Promise<any>;
    abstract commit(transaction: any): Promise<void>;
    abstract rollback(transaction: any): Promise<void>;
    abstract inTransaction(transaction: any, callback: () => Promise<any>): Promise<any>;
    batchInsert<T = any>(table: string, data: Record<string, any>[], batchSize?: number): Promise<QueryResult<T>[]>;
    abstract stream<T = any>(sql: string, params?: any[], options?: {
        highWaterMark?: number;
        objectMode?: boolean;
    }): AsyncIterableIterator<T>;
    protected sanitizeIdentifier(identifier: string): string;
    protected buildWhereClause(where: Record<string, any>): {
        sql: string;
        params: any[];
    };
    protected getOperator(op: string): string;
    protected onConnect(): Promise<void>;
    protected onDisconnect(): Promise<void>;
    protected onError(error: Error): Promise<void>;
    ping(): Promise<boolean>;
    getConfig(): DataSourceConfig;
    getName(): string;
    getType(): string;
}
//# sourceMappingURL=BaseAdapter.d.ts.map