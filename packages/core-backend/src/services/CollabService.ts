import type { Socket } from 'socket.io';
import { Server as SocketServer } from 'socket.io'
import type { Server as HttpServer } from 'http'
import type { ILogger } from '../di/identifiers'
import type { EventBus } from '../integration/events/event-bus'
import { buildCommentInboxRoom, buildCommentRecordRoom, buildCommentSheetRoom } from './commentRooms'
import { baselineRealtimeProtection, type ProtectionEvent, type RealtimeProtection } from '../realtime-authz/protection'
import type { ProtectedConnections, ProtectedSocket } from '../realtime-authz/protected-connections'
import type { RealtimeSessionBinding } from '../realtime-authz/session-binding'

export function buildAuthenticatedUserRoom(userId: string): string {
  return `auth-user:${userId}`
}

export type SocketTokenVerifier = (token: string) => Promise<string | null>
export type SheetRoomAuthChecker = (input: { sheetId: string; userId: string; socketId: string }) => Promise<boolean>
export type CommentRoomAuthChecker = (input: {
  spreadsheetId: string
  rowId?: string
  userId: string
  socketId: string
}) => Promise<boolean>

type AuthenticatedSocketData = {
  trustedUserId?: string | null
  authPromise?: Promise<string | null>
}

/**
 * What a room carries, for the resource check a protected delivery runs for each recipient.
 * `closed` is a room of a protected family whose resource cannot be told: nothing is delivered to it.
 */
type RoomScope =
  | { kind: 'sheet'; sheetId: string }
  | { kind: 'comment'; spreadsheetId: string; rowId?: string }
  | { kind: 'user'; userId: string }
  | { kind: 'opaque' }
  | { kind: 'closed' }

const SHEET_ROOM_PREFIX = 'sheet:'
const AUTH_USER_ROOM_PREFIX = 'auth-user:'
const COMMENT_RECORD_ROOM_PREFIX = 'comments:'
const COMMENT_SHEET_ROOM_PREFIX = 'comments-sheet:'
const COMMENT_INBOX_ROOM_PREFIX = 'comments-inbox:'

/**
 * The connection a plugin connection handler receives while realtime protection is active: the
 * verified user, inbound events that are re-checked before the listener runs, and sends that pass
 * the same delivery boundary as every other protected send. It exposes neither the credential nor
 * the raw transport.
 */
export interface ConstrainedPluginSocket {
  readonly id: string
  readonly userId: string
  readonly connected: boolean
  readonly data: { readonly trustedUserId: string }
  on(event: string, listener: (...args: unknown[]) => void): ConstrainedPluginSocket
  emit(event: string, ...args: unknown[]): boolean
  join(room: string): void
  leave(room: string): void
  to(room: string): { emit(event: string, payload?: unknown): boolean }
  disconnect(close?: boolean): void
}

/** How many room requests of one connection may wait while they cannot be decided. */
export const MAX_HELD_JOINS_PER_CONNECTION = 32

export class CollabService {
  /**
   * Room requests that could not be decided while handshakes are held, per connection and per room,
   * in the order they were last asked. They are answered when the instance returns to its baseline.
   */
  private readonly heldJoins = new Map<Socket, Map<string, () => void>>()
  /** Connections accepted while protected that have not had their connect-time user room yet. */
  private readonly unjoinedSockets = new Set<Socket>()
  /** Plugin connection handlers of connections that were kept waiting; they run at the release. */
  private readonly heldPluginHandlers = new Map<Socket, Array<(socket: Socket) => void>>()
  private io: SocketServer | null = null
  private sheetPresenceBySheet = new Map<string, Map<string, Set<string>>>()
  private sheetMembershipBySocket = new Map<string, Set<string>>()
  private commentInboxUserBySocket = new Map<string, string>()
  private commentInboxSocketsByUser = new Map<string, Set<string>>()
  private tokenVerifier: SocketTokenVerifier = async (token) => {
    // AuthService pulls in RBAC/metrics modules; keep it lazy so importing CollabService
    // does not register global metrics during parallel unit-test collection.
    const { authService } = await import('../auth/AuthService')
    const user = await authService.verifyToken(token)
    return user?.id?.toString().trim() || null
  }
  private sheetRoomAuthChecker: SheetRoomAuthChecker = async () => false
  private commentRoomAuthChecker: CommentRoomAuthChecker | null = null
  // Realtime protection. With the baseline protection (the default) every path below is the
  // pre-existing one and none of the protected-mode members is used.
  private protection: RealtimeProtection = baselineRealtimeProtection
  private connections: ProtectedConnections | null = null
  private unsubscribeProtection: (() => void) | null = null
  private roomScopes = new Map<string, RoomScope>()
  private roomDeliveryQueues = new Map<string, Promise<void>>()
  private rawPluginSockets = new Set<Socket>()

  constructor(
    private logger: ILogger,
    private eventBus: EventBus,
  ) {
    this.setupEventListeners()
  }

  setTokenVerifier(verifier: SocketTokenVerifier): void {
    this.tokenVerifier = verifier
  }

  setSheetRoomAuthChecker(checker: SheetRoomAuthChecker): void {
    this.sheetRoomAuthChecker = checker
  }

  setCommentRoomAuthChecker(checker: CommentRoomAuthChecker): void {
    this.commentRoomAuthChecker = checker
  }

