import { Server as SocketServer, Socket } from 'socket.io';
import { Inject } from '@wendellhu/redi';
import { ICollabService, ILogger } from '../di/identifiers';
import { EventBus } from '../events/EventBus';
import type { Server as HttpServer } from 'http';

export class CollabService implements ICollabService {
  private io: SocketServer | null = null;
  private connectionHandlers: Array<(socket: any) => void> = [];

  static inject = [ILogger, EventBus];

  constructor(
    private logger: ILogger,
    private eventBus: EventBus
  ) {
    this.setupEventListeners();
  }

  private setupEventListeners() {
    this.eventBus.subscribe('spreadsheet.cell.updated', (payload: unknown) => {
      if (!this.io) return;
      const data = payload as { spreadsheetId?: string } & Record<string, unknown>
      const spreadsheetId = data.spreadsheetId
      if (!spreadsheetId) return
      // Broadcast to room 'sheet:{spreadsheetId}'
      this.io.to(`sheet:${spreadsheetId}`).emit('sheet:op', {
        type: 'cell-update',
        data
      });
      this.logger.debug(`Broadcasting update for sheet ${spreadsheetId}`);
    });
  }

  initialize(httpServer: HttpServer): void {
    this.io = new SocketServer(httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      }
    });

    if (process.env.WS_REDIS_ENABLED === 'true') {
      this.logger.info('WS_REDIS_ENABLED=true; local adapter active (no Redis wiring yet)');
    }

    this.io.on('connection', (socket: Socket) => {
      this.logger.info(`WebSocket client connected: ${socket.id}`);
      const userId = typeof socket.handshake.query.userId === 'string'
        ? socket.handshake.query.userId
        : undefined
      if (userId) {
        socket.join(userId)
        socket.data.userId = userId
      }

      socket.on('disconnect', () => {
        this.logger.info(`WebSocket client disconnected: ${socket.id}`);
      });

      socket.on('join-sheet', (sheetId: string) => {
        socket.join(`sheet:${sheetId}`);
        this.logger.info(`Client ${socket.id} joined sheet:${sheetId}`);
        socket.emit('joined', { sheetId });
      });

      socket.on('leave-sheet', (sheetId: string) => {
        socket.leave(`sheet:${sheetId}`);
        this.logger.info(`Client ${socket.id} left sheet:${sheetId}`);
      });

      // Test event
      socket.on('ping', () => {
        socket.emit('pong', { timestamp: Date.now() });
      });
    });

    for (const handler of this.connectionHandlers) {
      this.io.on('connection', handler);
    }

    this.logger.info('CollabService (WebSocket) initialized');
  }

  broadcast(event: string, data: unknown): void {
    if (!this.io) {
      this.logger.warn('Attempted to broadcast before initialization');
      return;
    }
    this.io.emit(event, data);
  }

  sendTo(userId: string, event: string, data: unknown): void {
    if (!this.io) return;
    this.io.to(userId).emit(event, data);
  }

  joinRoom(room: string, userId: string): void
  joinRoom(socketId: string, room: string): void
  joinRoom(arg1: string, arg2: string): void {
    if (!this.io) return
    const socket = this.io.sockets.sockets.get(arg1)
    if (socket) {
      socket.join(arg2)
      return
    }
    if (!arg2) return
    this.io.in(arg2).socketsJoin(arg1)
  }

  async close(): Promise<void> {
    if (!this.io) return
    await new Promise<void>((resolve) => {
      this.io?.close(() => resolve())
    })
    this.io = null
  }

  // Exposed for Plugin System (CoreAPI)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onConnection(handler: (socket: any) => void): void {
    this.connectionHandlers.push(handler);
    if (!this.io) return;
    this.io.on('connection', handler);
  }

  leaveRoom(socketId: string, room: string): void {
    if (!this.io) return
    const socket = this.io.sockets.sockets.get(socketId)
    if (!socket) {
      this.logger.warn(`WebSocket client not found: ${socketId}`)
      return
    }
    socket.leave(room)
  }

  broadcastTo(room: string, event: string, data: unknown): void {
    if (!this.io) {
      this.logger.warn('Attempted to broadcastTo before initialization')
      return
    }
    this.io.to(room).emit(event, data)
  }
}
