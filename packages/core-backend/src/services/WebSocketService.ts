// @ts-nocheck
/**
 * WebSocket 服务实现
 * 提供实时通信功能，支持房间管理、权限控制等
 */

import { EventEmitter } from 'eventemitter3'
import type {
  WebSocketService,
  BroadcastOptions,
  SendOptions,
  SocketInfo,
  SocketMiddleware
} from '../types/plugin'
import { Logger } from '../core/logger'

/**
 * Socket 连接信息实现
 */
export class SocketInfoImpl implements SocketInfo {
  id: string
  userId?: string
  rooms: string[] = []
  connected: boolean = true
  connectedAt: Date = new Date()
  lastSeen: Date = new Date()
  metadata: Record<string, any> = {}

  constructor(id: string, userId?: string) {
    this.id = id
    this.userId = userId
  }

  updateLastSeen(): void {
    this.lastSeen = new Date()
  }
}

/**
 * WebSocket 服务实现
 */
export class WebSocketServiceImpl extends EventEmitter implements WebSocketService {
  private sockets = new Map<string, SocketInfoImpl>()
  private rooms = new Map<string, Set<string>>() // room -> socket IDs
  private userSockets = new Map<string, Set<string>>() // user ID -> socket IDs
  private middlewares: SocketMiddleware[] = []
  private logger: Logger
  private ioInstance: any // Socket.IO instance

  constructor(ioInstance?: any) {
    super()
    this.logger = new Logger('WebSocketService')
    this.ioInstance = ioInstance

    // 如果提供了 Socket.IO 实例，设置事件监听
    if (ioInstance) {
      this.setupSocketIOListeners(ioInstance)
    }
  }

  /**
   * 设置 Socket.IO 监听器
   */
  private setupSocketIOListeners(io: any): void {
    io.on('connection', (socket: any) => {
      const socketInfo = new SocketInfoImpl(socket.id)
      this.sockets.set(socket.id, socketInfo)

      // 应用中间件
      this.applyMiddlewares(socketInfo, (error?: Error) => {
        if (error) {
          this.logger.warn(`Middleware rejected connection ${socket.id}: ${error.message}`)
          socket.disconnect(true)
          return
        }

        this.emit('connection', socketInfo)
        this.logger.debug(`Socket connected: ${socket.id}`)
      })

      // 监听断开连接
      socket.on('disconnect', (reason: string) => {
        socketInfo.connected = false
        this.handleDisconnection(socketInfo, reason)
      })

      // 监听自定义事件
      socket.onAny((event: string, ...args: any[]) => {
        socketInfo.updateLastSeen()
        this.emit('message', event, socketInfo, ...args)
      })
    })
  }

  /**
   * 应用中间件
   */
  private applyMiddlewares(socket: SocketInfo, callback: (error?: Error) => void): void {
    let index = 0

    const next = (error?: Error) => {
      if (error) {
        callback(error)
        return
      }

      if (index >= this.middlewares.length) {
        callback()
        return
      }

      const middleware = this.middlewares[index++]
      try {
        middleware(socket, next)
      } catch (error) {
        next(error as Error)
      }
    }

    next()
  }

  /**
   * 处理连接断开
   */
  private handleDisconnection(socket: SocketInfoImpl, reason: string): void {
    // 从所有房间中移除
    for (const room of socket.rooms) {
      const roomSockets = this.rooms.get(room)
      if (roomSockets) {
        roomSockets.delete(socket.id)
        if (roomSockets.size === 0) {
          this.rooms.delete(room)
        }
      }
    }

    // 从用户映射中移除
    if (socket.userId) {
      const userSocketSet = this.userSockets.get(socket.userId)
      if (userSocketSet) {
        userSocketSet.delete(socket.id)
        if (userSocketSet.size === 0) {
          this.userSockets.delete(socket.userId)
        }
      }
    }

    // 从连接列表中移除
    this.sockets.delete(socket.id)

    this.emit('disconnection', socket)
    this.logger.debug(`Socket disconnected: ${socket.id}, reason: ${reason}`)
  }

