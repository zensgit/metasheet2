/**
 * Elasticsearch Data Source Adapter
 * Provides access to Elasticsearch search engine
 *
 * Note: This adapter intentionally does NOT extend BaseDataAdapter because:
 * - Elasticsearch is a document-based search engine, not a relational database
 * - Many BaseDataAdapter methods (SQL-style insert/update/delete) don't map directly
 * - Elasticsearch has unique capabilities (full-text search, aggregations, DSL queries)
 *   that require specialized methods not defined in BaseDataAdapter
 *
 * Instead, this adapter extends EventEmitter for consistency with connection lifecycle
 * events while providing Elasticsearch-specific methods for document operations.
 */

import { EventEmitter } from 'eventemitter3'

// Elasticsearch-specific query and result interfaces
interface QueryParams {
  table?: string;
  where?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  orderBy?: Array<{ column: string; direction: string }>;
  groupBy?: string | string[];
  select?: string[]
}
interface QueryResult { [key: string]: unknown }
interface SchemaInfo {
  tables: TableInfo[];
  views?: ViewInfo[];
  routines?: unknown[]
}
class DataSourceAdapter extends EventEmitter {}

// Elasticsearch type definitions
interface ElasticsearchClientConfig {
  node: string | string[]
  auth?: {
    username: string
    password: string
    apiKey?: string
  }
  cloud?: {
    id: string
  }
  maxRetries?: number
  requestTimeout?: number
  sniffOnStart?: boolean
  ssl?: {
    rejectUnauthorized?: boolean
    ca?: string
  }
}

interface ElasticsearchHit {
  _id: string
  _index: string
  _score: number
  _source: Record<string, unknown>
}

interface ElasticsearchSearchResponse {
  hits?: {
    hits?: ElasticsearchHit[]
  }
  aggregations?: Record<string, unknown>
  statusCode?: number
}

interface ElasticsearchBucket {
  key: string | number
  doc_count: number
  [key: string]: unknown
}

interface ElasticsearchAggregationValue {
  value?: unknown
  buckets?: ElasticsearchBucket[]
}

interface ElasticsearchIndexMapping {
  mappings: {
    properties: Record<string, ElasticsearchFieldConfig>
  }
}

interface ElasticsearchFieldConfig {
  type: string
  index?: boolean
}

interface ElasticsearchSQLResponse {
  columns?: Array<{ name: string }>
  rows?: unknown[][]
}

interface TableInfo {
  name: string
  columns: ColumnInfo[]
  primaryKey: string
  indexes: string[]
  foreignKeys: unknown[]
}

interface ColumnInfo {
  name: string
  type: string
  nullable: boolean
  indexed: boolean
  analyzed: boolean
}

interface ViewInfo {
  name: string
  definition: string
  columns: unknown[]
}

interface ElasticsearchQuery {
  search?: unknown
  index?: unknown
  update?: unknown
  delete?: unknown
  bulk?: unknown
  sql?: string
}

interface ElasticsearchBoolQuery {
  must?: unknown[]
  must_not?: unknown[]
  should?: unknown[]
  filter?: unknown[]
}

interface ElasticsearchSearchBody {
  size?: number
  from?: number
  query?: unknown
  sort?: Array<Record<string, string>>
  aggs?: Record<string, unknown>
  highlight?: {
    fields: Record<string, Record<string, never>>
  }
}

interface WhereOperators {
  $gt?: unknown
  $gte?: unknown
  $lt?: unknown
  $lte?: unknown
  $ne?: unknown
  $in?: unknown[]
  $nin?: unknown[]
  $regex?: string
  $text?: string
  $exists?: boolean
}

// Dynamic elasticsearch import
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ElasticsearchClient = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let Client: (new (config: ElasticsearchClientConfig) => ElasticsearchClient) | null = null
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  Client = require('@elastic/elasticsearch').Client
} catch {
  // @elastic/elasticsearch not installed
}

export interface ElasticsearchConfig {
  node: string | string[]
  auth?: {
    username: string
    password: string
  }
  apiKey?: string
  cloudId?: string
  maxRetries?: number
  requestTimeout?: number
  sniffOnStart?: boolean
  ssl?: {
    rejectUnauthorized?: boolean
    ca?: string
  }
}

export class ElasticsearchAdapter extends DataSourceAdapter {
  private client: ElasticsearchClient | null = null
  private config: ElasticsearchConfig

