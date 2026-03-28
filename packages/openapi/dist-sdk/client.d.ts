export type FetchLike = typeof fetch;
export interface ClientOptions {
    baseUrl: string;
    getToken: () => Promise<string> | string;
    fetch?: FetchLike;
}
export interface ClientResponse<T = unknown> {
    status: number;
    etag?: string;
    json: T;
}
export interface ClientTextResponse {
    status: number;
    etag?: string;
    text: string;
    contentDisposition?: string;
}
export interface RequestClient {
    request: <T = unknown>(method: string, path: string, body?: unknown, ifMatch?: string) => Promise<ClientResponse<T>>;
    requestWithRetry: <T = unknown>(method: string, path: string, body?: unknown, etag?: string, retries?: number) => Promise<ClientResponse<T>>;
    requestText?: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<ClientTextResponse>;
}
export interface ApiError {
    code?: string;
    message?: string;
    [key: string]: unknown;
}
export interface ApiEnvelope<T> {
    ok?: boolean;
    data?: T;
    error?: ApiError;
}
export interface DirectApiEnvelope<T, M = unknown> {
    success?: boolean;
    data?: T;
    metadata?: M;
    error?: string | ApiError;
}
export interface PaginationOptions {
    limit?: number;
    offset?: number;
}
export interface PlmListResponse<T = Record<string, unknown>> {
    items: T[];
    total?: number;
    limit?: number;
    offset?: number;
}
export interface PlmApprovalHistoryResponse<T = Record<string, unknown>> {
    approvalId: string;
    items: T[];
    total?: number;
}
export interface ListPlmProductsParams extends PaginationOptions {
    query?: string;
    status?: string;
    itemType?: string;
}
export interface GetPlmProductParams {
    itemType?: string;
    itemNumber?: string;
}
export interface GetPlmBomParams {
    depth?: number;
    effectiveAt?: string;
}
export interface ListPlmDocumentsParams extends PaginationOptions {
    productId: string;
    role?: string;
}
export interface ListPlmApprovalsParams extends PaginationOptions {
    productId?: string;
    status?: string;
    requesterId?: string;
}
export interface GetPlmWhereUsedParams {
    itemId: string;
    recursive?: boolean;
    maxLevels?: number;
}
export interface ComparePlmBomParams {
    leftId: string;
    rightId: string;
    leftType?: 'item' | 'version';
    rightType?: 'item' | 'version';
    lineKey?: string;
    compareMode?: string;
    maxLevels?: number;
    includeChildFields?: boolean;
    includeSubstitutes?: boolean;
    includeEffectivity?: boolean;
    includeRelationshipProps?: string[];
    effectiveAt?: string;
}
export interface PlmApprovalActionParams {
    approvalId: string;
    version: number;
    reason?: string;
    comment?: string;
}
export type PlmWorkbenchTeamViewKind = 'documents' | 'cad' | 'approvals' | 'workbench' | 'audit';
export type PlmTeamFilterPresetKind = 'bom' | 'where-used';
export type PlmWorkbenchBatchAction = 'archive' | 'restore' | 'delete';
export type PlmCollaborativeAuditResourceType = 'plm-team-preset-batch' | 'plm-team-preset-default' | 'plm-team-view-batch' | 'plm-team-view-default';
export interface ListPlmCollaborativeAuditLogsParams {
    page?: number;
    pageSize?: number;
    q?: string;
    actorId?: string;
    action?: string;
    resourceType?: PlmCollaborativeAuditResourceType | '';
    kind?: string;
    from?: string;
    to?: string;
}
export interface GetPlmCollaborativeAuditSummaryParams {
    windowMinutes?: number;
    limit?: number;
}
export interface ExportPlmCollaborativeAuditLogsParams extends ListPlmCollaborativeAuditLogsParams {
    limit?: number;
}
export interface PlmCollaborativeAuditLogsResponse<T = Record<string, unknown>> {
    items: T[];
    page?: number;
    pageSize?: number;
    total?: number;
    metadata?: {
        resourceTypes?: PlmCollaborativeAuditResourceType[];
    };
}
export interface PlmCollaborativeAuditSummaryRow {
    action?: string;
    resourceType?: PlmCollaborativeAuditResourceType;
    total?: number;
}
export interface PlmCollaborativeAuditSummaryResponse {
    windowMinutes?: number;
    actions?: PlmCollaborativeAuditSummaryRow[];
    resourceTypes?: PlmCollaborativeAuditSummaryRow[];
}
export interface PlmCollaborativeAuditCsvExportResponse {
    filename: string;
    csvText: string;
}
export interface PlmWorkbenchBatchResult<T = Record<string, unknown>> {
    action?: string;
    processedIds?: string[];
    skippedIds?: string[];
    items?: T[];
    metadata?: {
        requestedTotal?: number;
        processedTotal?: number;
        skippedTotal?: number;
        processedKinds?: string[];
    };
}
export interface PlmTeamViewListMetadata {
    total?: number;
    activeTotal?: number;
    archivedTotal?: number;
    tenantId?: string;
    kind?: PlmWorkbenchTeamViewKind;
    defaultViewId?: string | null;
}
export interface PlmTeamFilterPresetListMetadata {
    total?: number;
    activeTotal?: number;
    archivedTotal?: number;
    tenantId?: string;
    kind?: PlmTeamFilterPresetKind;
    defaultPresetId?: string | null;
}
export interface PlmDirectListResponse<T = Record<string, unknown>, M = Record<string, unknown>> {
    items: T[];
    metadata?: M;
}
export interface SavePlmWorkbenchTeamViewParams<TState = unknown> {
    kind: PlmWorkbenchTeamViewKind;
    name: string;
    state: TState;
    isDefault?: boolean;
}
export interface SavePlmTeamFilterPresetParams<TState = unknown> {
    kind: PlmTeamFilterPresetKind;
    name: string;
    state: TState;
}
export interface AddPlmSubstituteParams {
    bomLineId: string;
    substituteItemId: string;
    properties?: Record<string, unknown>;
}
export interface RemovePlmSubstituteParams {
    bomLineId: string;
    substituteId: string;
}
export interface GetPlmCadDiffParams {
    fileId: string;
    otherFileId: string;
}
export interface UpdatePlmCadPayload {
    fileId: string;
    payload: Record<string, unknown>;
}
export declare function createClient(opts: ClientOptions): RequestClient;
export declare function createPlmFederationClient(clientOrOptions: ClientOptions | RequestClient): {
    listProducts<T = Record<string, unknown>>(params?: ListPlmProductsParams): Promise<PlmListResponse<T>>;
    getProduct<T = Record<string, unknown>>(productId: string, params?: GetPlmProductParams): Promise<T>;
    getBom<T = Record<string, unknown>>(productId: string, params?: GetPlmBomParams): Promise<PlmListResponse<T>>;
    listDocuments<T = Record<string, unknown>>(params: ListPlmDocumentsParams): Promise<PlmListResponse<T>>;
    listApprovals<T = Record<string, unknown>>(params?: ListPlmApprovalsParams): Promise<PlmListResponse<T>>;
    getApprovalHistory<T = Record<string, unknown>>(approvalId: string): Promise<PlmApprovalHistoryResponse<T>>;
    approveApproval<T = Record<string, unknown>>(params: PlmApprovalActionParams): Promise<T>;
    rejectApproval<T = Record<string, unknown>>(params: PlmApprovalActionParams): Promise<T>;
    getWhereUsed<T = Record<string, unknown>>(params: GetPlmWhereUsedParams): Promise<T>;
    compareBom<T = Record<string, unknown>>(params: ComparePlmBomParams): Promise<T>;
    getBomCompareSchema<T = Record<string, unknown>>(): Promise<T>;
    listSubstitutes<T = Record<string, unknown>>(bomLineId: string): Promise<T>;
    addSubstitute<T = Record<string, unknown>>(params: AddPlmSubstituteParams): Promise<T>;
    removeSubstitute<T = Record<string, unknown>>(params: RemovePlmSubstituteParams): Promise<T>;
    getCadProperties<T = Record<string, unknown>>(fileId: string): Promise<T>;
    getCadViewState<T = Record<string, unknown>>(fileId: string): Promise<T>;
    getCadReview<T = Record<string, unknown>>(fileId: string): Promise<T>;
    getCadHistory<T = Record<string, unknown>>(fileId: string): Promise<T>;
    getCadDiff<T = Record<string, unknown>>(params: GetPlmCadDiffParams): Promise<T>;
    getCadMeshStats<T = Record<string, unknown>>(fileId: string): Promise<T>;
    updateCadProperties<T = Record<string, unknown>>(params: UpdatePlmCadPayload): Promise<T>;
    updateCadViewState<T = Record<string, unknown>>(params: UpdatePlmCadPayload): Promise<T>;
    updateCadReview<T = Record<string, unknown>>(params: UpdatePlmCadPayload): Promise<T>;
};
export declare function createPlmWorkbenchClient(clientOrOptions: ClientOptions | RequestClient): {
    listTeamViews<T = Record<string, unknown>>(kind: PlmWorkbenchTeamViewKind): Promise<PlmDirectListResponse<T, PlmTeamViewListMetadata>>;
    saveTeamView<T = Record<string, unknown>, TState = unknown>(params: SavePlmWorkbenchTeamViewParams<TState>): Promise<T>;
    renameTeamView<T = Record<string, unknown>>(id: string, name: string): Promise<T>;
    deleteTeamView<T = Record<string, unknown>>(id: string): Promise<T>;
    duplicateTeamView<T = Record<string, unknown>>(id: string, name?: string): Promise<T>;
    transferTeamView<T = Record<string, unknown>>(id: string, ownerUserId: string): Promise<T>;
    setTeamViewDefault<T = Record<string, unknown>>(id: string): Promise<T>;
    clearTeamViewDefault<T = Record<string, unknown>>(id: string): Promise<T>;
    archiveTeamView<T = Record<string, unknown>>(id: string): Promise<T>;
    restoreTeamView<T = Record<string, unknown>>(id: string): Promise<T>;
    batchTeamViews<T = Record<string, unknown>>(action: PlmWorkbenchBatchAction, ids: string[]): Promise<PlmWorkbenchBatchResult<T>>;
    listTeamFilterPresets<T = Record<string, unknown>>(kind: PlmTeamFilterPresetKind): Promise<PlmDirectListResponse<T, PlmTeamFilterPresetListMetadata>>;
    saveTeamFilterPreset<T = Record<string, unknown>, TState = unknown>(params: SavePlmTeamFilterPresetParams<TState>): Promise<T>;
    renameTeamFilterPreset<T = Record<string, unknown>>(id: string, name: string): Promise<T>;
    deleteTeamFilterPreset<T = Record<string, unknown>>(id: string): Promise<T>;
    duplicateTeamFilterPreset<T = Record<string, unknown>>(id: string, name?: string): Promise<T>;
    transferTeamFilterPreset<T = Record<string, unknown>>(id: string, ownerUserId: string): Promise<T>;
    setTeamFilterPresetDefault<T = Record<string, unknown>>(id: string): Promise<T>;
    clearTeamFilterPresetDefault<T = Record<string, unknown>>(id: string): Promise<T>;
    archiveTeamFilterPreset<T = Record<string, unknown>>(id: string): Promise<T>;
    restoreTeamFilterPreset<T = Record<string, unknown>>(id: string): Promise<T>;
    batchTeamFilterPresets<T = Record<string, unknown>>(action: PlmWorkbenchBatchAction, ids: string[]): Promise<PlmWorkbenchBatchResult<T>>;
    listCollaborativeAuditLogs<T = Record<string, unknown>>(params?: ListPlmCollaborativeAuditLogsParams): Promise<PlmCollaborativeAuditLogsResponse<T>>;
    getCollaborativeAuditSummary(params?: GetPlmCollaborativeAuditSummaryParams): Promise<PlmCollaborativeAuditSummaryResponse>;
    exportCollaborativeAuditLogsCsv(params?: ExportPlmCollaborativeAuditLogsParams): Promise<PlmCollaborativeAuditCsvExportResponse>;
};
