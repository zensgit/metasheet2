import { EventEmitter } from 'eventemitter3';
export interface SandboxOptions {
    timeout?: number;
    memoryLimit?: number;
    cpuLimit?: number;
    allowedModules?: string[];
    blockedModules?: string[];
    env?: Record<string, string>;
    workDir?: string;
    maxOutputSize?: number;
    maxExecutions?: number;
    isolateContext?: boolean;
}
export interface ExecutionContext {
    globals?: Record<string, any>;
    modules?: Record<string, any>;
    functions?: Record<string, Function>;
    data?: any;
}
export interface ExecutionResult {
    success: boolean;
    output?: any;
    error?: Error | string;
    logs: Array<{
        level: string;
        message: string;
        timestamp: Date;
    }>;
    metrics: {
        executionTime: number;
        memoryUsed: number;
        cpuTime?: number;
    };
    warnings?: string[];
}
export declare class ScriptSandbox extends EventEmitter {
    private options;
    private worker;
    private executionCount;
    private workDir;
    private scriptCache;
    constructor(options?: SandboxOptions);
    initialize(): Promise<void>;
    execute(script: string, context?: ExecutionContext, language?: 'javascript' | 'typescript' | 'python'): Promise<ExecutionResult>;
    private executeJavaScript;
    private executePython;
    private getWorkerCode;
    private wrapPythonScript;
    validateScript(script: string, language?: 'javascript' | 'typescript' | 'python'): Promise<{
        valid: boolean;
        errors?: string[];
    }>;
    cleanup(): Promise<void>;
    getMetrics(): {
        executionCount: number;
        cacheSize: number;
        uptime: number;
    };
    private createWorkerScript;
}
//# sourceMappingURL=ScriptSandbox.d.ts.map