  constructor(config: ElasticsearchConfig) {
    super()
    this.config = config
  }

  async connect(): Promise<void> {
    if (!Client) {
      throw new Error('Elasticsearch module not installed. Please install: npm install @elastic/elasticsearch')
    }

    try {
      const clientConfig: ElasticsearchClientConfig = {
        node: this.config.node,
        maxRetries: this.config.maxRetries || 3,
        requestTimeout: this.config.requestTimeout || 30000,
        sniffOnStart: this.config.sniffOnStart
      }

      if (this.config.auth) {
        clientConfig.auth = this.config.auth
      }

      if (this.config.apiKey) {
        clientConfig.auth = { apiKey: this.config.apiKey } as ElasticsearchClientConfig['auth']
      }

      if (this.config.cloudId) {
        clientConfig.cloud = { id: this.config.cloudId }
      }

      if (this.config.ssl) {
        clientConfig.ssl = this.config.ssl
      }

      this.client = new Client(clientConfig)

      // Test connection
      await this.client.ping()
      this.emit('connected')
    } catch (error) {
      this.emit('error', error)
      throw error
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close()
      this.client = null
      this.emit('disconnected')
    }
  }

  async query(params: QueryParams): Promise<QueryResult[]> {
    if (!this.client) {
      throw new Error('Elasticsearch client not connected')
    }

    try {
      const index = params.table || '_all'
      const size = params.limit || 100
      const from = params.offset || 0

      // Build Elasticsearch query
      const body: ElasticsearchSearchBody = {
        size,
        from
      }

      // Convert where clause to Elasticsearch query
      if (params.where) {
        body.query = this.buildElasticsearchQuery(params.where)
      }

      // Add sorting
      if (params.orderBy) {
        body.sort = params.orderBy.map(field => ({
          [field.column]: field.direction?.toLowerCase() || 'asc'
        }))
      }

      // Add aggregations if specified
      if (params.groupBy) {
        body.aggs = this.buildAggregations(params.groupBy, params.select)
      }

      // Execute search
      const response = await this.client.search({
        index,
        body
      }) as ElasticsearchSearchResponse

      // Process results
      const results: QueryResult[] = []

      if (response.hits?.hits) {
        for (const hit of response.hits.hits) {
          results.push({
            _id: hit._id,
            _index: hit._index,
            _score: hit._score,
            ...hit._source
          })
        }
      }

      // Process aggregation results if present
      if (response.aggregations) {
        const aggResults = this.processAggregations(response.aggregations)
        results.push(...aggResults)
      }

      return results
    } catch (error) {
      this.emit('error', error)
      throw error
    }
  }

  async execute(command: string, _args?: unknown[]): Promise<unknown> {
    if (!this.client) {
      throw new Error('Elasticsearch client not connected')
    }

    try {
      // Parse DSL query
      const query: ElasticsearchQuery = typeof command === 'string' ? JSON.parse(command) : command

      // Execute based on operation type
      if (query.search) {
        return await this.client.search(query.search)
      }

      if (query.index) {
        return await this.client.index(query.index)
      }

      if (query.update) {
        return await this.client.update(query.update)
      }

      if (query.delete) {
        return await this.client.delete(query.delete)
      }

      if (query.bulk) {
        return await this.client.bulk(query.bulk)
      }

      if (query.sql) {
        return await this.executeSQLQuery(query.sql)
      }

      throw new Error('Unsupported Elasticsearch operation')
    } catch (error) {
      this.emit('error', error)
      throw error
    }
  }

  async getSchema(): Promise<SchemaInfo> {
    if (!this.client) {
      throw new Error('Elasticsearch client not connected')
    }

    try {
      // Get all indices
      const indices = await this.client.indices.getMapping() as Record<string, ElasticsearchIndexMapping>
      const tables: TableInfo[] = []

      for (const [indexName, indexData] of Object.entries(indices)) {
        const mappings = indexData.mappings
        const properties = mappings.properties || {}

        const columns = Object.entries(properties).map(([field, config]): ColumnInfo => ({
          name: field,
          type: this.mapElasticsearchType(config.type),
          nullable: true,
          indexed: config.index !== false,
          analyzed: config.type === 'text'
        }))

        tables.push({
          name: indexName,
          columns,
          primaryKey: '_id',
          indexes: Object.keys(properties).filter(field =>
            properties[field].index !== false
          ),
          foreignKeys: []
        })
      }

      // Get aliases as views
      const aliases = await this.client.indices.getAlias() as Record<string, unknown>
      const views: ViewInfo[] = Object.keys(aliases).map(alias => ({
        name: alias,
        definition: `Alias for indices`,
        columns: []
      }))

      return {
        tables,
        views,
        routines: []
      }
    } catch (error) {
      this.emit('error', error)
      throw error
    }
  }

