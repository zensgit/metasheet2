"use strict";
/**
 * 插件 RPC 机制使用示例
 * 展示如何在插件间使用 RPC 进行同步通信
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.UIClientPlugin = exports.CalculationPlugin = exports.DataServicePlugin = void 0;
exports.demonstrateRpc = demonstrateRpc;
exports.advancedExample = advancedExample;
const plugin_rpc_1 = require("./plugin-rpc");
const logger_1 = require("../utils/logger");
const logger = (0, logger_1.createLogger)('rpc-example');
// ============= 插件A: 数据服务插件 =============
class DataServicePlugin {
    pluginId = 'plugin-data-service';
    rpcServer;
    constructor() {
        this.rpcServer = plugin_rpc_1.RpcManager.getInstance().createServer(this.pluginId);
    }
    async initialize() {
        // 注册数据查询方法
        this.rpcServer.register({
            name: 'queryData',
            description: '查询数据',
            handler: this.queryData.bind(this),
            parameters: {
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
            parameters: {
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
        });
        // 注册批量操作方法
        this.rpcServer.register({
            name: 'batchOperation',
            description: '批量数据操作',
            handler: this.batchOperation.bind(this),
            parameters: {
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
        });
        logger.info(`${this.pluginId} initialized with RPC methods`);
    }
    async queryData(params) {
        logger.info('Querying data:', params);
        // 模拟数据查询
        const mockData = [];
        const limit = params.limit || 10;
        for (let i = 0; i < limit; i++) {
            mockData.push({
                id: `${params.table}-${i}`,
                name: `Record ${i}`,
                createdAt: new Date(),
                ...params.conditions
            });
        }
        return {
            data: mockData,
            total: mockData.length
        };
    }
    async saveData(params) {
        logger.info('Saving data:', params);
        // 模拟数据保存
        await new Promise(resolve => setTimeout(resolve, 100));
        return {
            id: `${params.table}-${Date.now()}`,
            success: true
        };
    }
    async batchOperation(params) {
        logger.info(`Processing ${params.operations.length} batch operations`);
        const results = [];
        for (const op of params.operations) {
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
    getMethods() {
        return this.rpcServer.getMethods();
    }
    destroy() {
        plugin_rpc_1.RpcManager.getInstance().destroyServer(this.pluginId);
    }
}
exports.DataServicePlugin = DataServicePlugin;
// ============= 插件B: 计算服务插件 =============
class CalculationPlugin {
    pluginId = 'plugin-calculation';
    rpcServer;
    constructor() {
        this.rpcServer = plugin_rpc_1.RpcManager.getInstance().createServer(this.pluginId);
    }
    async initialize() {
        // 注册计算方法
        this.rpcServer.register({
            name: 'calculate',
            description: '执行计算',
            handler: this.calculate.bind(this),
            parameters: {
                type: 'object',
                properties: {
                    expression: { type: 'string' },
                    variables: { type: 'object' }
                },
                required: ['expression']
            }
        });
        // 注册统计方法
        this.rpcServer.register({
            name: 'statistics',
            description: '计算统计数据',
            handler: this.statistics.bind(this),
            parameters: {
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
        });
        logger.info(`${this.pluginId} initialized`);
    }
    async calculate(params) {
        logger.info('Calculating:', params);
        // 简单的计算示例
        let result = 0;
        try {
            // 这里应该使用安全的表达式解析器
            // 示例中仅作演示
            if (params.expression === 'a + b') {
                result = (params.variables?.a || 0) + (params.variables?.b || 0);
            }
            else if (params.expression === 'a * b') {
                result = (params.variables?.a || 0) * (params.variables?.b || 0);
            }
        }
        catch (error) {
            throw new Error('Invalid expression');
        }
        return { result, expression: params.expression };
    }
    async statistics(params) {
        const results = {};
        for (const op of params.operations) {
            switch (op) {
                case 'sum':
                    results.sum = params.data.reduce((a, b) => a + b, 0);
                    break;
                case 'avg':
                    results.avg = params.data.reduce((a, b) => a + b, 0) / params.data.length;
                    break;
                case 'min':
                    results.min = Math.min(...params.data);
                    break;
                case 'max':
                    results.max = Math.max(...params.data);
                    break;
                case 'count':
                    results.count = params.data.length;
                    break;
                case 'stddev':
                    const avg = params.data.reduce((a, b) => a + b, 0) / params.data.length;
                    const variance = params.data.reduce((sum, val) => sum + Math.pow(val - avg, 2), 0) / params.data.length;
                    results.stddev = Math.sqrt(variance);
                    break;
            }
        }
        return results;
    }
    destroy() {
        plugin_rpc_1.RpcManager.getInstance().destroyServer(this.pluginId);
    }
}
exports.CalculationPlugin = CalculationPlugin;
// ============= 插件C: UI 客户端插件 =============
class UIClientPlugin {
    pluginId = 'plugin-ui-client';
    rpcClient;
    constructor() {
        this.rpcClient = plugin_rpc_1.RpcManager.getInstance().createClient(this.pluginId);
    }
    async initialize() {
        logger.info(`${this.pluginId} initialized`);
    }
    // 查询数据示例
    async fetchUserData(limit = 10) {
        try {
            const result = await this.rpcClient.call('plugin-data-service', 'queryData', {
                table: 'users',
                conditions: { active: true },
                limit
            });
            logger.info(`Fetched ${result.total} users`);
            return result;
        }
        catch (error) {
            logger.error('Failed to fetch user data:', error);
            throw error;
        }
    }
    // 保存数据示例
    async saveUserData(userData) {
        try {
            const result = await this.rpcClient.call('plugin-data-service', 'saveData', {
                table: 'users',
                data: userData
            });
            logger.info(`Saved user with ID: ${result.id}`);
            return result;
        }
        catch (error) {
            logger.error('Failed to save user data:', error);
            throw error;
        }
    }
    // 执行计算示例
    async performCalculation(a, b) {
        try {
            const result = await this.rpcClient.call('plugin-calculation', 'calculate', {
                expression: 'a + b',
                variables: { a, b }
            });
            logger.info(`Calculation result: ${result.result}`);
            return result;
        }
        catch (error) {
            logger.error('Calculation failed:', error);
            throw error;
        }
    }
    // 批量调用示例
    async performBatchOperations() {
        try {
            const results = await this.rpcClient.batch([
                {
                    targetPlugin: 'plugin-data-service',
                    method: 'queryData',
                    params: { table: 'users', limit: 5 }
                },
                {
                    targetPlugin: 'plugin-data-service',
                    method: 'queryData',
                    params: { table: 'products', limit: 10 }
                },
                {
                    targetPlugin: 'plugin-calculation',
                    method: 'statistics',
                    params: {
                        data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
                        operations: ['sum', 'avg', 'min', 'max']
                    }
                }
            ]);
            logger.info('Batch operations completed:', results);
            return results;
        }
        catch (error) {
            logger.error('Batch operations failed:', error);
            throw error;
        }
    }
    destroy() {
        plugin_rpc_1.RpcManager.getInstance().destroyClient(this.pluginId);
    }
}
exports.UIClientPlugin = UIClientPlugin;
// ============= 示例运行 =============
async function demonstrateRpc() {
    console.log('=== RPC Mechanism Demonstration ===\n');
    // 1. 初始化插件
    const dataService = new DataServicePlugin();
    const calculator = new CalculationPlugin();
    const uiClient = new UIClientPlugin();
    await dataService.initialize();
    await calculator.initialize();
    await uiClient.initialize();
    console.log('\n--- Plugins initialized ---');
    console.log('Available RPC methods:');
    const allMethods = plugin_rpc_1.RpcManager.getInstance().listAvailableMethods();
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
        const client = plugin_rpc_1.RpcManager.getInstance().createClient('error-test');
        await client.call('plugin-data-service', 'nonExistentMethod', {});
    }
    catch (error) {
        console.log('Expected error:', error.message);
    }
    // 5. 超时处理
    console.log('\n--- Timeout Handling ---');
    try {
        const client = plugin_rpc_1.RpcManager.getInstance().createClient('timeout-test');
        await client.call('plugin-data-service', 'queryData', { table: 'large_table' }, { timeout: 1 } // 1ms 超时
        );
    }
    catch (error) {
        console.log('Timeout error:', error.message);
    }
    // 6. 查看 RPC 指标
    console.log('\n--- RPC Metrics ---');
    const metrics = plugin_rpc_1.RpcManager.getInstance().getMetrics();
    console.log('System metrics:', metrics);
    // 获取单个服务器的指标
    const serverMetrics = dataService.rpcServer.getMetrics();
    console.log('Data service metrics:', serverMetrics);
    // 7. 清理
    console.log('\n--- Cleanup ---');
    dataService.destroy();
    calculator.destroy();
    uiClient.destroy();
    console.log('Demonstration completed!');
}
// 高级示例：插件协作
async function advancedExample() {
    console.log('\n=== Advanced RPC Example: Plugin Collaboration ===\n');
    // 创建一个复杂的工作流插件
    class WorkflowPlugin {
        pluginId = 'plugin-workflow';
        rpcClient;
        rpcServer;
        constructor() {
            this.rpcClient = plugin_rpc_1.RpcManager.getInstance().createClient(this.pluginId);
            this.rpcServer = plugin_rpc_1.RpcManager.getInstance().createServer(this.pluginId);
        }
        async initialize() {
            // 注册工作流执行方法
            this.rpcServer.register({
                name: 'executeWorkflow',
                description: '执行复杂工作流',
                handler: this.executeWorkflow.bind(this),
                parameters: {
                    type: 'object',
                    properties: {
                        workflowId: { type: 'string' },
                        data: { type: 'object' }
                    },
                    required: ['workflowId', 'data']
                }
            });
            logger.info(`${this.pluginId} initialized`);
        }
        async executeWorkflow(params) {
            logger.info(`Executing workflow: ${params.workflowId}`);
            const results = {
                workflowId: params.workflowId,
                steps: []
            };
            try {
                // Step 1: 查询相关数据
                const queryResult = await this.rpcClient.call('plugin-data-service', 'queryData', {
                    table: 'workflow_data',
                    conditions: { workflowId: params.workflowId }
                });
                results.steps.push({ step: 'query', success: true, data: queryResult });
                // Step 2: 执行计算
                const calcResult = await this.rpcClient.call('plugin-calculation', 'statistics', {
                    data: [1, 2, 3, 4, 5],
                    operations: ['sum', 'avg']
                });
                results.steps.push({ step: 'calculate', success: true, data: calcResult });
                // Step 3: 保存结果
                const saveResult = await this.rpcClient.call('plugin-data-service', 'saveData', {
                    table: 'workflow_results',
                    data: {
                        workflowId: params.workflowId,
                        result: calcResult,
                        timestamp: new Date()
                    }
                });
                results.steps.push({ step: 'save', success: true, data: saveResult });
                return {
                    success: true,
                    results
                };
            }
            catch (error) {
                logger.error('Workflow execution failed:', error);
                return {
                    success: false,
                    error: error.message,
                    results
                };
            }
        }
        destroy() {
            plugin_rpc_1.RpcManager.getInstance().destroyClient(this.pluginId);
            plugin_rpc_1.RpcManager.getInstance().destroyServer(this.pluginId);
        }
    }
    // 初始化所有插件
    const dataService = new DataServicePlugin();
    const calculator = new CalculationPlugin();
    const workflow = new WorkflowPlugin();
    await dataService.initialize();
    await calculator.initialize();
    await workflow.initialize();
    // 创建客户端调用工作流
    const client = plugin_rpc_1.RpcManager.getInstance().createClient('workflow-client');
    const workflowResult = await client.call('plugin-workflow', 'executeWorkflow', {
        workflowId: 'wf-001',
        data: { input: 'test' }
    });
    console.log('Workflow execution result:', JSON.stringify(workflowResult, null, 2));
    // 清理
    dataService.destroy();
    calculator.destroy();
    workflow.destroy();
    plugin_rpc_1.RpcManager.getInstance().destroyClient('workflow-client');
}
// 运行示例
if (require.main === module) {
    demonstrateRpc()
        .then(() => advancedExample())
        .catch(console.error);
}
//# sourceMappingURL=plugin-rpc.example.js.map