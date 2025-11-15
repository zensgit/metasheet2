"use strict";
/**
 * Elasticsearch Data Source Adapter
 * Provides access to Elasticsearch search engine
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ElasticsearchAdapter = void 0;
const BaseAdapter_1 = require("./BaseAdapter");
const elasticsearch_1 = require("@elastic/elasticsearch");
class ElasticsearchAdapter extends BaseAdapter_1.DataSourceAdapter {
    client = null;
    config;
    constructor(config) {
        super();
        this.config = config;
    }
    async connect() {
        try {
            const clientConfig = {
                node: this.config.node,
                maxRetries: this.config.maxRetries || 3,
                requestTimeout: this.config.requestTimeout || 30000,
                sniffOnStart: this.config.sniffOnStart
            };
            if (this.config.auth) {
                clientConfig.auth = this.config.auth;
            }
            if (this.config.apiKey) {
                clientConfig.auth = { apiKey: this.config.apiKey };
            }
            if (this.config.cloudId) {
                clientConfig.cloud = { id: this.config.cloudId };
            }
            if (this.config.ssl) {
                clientConfig.ssl = this.config.ssl;
            }
            this.client = new elasticsearch_1.Client(clientConfig);
            // Test connection
            await this.client.ping();
            this.emit('connected');
        }
        catch (error) {
            this.emit('error', error);
            throw error;
        }
    }
    async disconnect() {
        if (this.client) {
            await this.client.close();
            this.client = null;
            this.emit('disconnected');
        }
    }
    async query(params) {
        if (!this.client) {
            throw new Error('Elasticsearch client not connected');
        }
        try {
            const index = params.table || '_all';
            const size = params.limit || 100;
            const from = params.offset || 0;
            // Build Elasticsearch query
            const body = {
                size,
                from
            };
            // Convert where clause to Elasticsearch query
            if (params.where) {
                body.query = this.buildElasticsearchQuery(params.where);
            }
            // Add sorting
            if (params.orderBy) {
                body.sort = Array.isArray(params.orderBy)
                    ? params.orderBy.map(field => ({ [field]: 'asc' }))
                    : [{ [params.orderBy]: 'asc' }];
            }
            // Add aggregations if specified
            if (params.groupBy) {
                body.aggs = this.buildAggregations(params.groupBy, params.select);
            }
            // Execute search
            const response = await this.client.search({
                index,
                body
            });
            // Process results
            const results = [];
            if (response.hits?.hits) {
                for (const hit of response.hits.hits) {
                    results.push({
                        _id: hit._id,
                        _index: hit._index,
                        _score: hit._score,
                        ...hit._source
                    });
                }
            }
            // Process aggregation results if present
            if (response.aggregations) {
                const aggResults = this.processAggregations(response.aggregations);
                results.push(...aggResults);
            }
            return results;
        }
        catch (error) {
            this.emit('error', error);
            throw error;
        }
    }
    async execute(command, args) {
        if (!this.client) {
            throw new Error('Elasticsearch client not connected');
        }
        try {
            // Parse DSL query
            const query = typeof command === 'string' ? JSON.parse(command) : command;
            // Execute based on operation type
            if (query.search) {
                return await this.client.search(query.search);
            }
            if (query.index) {
                return await this.client.index(query.index);
            }
            if (query.update) {
                return await this.client.update(query.update);
            }
            if (query.delete) {
                return await this.client.delete(query.delete);
            }
            if (query.bulk) {
                return await this.client.bulk(query.bulk);
            }
            if (query.sql) {
                return await this.executeSQLQuery(query.sql);
            }
            throw new Error('Unsupported Elasticsearch operation');
        }
        catch (error) {
            this.emit('error', error);
            throw error;
        }
    }
    async getSchema() {
        if (!this.client) {
            throw new Error('Elasticsearch client not connected');
        }
        try {
            // Get all indices
            const indices = await this.client.indices.getMapping();
            const tables = [];
            for (const [indexName, indexData] of Object.entries(indices)) {
                const mappings = indexData.mappings;
                const properties = mappings.properties || {};
                const columns = Object.entries(properties).map(([field, config]) => ({
                    name: field,
                    type: this.mapElasticsearchType(config.type),
                    nullable: true,
                    indexed: config.index !== false,
                    analyzed: config.type === 'text'
                }));
                tables.push({
                    name: indexName,
                    columns,
                    primaryKey: '_id',
                    indexes: Object.keys(properties).filter(field => properties[field].index !== false),
                    foreignKeys: []
                });
            }
            // Get aliases as views
            const aliases = await this.client.indices.getAlias();
            const views = Object.keys(aliases).map(alias => ({
                name: alias,
                definition: `Alias for indices`,
                columns: []
            }));
            return {
                tables,
                views,
                routines: []
            };
        }
        catch (error) {
            this.emit('error', error);
            throw error;
        }
    }
    async testConnection() {
        if (!this.client) {
            await this.connect();
        }
        try {
            const response = await this.client.ping();
            return response.statusCode === 200;
        }
        catch {
            return false;
        }
    }
    /**
     * Build Elasticsearch query from where clause
     */
    buildElasticsearchQuery(where) {
        const must = [];
        const mustNot = [];
        const should = [];
        const filter = [];
        for (const [field, value] of Object.entries(where)) {
            if (typeof value === 'object' && value !== null) {
                // Handle operators
                if ('$gt' in value) {
                    filter.push({ range: { [field]: { gt: value.$gt } } });
                }
                if ('$gte' in value) {
                    filter.push({ range: { [field]: { gte: value.$gte } } });
                }
                if ('$lt' in value) {
                    filter.push({ range: { [field]: { lt: value.$lt } } });
                }
                if ('$lte' in value) {
                    filter.push({ range: { [field]: { lte: value.$lte } } });
                }
                if ('$ne' in value) {
                    mustNot.push({ term: { [field]: value.$ne } });
                }
                if ('$in' in value) {
                    should.push({ terms: { [field]: value.$in } });
                }
                if ('$nin' in value) {
                    mustNot.push({ terms: { [field]: value.$nin } });
                }
                if ('$regex' in value) {
                    must.push({ regexp: { [field]: value.$regex } });
                }
                if ('$text' in value) {
                    must.push({ match: { [field]: value.$text } });
                }
                if ('$exists' in value) {
                    if (value.$exists) {
                        filter.push({ exists: { field } });
                    }
                    else {
                        mustNot.push({ exists: { field } });
                    }
                }
            }
            else {
                // Exact match
                filter.push({ term: { [field]: value } });
            }
        }
        // Build bool query
        const bool = {};
        if (must.length > 0)
            bool.must = must;
        if (mustNot.length > 0)
            bool.must_not = mustNot;
        if (should.length > 0)
            bool.should = should;
        if (filter.length > 0)
            bool.filter = filter;
        return Object.keys(bool).length > 0 ? { bool } : { match_all: {} };
    }
    /**
     * Build aggregations
     */
    buildAggregations(groupBy, select) {
        const aggs = {};
        const fields = Array.isArray(groupBy) ? groupBy : [groupBy];
        let currentAgg = aggs;
        // Build nested aggregations for multiple group by fields
        for (let i = 0; i < fields.length; i++) {
            const field = fields[i];
            const aggName = `group_by_${field}`;
            currentAgg[aggName] = {
                terms: {
                    field,
                    size: 10000
                }
            };
            if (i < fields.length - 1) {
                currentAgg[aggName].aggs = {};
                currentAgg = currentAgg[aggName].aggs;
            }
        }
        // Add metrics aggregations
        if (select) {
            for (const col of select) {
                const match = col.match(/(\w+)\((.+)\)/);
                if (match) {
                    const [, func, field] = match;
                    const aggName = `${func}_${field}`.toLowerCase();
                    switch (func.toUpperCase()) {
                        case 'COUNT':
                            currentAgg[aggName] = { value_count: { field } };
                            break;
                        case 'SUM':
                            currentAgg[aggName] = { sum: { field } };
                            break;
                        case 'AVG':
                            currentAgg[aggName] = { avg: { field } };
                            break;
                        case 'MIN':
                            currentAgg[aggName] = { min: { field } };
                            break;
                        case 'MAX':
                            currentAgg[aggName] = { max: { field } };
                            break;
                        case 'STATS':
                            currentAgg[aggName] = { stats: { field } };
                            break;
                    }
                }
            }
        }
        return aggs;
    }
    /**
     * Process aggregation results
     */
    processAggregations(aggregations) {
        const results = [];
        const processAgg = (agg, parentKey) => {
            for (const [key, value] of Object.entries(agg)) {
                if (value.buckets) {
                    // Terms aggregation
                    for (const bucket of value.buckets) {
                        const result = {};
                        if (parentKey)
                            result[parentKey] = bucket.key;
                        result[key] = bucket.key;
                        result.doc_count = bucket.doc_count;
                        // Process nested aggregations
                        const nestedResults = {};
                        for (const [nestedKey, nestedValue] of Object.entries(bucket)) {
                            if (nestedKey !== 'key' && nestedKey !== 'doc_count') {
                                if (nestedValue.value !== undefined) {
                                    nestedResults[nestedKey] = nestedValue.value;
                                }
                                else if (nestedValue.buckets) {
                                    // Recursive processing
                                    processAgg({ [nestedKey]: nestedValue }, key);
                                }
                            }
                        }
                        results.push({ ...result, ...nestedResults });
                    }
                }
                else if (value.value !== undefined) {
                    // Metric aggregation
                    results.push({ [key]: value.value });
                }
            }
        };
        processAgg(aggregations);
        return results;
    }
    /**
     * Execute SQL query using Elasticsearch SQL
     */
    async executeSQLQuery(sql) {
        if (!this.client) {
            throw new Error('Elasticsearch client not connected');
        }
        const response = await this.client.sql.query({
            body: {
                query: sql
            }
        });
        // Convert SQL response to standard format
        const columns = response.columns || [];
        const rows = response.rows || [];
        return rows.map((row) => {
            const result = {};
            columns.forEach((col, index) => {
                result[col.name] = row[index];
            });
            return result;
        });
    }
    /**
     * Map Elasticsearch type to generic type
     */
    mapElasticsearchType(esType) {
        switch (esType) {
            case 'text':
            case 'keyword':
                return 'string';
            case 'long':
            case 'integer':
            case 'short':
            case 'byte':
                return 'integer';
            case 'double':
            case 'float':
            case 'half_float':
                return 'float';
            case 'boolean':
                return 'boolean';
            case 'date':
                return 'datetime';
            case 'object':
            case 'nested':
                return 'json';
            case 'geo_point':
            case 'geo_shape':
                return 'geometry';
            default:
                return 'any';
        }
    }
    /**
     * Elasticsearch-specific methods
     */
    async createIndex(name, settings, mappings) {
        if (!this.client) {
            throw new Error('Elasticsearch client not connected');
        }
        return await this.client.indices.create({
            index: name,
            body: {
                settings,
                mappings
            }
        });
    }
    async deleteIndex(name) {
        if (!this.client) {
            throw new Error('Elasticsearch client not connected');
        }
        return await this.client.indices.delete({
            index: name
        });
    }
    async indexDocument(index, document, id) {
        if (!this.client) {
            throw new Error('Elasticsearch client not connected');
        }
        return await this.client.index({
            index,
            id,
            body: document
        });
    }
    async bulkIndex(operations) {
        if (!this.client) {
            throw new Error('Elasticsearch client not connected');
        }
        return await this.client.bulk({
            body: operations
        });
    }
    async searchWithHighlight(index, query, fields) {
        if (!this.client) {
            throw new Error('Elasticsearch client not connected');
        }
        return await this.client.search({
            index,
            body: {
                query,
                highlight: {
                    fields: fields.reduce((acc, field) => {
                        acc[field] = {};
                        return acc;
                    }, {})
                }
            }
        });
    }
    async aggregate(index, aggregations) {
        if (!this.client) {
            throw new Error('Elasticsearch client not connected');
        }
        return await this.client.search({
            index,
            body: {
                size: 0,
                aggs: aggregations
            }
        });
    }
}
exports.ElasticsearchAdapter = ElasticsearchAdapter;
//# sourceMappingURL=ElasticsearchAdapter.js.map