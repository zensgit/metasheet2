import { AuditService } from './AuditService';
import type { Pool, QueryResult } from 'pg';
import { Logger } from '../core/logger';

/**
 * Represents a database record with unknown structure
 */
type DatabaseRecord = Record<string, unknown>;

/**
 * Represents a query result from the database
 */
interface DatabaseQueryResult {
  rows?: DatabaseRecord[];
  rowCount?: number | null;
  id?: string | number;
}

/**
 * Represents a field change in an update operation
 */
interface FieldChange {
  field: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * Database query interceptor for automatic audit logging
 */
export class AuditInterceptor {
  private auditService: AuditService;
  private enabledTables: Set<string>;
  private excludedOperations: Set<string>;
  private logger = new Logger('AuditInterceptor');

  constructor(
    auditService: AuditService,
    config: {
      enabledTables?: string[];
      excludedOperations?: string[];
    } = {}
  ) {
    this.auditService = auditService;
    this.enabledTables = new Set(config.enabledTables || [
      'users',
      'spreadsheets',
      'workflows',
      'approvals',
      'permissions',
      'roles',
      'departments'
    ]);
    this.excludedOperations = new Set(config.excludedOperations || [
      'SELECT',
      'SHOW',
      'DESCRIBE'
    ]);
  }

  /**
   * Intercept database query for audit logging
   */
  async interceptQuery(
    query: string,
    params: unknown[],
    result: DatabaseQueryResult
  ): Promise<void> {
    try {
      const operation = this.extractOperation(query);
      if (this.excludedOperations.has(operation)) return;

      const tableName = this.extractTableName(query);
      if (!this.enabledTables.has(tableName)) return;

      const recordId = this.extractRecordId(query, params, result);
      if (!recordId) return;

      // Log based on operation type
      switch (operation) {
        case 'INSERT':
          await this.logInsert(tableName, recordId, result);
          break;
        case 'UPDATE':
          await this.logUpdate(tableName, recordId, query, params);
          break;
        case 'DELETE':
          await this.logDelete(tableName, recordId);
          break;
      }
    } catch (error) {
      this.logger.error('Audit interceptor error', error instanceof Error ? error : undefined);
      // Don't throw - audit failures shouldn't break operations
    }
  }

  /**
   * Log INSERT operation
   */
  private async logInsert(
    tableName: string,
    recordId: string,
    result: DatabaseQueryResult
  ): Promise<void> {
    const changes: FieldChange[] = [];

    // Extract inserted values from result
    if (result.rows && result.rows[0]) {
      const record = result.rows[0];
      for (const [field, value] of Object.entries(record)) {
        if (field !== 'id' && field !== 'created_at' && field !== 'updated_at') {
          changes.push({
            field,
            newValue: value
          });
        }
      }
    }

    await this.auditService.logDataChange(
      tableName,
      recordId,
      'INSERT',
      changes
    );
  }

  /**
   * Log UPDATE operation
   */
  private async logUpdate(
    tableName: string,
    recordId: string,
    query: string,
    params: unknown[]
  ): Promise<void> {
    const changes = this.extractUpdateFields(query, params);

    await this.auditService.logDataChange(
      tableName,
      recordId,
      'UPDATE',
      changes
    );
  }

  /**
   * Log DELETE operation
   */
  private async logDelete(
    tableName: string,
    recordId: string
  ): Promise<void> {
    await this.auditService.logDataChange(
      tableName,
      recordId,
      'DELETE',
      []
    );
  }

  /**
   * Extract operation type from query
   */
  private extractOperation(query: string): string {
    const normalizedQuery = query.trim().toUpperCase();
    const firstWord = normalizedQuery.split(/\s+/)[0];
    return firstWord;
  }

