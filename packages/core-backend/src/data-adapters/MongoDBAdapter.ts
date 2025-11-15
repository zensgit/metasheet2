// @ts-nocheck
import { MongoClient, Db, Collection, Filter, FindOptions } from 'mongodb'
import {
  BaseDataAdapter,
  DataSourceConfig,
  QueryOptions,
  QueryResult,
  SchemaInfo,
  TableInfo,
  ColumnInfo
} from './BaseAdapter'

export class MongoDBAdapter extends BaseDataAdapter {
  private client: MongoClient | null = null
  private db: Db | null = null

  async connect(): Promise<void> {
    if (this.connected) {
      return
    }

    try {
      const uri = this.config.connection.uri || this.buildConnectionUri()

      this.client = new MongoClient(uri, {
        maxPoolSize: this.config.poolConfig?.max || 20,
        minPoolSize: this.config.poolConfig?.min || 2,
        serverSelectionTimeoutMS: this.config.poolConfig?.acquireTimeout || 30000,
        ...this.config.options
      })

      await this.client.connect()
      this.db = this.client.db(this.config.connection.database)

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

  async query<T = any>(collection: string, pipeline?: any[]): Promise<QueryResult<T>> {
    if (!this.db) {
      throw new Error('Not connected to database')
    }

    try {
      const coll = this.db.collection(collection)

      let cursor
      if (pipeline && pipeline.length > 0) {
        // Use aggregation pipeline
        cursor = coll.aggregate(pipeline)
      } else {
        // Simple find
        cursor = coll.find()
      }

      const data = await cursor.toArray()

      return {
        data: data as T[],
        metadata: {
          totalCount: data.length,
          columns: this.extractColumns(data)
        }
      }
    } catch (error) {
      return {
        data: [],
        error: error as Error
      }
    }
  }

  async select<T = any>(collection: string, options: QueryOptions = {}): Promise<QueryResult<T>> {
    if (!this.db) {
      throw new Error('Not connected to database')
    }

    try {
      const coll = this.db.collection(collection)

      const filter: Filter<any> = this.buildMongoFilter(options.where || {})
      const findOptions: FindOptions = {}

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
          columns: this.extractColumns(data)
        }
      }
    } catch (error) {
      return {
        data: [],
        error: error as Error
      }
    }
  }

  async insert<T = any>(collection: string, data: Record<string, any> | Record<string, any>[]): Promise<QueryResult<T>> {
    if (!this.db) {
      throw new Error('Not connected to database')
    }

    try {
      const coll = this.db.collection(collection)
      const docs = Array.isArray(data) ? data : [data]

      const result = docs.length === 1
        ? await coll.insertOne(docs[0])
        : await coll.insertMany(docs)

      // Fetch inserted documents
      const insertedIds = Array.isArray(result.insertedIds)
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

  async update<T = any>(
    collection: string,
    data: Record<string, any>,
    where: Record<string, any>
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

  async delete<T = any>(collection: string, where: Record<string, any>): Promise<QueryResult<T>> {
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
    const db = database ? this.client!.db(database) : this.db!

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
      this.analyzeDocument(doc, '', fieldMap)
    }

    const columns: ColumnInfo[] = []
    for (const [name, info] of fieldMap) {
      columns.push({
        name,
        type: Array.from(info.types).join(' | '),
        nullable: info.nullable,
        primaryKey: name === '_id'
      })
    }

    return columns
  }

  async tableExists(collection: string, database?: string): Promise<boolean> {
    const db = database ? this.client!.db(database) : this.db!

    const collections = await db.listCollections({ name: collection }).toArray()
    return collections.length > 0
  }

  // MongoDB doesn't have traditional transactions for all deployments
  async beginTransaction(): Promise<any> {
    if (!this.client) {
      throw new Error('Not connected to database')
    }

    const session = this.client.startSession()
    session.startTransaction()
    return session
  }

  async commit(transaction: any): Promise<void> {
    await transaction.commitTransaction()
    await transaction.endSession()
  }

  async rollback(transaction: any): Promise<void> {
    await transaction.abortTransaction()
    await transaction.endSession()
  }

  async inTransaction(transaction: any, callback: () => Promise<any>): Promise<any> {
    try {
      const result = await callback()
      await this.commit(transaction)
      return result
    } catch (error) {
      await this.rollback(transaction)
      throw error
    }
  }

  async *stream<T = any>(
    collection: string,
    filter?: any,
    options?: { batchSize?: number }
  ): AsyncIterableIterator<T> {
    if (!this.db) {
      throw new Error('Not connected to database')
    }

    const coll = this.db.collection(collection)
    const cursor = coll.find(filter || {})

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
      uri += `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
    }

    uri += `${host}:${port || 27017}`

    if (database) {
      uri += `/${database}`
    }

    return uri
  }

  private buildMongoFilter(where: Record<string, any>): Filter<any> {
    const filter: Filter<any> = {}

    for (const [key, value] of Object.entries(where)) {
      if (value === null) {
        filter[key] = null
      } else if (Array.isArray(value)) {
        filter[key] = { $in: value }
      } else if (typeof value === 'object' && value !== null) {
        // Handle operators
        const operators: Record<string, any> = {}
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

  private extractColumns(data: any[]): Array<{ name: string; type: string; nullable?: boolean }> {
    if (data.length === 0) return []

    const fieldMap = new Map<string, { types: Set<string>; nullable: boolean }>()

    for (const doc of data.slice(0, 100)) {
      this.analyzeDocument(doc, '', fieldMap)
    }

    const columns: Array<{ name: string; type: string; nullable?: boolean }> = []
    for (const [name, info] of fieldMap) {
      columns.push({
        name,
        type: Array.from(info.types).join(' | '),
        nullable: info.nullable
      })
    }

    return columns
  }

  private analyzeDocument(
    obj: any,
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
          this.analyzeDocument(value, fieldName, fieldMap)
        }
      }
    }
  }

  private async getIndexes(collection: string, database?: string): Promise<any[]> {
    const db = database ? this.client!.db(database) : this.db!
    const coll = db.collection(collection)

    const indexes = await coll.indexes()
    return indexes.map(index => ({
      name: index.name,
      columns: Object.keys(index.key || {}),
      unique: index.unique || false
    }))
  }
}
// @ts-nocheck
