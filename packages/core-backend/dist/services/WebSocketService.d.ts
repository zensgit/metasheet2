/**
 * WebSocket 服务实现
 * 提供实时通信功能，支持房间管理、权限控制等
 */
import { EventEmitter } from 'eventemitter3';
import type { WebSocketService, BroadcastOptions, SendOptions, SocketInfo, SocketMiddleware } from '../types/plugin';
/**
 * Socket 连接信息实现
 */
export declare class SocketInfoImpl implements SocketInfo {
    id: string;
    userId?: string;
    rooms: string[];
    connected: boolean;
    connectedAt: Date;
    lastSeen: Date;
    metadata: Record<string, any>;
    constructor(id: string, userId?: string);
    updateLastSeen(): void;
}
/**
 * WebSocket 服务实现
 */
export declare class WebSocketServiceImpl extends EventEmitter implements WebSocketService {
    private sockets;
    private rooms;
    private userSockets;
    private middlewares;
    private logger;
    private ioInstance;
    constructor(ioInstance?: any);
    /**
     * 设置 Socket.IO 监听器
     */
    private setupSocketIOListeners;
    /**
     * 应用中间件
     */
    private applyMiddlewares;
    /**
     * 处理连接断开
     */
    private handleDisconnection;
    broadcast(event: string, data: any, options?: BroadcastOptions): void;
    sendTo(targetId: string, event: string, data: any, options?: SendOptions): Promise<boolean>;
    sendToMany(targetIds: string[], event: string, data: any, options?: SendOptions): Promise<boolean[]>;
    private sendToSocket;
    join(socketId: string, room: string): Promise<void>;
    leave(socketId: string, room: string): Promise<void>;
    joinMany(socketIds: string[], room: string): Promise<void>;
    leaveMany(socketIds: string[], room: string): Promise<void>;
    broadcastToRoom(room: string, event: string, data: any, options?: BroadcastOptions): void;
    getConnectedSockets(): Promise<SocketInfo[]>;
    getSocketInfo(socketId: string): Promise<SocketInfo | null>;
    getRoomSockets(room: string): Promise<SocketInfo[]>;
    getRooms(): Promise<string[]>;
    onConnection(handler: (socket: SocketInfo) => void): void;
    onDisconnection(handler: (socket: SocketInfo) => void): void;
    onMessage(event: string, handler: (socket: SocketInfo, data: any) => void): void;
    use(middleware: SocketMiddleware): void;
    authenticate(socketId: string, token: string): Promise<boolean>;
    authorize(socketId: string, resource: string, action: string): Promise<boolean>;
    private parseUserFromToken;
    /**
     * 获取服务统计信息
     */
    getStats(): {
        connectedSockets: number;
        rooms: number;
        totalConnections: number;
        authenticatedSockets: number;
    };
    /**
     * 清理断开的连接
     */
    cleanup(): void;
    /**
     * 设置Socket.IO实例
     */
    setIOInstance(ioInstance: any): void;
}
/**
 * 认证中间件
 */
export declare function createAuthMiddleware(verifyToken: (token: string) => Promise<string | null>): SocketMiddleware;
/**
 * 速率限制中间件
 */
export declare function createRateLimitMiddleware(maxRequests: number, windowMs: number): SocketMiddleware;
//# sourceMappingURL=WebSocketService.d.ts.map