  /**
   * Extract table name from query
   */
  private extractTableName(query: string): string {
    const patterns = [
      /FROM\s+["`]?([\w_]+)["`]?/i,
      /UPDATE\s+["`]?([\w_]+)["`]?/i,
      /INSERT\s+INTO\s+["`]?([\w_]+)["`]?/i,
      /DELETE\s+FROM\s+["`]?([\w_]+)["`]?/i
    ];

    for (const pattern of patterns) {
      const match = query.match(pattern);
      if (match) return match[1];
    }

    return 'unknown';
  }

  /**
   * Extract record ID from query or result
   */
  private extractRecordId(
    query: string,
    params: unknown[],
    result: DatabaseQueryResult
  ): string | null {
    // Try to extract from WHERE clause
    const whereMatch = query.match(/WHERE\s+id\s*=\s*\$?(\d+)/i);
    if (whereMatch) {
      const paramIndex = parseInt(whereMatch[1]);
      if (!isNaN(paramIndex) && params[paramIndex - 1]) {
        return String(params[paramIndex - 1]);
      }
      return whereMatch[1];
    }

    // Try to extract from RETURNING clause result
    if (result?.rows?.[0]?.id) {
      return String(result.rows[0].id);
    }

    return null;
  }

  /**
   * Extract updated fields from UPDATE query
   */
  private extractUpdateFields(
    query: string,
    params: unknown[]
  ): FieldChange[] {
    const changes: FieldChange[] = [];

    // Match SET clause fields
    const setMatch = query.match(/SET\s+(.+?)\s+(WHERE|RETURNING|$)/i);
    if (!setMatch) return changes;

    const setClause = setMatch[1];
    const fieldAssignments = setClause.split(',');

    for (const assignment of fieldAssignments) {
      const match = assignment.match(/([\w_]+)\s*=\s*\$?(\d+|'[^']*'|[\w.]+)/i);
      if (match) {
        const field = match[1].trim();
        const valueRef = match[2];

        let newValue: unknown;
        if (valueRef.startsWith('$')) {
          const paramIndex = parseInt(valueRef.substring(1));
          newValue = params[paramIndex - 1];
        } else {
          newValue = valueRef.replace(/'/g, '');
        }

        changes.push({
          field,
          newValue
        });
      }
    }

    return changes;
  }
}

/**
 * Pool query function type
 */
type PoolQueryFunction = (text: string, params?: unknown[]) => Promise<QueryResult>;

/**
 * Pool with query method
 */
interface PoolWithQuery {
  query: PoolQueryFunction;
}

/**
 * Monkey patch pg Pool to add audit interceptor
 */
export function enableAuditInterceptor(
  pool: Pool,
  auditService: AuditService,
  config?: {
    enabledTables?: string[];
    excludedOperations?: string[];
  }
): void {
  const interceptor = new AuditInterceptor(auditService, config);
  const poolWithQuery = pool as PoolWithQuery;
  const originalQuery = poolWithQuery.query.bind(pool);

  poolWithQuery.query = async function(text: string, params?: unknown[]): Promise<QueryResult> {
    const result = await originalQuery(text, params);

    // Intercept for audit logging
    await interceptor.interceptQuery(text, params || [], result as DatabaseQueryResult);

    return result;
  };
}

/**
 * Decorator target interface
 */
interface DecoratorTarget {
  constructor: {
    name: string;
  };
}

/**
 * Object with audit service
 */
interface WithAuditService {
  auditService?: AuditService;
}

/**
 * Decorator for methods that should trigger audit logging
 */
export function Audited(
  eventType: string,
  eventCategory: string = 'SYSTEM'
) {
  return function(
    target: DecoratorTarget,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value as (...args: unknown[]) => Promise<unknown>;

    descriptor.value = async function(this: WithAuditService, ...args: unknown[]) {
      const auditService = this.auditService || new AuditService();
      const startTime = Date.now();

      try {
        const result = await originalMethod.apply(this, args);

        // Log successful operation
        await auditService.logEvent(
          eventType,
          `${target.constructor.name}.${propertyKey}`,
          {
            eventCategory,
            eventSeverity: 'INFO',
            responseTimeMs: Date.now() - startTime,
            actionDetails: {
              success: true,
              args: args.length > 0 ? args[0] : undefined
            }
          }
        );

        return result;
      } catch (error) {
        // Log failed operation
        await auditService.logEvent(
          eventType,
          `${target.constructor.name}.${propertyKey}`,
          {
            eventCategory,
            eventSeverity: 'ERROR',
            responseTimeMs: Date.now() - startTime,
            errorMessage: (error as Error).message,
            errorStack: (error as Error).stack,
            actionDetails: {
              success: false,
              args: args.length > 0 ? args[0] : undefined
            }
          }
        );

        throw error;
      }
    };

    return descriptor;
  };
}

/**
 * Decorator for compliance-sensitive operations
 */
export function Compliant(
  regulation: string,
  requirement?: string
) {
  return function(
    target: DecoratorTarget,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value as (...args: unknown[]) => Promise<unknown>;

    descriptor.value = async function(this: WithAuditService, ...args: unknown[]) {
      const auditService = this.auditService || new AuditService();

      // Log compliance event before operation
      await auditService.logComplianceEvent(
        regulation,
        {
          regulation,
          requirement,
          processingPurpose: `${target.constructor.name}.${propertyKey}`,
          dataEncrypted: true,
          actionDetails: {
            method: propertyKey,
            timestamp: new Date().toISOString()
          }
        }
      );

      return originalMethod.apply(this, args);
    };

    return descriptor;
  };
}
