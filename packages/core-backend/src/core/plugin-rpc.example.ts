/* eslint-disable @typescript-eslint/no-unused-vars */
/**
 * 插件 RPC 机制使用示例
 * 展示如何在插件间使用 RPC 进行同步通信
 *
 * NOTE: This is a demonstration file showing API usage patterns.
 * It uses mock implementations that match the actual RpcServer/RpcClient API.
 */

import type { RpcMethodDefinition, RpcServerConfig, RpcClientConfig } from './plugin-rpc';
import { createLogger } from './logger';

const logger = createLogger('rpc-example');

// ============= Mock EventBus for standalone example =============
interface MockEventBus {
  subscribe: (topic: string, handler: (event: { data: unknown }) => void, pluginId: string) => string;
  unsubscribe: (listenerId: string) => void;
  unsubscribeByPlugin: (pluginId: string) => void;
  publish: (topic: string, data: unknown) => Promise<void>;
}

const mockEventBus: MockEventBus = {
  subscribe: (_topic: string, _handler: (event: { data: unknown }) => void, _pluginId: string) => 'listener-id',
  unsubscribe: (_listenerId: string) => {},
  unsubscribeByPlugin: (_pluginId: string) => {},
  publish: async (_topic: string, _data: unknown) => {}
};

// ============= Mock RpcServer Implementation =============
interface MockMethodStats {
  calls: number;
  successes: number;
  failures: number;
  totalDuration: number;
  lastCall?: Date;
}

class MockRpcServer {
  private pluginId: string;
  private methods: Map<string, RpcMethodDefinition> = new Map();
  private stats: Map<string, MockMethodStats> = new Map();
  private config: RpcServerConfig;

  constructor(pluginId: string, _eventBus: MockEventBus, config?: RpcServerConfig) {
    this.pluginId = pluginId;
    this.config = {
      enableLogging: true,
      enableMetrics: true,
      maxConcurrentCalls: 100,
      defaultTimeout: 30000,
      ...config
    };
  }

  register(definition: RpcMethodDefinition): void {
    this.methods.set(definition.name, definition);
    this.stats.set(definition.name, {
      calls: 0,
      successes: 0,
      failures: 0,
      totalDuration: 0
    });
    if (this.config.enableLogging) {
      logger.debug(`Registered RPC method: ${this.pluginId}.${definition.name}`);
    }
  }

  getMethods(): string[] {
    return Array.from(this.methods.keys()).map(name => `${this.pluginId}.${name}`);
  }

  getStats(): Map<string, MockMethodStats> {
    return new Map(this.stats);
  }

  // For testing: invoke a method directly
  async invokeMethod(methodName: string, params: unknown[]): Promise<unknown> {
    const method = this.methods.get(methodName);
    if (!method) {
      throw new Error(`Method not found: ${methodName}`);
    }
    return method.handler(params, { callerId: 'test' });
  }

  destroy(): void {
    this.methods.clear();
    this.stats.clear();
    logger.info(`Mock RPC Server destroyed for plugin: ${this.pluginId}`);
  }
}

// ============= Mock RpcClient Implementation =============
interface BatchCall {
  plugin: string;
  method: string;
  params?: unknown[];
}

class MockRpcClient {
  private pluginId: string;
  private config: RpcClientConfig;
  // Reference to servers for mock calls
  private serverRegistry: Map<string, MockRpcServer>;

  constructor(
    pluginId: string,
    _eventBus: MockEventBus,
    config?: RpcClientConfig,
    serverRegistry?: Map<string, MockRpcServer>
  ) {
    this.pluginId = pluginId;
    this.config = {
      timeout: 30000,
      retries: 3,
      retryDelay: 1000,
      ...config
    };
    this.serverRegistry = serverRegistry || new Map();
  }

  async call<T = unknown>(
    targetPlugin: string,
    method: string,
    params: unknown[] = [],
    _options?: { timeout?: number; retries?: number }
  ): Promise<T> {
    const server = this.serverRegistry.get(targetPlugin);
    if (!server) {
      throw new Error(`Plugin not found: ${targetPlugin}`);
    }
    const result = await server.invokeMethod(method, params);
    return result as T;
  }

