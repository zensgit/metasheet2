/**
 * Workflow-specific Repository
 * Handles workflow definitions, instances, tokens, and incidents
 *
 * Note: Uses type assertions for Kysely aggregate functions due to complex
 * union types with 60+ tables causing TypeScript errors.
 */

import { BaseRepository } from './BaseRepository'
import type {
  WorkflowInstancesTable,
  WorkflowIncidentsTable
} from '../types'
import type { Updateable } from 'kysely'
import type { Database } from '../types'

// Type-safe update data for workflow instances
interface WorkflowInstanceUpdateData extends Partial<Updateable<Database['workflow_instances']>> {
  status?: WorkflowInstancesTable['status']
  updated_at?: Date
  started_at?: Date
  completed_at?: Date
  error?: string
}

// Type-safe token data for creation
interface WorkflowTokenCreateData {
  instance_id: string
  node_id: string
  token_type: 'EXECUTION'
  status: 'ACTIVE'
  parent_token_id: string
  variables: string
}

// Type-safe incident statistics result
interface IncidentStatistics {
  incident_type: string
  severity: string
  resolution_status: string
  count: string | number
}

// Type-safe instance with incidents result
interface InstanceWithIncidents {
  id: string
  definition_id: string
  status: string
  created_at: Date
  incident_count: string | number
  open_incidents: string | number
}

export class WorkflowDefinitionRepository extends BaseRepository<'workflow_definitions'> {
  constructor() {
    super('workflow_definitions')
  }

  /**
   * Find active workflow definition by name
   */
  async findActiveByName(name: string) {
    return await this.db
      .selectFrom('workflow_definitions')
      .selectAll()
      .where('name', '=', name)
      .where('status', '=', 'ACTIVE')
      .orderBy('version', 'desc')
      .executeTakeFirst()
  }

  /**
   * Get all versions of a workflow
   */
  async getAllVersions(name: string) {
    return await this.db
      .selectFrom('workflow_definitions')
      .selectAll()
      .where('name', '=', name)
      .orderBy('version', 'desc')
      .execute()
  }
}

export class WorkflowInstanceRepository extends BaseRepository<'workflow_instances'> {
  constructor() {
    super('workflow_instances')
  }

  /**
   * Find running instances
   */
  async findRunning() {
    return await this.db
      .selectFrom('workflow_instances')
      .selectAll()
      .where('status', 'in', ['RUNNING', 'SUSPENDED'])
      .orderBy('created_at', 'desc')
      .execute()
  }

  /**
   * Update instance status with timestamp
   */
  async updateStatus(
    id: string,
    status: WorkflowInstancesTable['status'],
    error?: string
  ) {
    const updateData: WorkflowInstanceUpdateData = { status, updated_at: new Date() }

    if (status === 'RUNNING' && !updateData.started_at) {
      updateData.started_at = new Date()
    }

    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) {
      updateData.completed_at = new Date()
    }

    if (error) {
      updateData.error = error
    }

