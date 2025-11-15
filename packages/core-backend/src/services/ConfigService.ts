/**
 * Configuration Management Service
 * Provides a unified interface for application configuration with multiple sources
 */

import { Logger } from '../core/logger'
import * as fs from 'fs'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { db } from '../db/db'

const logger = new Logger('ConfigService')

export interface ConfigSource {
  name: string
  priority: number
  get(key: string): Promise<any>
  set?(key: string, value: any): Promise<void>
  getAll?(): Promise<Record<string, any>>
}

/**
 * Environment variables configuration source
 */
export class EnvConfigSource implements ConfigSource {
  name = 'environment'
  priority = 100 // Highest priority

  async get(key: string): Promise<any> {
    const envKey = this.toEnvKey(key)
    const value = process.env[envKey]

    if (value === undefined) return undefined

    // Try to parse JSON values
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }

  private toEnvKey(key: string): string {
    // Convert dot notation to underscore: app.port -> APP_PORT
    return key.toUpperCase().replace(/\./g, '_')
  }

  async getAll(): Promise<Record<string, any>> {
    const config: Record<string, any> = {}

    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith('METASHEET_')) {
        const configKey = this.fromEnvKey(key)
        try {
          config[configKey] = JSON.parse(value as string)
        } catch {
          config[configKey] = value
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
  private config: Record<string, any> = {}
  private loaded = false

  constructor(private filePath: string) {}

  async get(key: string): Promise<any> {
    await this.loadConfig()
    return this.getNestedValue(this.config, key)
  }

  async getAll(): Promise<Record<string, any>> {
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

      if (ext === '.yaml' || ext === '.yml') {
        this.config = yaml.load(content) as Record<string, any>
      } else if (ext === '.json') {
        this.config = JSON.parse(content)
      } else {
        throw new Error(`Unsupported config file format: ${ext}`)
      }

      this.loaded = true
      logger.info(`Loaded config from ${this.filePath}`)
    } catch (error) {
      logger.error(`Failed to load config file: ${error}`)
      this.loaded = true
    }
  }

  private getNestedValue(obj: any, key: string): any {
    return key.split('.').reduce((curr, part) => curr?.[part], obj)
  }
}

/**
 * Database configuration source
 */
export class DatabaseConfigSource implements ConfigSource {
  name = 'database'
  priority = 30
  private cache: Map<string, { value: any; timestamp: number }> = new Map()
  private cacheTTL = 60000 // 1 minute

  async get(key: string): Promise<any> {
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

      let value = result.value

      // Decrypt if needed
      if (result.is_encrypted) {
        const secretManager = new SecretManager()
        value = await secretManager.decryptValue(value)
      }

      // Cache the value
      this.cache.set(key, { value, timestamp: Date.now() })

      return value
    } catch (error) {
      logger.error(`Failed to get config from database: ${error}`)
      return undefined
    }
  }

  async set(key: string, value: any): Promise<void> {
    if (!db) throw new Error('Database not available')

    const jsonValue = JSON.stringify(value)

    await db
      .insertInto('system_configs')
      .values({
        key,
        value: jsonValue,
        updated_at: new Date()
      })
      .onConflict((oc) =>
        oc.column('key').doUpdateSet({
          value: jsonValue,
          updated_at: new Date()
        })
      )
      .execute()

    // Invalidate cache
    this.cache.delete(key)
  }

  async getAll(): Promise<Record<string, any>> {
    if (!db) return {}

    try {
      const rows = await db
        .selectFrom('system_configs')
        .select(['key', 'value', 'is_encrypted'])
        .execute()

      const config: Record<string, any> = {}
      const secretManager = new SecretManager()

      for (const row of rows) {
        let value = row.value

        if (row.is_encrypted) {
          value = await secretManager.decryptValue(value)
        }

        config[row.key] = value
      }

      return config
    } catch (error) {
      logger.error(`Failed to get all configs from database: ${error}`)
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

  private defaults: Record<string, any> = {
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

  async get(key: string): Promise<any> {
    return this.getNestedValue(this.defaults, key)
  }

  async getAll(): Promise<Record<string, any>> {
    return { ...this.defaults }
  }

  private getNestedValue(obj: any, key: string): any {
    return key.split('.').reduce((curr, part) => curr?.[part], obj)
  }
}

/**
 * Secret Manager for handling encrypted values
 */
export class SecretManager {
  private crypto = require('crypto')
  private algorithm = 'aes-256-gcm'
  private keyDerivationSalt: Buffer

  constructor() {
    // Use environment variable or generate a salt
    const salt = process.env.ENCRYPTION_SALT || 'default-salt-change-in-production'
    this.keyDerivationSalt = Buffer.from(salt)
  }

  private getKey(): Buffer {
    const masterKey = process.env.ENCRYPTION_KEY || 'default-key-change-in-production'
    return this.crypto.pbkdf2Sync(masterKey, this.keyDerivationSalt, 100000, 32, 'sha256')
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
      logger.error(`Encryption failed: ${error}`)
      throw new Error('Failed to encrypt value')
    }
  }

  async decrypt(ciphertext: string): Promise<string> {
    try {
      const key = this.getKey()
      const combined = Buffer.from(ciphertext, 'base64')

      // Extract components
      const iv = combined.slice(0, 16)
      const authTag = combined.slice(16, 32)
      const encrypted = combined.slice(32)

      const decipher = this.crypto.createDecipheriv(this.algorithm, key, iv)
      decipher.setAuthTag(authTag)

      let decrypted = decipher.update(encrypted, null, 'utf8')
      decrypted += decipher.final('utf8')

      return decrypted
    } catch (error) {
      logger.error(`Decryption failed: ${error}`)
      throw new Error('Failed to decrypt value')
    }
  }

  async decryptValue(value: any): Promise<any> {
    if (typeof value === 'string' && value.startsWith('enc:')) {
      return await this.decrypt(value.substring(4))
    }
    return value
  }

  async rotateKey(oldKey: string, newKey: string): Promise<void> {
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

    for (const config of configs) {
      try {
        // Decrypt with old key
        process.env.ENCRYPTION_KEY = oldKey
        const decrypted = await this.decrypt(config.value.toString())

        // Encrypt with new key
        process.env.ENCRYPTION_KEY = newKey
        const encrypted = await this.encrypt(decrypted)

        // Update database
        await db
          .updateTable('system_configs')
          .set({ value: encrypted, updated_at: new Date() })
          .where('id', '=', config.id)
          .execute()

      } catch (error) {
        logger.error(`Failed to rotate key for config ${config.key}: ${error}`)
        process.env.ENCRYPTION_KEY = originalKey
        throw error
      }
    }

    process.env.ENCRYPTION_KEY = newKey
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

  async get<T = any>(key: string, defaultValue?: T): Promise<T> {
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
    return undefined as any
  }

  async set(key: string, value: any, sourceName: string = 'database'): Promise<void> {
    const source = this.sources.find(s => s.name === sourceName)

    if (!source || !source.set) {
      throw new Error(`Cannot set config in source: ${sourceName}`)
    }

    await source.set(key, value)
    logger.info(`Config '${key}' saved to ${sourceName}`)
  }

  async getAll(): Promise<Record<string, any>> {
    const allConfigs: Record<string, any> = {}

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
    if (port && (port < 1 || port > 65535)) {
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