import type { PluginManifest } from '../types/plugin';
export interface ValidationIssue {
    level: 'error' | 'warning';
    message: string;
}
export interface ValidationResult {
    ok: boolean;
    issues: ValidationIssue[];
}
export interface CapabilityRegistry {
    has(key: string): boolean;
}
export declare function validateManifest(manifest: PluginManifest, caps?: CapabilityRegistry): ValidationResult;
//# sourceMappingURL=plugin-validator.d.ts.map