    return await this.update(id, updateData)
  }

  /**
   * Get instances with incidents
   */
  async getInstancesWithIncidents(): Promise<InstanceWithIncidents[]> {
    // Using type assertions for Kysely aggregate functions to avoid complex union type errors
    // This is a known limitation with Kysely's type system when dealing with large schemas
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const countFn = this.db.fn.count as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sumFn = this.db.fn.sum as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawFn = (this.db as any).raw

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = this.db
      .selectFrom('workflow_instances as wi')
      .innerJoin('workflow_incidents as inc', 'inc.instance_id', 'wi.id')
      .select([
        'wi.id',
        'wi.definition_id',
        'wi.status',
        'wi.created_at',
        countFn('inc.id').as('incident_count'),
        sumFn(
          rawFn(`case when inc.resolution_status = 'OPEN' then 1 else 0 end`)
        ).as('open_incidents')
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .groupBy(['wi.id', 'wi.definition_id', 'wi.status', 'wi.created_at']) as any

    return await query
      .having(countFn('inc.id'), '>', 0)
      .execute() as InstanceWithIncidents[]
  }
}

export class WorkflowTokenRepository extends BaseRepository<'workflow_tokens'> {
  constructor() {
    super('workflow_tokens')
  }

  /**
   * Get active tokens for an instance
   */
  async getActiveTokens(instanceId: string) {
    return await this.db
      .selectFrom('workflow_tokens')
      .selectAll()
      .where('instance_id', '=', instanceId)
      .where('status', '=', 'ACTIVE')
      .orderBy('created_at', 'asc')
      .execute()
  }

  /**
   * Consume a token
   */
  async consumeToken(tokenId: string) {
    return await this.update(tokenId, {
      status: 'CONSUMED',
      consumed_at: new Date() as unknown as Date,
      updated_at: new Date() as unknown as Date
    })
  }

  /**
   * Create child tokens for parallel execution
   */
  async createChildTokens(
    parentTokenId: string,
    nodeIds: string[],
    instanceId: string
  ) {
    const tokens: WorkflowTokenCreateData[] = nodeIds.map(nodeId => ({
      instance_id: instanceId,
      node_id: nodeId,
      token_type: 'EXECUTION' as const,
      status: 'ACTIVE' as const,
      parent_token_id: parentTokenId,
      variables: JSON.stringify({})
    }))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await this.createMany(tokens as any)
  }
}

export class WorkflowIncidentRepository extends BaseRepository<'workflow_incidents'> {
  constructor() {
    super('workflow_incidents')
  }

  /**
   * Get open incidents
   */
  async getOpenIncidents(instanceId?: string) {
    let query = this.db
      .selectFrom('workflow_incidents')
      .selectAll()
      .where('resolution_status', 'in', ['OPEN', 'IN_PROGRESS'])

    if (instanceId) {
      query = query.where('instance_id', '=', instanceId)
    }

    return await query.orderBy('created_at', 'desc').execute()
  }

  /**
   * Record an incident
   */
  async recordIncident(params: {
    instanceId: string
    tokenId?: string
    type: WorkflowIncidentsTable['incident_type']
    severity: WorkflowIncidentsTable['severity']
    nodeId?: string
    errorCode?: string
    errorMessage?: string
    stackTrace?: string
    data?: Record<string, unknown>
  }) {
    return await this.create({
      workflow_instance_id: params.instanceId,
      instance_id: params.instanceId,
      token_id: params.tokenId ?? null,
      incident_type: params.type,
      type: params.type,
      severity: params.severity,
      node_id: params.nodeId ?? null,
      error_code: params.errorCode ?? null,
      error_message: params.errorMessage ?? null,
      message: params.errorMessage ?? 'Workflow incident',
      stack_trace: params.stackTrace ?? null,
      incident_data: JSON.stringify(params.data || {}),
      resolution_status: 'OPEN',
      status: 'OPEN',
      retry_count: 0,
      max_retries: 3
    })
  }

  /**
   * Resolve an incident
   */
  async resolveIncident(
    incidentId: string,
    resolvedBy: string,
    notes?: string
  ) {
    return await this.update(incidentId, {
      resolution_status: 'RESOLVED',
      resolved_by: resolvedBy,
      resolved_at: new Date() as unknown as Date,
      resolution_notes: notes,
      updated_at: new Date() as unknown as Date
    })
  }

  /**
   * Get incident statistics
   */
  async getStatistics(timeRange?: { start: Date; end: Date }): Promise<IncidentStatistics[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = this.db
      .selectFrom('workflow_incidents')
      .select([
        'incident_type',
        'severity',
        'resolution_status',
        this.db.fn.count('id').as('count')
      ])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .groupBy(['incident_type', 'severity', 'resolution_status']) as any

    if (timeRange) {
      query = query
        .where('created_at', '>=', timeRange.start as unknown as Date)
        .where('created_at', '<=', timeRange.end as unknown as Date)
    }

    return await query.execute() as IncidentStatistics[]
  }
}

// Export repository instances
export const workflowDefinitionRepo = new WorkflowDefinitionRepository()
export const workflowInstanceRepo = new WorkflowInstanceRepository()
export const workflowTokenRepo = new WorkflowTokenRepository()
export const workflowIncidentRepo = new WorkflowIncidentRepository()
