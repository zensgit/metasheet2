import { Server as SocketServer, Socket } from 'socket.io'
import type { Server as HttpServer } from 'http'
import type { ILogger } from '../di/identifiers'
import type { EventBus } from '../integration/events/event-bus'

export class CollabService {
  private io: SocketServer | null = null

  constructor(
    private logger: ILogger,
    private eventBus: EventBus,
  ) {
    this.setupEventListeners()
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

  private getUserIdFromSocket(socket: Socket): string | undefined {
    const raw = socket.handshake.query.userId
    const value = Array.isArray(raw) ? raw[0] : raw
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    return undefined
  }

  private resolveTarget(options?: { userId?: string; socketId?: string }): string | null {
    if (options?.userId) return options.userId
    if (options?.socketId) return options.socketId
    return null
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
      const userId = this.getUserIdFromSocket(socket)
      if (userId) {
        socket.join(userId)
        this.logger.debug(`WebSocket client ${socket.id} joined user room ${userId}`)
      }

      socket.on('disconnect', () => {
        this.logger.info(`WebSocket client disconnected: ${socket.id}`)
      })

      socket.on('join-sheet', (sheetId: string) => {
        socket.join(`sheet:${sheetId}`)
        this.logger.info(`Client ${socket.id} joined sheet:${sheetId}`)
        socket.emit('joined', { sheetId })
      })

      socket.on('leave-sheet', (sheetId: string) => {
        socket.leave(`sheet:${sheetId}`)
        this.logger.info(`Client ${socket.id} left sheet:${sheetId}`)
      })

      socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() })
      })
    })

    this.logger.info('CollabService (WebSocket) initialized')
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onConnection(handler: (socket: any) => void): void {
    if (!this.io) return
    this.io.on('connection', handler)
  }
}
