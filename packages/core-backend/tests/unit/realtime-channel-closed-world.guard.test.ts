/**
 * Closed world of realtime channels.
 *
 * Every deployable source file that constructs a Socket.IO server, opens a namespace, reaches the
 * raw server, registers a connection handler, sends to connections, uses a cluster or recovery
 * feature of Socket.IO, or speaks another push protocol (server-sent events, a native WebSocket
 * server) must be listed below with its role and with the exact number of such sites it holds.
 *
 * So must every file that can put a connection into a room, found two ways: a room entered or left
 * through something named like a connection (socket, client, peer, connection), and, whatever the
 * names are, an event listener registered in the same file as a call that can be a room entry or exit.
 * What this does not see: a room call through a receiver with another name, in a file that registers
 * no listener at all and is handed its connections by a listed file.
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
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = join(here, '../../../..')
const ROOTS = ['packages/core-backend/src', 'plugins']
const EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.cjs', '.mjs']

type Category = 'socketIoImport' | 'serverConstruct' | 'namespace' | 'rawServer' | 'connectionHandler' | 'pluginBridge' | 'clusterOrRecovery' | 'otherPushProtocol' | 'roomSend' | 'serverSend' | 'connectionRoomCall' | 'listenerWithRoomCall' | 'emit'

type TextCategory = Exclude<Category, 'emit' | 'listenerWithRoomCall'>

const DETECTORS: Record<TextCategory, RegExp> = {
  socketIoImport: /from ['"]socket\.io['"]|require\(['"]socket\.io['"]\)/g,
  serverConstruct: /new SocketServer\(|new SocketIOServer\(|new Server\(\s*httpServer/g,
  namespace: /\.of\(\s*['"`]\//g,
  rawServer: /\.getIO\(\)/g,
  connectionHandler: /\.onConnection\(|\.on\(\s*['"]connection['"]/g,
  pluginBridge: /websocket\.(broadcast|broadcastTo|sendTo|join|leave|onConnection)\b/g,
  clusterOrRecovery: /fetchSockets\(|serverSideEmit\(|socketsJoin\(|socketsLeave\(|connectionStateRecovery|@socket\.io\/[a-z-]*adapter|socket\.io-redis|\bio\.adapter\(/g,
  otherPushProtocol: /text\/event-stream|new WebSocketServer\(|from ['"]ws['"]|require\(['"]ws['"]\)/g,
  // A send to a room or to every connection makes a file a channel bearer whatever object it goes through.
  roomSend: /\.(to|in)\(\s*[^()]*(\([^()]*\))?[^()]*\)\s*\.emit\(/g,
  serverSend: /\bio\??\.emit\(/g,
  // A room entered or left through something named like a connection, in any file.
  connectionRoomCall: /\b[\w.]*(socket|client|peer|connection)\w*\)?\??\.(join|leave)\(/gi,
}
const EMIT = /\.emit\(/g
const ROOM_METHOD = /\.(join|leave|socketsJoin|socketsLeave)\(/
const LISTENER_METHODS = new Set(['on', 'once', 'onAny', 'prependAny', 'addListener', 'prependListener', 'prependOnceListener'])
const PATH_RECEIVER = /^(path|nodePath|posix|win32|path\.posix|path\.win32)$/

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

function parse(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.[cm]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS)
}

function isFixedText(node: ts.Node | undefined): boolean {
  return Boolean(node) && (ts.isStringLiteral(node as ts.Node) || ts.isNoSubstitutionTemplateLiteral(node as ts.Node))
}

/**
 * Whatever the names are: a file that registers an event listener and also calls something that can
 * be a room entry or exit is a channel bearer. A room call here is any `.leave(...)`, any
 * `.socketsJoin(...)` / `.socketsLeave(...)`, and a `.join(x, ...)` whose first argument is not a fixed
 * text and whose receiver is not the path module (joining an array with a fixed separator is not one).
 * Returns the number of such room calls, or 0 when the file registers no listener.
 */
function listenerWithRoomCalls(file: string, text: string): number {
  if (!ROOM_METHOD.test(text)) return 0
  const source = parse(file, text)
  let listeners = 0
  let roomCalls = 0
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      if (LISTENER_METHODS.has(method) && node.arguments.length > 0) listeners += 1
      if (method === 'leave' || method === 'socketsJoin' || method === 'socketsLeave') roomCalls += 1
      if (method === 'join' && node.arguments.length >= 1 && !isFixedText(node.arguments[0])
        && !PATH_RECEIVER.test(node.expression.expression.getText(source))) roomCalls += 1
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return listeners > 0 ? roomCalls : 0
}

