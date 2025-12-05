/**
 * 插件间 RPC (Remote Procedure Call) 机制
 * 任务ID: P1-021
 * 功能: 基于事件总线实现插件间的远程方法调用
 */

import type { EventBus } from '../integration/events/event-bus';
import type { Logger} from './logger';
import { createLogger } from './logger';

/**
 * RPC 调用请求
 */
export interface RpcRequest {
  id: string;
  method: string;
  params: unknown[];
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
  result?: unknown;
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
  data?: unknown;
}

/**
 * RPC 错误代码
 */
export enum RpcErrorCode {
  METHOD_NOT_FOUND = -32601,
  INVALID_PARAMS = -32602,
  INTERNAL_ERROR = -32603,
  TIMEOUT = -32000,
  PLUGIN_NOT_FOUND = -32001,
  UNAUTHORIZED = -32002,
  RATE_LIMITED = -32003,
}

/**
 * RPC 方法处理器
 */
export type RpcMethodHandler = (
  params: unknown[],
  metadata?: Record<string, unknown>
) => unknown | Promise<unknown>;

/**
 * RPC 方法定义
 */
export interface RpcMethodDefinition {
  name: string;
  handler: RpcMethodHandler;
  description?: string;
  schema?: {
    params?: Record<string, unknown>;
    returns?: Record<string, unknown>;
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
 * 事件数据接口
 */
interface EventData {
  data: unknown;
}

/**
 * 将未知类型转换为 Error 对象
 */
function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  if (typeof error === 'string') {
    return new Error(error);
  }
  return new Error('Unknown error');
}

/**
 * RPC 服务器 - 提供方法供其他插件调用
 */
export class RpcServer {
  private pluginId: string;
  private methods: Map<string, RpcMethodDefinition>;
  private eventBus: EventBus;
  private logger: Logger;
  private config: RpcServerConfig;
  private stats: Map<string, MethodStats>;
  private rateLimiters: Map<string, Map<string, number[]>>;
  private activeCalls: number = 0;

  constructor(
    pluginId: string,
    eventBus: EventBus,
    config?: RpcServerConfig
  ) {
    this.pluginId = pluginId;
    this.eventBus = eventBus;
    this.methods = new Map();
    this.stats = new Map();
    this.rateLimiters = new Map();
    this.logger = createLogger(`RpcServer:${pluginId}`);
    this.config = {
      enableLogging: true,
      enableMetrics: true,
      maxConcurrentCalls: 100,
      defaultTimeout: 30000,
      ...config
    };

    this.initialize();
  }

  /**
   * 初始化 RPC 服务器
   */
  private initialize(): void {
    // 订阅 RPC 请求事件
    this.eventBus.subscribe(
      `rpc:request:${this.pluginId}:*`,
      this.handleRpcRequest.bind(this),
      this.pluginId
    );

    if (this.config.enableLogging) {
      this.logger.info(`RPC Server initialized for plugin: ${this.pluginId}`);
    }
  }

  /**
   * 注册 RPC 方法
   */
  public register(definition: RpcMethodDefinition): void {
    const fullName = `${this.pluginId}.${definition.name}`;
    this.methods.set(definition.name, definition);

    // 初始化统计
    this.stats.set(definition.name, {
      calls: 0,
      successes: 0,
      failures: 0,
      totalDuration: 0
    });

    if (definition.rateLimit) {
      this.rateLimiters.set(definition.name, new Map());
    }

    if (this.config.enableLogging) {
      this.logger.debug(`Registered RPC method: ${fullName}`);
    }
  }

  /**
   * 批量注册方法
   */
  public registerAll(definitions: RpcMethodDefinition[]): void {
    definitions.forEach(def => this.register(def));
  }