  async callBatch<T = unknown>(calls: BatchCall[]): Promise<T[]> {
    return Promise.all(
      calls.map(call => this.call<T>(call.plugin, call.method, call.params || []))
    );
  }

  destroy(): void {
    logger.info(`Mock RPC Client destroyed for plugin: ${this.pluginId}`);
  }
}

// ============= Mock RpcManager Implementation =============
class MockRpcManager {
  private static instance: MockRpcManager | null = null;
  private eventBus: MockEventBus;
  private servers: Map<string, MockRpcServer> = new Map();
  private clients: Map<string, MockRpcClient> = new Map();

  private constructor(eventBus: MockEventBus) {
    this.eventBus = eventBus;
  }

  static getInstance(eventBus: MockEventBus): MockRpcManager {
    if (!MockRpcManager.instance) {
      MockRpcManager.instance = new MockRpcManager(eventBus);
    }
    return MockRpcManager.instance;
  }

  static resetInstance(): void {
    MockRpcManager.instance = null;
  }

  createServer(pluginId: string, config?: RpcServerConfig): MockRpcServer {
    if (this.servers.has(pluginId)) {
      throw new Error(`RPC server already exists for plugin: ${pluginId}`);
    }
    const server = new MockRpcServer(pluginId, this.eventBus, config);
    this.servers.set(pluginId, server);
    logger.info(`Created RPC server for plugin: ${pluginId}`);
    return server;
  }

  createClient(pluginId: string, config?: RpcClientConfig): MockRpcClient {
    if (this.clients.has(pluginId)) {
      return this.clients.get(pluginId)!;
    }
    const client = new MockRpcClient(pluginId, this.eventBus, config, this.servers);
    this.clients.set(pluginId, client);
    logger.info(`Created RPC client for plugin: ${pluginId}`);
    return client;
  }

  destroyServer(pluginId: string): void {
    const server = this.servers.get(pluginId);
    if (server) {
      server.destroy();
      this.servers.delete(pluginId);
    }
  }

  destroyClient(pluginId: string): void {
    const client = this.clients.get(pluginId);
    if (client) {
      client.destroy();
      this.clients.delete(pluginId);
    }
  }

  listAvailableMethods(): Array<{ plugin: string; method: string; description: string }> {
    const methods: Array<{ plugin: string; method: string; description: string }> = [];
    for (const [pluginId, server] of this.servers) {
      const serverMethods = server.getMethods();
      serverMethods.forEach(fullName => {
        const methodName = fullName.replace(`${pluginId}.`, '');
        methods.push({
          plugin: pluginId,
          method: methodName,
          description: `Method ${methodName} from ${pluginId}`
        });
      });
    }
    return methods;
  }

  getMetrics(): Record<string, unknown> {
    const metrics: Record<string, unknown> = {};
    for (const [pluginId, server] of this.servers) {
      metrics[pluginId] = Object.fromEntries(server.getStats());
    }
    return metrics;
  }

  destroy(): void {
    for (const server of this.servers.values()) {
      server.destroy();
    }
    for (const client of this.clients.values()) {
      client.destroy();
    }
    this.servers.clear();
    this.clients.clear();
    logger.info('RPC Manager destroyed');
  }
}

// ============= 插件A: 数据服务插件 =============
class DataServicePlugin {
  private pluginId = 'plugin-data-service';
  private rpcServer: MockRpcServer;

  constructor(rpcManager: MockRpcManager) {
    this.rpcServer = rpcManager.createServer(this.pluginId);
  }