  broadcast(event: string, data: any, options: BroadcastOptions = {}): void {
    try {
      if (this.ioInstance) {
        let emitter = this.ioInstance

        if (options.except && options.except.length > 0) {
          // 排除指定的socket
          for (const socketId of options.except) {
            emitter = emitter.except(socketId)
          }
        }

        // 设置发送选项
        if (options.compress) emitter = emitter.compress(true)
        if (options.volatile) emitter = emitter.volatile
        if (options.binary) emitter = emitter.binary(true)

        emitter.emit(event, data)
      } else {
        // 回退到内存实现
        for (const [socketId, socket] of this.sockets.entries()) {
          if (socket.connected && !options.except?.includes(socketId)) {
            this.emit('send', socketId, event, data)
          }
        }
      }

      this.emit('broadcast', { event, data, options })
      this.logger.debug(`Broadcast sent: ${event}`)
    } catch (error) {
      this.logger.error(`Failed to broadcast event ${event}`, error as Error)
      this.emit('error', { operation: 'broadcast', event, error })
    }
  }

  async sendTo(targetId: string, event: string, data: any, options: SendOptions = {}): Promise<boolean> {
    try {
      // 尝试按用户ID发送
      const userSockets = this.userSockets.get(targetId)
      if (userSockets && userSockets.size > 0) {
        let sent = false
        for (const socketId of userSockets) {
          const success = await this.sendToSocket(socketId, event, data, options)
          sent = sent || success
        }
        return sent
      }

      // 尝试按Socket ID发送
      const socket = this.sockets.get(targetId)
      if (socket && socket.connected) {
        return await this.sendToSocket(targetId, event, data, options)
      }

      this.logger.warn(`Target not found for sendTo: ${targetId}`)
      return false
    } catch (error) {
      this.logger.error(`Failed to send to ${targetId}`, error as Error)
      return false
    }
  }

  async sendToMany(targetIds: string[], event: string, data: any, options: SendOptions = {}): Promise<boolean[]> {
    const results = await Promise.all(
      targetIds.map(id => this.sendTo(id, event, data, options))
    )
    return results
  }

  private async sendToSocket(socketId: string, event: string, data: any, options: SendOptions = {}): Promise<boolean> {
    try {
      if (this.ioInstance) {
        const socket = this.ioInstance.sockets.sockets.get(socketId)
        if (socket && socket.connected) {
          let emitter = socket

          // 设置发送选项
          if (options.timeout) emitter = emitter.timeout(options.timeout)
          if (options.compress) emitter = emitter.compress(true)
          if (options.volatile) emitter = emitter.volatile
          if (options.binary) emitter = emitter.binary(true)

          emitter.emit(event, data)
          return true
        }
      } else {
        // 回退到内存实现
        const socket = this.sockets.get(socketId)
        if (socket && socket.connected) {
          this.emit('send', socketId, event, data)
          return true
        }
      }
      return false
    } catch (error) {
      this.logger.error(`Failed to send to socket ${socketId}`, error as Error)
      return false
    }
  }

  async join(socketId: string, room: string): Promise<void> {
    try {
      const socket = this.sockets.get(socketId)
      if (!socket || !socket.connected) {
        throw new Error(`Socket ${socketId} not found or not connected`)
      }

      // 添加到房间
      if (!this.rooms.has(room)) {
        this.rooms.set(room, new Set())
      }
      this.rooms.get(room)!.add(socketId)

      // 更新socket信息
      if (!socket.rooms.includes(room)) {
        socket.rooms.push(room)
      }

      // 如果有Socket.IO实例，也加入到Socket.IO房间
      if (this.ioInstance) {
        const ioSocket = this.ioInstance.sockets.sockets.get(socketId)
        if (ioSocket) {
          ioSocket.join(room)
        }
      }

      this.emit('room:joined', { socketId, room, socket })
      this.logger.debug(`Socket ${socketId} joined room ${room}`)
    } catch (error) {
      this.logger.error(`Failed to join room ${room}`, error as Error)
      throw error
    }
  }

