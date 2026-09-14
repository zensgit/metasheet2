/**
 * Configuration Management Service
 * Provides a unified interface for application configuration with multiple sources
 */

import { Logger } from '../core/logger'
import * as fs from 'fs'
import * as path from 'path'
import { db } from '../db/db'
import { toISOString, toDateValue } from '../db/type-helpers'
import type { ResolveEncryptionMaterialOptions } from '../security/encrypted-secrets'
import { EncryptionMaterialError, resolveEncryptionMaterial } from '../security/encrypted-secrets'

// js-yaml is optional - try to load dynamically
let yaml: { load(content: string): unknown } | null = null
try {
  yaml = require('js-yaml')
} catch {
  // js-yaml not available, will only support JSON configs
}

const logger = new Logger('ConfigService')

// Type definitions for configuration values
export type ConfigValue = string | number | boolean | null | ConfigValue[] | { [key: string]: ConfigValue }

// Helper to convert unknown error to string for logging
function errorToString(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Type guard to check if a value is a valid JSON object
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Type guard to validate ConfigValue
function isConfigValue(value: unknown): value is ConfigValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true
  }
  if (Array.isArray(value)) {
    return value.every(isConfigValue)
  }
  if (isJsonObject(value)) {
    return Object.values(value).every(isConfigValue)
  }
  return false
}

export interface ConfigSource {
  name: string
  priority: number
  get(key: string): Promise<ConfigValue | undefined>
  set?(key: string, value: ConfigValue): Promise<void>
  getAll?(): Promise<Record<string, ConfigValue>>
}

/**
 * Environment variables configuration source
 */
export class EnvConfigSource implements ConfigSource {
  name = 'environment'
  priority = 100 // Highest priority

  async get(key: string): Promise<ConfigValue | undefined> {
    const envKey = this.toEnvKey(key)
    const value = process.env[envKey]

    if (value === undefined) return undefined

    // Try to parse JSON values
    try {
      const parsed = JSON.parse(value)
      return isConfigValue(parsed) ? parsed : value
    } catch {
      return value
    }
  }

  private toEnvKey(key: string): string {
    // Convert dot notation to underscore: app.port -> APP_PORT
    return key.toUpperCase().replace(/\./g, '_')
  }

  async getAll(): Promise<Record<string, ConfigValue>> {
    const config: Record<string, ConfigValue> = {}

    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('METASHEET_')) {
        const configKey = this.fromEnvKey(key)
        if (value !== undefined) {
          try {
            const parsed = JSON.parse(value)
            config[configKey] = isConfigValue(parsed) ? parsed : value
          } catch {
            config[configKey] = value
          }
        }
      }
    }

    return config
  }

  private fromEnvKey(envKey: string): string {
    return envKey
      .replace(/^METASHEET_/, '')
      .toLowerCase()
      .replace(/_/g, '.')
  }
}

/**
 * File-based configuration source (YAML/JSON)
 */
export class FileConfigSource implements ConfigSource {
  name = 'file'
  priority = 50
  private config: Record<string, ConfigValue> = {}
  private loaded = false

  constructor(private filePath: string) {}

  async get(key: string): Promise<ConfigValue | undefined> {
    await this.loadConfig()
    return this.getNestedValue(this.config, key)
  }

  async getAll(): Promise<Record<string, ConfigValue>> {
    await this.loadConfig()
    return { ...this.config }
  }

  private async loadConfig(): Promise<void> {
    if (this.loaded) return

    try {
      if (!fs.existsSync(this.filePath)) {
        logger.warn(`Config file not found: ${this.filePath}`)
        this.loaded = true
        return
      }

      const content = fs.readFileSync(this.filePath, 'utf8')
      const ext = path.extname(this.filePath)

      let parsed: unknown
      if (ext === '.yaml' || ext === '.yml') {
        if (!yaml) {
          throw new Error('YAML config files require js-yaml package to be installed')
        }
        parsed = yaml.load(content)
      } else if (ext === '.json') {
        parsed = JSON.parse(content)
      } else {
        throw new Error(`Unsupported config file format: ${ext}`)
      }

      // Validate and assign the parsed config
      if (isJsonObject(parsed)) {
        const validatedConfig: Record<string, ConfigValue> = {}
        for (const [key, value] of Object.entries(parsed)) {
          if (isConfigValue(value)) {
            validatedConfig[key] = value
          }
        }
        this.config = validatedConfig
      }

      this.loaded = true
      logger.info(`Loaded config from ${this.filePath}`)
    } catch (error) {
      logger.warn(`Failed to load config file: ${errorToString(error)}`)
      this.loaded = true
    }
  }

