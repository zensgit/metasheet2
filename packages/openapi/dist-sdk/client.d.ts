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
