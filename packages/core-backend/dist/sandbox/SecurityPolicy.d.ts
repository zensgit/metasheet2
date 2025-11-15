export interface SecurityPolicyOptions {
    maxExecutionTime?: number;
    maxMemory?: number;
    maxCPU?: number;
    maxOutputSize?: number;
    allowNetwork?: boolean;
    allowFileSystem?: boolean;
    allowChildProcess?: boolean;
    allowedModules?: string[];
    blockedModules?: string[];
    allowedAPIs?: string[];
    blockedAPIs?: string[];
    allowedDomains?: string[];
    blockedDomains?: string[];
    maxLoops?: number;
    maxRecursion?: number;
    maxArraySize?: number;
    maxStringLength?: number;
}
export interface ValidationResult {
    allowed: boolean;
    reasons: string[];
    warnings?: string[];
    risk: 'low' | 'medium' | 'high';
}
export declare class SecurityPolicy {
    private options;
    private dangerousPatterns;
    private suspiciousPatterns;
    constructor(options?: SecurityPolicyOptions);
    private initializeDangerousPatterns;
    private initializeSuspiciousPatterns;
    validate(script: string, language?: 'javascript' | 'typescript' | 'python'): Promise<ValidationResult>;
    checkCompliance(metrics: {
        executionTime: number;
        memoryUsed: number;
        cpuTime?: number;
        outputSize?: number;
    }): {
        compliant: boolean;
        violations: string[];
    };
    sanitizeCode(script: string): string;
    generateSafeWrapper(script: string, language?: 'javascript' | 'python'): string;
    getOptions(): SecurityPolicyOptions;
    updateOptions(updates: Partial<SecurityPolicyOptions>): void;
    clone(): SecurityPolicy;
}
//# sourceMappingURL=SecurityPolicy.d.ts.map