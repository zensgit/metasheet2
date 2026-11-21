/**
 * Closed world of realtime channels.
 *
 * Every deployable source file that constructs a Socket.IO server, opens a namespace, reaches the
 * raw server, registers a connection handler, sends to connections, uses a cluster or recovery
 * feature of Socket.IO, or speaks another push protocol (server-sent events, a native WebSocket
 * server) must be listed below with its role and with the exact number of such sites it holds.
 *
 * A new file with any of these sites, or a new site in a listed file, fails this guard. The fix is
 * never to bump a number alone: classify the new site, route it through the protected delivery
 * boundary (or state why it carries no tenant collaboration data) and add a behaviour assertion for
 * it; then update the entry.
 *
 * Population comes from the file system, not from a list of names: the scan walks the backend source
 * tree and every plugin directory (source, built entry files and runtime libraries), skipping
 * dependencies and tests. Editor leftovers that are never built or loaded (`*.insyncdl`) are excluded
 * by extension, and a control below shows the scan still sees real `.ts` and `.js` files.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = join(here, '../../../..')
const ROOTS = ['packages/core-backend/src', 'plugins']
const EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.cjs', '.mjs']

type Category = 'socketIoImport' | 'serverConstruct' | 'namespace' | 'rawServer' | 'connectionHandler' | 'pluginBridge' | 'clusterOrRecovery' | 'otherPushProtocol' | 'emit'

const DETECTORS: Record<Exclude<Category, 'emit'>, RegExp> = {
  socketIoImport: /from ['"]socket\.io['"]|require\(['"]socket\.io['"]\)/g,
  serverConstruct: /new SocketServer\(|new SocketIOServer\(|new Server\(\s*httpServer/g,
  namespace: /\.of\(\s*['"`]\//g,
  rawServer: /\.getIO\(\)/g,
  connectionHandler: /\.onConnection\(|\.on\(\s*['"]connection['"]/g,
  pluginBridge: /websocket\.(broadcast|broadcastTo|sendTo|join|leave|onConnection)\b/g,
  clusterOrRecovery: /fetchSockets\(|serverSideEmit\(|socketsJoin\(|socketsLeave\(|connectionStateRecovery|@socket\.io\/[a-z-]*adapter|socket\.io-redis|\bio\.adapter\(/g,
  otherPushProtocol: /text\/event-stream|new WebSocketServer\(|from ['"]ws['"]|require\(['"]ws['"]\)/g,
}
const EMIT = /\.emit\(/g

type Counts = Partial<Record<Category, number>>

function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|__fixtures__|fixtures|node_modules)\//.test(path) || /\.(test|spec)\.[cm]?[jt]s$/.test(path) || path.endsWith('.d.ts')
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isDirectory()) walk(full, out)
    else if (EXTENSIONS.some((extension) => name.endsWith(extension))) out.push(full)
  }
}

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length
}

function analyse(text: string): Counts | null {
  const counts: Counts = {}
  for (const [category, pattern] of Object.entries(DETECTORS) as Array<[Exclude<Category, 'emit'>, RegExp]>) {
    const found = count(text, pattern)
    if (found > 0) counts[category] = found
  }
  if (Object.keys(counts).length === 0) return null
  // Sends are counted only in a file that already bears a channel: plain event emitters elsewhere
  // use the same method name.
  const emits = count(text, EMIT)
  if (emits > 0) counts.emit = emits
  return counts
}

function scan(): Record<string, Counts> {
  const files: string[] = []
  for (const root of ROOTS) walk(join(REPO, root), files)
  const found: Record<string, Counts> = {}
  for (const file of files.sort()) {
    const rel = relative(REPO, file).split(sep).join('/')
    if (isTestPath(rel)) continue
    const counts = analyse(readFileSync(file, 'utf8'))
    if (counts) found[rel] = counts
  }
  return found
}

interface Entry { role: string; counts: Counts }

const B = 'packages/core-backend/src'
const EXPECTED: Record<string, Entry> = {
  [`${B}/services/CollabService.ts`]: {
    role: 'PROTECTED BOUNDARY. The default collaboration channel: every send goes through emitToRoom or the delivery boundary of the protected connections; the three cluster-style calls are the baseline room join, room leave and member listing, each with a protected branch in front of it.',
    counts: { socketIoImport: 2, serverConstruct: 1, connectionHandler: 2, clusterOrRecovery: 3, emit: 16 },
  },
  [`${B}/collab/yjs-websocket-adapter.ts`]: {
    role: 'PROTECTED BOUNDARY. The record editing namespace: the handshake, every message and every send to a record room are checked; an incoming change is applied only after its sender was checked.',
    counts: { socketIoImport: 1, namespace: 1, connectionHandler: 1, emit: 22 },
  },
  [`${B}/index.ts`]: {
    role: 'WIRING. Hands the raw collaboration server to the record editing adapter (the one raw access), defines the plugin bridge on top of the collaboration service, and attaches realtime protection to both channels before either accepts a connection. Its two emit sites are process event-bus emits, not sends to connections.',
    counts: { rawServer: 1, connectionHandler: 1, pluginBridge: 1, emit: 2 },
  },
  [`${B}/services/MetricsStreamService.ts`]: {
    role: 'EXCLUDED BY NAME. A second Socket.IO server for runtime metrics on its own path and namespace; it carries no tenant collaboration session or content. Giving it tenant business data requires listing it as a protected boundary first.',
    counts: { socketIoImport: 2, serverConstruct: 1, namespace: 1, connectionHandler: 1, clusterOrRecovery: 2, emit: 3 },
  },
  [`${B}/services/WebSocketService.ts`]: {
    role: 'NOT WIRED. A raw-connection plugin service that is constructed only by the plugin service factory, which the production start-up graph does not use (pinned below). Wiring it in must fail this guard until it is put behind the protected boundary.',
    counts: { socketIoImport: 2, connectionHandler: 2, emit: 16 },
  },
  [`${B}/di/identifiers.ts`]: {
    role: 'TYPES ONLY. Imports the socket type for the collaboration service interface; holds no site that sends or accepts.',
    counts: { socketIoImport: 1 },
  },
  [`${B}/types/plugin.ts`]: {
    role: 'TYPES ONLY. Documentation examples of the plugin bridge inside comments; holds no executable site.',
    counts: { pluginBridge: 3 },
  },
  'plugins/plugin-view-gantt/src/index.ts': {
    role: 'PLUGIN BRIDGE CONSUMER. Registers a connection handler and sends through the bridge; in protected mode the handler receives the constrained connection after admission and its sends pass the delivery boundary.',
    counts: { connectionHandler: 1, pluginBridge: 1, emit: 7 },
  },
  'plugins/plugin-view-gantt/dist/index-complex.js': {
    role: 'PLUGIN BRIDGE CONSUMER. Built form of the same plugin entry; same constrained connection and delivery boundary apply.',
    counts: { connectionHandler: 1, pluginBridge: 1, emit: 7 },
  },
  'plugins/plugin-view-gantt/dist/api.js': {
    role: 'PLUGIN BRIDGE CONSUMER. Built plugin routes that call the bridge broadcast; the broadcast is filtered by recipient in protected mode.',
    counts: { pluginBridge: 5 },
  },
  'plugins/plugin-view-gantt/dist/handlers.js': {
    role: 'PLUGIN BRIDGE CONSUMER. Built plugin handlers that call the bridge broadcast; the broadcast is filtered by recipient in protected mode.',
    counts: { pluginBridge: 8 },
  },
}

describe('closed world of realtime channels', () => {
  const found = scan()

  it('every file that bears a realtime channel is listed, with its exact sites', () => {
    const actual = Object.fromEntries(Object.entries(found).map(([file, counts]) => [file, counts]))
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([file, entry]) => [file, entry.counts]))
    expect(actual).toEqual(expected)
  })

  it('every listed file states its role', () => {
    for (const [file, entry] of Object.entries(EXPECTED)) expect(entry.role.length, file).toBeGreaterThan(20)
  })

  it('exactly two Socket.IO servers are constructed: collaboration and the metrics stream', () => {
    const constructors = Object.entries(found).filter(([, counts]) => (counts.serverConstruct ?? 0) > 0).map(([file]) => file)
    expect(constructors).toEqual([`${B}/services/CollabService.ts`, `${B}/services/MetricsStreamService.ts`])
  })

  it('the collaboration server is built without state recovery, a cluster adapter or cross-process sends', () => {
    const text = readFileSync(join(REPO, `${B}/services/CollabService.ts`), 'utf8')
    const options = text.slice(text.indexOf('this.io = new SocketServer(httpServer, {'), text.indexOf("if (process.env.WS_REDIS_ENABLED === 'true')"))
    expect(options.replace(/\s+/g, ' ')).toBe("this.io = new SocketServer(httpServer, { cors: { origin: '*', methods: ['GET', 'POST'], }, }) ")
    expect(text).not.toMatch(/connectionStateRecovery|serverSideEmit|@socket\.io\/[a-z-]*adapter|socket\.io-redis|\bio\.adapter\(/)
  })

  it('the raw-connection plugin service stays out of the production start-up graph', () => {
    const index = readFileSync(join(REPO, `${B}/index.ts`), 'utf8')
    expect(index).not.toMatch(/plugin-service-factory|plugin-manager|createPluginManager|WebSocketServiceImpl|services\/WebSocketService/)
  })

  it('the raw collaboration server is reached in exactly one place, to register the record editing namespace', () => {
    const index = readFileSync(join(REPO, `${B}/index.ts`), 'utf8')
    expect(index.split('.getIO()')).toHaveLength(2)
    expect(index).toContain('const collabIO = this.injector.get(ICollabService).getIO()')
    expect(index.split('yjsWsAdapter.register(collabIO)')).toHaveLength(2)
    expect(index.split('collabIO')).toHaveLength(4)
  })

  it('no server-sent-event stream and no native WebSocket server exists in the deployable sources', () => {
    expect(Object.entries(found).filter(([, counts]) => (counts.otherPushProtocol ?? 0) > 0).map(([file]) => file)).toEqual([])
  })

  it('the scan sees real source and built files, skips tests and editor leftovers (controls)', () => {
    expect(Object.keys(found)).toContain(`${B}/services/CollabService.ts`)
    expect(Object.keys(found).some((file) => file.startsWith('plugins/') && file.endsWith('.js'))).toBe(true)
    expect(Object.keys(found).some((file) => file.includes('.insyncdl'))).toBe(false)
    expect(isTestPath('packages/core-backend/src/x/__tests__/a.ts')).toBe(true)
    expect(isTestPath('packages/core-backend/src/services/CollabService.ts')).toBe(false)
  })

  it('an unlisted file with a send, a namespace, a raw server access or another protocol is detected (controls)', () => {
    expect(analyse("import { Server } from 'socket.io'\nio.emit('x', 1)\nio.to(room).emit('y', 2)")).toEqual({ socketIoImport: 1, emit: 2 })
    expect(analyse("const nsp = io.of('/private')\nnsp.emit('x')")).toEqual({ namespace: 1, emit: 1 })
    expect(analyse('const io = collab.getIO()\nio.emit("x")')).toEqual({ rawServer: 1, emit: 1 })
    expect(analyse("api.websocket.broadcast('x', {})")).toEqual({ pluginBridge: 1 })
    expect(analyse('await io.in(room).fetchSockets(); io.serverSideEmit("x")')).toEqual({ clusterOrRecovery: 2 })
    expect(analyse("res.setHeader('Content-Type', 'text/event-stream')")).toEqual({ otherPushProtocol: 1 })
    expect(analyse("new SocketServer(httpServer, { connectionStateRecovery: {} })")).toEqual({ serverConstruct: 1, clusterOrRecovery: 1 })
    expect(analyse('emitter.emit("plain event emitter")')).toBeNull()
  })
})