  /**
   * Attaches realtime protection. While the protection is in baseline mode nothing changes; in
   * protected mode every connection is registered and admitted before it is served, every inbound
   * event re-reads the session of its connection, and every send goes through the delivery boundary
   * of `connections`, which reads the session of each recipient again.
   */
  setRealtimeProtection(protection: RealtimeProtection, connections: ProtectedConnections): void {
    this.unsubscribeProtection?.()
    this.protection = protection
    this.connections = connections
    connections.onSweep(() => this.sweepSubscriptions())
    this.unsubscribeProtection = protection.subscribe((event) => this.onProtectionEvent(event))
  }

  private isProtected(): boolean {
    return this.connections !== null && this.protection.mode() !== 'baseline'
  }

  private onProtectionEvent(event: ProtectionEvent): void {
    if (event.type === 'decision' && this.io && this.connections && !this.isProtected()) {
      // Back at the baseline: connections and room requests that were held are served by the
      // baseline path now, exactly as if they had arrived at this moment.
      this.releaseHeld()
      return
    }
    if (event.type !== 'decision' || !this.io || !this.connections || !this.isProtected()) return
    // Connections accepted before protection became active are registered now; none of them is
    // served again until its session has been read as current.
    for (const socket of this.io.sockets.sockets.values()) {
      this.adoptSocket(socket, true)
      // A plugin handler holds the raw transport of this connection: it has to reconnect.
      if (this.rawPluginSockets.has(socket)) this.connections.end(socket, { code: 'REALTIME_UNAVAILABLE', retry: true })
    }
    if (event.decision.established === 'terminate') {
      this.connections.endAll({ code: 'REALTIME_UNAVAILABLE', retry: true })
      return
    }
    void this.connections.sweep()
  }

  private adoptSocket(socket: Socket, established = false): void {
    this.connections?.register(socket, {
      onAdmitted: (admitted, binding) => this.onSocketAdmitted(admitted as Socket, binding),
    }, { established })
  }

  /**
   * Keeps a room request that cannot be decided while handshakes are held. Nothing is joined and
   * nothing is answered now; the request is asked again when the instance is back at its baseline.
   * False when the connection already holds as many requests as it may: the caller answers then.
   */
  private holdJoin(socket: Socket, key: string, replay: () => void): boolean {
    let held = this.heldJoins.get(socket)
    if (!held) {
      held = new Map()
      this.heldJoins.set(socket, held)
    }
    if (!held.has(key) && held.size >= MAX_HELD_JOINS_PER_CONNECTION) return false
    held.delete(key)
    held.set(key, replay)
    // The instance may have returned to its baseline while this request was being answered.
    if (!this.isProtected()) this.releaseHeld()
    return true
  }

  /** How many connections are kept with something still to be answered (diagnostics, tests). */
  heldConnectionCount(): number {
    return new Set<Socket>([...this.heldJoins.keys(), ...this.unjoinedSockets, ...this.heldPluginHandlers.keys()]).size
  }

  private dropHeldJoin(socket: Socket, key: string): void {
    const held = this.heldJoins.get(socket)
    if (!held) return
    held.delete(key)
    if (held.size === 0) this.heldJoins.delete(socket)
  }

  private releaseHeld(): void {
    if (this.isProtected()) return
    const unjoined = [...this.unjoinedSockets]
    this.unjoinedSockets.clear()
    const held = [...this.heldJoins]
    this.heldJoins.clear()
    const pluginHandlers = [...this.heldPluginHandlers]
    this.heldPluginHandlers.clear()
    for (const socket of unjoined) {
      if (socket.connected) void this.joinAuthenticatedUserRoom(socket)
    }
    for (const [socket, handlers] of pluginHandlers) {
      if (!socket.connected) continue
      for (const handler of handlers) this.runPluginHandlerAtBaseline(socket, handler)
    }
    for (const [socket, joins] of held) {
      if (!socket.connected) continue
      for (const replay of joins.values()) replay()
    }
  }

  /**
   * Who a connection is for one inbound request: a user, nobody, or not answerable right now.
   * `held` is set when it is not answerable and handshakes were held when the request arrived.
   */
  private async resolveIdentity(socket: Socket): Promise<{ userId: string | null; held: boolean }> {
    if (this.isProtected() && this.connections) {
      this.adoptSocket(socket)
      const answer = await this.connections.checkCurrent(socket)
      if (answer.state === 'current') return { userId: answer.binding.userId, held: false }
      return { userId: null, held: answer.state === 'unavailable' && answer.hold && socket.connected }
    }
    return { userId: await this.resolveTrustedUserId(socket), held: false }
  }

  private onSocketAdmitted(socket: Socket, binding: RealtimeSessionBinding): void {
    this.unjoinedSockets.delete(socket)
    if (!socket.connected) return
    this.getSocketData(socket).trustedUserId = binding.userId
    const userRoom = buildAuthenticatedUserRoom(binding.userId)
    this.roomScopes.set(userRoom, { kind: 'user', userId: binding.userId })
    this.roomScopes.set(binding.userId, { kind: 'user', userId: binding.userId })
    try {
      socket.join(userRoom)
      socket.join(binding.userId)
    } catch (error) {
      this.logger.warn('WebSocket authenticated user room join failed', error instanceof Error ? error : undefined)
    }
  }