  async testConnection(): Promise<boolean> {
    if (!this.client) {
      await this.connect()
    }

    try {
      const response = await this.client!.ping() as ElasticsearchSearchResponse
      return response.statusCode === 200
    } catch {
      return false
    }
  }

  /**
   * Build Elasticsearch query from where clause
   */
  private buildElasticsearchQuery(where: Record<string, unknown>): Record<string, unknown> {
    const must: unknown[] = []
    const mustNot: unknown[] = []
    const should: unknown[] = []
    const filter: unknown[] = []

    for (const [field, value] of Object.entries(where)) {
      if (typeof value === 'object' && value !== null) {
        const operators = value as WhereOperators
        // Handle operators
        if ('$gt' in operators) {
          filter.push({ range: { [field]: { gt: operators.$gt } } })
        }
        if ('$gte' in operators) {
          filter.push({ range: { [field]: { gte: operators.$gte } } })
        }
        if ('$lt' in operators) {
          filter.push({ range: { [field]: { lt: operators.$lt } } })
        }
        if ('$lte' in operators) {
          filter.push({ range: { [field]: { lte: operators.$lte } } })
        }
        if ('$ne' in operators) {
          mustNot.push({ term: { [field]: operators.$ne } })
        }
        if ('$in' in operators) {
          should.push({ terms: { [field]: operators.$in } })
        }
        if ('$nin' in operators) {
          mustNot.push({ terms: { [field]: operators.$nin } })
        }
        if ('$regex' in operators) {
          must.push({ regexp: { [field]: operators.$regex } })
        }
        if ('$text' in operators) {
          must.push({ match: { [field]: operators.$text } })
        }
        if ('$exists' in operators) {
          if (operators.$exists) {
            filter.push({ exists: { field } })
          } else {
            mustNot.push({ exists: { field } })
          }
        }
      } else {
        // Exact match
        filter.push({ term: { [field]: value } })
      }
    }

    // Build bool query
    const bool: ElasticsearchBoolQuery = {}
    if (must.length > 0) bool.must = must
    if (mustNot.length > 0) bool.must_not = mustNot
    if (should.length > 0) bool.should = should
    if (filter.length > 0) bool.filter = filter

    return Object.keys(bool).length > 0 ? { bool } : { match_all: {} }
  }

  /**
   * Build aggregations
   */
  private buildAggregations(groupBy: string | string[], select?: string[]): Record<string, unknown> {
    const aggs: Record<string, unknown> = {}

    const fields = Array.isArray(groupBy) ? groupBy : [groupBy]
    let currentAgg = aggs

    // Build nested aggregations for multiple group by fields
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]
      const aggName = `group_by_${field}`

      currentAgg[aggName] = {
        terms: {
          field,
          size: 10000
        }
      }

