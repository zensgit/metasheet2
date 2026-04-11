function trimTrailingSlash(input) {
    return input.replace(/\/+$/, '');
}
function joinUrl(baseUrl, path) {
    return `${trimTrailingSlash(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}
function buildQueryString(params) {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
        if (value === undefined || value === '')
            return;
        searchParams.set(key, String(value));
    });
    return searchParams.toString();
}
function withQuery(path, params) {
    const query = buildQueryString(params);
    return query ? `${path}?${query}` : path;
}
function withPagination(pagination) {
    if (!pagination)
        return undefined;
    if (pagination.limit === undefined && pagination.offset === undefined)
        return undefined;
    return {
        limit: pagination.limit ?? 100,
        offset: pagination.offset ?? 0,
    };
}
function toRequestClient(clientOrOptions) {
    if ('request' in clientOrOptions && 'requestWithRetry' in clientOrOptions) {
        return clientOrOptions;
    }
    return createClient(clientOrOptions);
}
function buildApiEnvelopeError(error, fallback) {
    const nextError = new Error(error?.message || fallback);
    if (!error || typeof error !== 'object') {
        return nextError;
    }
    Object.assign(nextError, error);
    if (!nextError.message) {
        nextError.message = fallback;
    }
    return nextError;
}
function unwrapData(response, fallback) {
    const envelope = response.json;
    if (response.status >= 400) {
        throw buildApiEnvelopeError(envelope?.error, fallback);
    }
    if (envelope && typeof envelope === 'object' && 'ok' in envelope) {
        if (envelope.ok === false) {
            throw buildApiEnvelopeError(envelope.error, fallback);
        }
        return envelope.data;
    }
    return response.json;
}
function buildDirectApiError(error, fallback) {
    if (typeof error === 'string' && error.trim()) {
        return new Error(error.trim());
    }
    const nextError = new Error(error && typeof error === 'object' && typeof error.message === 'string'
        ? error.message
        : fallback);
    if (!error || typeof error !== 'object') {
        return nextError;
    }
    Object.assign(nextError, error);
    if (!nextError.message) {
        nextError.message = fallback;
    }
    return nextError;
}
function parseRecord(value) {
    if (!value.trim()) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function unwrapDirectData(response, fallback) {
    return unwrapDirectEnvelope(response, fallback).data;
}
function unwrapDirectEnvelope(response, fallback) {
    const envelope = response.json;
    const directError = envelope && typeof envelope === 'object' && 'error' in envelope
        ? envelope.error
        : undefined;
    if (response.status >= 400) {
        throw buildDirectApiError(directError, fallback);
    }
    if (envelope && typeof envelope === 'object' && ('success' in envelope || 'data' in envelope || 'error' in envelope)) {
        if (envelope.success === false) {
            throw buildDirectApiError(directError, fallback);
        }
        return {
            data: envelope.data,
            metadata: envelope.metadata,
        };
    }
    return {
        data: response.json,
    };
}
async function requestPlmQuery(client, body, fallback) {
    const response = await client.request('POST', '/api/federation/plm/query', body);
    return unwrapData(response, fallback);
}
async function requestPlmMutate(client, body, fallback) {
    const response = await client.request('POST', '/api/federation/plm/mutate', body);
    return unwrapData(response, fallback);
}
async function requestPlmGet(client, path, fallback) {
    const response = await client.request('GET', path);
    return unwrapData(response, fallback);
}
async function requestDirectApi(client, method, path, fallback, body) {
    const response = await client.request(method, path, body);
    return unwrapDirectData(response, fallback);
}
async function requestDirectEnvelope(client, method, path, fallback, body) {
    const response = await client.request(method, path, body);
    return unwrapDirectEnvelope(response, fallback);
}
async function requestDirectText(client, method, path, fallback, body, headers) {
    if (!client.requestText) {
        throw new Error(fallback);
    }
    const response = await client.requestText(method, path, body, headers);
    if (response.status >= 400) {
        const envelope = parseRecord(response.text);
        const directError = envelope && 'error' in envelope
            ? envelope.error
            : undefined;
        throw buildDirectApiError(directError, response.text.trim() || fallback);
    }
    return response;
}
export function createClient(opts) {
    const f = opts.fetch || fetch;
    async function buildHeaders(body, ifMatch, extraHeaders) {
        const token = await opts.getToken();
        const headers = {
            authorization: `Bearer ${token}`,
            ...(extraHeaders || {}),
        };
        if (body !== undefined) {
            headers['content-type'] = 'application/json';
        }
        if (ifMatch) {
            headers['if-match'] = ifMatch;
        }
        return headers;
    }
    async function request(method, path, body, ifMatch) {
        const headers = await buildHeaders(body, ifMatch);
        const res = await f(joinUrl(opts.baseUrl, path), {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const etag = res.headers.get('etag') || undefined;
        const json = await res.json().catch(() => ({}));
        return { status: res.status, etag, json };
    }
    async function requestText(method, path, body, extraHeaders) {
        const headers = await buildHeaders(body, undefined, extraHeaders);
        const res = await f(joinUrl(opts.baseUrl, path), {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const etag = res.headers.get('etag') || undefined;
        const text = await res.text();
        return {
            status: res.status,
            etag,
            text,
            contentDisposition: res.headers.get('content-disposition') || undefined,
        };
    }
    async function requestWithRetry(method, path, body, etag, retries = 1) {
        const response = await request(method, path, body, etag);
        if (response.status === 409 && retries > 0) {
            const getPath = path.replace(/\/(approve|reject|return|revoke)$/, '');
            const latest = await request('GET', getPath);
            return request(method, path, body, latest.etag);
        }
        return response;
    }
    return { request, requestWithRetry, requestText };
}
export function createPlmFederationClient(clientOrOptions) {
    const client = toRequestClient(clientOrOptions);
    return {
        async listProducts(params = {}) {
            const filters = {};
            if (params.query)
                filters.query = params.query;
            if (params.status)
                filters.status = params.status;
            if (params.itemType)
                filters.itemType = params.itemType;
            return requestPlmQuery(client, {
                operation: 'products',
                pagination: withPagination(params),
                filters: Object.keys(filters).length > 0 ? filters : undefined,
            }, 'Failed to load PLM products');
        },
        async getProduct(productId, params = {}) {
            return requestPlmGet(client, withQuery(`/api/federation/plm/products/${encodeURIComponent(productId)}`, {
                itemType: params.itemType,
                itemNumber: params.itemNumber,
            }), 'Failed to load PLM product');
        },
        async getBom(productId, params = {}) {
            return requestPlmGet(client, withQuery(`/api/federation/plm/products/${encodeURIComponent(productId)}/bom`, {
                depth: params.depth,
                effective_at: params.effectiveAt,
            }), 'Failed to load PLM BOM');
        },
        async getMetadata(itemType) {
            return requestPlmGet(client, `/api/federation/plm/metadata/${encodeURIComponent(itemType)}`, 'Failed to load PLM metadata');
        },
        async listDocuments(params) {
            const filters = {};
            if (params.role)
                filters.role = params.role;
            return requestPlmQuery(client, {
                operation: 'documents',
                productId: params.productId,
                pagination: withPagination(params) ?? { limit: 100, offset: 0 },
                filters: Object.keys(filters).length > 0 ? filters : undefined,
            }, 'Failed to load PLM documents');
        },
        async listApprovals(params = {}) {
            const filters = {};
            if (params.status && params.status !== 'all')
                filters.status = params.status;
            if (params.requesterId)
                filters.requesterId = params.requesterId;
            return requestPlmQuery(client, {
                operation: 'approvals',
                productId: params.productId,
                pagination: withPagination(params),
                filters: Object.keys(filters).length > 0 ? filters : undefined,
            }, 'Failed to load PLM approvals');
        },
        async getApprovalHistory(approvalId) {
            return requestPlmQuery(client, {
                operation: 'approval_history',
                approvalId,
            }, 'Failed to load PLM approval history');
        },
        async approveApproval(params) {
            return requestPlmMutate(client, {
                operation: 'approval_approve',
                approvalId: params.approvalId,
                version: params.version,
                comment: params.comment,
            }, 'Failed to approve PLM approval');
        },
        async rejectApproval(params) {
            return requestPlmMutate(client, {
                operation: 'approval_reject',
                approvalId: params.approvalId,
                version: params.version,
                reason: params.reason,
                comment: params.comment,
            }, 'Failed to reject PLM approval');
        },
        async getWhereUsed(params) {
            return requestPlmQuery(client, {
                operation: 'where_used',
                itemId: params.itemId,
                recursive: params.recursive,
                maxLevels: params.maxLevels,
            }, 'Failed to load PLM where-used data');
        },
        async compareBom(params) {
            return requestPlmQuery(client, {
                operation: 'bom_compare',
                leftId: params.leftId,
                rightId: params.rightId,
                leftType: params.leftType ?? 'item',
                rightType: params.rightType ?? 'item',
                lineKey: params.lineKey,
                compareMode: params.compareMode,
                maxLevels: params.maxLevels,
                includeChildFields: params.includeChildFields,
                includeSubstitutes: params.includeSubstitutes,
                includeEffectivity: params.includeEffectivity,
                includeRelationshipProps: params.includeRelationshipProps,
                effectiveAt: params.effectiveAt,
            }, 'Failed to compare PLM BOMs');
        },
        async getBomCompareSchema() {
            return requestPlmQuery(client, {
                operation: 'bom_compare_schema',
            }, 'Failed to load PLM BOM compare schema');
        },
        async listSubstitutes(bomLineId) {
            return requestPlmQuery(client, {
                operation: 'substitutes',
                bomLineId,
            }, 'Failed to load PLM substitutes');
        },
        async addSubstitute(params) {
            return requestPlmMutate(client, {
                operation: 'substitutes_add',
                bomLineId: params.bomLineId,
                substituteItemId: params.substituteItemId,
                properties: params.properties,
            }, 'Failed to add PLM substitute');
        },
        async removeSubstitute(params) {
            return requestPlmMutate(client, {
                operation: 'substitutes_remove',
                bomLineId: params.bomLineId,
                substituteId: params.substituteId,
            }, 'Failed to remove PLM substitute');
        },
        async getCadProperties(fileId) {
            return requestPlmQuery(client, {
                operation: 'cad_properties',
                fileId,
            }, 'Failed to load PLM CAD properties');
        },
        async getCadViewState(fileId) {
            return requestPlmQuery(client, {
                operation: 'cad_view_state',
                fileId,
            }, 'Failed to load PLM CAD view state');
        },
        async getCadReview(fileId) {
            return requestPlmQuery(client, {
                operation: 'cad_review',
                fileId,
            }, 'Failed to load PLM CAD review');
        },
        async getCadHistory(fileId) {
            return requestPlmQuery(client, {
                operation: 'cad_history',
                fileId,
            }, 'Failed to load PLM CAD history');
        },
        async getCadDiff(params) {
            return requestPlmQuery(client, {
                operation: 'cad_diff',
                fileId: params.fileId,
                otherFileId: params.otherFileId,
            }, 'Failed to load PLM CAD diff');
        },
        async getCadMeshStats(fileId) {
            return requestPlmQuery(client, {
                operation: 'cad_mesh_stats',
                fileId,
            }, 'Failed to load PLM CAD mesh stats');
        },
        async updateCadProperties(params) {
            return requestPlmMutate(client, {
                operation: 'cad_properties_update',
                fileId: params.fileId,
                payload: params.payload,
            }, 'Failed to update PLM CAD properties');
        },
        async updateCadViewState(params) {
            return requestPlmMutate(client, {
                operation: 'cad_view_state_update',
                fileId: params.fileId,
                payload: params.payload,
            }, 'Failed to update PLM CAD view state');
        },
        async updateCadReview(params) {
            return requestPlmMutate(client, {
                operation: 'cad_review_update',
                fileId: params.fileId,
                payload: params.payload,
            }, 'Failed to update PLM CAD review');
        },
    };
}
export function createPlmWorkbenchClient(clientOrOptions) {
    const client = toRequestClient(clientOrOptions);
    return {
        async listTeamViews(kind) {
            const response = await requestDirectEnvelope(client, 'GET', withQuery('/api/plm-workbench/views/team', { kind }), 'Failed to load PLM team views');
            return {
                items: Array.isArray(response.data) ? response.data : [],
                metadata: response.metadata,
            };
        },
        async saveTeamView(params) {
            return requestDirectApi(client, 'POST', '/api/plm-workbench/views/team', 'Failed to save PLM team view', params);
        },
        async renameTeamView(id, name) {
            return requestDirectApi(client, 'PATCH', `/api/plm-workbench/views/team/${encodeURIComponent(id)}`, 'Failed to rename PLM team view', { name });
        },
        async deleteTeamView(id) {
            return requestDirectApi(client, 'DELETE', `/api/plm-workbench/views/team/${encodeURIComponent(id)}`, 'Failed to delete PLM team view');
        },
        async duplicateTeamView(id, name) {
            return requestDirectApi(client, 'POST', `/api/plm-workbench/views/team/${encodeURIComponent(id)}/duplicate`, 'Failed to duplicate PLM team view', name ? { name } : {});
        },
        async transferTeamView(id, ownerUserId) {
            return requestDirectApi(client, 'POST', `/api/plm-workbench/views/team/${encodeURIComponent(id)}/transfer`, 'Failed to transfer PLM team view', { ownerUserId });
        },
        async setTeamViewDefault(id) {
            return requestDirectApi(client, 'POST', `/api/plm-workbench/views/team/${encodeURIComponent(id)}/default`, 'Failed to set PLM team view default');
        },
        async clearTeamViewDefault(id) {
            return requestDirectApi(client, 'DELETE', `/api/plm-workbench/views/team/${encodeURIComponent(id)}/default`, 'Failed to clear PLM team view default');
        },
        async archiveTeamView(id) {
            return requestDirectApi(client, 'POST', `/api/plm-workbench/views/team/${encodeURIComponent(id)}/archive`, 'Failed to archive PLM team view');
        },
        async restoreTeamView(id) {
            return requestDirectApi(client, 'POST', `/api/plm-workbench/views/team/${encodeURIComponent(id)}/restore`, 'Failed to restore PLM team view');
        },
        async batchTeamViews(action, ids) {
            const response = await requestDirectEnvelope(client, 'POST', '/api/plm-workbench/views/team/batch', 'Failed to batch update PLM team views', { action, ids });
            return {
                ...response.data,
                metadata: response.metadata,
            };
        },
        async listTeamFilterPresets(kind) {
            const response = await requestDirectEnvelope(client, 'GET', withQuery('/api/plm-workbench/filter-presets/team', { kind }), 'Failed to load PLM team filter presets');
            return {
                items: Array.isArray(response.data) ? response.data : [],
                metadata: response.metadata,
            };
        },
        async saveTeamFilterPreset(params) {
            return requestDirectApi(client, 'POST', '/api/plm-workbench/filter-presets/team', 'Failed to save PLM team filter preset', params);
        },
        async renameTeamFilterPreset(id, name) {
            return requestDirectApi(client, 'PATCH', `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}`, 'Failed to rename PLM team filter preset', { name });
        },
        async deleteTeamFilterPreset(id) {
            return requestDirectApi(client, 'DELETE', `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}`, 'Failed to delete PLM team filter preset');
        },
        async duplicateTeamFilterPreset(id, name) {
            return requestDirectApi(client, 'POST', `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}/duplicate`, 'Failed to duplicate PLM team filter preset', name ? { name } : {});
        },
        async transferTeamFilterPreset(id, ownerUserId) {
            return requestDirectApi(client, 'POST', `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}/transfer`, 'Failed to transfer PLM team filter preset', { ownerUserId });
        },
        async setTeamFilterPresetDefault(id) {
            return requestDirectApi(client, 'POST', `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}/default`, 'Failed to set PLM team filter preset default');
        },
        async clearTeamFilterPresetDefault(id) {
            return requestDirectApi(client, 'DELETE', `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}/default`, 'Failed to clear PLM team filter preset default');
        },
        async archiveTeamFilterPreset(id) {
            return requestDirectApi(client, 'POST', `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}/archive`, 'Failed to archive PLM team filter preset');
        },
        async restoreTeamFilterPreset(id) {
            return requestDirectApi(client, 'POST', `/api/plm-workbench/filter-presets/team/${encodeURIComponent(id)}/restore`, 'Failed to restore PLM team filter preset');
        },
        async batchTeamFilterPresets(action, ids) {
            const response = await requestDirectEnvelope(client, 'POST', '/api/plm-workbench/filter-presets/team/batch', 'Failed to batch update PLM team filter presets', { action, ids });
            return {
                ...response.data,
                metadata: response.metadata,
            };
        },
        async listCollaborativeAuditLogs(params = {}) {
            const response = await requestDirectEnvelope(client, 'GET', withQuery('/api/plm-workbench/audit-logs', {
                page: params.page,
                pageSize: params.pageSize,
                q: params.q,
                actorId: params.actorId,
                action: params.action,
                resourceType: params.resourceType,
                kind: params.kind,
                from: params.from,
                to: params.to,
            }), 'Failed to load PLM collaborative audit logs');
            return {
                items: Array.isArray(response.data?.items) ? response.data.items : [],
                page: response.data?.page,
                pageSize: response.data?.pageSize,
                total: response.data?.total,
                metadata: response.metadata,
            };
        },
        async getCollaborativeAuditSummary(params = {}) {
            return requestDirectApi(client, 'GET', withQuery('/api/plm-workbench/audit-logs/summary', {
                windowMinutes: params.windowMinutes,
                limit: params.limit,
            }), 'Failed to load PLM collaborative audit summary');
        },
        async exportCollaborativeAuditLogsCsv(params = {}) {
            const response = await requestDirectText(client, 'GET', withQuery('/api/plm-workbench/audit-logs/export.csv', {
                q: params.q,
                actorId: params.actorId,
                action: params.action,
                resourceType: params.resourceType,
                kind: params.kind,
                from: params.from,
                to: params.to,
                limit: params.limit,
            }), 'Failed to export PLM collaborative audit logs', undefined, { accept: 'text/csv' });
            const filename = response.contentDisposition?.match(/filename=\"?([^\";]+)\"?/)?.[1] || 'plm-collaborative-audit.csv';
            return {
                filename,
                csvText: response.text,
            };
        },
    };
}