  async initialize(): Promise<void> {
    // 注册数据查询方法
    this.rpcServer.register({
      name: 'queryData',
      description: '查询数据',
      handler: this.queryData.bind(this),
      schema: {
        params: {
          type: 'object',
          properties: {
            table: { type: 'string', description: '表名' },
            conditions: { type: 'object', description: '查询条件' },
            limit: { type: 'number', description: '限制数量' }
          },
          required: ['table']
        },
        returns: {
          type: 'object',
          properties: {
            data: { type: 'array' },
            total: { type: 'number' }
          }
        }
      },
      rateLimit: {
        maxCalls: 100,
        windowMs: 60000 // 每分钟最多100次
      }
    });

    // 注册数据保存方法
    this.rpcServer.register({
      name: 'saveData',
      description: '保存数据',
      handler: this.saveData.bind(this),
      schema: {
        params: {
          type: 'object',
          properties: {
            table: { type: 'string' },
            data: { type: 'object' }
          },
          required: ['table', 'data']
        },
        returns: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            success: { type: 'boolean' }
          }
        }
      }
    });

    // 注册批量操作方法
    this.rpcServer.register({
      name: 'batchOperation',
      description: '批量数据操作',
      handler: this.batchOperation.bind(this),
      schema: {
        params: {
          type: 'object',
          properties: {
            operations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['create', 'update', 'delete'] },
                  table: { type: 'string' },
                  data: { type: 'object' }
                }
              }
            }
          },
          required: ['operations']
        }
      }
    });

    logger.info(`${this.pluginId} initialized with RPC methods`);
  }

  private async queryData(params: unknown[]): Promise<{ data: unknown[]; total: number }> {
    const [queryParams] = params as [{ table: string; conditions?: Record<string, unknown>; limit?: number }];
    logger.info('Querying data:', queryParams);

    // 模拟数据查询
    const mockData: Array<Record<string, unknown>> = [];
    const limit = queryParams.limit || 10;

    for (let i = 0; i < limit; i++) {
      mockData.push({
        id: `${queryParams.table}-${i}`,
        name: `Record ${i}`,
        createdAt: new Date(),
        ...queryParams.conditions
      });
    }

    return {
      data: mockData,
      total: mockData.length
    };
  }

  private async saveData(params: unknown[]): Promise<{ id: string; success: boolean }> {
    const [saveParams] = params as [{ table: string; data: Record<string, unknown> }];
    logger.info('Saving data:', saveParams);

    // 模拟数据保存
    await new Promise(resolve => setTimeout(resolve, 100));

    return {
      id: `${saveParams.table}-${Date.now()}`,
      success: true
    };
  }

  private async batchOperation(
    params: unknown[]
  ): Promise<{ results: unknown[]; totalProcessed: number }> {
    const [batchParams] = params as [{ operations: Array<{ type: string; table: string; data?: unknown }> }];
    logger.info(`Processing ${batchParams.operations.length} batch operations`);

    const results: Array<{ operation: string; table: string; success: boolean; id: string }> = [];
    for (const op of batchParams.operations) {
      // 模拟操作处理
      await new Promise(resolve => setTimeout(resolve, 50));

      results.push({
        operation: op.type,
        table: op.table,
        success: true,
        id: `${op.table}-${Date.now()}`
      });
    }

    return { results, totalProcessed: results.length };
  }

  getMethods(): string[] {
    return this.rpcServer.getMethods();
  }

  getServer(): MockRpcServer {
    return this.rpcServer;
  }

  destroy(rpcManager: MockRpcManager): void {
    rpcManager.destroyServer(this.pluginId);
  }
}

// ============= 插件B: 计算服务插件 =============
class CalculationPlugin {
  private pluginId = 'plugin-calculation';
  private rpcServer: MockRpcServer;

  constructor(rpcManager: MockRpcManager) {
    this.rpcServer = rpcManager.createServer(this.pluginId);
  }

