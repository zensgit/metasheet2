export interface SandboxAdapter {
    wrap<T extends object>(plugin: T, manifestId: string): T;
}
export declare class NoopSandbox implements SandboxAdapter {
    wrap<T extends object>(plugin: T): T;
}
export declare function createSandbox(): SandboxAdapter;
//# sourceMappingURL=plugin-sandbox.d.ts.map