  private scopeOfRoom(room: string): RoomScope {
    const registered = this.roomScopes.get(room)
    if (registered) return registered
    if (room.startsWith(SHEET_ROOM_PREFIX)) return { kind: 'sheet', sheetId: room.slice(SHEET_ROOM_PREFIX.length) }
    if (room.startsWith(COMMENT_SHEET_ROOM_PREFIX)) {
      return { kind: 'comment', spreadsheetId: room.slice(COMMENT_SHEET_ROOM_PREFIX.length) }
    }
    if (room.startsWith(COMMENT_INBOX_ROOM_PREFIX)) return { kind: 'user', userId: room.slice(COMMENT_INBOX_ROOM_PREFIX.length) }
    if (room.startsWith(AUTH_USER_ROOM_PREFIX)) return { kind: 'user', userId: room.slice(AUTH_USER_ROOM_PREFIX.length) }
    // A record comment room is only ever entered through its join handler, which registers its
    // scope; one that is not registered cannot be checked, so nothing is delivered to it.
    if (room.startsWith(COMMENT_RECORD_ROOM_PREFIX)) return { kind: 'closed' }
    return { kind: 'opaque' }
  }

  private async checkRoomScope(scope: RoomScope, binding: RealtimeSessionBinding, socketId: string): Promise<boolean> {
    if (scope.kind === 'opaque') return true
    if (scope.kind === 'closed') return false
    if (scope.kind === 'user') return binding.userId === scope.userId
    if (scope.kind === 'sheet') {
      return (await this.sheetRoomAuthChecker({ sheetId: scope.sheetId, userId: binding.userId, socketId })) === true
    }
    if (this.commentRoomAuthChecker) {
      return (await this.commentRoomAuthChecker({
        spreadsheetId: scope.spreadsheetId, rowId: scope.rowId, userId: binding.userId, socketId,
      })) === true
    }
    return (await this.sheetRoomAuthChecker({ sheetId: scope.spreadsheetId, userId: binding.userId, socketId })) === true
  }

  private localRoomSockets(room: string): Socket[] {
    if (!this.io) return []
    const ids = this.io.sockets.adapter.rooms.get(room)
    if (!ids) return []
    const sockets: Socket[] = []
    for (const id of ids) {
      const socket = this.io.sockets.sockets.get(id)
      if (socket) sockets.push(socket)
    }
    return sockets
  }

  /** Takes a connection out of a room whose resource it may no longer read, and tells it so. */
  private dropSubscription(socket: Socket, room: string, scope: RoomScope): void {
    if (!socket.rooms.has(room)) return
    socket.leave(room)
    if (scope.kind === 'sheet') {
      const userId = this.getTrustedUserId(socket)
      if (userId) this.removeSheetPresence(scope.sheetId, userId, socket.id)
      this.untrackSocketSheetMembership(socket.id, scope.sheetId)
      socket.emit('join-denied', { sheetId: scope.sheetId, reason: 'forbidden' })
      this.emitSheetPresence(scope.sheetId)
    } else if (scope.kind === 'comment') {
      socket.emit('comment-join-denied', { scope: scope.spreadsheetId, reason: 'forbidden' })
    } else if (scope.kind === 'user' && room.startsWith(COMMENT_INBOX_ROOM_PREFIX)) {
      this.untrackCommentInboxMembership(socket.id)
    }
  }

  /**
   * Sends to a room. Baseline: the pre-existing Socket.IO room emit. Protected: the delivery
   * boundary, one delivery at a time per room so that the order of events in a room is kept.
   */
  private emitToRoom(room: string, event: string, payload: unknown, except?: Socket): void {
    if (!this.io) return
    if (!this.isProtected()) {
      if (except) except.to(room).emit(event, payload)
      else this.io.to(room).emit(event, payload)
      return
    }
    const previous = this.roomDeliveryQueues.get(room) ?? Promise.resolve()
    const next = previous
      .then(() => this.deliverToRoom(room, event, payload, except))
      .catch((error) => {
        this.logger.warn('Protected room delivery failed', error instanceof Error ? error : undefined)
      })
      .finally(() => {
        if (this.roomDeliveryQueues.get(room) === next) this.roomDeliveryQueues.delete(room)
      })
    this.roomDeliveryQueues.set(room, next)
  }

  private async deliverToRoom(room: string, event: string, payload: unknown, except?: Socket): Promise<void> {
    if (!this.io || !this.connections) return
    if (!this.isProtected()) {
      // Protection went back to baseline while this delivery waited its turn.
      if (except) except.to(room).emit(event, payload)
      else this.io.to(room).emit(event, payload)
      return
    }
    const scope = this.scopeOfRoom(room)
    const members = this.localRoomSockets(room).filter((socket) => socket !== except)
    await this.connections.deliver(members, (socket) => socket.emit(event, payload), {
      resourceCheck: (binding, socket) => this.checkRoomScope(scope, binding, socket.id),
      onResourceDenied: (socket) => this.dropSubscription(socket as Socket, room, scope),
      stillSubscribed: (socket) => (socket as Socket).rooms.has(room),
    })
  }

  /**
   * Idle pass over subscriptions: a connection that stays in a sheet or comment room without any
   * delivery is still taken out of it once its user may no longer read the resource.
   */
  private async sweepSubscriptions(): Promise<void> {
    if (!this.io || !this.connections || !this.isProtected()) return
    const rooms = [...this.io.sockets.adapter.rooms.keys()]
    for (const room of [...this.roomScopes.keys()]) {
      if (!this.io.sockets.adapter.rooms.has(room)) this.roomScopes.delete(room)
    }
    for (const room of rooms) {
      const scope = this.scopeOfRoom(room)
      // Only sheet and comment rooms have a resource that can be narrowed while a session stays
      // current. The session pass of the sweep has already read every connection in one batch.
      if (scope.kind !== 'sheet' && scope.kind !== 'comment') continue
      const members = this.localRoomSockets(room)
      if (members.length === 0) continue
      await this.connections.sweepResources(members, {
        resourceCheck: (binding, socket) => this.checkRoomScope(scope, binding, socket.id),
        onResourceDenied: (socket) => this.dropSubscription(socket as Socket, room, scope),
      })
    }
  }