  async initialize(): Promise<void> {
    // 注册计算方法
    this.rpcServer.register({
      name: 'calculate',
      description: '执行计算',
      handler: this.calculate.bind(this),
      schema: {
        params: {
          type: 'object',
          properties: {
            expression: { type: 'string' },
            variables: { type: 'object' }
          },
          required: ['expression']
        }
      }
    });

    // 注册统计方法
    this.rpcServer.register({
      name: 'statistics',
      description: '计算统计数据',
      handler: this.statistics.bind(this),
      schema: {
        params: {
          type: 'object',
          properties: {
            data: { type: 'array', items: { type: 'number' } },
            operations: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['sum', 'avg', 'min', 'max', 'count', 'stddev']
              }
            }
          },
          required: ['data', 'operations']
        }
      }
    });

    logger.info(`${this.pluginId} initialized`);
  }

  private async calculate(
    params: unknown[]
  ): Promise<{ result: number; expression: string }> {
    const [calcParams] = params as [{ expression: string; variables?: Record<string, number> }];
    logger.info('Calculating:', calcParams);

    // 简单的计算示例
    let result = 0;

    try {
      // 这里应该使用安全的表达式解析器
      // 示例中仅作演示
      if (calcParams.expression === 'a + b') {
        result = (calcParams.variables?.a || 0) + (calcParams.variables?.b || 0);
      } else if (calcParams.expression === 'a * b') {
        result = (calcParams.variables?.a || 0) * (calcParams.variables?.b || 0);
      }
    } catch {
      throw new Error('Invalid expression');
    }

    return { result, expression: calcParams.expression };
  }

  private async statistics(params: unknown[]): Promise<Record<string, number>> {
    const [statsParams] = params as [{ data: number[]; operations: string[] }];
    const results: Record<string, number> = {};

    for (const op of statsParams.operations) {
      switch (op) {
        case 'sum':
          results.sum = statsParams.data.reduce((a, b) => a + b, 0);
          break;
        case 'avg':
          results.avg = statsParams.data.reduce((a, b) => a + b, 0) / statsParams.data.length;
          break;
        case 'min':
          results.min = Math.min(...statsParams.data);
          break;
        case 'max':
          results.max = Math.max(...statsParams.data);
          break;
        case 'count':
          results.count = statsParams.data.length;
          break;
        case 'stddev': {
          const avg = statsParams.data.reduce((a, b) => a + b, 0) / statsParams.data.length;
          const variance = statsParams.data.reduce((sum, val) =>
            sum + Math.pow(val - avg, 2), 0) / statsParams.data.length;
          results.stddev = Math.sqrt(variance);
          break;
        }
      }
    }

    return results;
  }

  destroy(rpcManager: MockRpcManager): void {
    rpcManager.destroyServer(this.pluginId);
  }
}

// ============= 插件C: UI 客户端插件 =============
class UIClientPlugin {
  private pluginId = 'plugin-ui-client';
  private rpcClient: MockRpcClient;

  constructor(rpcManager: MockRpcManager) {
    this.rpcClient = rpcManager.createClient(this.pluginId);
  }

  async initialize(): Promise<void> {
    logger.info(`${this.pluginId} initialized`);
  }

  // 查询数据示例
  async fetchUserData(limit: number = 10): Promise<{ data: unknown[]; total: number }> {
    try {
      const result = await this.rpcClient.call<{ data: unknown[]; total: number }>(
        'plugin-data-service',
        'queryData',
        [{
          table: 'users',
          conditions: { active: true },
          limit
        }]
      );

      logger.info(`Fetched ${result.total} users`);
      return result;
    } catch (error) {
      logger.error('Failed to fetch user data:', error as Error);
      throw error;
    }
  }

  // 保存数据示例
  async saveUserData(userData: Record<string, unknown>): Promise<{ id: string; success: boolean }> {
    try {
      const result = await this.rpcClient.call<{ id: string; success: boolean }>(
        'plugin-data-service',
        'saveData',
        [{
          table: 'users',
          data: userData
        }]
      );

      logger.info(`Saved user with ID: ${result.id}`);
      return result;
    } catch (error) {
      logger.error('Failed to save user data:', error as Error);
      throw error;
    }
  }

