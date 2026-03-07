import { describe, expect, it, vi } from 'vitest'
import { createApprovalsClient, createClient, createMetaSheetClient, createWorkflowClient } from '../client.ts'

function createResponse<T>(status: number, json: T, etag?: string, url?: string) {
  return {
    status,
    url,
    headers: {
      get: vi.fn((name: string) => (name.toLowerCase() === 'etag' ? etag ?? null : null)),
    },
    json: vi.fn(async () => json),
  }
}

describe('@metasheet/sdk client', () => {
  it('sends auth and conditional headers and parses the JSON payload', async () => {
    const fetch = vi.fn(async () => createResponse(200, { ok: true }, 'etag-1'))
    const client = createClient({
      baseUrl: 'https://api.example.com',
      getToken: () => 'token-123',
      fetch: fetch as typeof globalThis.fetch,
    })

    const response = await client.request<{ ok: boolean }>(
      'PATCH',
      '/records/1',
      { title: 'Updated' },
      'etag-0',
    )

    expect(fetch).toHaveBeenCalledWith('https://api.example.com/records/1', {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
        'if-match': 'etag-0',
      },
      body: JSON.stringify({ title: 'Updated' }),
    })
    expect(response).toEqual({
      status: 200,
      etag: 'etag-1',
      url: 'https://api.example.com/records/1',
      json: { ok: true },
    })
  })

  it('returns undefined JSON when the response body cannot be parsed', async () => {
    const fetch = vi.fn(async () => ({
      status: 204,
      headers: { get: vi.fn(() => null) },
      json: vi.fn(async () => {
        throw new Error('no json body')
      }),
    }))
    const client = createClient({
      baseUrl: 'https://api.example.com',
      getToken: async () => 'token-123',
      fetch: fetch as typeof globalThis.fetch,
    })

    await expect(client.request('GET', '/health')).resolves.toEqual({
      status: 204,
      etag: undefined,
      url: 'https://api.example.com/health',
      json: undefined,
    })
  })

  it('refreshes the parent ETag and retries once after a 409 conflict', async () => {
    const fetch = vi.fn()
    fetch
      .mockResolvedValueOnce(createResponse(409, { message: 'conflict' }, 'stale-etag'))
      .mockResolvedValueOnce(createResponse(200, { data: { id: 'wf-1' } }, 'fresh-etag'))
      .mockResolvedValueOnce(createResponse(200, { ok: true }, 'fresh-etag'))

    const client = createClient({
      baseUrl: 'https://api.example.com',
      getToken: () => 'token-123',
      fetch: fetch as typeof globalThis.fetch,
    })

    const response = await client.requestWithRetry(
      'POST',
      '/workflow/123/approve',
      { comment: 'approved' },
      'stale-etag',
    )

    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.example.com/workflow/123/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
        'if-match': 'stale-etag',
      },
      body: JSON.stringify({ comment: 'approved' }),
    })
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.example.com/workflow/123', {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
      },
      body: undefined,
    })
    expect(fetch).toHaveBeenNthCalledWith(3, 'https://api.example.com/workflow/123/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
        'if-match': 'fresh-etag',
      },
      body: JSON.stringify({ comment: 'approved' }),
    })
    expect(response).toEqual({
      status: 200,
      etag: 'fresh-etag',
      url: 'https://api.example.com/workflow/123/approve',
      json: { ok: true },
    })
  })

  it('refreshes the token and retries once after a 401 response', async () => {
    const fetch = vi.fn()
    fetch
      .mockResolvedValueOnce(createResponse(401, { message: 'expired' }, undefined, 'https://api.example.com/views'))
      .mockResolvedValueOnce(createResponse(200, { ok: true }, undefined, 'https://api.example.com/views'))

    const client = createClient({
      baseUrl: 'https://api.example.com',
      getToken: () => 'stale-token',
      refreshToken: () => 'fresh-token',
      fetch: fetch as typeof globalThis.fetch,
    })

    await expect(client.request('GET', '/views')).resolves.toEqual({
      status: 200,
      etag: undefined,
      url: 'https://api.example.com/views',
      json: { ok: true },
    })

    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.example.com/views', {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer stale-token',
      },
      body: undefined,
    })
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.example.com/views', {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer fresh-token',
      },
      body: undefined,
    })
  })

  it('provides business helpers for the Univer meta endpoints', async () => {
    const fetch = vi.fn()
    fetch
      .mockResolvedValueOnce(createResponse(200, {
        ok: true,
        data: {
          views: [{ id: 'view-1', name: 'Main Grid', type: 'grid' }],
        },
      }, undefined, 'https://api.example.com/api/univer-meta/views?sheetId=sheet-1'))
      .mockResolvedValueOnce(createResponse(200, {
        ok: true,
        data: {
          fields: [{ id: 'name', name: 'Name', type: 'string' }],
          rows: [{ id: 'row-1', data: { name: 'Alice' } }],
        },
      }, undefined, 'https://api.example.com/api/univer-meta/view?sheetId=sheet-1&viewId=view-1'))

    const client = createMetaSheetClient({
      baseUrl: 'https://api.example.com',
      getToken: () => 'token-123',
      fetch: fetch as typeof globalThis.fetch,
    })

    await expect(client.listUniverMetaViews({ sheetId: 'sheet-1' })).resolves.toEqual([
      { id: 'view-1', name: 'Main Grid', type: 'grid' },
    ])
    await expect(client.getUniverMetaView({ sheetId: 'sheet-1', viewId: 'view-1' })).resolves.toEqual({
      fields: [{ id: 'name', name: 'Name', type: 'string' }],
      rows: [{ id: 'row-1', data: { name: 'Alice' } }],
    })
  })

  it('provides business helpers for the approvals endpoints', async () => {
    const fetch = vi.fn()
    fetch
      .mockResolvedValueOnce(createResponse(200, {
        id: 'approval/1',
        status: 'pending',
        version: 3,
      }, undefined, 'https://api.example.com/api/approvals/approval%2F1'))
      .mockResolvedValueOnce(createResponse(200, {
        data: [{ id: 'approval-2', status: 'pending', version: 1 }],
        total: 1,
        limit: 10,
        offset: 5,
      }, undefined, 'https://api.example.com/api/approvals/pending?limit=10&offset=5'))
      .mockResolvedValueOnce(createResponse(200, {
        data: [{ action: 'approve', actor_id: 'u1', to_status: 'approved' }],
        total: 1,
      }, undefined, 'https://api.example.com/api/approvals/approval%2F1/history'))
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        id: 'approval/1',
        status: 'approved',
        version: 4,
      }, undefined, 'https://api.example.com/api/approvals/approval%2F1/approve'))
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        id: 'approval/1',
        status: 'rejected',
        version: 5,
      }, undefined, 'https://api.example.com/api/approvals/approval%2F1/reject'))

    const client = createApprovalsClient({
      baseUrl: 'https://api.example.com',
      getToken: () => 'token-123',
      fetch: fetch as typeof globalThis.fetch,
    })

    await expect(client.getApproval('approval/1')).resolves.toEqual({
      id: 'approval/1',
      status: 'pending',
      version: 3,
    })
    await expect(client.listPendingApprovals({ limit: 10, offset: 5 })).resolves.toEqual({
      data: [{ id: 'approval-2', status: 'pending', version: 1 }],
      total: 1,
      limit: 10,
      offset: 5,
    })
    await expect(client.getApprovalHistory('approval/1')).resolves.toEqual({
      data: [{ action: 'approve', actor_id: 'u1', to_status: 'approved' }],
      total: 1,
    })
    await expect(client.approveApproval('approval/1', { comment: 'LGTM' })).resolves.toEqual({
      success: true,
      id: 'approval/1',
      status: 'approved',
      version: 4,
    })
    await expect(
      client.rejectApproval('approval/1', { reason: 'Need changes', comment: 'missing fields' }),
    ).resolves.toEqual({
      success: true,
      id: 'approval/1',
      status: 'rejected',
      version: 5,
    })

    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.example.com/api/approvals/approval%2F1', {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
      },
      body: undefined,
    })
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.example.com/api/approvals/pending?limit=10&offset=5', {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
      },
      body: undefined,
    })
    expect(fetch).toHaveBeenNthCalledWith(4, 'https://api.example.com/api/approvals/approval%2F1/approve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
      },
      body: JSON.stringify({ comment: 'LGTM' }),
    })
    expect(fetch).toHaveBeenNthCalledWith(5, 'https://api.example.com/api/approvals/approval%2F1/reject', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
      },
      body: JSON.stringify({ reason: 'Need changes', comment: 'missing fields' }),
    })
  })

  it('throws structured errors when approvals helpers receive an error payload', async () => {
    const fetch = vi.fn(async () =>
      createResponse(400, { error: 'Rejection reason is required' }, undefined, 'https://api.example.com/api/approvals/a-1/reject'),
    )
    const client = createApprovalsClient({
      baseUrl: 'https://api.example.com',
      getToken: () => 'token-123',
      fetch: fetch as typeof globalThis.fetch,
    })

    await expect(client.rejectApproval('a-1', { reason: '' })).rejects.toMatchObject({
      message: 'Rejection reason is required',
      status: 400,
      url: 'https://api.example.com/api/approvals/a-1/reject',
    })
  })

  it('provides business helpers for workflow listing and detail endpoints', async () => {
    const fetch = vi.fn()
    fetch
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        data: [{ id: 'def-1', key: 'leave/request', name: 'Leave Request', version: 3 }],
      }, undefined, 'https://api.example.com/api/workflow/definitions?category=hr&latest=true'))
      .mockResolvedValueOnce(createResponse(201, {
        success: true,
        data: { instanceId: 'inst-1', message: 'Process started successfully' },
      }, undefined, 'https://api.example.com/api/workflow/start/leave%2Frequest'))
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        data: [{ id: 'inst-1', process_definition_key: 'leave/request', state: 'ACTIVE', variables: { days: 2 } }],
      }, undefined, 'https://api.example.com/api/workflow/instances?state=ACTIVE&processKey=leave%2Frequest'))
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        data: {
          id: 'inst-1',
          process_definition_key: 'leave/request',
          state: 'ACTIVE',
          variables: { days: 2 },
          activities: [{ id: 'act-1', type: 'startEvent' }],
          variableList: [{ name: 'days', json_value: 2 }],
        },
      }, undefined, 'https://api.example.com/api/workflow/instances/inst-1'))
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        data: [{ id: 'task-1', process_instance_id: 'inst-1', state: 'READY', variables: { days: 2 } }],
      }, undefined, 'https://api.example.com/api/workflow/tasks?candidateUser=u1&state=READY'))
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        data: [{ id: 'incident-1', state: 'OPEN', process_instance_id: 'inst-1' }],
      }, undefined, 'https://api.example.com/api/workflow/incidents?processInstanceId=inst-1&state=OPEN'))
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        data: [{ id: 'audit-1', process_instance_id: 'inst-1', user_id: 'u1' }],
      }, undefined, 'https://api.example.com/api/workflow/audit?processInstanceId=inst-1&userId=u1'))

    const client = createWorkflowClient({
      baseUrl: 'https://api.example.com',
      getToken: () => 'token-123',
      fetch: fetch as typeof globalThis.fetch,
    })

    await expect(client.listWorkflowDefinitions({ category: 'hr', latest: true })).resolves.toEqual([
      { id: 'def-1', key: 'leave/request', name: 'Leave Request', version: 3 },
    ])
    await expect(client.startWorkflow('leave/request', { businessKey: 'biz-1', variables: { days: 2 } })).resolves.toEqual({
      instanceId: 'inst-1',
      message: 'Process started successfully',
    })
    await expect(client.listWorkflowInstances({ state: 'ACTIVE', processKey: 'leave/request' })).resolves.toEqual([
      { id: 'inst-1', process_definition_key: 'leave/request', state: 'ACTIVE', variables: { days: 2 } },
    ])
    await expect(client.getWorkflowInstance('inst-1')).resolves.toEqual({
      id: 'inst-1',
      process_definition_key: 'leave/request',
      state: 'ACTIVE',
      variables: { days: 2 },
      activities: [{ id: 'act-1', type: 'startEvent' }],
      variableList: [{ name: 'days', json_value: 2 }],
    })
    await expect(client.listWorkflowTasks({ candidateUser: 'u1', state: 'READY' })).resolves.toEqual([
      { id: 'task-1', process_instance_id: 'inst-1', state: 'READY', variables: { days: 2 } },
    ])
    await expect(client.listWorkflowIncidents({ processInstanceId: 'inst-1', state: 'OPEN' })).resolves.toEqual([
      { id: 'incident-1', state: 'OPEN', process_instance_id: 'inst-1' },
    ])
    await expect(client.listWorkflowAuditLogs({ processInstanceId: 'inst-1', userId: 'u1' })).resolves.toEqual([
      { id: 'audit-1', process_instance_id: 'inst-1', user_id: 'u1' },
    ])

    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.example.com/api/workflow/definitions?category=hr&latest=true', {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
      },
      body: undefined,
    })
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.example.com/api/workflow/start/leave%2Frequest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
      },
      body: JSON.stringify({ businessKey: 'biz-1', variables: { days: 2 } }),
    })
    expect(fetch).toHaveBeenNthCalledWith(5, 'https://api.example.com/api/workflow/tasks?candidateUser=u1&state=READY', {
      method: 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
      },
      body: undefined,
    })
  })

  it('provides business helpers for workflow command endpoints', async () => {
    const fetch = vi.fn()
    fetch
      .mockResolvedValueOnce(createResponse(201, {
        success: true,
        data: { definitionId: 'def-1', message: 'Process deployed successfully' },
      }, undefined, 'https://api.example.com/api/workflow/deploy'))
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        message: 'Task claimed successfully',
      }, undefined, 'https://api.example.com/api/workflow/tasks/task%2F1/claim'))
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        message: 'Task completed successfully',
      }, undefined, 'https://api.example.com/api/workflow/tasks/task%2F1/complete'))
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        message: 'Message sent successfully',
      }, undefined, 'https://api.example.com/api/workflow/message'))
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        message: 'Signal broadcast successfully',
      }, undefined, 'https://api.example.com/api/workflow/signal'))
      .mockResolvedValueOnce(createResponse(200, {
        success: true,
        message: 'Incident resolved successfully',
      }, undefined, 'https://api.example.com/api/workflow/incidents/incident%2F1/resolve'))

    const client = createWorkflowClient({
      baseUrl: 'https://api.example.com',
      getToken: () => 'token-123',
      fetch: fetch as typeof globalThis.fetch,
    })

    await expect(client.deployWorkflowDefinition({
      bpmnXml: '<xml />',
      key: 'leave/request',
      name: 'Leave Request',
      category: 'hr',
    })).resolves.toEqual({
      definitionId: 'def-1',
      message: 'Process deployed successfully',
    })
    await expect(client.claimWorkflowTask('task/1')).resolves.toEqual({
      success: true,
      message: 'Task claimed successfully',
    })
    await expect(client.completeWorkflowTask('task/1', {
      variables: { approved: true },
      formData: { note: 'ok' },
    })).resolves.toEqual({
      success: true,
      message: 'Task completed successfully',
    })
    await expect(client.sendWorkflowMessage({
      messageName: 'InvoiceReceived',
      correlationKey: 'invoice-1',
      variables: { amount: 12 },
    })).resolves.toEqual({
      success: true,
      message: 'Message sent successfully',
    })
    await expect(client.broadcastWorkflowSignal({
      signalName: 'NightlySync',
      variables: { source: 'scheduler' },
    })).resolves.toEqual({
      success: true,
      message: 'Signal broadcast successfully',
    })
    await expect(client.resolveWorkflowIncident('incident/1')).resolves.toEqual({
      success: true,
      message: 'Incident resolved successfully',
    })

    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.example.com/api/workflow/deploy', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
      },
      body: JSON.stringify({
        bpmnXml: '<xml />',
        key: 'leave/request',
        name: 'Leave Request',
        category: 'hr',
      }),
    })
    expect(fetch).toHaveBeenNthCalledWith(3, 'https://api.example.com/api/workflow/tasks/task%2F1/complete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
      },
      body: JSON.stringify({ variables: { approved: true }, formData: { note: 'ok' } }),
    })
    expect(fetch).toHaveBeenNthCalledWith(6, 'https://api.example.com/api/workflow/incidents/incident%2F1/resolve', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token-123',
      },
      body: undefined,
    })
  })

  it('throws structured errors when workflow helpers receive an error payload', async () => {
    const fetch = vi.fn(async () =>
      createResponse(404, { error: 'Process instance not found' }, undefined, 'https://api.example.com/api/workflow/instances/missing'),
    )
    const client = createWorkflowClient({
      baseUrl: 'https://api.example.com',
      getToken: () => 'token-123',
      fetch: fetch as typeof globalThis.fetch,
    })

    await expect(client.getWorkflowInstance('missing')).rejects.toMatchObject({
      message: 'Process instance not found',
      status: 404,
      url: 'https://api.example.com/api/workflow/instances/missing',
    })
  })
})
