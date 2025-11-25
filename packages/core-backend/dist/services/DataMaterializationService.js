// @ts-nocheck
/**
 * Data Materialization Service with CDC Support
 * Handles data synchronization between external sources and local tables
 */
import { EventEmitter } from 'events';
import { CronJob } from 'cron';
import { db } from '../db/kysely';
// Soft dependency adapters; defer to runtime wiring in Phase B
// @ts-ignore
import { PostgresAdapter } from '../data-adapters/PostgresAdapter';
// @ts-ignore
import { MySQLAdapter } from '../data-adapters/MySQLAdapter';
// @ts-ignore
import { MongoDBAdapter } from '../data-adapters/MongoDBAdapter';
// @ts-ignore
import { HTTPAdapter } from '../data-adapters/HTTPAdapter';
/**
 * Data Materialization Service
 */
export class DataMaterializationService extends EventEmitter {
    adapters = new Map();
    syncJobs = new Map();
    cdcListeners = new Map();
    syncInProgress = new Set();
    constructor() {
        super();
        this.initialize();
    }
    async initialize() {
        // Load existing materialization configs
        if (!db)
            return;
        try {
            const configs = await db
                .selectFrom('external_tables')
                .innerJoin('data_sources', 'data_sources.id', 'external_tables.data_source_id')
                .selectAll()
                .execute();
            for (const config of configs) {
                if (config.sync_mode === 'SCHEDULED' && config.sync_interval) {
                    this.scheduleSync(config.id, config.sync_interval);
                }
                if (config.sync_mode === 'REALTIME') {
                    await this.setupCDC(config.id);
                }
            }
        }
        catch (error) {
            console.error('Failed to initialize materialization service:', error);
        }
    }
    /**
     * Create a new materialization
     */
    async createMaterialization(config) {
        if (!db)
            throw new Error('Database not configured');
        const id = config.id || crypto.randomUUID();
        // Validate data source exists
        const dataSource = await db
            .selectFrom('data_sources')
            .selectAll()
            .where('id', '=', config.sourceId)
            .executeTakeFirst();
        if (!dataSource) {
            throw new Error(`Data source ${config.sourceId} not found`);
        }
        // Create external table record
        await db
            .insertInto('external_tables')
            .values({
            id,
            table_id: config.targetTableId,
            data_source_id: config.sourceId,
            external_schema: config.sourceSchema,
            external_table: config.sourceTable,
            external_primary_key: config.primaryKey,
            sync_mode: config.syncMode === 'CDC' ? 'REALTIME' :
                config.syncInterval ? 'SCHEDULED' : 'LAZY',
            sync_interval: config.syncInterval,
            field_mappings: config.fieldMappings,
            transform_rules: config.transformRules || [],
            cache_ttl: 300,
            max_cache_size: 10485760
        })
            .execute();
        // Setup sync based on mode
        if (config.syncInterval) {
            this.scheduleSync(id, config.syncInterval);
        }
        if (config.cdcEnabled) {
            await this.setupCDC(id);
        }
        // Perform initial sync
        await this.executeMaterialization(id);
        this.emit('materialization:created', id, config);
        return id;
    }
    /**
     * Execute a materialization
     */
    async executeMaterialization(materializationId, options) {
        if (this.syncInProgress.has(materializationId)) {
            return {
                success: false,
                recordsProcessed: 0,
                recordsInserted: 0,
                recordsUpdated: 0,
                recordsDeleted: 0,
                errors: ['Sync already in progress'],
                duration: 0
            };
        }
        this.syncInProgress.add(materializationId);
        const startTime = Date.now();
        try {
            // Load configuration
            const config = await this.loadMaterializationConfig(materializationId);
            if (!config) {
                throw new Error(`Materialization ${materializationId} not found`);
            }
            // Get adapter
            const adapter = await this.getAdapter(config.data_source_id);
            // Determine sync mode
            const syncMode = options?.fullSync ? 'FULL' :
                config.sync_mode === 'REALTIME' ? 'CDC' :
                    config.sync_mode;
            let result;
            switch (syncMode) {
                case 'FULL':
                    result = await this.performFullSync(config, adapter);
                    break;
                case 'INCREMENTAL':
                    result = await this.performIncrementalSync(config, adapter, options?.fromTimestamp);
                    break;
                case 'CDC':
                    result = await this.performCDCSync(config, adapter);
                    break;
                case 'UPSERT':
                    result = await this.performUpsertSync(config, adapter);
                    break;
                default:
                    result = await this.performLazySync(config, adapter);
            }
            // Update sync metadata
            await db
                .updateTable('external_tables')
                .set({
                last_sync: new Date(),
                next_sync: config.sync_interval
                    ? new Date(Date.now() + config.sync_interval * 1000)
                    : null,
                total_rows: result.recordsProcessed,
                sync_duration_ms: Date.now() - startTime,
                error_count: result.errors.length,
                last_error: result.errors[0] || null,
                updated_at: new Date()
            })
                .where('id', '=', materializationId)
                .execute();
            result.duration = Date.now() - startTime;
            this.emit('materialization:synced', materializationId, result);
            return result;
        }
        catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            // Update error state
            await db
                .updateTable('external_tables')
                .set({
                last_error: errorMessage,
                error_count: db.raw('error_count + 1'),
                updated_at: new Date()
            })
                .where('id', '=', materializationId)
                .execute();
            this.emit('materialization:error', materializationId, error);
            return {
                success: false,
                recordsProcessed: 0,
                recordsInserted: 0,
                recordsUpdated: 0,
                recordsDeleted: 0,
                errors: [errorMessage],
                duration: Date.now() - startTime
            };
        }
        finally {
            this.syncInProgress.delete(materializationId);
        }
    }
    /**
     * Perform full sync
     */
    async performFullSync(config, adapter) {
        const result = {
            success: true,
            recordsProcessed: 0,
            recordsInserted: 0,
            recordsUpdated: 0,
            recordsDeleted: 0,
            errors: [],
            duration: 0
        };
        try {
            // Clear existing data
            if (config.table_id) {
                await db
                    .deleteFrom('cells')
                    .where('sheet_id', 'in', db.selectFrom('sheets')
                    .select('id')
                    .where('spreadsheet_id', '=', config.table_id))
                    .execute();
            }
            // Fetch all data from source
            const sourceData = await adapter.query({
                table: config.external_table,
                schema: config.external_schema
            });
            // Transform and insert data
            for (const record of sourceData) {
                const transformed = await this.transformRecord(record, config.field_mappings, config.transform_rules);
                await this.insertRecord(config.table_id, transformed);
                result.recordsInserted++;
                result.recordsProcessed++;
            }
        }
        catch (error) {
            result.success = false;
            result.errors.push(error instanceof Error ? error.message : 'Unknown error');
        }
        return result;
    }
    /**
     * Perform incremental sync
     */
    async performIncrementalSync(config, adapter, fromTimestamp) {
        const result = {
            success: true,
            recordsProcessed: 0,
            recordsInserted: 0,
            recordsUpdated: 0,
            recordsDeleted: 0,
            errors: [],
            duration: 0
        };
        try {
            const lastSync = fromTimestamp || config.last_sync || new Date(0);
            // Fetch changed data
            const sourceData = await adapter.query({
                table: config.external_table,
                schema: config.external_schema,
                where: {
                    [config.cdc_column || 'updated_at']: { $gt: lastSync }
                },
                orderBy: config.cdc_column || 'updated_at'
            });
            // Process changes
            for (const record of sourceData) {
                const transformed = await this.transformRecord(record, config.field_mappings, config.transform_rules);
                const exists = await this.recordExists(config.table_id, config.external_primary_key, record[config.external_primary_key]);
                if (exists) {
                    await this.updateRecord(config.table_id, config.external_primary_key, record[config.external_primary_key], transformed);
                    result.recordsUpdated++;
                }
                else {
                    await this.insertRecord(config.table_id, transformed);
                    result.recordsInserted++;
                }
                result.recordsProcessed++;
            }
        }
        catch (error) {
            result.success = false;
            result.errors.push(error instanceof Error ? error.message : 'Unknown error');
        }
        return result;
    }
    /**
     * Perform CDC sync
     */
    async performCDCSync(config, adapter) {
        const result = {
            success: true,
            recordsProcessed: 0,
            recordsInserted: 0,
            recordsUpdated: 0,
            recordsDeleted: 0,
            errors: [],
            duration: 0
        };
        try {
            // Get change events from adapter
            const changes = await adapter.getChanges?.({
                table: config.external_table,
                schema: config.external_schema,
                since: config.last_sync
            });
            if (!changes) {
                throw new Error('Adapter does not support CDC');
            }
            // Process each change
            for (const change of changes) {
                result.recordsProcessed++;
                switch (change.type) {
                    case 'INSERT':
                        if (change.after) {
                            const transformed = await this.transformRecord(change.after, config.field_mappings, config.transform_rules);
                            await this.insertRecord(config.table_id, transformed);
                            result.recordsInserted++;
                        }
                        break;
                    case 'UPDATE':
                        if (change.after) {
                            const transformed = await this.transformRecord(change.after, config.field_mappings, config.transform_rules);
                            await this.updateRecord(config.table_id, config.external_primary_key, change.primaryKey, transformed);
                            result.recordsUpdated++;
                        }
                        break;
                    case 'DELETE':
                        await this.deleteRecord(config.table_id, config.external_primary_key, change.primaryKey);
                        result.recordsDeleted++;
                        break;
                }
                this.emit('cdc:event', config.id, change);
            }
        }
        catch (error) {
            result.success = false;
            result.errors.push(error instanceof Error ? error.message : 'Unknown error');
        }
        return result;
    }
    /**
     * Perform upsert sync
     */
    async performUpsertSync(config, adapter) {
        const result = {
            success: true,
            recordsProcessed: 0,
            recordsInserted: 0,
            recordsUpdated: 0,
            recordsDeleted: 0,
            errors: [],
            duration: 0
        };
        try {
            // Fetch all source data
            const sourceData = await adapter.query({
                table: config.external_table,
                schema: config.external_schema
            });
            // Build source key set
            const sourceKeys = new Set(sourceData.map(r => r[config.external_primary_key]));
            // Process upserts
            for (const record of sourceData) {
                const transformed = await this.transformRecord(record, config.field_mappings, config.transform_rules);
                const exists = await this.recordExists(config.table_id, config.external_primary_key, record[config.external_primary_key]);
                if (exists) {
                    await this.updateRecord(config.table_id, config.external_primary_key, record[config.external_primary_key], transformed);
                    result.recordsUpdated++;
                }
                else {
                    await this.insertRecord(config.table_id, transformed);
                    result.recordsInserted++;
                }
                result.recordsProcessed++;
            }
            // Delete records not in source
            const targetKeys = await this.getTargetKeys(config.table_id, config.external_primary_key);
            for (const key of targetKeys) {
                if (!sourceKeys.has(key)) {
                    await this.deleteRecord(config.table_id, config.external_primary_key, key);
                    result.recordsDeleted++;
                }
            }
        }
        catch (error) {
            result.success = false;
            result.errors.push(error instanceof Error ? error.message : 'Unknown error');
        }
        return result;
    }
    /**
     * Perform lazy sync (on-demand)
     */
    async performLazySync(config, adapter) {
        // Lazy sync doesn't actually sync, just marks for sync
        return {
            success: true,
            recordsProcessed: 0,
            recordsInserted: 0,
            recordsUpdated: 0,
            recordsDeleted: 0,
            errors: [],
            duration: 0
        };
    }
    /**
     * Setup CDC listener
     */
    async setupCDC(materializationId) {
        const config = await this.loadMaterializationConfig(materializationId);
        if (!config)
            return;
        const adapter = await this.getAdapter(config.data_source_id);
        if (adapter.subscribeToCDC) {
            const listener = await adapter.subscribeToCDC({
                table: config.external_table,
                schema: config.external_schema,
                callback: async (change) => {
                    await this.handleCDCEvent(materializationId, change);
                }
            });
            this.cdcListeners.set(materializationId, listener);
            this.emit('cdc:subscribed', materializationId);
        }
    }
    /**
     * Handle CDC event
     */
    async handleCDCEvent(materializationId, change) {
        const config = await this.loadMaterializationConfig(materializationId);
        if (!config)
            return;
        switch (change.type) {
            case 'INSERT':
                if (change.after) {
                    const transformed = await this.transformRecord(change.after, config.field_mappings, config.transform_rules);
                    await this.insertRecord(config.table_id, transformed);
                }
                break;
            case 'UPDATE':
                if (change.after) {
                    const transformed = await this.transformRecord(change.after, config.field_mappings, config.transform_rules);
                    await this.updateRecord(config.table_id, config.external_primary_key, change.primaryKey, transformed);
                }
                break;
            case 'DELETE':
                await this.deleteRecord(config.table_id, config.external_primary_key, change.primaryKey);
                break;
        }
        this.emit('cdc:processed', materializationId, change);
    }
    /**
     * Schedule periodic sync
     */
    scheduleSync(materializationId, intervalSeconds) {
        // Convert seconds to cron pattern
        const cronPattern = intervalSeconds < 60
            ? `*/${intervalSeconds} * * * * *` // Every N seconds
            : intervalSeconds < 3600
                ? `0 */${Math.floor(intervalSeconds / 60)} * * * *` // Every N minutes
                : `0 0 */${Math.floor(intervalSeconds / 3600)} * * *`; // Every N hours
        const job = new CronJob(cronPattern, async () => {
            await this.executeMaterialization(materializationId);
        });
        job.start();
        this.syncJobs.set(materializationId, job);
        this.emit('sync:scheduled', materializationId, cronPattern);
    }
    /**
     * Get data source adapter
     */
    async getAdapter(dataSourceId) {
        let adapter = this.adapters.get(dataSourceId);
        if (adapter)
            return adapter;
        const dataSource = await db
            .selectFrom('data_sources')
            .selectAll()
            .where('id', '=', dataSourceId)
            .executeTakeFirst();
        if (!dataSource) {
            throw new Error(`Data source ${dataSourceId} not found`);
        }
        // Create adapter based on type
        switch (dataSource.type) {
            case 'POSTGRES':
                adapter = new PostgresAdapter(dataSource.connection_config);
                break;
            case 'MYSQL':
                adapter = new MySQLAdapter(dataSource.connection_config);
                break;
            case 'MONGODB':
                adapter = new MongoDBAdapter(dataSource.connection_config);
                break;
            case 'HTTP':
                adapter = new HTTPAdapter(dataSource.connection_config);
                break;
            default:
                throw new Error(`Unsupported data source type: ${dataSource.type}`);
        }
        await adapter.connect();
        this.adapters.set(dataSourceId, adapter);
        return adapter;
    }
    /**
     * Load materialization configuration
     */
    async loadMaterializationConfig(id) {
        return await db
            .selectFrom('external_tables')
            .selectAll()
            .where('id', '=', id)
            .executeTakeFirst();
    }
    /**
     * Transform record based on rules
     */
    async transformRecord(record, fieldMappings, rules) {
        let transformed = {};
        // Apply field mappings
        for (const [source, target] of Object.entries(fieldMappings)) {
            transformed[target] = record[source];
        }
        // Apply transform rules
        if (rules) {
            for (const rule of rules) {
                transformed = await this.applyTransformRule(transformed, rule);
            }
        }
        return transformed;
    }
    /**
     * Apply a transform rule
     */
    async applyTransformRule(record, rule) {
        switch (rule.type) {
            case 'RENAME':
                record[rule.config.newName] = record[rule.field];
                delete record[rule.field];
                break;
            case 'CAST':
                record[rule.field] = this.castValue(record[rule.field], rule.config.type);
                break;
            case 'FORMULA':
                record[rule.field] = await this.evaluateFormula(record, rule.config.formula);
                break;
            case 'LOOKUP':
                record[rule.field] = await this.lookupValue(record[rule.field], rule.config.table, rule.config.key, rule.config.value);
                break;
            case 'AGGREGATE':
                record[rule.field] = await this.aggregateValue(record, rule.config.function, rule.config.fields);
                break;
        }
        return record;
    }
    /**
     * Helper methods for data operations
     */
    async recordExists(tableId, keyField, keyValue) {
        // Implementation depends on target table structure
        return false;
    }
    async insertRecord(tableId, record) {
        // Implementation depends on target table structure
    }
    async updateRecord(tableId, keyField, keyValue, record) {
        // Implementation depends on target table structure
    }
    async deleteRecord(tableId, keyField, keyValue) {
        // Implementation depends on target table structure
    }
    async getTargetKeys(tableId, keyField) {
        // Implementation depends on target table structure
        return [];
    }
    castValue(value, type) {
        switch (type) {
            case 'string': return String(value);
            case 'number': return Number(value);
            case 'boolean': return Boolean(value);
            case 'date': return new Date(value);
            case 'json': return JSON.parse(value);
            default: return value;
        }
    }
    async evaluateFormula(record, formula) {
        // Simple formula evaluation
        // In production, use a proper formula engine
        return eval(formula);
    }
    async lookupValue(key, table, keyField, valueField) {
        // Lookup value from another table
        const result = await db
            .selectFrom(table)
            .select(valueField)
            .where(keyField, '=', key)
            .executeTakeFirst();
        return result?.[valueField];
    }
    async aggregateValue(record, func, fields) {
        const values = fields.map(f => record[f]).filter(v => v !== undefined);
        switch (func) {
            case 'SUM': return values.reduce((a, b) => a + b, 0);
            case 'AVG': return values.reduce((a, b) => a + b, 0) / values.length;
            case 'MIN': return Math.min(...values);
            case 'MAX': return Math.max(...values);
            case 'COUNT': return values.length;
            case 'CONCAT': return values.join('');
            default: return null;
        }
    }
    /**
     * Cleanup and shutdown
     */
    async shutdown() {
        // Stop all sync jobs
        for (const job of this.syncJobs.values()) {
            job.stop();
        }
        // Unsubscribe from CDC
        for (const listener of this.cdcListeners.values()) {
            if (listener && listener.unsubscribe) {
                await listener.unsubscribe();
            }
        }
        // Disconnect adapters
        for (const adapter of this.adapters.values()) {
            await adapter.disconnect();
        }
        this.emit('shutdown');
    }
}
// Export singleton instance
export const dataMaterializationService = new DataMaterializationService();
//# sourceMappingURL=DataMaterializationService.js.map