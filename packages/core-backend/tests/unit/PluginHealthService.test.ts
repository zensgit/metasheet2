import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PluginHealthService } from '../../src/services/PluginHealthService'
import { eventBus } from '../../src/integration/events/event-bus'

// Mock dependencies
vi.mock('../../src/integration/events/event-bus', () => ({
  eventBus: {
    subscribe: vi.fn(),
    emit: vi.fn()
  }
}))

vi.mock('../../src/metrics/metrics', () => ({
  metrics: {
    pluginStatus: { labels: () => ({ set: vi.fn() }) }
  }
}))

describe('PluginHealthService', () => {
  let service: PluginHealthService
  let listeners: Record<string, (payload: any) => void> = {}

  beforeEach(() => {
    vi.clearAllMocks()
    listeners = {}
    vi.mocked(eventBus.subscribe).mockImplementation((event, handler) => {
      listeners[event as string] = handler
      return 'id'
    })
    service = new PluginHealthService()
  })

  it('should initialize with empty health map', () => {
    expect(service.getAllPluginHealth()).toEqual([])
  })

  it('should update status on plugin:activated', () => {
    listeners['plugin:activated']({ pluginName: 'test-plugin' })
    
    const health = service.getPluginHealth('test-plugin')
    expect(health).toBeDefined()
    expect(health?.status).toBe('active')
    expect(health?.activatedAt).toBeDefined()
  })

  it('should update status on plugin:deactivated', () => {
    listeners['plugin:activated']({ pluginName: 'test-plugin' })
    listeners['plugin:deactivated']({ pluginName: 'test-plugin' })
    
    const health = service.getPluginHealth('test-plugin')
    expect(health?.status).toBe('inactive')
  })

  it('should record errors on plugin:error', () => {
    listeners['plugin:error']({ pluginName: 'test-plugin', error: 'Something went wrong' })
    
    const health = service.getPluginHealth('test-plugin')
    expect(health?.errorCount).toBe(1)
    expect(health?.lastError?.message).toBe('Something went wrong')
  })

  it('should mark as degraded after multiple errors', () => {
    listeners['plugin:activated']({ pluginName: 'test-plugin' })
    
    for (let i = 0; i < 6; i++) {
      listeners['plugin:error']({ pluginName: 'test-plugin', error: 'Error' })
    }
    
    const health = service.getPluginHealth('test-plugin')
    expect(health?.status).toBe('degraded')
  })

  it('should record heartbeats', () => {
    listeners['plugin:heartbeat']({ pluginName: 'test-plugin', data: { cpu: 10 } })
    
    const health = service.getPluginHealth('test-plugin')
    expect(health?.lastHeartbeat).toBeDefined()
    expect(health?.metadata?.cpu).toBe(10)
  })
})
