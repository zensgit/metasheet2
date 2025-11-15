/**
 * Workflow-specific Repository
 * Handles workflow definitions, instances, tokens, and incidents
 */
import { BaseRepository } from './BaseRepository';
import type { WorkflowInstancesTable, WorkflowIncidentsTable } from '../types';
export declare class WorkflowDefinitionRepository extends BaseRepository<'workflow_definitions'> {
    constructor();
    /**
     * Find active workflow definition by name
     */
    findActiveByName(name: string): Promise<{
        id: string;
        name: string;
        version: string;
        type: "BPMN" | "DAG" | "STATE_MACHINE";
        status: "DRAFT" | "ACTIVE" | "DEPRECATED";
        created_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        updated_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        definition: any;
        settings: any;
        created_by: string;
        variables_schema: any;
    }>;
    /**
     * Get all versions of a workflow
     */
    getAllVersions(name: string): Promise<{
        id: string;
        name: string;
        version: string;
        type: "BPMN" | "DAG" | "STATE_MACHINE";
        status: "DRAFT" | "ACTIVE" | "DEPRECATED";
        created_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        updated_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        definition: any;
        settings: any;
        created_by: string;
        variables_schema: any;
    }[]>;
}
export declare class WorkflowInstanceRepository extends BaseRepository<'workflow_instances'> {
    constructor();
    /**
     * Find running instances
     */
    findRunning(): Promise<{
        error: string;
        id: string;
        status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "SUSPENDED";
        completed_at: Date;
        created_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        updated_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        definition_id: string;
        parent_instance_id: string;
        variables: any;
        context: any;
        started_at: Date;
    }[]>;
    /**
     * Update instance status with timestamp
     */
    updateStatus(id: string, status: WorkflowInstancesTable['status'], error?: string): Promise<{
        error: string;
        id: string;
        status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "SUSPENDED";
        completed_at: Date;
        created_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        updated_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        definition_id: string;
        parent_instance_id: string;
        variables: any;
        context: any;
        started_at: Date;
    }>;
    /**
     * Get instances with incidents
     */
    getInstancesWithIncidents(): Promise<{
        id: string;
        status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "SUSPENDED";
        created_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        definition_id: string;
        incident_count: string | number | bigint;
        open_incidents: string | number | bigint;
    }[]>;
}
export declare class WorkflowTokenRepository extends BaseRepository<'workflow_tokens'> {
    constructor();
    /**
     * Get active tokens for an instance
     */
    getActiveTokens(instanceId: string): Promise<{
        id: string;
        status: "ACTIVE" | "CANCELLED" | "CONSUMED";
        created_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        updated_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        variables: any;
        instance_id: string;
        node_id: string;
        token_type: "WAIT" | "EXECUTION" | "COMPENSATE";
        parent_token_id: string;
        consumed_at: Date;
    }[]>;
    /**
     * Consume a token
     */
    consumeToken(tokenId: string): Promise<{
        id: string;
        status: "ACTIVE" | "CANCELLED" | "CONSUMED";
        created_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        updated_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        variables: any;
        instance_id: string;
        node_id: string;
        token_type: "WAIT" | "EXECUTION" | "COMPENSATE";
        parent_token_id: string;
        consumed_at: Date;
    }>;
    /**
     * Create child tokens for parallel execution
     */
    createChildTokens(parentTokenId: string, nodeIds: string[], instanceId: string): Promise<{
        id: string;
        status: "ACTIVE" | "CANCELLED" | "CONSUMED";
        created_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        updated_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        variables: any;
        instance_id: string;
        node_id: string;
        token_type: "WAIT" | "EXECUTION" | "COMPENSATE";
        parent_token_id: string;
        consumed_at: Date;
    }[]>;
}
export declare class WorkflowIncidentRepository extends BaseRepository<'workflow_incidents'> {
    constructor();
    /**
     * Get open incidents
     */
    getOpenIncidents(instanceId?: string): Promise<{
        id: string;
        created_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        updated_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        error_message: string;
        severity: "CRITICAL" | "WARNING" | "ERROR";
        instance_id: string;
        token_id: string;
        incident_type: "VALIDATION_ERROR" | "ERROR" | "TIMEOUT" | "COMPENSATION_FAILED" | "SYSTEM_ERROR";
        node_id: string;
        error_code: string;
        stack_trace: string;
        incident_data: any;
        resolution_status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "IGNORED";
        resolved_by: string;
        resolved_at: Date;
        resolution_notes: string;
        retry_count: number;
        max_retries: number;
    }[]>;
    /**
     * Record an incident
     */
    recordIncident(params: {
        instanceId: string;
        tokenId?: string;
        type: WorkflowIncidentsTable['incident_type'];
        severity: WorkflowIncidentsTable['severity'];
        nodeId?: string;
        errorCode?: string;
        errorMessage?: string;
        stackTrace?: string;
        data?: any;
    }): Promise<{
        id: string;
        created_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        updated_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        error_message: string;
        severity: "CRITICAL" | "WARNING" | "ERROR";
        instance_id: string;
        token_id: string;
        incident_type: "VALIDATION_ERROR" | "ERROR" | "TIMEOUT" | "COMPENSATION_FAILED" | "SYSTEM_ERROR";
        node_id: string;
        error_code: string;
        stack_trace: string;
        incident_data: any;
        resolution_status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "IGNORED";
        resolved_by: string;
        resolved_at: Date;
        resolution_notes: string;
        retry_count: number;
        max_retries: number;
    }>;
    /**
     * Resolve an incident
     */
    resolveIncident(incidentId: string, resolvedBy: string, notes?: string): Promise<{
        id: string;
        created_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        updated_at: {
            readonly __select__: Date;
            readonly __insert__: string | Date;
            readonly __update__: string | Date;
        };
        error_message: string;
        severity: "CRITICAL" | "WARNING" | "ERROR";
        instance_id: string;
        token_id: string;
        incident_type: "VALIDATION_ERROR" | "ERROR" | "TIMEOUT" | "COMPENSATION_FAILED" | "SYSTEM_ERROR";
        node_id: string;
        error_code: string;
        stack_trace: string;
        incident_data: any;
        resolution_status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "IGNORED";
        resolved_by: string;
        resolved_at: Date;
        resolution_notes: string;
        retry_count: number;
        max_retries: number;
    }>;
    /**
     * Get incident statistics
     */
    getStatistics(timeRange?: {
        start: Date;
        end: Date;
    }): Promise<{
        severity: "CRITICAL" | "WARNING" | "ERROR";
        incident_type: "VALIDATION_ERROR" | "ERROR" | "TIMEOUT" | "COMPENSATION_FAILED" | "SYSTEM_ERROR";
        resolution_status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "IGNORED";
        count: string | number | bigint;
    }[]>;
}
export declare const workflowDefinitionRepo: WorkflowDefinitionRepository;
export declare const workflowInstanceRepo: WorkflowInstanceRepository;
export declare const workflowTokenRepo: WorkflowTokenRepository;
export declare const workflowIncidentRepo: WorkflowIncidentRepository;
//# sourceMappingURL=WorkflowRepository.d.ts.map