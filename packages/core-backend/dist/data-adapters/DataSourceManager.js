import { EventEmitter } from 'eventemitter3';
import { PostgresAdapter } from './PostgresAdapter';
import { MySQLAdapter } from './MySQLAdapter';
import { HTTPAdapter } from './HTTPAdapter';
import { MongoDBAdapter } from './MongoDBAdapter';
export class DataSourceManager extends EventEmitter {
    adapters = new Map();
    adapterTypes = new Map();
    connectionPool = new Map();
    constructor() {
        super();
        this.registerDefaultAdapters();
    }
    registerDefaultAdapters() {
        this.registerAdapterType('postgresql', PostgresAdapter);
        this.registerAdapterType('postgres', PostgresAdapter);
        this.registerAdapterType('mysql', MySQLAdapter);
        this.registerAdapterType('http', HTTPAdapter);
        this.registerAdapterType('mongodb', MongoDBAdapter);
    }
    registerAdapterType(type, adapterClass) {
        this.adapterTypes.set(type.toLowerCase(), adapterClass);
    }
    async addDataSource(config) {
        if (this.adapters.has(config.id)) {
            throw new Error(`Data source with id '${config.id}' already exists`);
        }
        const AdapterClass = this.adapterTypes.get(config.type.toLowerCase());
        if (!AdapterClass) {
            throw new Error(`Unsupported data source type: ${config.type}`);
        }
        const adapter = new AdapterClass(config);
        // Set up event forwarding
        adapter.on('connected', (data) => this.emit('adapter:connected', { ...data, id: config.id }));
        adapter.on('disconnected', (data) => this.emit('adapter:disconnected', { ...data, id: config.id }));
        adapter.on('error', (data) => this.emit('adapter:error', { ...data, id: config.id }));
        this.adapters.set(config.id, adapter);
        // Auto-connect if specified
        if (config.options?.autoConnect !== false) {
            await this.connectDataSource(config.id);
        }
        return adapter;
    }
    async removeDataSource(id) {
        const adapter = this.adapters.get(id);
        if (!adapter) {
            throw new Error(`Data source with id '${id}' not found`);
        }
        if (adapter.isConnected()) {
            await adapter.disconnect();
        }
        adapter.removeAllListeners();
        this.adapters.delete(id);
        this.connectionPool.delete(id);
    }
    getDataSource(id) {
        const adapter = this.adapters.get(id);
        if (!adapter) {
            throw new Error(`Data source with id '${id}' not found`);
        }
        return adapter;
    }
    async connectDataSource(id) {
        const adapter = this.getDataSource(id);
        // Reuse existing connection promise if connecting
        let connectionPromise = this.connectionPool.get(id);
        if (connectionPromise) {
            return connectionPromise;
        }
        connectionPromise = adapter.connect();
        this.connectionPool.set(id, connectionPromise);
        try {
            await connectionPromise;
        }
        finally {
            this.connectionPool.delete(id);
        }
    }
    async disconnectDataSource(id) {
        const adapter = this.getDataSource(id);
        await adapter.disconnect();
    }
    async testConnection(id) {
        const adapter = this.getDataSource(id);
        return adapter.testConnection();
    }
    // Query routing methods
    async query(dataSourceId, sql, params) {
        const adapter = this.getDataSource(dataSourceId);
        if (!adapter.isConnected()) {
            await this.connectDataSource(dataSourceId);
        }
        return adapter.query(sql, params);
    }
    async select(dataSourceId, table, options) {
        const adapter = this.getDataSource(dataSourceId);
        if (!adapter.isConnected()) {
            await this.connectDataSource(dataSourceId);
        }
        return adapter.select(table, options);
    }
    async insert(dataSourceId, table, data) {
        const adapter = this.getDataSource(dataSourceId);
        if (!adapter.isConnected()) {
            await this.connectDataSource(dataSourceId);
        }
        return adapter.insert(table, data);
    }
    async update(dataSourceId, table, data, where) {
        const adapter = this.getDataSource(dataSourceId);
        if (!adapter.isConnected()) {
            await this.connectDataSource(dataSourceId);
        }
        return adapter.update(table, data, where);
    }
    async delete(dataSourceId, table, where) {
        const adapter = this.getDataSource(dataSourceId);
        if (!adapter.isConnected()) {
            await this.connectDataSource(dataSourceId);
        }
        return adapter.delete(table, where);
    }
    // Cross-database operations
    async copyData(sourceId, sourceTable, targetId, targetTable, options) {
        const startTime = Date.now();
        const sourceAdapter = this.getDataSource(sourceId);
        const targetAdapter = this.getDataSource(targetId);
        if (!sourceAdapter.isConnected()) {
            await this.connectDataSource(sourceId);
        }
        if (!targetAdapter.isConnected()) {
            await this.connectDataSource(targetId);
        }
        const batchSize = options?.batchSize || 1000;
        let offset = 0;
        let totalRows = 0;
        while (true) {
            const result = await sourceAdapter.select(sourceTable, {
                where: options?.where,
                limit: batchSize,
                offset
            });
            if (result.data.length === 0) {
                break;
            }
            let data = result.data;
            if (options?.transform) {
                data = data.map(options.transform);
            }
            await targetAdapter.insert(targetTable, data);
            totalRows += data.length;
            offset += batchSize;
            this.emit('copy:progress', {
                sourceId,
                targetId,
                totalRows,
                currentBatch: data.length
            });
        }
        const duration = Date.now() - startTime;
        return { totalRows, duration };
    }
    // Federation query (simple JOIN across databases)
    async federatedQuery(queries, joinLogic) {
        const results = new Map();
        // Execute queries in parallel
        const promises = queries.map(async ({ dataSourceId, sql, params, alias }) => {
            const adapter = this.getDataSource(dataSourceId);
            if (!adapter.isConnected()) {
                await this.connectDataSource(dataSourceId);
            }
            const result = await adapter.query(sql, params);
            results.set(alias, result.data);
        });
        await Promise.all(promises);
        // Apply join logic if provided, otherwise return concatenated results
        if (joinLogic) {
            return joinLogic(results);
        }
        // Default: concatenate all results
        const allResults = [];
        for (const data of results.values()) {
            allResults.push(...data);
        }
        return allResults;
    }
    // Management methods
    listDataSources() {
        const sources = [];
        for (const [id, adapter] of this.adapters) {
            sources.push({
                id,
                name: adapter.getName(),
                type: adapter.getType(),
                connected: adapter.isConnected()
            });
        }
        return sources;
    }
    async healthCheck() {
        const health = new Map();
        for (const [id, adapter] of this.adapters) {
            const startTime = Date.now();
            const connected = adapter.isConnected();
            let responsive = false;
            if (connected) {
                try {
                    responsive = await adapter.testConnection();
                }
                catch {
                    responsive = false;
                }
            }
            health.set(id, {
                connected,
                responsive,
                latency: connected ? Date.now() - startTime : undefined
            });
        }
        return health;
    }
    async disconnectAll() {
        const promises = [];
        for (const [id, adapter] of this.adapters) {
            if (adapter.isConnected()) {
                promises.push(adapter.disconnect());
            }
        }
        await Promise.all(promises);
    }
    async dispose() {
        await this.disconnectAll();
        this.adapters.clear();
        this.adapterTypes.clear();
        this.connectionPool.clear();
        this.removeAllListeners();
    }
}
//# sourceMappingURL=DataSourceManager.js.map