  // 执行计算示例
  async performCalculation(a: number, b: number): Promise<{ result: number }> {
    try {
      const result = await this.rpcClient.call<{ result: number }>(
        'plugin-calculation',
        'calculate',
        [{
          expression: 'a + b',
          variables: { a, b }
        }]
      );

      logger.info(`Calculation result: ${result.result}`);
      return result;
    } catch (error) {
      logger.error('Calculation failed:', error as Error);
      throw error;
    }
  }

  // 批量调用示例
  async performBatchOperations(): Promise<unknown[]> {
    try {
      const results = await this.rpcClient.callBatch([
        {
          plugin: 'plugin-data-service',
          method: 'queryData',
          params: [{ table: 'users', limit: 5 }]
        },
        {
          plugin: 'plugin-data-service',
          method: 'queryData',
          params: [{ table: 'products', limit: 10 }]
        },
        {
          plugin: 'plugin-calculation',
          method: 'statistics',
          params: [{
            data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
            operations: ['sum', 'avg', 'min', 'max']
          }]
        }
      ]);

      logger.info('Batch operations completed', { results });
      return results;
    } catch (error) {
      logger.error('Batch operations failed:', error as Error);
      throw error;
    }
  }

  destroy(rpcManager: MockRpcManager): void {
    rpcManager.destroyClient(this.pluginId);
  }
}

// ============= 示例运行 =============
async function demonstrateRpc(): Promise<void> {
  console.log('=== RPC Mechanism Demonstration ===\n');

  // Reset singleton for clean test
  MockRpcManager.resetInstance();
  const rpcManager = MockRpcManager.getInstance(mockEventBus);

  // 1. 初始化插件
  const dataService = new DataServicePlugin(rpcManager);
  const calculator = new CalculationPlugin(rpcManager);
  const uiClient = new UIClientPlugin(rpcManager);

  await dataService.initialize();
  await calculator.initialize();
  await uiClient.initialize();

  console.log('\n--- Plugins initialized ---');
  console.log('Available RPC methods:');
  const allMethods = rpcManager.listAvailableMethods();
  allMethods.forEach(m => {
    console.log(`  - ${m.plugin}.${m.method}: ${m.description}`);
  });

  // 2. 执行单个 RPC 调用
  console.log('\n--- Single RPC Calls ---');

  // 查询数据
  const userData = await uiClient.fetchUserData(3);
  console.log('User data:', userData);

  // 保存数据
  const saveResult = await uiClient.saveUserData({
    name: 'John Doe',
    email: 'john@example.com'
  });
  console.log('Save result:', saveResult);

  // 执行计算
  const calcResult = await uiClient.performCalculation(10, 25);
  console.log('Calculation result:', calcResult);

  // 3. 批量 RPC 调用
  console.log('\n--- Batch RPC Calls ---');
  const batchResults = await uiClient.performBatchOperations();
  console.log('Batch results:', JSON.stringify(batchResults, null, 2));

  // 4. 错误处理示例
  console.log('\n--- Error Handling ---');

  try {
    // 调用不存在的方法
    const client = rpcManager.createClient('error-test');
    await client.call('plugin-data-service', 'nonExistentMethod', [{}]);
  } catch (error) {
    console.log('Expected error:', (error as Error).message);
  }

  // 5. 查看 RPC 指标
  console.log('\n--- RPC Metrics ---');
  const metrics = rpcManager.getMetrics();
  console.log('System metrics:', metrics);

  // 获取单个服务器的指标
  const serverMetrics = dataService.getServer().getStats();
  console.log('Data service metrics:', Object.fromEntries(serverMetrics));

  // 6. 清理
  console.log('\n--- Cleanup ---');
  dataService.destroy(rpcManager);
  calculator.destroy(rpcManager);
  uiClient.destroy(rpcManager);

  console.log('Demonstration completed!');
}

