/**
 * Configuration Management Service
 * Provides a unified interface for application configuration with multiple sources
 */
export interface ConfigSource {
    name: string;
    priority: number;
    get(key: string): Promise<any>;
    set?(key: string, value: any): Promise<void>;
    getAll?(): Promise<Record<string, any>>;
}
/**
 * Environment variables configuration source
 */
export declare class EnvConfigSource implements ConfigSource {
    name: string;
    priority: number;
    get(key: string): Promise<any>;
    private toEnvKey;
    getAll(): Promise<Record<string, any>>;
    private fromEnvKey;
}
/**
 * File-based configuration source (YAML/JSON)
 */
export declare class FileConfigSource implements ConfigSource {
    private filePath;
    name: string;
    priority: number;
    private config;
    private loaded;
    constructor(filePath: string);
    get(key: string): Promise<any>;
    getAll(): Promise<Record<string, any>>;
    private loadConfig;
    private getNestedValue;
}
/**
 * Database configuration source
 */
export declare class DatabaseConfigSource implements ConfigSource {
    name: string;
    priority: number;
    private cache;
    private cacheTTL;
    get(key: string): Promise<any>;
    set(key: string, value: any): Promise<void>;
    getAll(): Promise<Record<string, any>>;
}
/**
 * Default configuration source
 */
export declare class DefaultConfigSource implements ConfigSource {
    name: string;
    priority: number;
    private defaults;
    get(key: string): Promise<any>;
    getAll(): Promise<Record<string, any>>;
    private getNestedValue;
}
/**
 * Secret Manager for handling encrypted values
 */
export declare class SecretManager {
    private crypto;
    private algorithm;
    private keyDerivationSalt;
    constructor();
    private getKey;
    encrypt(plaintext: string): Promise<string>;
    decrypt(ciphertext: string): Promise<string>;
    decryptValue(value: any): Promise<any>;
    rotateKey(oldKey: string, newKey: string): Promise<void>;
}
/**
 * Main Configuration Service
 */
export declare class ConfigService {
    private sources;
    private static instance;
    constructor();
    static getInstance(): ConfigService;
    get<T = any>(key: string, defaultValue?: T): Promise<T>;
    set(key: string, value: any, sourceName?: string): Promise<void>;
    getAll(): Promise<Record<string, any>>;
    reload(): Promise<void>;
    validate(): Promise<{
        valid: boolean;
        errors: string[];
    }>;
}
export declare const config: ConfigService;
//# sourceMappingURL=ConfigService.d.ts.map