  private protectedDenyReason(socket: Socket): 'unauthorized' | 'unavailable' {
    return this.connections?.phaseOf(socket) === 'anonymous' ? 'unauthorized' : 'unavailable'
  }

  private setupEventListeners() {
    this.eventBus.subscribe('spreadsheet.cell.updated', (payload) => {
      if (!this.io) return
      const data = payload as { spreadsheetId?: string }
      if (!data?.spreadsheetId) return
      this.emitToRoom(`sheet:${data.spreadsheetId}`, 'sheet:op', {
        type: 'cell-update',
        data: payload,
      })
      this.logger.debug(`Broadcasting update for sheet ${data.spreadsheetId}`)
    })
  }

  private getTokenFromSocket(socket: Socket): string | undefined {
    const authToken = (socket.handshake.auth as { token?: unknown } | undefined)?.token
    if (typeof authToken === 'string' && authToken.trim().length > 0) return authToken.trim()
    return undefined
  }

  private getSocketData(socket: Socket): AuthenticatedSocketData {
    return socket.data as AuthenticatedSocketData
  }

  private getTrustedUserId(socket: Socket): string | undefined {
    const userId = this.getSocketData(socket).trustedUserId
    return typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : undefined
  }

  private async resolveTrustedUserId(socket: Socket): Promise<string | null> {
    if (this.isProtected() && this.connections) {
      // Protected: the identity of a connection is its bound session, read as current right now.
      this.adoptSocket(socket)
      const binding = await this.connections.ensureCurrent(socket)
      return binding ? binding.userId : null
    }
    const data = this.getSocketData(socket)
    if (data.trustedUserId !== undefined) return data.trustedUserId
    if (data.authPromise) return data.authPromise

    const token = this.getTokenFromSocket(socket)
    if (!token) {
      data.trustedUserId = null
      return null
    }

    data.authPromise = (async () => {
      try {
        const userId = await this.tokenVerifier(token)
        data.trustedUserId = userId?.trim() || null
        return data.trustedUserId
      } catch (error) {
        data.trustedUserId = null
        this.logger.warn('WebSocket token verification failed', error instanceof Error ? error : undefined)
        return null
      } finally {
        data.authPromise = undefined
      }
    })()

    return data.authPromise
  }

  private async joinAuthenticatedUserRoom(socket: Socket): Promise<void> {
    const userId = await this.resolveTrustedUserId(socket)
    if (!userId || !socket.connected) return
    try {
      socket.join(buildAuthenticatedUserRoom(userId))
      // Legacy plugin APIs address users by raw user id; keep that room, but only
      // after token verification. Never join it from the spoofable query userId.
      socket.join(userId)
      this.logger.debug(`WebSocket client ${socket.id} joined authenticated user room for ${userId}`)
    } catch (error) {
      this.logger.warn('WebSocket authenticated user room join failed', error instanceof Error ? error : undefined)
    }
  }

  private resolveTarget(options?: { userId?: string; socketId?: string }): string | null {
    if (options?.userId) return options.userId
    if (options?.socketId) return options.socketId
    return null
  }

  private parseCommentRecordScope(payload: unknown): { spreadsheetId: string; rowId: string } | null {
    if (!payload || typeof payload !== 'object') return null
    const next = payload as { spreadsheetId?: unknown; rowId?: unknown }
    const spreadsheetId = typeof next.spreadsheetId === 'string' ? next.spreadsheetId.trim() : ''
    const rowId = typeof next.rowId === 'string' ? next.rowId.trim() : ''
    if (!spreadsheetId || !rowId) return null
    return { spreadsheetId, rowId }
  }

  private parseSheetScope(payload: unknown): string | null {
    if (!payload || typeof payload !== 'object') return null
    const next = payload as { spreadsheetId?: unknown }
    const spreadsheetId = typeof next.spreadsheetId === 'string' ? next.spreadsheetId.trim() : ''
    return spreadsheetId || null
  }

  private normalizeSheetId(payload: unknown): string | null {
    if (typeof payload !== 'string') return null
    const sheetId = payload.trim()
    return sheetId || null
  }

  private buildSheetRoom(sheetId: string): string {
    return `sheet:${sheetId}`
  }

  // Live cell-cursor payload: {sheetId, recordId, fieldId}; recordId/fieldId null = cleared (blur).
  private normalizeCursorPayload(
    payload: unknown,
  ): { sheetId: string; recordId: string | null; fieldId: string | null } | null {
    if (!payload || typeof payload !== 'object') return null
    const p = payload as Record<string, unknown>
    const sheetId = typeof p.sheetId === 'string' ? p.sheetId.trim() : ''
    if (!sheetId) return null
    const recordId = typeof p.recordId === 'string' && p.recordId.trim() ? p.recordId.trim() : null
    const fieldId = typeof p.fieldId === 'string' && p.fieldId.trim() ? p.fieldId.trim() : null
    return { sheetId, recordId, fieldId }
  }

  // Broadcast a user's active cell to the rest of the sheet room (sender excluded via socket.to). The
  // userId is the trusted server-side identity; recordId/fieldId null clears that user's remote cursor.
  private broadcastCursor(
    socket: Socket,
    sheetId: string,
    userId: string,
    recordId: string | null,
    fieldId: string | null,
  ): void {
    this.emitToRoom(this.buildSheetRoom(sheetId), 'sheet:cursor', { sheetId, userId, recordId, fieldId }, socket)
  }