// 高级示例：插件协作
async function advancedExample(): Promise<void> {
  console.log('\n=== Advanced RPC Example: Plugin Collaboration ===\n');

  // Reset singleton for clean test
  MockRpcManager.resetInstance();
  const rpcManager = MockRpcManager.getInstance(mockEventBus);

  // 创建一个复杂的工作流插件
  class WorkflowPlugin {
    private pluginId = 'plugin-workflow';
    private rpcClient: MockRpcClient;
    private rpcServer: MockRpcServer;

    constructor(mgr: MockRpcManager) {
      this.rpcClient = mgr.createClient(this.pluginId);
      this.rpcServer = mgr.createServer(this.pluginId);
    }

    async initialize(): Promise<void> {
      // 注册工作流执行方法
      this.rpcServer.register({
        name: 'executeWorkflow',
        description: '执行复杂工作流',
        handler: this.executeWorkflow.bind(this),
        schema: {
          params: {
            type: 'object',
            properties: {
              workflowId: { type: 'string' },
              data: { type: 'object' }
            },
            required: ['workflowId', 'data']
          }
        }
      });

      logger.info(`${this.pluginId} initialized`);
    }

    private async executeWorkflow(
      params: unknown[]
    ): Promise<{ success: boolean; results: unknown; error?: string }> {
      const [wfParams] = params as [{ workflowId: string; data: unknown }];
      logger.info(`Executing workflow: ${wfParams.workflowId}`);

      interface WorkflowResults {
        workflowId: string;
        steps: Array<{ step: string; success: boolean; data: unknown }>;
      }

      const results: WorkflowResults = {
        workflowId: wfParams.workflowId,
        steps: []
      };

      try {
        // Step 1: 查询相关数据
        const queryResult = await this.rpcClient.call(
          'plugin-data-service',
          'queryData',
          [{
            table: 'workflow_data',
            conditions: { workflowId: wfParams.workflowId }
          }]
        );
        results.steps.push({ step: 'query', success: true, data: queryResult });

        // Step 2: 执行计算
        const calcResult = await this.rpcClient.call(
          'plugin-calculation',
          'statistics',
          [{
            data: [1, 2, 3, 4, 5],
            operations: ['sum', 'avg']
          }]
        );
        results.steps.push({ step: 'calculate', success: true, data: calcResult });

        // Step 3: 保存结果
        const saveResult = await this.rpcClient.call(
          'plugin-data-service',
          'saveData',
          [{
            table: 'workflow_results',
            data: {
              workflowId: wfParams.workflowId,
              result: calcResult,
              timestamp: new Date()
            }
          }]
        );
        results.steps.push({ step: 'save', success: true, data: saveResult });

        return {
          success: true,
          results
        };
      } catch (error) {
        logger.error('Workflow execution failed:', error as Error);
        return {
          success: false,
          error: (error as Error).message,
          results
        };
      }
    }

    destroy(mgr: MockRpcManager): void {
      mgr.destroyClient(this.pluginId);
      mgr.destroyServer(this.pluginId);
    }
  }

  // 初始化所有插件
  const dataService = new DataServicePlugin(rpcManager);
  const calculator = new CalculationPlugin(rpcManager);
  const workflow = new WorkflowPlugin(rpcManager);

  await dataService.initialize();
  await calculator.initialize();
  await workflow.initialize();

  // 创建客户端调用工作流
  const client = rpcManager.createClient('workflow-client');

  const workflowResult = await client.call(
    'plugin-workflow',
    'executeWorkflow',
    [{
      workflowId: 'wf-001',
      data: { input: 'test' }
    }]
  );

  console.log('Workflow execution result:', JSON.stringify(workflowResult, null, 2));

  // 清理
  dataService.destroy(rpcManager);
  calculator.destroy(rpcManager);
  workflow.destroy(rpcManager);
  rpcManager.destroyClient('workflow-client');
}

// 运行示例
if (require.main === module) {
  demonstrateRpc()
    .then(() => advancedExample())
    .catch(console.error);
}

export {
  DataServicePlugin,
  CalculationPlugin,
  UIClientPlugin,
  MockRpcManager,
  MockRpcServer,
  MockRpcClient,
  demonstrateRpc,
  advancedExample
};
