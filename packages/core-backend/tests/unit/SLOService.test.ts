import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SLOService } from '../../src/services/SLOService'
import { registry } from '../../src/metrics/metrics'

// Mock dependencies
vi.mock('../../src/metrics/metrics', () => ({
  registry: {
    getMetricsAsJSON: vi.fn()
  }
}))

vi.mock('../../src/services/NotificationService', () => ({
  notificationService: {
    send: vi.fn().mockResolvedValue({ id: 'mock', status: 'sent' })
  }
}))

describe('SLOService', () => {
  let service: SLOService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new SLOService()
  })

  it('should calculate healthy status when no errors', async () => {
    vi.mocked(registry.getMetricsAsJSON).mockResolvedValue([
      {
        name: 'http_requests_total',
        values: [
          { value: 1000, labels: { status: '200' } },
          { value: 500, labels: { status: '201' } }
        ]
      }
    ])

    const status = await service.getSLOStatus()
    expect(status).toHaveLength(1)
    expect(status[0].status).toBe('healthy')
    expect(status[0].currentAvailability).toBe(1.0)
    expect(status[0].errorBudget.remainingPercentage).toBe(100)
  })

  it('should calculate at_risk status when errors consume budget', async () => {
    // Target 0.999, allowed error rate 0.001
    // Total 10000, allowed errors 10
    // If we have 9 errors, remaining is 1 (10%), so < 20% -> at_risk
    
    vi.mocked(registry.getMetricsAsJSON).mockResolvedValue([
      {
        name: 'http_requests_total',
        values: [
          { value: 9991, labels: { status: '200' } },
          { value: 9, labels: { status: '500' } }
        ]
      }
    ])

    const status = await service.getSLOStatus()
    expect(status).toHaveLength(1)
    expect(status[0].status).toBe('at_risk')
    expect(status[0].errorBudget.consumed).toBe(9)
    // total allowed = 10000 * 0.001 = 10
    expect(status[0].errorBudget.total).toBe(10)
    expect(status[0].errorBudget.remaining).toBe(1)
    expect(status[0].errorBudget.remainingPercentage).toBe(10)
  })

  it('should calculate violated status when budget exceeded', async () => {
    // Total 10000, allowed 10
    // Errors 11 -> violated

    vi.mocked(registry.getMetricsAsJSON).mockResolvedValue([
      {
        name: 'http_requests_total',
        values: [
          { value: 9989, labels: { status: '200' } },
          { value: 11, labels: { status: '500' } }
        ]
      }
    ])

    const status = await service.getSLOStatus()
    expect(status).toHaveLength(1)
    expect(status[0].status).toBe('violated')
    expect(status[0].errorBudget.remaining).toBe(0)
    expect(status[0].errorBudget.remainingPercentage).toBe(0)
  })

  describe('Visualization', () => {
    it('should return visualization data with budget bar', async () => {
      vi.mocked(registry.getMetricsAsJSON).mockResolvedValue([
        {
          name: 'http_requests_total',
          values: [
            { value: 9500, labels: { status: '200' } },
            { value: 500, labels: { status: '500' } }
          ]
        }
      ])

      const viz = await service.getVisualization()
      expect(viz).toHaveLength(1)
      expect(viz[0]).toHaveProperty('budgetBar')
      expect(viz[0].budgetBar).toHaveProperty('consumedPercent')
      expect(viz[0].budgetBar).toHaveProperty('remainingPercent')
      expect(viz[0]).toHaveProperty('trend')
      expect(['improving', 'stable', 'degrading']).toContain(viz[0].trend)
    })

    it('should calculate trend based on alert history', async () => {
      vi.mocked(registry.getMetricsAsJSON).mockResolvedValue([
        {
          name: 'http_requests_total',
          values: [
            { value: 1000, labels: { status: '200' } }
          ]
        }
      ])

      const viz = await service.getVisualization()
      expect(viz[0].trend).toBe('stable') // No alerts = stable
    })
  })

  describe('Alerting', () => {
    it('should enable and disable alerting', () => {
      service.setAlertingEnabled(false)
      // No exception = success
      service.setAlertingEnabled(true)
    })

    it('should return empty alert history initially', () => {
      const history = service.getAlertHistory()
      expect(history).toEqual([])
    })

    it('should update alert thresholds', () => {
      const result = service.updateAlertThresholds('http-availability', {
        warning: 60,
        critical: 30
      })
      expect(result).toBe(true)

      const config = service.getSLOConfig('http-availability')
      expect(config?.alertThresholds).toEqual({ warning: 60, critical: 30 })
    })

    it('should return false for unknown SLO threshold update', () => {
      const result = service.updateAlertThresholds('unknown-slo', {
        warning: 50,
        critical: 20
      })
      expect(result).toBe(false)
    })
  })

  describe('Configuration', () => {
    it('should add custom SLO', () => {
      service.addSLO({
        id: 'custom-slo',
        name: 'Custom SLO',
        target: 0.95,
        windowDays: 7,
        indicator: {
          totalMetric: 'custom_total',
          errorMetric: 'custom_errors'
        }
      })

      const config = service.getSLOConfig('custom-slo')
      expect(config).toBeDefined()
      expect(config?.name).toBe('Custom SLO')
    })

    it('should get all SLO configs', () => {
      const configs = service.getAllSLOConfigs()
      expect(configs.length).toBeGreaterThanOrEqual(1)
      expect(configs.some(c => c.id === 'http-availability')).toBe(true)
    })
  })
})