  private getNestedValue(obj: Record<string, ConfigValue>, key: string): ConfigValue | undefined {
    const parts = key.split('.')
    let current: ConfigValue | undefined = obj

    for (const part of parts) {
      if (current === undefined || current === null) {
        return undefined
      }
      if (typeof current === 'object' && !Array.isArray(current) && part in current) {
        current = current[part]
      } else {
        return undefined
      }
    }

    return current
  }
}

/**
 * Database configuration source
 */
export class DatabaseConfigSource implements ConfigSource {
  name = 'database'
  priority = 30
  private cache: Map<string, { value: ConfigValue; timestamp: number }> = new Map()
  private cacheTTL = 60000 // 1 minute

  async get(key: string): Promise<ConfigValue | undefined> {
    // Check cache
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.value
    }

    if (!db) return undefined

    try {
      const result = await db
        .selectFrom('system_configs')
        .select(['value', 'is_encrypted'])
        .where('key', '=', key)
        .executeTakeFirst()

      if (!result) return undefined

      let value: string = result.value

      // Decrypt if needed
      if (result.is_encrypted) {
        const secretManager = new SecretManager()
        value = await secretManager.decryptValue(value)
      }

      // Parse the JSON value
      const parsed: unknown = JSON.parse(value)
      const configValue = isConfigValue(parsed) ? parsed : undefined

      if (configValue !== undefined) {
        // Cache the value
        this.cache.set(key, { value: configValue, timestamp: Date.now() })
      }

      return configValue
    } catch (error) {
      logger.warn(`Failed to get config from database: ${errorToString(error)}`)
      return undefined
    }
  }

  async set(key: string, value: ConfigValue): Promise<void> {
    if (!db) throw new Error('Database not available')

    const jsonValue = JSON.stringify(value)

    await db
      .insertInto('system_configs')
      .values({
        key,
        value: jsonValue,
        is_encrypted: false,
        updated_at: toISOString(new Date())
      })
      // Kysely's onConflict has complex inferred types that are correctly handled
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .onConflict((oc: any) =>
        oc.column('key').doUpdateSet({
          value: jsonValue,
          updated_at: toDateValue(new Date())
        })
      )
      .execute()

    // Invalidate cache
    this.cache.delete(key)
  }

  async getAll(): Promise<Record<string, ConfigValue>> {
    if (!db) return {}

    try {
      const rows = await db
        .selectFrom('system_configs')
        .select(['key', 'value', 'is_encrypted'])
        .execute()

      const config: Record<string, ConfigValue> = {}
      const secretManager = new SecretManager()

      for (const row of rows) {
        let value: string = row.value

        if (row.is_encrypted) {
          value = await secretManager.decryptValue(value)
        }

        try {
          const parsed: unknown = JSON.parse(value)
          if (isConfigValue(parsed)) {
            config[row.key] = parsed
          }
        } catch {
          // If parsing fails, skip this config entry
          logger.warn(`Failed to parse config value for key: ${row.key}`)
        }
      }

      return config
    } catch (error) {
      logger.warn(`Failed to get all configs from database: ${errorToString(error)}`)
      return {}
    }
  }
}

/**
 * Default configuration source
 */
export class DefaultConfigSource implements ConfigSource {
  name = 'default'
  priority = 0 // Lowest priority

  private defaults: Record<string, ConfigValue> = {
    'app.port': 8900,
    'app.host': '0.0.0.0',
    'app.env': 'development',
    'database.pool.min': 2,
    'database.pool.max': 10,
    'cache.ttl': 3600,
    'session.secret': 'change-me-in-production',
    'session.ttl': 86400,
    'cors.enabled': true,
    'cors.origins': ['http://localhost:8899'],
    'logging.level': 'info',
    'logging.format': 'json',
    'metrics.enabled': true,
    'metrics.port': 9090,
    'security.rateLimit.enabled': true,
    'security.rateLimit.windowMs': 900000, // 15 minutes
    'security.rateLimit.max': 100,
    'uploads.maxSize': 10485760, // 10MB
    'uploads.allowedTypes': ['image/jpeg', 'image/png', 'image/gif', 'application/pdf'],
    'email.enabled': false,
    'email.from': 'noreply@metasheet.com',
    'workflow.maxRetries': 3,
    'workflow.retryDelay': 60000,
    'form.uploadLimit': 10485760,
    'form.responseRetention': 365,
    'gallery.imageCacheTTL': 3600
  }

  async get(key: string): Promise<ConfigValue | undefined> {
    return this.getNestedValue(this.defaults, key)
  }

  async getAll(): Promise<Record<string, ConfigValue>> {
    return { ...this.defaults }
  }

