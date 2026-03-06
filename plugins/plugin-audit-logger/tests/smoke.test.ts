import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AuditLoggerPlugin from '../src/index'

interface RouteRegistration {
  method: string
  path: string
  handler: (req: any, res: any) => Promise<void>
}

function createResponse() {
  const response: any = {
    status: vi.fn(() => response),
    json: vi.fn(() => response),
    send: vi.fn(() => response),
    setHeader: vi.fn(),
  }
  return response
}

function createMockContext() {
  const routes: RouteRegistration[] = []
  const eventEmit = vi.fn()

  const context = {
    core: {
      http: {
        addRoute: vi.fn((method: string, path: string, handler: RouteRegistration['handler']) => {
          routes.push({ method, path, handler })
        }),
      },
      events: {
        emit: eventEmit,
      },
    },
  } as any

  return {
    context,
    routes,
    eventEmit,
  }
}

describe('plugin-audit-logger smoke', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers routes, commands, and services against the current plugin context contract', async () => {
    const { context, routes, eventEmit } = createMockContext()

    AuditLoggerPlugin.activate(context)
    await Promise.resolve()

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'GET', path: '/api/v2/audit/logs' }),
        expect.objectContaining({ method: 'GET', path: '/api/v2/audit/logs/:logId' }),
        expect.objectContaining({ method: 'POST', path: '/api/v2/audit/export' }),
      ]),
    )
    expect(eventEmit).toHaveBeenCalledWith(
      'plugin:service:register',
      expect.objectContaining({
        name: 'audit-logger',
        service: expect.objectContaining({
          getLogs: expect.any(Function),
          exportLogs: expect.any(Function),
          clearOldLogs: expect.any(Function),
        }),
      }),
    )
    expect(eventEmit).toHaveBeenCalledWith(
      'audit.log.created',
      expect.objectContaining({
        action: 'plugin.activated',
        resource: 'audit-logger',
      }),
    )

    const registeredCommands = eventEmit.mock.calls
      .filter(([eventName]) => eventName === 'plugin:command:register')
      .map(([, payload]) => payload.id)

    expect(registeredCommands).toEqual([
      'audit.viewLogs',
      'audit.exportLogs',
      'audit.clearOldLogs',
    ])

    expect(() => AuditLoggerPlugin.deactivate()).not.toThrow()
  })

  it('serves export requests and command handlers using the registered audit logger service', async () => {
    const { context, routes, eventEmit } = createMockContext()

    AuditLoggerPlugin.activate(context)
    await Promise.resolve()

    const exportRoute = routes.find(
      (route) => route.method === 'POST' && route.path === '/api/v2/audit/export',
    )
    expect(exportRoute).toBeDefined()

    const response = createResponse()
    await exportRoute!.handler({ body: { format: 'csv' } }, response)

    expect(response.setHeader).toHaveBeenNthCalledWith(1, 'Content-Type', 'text/csv')
    expect(response.setHeader).toHaveBeenNthCalledWith(
      2,
      'Content-Disposition',
      'attachment; filename="audit-logs.csv"',
    )
    expect(response.send).toHaveBeenCalledWith('ID,Timestamp,User ID,Action,Resource,Details')
    expect(eventEmit).toHaveBeenCalledWith(
      'audit.log.exported',
      expect.objectContaining({ format: 'csv' }),
    )

    const exportCommand = eventEmit.mock.calls.find((call) => {
      return call[0] === 'plugin:command:register' && call[1].id === 'audit.exportLogs'
    })?.[1]

    expect(exportCommand).toBeDefined()
    await expect(exportCommand.handler({ format: 'json' })).resolves.toEqual({
      success: true,
      data: '[]',
    })
  })
})
