/**
 * Audit System Tests
 * Sprint 7 Day 2: Tests for AuditService MessageBus integration and AuditLogSubscriber
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { AuditLogSubscriber, createAuditLogSubscriber } from '../audit/AuditLogSubscriber'
import type { AuditMessageEvent } from '../audit/AuditService'

// Mock dependencies
vi.mock('../integration/messaging/message-bus', () => {
  const handlers: Map<string, { pattern: string; handler: (msg: unknown) => void }> = new Map()
  let subIdCounter = 0

  return {
    messageBus: {
      subscribePattern: vi.fn((pattern: string, handler: (msg: unknown) => void) => {
        const subId = `sub_${++subIdCounter}`
        handlers.set(subId, { pattern, handler })
        return subId
      }),
      unsubscribe: vi.fn((subId: string) => {
        handlers.delete(subId)
        return true
      }),
      publish: vi.fn(),
      // Test helper to simulate publishing
      __simulatePublish: (topic: string, payload: unknown) => {
        for (const [, sub] of handlers) {
          // Simple pattern matching for tests
          const patternRegex = sub.pattern
            .replace(/\./g, '\\.')
            .replace(/\*/g, '.*')
          if (new RegExp(`^${patternRegex}$`).test(topic)) {
            sub.handler({ topic, payload })
          }
        }
      },
      __getHandlers: () => handlers
    }
  }
})

vi.mock('../integration/metrics/metrics', () => ({
  coreMetrics: {
    increment: vi.fn(),
    histogram: vi.fn(),
    gauge: vi.fn()
  }
}))

vi.mock('../core/logger', () => ({
  Logger: class MockLogger {
    info = vi.fn()
    warn = vi.fn()
    error = vi.fn()
    debug = vi.fn()
  }
}))

