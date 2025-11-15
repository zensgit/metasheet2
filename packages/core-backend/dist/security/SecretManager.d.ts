/**
 * Secret Management Service
 * Provides secure storage and retrieval of sensitive data
 * Supports multiple backends: Vault, AWS KMS, Local encrypted storage
 */
import { EventEmitter } from 'events';
interface SecretProvider {
    name: string;
    init(): Promise<void>;
    store(key: string, value: string, metadata?: any): Promise<string>;
    retrieve(key: string): Promise<string | null>;
    delete(key: string): Promise<boolean>;
    rotate(key: string): Promise<string>;
    list(prefix?: string): Promise<string[]>;
}
/**
 * Main Secret Manager
 */
export declare class SecretManager extends EventEmitter {
    private providers;
    private defaultProvider;
    private cache;
    private cacheTTL;
    constructor();
    private setupProviders;
    addProvider(provider: SecretProvider): void;
    init(): Promise<void>;
    getProvider(name?: string): SecretProvider;
    /**
     * Store a secret
     */
    store(key: string, value: string, options?: {
        provider?: string;
        metadata?: any;
        ttl?: number;
    }): Promise<string>;
    /**
     * Retrieve a secret
     */
    retrieve(key: string, options?: {
        provider?: string;
        useCache?: boolean;
    }): Promise<string | null>;
    /**
     * Delete a secret
     */
    delete(key: string, options?: {
        provider?: string;
    }): Promise<boolean>;
    /**
     * Rotate a secret
     */
    rotate(key: string, options?: {
        provider?: string;
    }): Promise<string>;
    /**
     * List secrets
     */
    list(prefix?: string, options?: {
        provider?: string;
    }): Promise<string[]>;
    /**
     * Encrypt data (utility method)
     */
    encrypt(data: string, key?: string): string;
    /**
     * Decrypt data (utility method)
     */
    decrypt(encrypted: string, key: string): string;
    /**
     * Generate secure random string
     */
    generateSecret(length?: number): string;
    /**
     * Hash a secret (one-way)
     */
    hash(value: string, salt?: string): string;
    /**
     * Verify hashed secret
     */
    verifyHash(value: string, hash: string): boolean;
}
export declare const secretManager: SecretManager;
export {};
//# sourceMappingURL=SecretManager.d.ts.map