import { describe, it, expect, vi } from 'vitest'
import GanttPlugin from '../src/index'

interface RouteRegistration {
  method: string
  path: string
  handler: (req: any, res: any) => Promise<void>
}

function createResponse() {
  const response: any = {
    status: vi.fn(() => response),
    json: vi.fn(() => response),
    setHeader: vi.fn(),
    end: vi.fn(),
  }
  return response
}

function createMockContext() {
  const routes: RouteRegistration[] = []
  const pluginApis = new Map<string, Record<string, (...args: any[]) => Promise<unknown> | unknown>>()
  const connectionHandlers: Array<(socket: any) => void> = []
  const eventEmit = vi.fn()
  const eventOn = vi.fn()
  const websocketBroadcast = vi.fn()
  const websocketBroadcastTo = vi.fn()

  const task = {
    id: 'task-1',
    viewId: 'view-1',
    name: 'Kickoff',
    description: 'Initial task',
    startDate: new Date('2026-03-01T00:00:00.000Z'),
    endDate: new Date('2026-03-03T00:00:00.000Z'),
    progress: 0,
    orderIndex: 0,
    isMilestone: false,
    status: 'not_started',
    createdBy: 'user-1',
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-01T00:00:00.000Z'),
  }

  const queries: string[] = []
  const databaseQuery = vi.fn(async (sql: string) => {
    queries.push(sql)

    if (sql.includes('INSERT INTO gantt_tasks')) {
      return [task]
    }
    if (sql.includes('SELECT * FROM gantt_tasks')) {
      return [task]
    }
    if (sql.includes('SELECT * FROM gantt_dependencies')) {
      return []
    }
    if (sql.includes('SELECT * FROM gantt_resources')) {
      return []
    }
    if (sql.includes('SELECT tr.* FROM gantt_task_resources')) {
      return []
    }

    return []
  })

  const context = {
    metadata: {
      name: 'plugin-view-gantt',
      version: '1.0.0',
      path: '/tmp/plugin-view-gantt',
    },
    api: {
      http: {
        addRoute: vi.fn((method: string, path: string, handler: RouteRegistration['handler']) => {
          routes.push({ method, path, handler })
        }),
        removeRoute: vi.fn(),
        middleware: vi.fn(),
      },
      events: {
        emit: eventEmit,
        on: eventOn,
        once: vi.fn(),
        off: vi.fn(),
      },
      websocket: {
        broadcast: websocketBroadcast,
        broadcastTo: websocketBroadcastTo,
        sendTo: vi.fn(),
        join: vi.fn(),
        leave: vi.fn(),
        onConnection: vi.fn((handler: (socket: any) => void) => {
          connectionHandlers.push(handler)
        }),
      },
      database: {
        query: databaseQuery,
        transaction: vi.fn(),
        model: vi.fn(),
      },
      auth: {
        verifyToken: vi.fn(),
        checkPermission: vi.fn().mockReturnValue(true),
        createToken: vi.fn(),
      },
    },
    core: {
      events: {
        emit: eventEmit,
      },
    },
    communication: {
      register: vi.fn((name: string, api: Record<string, (...args: any[]) => Promise<unknown> | unknown>) => {
        pluginApis.set(name, api)
      }),
      call: vi.fn(),
      on: vi.fn(),
      emit: vi.fn(),
    },
    storage: {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    },
    config: {},
    logger: {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as any

  return {
    context,
    routes,
    pluginApis,
    connectionHandlers,
    eventEmit,
    eventOn,
    websocketBroadcast,
    queries,
  }
}

describe('plugin-view-gantt smoke', () => {
  it('activates against the current plugin context contract', async () => {
    const plugin = new GanttPlugin()
    const { context, routes, pluginApis, connectionHandlers, eventOn } = createMockContext()

    await plugin.activate(context)

    expect(routes.some((route) => route.path === '/api/gantt/:viewId')).toBe(true)
    expect(routes.some((route) => route.path === '/api/gantt/:viewId/tasks')).toBe(true)
    expect(eventOn).toHaveBeenCalledWith('view:update', expect.any(Function))
    expect(pluginApis.get('gantt')).toEqual(
      expect.objectContaining({
        getGanttData: expect.any(Function),
        createTask: expect.any(Function),
        syncData: expect.any(Function),
      }),
    )
    expect(connectionHandlers).toHaveLength(1)
  })

  it('creates tasks through the plugin API and serves cached gantt data through the route handler', async () => {
    const plugin = new GanttPlugin()
    const { context, routes, pluginApis, connectionHandlers, eventEmit, websocketBroadcast, queries } = createMockContext()

    await plugin.activate(context)

    const ganttApi = pluginApis.get('gantt')!
    const createdTask = await ganttApi.createTask('view-1', {
      name: 'Kickoff',
      startDate: new Date('2026-03-01T00:00:00.000Z'),
      endDate: new Date('2026-03-03T00:00:00.000Z'),
      createdBy: 'user-1',
    })

    expect(createdTask).toEqual(expect.objectContaining({ id: 'task-1', name: 'Kickoff' }))
    expect(eventEmit).toHaveBeenCalledWith(
      'gantt:task:created',
      expect.objectContaining({
        viewId: 'view-1',
        task: expect.objectContaining({ id: 'task-1' }),
      }),
    )
    expect(queries.some((sql) => sql.includes('INSERT INTO gantt_tasks'))).toBe(true)

    const getRoute = routes.find((route) => route.method === 'GET' && route.path === '/api/gantt/:viewId')
    expect(getRoute).toBeDefined()

    const response = createResponse()
    await getRoute!.handler(
      {
        params: { viewId: 'view-1' },
        headers: {},
        user: { id: 'user-1' },
      },
      response,
    )

    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          tasks: [expect.objectContaining({ id: 'task-1' })],
        }),
      }),
    )

    const socketHandlers = new Map<string, (data: any) => Promise<void> | void>()
    const socket = {
      join: vi.fn(),
      leave: vi.fn(),
      emit: vi.fn(),
      to: vi.fn(() => ({ emit: vi.fn() })),
      on: vi.fn((event: string, handler: (data: any) => Promise<void> | void) => {
        socketHandlers.set(event, handler)
      }),
    }

    connectionHandlers[0](socket)
    await socketHandlers.get('gantt:subscribe')!({ viewId: 'view-1' })

    expect(socket.join).toHaveBeenCalledWith('gantt:view-1')
    expect(socket.emit).toHaveBeenCalledWith(
      'gantt:data',
      expect.objectContaining({
        tasks: [expect.objectContaining({ id: 'task-1' })],
      }),
    )
    expect(websocketBroadcast).not.toHaveBeenCalledWith('gantt:error', expect.anything())
  })
})
