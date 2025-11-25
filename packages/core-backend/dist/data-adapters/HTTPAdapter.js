import axios from 'axios';
import { BaseDataAdapter } from './BaseAdapter';
export class HTTPAdapter extends BaseDataAdapter {
    client = null;
    endpoints = new Map();
    async connect() {
        if (this.connected) {
            return;
        }
        try {
            const baseURL = this.config.connection.baseURL || this.config.connection.url;
            this.client = axios.create({
                baseURL,
                timeout: this.config.options?.timeout || 30000,
                headers: {
                    'Content-Type': 'application/json',
                    ...this.config.connection.headers
                }
            });
            // Add auth if provided
            if (this.config.credentials) {
                if (this.config.credentials.apiKey) {
                    this.client.defaults.headers.common['X-API-Key'] = this.config.credentials.apiKey;
                }
                else if (this.config.credentials.bearerToken) {
                    this.client.defaults.headers.common['Authorization'] = `Bearer ${this.config.credentials.bearerToken}`;
                }
                else if (this.config.credentials.username && this.config.credentials.password) {
                    this.client.defaults.auth = {
                        username: this.config.credentials.username,
                        password: this.config.credentials.password
                    };
                }
            }
            // Add request interceptor for logging
            this.client.interceptors.request.use((config) => {
                this.emit('request', { method: config.method, url: config.url });
                return config;
            }, (error) => {
                this.emit('error', { error });
                return Promise.reject(error);
            });
            // Add response interceptor for error handling
            this.client.interceptors.response.use((response) => {
                this.emit('response', { status: response.status, url: response.config.url });
                return response;
            }, (error) => {
                this.emit('error', { error });
                return Promise.reject(error);
            });
            // Register predefined endpoints if provided
            if (this.config.options?.endpoints) {
                for (const [name, endpoint] of Object.entries(this.config.options.endpoints)) {
                    this.registerEndpoint(name, endpoint);
                }
            }
            this.connected = true;
            await this.onConnect();
        }
        catch (error) {
            await this.onError(error);
            throw new Error(`Failed to initialize HTTP adapter: ${error}`);
        }
    }
    async disconnect() {
        this.client = null;
        this.endpoints.clear();
        this.connected = false;
        await this.onDisconnect();
    }
    isConnected() {
        return this.connected && this.client !== null;
    }
    async testConnection() {
        if (!this.client) {
            return false;
        }
        try {
            const healthEndpoint = this.config.options?.healthCheckEndpoint || '/health';
            const response = await this.client.get(healthEndpoint);
            return response.status >= 200 && response.status < 300;
        }
        catch {
            // Try a HEAD request to base URL as fallback
            try {
                const response = await this.client.head('/');
                return response.status >= 200 && response.status < 300;
            }
            catch {
                return false;
            }
        }
    }
    registerEndpoint(name, config) {
        this.endpoints.set(name, config);
    }
    async query(endpoint, params) {
        if (!this.client) {
            throw new Error('HTTP client not initialized');
        }
        try {
            // Check if it's a registered endpoint
            const endpointConfig = this.endpoints.get(endpoint);
            if (endpointConfig) {
                const requestConfig = {
                    url: endpointConfig.url,
                    method: endpointConfig.method,
                    headers: endpointConfig.headers
                };
                // Apply request transformation if provided
                if (params && endpointConfig.transformRequest) {
                    requestConfig.data = endpointConfig.transformRequest(params);
                }
                else if (params) {
                    if (['GET', 'DELETE'].includes(endpointConfig.method.toUpperCase())) {
                        requestConfig.params = params[0];
                    }
                    else {
                        requestConfig.data = params[0];
                    }
                }
                const response = await this.client.request(requestConfig);
                // Apply response transformation if provided
                const data = endpointConfig.transformResponse
                    ? endpointConfig.transformResponse(response.data)
                    : response.data;
                return {
                    data: Array.isArray(data) ? data : [data],
                    metadata: {
                        totalCount: Array.isArray(data) ? data.length : 1,
                        columns: this.extractColumns(data)
                    }
                };
            }
            // Direct endpoint call
            const response = await this.client.get(endpoint, { params: params?.[0] });
            const data = response.data;
            return {
                data: Array.isArray(data) ? data : [data],
                metadata: {
                    totalCount: Array.isArray(data) ? data.length : 1,
                    columns: this.extractColumns(data)
                }
            };
        }
        catch (error) {
            return {
                data: [],
                error: error
            };
        }
    }
    async select(endpoint, options) {
        if (!this.client) {
            throw new Error('HTTP client not initialized');
        }
        try {
            const method = options?.method || 'GET';
            const url = options?.endpoint || endpoint;
            const requestConfig = {
                url,
                method,
                headers: options?.headers,
                params: options?.params || options?.where,
                data: options?.data
            };
            // Handle pagination
            if (options?.limit) {
                requestConfig.params = {
                    ...requestConfig.params,
                    limit: options.limit,
                    offset: options.offset || 0
                };
            }
            // Handle ordering
            if (options?.orderBy?.length) {
                const sortParams = options.orderBy.map(o => `${o.column}:${o.direction}`).join(',');
                requestConfig.params = {
                    ...requestConfig.params,
                    sort: sortParams
                };
            }
            const response = await this.client.request(requestConfig);
            const data = response.data;
            // Handle paginated responses
            let resultData = data;
            let totalCount = undefined;
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                // Check for common pagination patterns
                if ('data' in data) {
                    resultData = data.data;
                }
                else if ('items' in data) {
                    resultData = data.items;
                }
                else if ('results' in data) {
                    resultData = data.results;
                }
                // Extract total count if available
                if ('total' in data) {
                    totalCount = data.total;
                }
                else if ('count' in data) {
                    totalCount = data.count;
                }
                else if ('totalCount' in data) {
                    totalCount = data.totalCount;
                }
            }
            return {
                data: Array.isArray(resultData) ? resultData : [resultData],
                metadata: {
                    totalCount: totalCount || (Array.isArray(resultData) ? resultData.length : 1),
                    columns: this.extractColumns(resultData)
                }
            };
        }
        catch (error) {
            return {
                data: [],
                error: error
            };
        }
    }
    async insert(endpoint, data) {
        if (!this.client) {
            throw new Error('HTTP client not initialized');
        }
        try {
            const response = await this.client.post(endpoint, data);
            const responseData = response.data;
            return {
                data: Array.isArray(responseData) ? responseData : [responseData],
                metadata: {
                    totalCount: Array.isArray(responseData) ? responseData.length : 1
                }
            };
        }
        catch (error) {
            return {
                data: [],
                error: error
            };
        }
    }
    async update(endpoint, data, where) {
        if (!this.client) {
            throw new Error('HTTP client not initialized');
        }
        try {
            // For REST APIs, typically update by ID
            const id = where.id || where._id;
            const url = id ? `${endpoint}/${id}` : endpoint;
            const response = await this.client.put(url, data, {
                params: id ? undefined : where
            });
            const responseData = response.data;
            return {
                data: Array.isArray(responseData) ? responseData : [responseData],
                metadata: {
                    totalCount: Array.isArray(responseData) ? responseData.length : 1
                }
            };
        }
        catch (error) {
            return {
                data: [],
                error: error
            };
        }
    }
    async delete(endpoint, where) {
        if (!this.client) {
            throw new Error('HTTP client not initialized');
        }
        try {
            // For REST APIs, typically delete by ID
            const id = where.id || where._id;
            const url = id ? `${endpoint}/${id}` : endpoint;
            const response = await this.client.delete(url, {
                params: id ? undefined : where
            });
            const responseData = response.data;
            return {
                data: Array.isArray(responseData) ? responseData : [responseData],
                metadata: {
                    totalCount: Array.isArray(responseData) ? responseData.length : 1
                }
            };
        }
        catch (error) {
            return {
                data: [],
                error: error
            };
        }
    }
    // Schema operations (limited for HTTP)
    async getSchema(schema) {
        // HTTP APIs typically don't expose schema information
        // This could be implemented for specific APIs that provide metadata endpoints
        return {
            tables: []
        };
    }
    async getTableInfo(table, schema) {
        // Would need API-specific implementation
        return {
            name: table,
            schema,
            columns: []
        };
    }
    async getColumns(table, schema) {
        // Would need API-specific implementation
        return [];
    }
    async tableExists(table, schema) {
        // Try to access the endpoint
        try {
            const response = await this.client.head(table);
            return response.status < 400;
        }
        catch {
            return false;
        }
    }
    // Transaction support (not applicable for HTTP)
    async beginTransaction() {
        throw new Error('Transactions not supported in HTTP adapter');
    }
    async commit(transaction) {
        throw new Error('Transactions not supported in HTTP adapter');
    }
    async rollback(transaction) {
        throw new Error('Transactions not supported in HTTP adapter');
    }
    async inTransaction(transaction, callback) {
        // Just execute the callback without transaction support
        return callback();
    }
    async *stream(endpoint, params, options) {
        if (!this.client) {
            throw new Error('HTTP client not initialized');
        }
        // Implement pagination-based streaming
        let page = 0;
        const pageSize = options?.highWaterMark || 100;
        while (true) {
            const response = await this.client.get(endpoint, {
                params: {
                    ...params?.[0],
                    page,
                    limit: pageSize
                }
            });
            const data = response.data;
            const items = Array.isArray(data) ? data : (data.data || data.items || data.results || []);
            if (items.length === 0) {
                break;
            }
            for (const item of items) {
                yield item;
            }
            // Check if there are more pages
            if (items.length < pageSize) {
                break;
            }
            page++;
        }
    }
    // Helper methods
    extractColumns(data) {
        if (!data)
            return [];
        const sample = Array.isArray(data) ? data[0] : data;
        if (!sample || typeof sample !== 'object')
            return [];
        return Object.keys(sample).map(key => ({
            name: key,
            type: typeof sample[key],
            nullable: sample[key] === null || sample[key] === undefined
        }));
    }
    // Batch operations using HTTP
    async batchRequest(requests) {
        if (!this.client) {
            throw new Error('HTTP client not initialized');
        }
        const results = [];
        // Execute requests in parallel with concurrency control
        const concurrency = this.config.options?.batchConcurrency || 5;
        const chunks = [];
        for (let i = 0; i < requests.length; i += concurrency) {
            chunks.push(requests.slice(i, i + concurrency));
        }
        for (const chunk of chunks) {
            const promises = chunk.map(async (req) => {
                try {
                    const response = await this.client.request({
                        method: req.method,
                        url: req.endpoint,
                        data: req.data,
                        params: req.params
                    });
                    return {
                        data: Array.isArray(response.data) ? response.data : [response.data]
                    };
                }
                catch (error) {
                    return {
                        data: [],
                        error: error
                    };
                }
            });
            const chunkResults = await Promise.all(promises);
            results.push(...chunkResults);
        }
        return results;
    }
}
//# sourceMappingURL=HTTPAdapter.js.map