function analyse(text: string, file = 'probe.ts'): Counts | null {
  const counts: Counts = {}
  for (const [category, pattern] of Object.entries(DETECTORS) as Array<[TextCategory, RegExp]>) {
    const found = count(text, pattern)
    if (found > 0) counts[category] = found
  }
  const roomCalls = listenerWithRoomCalls(file, text)
  if (roomCalls > 0) counts.listenerWithRoomCall = roomCalls
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
    const counts = analyse(readFileSync(file, 'utf8'), rel)
    if (counts) found[rel] = counts
  }
  return found
}

/**
 * Besides the counts, every channel-bearing file lists two things exactly:
 *   - `inbound`: every listener registration (`.on`, `.once`, `.onAny`, `.addListener` and their
 *                prepend forms), with the event name when it is a fixed text and the expression otherwise;
 *   - `rooms`:   every `.join(...)`, `.leave(...)`, `.socketsJoin(...)`, `.socketsLeave(...)` call.
 * Both are read from the syntax tree, so a new inbound handler or a new way into a room changes the
 * list and fails the guard until it is classified.
 */
interface Entry { role: string; counts: Counts; inbound: string[]; rooms: string[] }

interface Sites { inbound: string[]; rooms: string[] }

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function sitesOf(file: string, text: string): Sites {
  const source = parse(file, text)
  const inbound: string[] = []
  const rooms: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text
      const receiver = squash(node.expression.expression.getText(source))
      const first = node.arguments[0]
      if (LISTENER_METHODS.has(method) && first) {
        if (method === 'onAny' || method === 'prependAny') inbound.push(`${receiver}.${method}()`)
        else if (isFixedText(first)) inbound.push(`${receiver}.${method}('${(first as ts.StringLiteral).text}')`)
        else inbound.push(`${receiver}.${method}(<${squash(first.getText(source))}>)`)
      }
      if (method === 'join' || method === 'leave' || method === 'socketsJoin' || method === 'socketsLeave') {
        rooms.push(`${receiver}.${method}(${node.arguments.map((argument) => squash(argument.getText(source))).join(', ')})`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { inbound: inbound.sort(), rooms: rooms.sort() }
}

const B = 'packages/core-backend/src'
const EXPECTED: Record<string, Entry> = {
  [`${B}/services/CollabService.ts`]: {
    role: 'PROTECTED BOUNDARY. The default collaboration channel: every send goes through emitToRoom or the delivery boundary of the protected connections; the three cluster-style calls are the baseline room join, room leave and member listing, each with a protected branch in front of it. Every inbound handler listed here resolves the identity of its connection through resolveTrustedUserId (which re-reads the session in protected mode) before it joins a room, except the leave handlers and ping, which give nothing.',
    counts: { socketIoImport: 2, serverConstruct: 1, connectionHandler: 2, clusterOrRecovery: 3, roomSend: 4, serverSend: 1, connectionRoomCall: 16, listenerWithRoomCall: 18, emit: 16 },
    inbound: [
      'socket.on(\'disconnect\')',
      'socket.on(\'join-comment-inbox\')',
      'socket.on(\'join-comment-record\')',
      'socket.on(\'join-comment-sheet\')',
      'socket.on(\'join-sheet\')',
      'socket.on(\'leave-comment-inbox\')',
      'socket.on(\'leave-comment-record\')',
      'socket.on(\'leave-comment-sheet\')',
      'socket.on(\'leave-sheet\')',
      'socket.on(\'ping\')',
      'socket.on(\'sheet:cursor\')',
      // The constrained connection handed to a plugin: the plugin names the event; the listener runs
      // only while the session of the connection is still the one it was admitted with.
      'socket.on(<event>)',
      'socket.once(\'disconnect\')',
      'socket.once(\'disconnect\')',
      'this.io.on(\'connection\')',
      'this.io.on(\'connection\')',
    ],
    rooms: [
      '(socket as Socket).join(room)',
      '(target as Socket).join(room)',
      'socket.join(binding.userId)',
      'socket.join(buildAuthenticatedUserRoom(userId))',
      'socket.join(room)',
      'socket.join(room)',
      'socket.join(room)',
      'socket.join(room)',
      'socket.join(userId)',
      'socket.join(userRoom)',
      'socket.leave(room)',
      'socket.leave(room)',
      'socket.leave(room)',
      'socket.leave(room)',
      'socket.leave(room)',
      'socket.leave(room)',
      'this.io.in(target).socketsJoin(room)',
      'this.io.in(target).socketsLeave(room)',
    ],
  },
  [`${B}/collab/yjs-websocket-adapter.ts`]: {
    role: 'PROTECTED BOUNDARY. The record editing namespace: the handshake, every message and every send of record content to a record room are checked; an incoming change is applied only after its sender was checked. One send goes outside the delivery boundary on purpose: the invalidation notice, a control message without record content that tells subscribers their copy is no longer the shared one; it is sent to the whole record room also while deliveries are withheld. The resync notice to one subscriber that a relayed change did not reach is the same kind of control message.',
    counts: { socketIoImport: 1, namespace: 1, connectionHandler: 1, roomSend: 3, connectionRoomCall: 4, listenerWithRoomCall: 4, emit: 25 },
    inbound: [
      // The transport of a handshake that is kept waiting: its close releases the waiter.
      'conn.once(\'close\')',
      'nsp.on(\'connection\')',
      'socket.on(\'disconnect\')',
      'socket.on(\'yjs:message\')',
      'socket.on(\'yjs:presence\')',
      'socket.on(\'yjs:subscribe\')',
      'socket.on(\'yjs:unsubscribe\')',
      'socket.on(\'yjs:update\')',
      'staging.on(\'afterTransaction\')',
    ],
    rooms: [
      'socket.join(room)',
      'socket.leave(`yjs:${recordId}`)',
      'socket.leave(`yjs:${recordId}`)',
      'socket.leave(`yjs:${recordId}`)',
    ],
  },
  [`${B}/index.ts`]: {
    role: 'WIRING. Hands the raw collaboration server to the record editing adapter (the one raw access), defines the plugin bridge on top of the collaboration service, and attaches realtime protection to both channels before either accepts a connection. Its two emit sites are process event-bus emits, not sends to connections; its on() sites are process and server events, and its join/leave sites are the plugin bridge methods that delegate to the collaboration service.',
    counts: { rawServer: 1, connectionHandler: 1, pluginBridge: 1, listenerWithRoomCall: 2, emit: 2 },
    inbound: [
      // The plugin event bus, not a connection.
      'eventBus.on(<event>)',
      'process.on(\'SIGINT\')',
      'process.on(\'SIGTERM\')',
      'this.httpServer.once(\'error\')',
    ],
    rooms: [
      'keys.join(\', \')',
      'this.injector.get(ICollabService).join(room, options)',
      'this.injector.get(ICollabService).leave(room, options)',
    ],
  },
  [`${B}/services/MetricsStreamService.ts`]: {
    role: 'EXCLUDED BY NAME. A second Socket.IO server for runtime metrics; it shares the default transport path with the collaboration server and is separated by its namespace. It carries no tenant collaboration session or content. Giving it tenant business data requires listing it as a protected boundary first.',
    counts: { socketIoImport: 2, serverConstruct: 1, namespace: 1, connectionHandler: 1, clusterOrRecovery: 2, emit: 3 },
    inbound: [
      'socket.on(\'disconnect\')',
      'socket.on(\'metrics:ack\')',
      'socket.on(\'metrics:subscribe\')',
      'this.nsp.on(\'connection\')',
    ],
    rooms: [
      '[...state.groups].join(\', \')',
    ],
  },
  [`${B}/services/WebSocketService.ts`]: {
    role: 'NOT WIRED. A raw-connection plugin service that is constructed only by the plugin service factory, which the production start-up graph does not use (pinned below). Wiring it in must fail this guard until it is put behind the protected boundary.',
    counts: { socketIoImport: 2, connectionHandler: 2, connectionRoomCall: 2, listenerWithRoomCall: 4, emit: 16 },
    inbound: [
      'io.on(\'connection\')',
      'socket.on(\'disconnect\')',
      'socket.onAny()',
      'this.on(\'connection\')',
      'this.on(\'disconnection\')',
      'this.on(\'message\')',
    ],
    rooms: [
      'ioSocket.join(room)',
      'ioSocket.leave(room)',
      'this.join(id, room)',
      'this.leave(id, room)',
    ],
  },
  [`${B}/di/identifiers.ts`]: {
    role: 'TYPES ONLY. Imports the socket type for the collaboration service interface; holds no site that sends or accepts.',
    counts: { socketIoImport: 1 },
    inbound: [
    ],
    rooms: [
    ],
  },
  [`${B}/types/plugin.ts`]: {
    role: 'TYPES ONLY. Documentation examples of the plugin bridge inside comments; holds no executable site.',
    counts: { pluginBridge: 3 },
    inbound: [
    ],
    rooms: [
    ],
  },
  'plugins/plugin-view-gantt/src/index.ts': {
    role: 'PLUGIN BRIDGE CONSUMER. Registers a connection handler and sends through the bridge; in protected mode the handler receives the constrained connection after admission, its inbound handlers run only after the session was re-read, and its sends and room joins pass the delivery boundary.',
    counts: { connectionHandler: 1, pluginBridge: 1, roomSend: 1, connectionRoomCall: 2, listenerWithRoomCall: 2, emit: 7 },
    inbound: [
      'api.events.on(\'gantt:dependency:created\')',
      'api.events.on(\'gantt:dependency:deleted\')',
      'api.events.on(\'gantt:task:created\')',
      'api.events.on(\'gantt:task:deleted\')',
      'api.events.on(\'gantt:task:updated\')',
      'api.events.on(\'view:update\')',
      'socket.on(\'gantt:subscribe\')',
      'socket.on(\'gantt:task:update\')',
      'socket.on(\'gantt:unsubscribe\')',
    ],
    rooms: [
      'fields.join(\', \')',
      'socket.join(`gantt:${viewId}`)',
      'socket.leave(`gantt:${viewId}`)',
    ],
  },
  'plugins/plugin-view-gantt/dist/index-complex.js': {
    role: 'PLUGIN BRIDGE CONSUMER. Built form of the same plugin entry; same constrained connection and delivery boundary apply.',
    counts: { connectionHandler: 1, pluginBridge: 1, roomSend: 1, connectionRoomCall: 2, listenerWithRoomCall: 2, emit: 7 },
    inbound: [
      'api.events.on(\'gantt:dependency:created\')',
      'api.events.on(\'gantt:dependency:deleted\')',
      'api.events.on(\'gantt:task:created\')',
      'api.events.on(\'gantt:task:deleted\')',
      'api.events.on(\'gantt:task:updated\')',
      'api.events.on(\'view:update\')',
      'socket.on(\'gantt:subscribe\')',
      'socket.on(\'gantt:task:update\')',
      'socket.on(\'gantt:unsubscribe\')',
    ],
    rooms: [
      'fields.join(\', \')',
      'socket.join(`gantt:${viewId}`)',
      'socket.leave(`gantt:${viewId}`)',
    ],
  },
  'plugins/plugin-view-gantt/dist/api.js': {
    role: 'PLUGIN BRIDGE CONSUMER. Built plugin routes that call the bridge broadcast; the broadcast is filtered by recipient in protected mode. Its one join site joins strings, not rooms.',
    counts: { pluginBridge: 5 },
    inbound: [
    ],
    rooms: [
      'fields.join(\', \')',
    ],
  },
  'plugins/plugin-view-gantt/dist/handlers.js': {
    role: 'PLUGIN BRIDGE CONSUMER. Built plugin handlers that call the bridge broadcast; the broadcast is filtered by recipient in protected mode.',
    counts: { pluginBridge: 8 },
    inbound: [
    ],
    rooms: [
    ],
  },
}

describe('closed world of realtime channels', () => {
  const found = scan()

  it('every file that bears a realtime channel is listed, with its exact sites', () => {
    const actual = Object.fromEntries(Object.entries(found).map(([file, counts]) => [file, counts]))
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([file, entry]) => [file, entry.counts]))
    expect(actual).toEqual(expected)
  })

  it('every inbound handler of a channel-bearing file is listed', () => {
    const actual = Object.fromEntries(Object.keys(found).map((file) => [file, sitesOf(file, readFileSync(join(REPO, file), 'utf8')).inbound]))
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([file, entry]) => [file, entry.inbound]))
    expect(actual).toEqual(expected)
  })

  it('every call that puts a connection into a room, or takes it out, is listed', () => {
    const actual = Object.fromEntries(Object.keys(found).map((file) => [file, sitesOf(file, readFileSync(join(REPO, file), 'utf8')).rooms]))
    const expected = Object.fromEntries(Object.entries(EXPECTED).map(([file, entry]) => [file, entry.rooms]))
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
    expect(analyse("import { Server } from 'socket.io'\nio.emit('x', 1)\nio.to(room).emit('y', 2)")).toEqual({ socketIoImport: 1, roomSend: 1, serverSend: 1, emit: 2 })
    expect(analyse("const nsp = io.of('/private')\nnsp.emit('x')")).toEqual({ namespace: 1, emit: 1 })
    expect(analyse('const io = collab.getIO()\nio.emit("x")')).toEqual({ rawServer: 1, serverSend: 1, emit: 1 })
    expect(analyse("api.websocket.broadcast('x', {})")).toEqual({ pluginBridge: 1 })
    expect(analyse('await io.in(room).fetchSockets(); io.serverSideEmit("x")')).toEqual({ clusterOrRecovery: 2 })
    expect(analyse("res.setHeader('Content-Type', 'text/event-stream')")).toEqual({ otherPushProtocol: 1 })
    expect(analyse("new SocketServer(httpServer, { connectionStateRecovery: {} })")).toEqual({ serverConstruct: 1, clusterOrRecovery: 1 })
    expect(analyse('emitter.emit("plain event emitter")')).toBeNull()
    // A send to a room, or to every connection, through any object makes the file a channel bearer.
    expect(analyse('service.io.to(room).emit("x", 1)')).toEqual({ roomSend: 1, emit: 1 })
    expect(analyse('this.io.in(buildRoom(id)).emit("x")')).toEqual({ roomSend: 1, emit: 1 })
    expect(analyse('holder.io.emit("x")')).toEqual({ serverSend: 1, emit: 1 })
  })

  it('a file that only holds an inbound handler entering a room, or only a room call on a connection, is a channel bearer (controls)', () => {
    // No send, no namespace, no import of the transport, and no conventional name.
    expect(analyse("export function attach(s) { s.on('join-any', (room) => s.join(room)) }")).toEqual({ listenerWithRoomCall: 1 })
    expect(analyse('export function attach(s) { s.on(eventName, (room) => { s.leave(room) }) }')).toEqual({ listenerWithRoomCall: 1 })
    expect(analyse('export function attach(s) { s.onAny((event, room) => s.join(room, extra)) }')).toEqual({ listenerWithRoomCall: 1 })
    // No listener in the file: seen through the name of the receiver.
    expect(analyse('export const put = (socket, room) => socket.join(room)')).toEqual({ connectionRoomCall: 1 })
    expect(analyse('export const out = (ctx, room) => ctx.clientSocket?.leave(room)')).toEqual({ connectionRoomCall: 1 })
    // Not room calls: a list joined with a fixed separator, a file path.
    expect(analyse("emitter.on('x', f)\nconst csv = parts.join(', ')\nconst file = path.join(dir, name)")).toBeNull()
    expect(analyse('const csv = parts.join(separator)')).toBeNull()
  })

  it('a new inbound handler and a new way into a room are both seen by the site scan (controls)', () => {
    const sites = sitesOf('probe.ts', "socket.on('join-any', (room: string) => socket.join(room))\nsocket.once('x', () => undefined)\nio.in(a).socketsJoin(b)\nsocket.leave(`r:${id}`)\nconst csv = parts.join(',')")
    expect(sites.inbound).toEqual(["socket.on('join-any')", "socket.once('x')"])
    expect(sitesOf('probe.ts', 'socket.on(name, handler)\nsocket.onAny(handler)\nsocket.addListener("x", handler)').inbound).toEqual(['socket.addListener(\'x\')', 'socket.on(<name>)', 'socket.onAny()'])
    expect(sites.rooms).toEqual(['io.in(a).socketsJoin(b)', "parts.join(',')", 'socket.join(room)', 'socket.leave(`r:${id}`)'])
    expect(sitesOf('probe.js', "socket.on('gantt:subscribe', function (d) { socket.join('gantt:' + d.viewId) })").rooms).toEqual(["socket.join('gantt:' + d.viewId)"])
  })
})
