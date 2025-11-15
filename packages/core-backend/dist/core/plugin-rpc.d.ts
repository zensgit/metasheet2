/**
 * 插件间 RPC (Remote Procedure Call) 机制
 * 任务ID: P1-021
 * 功能: 基于事件总线实现插件间的远程方法调用
 */
import { EventBus } from '../integration/events/event-bus';
/**
 * RPC 调用请求
 */
export interface RpcRequest {
    id: string;
    method: string;
    params: any[];
    timeout?: number;
    metadata?: {
        callerId: string;
        timestamp: Date;
        correlationId?: string;
    };
}
/**
 * RPC 调用响应
 */
export interface RpcResponse {
    id: string;
    result?: any;
    error?: RpcError;
    metadata?: {
        responderId: string;
        timestamp: Date;
        duration: number;
    };
}
/**
 * RPC 错误
 */
export interface RpcError {
    code: number;
    message: string;
    data?: any;
}
/**
 * RPC 错误代码
 */
export declare enum RpcErrorCode {
    METHOD_NOT_FOUND = -32601,
    INVALID_PARAMS = -32602,
    INTERNAL_ERROR = -32603,
    TIMEOUT = -32000,
    PLUGIN_NOT_FOUND = -32001,
    UNAUTHORIZED = -32002,
    RATE_LIMITED = -32003
}
/**
 * RPC 方法处理器
 */
export type RpcMethodHandler = (params: any[], metadata?: any) => any | Promise<any>;
/**
 * RPC 方法定义
 */
export interface RpcMethodDefinition {
    name: string;
    handler: RpcMethodHandler;
    description?: string;
    schema?: {
        params?: any;
        returns?: any;
    };
    rateLimit?: {
        maxCalls: number;
        windowMs: number;
    };
}
/**
 * RPC 客户端配置
 */
export interface RpcClientConfig {
    timeout?: number;
    retries?: number;
    retryDelay?: number;
}
/**
 * RPC 服务器配置
 */
export interface RpcServerConfig {
    enableLogging?: boolean;
    enableMetrics?: boolean;
    maxConcurrentCalls?: number;
    defaultTimeout?: number;
}
/**
 * 方法调用统计
 */
interface MethodStats {
    calls: number;
    successes: number;
    failures: number;
    totalDuration: number;
    lastCall?: Date;
}
/**
 * RPC 服务器 - 提供方法供其他插件调用
 */
export declare class RpcServer {
    private pluginId;
    private methods;
    private eventBus;
    private logger;
    private config;
    private stats;
    private rateLimiters;
    private activeCalls;
    constructor(pluginId: string, eventBus: EventBus, config?: RpcServerConfig);
    /**
     * 初始化 RPC 服务器
     */
    private initialize;
    /**
     * 注册 RPC 方法
     */
    register(definition: RpcMethodDefinition): void;
    /**
     * 批量注册方法
     */
    registerAll(definitions: RpcMethodDefinition[]): void;
    /**
     * 处理 RPC 请求
     */
    private handleRpcRequest;
    /**
     * 发送错误响应
     */
    private sendError;
    /**
     * 检查速率限制
     */
    private checkRateLimit;
    /**
     * 更新统计信息
     */
    private updateStats;
    /**
     * 获取方法列表
     */
    getMethods(): string[];
    /**
     * 获取统计信息
     */
    getStats(): Map<string, MethodStats>;
    /**
     * 清理资源
     */
    destroy(): void;
}
/**
 * RPC 客户端 - 调用其他插件提供的方法
 */
export declare class RpcClient {
    private pluginId;
    private eventBus;
    private logger;
    private config;
    private pendingCalls;
    constructor(pluginId: string, eventBus: EventBus, config?: RpcClientConfig);
    /**
     * 调用远程方法
     */
    call<T = any>(targetPlugin: string, method: string, params?: any[], options?: {
        timeout?: number;
        retries?: number;
    }): Promise<T>;
    /**
     * 执行单次调用
     */
    private doCall;
    /**
     * 批量调用
     */
    callBatch<T = any>(calls: Array<{
        plugin: string;
        method: string;
        params?: any[];
    }>): Promise<T[]>;
    /**
     * 生成唯一ID
     */
    private generateId;
    /**
     * 清理资源
     */
    destroy(): void;
}
/**
 * RPC 管理器 - 简化 RPC 使用
 */
export declare class RpcManager {
    private static instance;
    private eventBus;
    private servers;
    private clients;
    private logger;
    private constructor();
    /**
     * 获取单例实例
     */
    static getInstance(eventBus: EventBus): RpcManager;
    /**
     * 创建 RPC 服务器
     */
    createServer(pluginId: string, config?: RpcServerConfig): RpcServer;
    /**
     * 创建 RPC 客户端
     */
    createClient(pluginId: string, config?: RpcClientConfig): RpcClient;
    /**
     * 获取所有可用的 RPC 方法
     */
    getAvailableMethods(): string[];
    /**
     * 清理资源
     */
    destroy(): void;
}
export default RpcManager;
//# sourceMappingURL=plugin-rpc.d.ts.map