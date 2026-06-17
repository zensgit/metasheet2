import type { Socket } from 'socket.io';
import { Server as SocketServer } from 'socket.io'
import type { Server as HttpServer } from 'http'
import type { ILogger } from '../di/identifiers'
import type { EventBus } from '../integration/events/event-bus'
import { buildCommentInboxRoom, buildCommentRecordRoom, buildCommentSheetRoom } from './commentRooms'

export function buildAuthenticatedUserRoom(userId: string): string {
  return `auth-user:${userId}`
}

export type SocketTokenVerifier = (token: string) => Promise<string | null>
export type SheetRoomAuthChecker = (input: { sheetId: string; userId: string; socketId: string }) => Promise<boolean>

type AuthenticatedSocketData = {
  trustedUserId?: string | null
  authPromise?: Promise<string | null>
}

export class CollabService {
  private io: SocketServer | null = null
  private sheetPresenceBySheet = new Map<string, Map<string, Set<string>>>()
  private sheetMembershipBySocket = new Map<string, Set<string>>()
  private tokenVerifier: SocketTokenVerifier = async (token) => {
    // AuthService pulls in RBAC/metrics modules; keep it lazy so importing CollabService
    // does not register global metrics during parallel unit-test collection.
    const { authService } = await import('../auth/AuthService')
    const user = await authService.verifyToken(token)
    return user?.id?.toString().trim() || null
  }
  private sheetRoomAuthChecker: SheetRoomAuthChecker = async () => false

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

  private setupEventListeners() {
    this.eventBus.subscribe('spreadsheet.cell.updated', (payload) => {
      if (!this.io) return
      const data = payload as { spreadsheetId?: string }
      if (!data?.spreadsheetId) return
      this.io.to(`sheet:${data.spreadsheetId}`).emit('sheet:op', {
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
    socket.to(this.buildSheetRoom(sheetId)).emit('sheet:cursor', { sheetId, userId, recordId, fieldId })
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
    this.io.to(this.buildSheetRoom(sheetId)).emit('sheet:presence', {
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

    const userId = await this.resolveTrustedUserId(socket)
    if (!socket.connected) return
    if (!userId) {
      this.denySheetJoin(socket, sheetId, 'unauthorized')
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
    socket.join(room)
    this.trackSocketSheetMembership(socket.id, sheetId)
    this.addSheetPresence(sheetId, userId, socket.id)
    this.logger.info(`Client ${socket.id} joined ${room}`)
    socket.emit('joined', { sheetId })
    this.emitSheetPresence(sheetId)
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
      void this.joinAuthenticatedUserRoom(socket)

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
        this.logger.info(`WebSocket client disconnected: ${socket.id}`)
      })

      socket.on('join-sheet', (payload: unknown) => {
        void this.handleJoinSheet(socket, payload)
      })

      socket.on('leave-sheet', (payload: unknown) => {
        const sheetId = this.normalizeSheetId(payload)
        if (!sheetId) return
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
        const userId = this.getTrustedUserId(socket)
        if (!userId) return
        this.broadcastCursor(socket, data.sheetId, userId, data.recordId, data.fieldId)
      })

      socket.on('join-comment-record', (payload: unknown) => {
        const scope = this.parseCommentRecordScope(payload)
        if (!scope) return
        const room = buildCommentRecordRoom(scope)
        socket.join(room)
        this.logger.info(`Client ${socket.id} joined ${room}`)
        socket.emit('joined-comment-record', scope)
      })

      socket.on('leave-comment-record', (payload: unknown) => {
        const scope = this.parseCommentRecordScope(payload)
        if (!scope) return
        const room = buildCommentRecordRoom(scope)
        socket.leave(room)
        this.logger.info(`Client ${socket.id} left ${room}`)
      })

      socket.on('join-comment-sheet', (payload: unknown) => {
        const spreadsheetId = this.parseSheetScope(payload)
        if (!spreadsheetId) return
        const room = buildCommentSheetRoom({ spreadsheetId })
        socket.join(room)
        this.logger.info(`Client ${socket.id} joined ${room}`)
      })

      socket.on('leave-comment-sheet', (payload: unknown) => {
        const spreadsheetId = this.parseSheetScope(payload)
        if (!spreadsheetId) return
        const room = buildCommentSheetRoom({ spreadsheetId })
        socket.leave(room)
        this.logger.info(`Client ${socket.id} left ${room}`)
      })

      socket.on('join-comment-inbox', () => {
        const room = buildCommentInboxRoom()
        socket.join(room)
        this.logger.info(`Client ${socket.id} joined ${room}`)
        socket.emit('joined-comment-inbox')
      })

      socket.on('leave-comment-inbox', () => {
        const room = buildCommentInboxRoom()
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

  broadcast(event: string, data: unknown): void {
    if (!this.io) {
      this.logger.warn('Attempted to broadcast before initialization')
      return
    }
    this.io.emit(event, data)
  }

  broadcastTo(room: string, event: string, data: unknown): void {
    if (!this.io) {
      this.logger.warn('Attempted to broadcastTo before initialization')
      return
    }
    this.io.to(room).emit(event, data)
  }

  sendTo(userId: string, event: string, data: unknown): void {
    if (!this.io) return
    this.io.to(userId).emit(event, data)
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

  onConnection(handler: (socket: Socket) => void): void {
    if (!this.io) return
    this.io.on('connection', handler)
  }

  /**
   * Return a list of user IDs currently present in the given room.
   *
   * When Socket.IO is not initialised (e.g. in unit tests or early startup),
   * this method safely returns an empty array instead of throwing.
   */
  async getRoomMembers(room: string): Promise<string[]> {
    if (!this.io) return []
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
}
