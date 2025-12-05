// MongoDB types for optional dependency
interface MongoClientOptions {
  maxPoolSize?: number;
  minPoolSize?: number;
  serverSelectionTimeoutMS?: number;
  [key: string]: unknown;
}

interface MongoClientSession {
  startTransaction(): void;
  commitTransaction(): Promise<void>;
  abortTransaction(): Promise<void>;
  endSession(): Promise<void>;
}

interface MongoClientType {
  connect(): Promise<void>;
  close(): Promise<void>;
  db(name?: string): MongoDb;
  startSession(): MongoClientSession;
}

interface MongoDb {
  collection(name: string): MongoCollection;
  admin(): { ping(): Promise<Record<string, unknown>> };
  listCollections(filter?: { name?: string }): { toArray(): Promise<MongoCollectionInfo[]> };
}

interface MongoCollectionInfo {
  name: string;
  type?: string;
  options?: Record<string, unknown>;
  info?: Record<string, unknown>;
}

interface MongoCursor<T = unknown> {
  toArray(): Promise<T[]>;
  batchSize(size: number): this;
  limit(count: number): this;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}

interface MongoCollection {
  aggregate(pipeline: Record<string, unknown>[]): MongoCursor;
  find(filter?: Record<string, unknown>, options?: MongoFindOptions): MongoCursor;
  findOne(filter?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  insertOne(doc: Record<string, unknown>): Promise<{ insertedId: unknown }>;
  insertMany(docs: Record<string, unknown>[]): Promise<{ insertedIds: Record<number, unknown> }>;
  updateOne(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<{ modifiedCount: number }>;
  updateMany(filter: Record<string, unknown>, update: Record<string, unknown>): Promise<{ modifiedCount: number }>;
  deleteOne(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
  deleteMany(filter: Record<string, unknown>): Promise<{ deletedCount: number }>;
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
  indexes(): Promise<MongoIndexInfo[]>;
}

interface MongoFindOptions {
  projection?: Record<string, number>;
  sort?: Record<string, number>;
  limit?: number;
  skip?: number;
}

interface MongoIndexInfo {
  name: string;
  key?: Record<string, number>;
  unique?: boolean;
}

interface MongoFilter {
  [key: string]: unknown | { [operator: string]: unknown };
}

interface MongoDocument extends Record<string, unknown> {
  _id?: unknown;
}

import type {
  DbValue,
  WhereValue,
  QueryOptions,
  QueryResult,
  SchemaInfo,
  TableInfo,
  ColumnInfo,
  IndexInfo,
  Transaction
} from './BaseAdapter';
import {
  BaseDataAdapter,
  DataSourceConfig as _DataSourceConfig
} from './BaseAdapter'

// Dynamic mongodb import
let MongoClient: (new (uri: string, options?: MongoClientOptions) => MongoClientType) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  MongoClient = require('mongodb').MongoClient
} catch {
  // mongodb not installed
}

export class MongoDBAdapter extends BaseDataAdapter {
  private client: MongoClientType | null = null
  private db: MongoDb | null = null

  async connect(): Promise<void> {
    if (this.connected) {
      return
    }

    if (!MongoClient) {
      throw new Error('mongodb package is not installed')
    }

    try {
      const uri = typeof this.config.connection.uri === 'string'
        ? this.config.connection.uri
        : this.buildConnectionUri()

      this.client = new MongoClient(uri, {
        maxPoolSize: this.config.poolConfig?.max || 20,
        minPoolSize: this.config.poolConfig?.min || 2,
        serverSelectionTimeoutMS: this.config.poolConfig?.acquireTimeout || 30000,
        ...this.config.options
      })

      await this.client.connect()

      const dbName = typeof this.config.connection.database === 'string'
        ? this.config.connection.database
        : undefined
      this.db = this.client.db(dbName)

      this.connected = true
      await this.onConnect()
    } catch (error) {
      await this.onError(error as Error)
      throw new Error(`Failed to connect to MongoDB: ${error}`)
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected || !this.client) {
      return
    }

    try {
      await this.client.close()
      this.client = null
      this.db = null
      this.connected = false
      await this.onDisconnect()
    } catch (error) {
      await this.onError(error as Error)
      throw new Error(`Failed to disconnect from MongoDB: ${error}`)
    }
  }

  isConnected(): boolean {
    return this.connected && this.client !== null && this.db !== null
  }

  async testConnection(): Promise<boolean> {
    if (!this.db) {
      return false
    }

    try {
      await this.db.admin().ping()
      return true
    } catch {
      return false
    }
  }

  async query<T = Record<string, DbValue>>(collection: string, params?: DbValue[]): Promise<QueryResult<T>> {
    if (!this.db) {
      throw new Error('Not connected to database')
    }

    try {
      const coll = this.db.collection(collection)

      let cursor: MongoCursor
      // If params is provided and it's an array of objects, treat as aggregation pipeline
      if (params && Array.isArray(params) && params.length > 0 && typeof params[0] === 'object') {
        cursor = coll.aggregate(params as Record<string, unknown>[])
      } else {
        // Simple find
        cursor = coll.find()
      }

      const data = await cursor.toArray()

      return {
        data: data as T[],
        metadata: {
          totalCount: data.length,
          columns: this.extractColumns(data as MongoDocument[])
        }
      }
    } catch (error) {
      return {
        data: [],
        error: error as Error
      }
    }
  }

  async select<T = Record<string, DbValue>>(collection: string, options: QueryOptions = {}): Promise<QueryResult<T>> {
    if (!this.db) {
      throw new Error('Not connected to database')
    }

    try {
      const coll = this.db.collection(collection)

      const filter: MongoFilter = this.buildMongoFilter(options.where || {})
      const findOptions: MongoFindOptions = {}

      // Add projection
      if (options.select?.length) {
        findOptions.projection = options.select.reduce((proj, field) => {
          proj[field] = 1
          return proj
        }, {} as Record<string, number>)
      }

      // Add sorting
      if (options.orderBy?.length) {
        findOptions.sort = options.orderBy.reduce((sort, order) => {
          sort[order.column] = order.direction === 'asc' ? 1 : -1
          return sort
        }, {} as Record<string, number>)
      }

      // Add pagination
      if (options.limit) {
        findOptions.limit = options.limit
      }
      if (options.offset) {
        findOptions.skip = options.offset
      }

      const cursor = coll.find(filter, findOptions)
      const data = await cursor.toArray()
      const totalCount = await coll.countDocuments(filter)

      return {
        data: data as T[],
        metadata: {
          totalCount,
          columns: this.extractColumns(data as MongoDocument[])
        }
      }
    } catch (error) {
      return {
        data: [],
        error: error as Error
      }
    }
  }

  async insert<T = Record<string, DbValue>>(collection: string, data: Record<string, DbValue> | Record<string, DbValue>[]): Promise<QueryResult<T>> {
    if (!this.db) {
      throw new Error('Not connected to database')
    }

    try {
      const coll = this.db.collection(collection)
      const docs = Array.isArray(data) ? data : [data]

      const result = docs.length === 1
        ? await coll.insertOne(docs[0] as Record<string, unknown>)
        : await coll.insertMany(docs as Record<string, unknown>[])

      // Fetch inserted documents
      const insertedIds = 'insertedIds' in result
        ? Object.values(result.insertedIds)
        : [result.insertedId]

      const insertedDocs = await coll.find({
        _id: { $in: insertedIds }
      }).toArray()

      return {
        data: insertedDocs as T[],
        metadata: {
          totalCount: insertedDocs.length
        }
      }
    } catch (error) {
      return {
        data: [],
        error: error as Error
      }
    }
  }

  async update<T = Record<string, DbValue>>(
    collection: string,
    data: Record<string, DbValue>,
    where: Record<string, WhereValue>
  ): Promise<QueryResult<T>> {
    if (!this.db) {
      throw new Error('Not connected to database')
    }

    try {
      const coll = this.db.collection(collection)
      const filter = this.buildMongoFilter(where)

      // Remove MongoDB-specific fields from update data
      const { _id, ...updateData } = data

      const result = await coll.updateMany(filter, { $set: updateData })

      // Fetch updated documents
      const updatedDocs = await coll.find(filter).toArray()

      return {
        data: updatedDocs as T[],
        metadata: {
          totalCount: result.modifiedCount
        }
      }
    } catch (error) {
      return {
        data: [],
        error: error as Error
      }
    }
  }

  async delete<T = Record<string, DbValue>>(collection: string, where: Record<string, WhereValue>): Promise<QueryResult<T>> {
    if (!this.db) {
      throw new Error('Not connected to database')
    }

    try {
      const coll = this.db.collection(collection)
      const filter = this.buildMongoFilter(where)

      // Fetch documents before deletion
      const docsToDelete = await coll.find(filter).toArray()

      const result = await coll.deleteMany(filter)

      return {
        data: docsToDelete as T[],
        metadata: {
          totalCount: result.deletedCount
        }
      }
    } catch (error) {
      return {
        data: [],
        error: error as Error
      }
    }
  }

  async getSchema(database?: string): Promise<SchemaInfo> {
    const db = database ? this.client!.db(database) : this.db!

    const collections = await db.listCollections().toArray()

    const tables: TableInfo[] = await Promise.all(
      collections.map(async (coll) => ({
        name: coll.name,
        columns: await this.getColumns(coll.name, database),
        primaryKey: ['_id'],
        indexes: await this.getIndexes(coll.name, database)
      }))
    )

    return { tables }
  }

  async getTableInfo(collection: string, database?: string): Promise<TableInfo> {
    const _db = database ? this.client!.db(database) : this.db!

    return {
      name: collection,
      columns: await this.getColumns(collection, database),
      primaryKey: ['_id'],
      indexes: await this.getIndexes(collection, database)
    }
  }

  async getColumns(collection: string, database?: string): Promise<ColumnInfo[]> {
    const db = database ? this.client!.db(database) : this.db!
    const coll = db.collection(collection)

    // Sample documents to infer schema
    const samples = await coll.find().limit(100).toArray()

    if (samples.length === 0) {
      return [
        {
          name: '_id',
          type: 'ObjectId',
          nullable: false,
          primaryKey: true
        }
      ]
    }

    // Analyze schema from samples
    const fieldMap = new Map<string, { types: Set<string>; nullable: boolean }>()

    for (const doc of samples) {
      this.analyzeDocument(doc as MongoDocument, '', fieldMap)
    }

    const columns: ColumnInfo[] = []
    fieldMap.forEach((info, name) => {
      columns.push({
        name,
        type: Array.from(info.types).join(' | '),
        nullable: info.nullable,
        primaryKey: name === '_id'
      })
    })

    return columns
  }

  async tableExists(collection: string, database?: string): Promise<boolean> {
    const db = database ? this.client!.db(database) : this.db!

    const collections = await db.listCollections({ name: collection }).toArray()
    return collections.length > 0
  }

  // MongoDB doesn't have traditional transactions for all deployments
  async beginTransaction(): Promise<Transaction> {
    if (!this.client) {
      throw new Error('Not connected to database')
    }

    const session = this.client.startSession()
    session.startTransaction()
    return session as unknown as Transaction
  }

  async commit(transaction: Transaction): Promise<void> {
    const session = transaction as unknown as MongoClientSession
    await session.commitTransaction()
    await session.endSession()
  }

  async rollback(transaction: Transaction): Promise<void> {
    const session = transaction as unknown as MongoClientSession
    await session.abortTransaction()
    await session.endSession()
  }

  async inTransaction<R = unknown>(transaction: Transaction, callback: () => Promise<R>): Promise<R> {
    try {
      const result = await callback()
      await this.commit(transaction)
      return result
    } catch (error) {
      await this.rollback(transaction)
      throw error
    }
  }

  async *stream<T = Record<string, DbValue>>(
    collection: string,
    _params?: DbValue[],
    options?: { highWaterMark?: number; objectMode?: boolean; batchSize?: number; filter?: Record<string, unknown> }
  ): AsyncIterableIterator<T> {
    if (!this.db) {
      throw new Error('Not connected to database')
    }

    const coll = this.db.collection(collection)
    const cursor = coll.find(options?.filter || {})

    if (options?.batchSize) {
      cursor.batchSize(options.batchSize)
    }

    for await (const doc of cursor) {
      yield doc as T
    }
  }

  // Helper methods
  private buildConnectionUri(): string {
    const { host, port, database } = this.config.connection
    const { username, password } = this.config.credentials || {}

    let uri = 'mongodb://'

    if (username && password) {
      const user = String(username)
      const pass = String(password)
      uri += `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`
    }

    uri += `${String(host)}:${port || 27017}`

    if (database) {
      uri += `/${String(database)}`
    }

    return uri
  }

  private buildMongoFilter(where: Record<string, WhereValue>): MongoFilter {
    const filter: MongoFilter = {}

    for (const [key, value] of Object.entries(where)) {
      if (value === null) {
        filter[key] = null
      } else if (Array.isArray(value)) {
        filter[key] = { $in: value }
      } else if (typeof value === 'object' && value !== null) {
        // Handle operators
        const operators: Record<string, unknown> = {}
        for (const [op, val] of Object.entries(value)) {
          const mongoOp = this.mapOperatorToMongo(op)
          operators[mongoOp] = val
        }
        filter[key] = operators
      } else {
        filter[key] = value
      }
    }

    return filter
  }

  private mapOperatorToMongo(op: string): string {
    const operatorMap: Record<string, string> = {
      $gt: '$gt',
      $gte: '$gte',
      $lt: '$lt',
      $lte: '$lte',
      $ne: '$ne',
      $in: '$in',
      $nin: '$nin',
      $like: '$regex',
      $between: '$gte' // Special handling needed
    }
    return operatorMap[op] || op
  }

  private extractColumns(data: MongoDocument[]): Array<{ name: string; type: string; nullable?: boolean }> {
    if (data.length === 0) return []

    const fieldMap = new Map<string, { types: Set<string>; nullable: boolean }>()

    for (const doc of data.slice(0, 100)) {
      this.analyzeDocument(doc, '', fieldMap)
    }

    const columns: Array<{ name: string; type: string; nullable?: boolean }> = []
    fieldMap.forEach((info, name) => {
      columns.push({
        name,
        type: Array.from(info.types).join(' | '),
        nullable: info.nullable
      })
    })

    return columns
  }

  private analyzeDocument(
    obj: MongoDocument,
    prefix: string,
    fieldMap: Map<string, { types: Set<string>; nullable: boolean }>
  ): void {
    for (const [key, value] of Object.entries(obj)) {
      const fieldName = prefix ? `${prefix}.${key}` : key

      if (!fieldMap.has(fieldName)) {
        fieldMap.set(fieldName, { types: new Set(), nullable: false })
      }

      const field = fieldMap.get(fieldName)!

      if (value === null || value === undefined) {
        field.nullable = true
      } else {
        const type = Array.isArray(value) ? 'array' : typeof value
        field.types.add(type)

        if (type === 'object' && !Array.isArray(value)) {
          this.analyzeDocument(value as MongoDocument, fieldName, fieldMap)
        }
      }
    }
  }

  private async getIndexes(collection: string, database?: string): Promise<IndexInfo[]> {
    const db = database ? this.client!.db(database) : this.db!
    const coll = db.collection(collection)

    const indexes = await coll.indexes()
    return indexes.map((index) => ({
      name: index.name,
      columns: Object.keys(index.key || {}),
      unique: index.unique || false
    }))
  }
}
