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
export interface RequestClient {
    request: <T = unknown>(method: string, path: string, body?: unknown, ifMatch?: string) => Promise<ClientResponse<T>>;
    requestWithRetry: <T = unknown>(method: string, path: string, body?: unknown, etag?: string, retries?: number) => Promise<ClientResponse<T>>;
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
    comment?: string;
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
    getApprovalHistory<T = Record<string, unknown>>(approvalId: string): Promise<{
        items?: T[];
    }>;
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
