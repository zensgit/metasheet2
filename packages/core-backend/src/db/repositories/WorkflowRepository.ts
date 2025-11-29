// @ts-nocheck
/**
 * Workflow-specific Repository
 * Handles workflow definitions, instances, tokens, and incidents
 */

import { BaseRepository } from './BaseRepository'
import type {
  WorkflowDefinitionsTable,
  WorkflowInstancesTable,
  WorkflowTokensTable,
  WorkflowIncidentsTable
} from '../types'
import { db } from '../kysely'

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
    const updateData: any = { status, updated_at: new Date() }

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
  async getInstancesWithIncidents() {
    return await this.db
      .selectFrom('workflow_instances as wi')
      .innerJoin('workflow_incidents as inc', 'inc.instance_id', 'wi.id')
      .select([
        'wi.id',
        'wi.definition_id',
        'wi.status',
        'wi.created_at',
        this.db.fn.count('inc.id').as('incident_count'),
        this.db.fn
          .sum(
            this.db.raw<number>(`case when inc.resolution_status = 'OPEN' then 1 else 0 end`)
          )
          .as('open_incidents')
      ])
      .groupBy(['wi.id', 'wi.definition_id', 'wi.status', 'wi.created_at'])
      .having(this.db.fn.count('inc.id'), '>', 0)
      .execute()
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
      consumed_at: new Date(),
      updated_at: new Date()
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
    const tokens = nodeIds.map(nodeId => ({
      instance_id: instanceId,
      node_id: nodeId,
      token_type: 'EXECUTION' as const,
      status: 'ACTIVE' as const,
      parent_token_id: parentTokenId,
      variables: {}
    }))

    return await this.createMany(tokens)
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
    data?: any
  }) {
    return await this.create({
      instance_id: params.instanceId,
      token_id: params.tokenId,
      incident_type: params.type,
      severity: params.severity,
      node_id: params.nodeId,
      error_code: params.errorCode,
      error_message: params.errorMessage,
      stack_trace: params.stackTrace,
      incident_data: params.data || {},
      resolution_status: 'OPEN',
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
      resolved_at: new Date(),
      resolution_notes: notes,
      updated_at: new Date()
    })
  }

  /**
   * Get incident statistics
   */
  async getStatistics(timeRange?: { start: Date; end: Date }) {
    let query = this.db
      .selectFrom('workflow_incidents')
      .select([
        'incident_type',
        'severity',
        'resolution_status',
        this.db.fn.count('id').as('count')
      ])
      .groupBy(['incident_type', 'severity', 'resolution_status'])

    if (timeRange) {
      query = query
        .where('created_at', '>=', timeRange.start)
        .where('created_at', '<=', timeRange.end)
    }

    return await query.execute()
  }
}

// Export repository instances
export const workflowDefinitionRepo = new WorkflowDefinitionRepository()
export const workflowInstanceRepo = new WorkflowInstanceRepository()
export const workflowTokenRepo = new WorkflowTokenRepository()
export const workflowIncidentRepo = new WorkflowIncidentRepository()