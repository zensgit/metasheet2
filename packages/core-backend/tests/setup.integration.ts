import * as fs from 'fs/promises'
import * as path from 'path'
import { inspect } from 'util'
import { expect, beforeAll, afterAll, vi } from 'vitest'
import { spreadsheetMatchers } from './utils/test-db'

// Extend expect with custom matchers
expect.extend({
  ...spreadsheetMatchers
})

const originalSetInterval = globalThis.setInterval
const originalSetTimeout = globalThis.setTimeout

beforeAll(async () => {
  const fixturesDir = path.join(__dirname, 'fixtures/test-plugins')
  try {
    await fs.rm(fixturesDir, { recursive: true, force: true })
  } catch (error) {
    console.warn('Warning: Could not clean fixtures directory:', error instanceof Error ? error.message : error)
  }

  process.env.NODE_ENV = 'test'
  process.env.LOG_LEVEL = 'error'
  process.env.SKIP_PLUGINS = process.env.SKIP_PLUGINS ?? 'true'
  process.env.SKIP_SPREADSHEET_API = process.env.SKIP_SPREADSHEET_API ?? 'true'
  process.env.RBAC_BYPASS = process.env.RBAC_BYPASS ?? 'true'
  if (!process.env.METASHEET_VERSION) {
    try {
      const packageJsonPath = path.join(__dirname, '../package.json')
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'))
      if (typeof packageJson?.version === 'string') {
        process.env.METASHEET_VERSION = packageJson.version
      }
    } catch (error) {
      console.warn('Warning: Could not read package version:', error instanceof Error ? error.message : error)
    }
  }

  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const timer = originalSetInterval(handler, timeout as number, ...args)
    if (typeof (timer as NodeJS.Timeout).unref === 'function') {
      (timer as NodeJS.Timeout).unref()
    }
    return timer
  }) as typeof setInterval

  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const timer = originalSetTimeout(handler, timeout as number, ...args)
    if (typeof (timer as NodeJS.Timeout).unref === 'function') {
      (timer as NodeJS.Timeout).unref()
    }
    return timer
  }) as typeof setTimeout

  if (typeof globalThis.fetch !== 'function') {
    throw new Error('Global fetch is not available in the integration test environment')
  }

  vi.setConfig({ testTimeout: 60000 })
})

afterAll(async () => {
  if (process.env.DUMP_HANDLES === 'true') {
    const getHandleName = (handle: unknown) =>
      (handle as { constructor?: { name?: string } })?.constructor?.name || typeof handle

    const stdio = new Set<unknown>([process.stdout, process.stderr, process.stdin])
    const rawHandles: unknown[] = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() || []
    const handles = rawHandles.filter((handle) => !stdio.has(handle))
    const requests: unknown[] = (process as unknown as { _getActiveRequests?: () => unknown[] })._getActiveRequests?.() || []
    const summary = new Map<string, number>()

    for (const handle of handles) {
      const name = getHandleName(handle)
      summary.set(name, (summary.get(name) || 0) + 1)
    }

    const summaryEntries = Array.from(summary.entries()).sort(([a], [b]) => a.localeCompare(b))
    const servers = handles
      .filter((handle) => getHandleName(handle) === 'Server')
      .map((handle) => {
        const server = handle as { listening?: boolean; address?: () => unknown }
        let address: unknown = null
        try {
          address = server.address ? server.address() : null
        } catch {
          address = null
        }
        return {
          listening: server.listening ?? null,
          address
        }
      })

    const sockets = handles
      .filter((handle) => getHandleName(handle) === 'Socket')
      .map((handle) => {
        const socket = handle as {
          localAddress?: string
          localPort?: number
          remoteAddress?: string
          remotePort?: number
          destroyed?: boolean
        }
        return {
          localAddress: socket.localAddress,
          localPort: socket.localPort,
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
          destroyed: socket.destroyed ?? null
        }
      })

    const details = handles.map((handle) => ({
      type: getHandleName(handle),
      detail: inspect(handle, { depth: 1 })
    }))

    console.error('[DUMP_HANDLES] Active handles summary (excluding stdio):', summaryEntries)
    console.error('[DUMP_HANDLES] Active requests count:', requests.length)
    if (servers.length > 0) {
      console.error('[DUMP_HANDLES] Servers:', servers)
    }
    if (sockets.length > 0) {
      console.error('[DUMP_HANDLES] Sockets:', sockets)
    }
    console.error('[DUMP_HANDLES] Handle details:', details)
  }

  try {
    vi.clearAllMocks()
    vi.clearAllTimers()

    if (global.gc) {
      global.gc()
    }

    globalThis.setInterval = originalSetInterval
    globalThis.setTimeout = originalSetTimeout

    delete process.env.NODE_ENV
    delete process.env.LOG_LEVEL
    delete process.env.RBAC_BYPASS
  } catch (error) {
    console.warn('Warning: Cleanup failed:', error instanceof Error ? error.message : error)
  }

})