  async leave(socketId: string, room: string): Promise<void> {
    try {
      const socket = this.sockets.get(socketId)
      if (!socket) {
        throw new Error(`Socket ${socketId} not found`)
      }

      // 从房间移除
      const roomSockets = this.rooms.get(room)
      if (roomSockets) {
        roomSockets.delete(socketId)
        if (roomSockets.size === 0) {
          this.rooms.delete(room)
        }
      }

      // 更新socket信息
      const roomIndex = socket.rooms.indexOf(room)
      if (roomIndex > -1) {
        socket.rooms.splice(roomIndex, 1)
      }

      // 如果有Socket.IO实例，也离开Socket.IO房间
      if (this.ioInstance) {
        const ioSocket = this.ioInstance.sockets.sockets.get(socketId)
        if (ioSocket) {
          ioSocket.leave(room)
        }
      }

      this.emit('room:left', { socketId, room, socket })
      this.logger.debug(`Socket ${socketId} left room ${room}`)
    } catch (error) {
      this.logger.error(`Failed to leave room ${room}`, error as Error)
      throw error
    }
  }

  async joinMany(socketIds: string[], room: string): Promise<void> {
    await Promise.all(socketIds.map(id => this.join(id, room)))
  }

  async leaveMany(socketIds: string[], room: string): Promise<void> {
    await Promise.all(socketIds.map(id => this.leave(id, room)))
  }

  broadcastToRoom(room: string, event: string, data: any, options: BroadcastOptions = {}): void {
    try {
      const roomSockets = this.rooms.get(room)
      if (!roomSockets || roomSockets.size === 0) {
        this.logger.debug(`No sockets in room ${room}`)
        return
      }

      if (this.ioInstance) {
        let emitter = this.ioInstance.to(room)

        if (options.except && options.except.length > 0) {
          for (const socketId of options.except) {
            emitter = emitter.except(socketId)
          }
        }

        if (options.compress) emitter = emitter.compress(true)
        if (options.volatile) emitter = emitter.volatile
        if (options.binary) emitter = emitter.binary(true)

        emitter.emit(event, data)
      } else {
        // 回退到内存实现
        for (const socketId of roomSockets) {
          if (!options.except?.includes(socketId)) {
            this.sendToSocket(socketId, event, data)
          }
        }
      }

      this.emit('room:broadcast', { room, event, data, options })
      this.logger.debug(`Broadcast to room ${room}: ${event}`)
    } catch (error) {
      this.logger.error(`Failed to broadcast to room ${room}`, error as Error)
      this.emit('error', { operation: 'broadcastToRoom', room, event, error })
    }
  }

  async getConnectedSockets(): Promise<SocketInfo[]> {
    return Array.from(this.sockets.values()).filter(socket => socket.connected)
  }

  async getSocketInfo(socketId: string): Promise<SocketInfo | null> {
    return this.sockets.get(socketId) || null
  }

  async getRoomSockets(room: string): Promise<SocketInfo[]> {
    const roomSocketIds = this.rooms.get(room)
    if (!roomSocketIds) return []

    const sockets: SocketInfo[] = []
    for (const socketId of roomSocketIds) {
      const socket = this.sockets.get(socketId)
      if (socket && socket.connected) {
        sockets.push(socket)
      }
    }
    return sockets
  }

  async getRooms(): Promise<string[]> {
    return Array.from(this.rooms.keys())
  }

  onConnection(handler: (socket: SocketInfo) => void): void {
    this.on('connection', handler)
  }

  onDisconnection(handler: (socket: SocketInfo) => void): void {
    this.on('disconnection', handler)
  }

  onMessage(event: string, handler: (socket: SocketInfo, data: any) => void): void {
    this.on('message', (eventName: string, socket: SocketInfo, ...args: any[]) => {
      if (eventName === event) {
        handler(socket, args[0])
      }
    })
  }

  use(middleware: SocketMiddleware): void {
    this.middlewares.push(middleware)
    this.logger.debug(`Registered WebSocket middleware`)
  }

  async authenticate(socketId: string, token: string): Promise<boolean> {
    try {
      // 这里应该集成实际的认证逻辑
      const socket = this.sockets.get(socketId)
      if (!socket) return false

      // 模拟token验证
      if (!token || token === 'invalid') {
        return false
      }

      // 假设从token中解析用户信息
      const userId = this.parseUserFromToken(token)
      if (userId) {
        socket.userId = userId
        socket.metadata.authenticated = true
        socket.metadata.authenticatedAt = new Date()

        // 添加到用户映射
        if (!this.userSockets.has(userId)) {
          this.userSockets.set(userId, new Set())
        }
        this.userSockets.get(userId)!.add(socketId)

        this.emit('socket:authenticated', { socketId, userId, socket })
        return true
      }

      return false
    } catch (error) {
      this.logger.error(`Authentication failed for socket ${socketId}`, error as Error)
      return false
    }
  }

