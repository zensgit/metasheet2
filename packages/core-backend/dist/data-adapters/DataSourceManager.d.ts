import { EventEmitter } from 'eventemitter3';
import { BaseDataAdapter, DataSourceConfig, QueryOptions, QueryResult } from './BaseAdapter';
type AdapterConstructor = new (config: DataSourceConfig) => BaseDataAdapter;
export declare class DataSourceManager extends EventEmitter {
    private adapters;
    private adapterTypes;
    private connectionPool;
    constructor();
    private registerDefaultAdapters;
    registerAdapterType(type: string, adapterClass: AdapterConstructor): void;
    addDataSource(config: DataSourceConfig): Promise<BaseDataAdapter>;
    removeDataSource(id: string): Promise<void>;
    getDataSource(id: string): BaseDataAdapter;
    connectDataSource(id: string): Promise<void>;
    disconnectDataSource(id: string): Promise<void>;
    testConnection(id: string): Promise<boolean>;
    query<T = any>(dataSourceId: string, sql: string, params?: any[]): Promise<QueryResult<T>>;
    select<T = any>(dataSourceId: string, table: string, options?: QueryOptions): Promise<QueryResult<T>>;
    insert<T = any>(dataSourceId: string, table: string, data: Record<string, any> | Record<string, any>[]): Promise<QueryResult<T>>;
    update<T = any>(dataSourceId: string, table: string, data: Record<string, any>, where: Record<string, any>): Promise<QueryResult<T>>;
    delete<T = any>(dataSourceId: string, table: string, where: Record<string, any>): Promise<QueryResult<T>>;
    copyData(sourceId: string, sourceTable: string, targetId: string, targetTable: string, options?: {
        where?: Record<string, any>;
        batchSize?: number;
        transform?: (row: any) => any;
    }): Promise<{
        totalRows: number;
        duration: number;
    }>;
    federatedQuery<T = any>(queries: Array<{
        dataSourceId: string;
        sql: string;
        params?: any[];
        alias: string;
    }>, joinLogic?: (results: Map<string, any[]>) => T[]): Promise<T[]>;
    listDataSources(): Array<{
        id: string;
        name: string;
        type: string;
        connected: boolean;
    }>;
    healthCheck(): Promise<Map<string, {
        connected: boolean;
        responsive: boolean;
        latency?: number;
    }>>;
    disconnectAll(): Promise<void>;
    dispose(): Promise<void>;
}
export {};
//# sourceMappingURL=DataSourceManager.d.ts.map