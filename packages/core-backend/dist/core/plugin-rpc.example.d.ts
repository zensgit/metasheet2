/**
 * 插件 RPC 机制使用示例
 * 展示如何在插件间使用 RPC 进行同步通信
 */
declare class DataServicePlugin {
    private pluginId;
    private rpcServer;
    constructor();
    initialize(): Promise<void>;
    private queryData;
    private saveData;
    private batchOperation;
    getMethods(): string[];
    destroy(): void;
}
declare class CalculationPlugin {
    private pluginId;
    private rpcServer;
    constructor();
    initialize(): Promise<void>;
    private calculate;
    private statistics;
    destroy(): void;
}
declare class UIClientPlugin {
    private pluginId;
    private rpcClient;
    constructor();
    initialize(): Promise<void>;
    fetchUserData(limit?: number): Promise<{
        data: any[];
        total: number;
    }>;
    saveUserData(userData: any): Promise<{
        id: string;
        success: boolean;
    }>;
    performCalculation(a: number, b: number): Promise<{
        result: number;
    }>;
    performBatchOperations(): Promise<any>;
    destroy(): void;
}
declare function demonstrateRpc(): Promise<void>;
declare function advancedExample(): Promise<void>;
export { DataServicePlugin, CalculationPlugin, UIClientPlugin, demonstrateRpc, advancedExample };
//# sourceMappingURL=plugin-rpc.example.d.ts.map