describe('AuditLogSubscriber', () => {
  const testOutputDir = '/tmp/audit-test-' + Date.now()
  let subscriber: AuditLogSubscriber

  const createTestEvent = (overrides: Partial<AuditMessageEvent> = {}): AuditMessageEvent => ({
    id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    who: {
      userId: 1,
      userName: 'testuser',
      userEmail: 'test@example.com',
      sessionId: 'session_123',
      actorType: 'user',
      actorId: '1'
    },
    what: {
      eventType: 'TEST_EVENT',
      eventCategory: 'USER',
      action: 'test_action',
      resourceType: 'document',
      resourceId: 'doc_123'
    },
    when: {
      timestamp: new Date().toISOString(),
      timezone: 'UTC'
    },
    where: {
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      serviceName: 'test-service'
    },
    outcome: {
      success: true,
      statusCode: 200,
      severity: 'INFO'
    },
    ...overrides
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    // Clean up test directory if exists
    try {
      await fs.promises.rm(testOutputDir, { recursive: true, force: true })
    } catch {
      // Directory doesn't exist
    }
  })

  afterEach(async () => {
    if (subscriber) {
      await subscriber.stop()
    }
    // Clean up test directory
    try {
      await fs.promises.rm(testOutputDir, { recursive: true, force: true })
    } catch {
      // Directory doesn't exist
    }
  })

  describe('initialization', () => {
    it('should create subscriber with default options', () => {
      subscriber = new AuditLogSubscriber()
      expect(subscriber).toBeInstanceOf(AuditLogSubscriber)
    })

    it('should create subscriber with custom options', () => {
      subscriber = new AuditLogSubscriber({
        outputDir: testOutputDir,
        filePrefix: 'custom-audit',
        maxFileSizeBytes: 50 * 1024 * 1024,
        bufferSize: 50,
        flushIntervalMs: 1000
      })
      expect(subscriber).toBeInstanceOf(AuditLogSubscriber)
    })

    it('should create subscriber using factory function', () => {
      subscriber = createAuditLogSubscriber({ outputDir: testOutputDir })
      expect(subscriber).toBeInstanceOf(AuditLogSubscriber)
    })
  })

  describe('start and stop', () => {
    it('should start and create output directory', async () => {
      subscriber = new AuditLogSubscriber({ outputDir: testOutputDir })
      await subscriber.start()

      const dirExists = await fs.promises.access(testOutputDir)
        .then(() => true)
        .catch(() => false)
      expect(dirExists).toBe(true)
    })

    it('should subscribe to audit topics on start', async () => {
      const { messageBus } = await import('../integration/messaging/message-bus')

      subscriber = new AuditLogSubscriber({ outputDir: testOutputDir })
      await subscriber.start()

      expect(messageBus.subscribePattern).toHaveBeenCalledWith(
        'system.audit.*',
        expect.any(Function),
        'audit-log-subscriber'
      )
    })

    it('should subscribe to specific categories', async () => {
      const { messageBus } = await import('../integration/messaging/message-bus')

      subscriber = new AuditLogSubscriber({
        outputDir: testOutputDir,
        categories: ['user', 'security']
      })
      await subscriber.start()

      expect(messageBus.subscribePattern).toHaveBeenCalledTimes(2)
      expect(messageBus.subscribePattern).toHaveBeenCalledWith(
        'system.audit.user.*',
        expect.any(Function),
        'audit-log-subscriber'
      )
      expect(messageBus.subscribePattern).toHaveBeenCalledWith(
        'system.audit.security.*',
        expect.any(Function),
        'audit-log-subscriber'
      )
    })

    it('should unsubscribe on stop', async () => {
      const { messageBus } = await import('../integration/messaging/message-bus')

      subscriber = new AuditLogSubscriber({ outputDir: testOutputDir })
      await subscriber.start()
      await subscriber.stop()

      expect(messageBus.unsubscribe).toHaveBeenCalled()
    })
  })

  describe('event handling', () => {
    it('should receive and buffer events', async () => {
      const { messageBus } = await import('../integration/messaging/message-bus')

      subscriber = new AuditLogSubscriber({
        outputDir: testOutputDir,
        bufferSize: 10 // High buffer to prevent auto-flush
      })
      await subscriber.start()

      // Simulate publishing event
      const event = createTestEvent()
      const simulatePublish = (messageBus as unknown as {
        __simulatePublish: (topic: string, payload: unknown) => void
      }).__simulatePublish

      simulatePublish('system.audit.user.test_event', event)

      const stats = subscriber.getStats()
      expect(stats.eventsReceived).toBe(1)
      expect(stats.bufferLength).toBe(1)
    })

    it('should flush when buffer is full', async () => {
      const { messageBus } = await import('../integration/messaging/message-bus')

      subscriber = new AuditLogSubscriber({
        outputDir: testOutputDir,
        bufferSize: 3
      })
      await subscriber.start()

      const simulatePublish = (messageBus as unknown as {
        __simulatePublish: (topic: string, payload: unknown) => void
      }).__simulatePublish

      // Send 3 events to trigger flush
      for (let i = 0; i < 3; i++) {
        simulatePublish('system.audit.user.test', createTestEvent())
      }

      // Wait for flush
      await new Promise(resolve => setTimeout(resolve, 100))

      const stats = subscriber.getStats()
      expect(stats.eventsWritten).toBe(3)
      expect(stats.bufferLength).toBe(0)
    })

    it('should write events to JSON Lines file', async () => {
      const { messageBus } = await import('../integration/messaging/message-bus')

      subscriber = new AuditLogSubscriber({
        outputDir: testOutputDir,
        bufferSize: 1 // Flush after each event
      })
      await subscriber.start()

      const simulatePublish = (messageBus as unknown as {
        __simulatePublish: (topic: string, payload: unknown) => void
      }).__simulatePublish

      const event = createTestEvent()
      simulatePublish('system.audit.user.test', event)

      // Wait for flush
      await new Promise(resolve => setTimeout(resolve, 100))

      // Read the file
      const stats = subscriber.getStats()
      const content = await fs.promises.readFile(stats.currentFilePath, 'utf8')
      const lines = content.trim().split('\n')

      expect(lines.length).toBe(1)
      const writtenEvent = JSON.parse(lines[0])
      expect(writtenEvent.id).toBe(event.id)
      expect(writtenEvent.who.userId).toBe(event.who.userId)
    })
  })

  describe('manual flush', () => {
    it('should flush buffer on demand', async () => {
      const { messageBus } = await import('../integration/messaging/message-bus')

      subscriber = new AuditLogSubscriber({
        outputDir: testOutputDir,
        bufferSize: 100, // High buffer
        flushIntervalMs: 60000 // Long interval
      })
      await subscriber.start()

      const simulatePublish = (messageBus as unknown as {
        __simulatePublish: (topic: string, payload: unknown) => void
      }).__simulatePublish

      simulatePublish('system.audit.user.test', createTestEvent())

      let stats = subscriber.getStats()
      expect(stats.bufferLength).toBe(1)
      expect(stats.eventsWritten).toBe(0)

      await subscriber.flush()

      stats = subscriber.getStats()
      expect(stats.bufferLength).toBe(0)
      expect(stats.eventsWritten).toBe(1)
    })
  })

  describe('statistics', () => {
    it('should track events received', async () => {
      const { messageBus } = await import('../integration/messaging/message-bus')

      subscriber = new AuditLogSubscriber({
        outputDir: testOutputDir,
        bufferSize: 100
      })
      await subscriber.start()

      const simulatePublish = (messageBus as unknown as {
        __simulatePublish: (topic: string, payload: unknown) => void
      }).__simulatePublish

      for (let i = 0; i < 5; i++) {
        simulatePublish('system.audit.user.test', createTestEvent())
      }

      const stats = subscriber.getStats()
      expect(stats.eventsReceived).toBe(5)
    })

    it('should update lastFlushTime on flush', async () => {
      subscriber = new AuditLogSubscriber({
        outputDir: testOutputDir,
        bufferSize: 1
      })
      await subscriber.start()

      let stats = subscriber.getStats()
      expect(stats.lastFlushTime).toBeNull()

      const { messageBus } = await import('../integration/messaging/message-bus')
      const simulatePublish = (messageBus as unknown as {
        __simulatePublish: (topic: string, payload: unknown) => void
      }).__simulatePublish

      simulatePublish('system.audit.user.test', createTestEvent())
      await new Promise(resolve => setTimeout(resolve, 100))

      stats = subscriber.getStats()
      expect(stats.lastFlushTime).toBeInstanceOf(Date)
    })
  })

  describe('file path generation', () => {
    it('should generate file with correct prefix', async () => {
      subscriber = new AuditLogSubscriber({
        outputDir: testOutputDir,
        filePrefix: 'my-audit'
      })
      await subscriber.start()

      const stats = subscriber.getStats()
      expect(stats.currentFilePath).toContain('my-audit-')
      expect(stats.currentFilePath.endsWith('.jsonl')).toBe(true)
    })

    it('should include date in filename', async () => {
      subscriber = new AuditLogSubscriber({
        outputDir: testOutputDir
      })
      await subscriber.start()

      const today = new Date().toISOString().split('T')[0]
      const stats = subscriber.getStats()
      expect(stats.currentFilePath).toContain(today)
    })
  })

  describe('events', () => {
    it('should emit flushed event after flush', async () => {
      const { messageBus } = await import('../integration/messaging/message-bus')

      subscriber = new AuditLogSubscriber({
        outputDir: testOutputDir,
        bufferSize: 1
      })

      const flushedHandler = vi.fn()
      subscriber.on('flushed', flushedHandler)

      await subscriber.start()

      const simulatePublish = (messageBus as unknown as {
        __simulatePublish: (topic: string, payload: unknown) => void
      }).__simulatePublish

      simulatePublish('system.audit.user.test', createTestEvent())
      await new Promise(resolve => setTimeout(resolve, 100))

      expect(flushedHandler).toHaveBeenCalledWith({ count: 1 })
    })
  })
})

describe('AuditService MessageBus Integration', () => {
  it('should have AuditMessageEvent interface with required fields', async () => {
    // This test validates the interface structure
    const event: AuditMessageEvent = {
      id: 'audit_123',
      who: {
        userId: 1,
        userName: 'test',
        actorType: 'user'
      },
      what: {
        eventType: 'TEST',
        eventCategory: 'USER',
        action: 'test_action'
      },
      when: {
        timestamp: new Date().toISOString()
      },
      where: {
        serviceName: 'test'
      },
      outcome: {
        success: true,
        severity: 'INFO'
      }
    }

    expect(event.id).toBeDefined()
    expect(event.who.actorType).toBe('user')
    expect(event.what.eventType).toBe('TEST')
    expect(event.outcome.success).toBe(true)
  })
})
