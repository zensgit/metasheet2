import { EventEmitter } from 'eventemitter3';
import { ScriptSandbox, SandboxOptions, ExecutionContext, ExecutionResult } from './ScriptSandbox';
import { SecurityPolicy } from './SecurityPolicy';
export interface SandboxPool {
    id: string;
    name: string;
    options: SandboxOptions;
    policy: SecurityPolicy;
    instances: ScriptSandbox[];
    maxInstances: number;
    activeInstances: number;
}
export interface ScriptTemplate {
    id: string;
    name: string;
    description?: string;
    language: 'javascript' | 'typescript' | 'python';
    code: string;
    parameters?: Array<{
        name: string;
        type: string;
        required?: boolean;
        default?: any;
        description?: string;
    }>;
    context?: ExecutionContext;
    sandboxOptions?: SandboxOptions;
}
export interface ExecutionRequest {
    script?: string;
    templateId?: string;
    parameters?: Record<string, any>;
    context?: ExecutionContext;
    language?: 'javascript' | 'typescript' | 'python';
    poolId?: string;
    async?: boolean;
    callback?: (result: ExecutionResult) => void;
}
export interface ExecutionJob {
    id: string;
    request: ExecutionRequest;
    status: 'pending' | 'running' | 'completed' | 'failed' | 'timeout';
    result?: ExecutionResult;
    startedAt?: Date;
    completedAt?: Date;
    sandbox?: ScriptSandbox;
}
export declare class SandboxManager extends EventEmitter {
    private pools;
    private templates;
    private jobs;
    private defaultPool;
    private queue;
    private processing;
    constructor();
    private initializeDefaultPool;
    createPool(name: string, options: SandboxOptions, policy: SecurityPolicy, maxInstances?: number): Promise<string>;
    destroyPool(poolId: string): Promise<void>;
    registerTemplate(template: ScriptTemplate): string;
    execute(request: ExecutionRequest): Promise<ExecutionResult>;
    private executeJob;
    private getSandbox;
    private releaseSandbox;
    private prepareTemplateScript;
    private processQueue;
    getJobStatus(jobId: string): Promise<ExecutionJob | undefined>;
    getJobResult(jobId: string, timeout?: number): Promise<ExecutionResult>;
    getPoolMetrics(poolId?: string): {
        poolId: string;
        name: string;
        activeInstances: number;
        totalInstances: number;
        maxInstances: number;
        utilization: number;
    }[];
    cleanup(): Promise<void>;
}
//# sourceMappingURL=SandboxManager.d.ts.map