  /**
   * 处理 RPC 请求
   */
  private async handleRpcRequest(event: EventData): Promise<void> {
    const request = event.data as RpcRequest;
    const startTime = Date.now();

    // 检查并发限制
    if (this.activeCalls >= this.config.maxConcurrentCalls!) {
      await this.sendError(request, {
        code: RpcErrorCode.RATE_LIMITED,
        message: 'Max concurrent calls exceeded'
      });
      return;
    }

    this.activeCalls++;

    try {
      // 提取方法名
      const methodName = request.method;
      const method = this.methods.get(methodName);

      if (!method) {
        await this.sendError(request, {
          code: RpcErrorCode.METHOD_NOT_FOUND,
          message: `Method not found: ${methodName}`
        });
        this.updateStats(methodName, false, Date.now() - startTime);
        return;
      }

      // 检查速率限制
      if (method.rateLimit) {
        const callerId = request.metadata?.callerId || 'unknown';
        if (!this.checkRateLimit(methodName, callerId, method.rateLimit)) {
          await this.sendError(request, {
            code: RpcErrorCode.RATE_LIMITED,
            message: 'Rate limit exceeded'
          });
          this.updateStats(methodName, false, Date.now() - startTime);
          return;
        }
      }

      // 设置超时
      const timeout = request.timeout || this.config.defaultTimeout!;
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('RPC timeout')), timeout);
      });

      // 执行方法
      const resultPromise = method.handler(request.params, request.metadata);

      // 等待结果或超时
      const result = await Promise.race([resultPromise, timeoutPromise]);

      // 发送响应
      const response: RpcResponse = {
        id: request.id,
        result,
        metadata: {
          responderId: this.pluginId,
          timestamp: new Date(),
          duration: Date.now() - startTime
        }
      };

      await this.eventBus.publish(
        `rpc:response:${request.id}`,
        response
      );

      this.updateStats(methodName, true, Date.now() - startTime);

      if (this.config.enableLogging) {
        this.logger.debug(`RPC call succeeded: ${methodName}`);
      }

    } catch (error: unknown) {
      // 发送错误响应
      const err = toError(error);

      await this.sendError(request, {
        code: RpcErrorCode.INTERNAL_ERROR,
        message: err.message,
        data: err.stack
      });

      const methodName = request.method;
      this.updateStats(methodName, false, Date.now() - startTime);

      if (this.config.enableLogging) {
        this.logger.error(`RPC call failed: ${methodName}`, err);
      }
    } finally {
      this.activeCalls--;
    }
  }

  /**
   * 发送错误响应
   */
  private async sendError(request: RpcRequest, error: RpcError): Promise<void> {
    const response: RpcResponse = {
      id: request.id,
      error,
      metadata: {
        responderId: this.pluginId,
        timestamp: new Date(),
        duration: 0
      }
    };

    await this.eventBus.publish(
      `rpc:response:${request.id}`,
      response
    );
  }

  /**
   * 检查速率限制
   */
  private checkRateLimit(
    method: string,
    callerId: string,
    limit: { maxCalls: number; windowMs: number }
  ): boolean {
    const now = Date.now();
    const limiter = this.rateLimiters.get(method)!;

    if (!limiter.has(callerId)) {
      limiter.set(callerId, []);
    }

    const calls = limiter.get(callerId)!;

    // 清理过期的调用记录
    const cutoff = now - limit.windowMs;
    const validCalls = calls.filter(time => time > cutoff);

    if (validCalls.length >= limit.maxCalls) {
      return false;
    }

    validCalls.push(now);
    limiter.set(callerId, validCalls);

    return true;
  }

  /**
   * 更新统计信息
   */
  private updateStats(method: string, success: boolean, duration: number): void {
    if (!this.config.enableMetrics) return;

    let stats = this.stats.get(method);
    if (!stats) {
      stats = {
        calls: 0,
        successes: 0,
        failures: 0,
        totalDuration: 0
      };
      this.stats.set(method, stats);
    }

    stats.calls++;
    if (success) {
      stats.successes++;
    } else {
      stats.failures++;
    }
    stats.totalDuration += duration;
    stats.lastCall = new Date();
  }

  /**
   * 获取方法列表
   */
  public getMethods(): string[] {
    return Array.from(this.methods.keys()).map(
      name => `${this.pluginId}.${name}`
    );
  }

  /**
   * 获取统计信息
   */
  public getStats(): Map<string, MethodStats> {
    return new Map(this.stats);
  }

  /**
   * 清理资源
   */
  public destroy(): void {
    this.eventBus.unsubscribeByPlugin(this.pluginId);
    this.methods.clear();
    this.stats.clear();
    this.rateLimiters.clear();

    if (this.config.enableLogging) {
      this.logger.info(`RPC Server destroyed for plugin: ${this.pluginId}`);
    }
  }
}

/**
 * 待处理的调用信息
 */
interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeout: NodeJS.Timeout;
}

/**
 * RPC 客户端 - 调用其他插件提供的方法
 */
export class RpcClient {
  private pluginId: string;
  private eventBus: EventBus;
  private logger: Logger;
  private config: RpcClientConfig;
  private pendingCalls: Map<string, PendingCall>;

  constructor(
    pluginId: string,
    eventBus: EventBus,
    config?: RpcClientConfig
  ) {
    this.pluginId = pluginId;
    this.eventBus = eventBus;
    this.pendingCalls = new Map();
    this.logger = createLogger(`RpcClient:${pluginId}`);
    this.config = {
      timeout: 30000,
      retries: 3,
      retryDelay: 1000,
      ...config
    };
  }

  /**
   * 调用远程方法
   */
  public async call<T = unknown>(
    targetPlugin: string,
    method: string,
    params: unknown[] = [],
    options?: {
      timeout?: number;
      retries?: number;
    }
  ): Promise<T> {
    const actualOptions = {
      timeout: this.config.timeout,
      retries: this.config.retries,
      ...options
    };

    let lastError: unknown;

    for (let attempt = 0; attempt <= actualOptions.retries!; attempt++) {
      try {
        const result = await this.doCall<T>(
          targetPlugin,
          method,
          params,
          actualOptions.timeout!
        );
        return result;
      } catch (error) {
        lastError = error;

        if (attempt < actualOptions.retries!) {
          // 等待后重试
          await new Promise(resolve =>
            setTimeout(resolve, this.config.retryDelay! * (attempt + 1))
          );
          this.logger.warn(
            `RPC call failed, retrying... (${attempt + 1}/${actualOptions.retries})`,
            { targetPlugin, method, error }
          );
        }
      }
    }

    throw lastError;
  }