  private trackSocketSheetMembership(socketId: string, sheetId: string) {
    const current = this.sheetMembershipBySocket.get(socketId) ?? new Set<string>()
    current.add(sheetId)
    this.sheetMembershipBySocket.set(socketId, current)
  }

  private untrackSocketSheetMembership(socketId: string, sheetId: string) {
    const current = this.sheetMembershipBySocket.get(socketId)
    if (!current) return
    current.delete(sheetId)
    if (current.size === 0) {
      this.sheetMembershipBySocket.delete(socketId)
      return
    }
    this.sheetMembershipBySocket.set(socketId, current)
  }

  private addSheetPresence(sheetId: string, userId: string, socketId: string) {
    const sheetPresence = this.sheetPresenceBySheet.get(sheetId) ?? new Map<string, Set<string>>()
    const sockets = sheetPresence.get(userId) ?? new Set<string>()
    sockets.add(socketId)
    sheetPresence.set(userId, sockets)
    this.sheetPresenceBySheet.set(sheetId, sheetPresence)
  }

  private removeSheetPresence(sheetId: string, userId: string, socketId: string) {
    const sheetPresence = this.sheetPresenceBySheet.get(sheetId)
    if (!sheetPresence) return
    const sockets = sheetPresence.get(userId)
    if (!sockets) return
    sockets.delete(socketId)
    if (sockets.size === 0) {
      sheetPresence.delete(userId)
    } else {
      sheetPresence.set(userId, sockets)
    }
    if (sheetPresence.size === 0) {
      this.sheetPresenceBySheet.delete(sheetId)
      return
    }
    this.sheetPresenceBySheet.set(sheetId, sheetPresence)
  }

  private emitSheetPresence(sheetId: string) {
    if (!this.io) return
    const activeUsers = [...(this.sheetPresenceBySheet.get(sheetId)?.keys() ?? [])]
      .sort((left, right) => left.localeCompare(right))
      .map((id) => ({ id }))
    this.emitToRoom(this.buildSheetRoom(sheetId), 'sheet:presence', {
      sheetId,
      activeCount: activeUsers.length,
      users: activeUsers,
    })
  }

  private denySheetJoin(socket: Socket, sheetId: string, reason: string): void {
    socket.emit('join-denied', { sheetId, reason })
    this.logger.warn(`Client ${socket.id} denied joining sheet:${sheetId}: ${reason}`)
  }

  private async handleJoinSheet(socket: Socket, payload: unknown): Promise<void> {
    const sheetId = this.normalizeSheetId(payload)
    if (!sheetId) return

    const { userId, held } = await this.resolveIdentity(socket)
    if (!socket.connected) return
    if (!userId) {
      if (held && this.holdJoin(socket, `sheet:${sheetId}`, () => void this.handleJoinSheet(socket, payload))) return
      this.denySheetJoin(socket, sheetId, held ? 'unavailable' : this.isProtected() ? this.protectedDenyReason(socket) : 'unauthorized')
      return
    }

    let allowed = false
    try {
      allowed = await this.sheetRoomAuthChecker({ sheetId, userId, socketId: socket.id })
    } catch (error) {
      this.logger.warn('WebSocket sheet room auth check failed', error instanceof Error ? error : undefined)
    }
    if (!socket.connected) return
    if (!allowed) {
      this.denySheetJoin(socket, sheetId, 'forbidden')
      return
    }

    const room = this.buildSheetRoom(sheetId)
    if (this.isProtected()) this.roomScopes.set(room, { kind: 'sheet', sheetId })
    socket.join(room)
    this.trackSocketSheetMembership(socket.id, sheetId)
    this.addSheetPresence(sheetId, userId, socket.id)
    this.logger.info(`Client ${socket.id} joined ${room}`)
    socket.emit('joined', { sheetId })
    this.emitSheetPresence(sheetId)
  }

  // Shared auth+read gate for comment rooms that expose comment bodies. Record rooms require row-level
  // read access; sheet-wide rooms are delegated to `commentRoomAuthChecker` so row-deny-enabled sheets can
  // fail closed instead of receiving unfilterable full-comment broadcasts.
  private async authorizeCommentRoomAccess(
    socket: Socket,
    spreadsheetId: string,
    rowId: string | undefined,
    whenHeld: { key: string; replay: () => void },
  ): Promise<boolean> {
    const { userId, held } = await this.resolveIdentity(socket)
    if (!socket.connected) return false
    if (!userId) {
      if (held && this.holdJoin(socket, whenHeld.key, whenHeld.replay)) return false
      this.denyCommentJoin(socket, spreadsheetId, held ? 'unavailable' : this.isProtected() ? this.protectedDenyReason(socket) : 'unauthorized')
      return false
    }
    let allowed = false
    try {
      if (this.commentRoomAuthChecker) {
        allowed = await this.commentRoomAuthChecker({ spreadsheetId, rowId, userId, socketId: socket.id })
      } else {
        allowed = await this.sheetRoomAuthChecker({ sheetId: spreadsheetId, userId, socketId: socket.id })
      }
    } catch (error) {
      this.logger.warn('WebSocket comment room auth check failed', error instanceof Error ? error : undefined)
    }
    if (!socket.connected) return false
    if (!allowed) {
      this.denyCommentJoin(socket, spreadsheetId, 'forbidden')
      return false
    }
    return true
  }

