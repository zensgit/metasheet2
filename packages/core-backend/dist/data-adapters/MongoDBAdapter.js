// @ts-nocheck
import { MongoClient } from 'mongodb';
import { BaseDataAdapter } from './BaseAdapter';
export class MongoDBAdapter extends BaseDataAdapter {
    client = null;
    db = null;
    async connect() {
        if (this.connected) {
            return;
        }
        try {
            const uri = this.config.connection.uri || this.buildConnectionUri();
            this.client = new MongoClient(uri, {
                maxPoolSize: this.config.poolConfig?.max || 20,
                minPoolSize: this.config.poolConfig?.min || 2,
                serverSelectionTimeoutMS: this.config.poolConfig?.acquireTimeout || 30000,
                ...this.config.options
            });
            await this.client.connect();
            this.db = this.client.db(this.config.connection.database);
            this.connected = true;
            await this.onConnect();
        }
        catch (error) {
            await this.onError(error);
            throw new Error(`Failed to connect to MongoDB: ${error}`);
        }
    }
    async disconnect() {
        if (!this.connected || !this.client) {
            return;
        }
        try {
            await this.client.close();
            this.client = null;
            this.db = null;
            this.connected = false;
            await this.onDisconnect();
        }
        catch (error) {
            await this.onError(error);
            throw new Error(`Failed to disconnect from MongoDB: ${error}`);
        }
    }
    isConnected() {
        return this.connected && this.client !== null && this.db !== null;
    }
    async testConnection() {
        if (!this.db) {
            return false;
        }
        try {
            await this.db.admin().ping();
            return true;
        }
        catch {
            return false;
        }
    }
    async query(collection, pipeline) {
        if (!this.db) {
            throw new Error('Not connected to database');
        }
        try {
            const coll = this.db.collection(collection);
            let cursor;
            if (pipeline && pipeline.length > 0) {
                // Use aggregation pipeline
                cursor = coll.aggregate(pipeline);
            }
            else {
                // Simple find
                cursor = coll.find();
            }
            const data = await cursor.toArray();
            return {
                data: data,
                metadata: {
                    totalCount: data.length,
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
    async select(collection, options = {}) {
        if (!this.db) {
            throw new Error('Not connected to database');
        }
        try {
            const coll = this.db.collection(collection);
            const filter = this.buildMongoFilter(options.where || {});
            const findOptions = {};
            // Add projection
            if (options.select?.length) {
                findOptions.projection = options.select.reduce((proj, field) => {
                    proj[field] = 1;
                    return proj;
                }, {});
            }
            // Add sorting
            if (options.orderBy?.length) {
                findOptions.sort = options.orderBy.reduce((sort, order) => {
                    sort[order.column] = order.direction === 'asc' ? 1 : -1;
                    return sort;
                }, {});
            }
            // Add pagination
            if (options.limit) {
                findOptions.limit = options.limit;
            }
            if (options.offset) {
                findOptions.skip = options.offset;
            }
            const cursor = coll.find(filter, findOptions);
            const data = await cursor.toArray();
            const totalCount = await coll.countDocuments(filter);
            return {
                data: data,
                metadata: {
                    totalCount,
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
    async insert(collection, data) {
        if (!this.db) {
            throw new Error('Not connected to database');
        }
        try {
            const coll = this.db.collection(collection);
            const docs = Array.isArray(data) ? data : [data];
            const result = docs.length === 1
                ? await coll.insertOne(docs[0])
                : await coll.insertMany(docs);
            // Fetch inserted documents
            const insertedIds = Array.isArray(result.insertedIds)
                ? Object.values(result.insertedIds)
                : [result.insertedId];
            const insertedDocs = await coll.find({
                _id: { $in: insertedIds }
            }).toArray();
            return {
                data: insertedDocs,
                metadata: {
                    totalCount: insertedDocs.length
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
    async update(collection, data, where) {
        if (!this.db) {
            throw new Error('Not connected to database');
        }
        try {
            const coll = this.db.collection(collection);
            const filter = this.buildMongoFilter(where);
            // Remove MongoDB-specific fields from update data
            const { _id, ...updateData } = data;
            const result = await coll.updateMany(filter, { $set: updateData });
            // Fetch updated documents
            const updatedDocs = await coll.find(filter).toArray();
            return {
                data: updatedDocs,
                metadata: {
                    totalCount: result.modifiedCount
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
    async delete(collection, where) {
        if (!this.db) {
            throw new Error('Not connected to database');
        }
        try {
            const coll = this.db.collection(collection);
            const filter = this.buildMongoFilter(where);
            // Fetch documents before deletion
            const docsToDelete = await coll.find(filter).toArray();
            const result = await coll.deleteMany(filter);
            return {
                data: docsToDelete,
                metadata: {
                    totalCount: result.deletedCount
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
    async getSchema(database) {
        const db = database ? this.client.db(database) : this.db;
        const collections = await db.listCollections().toArray();
        const tables = await Promise.all(collections.map(async (coll) => ({
            name: coll.name,
            columns: await this.getColumns(coll.name, database),
            primaryKey: ['_id'],
            indexes: await this.getIndexes(coll.name, database)
        })));
        return { tables };
    }
    async getTableInfo(collection, database) {
        const db = database ? this.client.db(database) : this.db;
        return {
            name: collection,
            columns: await this.getColumns(collection, database),
            primaryKey: ['_id'],
            indexes: await this.getIndexes(collection, database)
        };
    }
    async getColumns(collection, database) {
        const db = database ? this.client.db(database) : this.db;
        const coll = db.collection(collection);
        // Sample documents to infer schema
        const samples = await coll.find().limit(100).toArray();
        if (samples.length === 0) {
            return [
                {
                    name: '_id',
                    type: 'ObjectId',
                    nullable: false,
                    primaryKey: true
                }
            ];
        }
        // Analyze schema from samples
        const fieldMap = new Map();
        for (const doc of samples) {
            this.analyzeDocument(doc, '', fieldMap);
        }
        const columns = [];
        for (const [name, info] of fieldMap) {
            columns.push({
                name,
                type: Array.from(info.types).join(' | '),
                nullable: info.nullable,
                primaryKey: name === '_id'
            });
        }
        return columns;
    }
    async tableExists(collection, database) {
        const db = database ? this.client.db(database) : this.db;
        const collections = await db.listCollections({ name: collection }).toArray();
        return collections.length > 0;
    }
    // MongoDB doesn't have traditional transactions for all deployments
    async beginTransaction() {
        if (!this.client) {
            throw new Error('Not connected to database');
        }
        const session = this.client.startSession();
        session.startTransaction();
        return session;
    }
    async commit(transaction) {
        await transaction.commitTransaction();
        await transaction.endSession();
    }
    async rollback(transaction) {
        await transaction.abortTransaction();
        await transaction.endSession();
    }
    async inTransaction(transaction, callback) {
        try {
            const result = await callback();
            await this.commit(transaction);
            return result;
        }
        catch (error) {
            await this.rollback(transaction);
            throw error;
        }
    }
    async *stream(collection, filter, options) {
        if (!this.db) {
            throw new Error('Not connected to database');
        }
        const coll = this.db.collection(collection);
        const cursor = coll.find(filter || {});
        if (options?.batchSize) {
            cursor.batchSize(options.batchSize);
        }
        for await (const doc of cursor) {
            yield doc;
        }
    }
    // Helper methods
    buildConnectionUri() {
        const { host, port, database } = this.config.connection;
        const { username, password } = this.config.credentials || {};
        let uri = 'mongodb://';
        if (username && password) {
            uri += `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
        }
        uri += `${host}:${port || 27017}`;
        if (database) {
            uri += `/${database}`;
        }
        return uri;
    }
    buildMongoFilter(where) {
        const filter = {};
        for (const [key, value] of Object.entries(where)) {
            if (value === null) {
                filter[key] = null;
            }
            else if (Array.isArray(value)) {
                filter[key] = { $in: value };
            }
            else if (typeof value === 'object' && value !== null) {
                // Handle operators
                const operators = {};
                for (const [op, val] of Object.entries(value)) {
                    const mongoOp = this.mapOperatorToMongo(op);
                    operators[mongoOp] = val;
                }
                filter[key] = operators;
            }
            else {
                filter[key] = value;
            }
        }
        return filter;
    }
    mapOperatorToMongo(op) {
        const operatorMap = {
            $gt: '$gt',
            $gte: '$gte',
            $lt: '$lt',
            $lte: '$lte',
            $ne: '$ne',
            $in: '$in',
            $nin: '$nin',
            $like: '$regex',
            $between: '$gte' // Special handling needed
        };
        return operatorMap[op] || op;
    }
    extractColumns(data) {
        if (data.length === 0)
            return [];
        const fieldMap = new Map();
        for (const doc of data.slice(0, 100)) {
            this.analyzeDocument(doc, '', fieldMap);
        }
        const columns = [];
        for (const [name, info] of fieldMap) {
            columns.push({
                name,
                type: Array.from(info.types).join(' | '),
                nullable: info.nullable
            });
        }
        return columns;
    }
    analyzeDocument(obj, prefix, fieldMap) {
        for (const [key, value] of Object.entries(obj)) {
            const fieldName = prefix ? `${prefix}.${key}` : key;
            if (!fieldMap.has(fieldName)) {
                fieldMap.set(fieldName, { types: new Set(), nullable: false });
            }
            const field = fieldMap.get(fieldName);
            if (value === null || value === undefined) {
                field.nullable = true;
            }
            else {
                const type = Array.isArray(value) ? 'array' : typeof value;
                field.types.add(type);
                if (type === 'object' && !Array.isArray(value)) {
                    this.analyzeDocument(value, fieldName, fieldMap);
                }
            }
        }
    }
    async getIndexes(collection, database) {
        const db = database ? this.client.db(database) : this.db;
        const coll = db.collection(collection);
        const indexes = await coll.indexes();
        return indexes.map(index => ({
            name: index.name,
            columns: Object.keys(index.key || {}),
            unique: index.unique || false
        }));
    }
}
// @ts-nocheck
//# sourceMappingURL=MongoDBAdapter.js.map