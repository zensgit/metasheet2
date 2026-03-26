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
function unwrapData(response, fallback) {
    const envelope = response.json;
    if (response.status >= 400) {
        throw new Error(envelope?.error?.message || fallback);
    }
    if (envelope && typeof envelope === 'object' && 'ok' in envelope) {
        if (envelope.ok === false) {
            throw new Error(envelope.error?.message || fallback);
        }
        return envelope.data;
    }
    return response.json;
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
export function createClient(opts) {
    const f = opts.fetch || fetch;
    async function request(method, path, body, ifMatch) {
        const token = await opts.getToken();
        const headers = {
            authorization: `Bearer ${token}`,
        };
        if (body !== undefined) {
            headers['content-type'] = 'application/json';
        }
        if (ifMatch) {
            headers['if-match'] = ifMatch;
        }
        const res = await f(joinUrl(opts.baseUrl, path), {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const etag = res.headers.get('etag') || undefined;
        const json = await res.json().catch(() => ({}));
        return { status: res.status, etag, json };
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
    return { request, requestWithRetry };
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
