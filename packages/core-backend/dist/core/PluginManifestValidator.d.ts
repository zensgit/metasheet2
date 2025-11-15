/**
 * Plugin Manifest Validator and Standard
 * Implements comprehensive manifest validation and versioning
 */
export declare const MANIFEST_VERSION = "2.0.0";
export interface PluginManifestV2 {
    manifestVersion: string;
    name: string;
    version: string;
    displayName: string;
    description: string;
    author: {
        name: string;
        email?: string;
        url?: string;
    };
    engine: {
        metasheet: string;
        node?: string;
        npm?: string;
    };
    main: string;
    types?: string;
    bin?: Record<string, string>;
    assets?: {
        icons?: Record<string, string>;
        styles?: string[];
        scripts?: string[];
    };
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    capabilities: {
        views?: string[];
        workflows?: string[];
        dataSources?: string[];
        functions?: string[];
        triggers?: string[];
        actions?: string[];
    };
    permissions: {
        database?: {
            read?: string[];
            write?: string[];
            execute?: boolean;
        };
        http?: {
            internal?: boolean;
            external?: boolean;
            allowedDomains?: string[];
            blockedDomains?: string[];
        };
        filesystem?: {
            read?: string[];
            write?: string[];
            temp?: boolean;
        };
        system?: {
            env?: string[];
            exec?: string[];
            network?: boolean;
        };
        plugins?: {
            communicate?: string[];
            control?: boolean;
        };
    };
    hooks?: {
        install?: string;
        uninstall?: string;
        activate?: string;
        deactivate?: string;
        upgrade?: string;
        configure?: string;
    };
    routes?: Array<{
        method: string;
        path: string;
        handler: string;
        middleware?: string[];
        permissions?: string[];
    }>;
    views?: Array<{
        id: string;
        type: string;
        name: string;
        component: string;
        icon?: string;
        permissions?: string[];
    }>;
    workflowNodes?: Array<{
        id: string;
        type: string;
        name: string;
        category: string;
        executor: string;
        config?: any;
    }>;
    migrations?: Array<{
        version: string;
        up: string;
        down: string;
    }>;
    configSchema?: {
        type: 'object';
        properties: Record<string, any>;
        required?: string[];
    };
    defaultConfig?: Record<string, any>;
    repository?: {
        type: string;
        url: string;
    };
    homepage?: string;
    bugs?: {
        url?: string;
        email?: string;
    };
    license?: string;
    keywords?: string[];
    platforms?: string[];
    cpu?: string[];
    os?: string[];
}
/**
 * Manifest validator
 */
export declare class ManifestValidator {
    private errors;
    private warnings;
    /**
     * Validate a plugin manifest
     */
    validate(manifest: any): {
        valid: boolean;
        errors: string[];
        warnings: string[];
        normalized?: PluginManifestV2;
    };
    private validateRequiredFields;
    private validateVersions;
    private validateCapabilities;
    private validatePermissions;
    private validateDependencies;
    private validateRoutes;
    private validateMigrations;
    private normalizeManifest;
    /**
     * Check if two plugins are compatible
     */
    static checkCompatibility(plugin1: PluginManifestV2, plugin2: PluginManifestV2): {
        compatible: boolean;
        conflicts: string[];
    };
}
export declare const manifestValidator: ManifestValidator;
//# sourceMappingURL=PluginManifestValidator.d.ts.map