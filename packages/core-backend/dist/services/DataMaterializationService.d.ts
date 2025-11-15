/**
 * Data Materialization Service with CDC Support
 * Handles data synchronization between external sources and local tables
 */
import { EventEmitter } from 'events';
export type SyncMode = 'FULL' | 'INCREMENTAL' | 'CDC' | 'UPSERT';
export type CDCEvent = 'INSERT' | 'UPDATE' | 'DELETE';
export interface MaterializationConfig {
    id?: string;
    name: string;
    sourceId: string;
    targetTableId: string;
    syncMode: SyncMode;
    syncInterval?: number;
    sourceSchema?: string;
    sourceTable: string;
    sourceQuery?: string;
    fieldMappings: Record<string, string>;
    transformRules?: TransformRule[];
    batchSize?: number;
    cdcEnabled?: boolean;
    cdcColumn?: string;
    primaryKey?: string;
    conflictResolution?: 'OVERWRITE' | 'MERGE' | 'SKIP' | 'ERROR';
    mergeFields?: string[];
}
export interface TransformRule {
    field: string;
    type: 'RENAME' | 'CAST' | 'FORMULA' | 'LOOKUP' | 'AGGREGATE';
    config: any;
}
export interface ChangeEvent {
    type: CDCEvent;
    table: string;
    primaryKey: any;
    before?: Record<string, any>;
    after?: Record<string, any>;
    timestamp: Date;
}
export interface SyncResult {
    success: boolean;
    recordsProcessed: number;
    recordsInserted: number;
    recordsUpdated: number;
    recordsDeleted: number;
    errors: string[];
    duration: number;
    nextSync?: Date;
}
/**
 * Data Materialization Service
 */
export declare class DataMaterializationService extends EventEmitter {
    private adapters;
    private syncJobs;
    private cdcListeners;
    private syncInProgress;
    constructor();
    private initialize;
    /**
     * Create a new materialization
     */
    createMaterialization(config: MaterializationConfig): Promise<string>;
    /**
     * Execute a materialization
     */
    executeMaterialization(materializationId: string, options?: {
        fullSync?: boolean;
        fromTimestamp?: Date;
    }): Promise<SyncResult>;
    /**
     * Perform full sync
     */
    private performFullSync;
    /**
     * Perform incremental sync
     */
    private performIncrementalSync;
    /**
     * Perform CDC sync
     */
    private performCDCSync;
    /**
     * Perform upsert sync
     */
    private performUpsertSync;
    /**
     * Perform lazy sync (on-demand)
     */
    private performLazySync;
    /**
     * Setup CDC listener
     */
    private setupCDC;
    /**
     * Handle CDC event
     */
    private handleCDCEvent;
    /**
     * Schedule periodic sync
     */
    private scheduleSync;
    /**
     * Get data source adapter
     */
    private getAdapter;
    /**
     * Load materialization configuration
     */
    private loadMaterializationConfig;
    /**
     * Transform record based on rules
     */
    private transformRecord;
    /**
     * Apply a transform rule
     */
    private applyTransformRule;
    /**
     * Helper methods for data operations
     */
    private recordExists;
    private insertRecord;
    private updateRecord;
    private deleteRecord;
    private getTargetKeys;
    private castValue;
    private evaluateFormula;
    private lookupValue;
    private aggregateValue;
    /**
     * Cleanup and shutdown
     */
    shutdown(): Promise<void>;
}
export declare const dataMaterializationService: DataMaterializationService;
//# sourceMappingURL=DataMaterializationService.d.ts.map