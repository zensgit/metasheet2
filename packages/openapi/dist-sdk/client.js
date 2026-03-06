function createHttpError(message, status, url) {
    const error = new Error(message);
    error.status = status;
    error.url = url;
    return error;
}
function toQueryString(params) {
    const search = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
        if (value) {
            search.set(key, value);
        }
    });
    const query = search.toString();
    return query ? `?${query}` : '';
}
export function createClient(opts) {
    const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
    async function send(method, path, token, body, ifMatch) {
        const url = opts.baseUrl + path;
        const headers = {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
        };
        if (ifMatch)
            headers['if-match'] = ifMatch;
        const res = await f(url, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const etag = res.headers.get('etag') || undefined;
        const json = (await res.json().catch(() => undefined));
        return { status: res.status, etag, url: res.url || url, json };
    }
    async function request(method, path, body, ifMatch) {
        const token = await opts.getToken();
        let response = await send(method, path, token, body, ifMatch);
        if (response.status === 401 && opts.refreshToken) {
            const refreshedToken = await opts.refreshToken();
            response = await send(method, path, refreshedToken, body, ifMatch);
        }
        return response;
    }
    async function requestWithRetry(method, path, body, etag, retries = 1) {
        const r = await request(method, path, body, etag);
        if (r.status === 409 && retries > 0) {
            // refresh ETag then retry once
            const g = await request('GET', path.replace(/\/(approve|reject|return|revoke)$/, ''));
            return request(method, path, body, g.etag);
        }
        return r;
    }
    return { request, requestWithRetry };
}
export function createMetaSheetClient(opts) {
    const client = createClient(opts);
    async function getUniverMetaView(params) {
        const response = await client.request('GET', `/api/univer-meta/view${toQueryString({
            sheetId: params.sheetId,
            viewId: params.viewId,
        })}`);
        if (!response.json?.ok || !response.json.data) {
            throw createHttpError(response.json?.error?.message || `HTTP ${response.status}`, response.status, response.url);
        }
        return response.json.data;
    }
    async function listUniverMetaViews(params) {
        const response = await client.request('GET', `/api/univer-meta/views${toQueryString({
            sheetId: params.sheetId,
        })}`);
        if (!response.json?.ok || !response.json.data) {
            throw createHttpError(response.json?.error?.message || `HTTP ${response.status}`, response.status, response.url);
        }
        return response.json.data.views;
    }
    return {
        ...client,
        getUniverMetaView,
        listUniverMetaViews,
    };
}