  async authorize(socketId: string, resource: string, action: string): Promise<boolean> {
    try {
      const socket = this.sockets.get(socketId)
      if (!socket || !socket.userId) {
        return false
      }

      // 这里应该集成实际的授权逻辑
      // 简化实现：已认证用户有基本权限
      return socket.metadata.authenticated === true
    } catch (error) {
      this.logger.error(`Authorization failed for socket ${socketId}`, error as Error)
      return false
    }
  }

  private parseUserFromToken(token: string): string | null {
    try {
      // 简化的token解析实现
      // 实际实现应该使用JWT库等
      if (token.startsWith('user_')) {
        return token.substring(5)
      }
      return null
    } catch {
      return null
    }
  }

  /**
   * 获取服务统计信息
   */
  getStats(): {
    connectedSockets: number
    rooms: number
    totalConnections: number
    authenticatedSockets: number
  } {
    const connectedSockets = Array.from(this.sockets.values()).filter(s => s.connected).length
    const authenticatedSockets = Array.from(this.sockets.values())
      .filter(s => s.connected && s.metadata.authenticated).length

    return {
      connectedSockets,
      rooms: this.rooms.size,
      totalConnections: this.sockets.size,
      authenticatedSockets
    }
  }

  /**
   * 清理断开的连接
   */
  cleanup(): void {
    const disconnectedCount = this.sockets.size

    // 清理断开的连接
    for (const [socketId, socket] of this.sockets.entries()) {
      if (!socket.connected) {
        this.handleDisconnection(socket, 'cleanup')
      }
    }

    const cleaned = disconnectedCount - this.sockets.size
    if (cleaned > 0) {
      this.logger.info(`Cleaned up ${cleaned} disconnected sockets`)
    }
  }

  /**
   * 完全关闭WebSocket服务
   * 断开所有连接并清理资源
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down WebSocket service...')

    const totalSockets = this.sockets.size

    // 断开所有活跃连接
    for (const [socketId, socket] of this.sockets.entries()) {
      try {
        // 通知客户端服务器正在关闭
        if (this.ioInstance) {
          const ioSocket = this.ioInstance.sockets?.sockets?.get(socketId)
          if (ioSocket) {
            ioSocket.emit('server:shutdown', { message: 'Server is shutting down' })
            ioSocket.disconnect(true)
          }
        }
        this.handleDisconnection(socket, 'shutdown')
      } catch (err) {
        this.logger.warn(`Error disconnecting socket ${socketId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // 清理所有房间
    this.rooms.clear()
    this.userSockets.clear()
    this.sockets.clear()

    // 移除所有事件监听器
    this.removeAllListeners()

    this.logger.info(`WebSocket service shutdown complete. Disconnected ${totalSockets} sockets.`)
  }

  /**
   * 设置Socket.IO实例
   */
  setIOInstance(ioInstance: any): void {
    this.ioInstance = ioInstance
    this.setupSocketIOListeners(ioInstance)
  }
}

/**
 * 认证中间件
 */
export function createAuthMiddleware(verifyToken: (token: string) => Promise<string | null>): SocketMiddleware {
  return async (socket: SocketInfo, next: (err?: Error) => void) => {
    try {
      const token = socket.metadata.token
      if (!token) {
        return next(new Error('No authentication token provided'))
      }

      const userId = await verifyToken(token)
      if (!userId) {
        return next(new Error('Invalid authentication token'))
      }

      socket.userId = userId
      socket.metadata.authenticated = true
      next()
    } catch (error) {
      next(error as Error)
    }
  }
}

/**
 * 速率限制中间件
 */
export function createRateLimitMiddleware(
  maxRequests: number,
  windowMs: number
): SocketMiddleware {
  const requests = new Map<string, { count: number; resetTime: number }>()

  return (socket: SocketInfo, next: (err?: Error) => void) => {
    const now = Date.now()
    const key = socket.userId || socket.id
    const existing = requests.get(key)

    if (existing && now < existing.resetTime) {
      if (existing.count >= maxRequests) {
        return next(new Error('Rate limit exceeded'))
      }
      existing.count++
    } else {
      requests.set(key, {
        count: 1,
        resetTime: now + windowMs
      })
    }

    next()
  }
}