  private denyCommentJoin(socket: Socket, scope: string, reason: string): void {
    socket.emit('comment-join-denied', { scope, reason })
    this.logger.warn(`Client ${socket.id} denied joining comment room ${scope}: ${reason}`)
  }

  private async handleJoinCommentRecord(socket: Socket, payload: unknown): Promise<void> {
    const scope = this.parseCommentRecordScope(payload)
    if (!scope) return
    const whenHeld = {
      key: `comment-record:${scope.spreadsheetId}:${scope.rowId}`,
      replay: () => void this.handleJoinCommentRecord(socket, payload),
    }
    if (!(await this.authorizeCommentRoomAccess(socket, scope.spreadsheetId, scope.rowId, whenHeld))) return
    if (!socket.connected) return
    const room = buildCommentRecordRoom(scope)
    if (this.isProtected()) this.roomScopes.set(room, { kind: 'comment', spreadsheetId: scope.spreadsheetId, rowId: scope.rowId })
    socket.join(room)
    this.logger.info(`Client ${socket.id} joined ${room}`)
    socket.emit('joined-comment-record', scope)
  }

  private async handleJoinCommentSheet(socket: Socket, payload: unknown): Promise<void> {
    const spreadsheetId = this.parseSheetScope(payload)
    if (!spreadsheetId) return
    const whenHeld = { key: `comment-sheet:${spreadsheetId}`, replay: () => void this.handleJoinCommentSheet(socket, payload) }
    if (!(await this.authorizeCommentRoomAccess(socket, spreadsheetId, undefined, whenHeld))) return
    if (!socket.connected) return
    const room = buildCommentSheetRoom({ spreadsheetId })
    socket.join(room)
    this.logger.info(`Client ${socket.id} joined ${room}`)
  }

  private async handleJoinCommentInbox(socket: Socket): Promise<void> {
    // The comment inbox is a cross-sheet activity stream (metadata: ids/authorId, no bodies). It requires
    // a verified identity and joins a per-user room; publishers still re-check target read access before
    // emitting to that room.
    const { userId, held } = await this.resolveIdentity(socket)
    if (!socket.connected) return
    if (!userId) {
      if (held && this.holdJoin(socket, 'comment-inbox', () => void this.handleJoinCommentInbox(socket))) return
      this.denyCommentJoin(socket, 'comment-inbox', held ? 'unavailable' : this.isProtected() ? this.protectedDenyReason(socket) : 'unauthorized')
      return
    }
    const room = buildCommentInboxRoom({ userId })
    if (this.isProtected()) this.roomScopes.set(room, { kind: 'user', userId })
    socket.join(room)
    this.trackCommentInboxMembership(socket.id, userId)
    this.logger.info(`Client ${socket.id} joined ${room}`)
    socket.emit('joined-comment-inbox')
  }

  private trackCommentInboxMembership(socketId: string, userId: string): void {
    this.untrackCommentInboxMembership(socketId)
    this.commentInboxUserBySocket.set(socketId, userId)
    const socketIds = this.commentInboxSocketsByUser.get(userId) ?? new Set<string>()
    socketIds.add(socketId)
    this.commentInboxSocketsByUser.set(userId, socketIds)
  }

  private untrackCommentInboxMembership(socketId: string): string | undefined {
    const userId = this.commentInboxUserBySocket.get(socketId)
    if (!userId) return undefined
    this.commentInboxUserBySocket.delete(socketId)
    const socketIds = this.commentInboxSocketsByUser.get(userId)
    socketIds?.delete(socketId)
    if (!socketIds || socketIds.size === 0) this.commentInboxSocketsByUser.delete(userId)
    return userId
  }

  initialize(httpServer: HttpServer): void {
    this.io = new SocketServer(httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
    })

    if (process.env.WS_REDIS_ENABLED === 'true') {
      this.logger.info('WS_REDIS_ENABLED=true; local adapter active (no Redis wiring yet)')
    }

