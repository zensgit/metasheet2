/**
 * Elasticsearch Data Source Adapter
 * Provides access to Elasticsearch search engine
 */
import { DataSourceAdapter, QueryParams, QueryResult, SchemaInfo } from './BaseAdapter';
export interface ElasticsearchConfig {
    node: string | string[];
    auth?: {
        username: string;
        password: string;
    };
    apiKey?: string;
    cloudId?: string;
    maxRetries?: number;
    requestTimeout?: number;
    sniffOnStart?: boolean;
    ssl?: {
        rejectUnauthorized?: boolean;
        ca?: string;
    };
}
export declare class ElasticsearchAdapter extends DataSourceAdapter {
    private client;
    private config;
    constructor(config: ElasticsearchConfig);
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    query(params: QueryParams): Promise<QueryResult[]>;
    execute(command: string, args?: any[]): Promise<any>;
    getSchema(): Promise<SchemaInfo>;
    testConnection(): Promise<boolean>;
    /**
     * Build Elasticsearch query from where clause
     */
    private buildElasticsearchQuery;
    /**
     * Build aggregations
     */
    private buildAggregations;
    /**
     * Process aggregation results
     */
    private processAggregations;
    /**
     * Execute SQL query using Elasticsearch SQL
     */
    private executeSQLQuery;
    /**
     * Map Elasticsearch type to generic type
     */
    private mapElasticsearchType;
    /**
     * Elasticsearch-specific methods
     */
    createIndex(name: string, settings?: any, mappings?: any): Promise<any>;
    deleteIndex(name: string): Promise<any>;
    indexDocument(index: string, document: any, id?: string): Promise<any>;
    bulkIndex(operations: any[]): Promise<any>;
    searchWithHighlight(index: string, query: any, fields: string[]): Promise<any>;
    aggregate(index: string, aggregations: any): Promise<any>;
}
//# sourceMappingURL=ElasticsearchAdapter.d.ts.map