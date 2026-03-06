export type FetchLike = typeof globalThis.fetch;
export interface RequestResult<T = unknown> {
    status: number;
    etag?: string;
    json: T;
}
export interface ClientOptions {
    baseUrl: string;
    getToken: () => Promise<string> | string;
    fetch?: FetchLike;
}
export declare function createClient(opts: ClientOptions): {
    request: <T = unknown>(method: string, path: string, body?: unknown, ifMatch?: string) => Promise<RequestResult<T>>;
    requestWithRetry: <T = unknown>(method: string, path: string, body?: unknown, etag?: string, retries?: number) => Promise<RequestResult<T>>;
};