    this.io.on('connection', (socket: Socket) => {
      this.logger.info(`WebSocket client connected: ${socket.id}`)
      if (this.isProtected() && this.connections) {
        // Protected: registered first, served only after its session has been read as current.
        this.unjoinedSockets.add(socket)
        this.adoptSocket(socket)
        void this.connections.admit(socket)
      } else {
        void this.joinAuthenticatedUserRoom(socket)
      }

      socket.on('disconnect', () => {
        const userId = this.getTrustedUserId(socket)
        const sheetIds = [...(this.sheetMembershipBySocket.get(socket.id) ?? [])]
        for (const sheetId of sheetIds) {
          // Clear this socket's live cell-cursor for the rest of the room before dropping presence.
          if (userId) this.broadcastCursor(socket, sheetId, userId, null, null)
          if (userId) this.removeSheetPresence(sheetId, userId, socket.id)
          this.untrackSocketSheetMembership(socket.id, sheetId)
          this.emitSheetPresence(sheetId)
        }
        this.untrackCommentInboxMembership(socket.id)
        this.connections?.unregister(socket)
        this.heldJoins.delete(socket)
        this.unjoinedSockets.delete(socket)
        this.heldPluginHandlers.delete(socket)
        this.rawPluginSockets.delete(socket)
        this.logger.info(`WebSocket client disconnected: ${socket.id}`)
      })

      socket.on('join-sheet', (payload: unknown) => {
        void this.handleJoinSheet(socket, payload)
      })

      socket.on('leave-sheet', (payload: unknown) => {
        const sheetId = this.normalizeSheetId(payload)
        if (!sheetId) return
        this.dropHeldJoin(socket, `sheet:${sheetId}`)
        const room = this.buildSheetRoom(sheetId)
        const userId = this.getTrustedUserId(socket)
        if (userId) this.broadcastCursor(socket, sheetId, userId, null, null)
        socket.leave(room)
        if (userId) this.removeSheetPresence(sheetId, userId, socket.id)
        this.untrackSocketSheetMembership(socket.id, sheetId)
        this.logger.info(`Client ${socket.id} left ${room}`)
        this.emitSheetPresence(sheetId)
      })

      // Live cell-cursor relay (presentational, no persistence): a sheet member broadcasts its active
      // cell to the rest of the room (sender excluded). Membership-gated; userId is the trusted identity.
      socket.on('sheet:cursor', (payload: unknown) => {
        const data = this.normalizeCursorPayload(payload)
        if (!data) return
        if (!this.sheetMembershipBySocket.get(socket.id)?.has(data.sheetId)) return
        if (this.isProtected()) {
          // Protected: the sender is re-checked before its cursor is relayed to anyone.
          void this.resolveTrustedUserId(socket).then((currentUserId) => {
            if (!currentUserId || !socket.connected) return
            if (!this.sheetMembershipBySocket.get(socket.id)?.has(data.sheetId)) return
            this.broadcastCursor(socket, data.sheetId, currentUserId, data.recordId, data.fieldId)
          })
          return
        }
        const userId = this.getTrustedUserId(socket)
        if (!userId) return
        this.broadcastCursor(socket, data.sheetId, userId, data.recordId, data.fieldId)
      })

      socket.on('join-comment-record', (payload: unknown) => {
        void this.handleJoinCommentRecord(socket, payload)
      })

      socket.on('leave-comment-record', (payload: unknown) => {
        const scope = this.parseCommentRecordScope(payload)
        if (!scope) return
        this.dropHeldJoin(socket, `comment-record:${scope.spreadsheetId}:${scope.rowId}`)
        const room = buildCommentRecordRoom(scope)
        socket.leave(room)
        this.logger.info(`Client ${socket.id} left ${room}`)
      })

      socket.on('join-comment-sheet', (payload: unknown) => {
        void this.handleJoinCommentSheet(socket, payload)
      })

      socket.on('leave-comment-sheet', (payload: unknown) => {
        const spreadsheetId = this.parseSheetScope(payload)
        if (!spreadsheetId) return
        this.dropHeldJoin(socket, `comment-sheet:${spreadsheetId}`)
        const room = buildCommentSheetRoom({ spreadsheetId })
        socket.leave(room)
        this.logger.info(`Client ${socket.id} left ${room}`)
      })

      socket.on('join-comment-inbox', () => {
        void this.handleJoinCommentInbox(socket)
      })

      socket.on('leave-comment-inbox', () => {
        this.dropHeldJoin(socket, 'comment-inbox')
        const userId = this.untrackCommentInboxMembership(socket.id) ?? this.getTrustedUserId(socket)
        if (!userId) return
        const room = buildCommentInboxRoom({ userId })
        socket.leave(room)
        this.logger.info(`Client ${socket.id} left ${room}`)
      })

      socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() })
      })
    })

    this.logger.info('CollabService (WebSocket) initialized')
  }

  getIO(): SocketServer | null {
    return this.io
  }

  /**
   * Stop of the server only: closes the transport of every connection with its standard close, which
   * writes the packets already queued first and then ends the transport; the client sees a transport
   * close and reconnects by itself. Sends nothing else. Returns how many transports were closed.
   */
  closeTransportsForShutdown(): number {
    const engine = this.io?.engine as unknown as { clients?: Record<string, { close(): unknown }> } | undefined
    const clients = Object.values(engine?.clients ?? {})
    for (const client of clients) client.close()
    return clients.length
  }

  broadcast(event: string, data: unknown): void {
    if (!this.io) {
      this.logger.warn('Attempted to broadcast before initialization')
      return
    }
    if (this.isProtected() && this.connections) {
      // Protected: a broadcast reaches only connections whose session is current right now.
      const everyone = [...this.io.sockets.sockets.values()]
      void this.connections.deliver(everyone, (socket) => socket.emit(event, data)).catch((error) => {
        this.logger.warn('Protected broadcast failed', error instanceof Error ? error : undefined)
      })
      return
    }
    this.io.emit(event, data)
  }

  broadcastTo(room: string, event: string, data: unknown): void {
    if (!this.io) {
      this.logger.warn('Attempted to broadcastTo before initialization')
      return
    }
    this.emitToRoom(room, event, data)
  }

  sendTo(userId: string, event: string, data: unknown): void {
    if (!this.io) return
    this.emitToRoom(userId, event, data)
  }

  async join(room: string, options?: { userId?: string; socketId?: string }): Promise<void> {
    if (!this.io) {
      this.logger.warn('Attempted to join room before initialization')
      return
    }
    const target = this.resolveTarget(options)
    if (!target) {
      this.logger.warn('join requires userId or socketId')
      return
    }
    if (this.isProtected() && this.connections) {
      // Protected: only connections whose session is current right now are put into the room.
      await this.connections.deliver(this.localRoomSockets(target), (socket) => {
        (socket as Socket).join(room)
      })
      this.logger.debug(`Joined ${target} to room ${room}`)
      return
    }
    await this.io.in(target).socketsJoin(room)
    this.logger.debug(`Joined ${target} to room ${room}`)
  }

  async leave(room: string, options?: { userId?: string; socketId?: string }): Promise<void> {
    if (!this.io) {
      this.logger.warn('Attempted to leave room before initialization')
      return
    }
    const target = this.resolveTarget(options)
    if (!target) {
      this.logger.warn('leave requires userId or socketId')
      return
    }
    await this.io.in(target).socketsLeave(room)
    this.logger.debug(`Left ${target} from room ${room}`)
  }

  /** The baseline way a plugin connection handler meets a connection: it is given the transport. */
  private runPluginHandlerAtBaseline(socket: Socket, handler: (socket: Socket) => void): void {
    this.rawPluginSockets.add(socket)
    socket.once('disconnect', () => this.rawPluginSockets.delete(socket))
    try {
      handler(socket)
    } catch (error) {
      this.logger.warn('Plugin connection handler failed', error instanceof Error ? error : undefined)
    }
  }

  onConnection(handler: (socket: Socket) => void): void {
    if (!this.io) return
    this.io.on('connection', (socket: Socket) => {
      if (!this.isProtected() || !this.connections) {
        this.rawPluginSockets.add(socket)
        socket.once('disconnect', () => this.rawPluginSockets.delete(socket))
        handler(socket)
        return
      }
      // Protected: the handler never sees a connection that has not been admitted, and what it
      // receives is the constrained connection, not the transport.
      const heldWhenAsked = this.protection.decision().ordinaryHandshake === 'hold'
      this.adoptSocket(socket)
      void this.connections.admit(socket).then((binding) => {
        if (!socket.connected) return
        if (!binding) {
          // Kept waiting, not refused: the handler meets this connection when it is released to
          // the baseline, the way it would have met it had it arrived then.
          if (!heldWhenAsked) return
          if (!this.isProtected()) {
            this.runPluginHandlerAtBaseline(socket, handler)
            return
          }
          this.heldPluginHandlers.set(socket, [...(this.heldPluginHandlers.get(socket) ?? []), handler])
          return
        }
        handler(this.constrainedPluginSocket(socket, binding) as unknown as Socket)
      }).catch((error) => {
        this.logger.warn('Plugin connection handler failed', error instanceof Error ? error : undefined)
      })
    })
  }

  private constrainedPluginSocket(socket: Socket, binding: RealtimeSessionBinding): ConstrainedPluginSocket {
    const userId = binding.userId
    const deliverToSelf = (send: (target: ProtectedSocket) => void): void => {
      if (!this.connections) return
      void this.connections.deliver([socket], send).catch((error) => {
        this.logger.warn('Protected plugin send failed', error instanceof Error ? error : undefined)
      })
    }
    const constrained: ConstrainedPluginSocket = {
      id: socket.id,
      userId,
      get connected() {
        return socket.connected
      },
      data: Object.freeze({ trustedUserId: userId }),
      on: (event, listener) => {
        socket.on(event, (...args: unknown[]) => {
          void this.resolveTrustedUserId(socket).then((currentUserId) => {
            if (!currentUserId || currentUserId !== userId || !socket.connected) return
            listener(...args)
          })
        })
        return constrained
      },
      emit: (event, ...args) => {
        deliverToSelf((target) => target.emit(event, ...args))
        return true
      },
      join: (room) => {
        deliverToSelf((target) => {
          (target as Socket).join(room)
        })
      },
      leave: (room) => {
        socket.leave(room)
      },
      to: (room) => ({
        emit: (event, payload) => {
          this.emitToRoom(room, event, payload, socket)
          return true
        },
      }),
      disconnect: (close) => {
        socket.disconnect(close)
      },
    }
    return constrained
  }

  /**
   * Return a list of user IDs currently present in the given room.
   *
   * When Socket.IO is not initialised (e.g. in unit tests or early startup),
   * this method safely returns an empty array instead of throwing.
   */
  async getRoomMembers(room: string): Promise<string[]> {
    if (!this.io) return []
    if (this.isProtected() && this.connections) {
      // Protected: a member is listed only when its session is current and it may still read the
      // resource of the room right now.
      const scope = this.scopeOfRoom(room)
      const userIds = new Set<string>()
      try {
        await this.connections.deliver(this.localRoomSockets(room), (_socket, binding) => {
          userIds.add(binding.userId)
        }, {
          resourceCheck: (binding, socket) => this.checkRoomScope(scope, binding, socket.id),
          onResourceDenied: (socket) => this.dropSubscription(socket as Socket, room, scope),
          stillSubscribed: (socket) => (socket as Socket).rooms.has(room),
        })
      } catch {
        return []
      }
      return [...userIds]
    }
    try {
      const sockets = await this.io.in(room).fetchSockets()
      const userIds = new Set<string>()
      for (const socket of sockets) {
        const raw = (socket.data as AuthenticatedSocketData | undefined)?.trustedUserId
        if (typeof raw === 'string' && raw.trim().length > 0) {
          userIds.add(raw.trim())
        }
      }
      return [...userIds]
    } catch {
      return []
    }
  }

  getCommentInboxSubscriberIds(): string[] {
    if (this.isProtected() && this.connections && this.io) {
      const userIds: string[] = []
      for (const [userId, socketIds] of this.commentInboxSocketsByUser) {
        for (const socketId of socketIds) {
          const socket = this.io.sockets.sockets.get(socketId)
          if (socket && this.connections.isServiceable(socket)) {
            userIds.push(userId)
            break
          }
        }
      }
      return userIds
    }
    return [...this.commentInboxSocketsByUser.keys()]
  }
}
