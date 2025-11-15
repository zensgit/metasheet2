"use strict";
/**
 * Redis Data Source Adapter
 * Provides access to Redis key-value store
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisAdapter = void 0;
const BaseAdapter_1 = require("./BaseAdapter");
const redis = __importStar(require("redis"));
class RedisAdapter extends BaseAdapter_1.DataSourceAdapter {
    client = null;
    config;
    constructor(config) {
        super();
        this.config = config;
    }
    async connect() {
        try {
            this.client = redis.createClient({
                socket: {
                    host: this.config.host,
                    port: this.config.port
                },
                password: this.config.password,
                database: this.config.database
            });
            await this.client.connect();
            this.emit('connected');
        }
        catch (error) {
            this.emit('error', error);
            throw error;
        }
    }
    async disconnect() {
        if (this.client) {
            await this.client.quit();
            this.client = null;
            this.emit('disconnected');
        }
    }
    async query(params) {
        if (!this.client) {
            throw new Error('Redis client not connected');
        }
        const results = [];
        try {
            // Handle different Redis query patterns
            if (params.table) {
                // Pattern-based key search
                const pattern = this.config.keyPrefix
                    ? `${this.config.keyPrefix}:${params.table}:*`
                    : `${params.table}:*`;
                const keys = await this.client.keys(pattern);
                // Fetch values for each key
                for (const key of keys) {
                    const type = await this.client.type(key);
                    let value;
                    switch (type) {
                        case 'string':
                            value = await this.client.get(key);
                            // Try to parse JSON
                            try {
                                value = JSON.parse(value);
                            }
                            catch { }
                            break;
                        case 'hash':
                            value = await this.client.hGetAll(key);
                            break;
                        case 'list':
                            value = await this.client.lRange(key, 0, -1);
                            break;
                        case 'set':
                            value = await this.client.sMembers(key);
                            break;
                        case 'zset':
                            value = await this.client.zRange(key, 0, -1, { WITHSCORES: true });
                            break;
                        default:
                            value = null;
                    }
                    if (value !== null) {
                        results.push({
                            _key: key,
                            _type: type,
                            ...(typeof value === 'object' && !Array.isArray(value) ? value : { value })
                        });
                    }
                }
                // Apply filtering
                if (params.where) {
                    return this.filterResults(results, params.where);
                }
                // Apply pagination
                if (params.limit) {
                    const offset = params.offset || 0;
                    return results.slice(offset, offset + params.limit);
                }
            }
            // Direct key access
            if (params.where?._key) {
                const key = params.where._key;
                const type = await this.client.type(key);
                let value;
                switch (type) {
                    case 'string':
                        value = await this.client.get(key);
                        try {
                            value = JSON.parse(value);
                        }
                        catch { }
                        break;
                    case 'hash':
                        value = await this.client.hGetAll(key);
                        break;
                    case 'list':
                        value = await this.client.lRange(key, 0, -1);
                        break;
                    case 'set':
                        value = await this.client.sMembers(key);
                        break;
                    case 'zset':
                        value = await this.client.zRange(key, 0, -1, { WITHSCORES: true });
                        break;
                }
                if (value !== null && value !== undefined) {
                    results.push({
                        _key: key,
                        _type: type,
                        ...(typeof value === 'object' && !Array.isArray(value) ? value : { value })
                    });
                }
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
            throw new Error('Redis client not connected');
        }
        // Parse and execute Redis command
        const parts = command.split(' ');
        const cmd = parts[0].toUpperCase();
        const cmdArgs = args || parts.slice(1);
        try {
            switch (cmd) {
                case 'GET':
                    return await this.client.get(cmdArgs[0]);
                case 'SET':
                    return await this.client.set(cmdArgs[0], cmdArgs[1]);
                case 'DEL':
                    return await this.client.del(cmdArgs);
                case 'HGET':
                    return await this.client.hGet(cmdArgs[0], cmdArgs[1]);
                case 'HSET':
                    return await this.client.hSet(cmdArgs[0], cmdArgs[1], cmdArgs[2]);
                case 'LPUSH':
                    return await this.client.lPush(cmdArgs[0], cmdArgs.slice(1));
                case 'RPUSH':
                    return await this.client.rPush(cmdArgs[0], cmdArgs.slice(1));
                case 'SADD':
                    return await this.client.sAdd(cmdArgs[0], cmdArgs.slice(1));
                case 'ZADD':
                    // Parse score-member pairs
                    const scores = [];
                    for (let i = 1; i < cmdArgs.length; i += 2) {
                        scores.push({
                            score: parseFloat(cmdArgs[i]),
                            value: cmdArgs[i + 1]
                        });
                    }
                    return await this.client.zAdd(cmdArgs[0], scores);
                case 'EXPIRE':
                    return await this.client.expire(cmdArgs[0], parseInt(cmdArgs[1]));
                case 'TTL':
                    return await this.client.ttl(cmdArgs[0]);
                case 'SCAN':
                    const cursor = cmdArgs[0] || '0';
                    const options = {};
                    if (cmdArgs[1] === 'MATCH')
                        options.MATCH = cmdArgs[2];
                    if (cmdArgs[3] === 'COUNT')
                        options.COUNT = parseInt(cmdArgs[4]);
                    return await this.client.scan(cursor, options);
                default:
                    throw new Error(`Unsupported Redis command: ${cmd}`);
            }
        }
        catch (error) {
            this.emit('error', error);
            throw error;
        }
    }
    async getSchema() {
        if (!this.client) {
            throw new Error('Redis client not connected');
        }
        try {
            // Redis doesn't have a traditional schema
            // We'll scan for key patterns and infer structure
            const patterns = new Set();
            const types = new Map();
            // Scan a sample of keys
            let cursor = '0';
            let sampleCount = 0;
            const maxSamples = 1000;
            do {
                const result = await this.client.scan(cursor, { COUNT: 100 });
                cursor = result.cursor;
                for (const key of result.keys) {
                    // Extract pattern from key
                    const pattern = key.replace(/:[^:]+$/, ':*');
                    patterns.add(pattern);
                    // Get type if not already known
                    if (!types.has(pattern)) {
                        const type = await this.client.type(key);
                        types.set(pattern, type);
                    }
                    sampleCount++;
                    if (sampleCount >= maxSamples)
                        break;
                }
            } while (cursor !== '0' && sampleCount < maxSamples);
            // Build schema info
            const tables = [];
            for (const pattern of patterns) {
                const type = types.get(pattern) || 'unknown';
                const parts = pattern.split(':');
                const tableName = parts[0] || 'default';
                // Sample one key to get structure
                const sampleKeys = await this.client.keys(pattern.replace('*', '1'));
                let columns = [];
                if (sampleKeys.length > 0) {
                    const sampleKey = sampleKeys[0];
                    const sampleType = await this.client.type(sampleKey);
                    if (sampleType === 'hash') {
                        const fields = await this.client.hKeys(sampleKey);
                        columns = fields.map(field => ({
                            name: field,
                            type: 'string',
                            nullable: true
                        }));
                    }
                    else {
                        columns = [
                            { name: '_key', type: 'string', nullable: false },
                            { name: '_type', type: 'string', nullable: false },
                            { name: 'value', type: type === 'string' ? 'string' : 'any', nullable: true }
                        ];
                    }
                }
                // Find or create table entry
                let table = tables.find(t => t.name === tableName);
                if (!table) {
                    table = {
                        name: tableName,
                        columns,
                        primaryKey: '_key',
                        indexes: [],
                        foreignKeys: []
                    };
                    tables.push(table);
                }
                else {
                    // Merge columns
                    for (const col of columns) {
                        if (!table.columns.find(c => c.name === col.name)) {
                            table.columns.push(col);
                        }
                    }
                }
            }
            return {
                tables,
                views: [],
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
            await this.client.ping();
            return true;
        }
        catch {
            return false;
        }
    }
    filterResults(results, where) {
        return results.filter(row => {
            for (const [key, value] of Object.entries(where)) {
                if (typeof value === 'object' && value !== null) {
                    // Handle operators
                    if ('$gt' in value && !(row[key] > value.$gt))
                        return false;
                    if ('$gte' in value && !(row[key] >= value.$gte))
                        return false;
                    if ('$lt' in value && !(row[key] < value.$lt))
                        return false;
                    if ('$lte' in value && !(row[key] <= value.$lte))
                        return false;
                    if ('$ne' in value && !(row[key] !== value.$ne))
                        return false;
                    if ('$in' in value && !value.$in.includes(row[key]))
                        return false;
                    if ('$nin' in value && value.$nin.includes(row[key]))
                        return false;
                    if ('$regex' in value) {
                        const regex = new RegExp(value.$regex, value.$options || '');
                        if (!regex.test(String(row[key])))
                            return false;
                    }
                }
                else {
                    if (row[key] !== value)
                        return false;
                }
            }
            return true;
        });
    }
    /**
     * Redis-specific methods
     */
    async publish(channel, message) {
        if (!this.client) {
            throw new Error('Redis client not connected');
        }
        return await this.client.publish(channel, message);
    }
    async subscribe(channel, callback) {
        if (!this.client) {
            throw new Error('Redis client not connected');
        }
        const subscriber = this.client.duplicate();
        await subscriber.connect();
        await subscriber.subscribe(channel, (message) => {
            callback(message);
        });
    }
    async setWithExpiry(key, value, ttl) {
        if (!this.client) {
            throw new Error('Redis client not connected');
        }
        await this.client.setEx(key, ttl, value);
    }
    async increment(key, by = 1) {
        if (!this.client) {
            throw new Error('Redis client not connected');
        }
        return await this.client.incrBy(key, by);
    }
    async addToSet(key, members) {
        if (!this.client) {
            throw new Error('Redis client not connected');
        }
        return await this.client.sAdd(key, members);
    }
    async getSetMembers(key) {
        if (!this.client) {
            throw new Error('Redis client not connected');
        }
        return await this.client.sMembers(key);
    }
    async addToSortedSet(key, score, member) {
        if (!this.client) {
            throw new Error('Redis client not connected');
        }
        return await this.client.zAdd(key, { score, value: member });
    }
    async getSortedSetRange(key, start, stop) {
        if (!this.client) {
            throw new Error('Redis client not connected');
        }
        return await this.client.zRange(key, start, stop);
    }
}
exports.RedisAdapter = RedisAdapter;
//# sourceMappingURL=RedisAdapter.js.map