function createHttpError(message, status, url) {
    const error = new Error(message);
    error.status = status;
    error.url = url;
    return error;
}
function encodePathSegment(value) {
    return encodeURIComponent(value);
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
function getErrorMessage(payload, status) {
    if (payload && typeof payload === 'object') {
        const error = payload.error;
        if (typeof error === 'string') {
            return error;
        }
        if (error && typeof error === 'object' && typeof error.message === 'string') {
            return error.message;
        }
        if (typeof payload.message === 'string') {
            return payload.message;
        }
    }
    return `HTTP ${status}`;
}
function unwrapResponse(response) {
    if (response.status >= 400) {
        throw createHttpError(getErrorMessage(response.json, response.status), response.status, response.url);
    }
    return response.json;
}
function unwrapSuccessData(response) {
    const json = unwrapResponse(response);
    if (!json || typeof json !== 'object' || json.success === false || !('data' in json)) {
        throw createHttpError(getErrorMessage(json, response.status), response.status, response.url);
    }
    return json.data;
}
function unwrapSuccessMessage(response) {
    const json = unwrapResponse(response);
    if (!json || typeof json !== 'object' || json.success === false) {
        throw createHttpError(getErrorMessage(json, response.status), response.status, response.url);
    }
    return json;
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
export function createApprovalsClient(opts) {
    const client = createClient(opts);
    async function getApproval(id) {
        const response = await client.request('GET', `/api/approvals/${encodePathSegment(id)}`);
        return unwrapResponse(response);
    }
    async function listPendingApprovals(params = {}) {
        const response = await client.request('GET', `/api/approvals/pending${toQueryString({
            limit: typeof params.limit === 'number' ? String(params.limit) : undefined,
            offset: typeof params.offset === 'number' ? String(params.offset) : undefined,
        })}`);
        return unwrapResponse(response);
    }
    async function getApprovalHistory(id) {
        const response = await client.request('GET', `/api/approvals/${encodePathSegment(id)}/history`);
        return unwrapResponse(response);
    }
    async function approveApproval(id, payload = {}) {
        const response = await client.request('POST', `/api/approvals/${encodePathSegment(id)}/approve`, payload);
        const json = unwrapResponse(response);
        if (json && typeof json === 'object' && ('success' in json || 'ok' in json)) {
            if (json.success === false || json.ok === false) {
                throw createHttpError(getErrorMessage(json, response.status), response.status, response.url);
            }
        }
        return json;
    }
    async function rejectApproval(id, payload) {
        const response = await client.request('POST', `/api/approvals/${encodePathSegment(id)}/reject`, payload);
        const json = unwrapResponse(response);
        if (json && typeof json === 'object' && ('success' in json || 'ok' in json)) {
            if (json.success === false || json.ok === false) {
                throw createHttpError(getErrorMessage(json, response.status), response.status, response.url);
            }
        }
        return json;
    }
    return {
        ...client,
        approveApproval,
        getApproval,
        getApprovalHistory,
        listPendingApprovals,
        rejectApproval,
    };
}
export function createWorkflowClient(opts) {
    const client = createClient(opts);
    async function deployWorkflowDefinition(payload) {
        const response = await client.request('POST', '/api/workflow/deploy', payload);
        return unwrapSuccessData(response);
    }
    async function listWorkflowDefinitions(params = {}) {
        const response = await client.request('GET', `/api/workflow/definitions${toQueryString({
            category: params.category,
            latest: typeof params.latest === 'boolean' ? String(params.latest) : undefined,
        })}`);
        return unwrapSuccessData(response);
    }
    async function startWorkflow(key, payload = {}) {
        const response = await client.request('POST', `/api/workflow/start/${encodePathSegment(key)}`, payload);
        return unwrapSuccessData(response);
    }
    async function listWorkflowInstances(params = {}) {
        const response = await client.request('GET', `/api/workflow/instances${toQueryString({
            businessKey: params.businessKey,
            processKey: params.processKey,
            state: params.state,
        })}`);
        return unwrapSuccessData(response);
    }
    async function getWorkflowInstance(instanceId) {
        const response = await client.request('GET', `/api/workflow/instances/${encodePathSegment(instanceId)}`);
        return unwrapSuccessData(response);
    }
    async function listWorkflowTasks(params = {}) {
        const response = await client.request('GET', `/api/workflow/tasks${toQueryString({
            assignee: params.assignee,
            candidateGroup: params.candidateGroup,
            candidateUser: params.candidateUser,
            processInstanceId: params.processInstanceId,
            state: params.state,
        })}`);
        return unwrapSuccessData(response);
    }
    async function claimWorkflowTask(taskId) {
        const response = await client.request('POST', `/api/workflow/tasks/${encodePathSegment(taskId)}/claim`);
        return unwrapSuccessMessage(response);
    }
    async function completeWorkflowTask(taskId, payload = {}) {
        const response = await client.request('POST', `/api/workflow/tasks/${encodePathSegment(taskId)}/complete`, payload);
        return unwrapSuccessMessage(response);
    }
    async function sendWorkflowMessage(payload) {
        const response = await client.request('POST', '/api/workflow/message', payload);
        return unwrapSuccessMessage(response);
    }
    async function broadcastWorkflowSignal(payload) {
        const response = await client.request('POST', '/api/workflow/signal', payload);
        return unwrapSuccessMessage(response);
    }
    async function listWorkflowIncidents(params = {}) {
        const response = await client.request('GET', `/api/workflow/incidents${toQueryString({
            processInstanceId: params.processInstanceId,
            state: params.state,
        })}`);
        return unwrapSuccessData(response);
    }
    async function resolveWorkflowIncident(incidentId) {
        const response = await client.request('POST', `/api/workflow/incidents/${encodePathSegment(incidentId)}/resolve`);
        return unwrapSuccessMessage(response);
    }
    async function listWorkflowAuditLogs(params = {}) {
        const response = await client.request('GET', `/api/workflow/audit${toQueryString({
            from: params.from,
            processInstanceId: params.processInstanceId,
            taskId: params.taskId,
            to: params.to,
            userId: params.userId,
        })}`);
        return unwrapSuccessData(response);
    }
    return {
        ...client,
        broadcastWorkflowSignal,
        claimWorkflowTask,
        completeWorkflowTask,
        deployWorkflowDefinition,
        getWorkflowInstance,
        listWorkflowAuditLogs,
        listWorkflowDefinitions,
        listWorkflowIncidents,
        listWorkflowInstances,
        listWorkflowTasks,
        resolveWorkflowIncident,
        sendWorkflowMessage,
        startWorkflow,
    };
}
