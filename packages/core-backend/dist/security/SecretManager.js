/**
 * Secret Management Service
 * Provides secure storage and retrieval of sensitive data
 * Supports multiple backends: Vault, AWS KMS, Local encrypted storage
 */
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { db } from '../db/kysely';
/**
 * Local encrypted storage provider
 */
class LocalSecretProvider {
    name = 'local';
    masterKey;
    secrets = new Map();
    config = {
        algorithm: 'aes-256-gcm',
        keyLength: 32,
        saltLength: 64,
        iterations: 100000,
        tagLength: 16
    };
    constructor(masterKey) {
        // Use provided key or generate from env
        const key = masterKey || process.env.MASTER_ENCRYPTION_KEY || '';
        if (!key) {
            // Generate a default key (not for production!)
            console.warn('No master key provided, generating temporary key');
            this.masterKey = crypto.randomBytes(32);
        }
        else {
            // Derive key from passphrase
            const salt = crypto.createHash('sha256').update('metasheet-salt').digest();
            this.masterKey = crypto.pbkdf2Sync(key, salt, this.config.iterations, this.config.keyLength, 'sha256');
        }
    }
    async init() {
        // Load secrets from database if available
        if (db) {
            try {
                const credentials = await db
                    .selectFrom('data_source_credentials')
                    .selectAll()
                    .execute();
                for (const cred of credentials) {
                    this.secrets.set(cred.id, {
                        encrypted: cred.encrypted_value,
                        metadata: {
                            created_at: cred.created_at,
                            updated_at: cred.updated_at,
                            accessed_at: cred.last_used || undefined,
                            expires_at: cred.expires_at || undefined
                        }
                    });
                }
            }
            catch (error) {
                console.error('Failed to load secrets from database:', error);
            }
        }
    }
    async store(key, value, metadata) {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv(this.config.algorithm, this.masterKey, iv);
        let encrypted = cipher.update(value, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag();
        const combined = Buffer.concat([iv, authTag, Buffer.from(encrypted, 'hex')]);
        const secretData = {
            encrypted: combined.toString('base64'),
            metadata: {
                created_at: new Date(),
                updated_at: new Date(),
                ...metadata
            }
        };
        this.secrets.set(key, secretData);
        // Persist to database
        if (db) {
            try {
                await db
                    .insertInto('data_source_credentials')
                    .values({
                    id: key,
                    data_source_id: metadata?.data_source_id || crypto.randomUUID(),
                    credential_type: metadata?.type || 'API_KEY',
                    encrypted_value: secretData.encrypted,
                    encryption_key_id: 'local',
                    created_by: metadata?.created_by
                })
                    .onConflict((oc) => oc.column('id').doUpdateSet({
                    encrypted_value: secretData.encrypted,
                    updated_at: new Date()
                }))
                    .execute();
            }
            catch (error) {
                console.error('Failed to persist secret:', error);
            }
        }
        return key;
    }
    async retrieve(key) {
        const secret = this.secrets.get(key);
        if (!secret)
            return null;
        try {
            const combined = Buffer.from(secret.encrypted, 'base64');
            const iv = combined.slice(0, 16);
            const authTag = combined.slice(16, 16 + this.config.tagLength);
            const encrypted = combined.slice(16 + this.config.tagLength);
            const decipher = crypto.createDecipheriv(this.config.algorithm, this.masterKey, iv);
            decipher.setAuthTag(authTag);
            let decrypted = decipher.update(encrypted.toString('hex'), 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            // Update access time
            secret.metadata.accessed_at = new Date();
            return decrypted;
        }
        catch (error) {
            console.error('Failed to decrypt secret:', error);
            return null;
        }
    }
    async delete(key) {
        const exists = this.secrets.has(key);
        this.secrets.delete(key);
        if (db && exists) {
            try {
                await db
                    .deleteFrom('data_source_credentials')
                    .where('id', '=', key)
                    .execute();
            }
            catch (error) {
                console.error('Failed to delete secret from database:', error);
            }
        }
        return exists;
    }
    async rotate(key) {
        const value = await this.retrieve(key);
        if (!value)
            throw new Error(`Secret ${key} not found`);
        // Generate new key ID
        const newKey = `${key}-${Date.now()}`;
        const metadata = this.secrets.get(key)?.metadata;
        // Store with new key
        await this.store(newKey, value, {
            ...metadata,
            rotated_from: key
        });
        // Mark old key as rotated
        if (this.secrets.has(key)) {
            const secret = this.secrets.get(key);
            secret.metadata.updated_at = new Date();
        }
        return newKey;
    }
    async list(prefix) {
        const keys = Array.from(this.secrets.keys());
        if (!prefix)
            return keys;
        return keys.filter(key => key.startsWith(prefix));
    }
}
/**
 * HashiCorp Vault provider
 */
class VaultSecretProvider {
    name = 'vault';
    vaultUrl;
    vaultToken;
    mountPath;
    constructor(config) {
        this.vaultUrl = config.url || process.env.VAULT_URL || 'http://localhost:8200';
        this.vaultToken = config.token || process.env.VAULT_TOKEN || '';
        this.mountPath = config.mountPath || 'secret';
    }
    async init() {
        if (!this.vaultToken) {
            throw new Error('Vault token not configured');
        }
        // Verify connection
        const response = await fetch(`${this.vaultUrl}/v1/sys/health`);
        if (!response.ok) {
            throw new Error(`Vault not healthy: ${response.statusText}`);
        }
    }
    async store(key, value, metadata) {
        const response = await fetch(`${this.vaultUrl}/v1/${this.mountPath}/data/${key}`, {
            method: 'POST',
            headers: {
                'X-Vault-Token': this.vaultToken,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                data: {
                    value,
                    ...metadata
                }
            })
        });
        if (!response.ok) {
            throw new Error(`Failed to store secret: ${response.statusText}`);
        }
        const result = await response.json();
        return result.data.version;
    }
    async retrieve(key) {
        const response = await fetch(`${this.vaultUrl}/v1/${this.mountPath}/data/${key}`, {
            headers: {
                'X-Vault-Token': this.vaultToken
            }
        });
        if (response.status === 404)
            return null;
        if (!response.ok) {
            throw new Error(`Failed to retrieve secret: ${response.statusText}`);
        }
        const result = await response.json();
        return result.data.data.value;
    }
    async delete(key) {
        const response = await fetch(`${this.vaultUrl}/v1/${this.mountPath}/metadata/${key}`, {
            method: 'DELETE',
            headers: {
                'X-Vault-Token': this.vaultToken
            }
        });
        return response.ok;
    }
    async rotate(key) {
        // Vault handles rotation internally
        const value = await this.retrieve(key);
        if (!value)
            throw new Error(`Secret ${key} not found`);
        // Create new version
        return await this.store(key, value, { rotated_at: new Date() });
    }
    async list(prefix) {
        const path = prefix || '';
        const response = await fetch(`${this.vaultUrl}/v1/${this.mountPath}/metadata/${path}?list=true`, {
            headers: {
                'X-Vault-Token': this.vaultToken
            }
        });
        if (!response.ok)
            return [];
        const result = await response.json();
        return result.data.keys || [];
    }
}
/**
 * Main Secret Manager
 */
export class SecretManager extends EventEmitter {
    providers = new Map();
    defaultProvider = 'local';
    cache = new Map();
    cacheTTL = 300000; // 5 minutes
    constructor() {
        super();
        this.setupProviders();
    }
    setupProviders() {
        // Setup local provider by default
        this.addProvider(new LocalSecretProvider());
        // Setup Vault if configured
        if (process.env.VAULT_URL && process.env.VAULT_TOKEN) {
            this.addProvider(new VaultSecretProvider({}));
            this.defaultProvider = 'vault';
        }
    }
    addProvider(provider) {
        this.providers.set(provider.name, provider);
    }
    async init() {
        for (const provider of this.providers.values()) {
            try {
                await provider.init();
                this.emit('provider:initialized', provider.name);
            }
            catch (error) {
                this.emit('provider:error', provider.name, error);
                console.error(`Failed to initialize provider ${provider.name}:`, error);
            }
        }
    }
    getProvider(name) {
        const providerName = name || this.defaultProvider;
        const provider = this.providers.get(providerName);
        if (!provider) {
            throw new Error(`Secret provider ${providerName} not found`);
        }
        return provider;
    }
    /**
     * Store a secret
     */
    async store(key, value, options) {
        const provider = this.getProvider(options?.provider);
        const result = await provider.store(key, value, options?.metadata);
        // Clear cache
        this.cache.delete(key);
        this.emit('secret:stored', key, provider.name);
        return result;
    }
    /**
     * Retrieve a secret
     */
    async retrieve(key, options) {
        // Check cache
        if (options?.useCache !== false) {
            const cached = this.cache.get(key);
            if (cached && cached.expires > Date.now()) {
                return cached.value;
            }
        }
        const provider = this.getProvider(options?.provider);
        const value = await provider.retrieve(key);
        if (value && options?.useCache !== false) {
            this.cache.set(key, {
                value,
                expires: Date.now() + this.cacheTTL
            });
        }
        this.emit('secret:retrieved', key, provider.name);
        return value;
    }
    /**
     * Delete a secret
     */
    async delete(key, options) {
        const provider = this.getProvider(options?.provider);
        const result = await provider.delete(key);
        // Clear cache
        this.cache.delete(key);
        this.emit('secret:deleted', key, provider.name);
        return result;
    }
    /**
     * Rotate a secret
     */
    async rotate(key, options) {
        const provider = this.getProvider(options?.provider);
        const newKey = await provider.rotate(key);
        // Clear cache
        this.cache.delete(key);
        this.cache.delete(newKey);
        this.emit('secret:rotated', key, newKey, provider.name);
        return newKey;
    }
    /**
     * List secrets
     */
    async list(prefix, options) {
        const provider = this.getProvider(options?.provider);
        return await provider.list(prefix);
    }
    /**
     * Encrypt data (utility method)
     */
    encrypt(data, key) {
        const encKey = key ? Buffer.from(key, 'hex') : crypto.randomBytes(32);
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
        let encrypted = cipher.update(data, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag();
        const combined = Buffer.concat([
            iv,
            authTag,
            Buffer.from(encrypted, 'hex')
        ]);
        return combined.toString('base64');
    }
    /**
     * Decrypt data (utility method)
     */
    decrypt(encrypted, key) {
        const combined = Buffer.from(encrypted, 'base64');
        const iv = combined.slice(0, 16);
        const authTag = combined.slice(16, 32);
        const data = combined.slice(32);
        const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(data.toString('hex'), 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }
    /**
     * Generate secure random string
     */
    generateSecret(length = 32) {
        return crypto.randomBytes(length).toString('hex');
    }
    /**
     * Hash a secret (one-way)
     */
    hash(value, salt) {
        const actualSalt = salt || crypto.randomBytes(16).toString('hex');
        const hash = crypto
            .pbkdf2Sync(value, actualSalt, 100000, 64, 'sha512')
            .toString('hex');
        return `${actualSalt}:${hash}`;
    }
    /**
     * Verify hashed secret
     */
    verifyHash(value, hash) {
        const [salt, originalHash] = hash.split(':');
        const newHash = crypto
            .pbkdf2Sync(value, salt, 100000, 64, 'sha512')
            .toString('hex');
        return newHash === originalHash;
    }
}
// Export singleton instance
export const secretManager = new SecretManager();
//# sourceMappingURL=SecretManager.js.map