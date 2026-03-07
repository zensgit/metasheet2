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
