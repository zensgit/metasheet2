export function createClient(opts) {
    const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
    async function request(method, path, body, ifMatch) {
        const token = await opts.getToken();
        const headers = {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
        };
        if (ifMatch)
            headers['if-match'] = ifMatch;
        const res = await f(opts.baseUrl + path, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const etag = res.headers.get('etag') || undefined;
        const json = (await res.json().catch(() => undefined));
        return { status: res.status, etag, json };
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