  /**
   * 执行单次调用
   */
  private async doCall<T>(
    targetPlugin: string,
    method: string,
    params: unknown[],
    timeout: number
  ): Promise<T> {
    const requestId = this.generateId();

    const request: RpcRequest = {
      id: requestId,
      method,
      params,
      timeout,
      metadata: {
        callerId: this.pluginId,
        timestamp: new Date()
      }
    };

    return new Promise<T>((resolve, reject) => {
      // 设置超时
      const timeoutHandle = setTimeout(() => {
        this.pendingCalls.delete(requestId);
        reject(new Error(`RPC call timeout: ${targetPlugin}.${method}`));
      }, timeout);

      // 保存待处理调用
      this.pendingCalls.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout: timeoutHandle
      });

      // 订阅响应事件
      const listenerId = this.eventBus.subscribe(
        `rpc:response:${requestId}`,
        (event: EventData) => {
          const response = event.data as RpcResponse;
          const pending = this.pendingCalls.get(requestId);

          if (pending) {
            clearTimeout(pending.timeout);
            this.pendingCalls.delete(requestId);
            this.eventBus.unsubscribe(listenerId);

            if (response.error) {
              reject(new Error(response.error.message));
            } else {
              resolve(response.result as T);
            }
          }
        },
        this.pluginId
      );

      // 发送请求
      try {
        this.eventBus.publish(
          `rpc:request:${targetPlugin}:${method}`,
          request
        );
      } catch (error) {
        clearTimeout(timeoutHandle);
        this.pendingCalls.delete(requestId);
        this.eventBus.unsubscribe(listenerId);
        reject(error);
      }
    });
  }

  /**
   * 批量调用
   */
  public async callBatch<T = unknown>(
    calls: Array<{
      plugin: string;
      method: string;
      params?: unknown[];
    }>
  ): Promise<T[]> {
    return Promise.all(
      calls.map(call =>
        this.call<T>(call.plugin, call.method, call.params || [])
      )
    );
  }

  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return `${this.pluginId}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * 清理资源
   */
  public destroy(): void {
    // 取消所有待处理调用
    for (const [_id, pending] of this.pendingCalls) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('RPC client destroyed'));
    }
    this.pendingCalls.clear();

    this.logger.info(`RPC Client destroyed for plugin: ${this.pluginId}`);
  }
}

/**
 * RPC 管理器 - 简化 RPC 使用
 */
export class RpcManager {
  private static instance: RpcManager;
  private eventBus: EventBus;
  private servers: Map<string, RpcServer>;
  private clients: Map<string, RpcClient>;
  private logger: Logger;

  private constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
    this.servers = new Map();
    this.clients = new Map();
    this.logger = createLogger('RpcManager');
  }

  /**
   * 获取单例实例
   */
  public static getInstance(eventBus: EventBus): RpcManager {
    if (!RpcManager.instance) {
      RpcManager.instance = new RpcManager(eventBus);
    }
    return RpcManager.instance;
  }

  /**
   * 创建 RPC 服务器
   */
  public createServer(
    pluginId: string,
    config?: RpcServerConfig
  ): RpcServer {
    if (this.servers.has(pluginId)) {
      throw new Error(`RPC server already exists for plugin: ${pluginId}`);
    }

    const server = new RpcServer(pluginId, this.eventBus, config);
    this.servers.set(pluginId, server);

    this.logger.info(`Created RPC server for plugin: ${pluginId}`);
    return server;
  }

  /**
   * 创建 RPC 客户端
   */
  public createClient(
    pluginId: string,
    config?: RpcClientConfig
  ): RpcClient {
    if (this.clients.has(pluginId)) {
      return this.clients.get(pluginId)!;
    }

    const client = new RpcClient(pluginId, this.eventBus, config);
    this.clients.set(pluginId, client);

    this.logger.info(`Created RPC client for plugin: ${pluginId}`);
    return client;
  }

  /**
   * 获取所有可用的 RPC 方法
   */
  public getAvailableMethods(): string[] {
    const methods: string[] = [];
    for (const server of this.servers.values()) {
      methods.push(...server.getMethods());
    }
    return methods;
  }

  /**
   * 清理资源
   */
  public destroy(): void {
    for (const server of this.servers.values()) {
      server.destroy();
    }
    for (const client of this.clients.values()) {
      client.destroy();
    }

    this.servers.clear();
    this.clients.clear();

    this.logger.info('RPC Manager destroyed');
  }
}

// 导出默认管理器
export default RpcManager;