      if (i < fields.length - 1) {
        (currentAgg[aggName] as Record<string, unknown>).aggs = {}
        currentAgg = (currentAgg[aggName] as Record<string, unknown>).aggs as Record<string, unknown>
      }
    }

    // Add metrics aggregations
    if (select) {
      for (const col of select) {
        const match = col.match(/(\w+)\((.+)\)/)
        if (match) {
          const [, func, field] = match
          const aggName = `${func}_${field}`.toLowerCase()

          switch (func.toUpperCase()) {
            case 'COUNT':
              currentAgg[aggName] = { value_count: { field } }
              break
            case 'SUM':
              currentAgg[aggName] = { sum: { field } }
              break
            case 'AVG':
              currentAgg[aggName] = { avg: { field } }
              break
            case 'MIN':
              currentAgg[aggName] = { min: { field } }
              break
            case 'MAX':
              currentAgg[aggName] = { max: { field } }
              break
            case 'STATS':
              currentAgg[aggName] = { stats: { field } }
              break
          }
        }
      }
    }

    return aggs
  }

  /**
   * Process aggregation results
   */
  private processAggregations(aggregations: Record<string, unknown>): QueryResult[] {
    const results: QueryResult[] = []

    const processAgg = (agg: Record<string, unknown>, parentKey?: string): void => {
      for (const [key, value] of Object.entries(agg)) {
        const aggValue = value as ElasticsearchAggregationValue
        if (aggValue.buckets) {
          // Terms aggregation
          for (const bucket of aggValue.buckets) {
            const result: QueryResult = {}
            if (parentKey) result[parentKey] = bucket.key
            result[key] = bucket.key
            result.doc_count = bucket.doc_count

            // Process nested aggregations
            const nestedResults: QueryResult = {}
            for (const [nestedKey, nestedValue] of Object.entries(bucket)) {
              if (nestedKey !== 'key' && nestedKey !== 'doc_count') {
                const nestedAggValue = nestedValue as ElasticsearchAggregationValue
                if (nestedAggValue.value !== undefined) {
                  nestedResults[nestedKey] = nestedAggValue.value
                } else if (nestedAggValue.buckets) {
                  // Recursive processing
                  processAgg({ [nestedKey]: nestedValue }, key)
                }
              }
            }

            results.push({ ...result, ...nestedResults })
          }
        } else if (aggValue.value !== undefined) {
          // Metric aggregation
          results.push({ [key]: aggValue.value })
        }
      }
    }

    processAgg(aggregations)
    return results
  }

  /**
   * Execute SQL query using Elasticsearch SQL
   */
  private async executeSQLQuery(sql: string): Promise<QueryResult[]> {
    if (!this.client) {
      throw new Error('Elasticsearch client not connected')
    }

    const response = await this.client.sql.query({
      body: {
        query: sql
      }
    }) as ElasticsearchSQLResponse

    // Convert SQL response to standard format
    const columns = response.columns || []
    const rows = response.rows || []

    return rows.map((row: unknown[]): QueryResult => {
      const result: QueryResult = {}
      columns.forEach((col, index: number) => {
        result[col.name] = row[index]
      })
      return result
    })
  }

  /**
   * Map Elasticsearch type to generic type
   */
  private mapElasticsearchType(esType: string): string {
    switch (esType) {
      case 'text':
      case 'keyword':
        return 'string'
      case 'long':
      case 'integer':
      case 'short':
      case 'byte':
        return 'integer'
      case 'double':
      case 'float':
      case 'half_float':
        return 'float'
      case 'boolean':
        return 'boolean'
      case 'date':
        return 'datetime'
      case 'object':
      case 'nested':
        return 'json'
      case 'geo_point':
      case 'geo_shape':
        return 'geometry'
      default:
        return 'any'
    }
  }

  /**
   * Elasticsearch-specific methods
   */

  async createIndex(name: string, settings?: unknown, mappings?: unknown): Promise<unknown> {
    if (!this.client) {
      throw new Error('Elasticsearch client not connected')
    }

    return await this.client.indices.create({
      index: name,
      body: {
        settings,
        mappings
      }
    })
  }

  async deleteIndex(name: string): Promise<unknown> {
    if (!this.client) {
      throw new Error('Elasticsearch client not connected')
    }

    return await this.client.indices.delete({
      index: name
    })
  }

  async indexDocument(index: string, document: Record<string, unknown>, id?: string): Promise<unknown> {
    if (!this.client) {
      throw new Error('Elasticsearch client not connected')
    }

    return await this.client.index({
      index,
      id,
      body: document
    })
  }

  async bulkIndex(operations: unknown[]): Promise<unknown> {
    if (!this.client) {
      throw new Error('Elasticsearch client not connected')
    }

    return await this.client.bulk({
      body: operations
    })
  }

  async searchWithHighlight(
    index: string,
    query: unknown,
    fields: string[]
  ): Promise<unknown> {
    if (!this.client) {
      throw new Error('Elasticsearch client not connected')
    }

    return await this.client.search({
      index,
      body: {
        query,
        highlight: {
          fields: fields.reduce((acc, field) => {
            acc[field] = {}
            return acc
          }, {} as Record<string, Record<string, never>>)
        }
      }
    })
  }

  async aggregate(index: string, aggregations: unknown): Promise<unknown> {
    if (!this.client) {
      throw new Error('Elasticsearch client not connected')
    }

    return await this.client.search({
      index,
      body: {
        size: 0,
        aggs: aggregations
      }
    })
  }
}
