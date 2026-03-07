export type FetchLike = typeof globalThis.fetch;
export interface RequestResult<T = unknown> {
    status: number;
    etag?: string;
    url?: string;
    json: T;
}
export interface ClientOptions {
    baseUrl: string;
    getToken: () => Promise<string> | string;
    refreshToken?: () => Promise<string> | string;
    fetch?: FetchLike;
}
export interface MetaField {
    id: string;
    name: string;
    type: 'string' | 'number' | 'boolean' | 'formula' | 'select' | 'link' | 'lookup' | 'rollup';
    order?: number;
    property?: {
        options?: Array<{
            value: string;
            label?: string;
            color?: string;
        }>;
    };
}
export interface MetaRecord {
    id: string;
    data: Record<string, unknown>;
}
export interface MetaViewData {
    fields: MetaField[];
    rows: MetaRecord[];
}
export interface ViewOption {
    id: string;
    name: string;
    type?: string;
    sheetId?: string;
}
export interface MetaViewResponse {
    ok: boolean;
    data?: MetaViewData;
    error?: {
        message?: string;
    };
}
export interface MetaViewsResponse {
    ok: boolean;
    data?: {
        views: ViewOption[];
    };
    error?: {
        message?: string;
    };
}
export interface UniverMetaViewParams {
    sheetId: string;
    viewId?: string;
}
export interface UniverMetaViewsParams {
    sheetId: string;
}
export interface ApprovalInstance {
    id: string;
    status: string;
    version: number;
    created_at?: string;
    updated_at?: string;
}
export interface ApprovalRecord {
    action: string;
    actor_id: string;
    actor_name?: string | null;
    comment?: string | null;
    created_at?: string;
    from_status?: string | null;
    from_version?: number | null;
    id?: string;
    instance_id?: string;
    metadata?: Record<string, unknown>;
    occurred_at?: string;
    reason?: string | null;
    to_status?: string;
    to_version?: number;
}
export interface ApprovalActionPayload {
    comment?: string;
    metadata?: Record<string, unknown>;
}
export interface ApprovalRejectPayload extends ApprovalActionPayload {
    reason: string;
}
export interface PendingApprovalsParams {
    limit?: number;
    offset?: number;
}
export interface PendingApprovalsResponse {
    data: ApprovalInstance[];
    degraded?: boolean;
    limit?: number;
    offset?: number;
    total: number;
}
export interface ApprovalHistoryResponse {
    data: ApprovalRecord[];
    degraded?: boolean;
    total: number;
}
export interface ApprovalActionResponse {
    degraded?: boolean;
    id: string;
    ok?: boolean;
    status?: string;
    success?: boolean;
    version?: number;
}
export interface WorkflowDefinition {
    category?: string | null;
    diagram_json?: unknown;
    id: string;
    key: string;
    name: string;
    tenant_id?: string | null;
    version: number;
    [key: string]: unknown;
}
export interface WorkflowDeployPayload {
    bpmnXml: string;
    category?: string;
    description?: string;
    key?: string;
    name: string;
}
export interface WorkflowDeployResult {
    definitionId: string;
    message: string;
}
export interface WorkflowDefinitionsParams {
    category?: string;
    latest?: boolean;
}
export interface WorkflowStartPayload {
    businessKey?: string;
    variables?: Record<string, unknown>;
}
export interface WorkflowStartResult {
    instanceId: string;
    message: string;
}
export interface WorkflowInstancesParams {
    businessKey?: string;
    processKey?: string;
    state?: 'ACTIVE' | 'COMPLETED' | 'SUSPENDED';
}
export interface WorkflowInstance {
    business_key?: string;
    id: string;
    process_definition_key: string;
    start_time?: string;
    state: string;
    tenant_id?: string | null;
    variables?: Record<string, unknown>;
    [key: string]: unknown;
}
export interface WorkflowInstanceVariable {
    json_value?: unknown;
    [key: string]: unknown;
}
export interface WorkflowInstanceDetail extends WorkflowInstance {
    activities: Array<Record<string, unknown>>;
    variableList: WorkflowInstanceVariable[];
}
export interface WorkflowTasksParams {
    assignee?: string;
    candidateGroup?: string;
    candidateUser?: string;
    processInstanceId?: string;
    state?: string;
}
export interface WorkflowTask {
    assignee?: string;
    candidate_groups?: string[] | string;
    candidate_users?: string[] | string;
    created_at?: string;
    form_data?: Record<string, unknown> | null;
    id: string;
    process_instance_id: string;
    state: string;
    variables?: Record<string, unknown>;
    [key: string]: unknown;
}
export interface WorkflowTaskCompletePayload {
    formData?: Record<string, unknown>;
    variables?: Record<string, unknown>;
}
export interface WorkflowMessagePayload {
    correlationKey?: string;
    messageName: string;
    variables?: Record<string, unknown>;
}
export interface WorkflowSignalPayload {
    signalName: string;
    variables?: Record<string, unknown>;
}
export interface WorkflowIncidentsParams {
    processInstanceId?: string;
    state?: 'OPEN' | 'RESOLVED';
}
export interface WorkflowIncident {
    created_at?: string;
    id: string;
    process_instance_id?: string;
    resolved_at?: string | null;
    resolved_by?: string | null;
    state: string;
    [key: string]: unknown;
}
export interface WorkflowAuditParams {
    from?: string;
    processInstanceId?: string;
    taskId?: string;
    to?: string;
    userId?: string;
}
export interface WorkflowAuditLog {
    id: string;
    new_value?: unknown;
    old_value?: unknown;
    process_instance_id?: string;
    task_id?: string;
    timestamp?: string;
    user_id?: string;
    [key: string]: unknown;
}
export interface WorkflowMessageResponse {
    error?: unknown;
    message?: string;
    success?: boolean;
}
export declare function createClient(opts: ClientOptions): {
    request: <T = unknown>(method: string, path: string, body?: unknown, ifMatch?: string) => Promise<RequestResult<T>>;
    requestWithRetry: <T = unknown>(method: string, path: string, body?: unknown, etag?: string, retries?: number) => Promise<RequestResult<T>>;
};
export declare function createMetaSheetClient(opts: ClientOptions): {
    getUniverMetaView: (params: UniverMetaViewParams) => Promise<MetaViewData>;
    listUniverMetaViews: (params: UniverMetaViewsParams) => Promise<ViewOption[]>;
    request: <T = unknown>(method: string, path: string, body?: unknown, ifMatch?: string) => Promise<RequestResult<T>>;
    requestWithRetry: <T = unknown>(method: string, path: string, body?: unknown, etag?: string, retries?: number) => Promise<RequestResult<T>>;
};
export declare function createApprovalsClient(opts: ClientOptions): {
    approveApproval: (id: string, payload?: ApprovalActionPayload) => Promise<ApprovalActionResponse>;
    getApproval: (id: string) => Promise<ApprovalInstance>;
    getApprovalHistory: (id: string) => Promise<ApprovalHistoryResponse>;
    listPendingApprovals: (params?: PendingApprovalsParams) => Promise<PendingApprovalsResponse>;
    rejectApproval: (id: string, payload: ApprovalRejectPayload) => Promise<ApprovalActionResponse>;
    request: <T = unknown>(method: string, path: string, body?: unknown, ifMatch?: string) => Promise<RequestResult<T>>;
    requestWithRetry: <T = unknown>(method: string, path: string, body?: unknown, etag?: string, retries?: number) => Promise<RequestResult<T>>;
};
export declare function createWorkflowClient(opts: ClientOptions): {
    broadcastWorkflowSignal: (payload: WorkflowSignalPayload) => Promise<WorkflowMessageResponse>;
    claimWorkflowTask: (taskId: string) => Promise<WorkflowMessageResponse>;
    completeWorkflowTask: (taskId: string, payload?: WorkflowTaskCompletePayload) => Promise<WorkflowMessageResponse>;
    deployWorkflowDefinition: (payload: WorkflowDeployPayload) => Promise<WorkflowDeployResult>;
    getWorkflowInstance: (instanceId: string) => Promise<WorkflowInstanceDetail>;
    listWorkflowAuditLogs: (params?: WorkflowAuditParams) => Promise<WorkflowAuditLog[]>;
    listWorkflowDefinitions: (params?: WorkflowDefinitionsParams) => Promise<WorkflowDefinition[]>;
    listWorkflowIncidents: (params?: WorkflowIncidentsParams) => Promise<WorkflowIncident[]>;
    listWorkflowInstances: (params?: WorkflowInstancesParams) => Promise<WorkflowInstance[]>;
    listWorkflowTasks: (params?: WorkflowTasksParams) => Promise<WorkflowTask[]>;
    resolveWorkflowIncident: (incidentId: string) => Promise<WorkflowMessageResponse>;
    sendWorkflowMessage: (payload: WorkflowMessagePayload) => Promise<WorkflowMessageResponse>;
    startWorkflow: (key: string, payload?: WorkflowStartPayload) => Promise<WorkflowStartResult>;
    request: <T = unknown>(method: string, path: string, body?: unknown, ifMatch?: string) => Promise<RequestResult<T>>;
    requestWithRetry: <T = unknown>(method: string, path: string, body?: unknown, etag?: string, retries?: number) => Promise<RequestResult<T>>;
};
