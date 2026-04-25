import { describe, expect, it, vi } from 'vitest'

import { EventBusService } from '../../src/core/EventBusService'
import { runWithRequestContext } from '../../src/context/request-context'

function buildService(): EventBusService {
  const service = new EventBusService()
  const testable = service as unknown as {
    validateEventSchema: ReturnType<typeof vi.fn>
    getEventType: ReturnType<typeof vi.fn>
  }
  testable.validateEventSchema = vi.fn().mockResolvedValue(undefined)
  testable.getEventType = vi.fn().mockResolvedValue({
    id: 'evt-test',
    event_name: 'approval.test',
    category: 'test',
    is_async: true,
    is_persistent: false,
    is_transactional: false,
    max_retries: 0,
    retry_delay_ms: 0,
  })
  return service
}

describe('EventBusService request-context enrichment', () => {
  it('defaults event correlation and actor metadata from the active request context', async () => {
    const service = buildService()
    const emitted: unknown[] = []
    service.on('approval.test', (event) => emitted.push(event))

    await runWithRequestContext(
      { correlationId: 'corr-123', userId: 'user-1', tenantId: 'tenant-a' },
      () => service.publish('approval.test', { ok: true }, {
        metadata: { source: 'unit' },
      }),
    )

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      event_name: 'approval.test',
      correlation_id: 'corr-123',
      metadata: {
        source: 'unit',
        user_id: 'user-1',
        tenant_id: 'tenant-a',
      },
    })
  })

  it('preserves explicit correlation and metadata overrides', async () => {
    const service = buildService()
    const emitted: unknown[] = []
    service.on('approval.test', (event) => emitted.push(event))

    await runWithRequestContext(
      { correlationId: 'corr-request', userId: 'user-request', tenantId: 'tenant-request' },
      () => service.publish('approval.test', { ok: true }, {
        correlation_id: 'corr-explicit',
        metadata: {
          user_id: 'user-explicit',
          tenant_id: 'tenant-explicit',
        },
      }),
    )

    expect(emitted[0]).toMatchObject({
      correlation_id: 'corr-explicit',
      metadata: {
        user_id: 'user-explicit',
        tenant_id: 'tenant-explicit',
      },
    })
  })

  it('keeps events outside a request context unchanged', async () => {
    const service = buildService()
    const emitted: unknown[] = []
    service.on('approval.test', (event) => emitted.push(event))

    await service.publish('approval.test', { ok: true }, {
      metadata: { source: 'system' },
    })

    expect(emitted[0]).toMatchObject({
      correlation_id: undefined,
      metadata: { source: 'system' },
    })
  })
})
