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

  sendTo(userId: string, event: string, data: unknown): void {
    if (!this.io) return
    this.io.to(userId).emit(event, data)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onConnection(handler: (socket: any) => void): void {
    if (!this.io) return
    this.io.on('connection', handler)
  }
}