  private getNestedValue(obj: Record<string, ConfigValue>, key: string): ConfigValue | undefined {
    const parts = key.split('.')
    let current: ConfigValue | undefined = obj

    for (const part of parts) {
      if (current === undefined || current === null) {
        return undefined
      }
      if (typeof current === 'object' && !Array.isArray(current) && part in current) {
        current = current[part]
      } else {
        return undefined
      }
    }

    return current
  }
}

/**
 * `process.env.X = undefined` stores the literal string "undefined", which would look like a
 * configured-but-wrong key to the production gate. rotateKey() restores env on failure, so it has
 * to distinguish "was unset" from "was set".
 */
function restoreEnvValue(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

/**
 * Secret Manager for handling encrypted values
 */
export class SecretManager {
  private crypto = require('crypto')
  private algorithm = 'aes-256-gcm'

  /**
   * Key + salt come from the shared resolver (src/security/encrypted-secrets.ts), which
   * fail-closes in production on missing / built-in-default material. Resolved per call rather
   * than cached in the constructor so rotateKey()'s `process.env.ENCRYPTION_KEY` swap still
   * selects the intended key for each decrypt/encrypt.
   */
  private getKey(options: ResolveEncryptionMaterialOptions = {}): Buffer {
    const material = resolveEncryptionMaterial(process.env, options)
    return this.crypto.pbkdf2Sync(material.masterKey, Buffer.from(material.salt), 100000, 32, 'sha256')
  }

  async encrypt(plaintext: string): Promise<string> {
    try {
      const key = this.getKey()
      const iv = this.crypto.randomBytes(16)
      const cipher = this.crypto.createCipheriv(this.algorithm, key, iv)

      let encrypted = cipher.update(plaintext, 'utf8', 'hex')
      encrypted += cipher.final('hex')

      const authTag = cipher.getAuthTag()

      // Combine iv, authTag, and encrypted data
      const combined = Buffer.concat([
        iv,
        authTag,
        Buffer.from(encrypted, 'hex')
      ])

      return combined.toString('base64')
    } catch (error) {
      // A misconfigured production key is an operator-actionable failure, not a generic crypto
      // error — keep the (values-free) diagnostic instead of flattening it to 'Failed to encrypt'.
      if (error instanceof EncryptionMaterialError) throw error
      logger.warn(`Encryption failed: ${errorToString(error)}`)
      throw new Error('Failed to encrypt value')
    }
  }

  /**
   * `options` exists solely for rotateKey()'s read-with-the-old-key step (see
   * ResolveEncryptionMaterialOptions). encrypt() has no such parameter on purpose: the rotation
   * TARGET must always satisfy the production gate.
   */
  async decrypt(ciphertext: string, options: ResolveEncryptionMaterialOptions = {}): Promise<string> {
    try {
      const key = this.getKey(options)
      const combined = Buffer.from(ciphertext, 'base64')

      // Extract components
      const iv = combined.slice(0, 16)
      const authTag = combined.slice(16, 32)
      const encrypted = combined.slice(32)

      const decipher = this.crypto.createDecipheriv(this.algorithm, key, iv)
      decipher.setAuthTag(authTag)

      let decrypted = decipher.update(encrypted, undefined, 'utf8')
      decrypted += decipher.final('utf8')

      return decrypted
    } catch (error) {
      if (error instanceof EncryptionMaterialError) throw error
      logger.warn(`Decryption failed: ${errorToString(error)}`)
      throw new Error('Failed to decrypt value')
    }
  }

  async decryptValue(value: string): Promise<string> {
    if (typeof value === 'string' && value.startsWith('enc:')) {
      return await this.decrypt(value.substring(4))
    }
    return value
  }

  /**
   * Re-encrypt every `is_encrypted` system_config row from oldKey to newKey.
   *
   * `newSalt` is optional and defaults to leaving ENCRYPTION_SALT alone (pre-existing behaviour).
   * It is needed for the one migration this gate exists to force: a deployment that ran on BOTH
   * built-in defaults has its rows under (default key, default salt), so the read must use the old
   * salt while the write must land on a non-default salt — otherwise the production gate rejects
   * the write and the rotation can never complete. Pass the same value you will then set in the
   * service environment.
   */
  async rotateKey(oldKey: string, newKey: string, options: { newSalt?: string } = {}): Promise<void> {
    // Implementation for key rotation
    logger.info('Key rotation initiated')

    if (!db) throw new Error('Database not available')

    // Get all encrypted configs
    const configs = await db
      .selectFrom('system_configs')
      .select(['id', 'key', 'value'])
      .where('is_encrypted', '=', true)
      .execute()

    // Re-encrypt with new key
    const originalKey = process.env.ENCRYPTION_KEY
    const originalSalt = process.env.ENCRYPTION_SALT

    for (const config of configs) {
      try {
        // Decrypt with old key. `allowDefaultsForRotationRead` is what makes rotating OFF the
        // built-in default key possible at all — the read is the only step allowed to see default
        // material, and only because we are on our way to replacing it.
        process.env.ENCRYPTION_KEY = oldKey
        if (options.newSalt !== undefined) restoreEnvValue('ENCRYPTION_SALT', originalSalt)
        const decrypted = await this.decrypt(config.value.toString(), {
          allowDefaultsForRotationRead: true,
        })

        // Encrypt with new key — NO bypass, so a default/empty newKey (or newSalt) is refused.
        process.env.ENCRYPTION_KEY = newKey
        if (options.newSalt !== undefined) process.env.ENCRYPTION_SALT = options.newSalt
        const encrypted = await this.encrypt(decrypted)

        // Update database
        await db
          .updateTable('system_configs')
          .set({ value: encrypted, updated_at: toDateValue(new Date()) })
          .where('id', '=', config.id)
          .execute()

      } catch (error) {
        logger.warn(`Failed to rotate key for config ${config.key}: ${errorToString(error)}`)
        restoreEnvValue('ENCRYPTION_KEY', originalKey)
        if (options.newSalt !== undefined) restoreEnvValue('ENCRYPTION_SALT', originalSalt)
        throw error
      }
    }

    // Pre-existing behaviour (not introduced by the fail-closed work): the process is left on the
    // new material so subsequent operations in THIS process match what was just written.
    process.env.ENCRYPTION_KEY = newKey
    if (options.newSalt !== undefined) process.env.ENCRYPTION_SALT = options.newSalt
    logger.info('Key rotation completed')
  }
}

/**
 * Main Configuration Service
 */
export class ConfigService {
  private sources: ConfigSource[] = []
  private static instance: ConfigService

  constructor() {
    // Initialize configuration sources in priority order
    this.sources = [
      new EnvConfigSource(),
      new FileConfigSource(process.env.CONFIG_FILE || './config.yaml'),
      new DatabaseConfigSource(),
      new DefaultConfigSource()
    ].sort((a, b) => b.priority - a.priority)
  }

  static getInstance(): ConfigService {
    if (!ConfigService.instance) {
      ConfigService.instance = new ConfigService()
    }
    return ConfigService.instance
  }

  async get<T extends ConfigValue = ConfigValue>(key: string, defaultValue?: T): Promise<T | undefined> {
    for (const source of this.sources) {
      const value = await source.get(key)
      if (value !== undefined) {
        logger.debug(`Config '${key}' loaded from ${source.name}`)
        return value as T
      }
    }

    if (defaultValue !== undefined) {
      return defaultValue
    }

    logger.warn(`Config key '${key}' not found in any source`)
    return undefined
  }

  async set(key: string, value: ConfigValue, sourceName: string = 'database'): Promise<void> {
    const source = this.sources.find(s => s.name === sourceName)

    if (!source || !source.set) {
      throw new Error(`Cannot set config in source: ${sourceName}`)
    }

    await source.set(key, value)
    logger.info(`Config '${key}' saved to ${sourceName}`)
  }

  async getAll(): Promise<Record<string, ConfigValue>> {
    const allConfigs: Record<string, ConfigValue> = {}

    // Merge configs from all sources (reverse order for priority)
    for (const source of [...this.sources].reverse()) {
      if (source.getAll) {
        const sourceConfigs = await source.getAll()
        Object.assign(allConfigs, sourceConfigs)
      }
    }

    return allConfigs
  }

  async reload(): Promise<void> {
    // Clear caches and reload configurations
    for (const source of this.sources) {
      if (source.name === 'database') {
        (source as DatabaseConfigSource)['cache'].clear()
      } else if (source.name === 'file') {
        (source as FileConfigSource)['loaded'] = false
      }
    }

    logger.info('Configuration reloaded')
  }

  async validate(): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = []

    // Validate required configurations
    const required = [
      'app.port',
      'app.host',
      'database.url',
      'session.secret'
    ]

    for (const key of required) {
      const value = await this.get(key)
      if (value === undefined) {
        errors.push(`Missing required config: ${key}`)
      }
    }

    // Validate configuration values
    const port = await this.get<number>('app.port')
    if (port !== undefined && typeof port === 'number' && (port < 1 || port > 65535)) {
      errors.push(`Invalid port number: ${port}`)
    }

    return {
      valid: errors.length === 0,
      errors
    }
  }
}

// Export singleton instance
export const config = ConfigService.getInstance()
