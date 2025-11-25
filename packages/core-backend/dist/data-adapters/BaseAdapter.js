import { EventEmitter } from 'eventemitter3';
export class BaseDataAdapter extends EventEmitter {
    config;
    connected = false;
    pool;
    constructor(config) {
        super();
        this.config = config;
    }
    // Batch operations
    async batchInsert(table, data, batchSize = 1000) {
        const results = [];
        for (let i = 0; i < data.length; i += batchSize) {
            const batch = data.slice(i, i + batchSize);
            const result = await this.insert(table, batch);
            results.push(result);
        }
        return results;
    }
    // Helper methods
    sanitizeIdentifier(identifier) {
        // Remove or escape potentially dangerous characters
        return identifier.replace(/[^a-zA-Z0-9_]/g, '');
    }
    buildWhereClause(where) {
        const conditions = [];
        const params = [];
        let paramIndex = 1;
        for (const [key, value] of Object.entries(where)) {
            if (value === null) {
                conditions.push(`${this.sanitizeIdentifier(key)} IS NULL`);
            }
            else if (Array.isArray(value)) {
                const placeholders = value.map(() => `$${paramIndex++}`).join(', ');
                conditions.push(`${this.sanitizeIdentifier(key)} IN (${placeholders})`);
                params.push(...value);
            }
            else if (typeof value === 'object' && value !== null) {
                // Handle operators like { $gt: 5, $lt: 10 }
                for (const [op, val] of Object.entries(value)) {
                    const operator = this.getOperator(op);
                    conditions.push(`${this.sanitizeIdentifier(key)} ${operator} $${paramIndex++}`);
                    params.push(val);
                }
            }
            else {
                conditions.push(`${this.sanitizeIdentifier(key)} = $${paramIndex++}`);
                params.push(value);
            }
        }
        return {
            sql: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
            params
        };
    }
    getOperator(op) {
        const operators = {
            $gt: '>',
            $gte: '>=',
            $lt: '<',
            $lte: '<=',
            $ne: '!=',
            $like: 'LIKE',
            $ilike: 'ILIKE',
            $in: 'IN',
            $nin: 'NOT IN',
            $between: 'BETWEEN'
        };
        return operators[op] || '=';
    }
    // Lifecycle hooks
    async onConnect() {
        this.emit('connected', { adapter: this.config.name });
    }
    async onDisconnect() {
        this.emit('disconnected', { adapter: this.config.name });
    }
    async onError(error) {
        this.emit('error', { adapter: this.config.name, error });
    }
    // Utility methods
    async ping() {
        try {
            return await this.testConnection();
        }
        catch (error) {
            return false;
        }
    }
    getConfig() {
        return { ...this.config };
    }
    getName() {
        return this.config.name;
    }
    getType() {
        return this.config.type;
    }
}
//# sourceMappingURL=BaseAdapter.js.map