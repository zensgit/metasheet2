/**
 * 插件配置管理器
 * 提供插件特定的配置管理、环境变量注入、配置验证和动态更新
 */

import * as crypto from 'crypto'
import { EventEmitter } from 'eventemitter3'
import type {
  PluginManifest,
  DatabaseAPI,
  ValidationService
} from '../types/plugin'
import { Logger } from '../core/logger'

/**
 * 配置项类型
 */
export enum ConfigType {
  STRING = 'string',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  ARRAY = 'array',
  OBJECT = 'object',
  SECRET = 'secret', // 加密存储的敏感信息
  FILE_PATH = 'file_path',
  URL = 'url',
  EMAIL = 'email'
}

/**
 * 配置项定义
 */
export interface ConfigItem {
  key: string
  type: ConfigType
  required: boolean
  defaultValue?: any
  description?: string
  validator?: string // 验证器名称
  sensitive?: boolean // 是否敏感信息（需要加密）
  options?: any[] // 枚举选项
  min?: number // 数值最小值或字符串最小长度
  max?: number // 数值最大值或字符串最大长度
  pattern?: string // 正则表达式模式
  dependsOn?: string[] // 依赖的其他配置项
  scope?: 'global' | 'user' | 'tenant' // 配置作用域
}

/**
 * 配置 Schema
 */
export interface ConfigSchema {
  version: string
  items: ConfigItem[]
  groups?: Array<{
    name: string
    title: string
    description?: string
    items: string[] // 配置项key列表
  }>
}

/**
 * 配置值
 */
export interface ConfigValue {
  key: string
  value: any
  encrypted: boolean
  scope: string
  userId?: string
  tenantId?: string
  updatedAt: Date
  updatedBy?: string
}

/**
 * 配置更改事件
 */
export interface ConfigChangeEvent {
  pluginName: string
  key: string
  oldValue: any
  newValue: any
  scope: string
  userId?: string
  updatedBy?: string
}

/**
 * 插件配置管理器
 */
export class PluginConfigManager extends EventEmitter {
  private schemas = new Map<string, ConfigSchema>()
  private configs = new Map<string, Map<string, ConfigValue>>() // pluginName -> key -> ConfigValue
  private encryptionKey: string
  private database?: DatabaseAPI
  private validationService?: ValidationService
  private logger: Logger

  constructor(
    encryptionKey?: string,
    database?: DatabaseAPI,
    validationService?: ValidationService
  ) {
    super()
    this.encryptionKey = encryptionKey || this.generateEncryptionKey()
    this.database = database
    this.validationService = validationService
    this.logger = new Logger('PluginConfigManager')
  }

  /**
   * 注册插件配置 Schema
   */
  async registerSchema(pluginName: string, schema: ConfigSchema): Promise<void> {
    try {
      // 验证 Schema
      this.validateSchema(schema)

      // 注册 Schema
      this.schemas.set(pluginName, schema)

      // 初始化配置映射
      if (!this.configs.has(pluginName)) {
        this.configs.set(pluginName, new Map())
      }

      // 持久化 Schema
      if (this.database) {
        await this.persistSchema(pluginName, schema)
      }

      // 应用默认值
      await this.applyDefaultValues(pluginName, schema)

      this.emit('schema:registered', { pluginName, schema })
      this.logger.info(`Registered config schema for plugin: ${pluginName}`)

    } catch (error) {
      this.logger.error(`Failed to register config schema for plugin ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 获取插件配置 Schema
   */
  getSchema(pluginName: string): ConfigSchema | undefined {
    return this.schemas.get(pluginName)
  }

  /**
   * 设置配置值
   */
  async setConfig(
    pluginName: string,
    key: string,
    value: any,
    options: {
      scope?: 'global' | 'user' | 'tenant'
      userId?: string
      tenantId?: string
      updatedBy?: string
    } = {}
  ): Promise<void> {
    const schema = this.schemas.get(pluginName)
    if (!schema) {
      throw new Error(`No config schema found for plugin: ${pluginName}`)
    }

    const configItem = schema.items.find(item => item.key === key)
    if (!configItem) {
      throw new Error(`Config key '${key}' not found in schema for plugin: ${pluginName}`)
    }

    try {
      // 验证配置值
      const validatedValue = await this.validateConfigValue(configItem, value)

      // 检查依赖
      if (configItem.dependsOn) {
        await this.checkDependencies(pluginName, configItem.dependsOn, options)
      }

      const scope = options.scope || configItem.scope || 'global'
      const encrypted = configItem.sensitive || configItem.type === ConfigType.SECRET

      // 获取旧值
      const oldValue = await this.getConfig(pluginName, key, options)

      // 加密敏感信息
      const finalValue = encrypted ? this.encrypt(validatedValue) : validatedValue

      const configValue: ConfigValue = {
        key,
        value: finalValue,
        encrypted,
        scope,
        userId: options.userId,
        tenantId: options.tenantId,
        updatedAt: new Date(),
        updatedBy: options.updatedBy
      }

      // 存储到内存
      const pluginConfigs = this.configs.get(pluginName)!
      const configKey = this.buildConfigKey(key, scope, options.userId, options.tenantId)
      pluginConfigs.set(configKey, configValue)

      // 持久化到数据库
      if (this.database) {
        await this.persistConfigValue(pluginName, configValue)
      }

      // 发送变更事件
      this.emit('config:changed', {
        pluginName,
        key,
        oldValue,
        newValue: validatedValue,
        scope,
        userId: options.userId,
        updatedBy: options.updatedBy
      } as ConfigChangeEvent)

      this.logger.debug(`Set config ${pluginName}.${key} = ${encrypted ? '[ENCRYPTED]' : validatedValue}`)

    } catch (error) {
      this.logger.error(`Failed to set config ${pluginName}.${key}`, error as Error)
      throw error
    }
  }

  /**
   * 获取配置值
   */
  async getConfig(
    pluginName: string,
    key: string,
    options: {
      scope?: 'global' | 'user' | 'tenant'
      userId?: string
      tenantId?: string
      includeDefaults?: boolean
    } = {}
  ): Promise<any> {
    const schema = this.schemas.get(pluginName)
    if (!schema) {
      throw new Error(`No config schema found for plugin: ${pluginName}`)
    }

    const configItem = schema.items.find(item => item.key === key)
    if (!configItem) {
      throw new Error(`Config key '${key}' not found in schema for plugin: ${pluginName}`)
    }

    const scope = options.scope || configItem.scope || 'global'
    const pluginConfigs = this.configs.get(pluginName)

    if (pluginConfigs) {
      // 尝试获取精确匹配的配置
      const exactKey = this.buildConfigKey(key, scope, options.userId, options.tenantId)
      let configValue = pluginConfigs.get(exactKey)

      // 如果没有找到，尝试查找更低级别的配置（作用域继承）
      if (!configValue) {
        configValue = this.findInheritedConfig(pluginConfigs, key, scope, options.userId, options.tenantId)
      }

      if (configValue) {
        return configValue.encrypted ? this.decrypt(configValue.value) : configValue.value
      }
    }

    // 返回默认值
    if (options.includeDefaults !== false && configItem.defaultValue !== undefined) {
      return configItem.defaultValue
    }

    return undefined
  }

  /**
   * 获取所有配置
   */
  async getAllConfigs(
    pluginName: string,
    options: {
      scope?: 'global' | 'user' | 'tenant'
      userId?: string
      tenantId?: string
      includeDefaults?: boolean
      includeSensitive?: boolean
    } = {}
  ): Promise<Record<string, any>> {
    const schema = this.schemas.get(pluginName)
    if (!schema) {
      throw new Error(`No config schema found for plugin: ${pluginName}`)
    }

    const result: Record<string, any> = {}

    for (const item of schema.items) {
      // 跳过敏感信息（除非明确要求）
      if (item.sensitive && !options.includeSensitive) {
        continue
      }

      try {
        const value = await this.getConfig(pluginName, item.key, options)
        if (value !== undefined) {
          result[item.key] = value
        }
      } catch (error) {
        this.logger.warn(`Failed to get config ${pluginName}.${item.key}`, error as Error)
      }
    }

    return result
  }

  /**
   * 删除配置值
   */
  async deleteConfig(
    pluginName: string,
    key: string,
    options: {
      scope?: 'global' | 'user' | 'tenant'
      userId?: string
      tenantId?: string
    } = {}
  ): Promise<void> {
    const schema = this.schemas.get(pluginName)
    if (!schema) {
      throw new Error(`No config schema found for plugin: ${pluginName}`)
    }

    const configItem = schema.items.find(item => item.key === key)
    if (!configItem) {
      throw new Error(`Config key '${key}' not found in schema for plugin: ${pluginName}`)
    }

    const scope = options.scope || configItem.scope || 'global'
    const configKey = this.buildConfigKey(key, scope, options.userId, options.tenantId)

    // 获取旧值
    const oldValue = await this.getConfig(pluginName, key, options)

    // 从内存中删除
    const pluginConfigs = this.configs.get(pluginName)
    if (pluginConfigs) {
      pluginConfigs.delete(configKey)
    }

    // 从数据库中删除
    if (this.database) {
      await this.removeConfigFromDatabase(pluginName, key, scope, options.userId, options.tenantId)
    }

    // 发送变更事件
    this.emit('config:changed', {
      pluginName,
      key,
      oldValue,
      newValue: undefined,
      scope,
      userId: options.userId
    } as ConfigChangeEvent)

    this.logger.debug(`Deleted config ${pluginName}.${key}`)
  }

  /**
   * 验证插件所有配置
   */
  async validateAllConfigs(
    pluginName: string,
    options: {
      scope?: 'global' | 'user' | 'tenant'
      userId?: string
      tenantId?: string
    } = {}
  ): Promise<{ valid: boolean; errors: Array<{ key: string; error: string }> }> {
    const schema = this.schemas.get(pluginName)
    if (!schema) {
      return { valid: false, errors: [{ key: '', error: `No config schema found for plugin: ${pluginName}` }] }
    }

    const errors: Array<{ key: string; error: string }> = []

    for (const item of schema.items) {
      try {
        const value = await this.getConfig(pluginName, item.key, options)

        // 检查必需配置
        if (item.required && (value === undefined || value === null)) {
          errors.push({ key: item.key, error: 'Required configuration is missing' })
          continue
        }

        // 验证配置值
        if (value !== undefined) {
          await this.validateConfigValue(item, value)
        }
      } catch (error) {
        errors.push({ key: item.key, error: (error as Error).message })
      }
    }

    return { valid: errors.length === 0, errors }
  }

  /**
   * 重置插件配置为默认值
   */
  async resetToDefaults(
    pluginName: string,
    options: {
      scope?: 'global' | 'user' | 'tenant'
      userId?: string
      tenantId?: string
    } = {}
  ): Promise<void> {
    const schema = this.schemas.get(pluginName)
    if (!schema) {
      throw new Error(`No config schema found for plugin: ${pluginName}`)
    }

    for (const item of schema.items) {
      if (item.defaultValue !== undefined) {
        await this.setConfig(pluginName, item.key, item.defaultValue, options)
      } else {
        // 删除没有默认值的配置
        try {
          await this.deleteConfig(pluginName, item.key, options)
        } catch {
          // 忽略删除不存在配置的错误
        }
      }
    }

    this.logger.info(`Reset configs to defaults for plugin: ${pluginName}`)
  }

  /**
   * 导出配置
   */
  async exportConfigs(
    pluginName: string,
    options: {
      scope?: 'global' | 'user' | 'tenant'
      userId?: string
      tenantId?: string
      includeSensitive?: boolean
    } = {}
  ): Promise<{ schema: ConfigSchema; configs: Record<string, any> }> {
    const schema = this.schemas.get(pluginName)
    if (!schema) {
      throw new Error(`No config schema found for plugin: ${pluginName}`)
    }

    const configs = await this.getAllConfigs(pluginName, options)

    return { schema, configs }
  }

  /**
   * 导入配置
   */
  async importConfigs(
    pluginName: string,
    data: { schema?: ConfigSchema; configs: Record<string, any> },
    options: {
      scope?: 'global' | 'user' | 'tenant'
      userId?: string
      tenantId?: string
      overwrite?: boolean
    } = {}
  ): Promise<void> {
    // 如果提供了schema，先注册
    if (data.schema) {
      await this.registerSchema(pluginName, data.schema)
    }

    const schema = this.schemas.get(pluginName)
    if (!schema) {
      throw new Error(`No config schema found for plugin: ${pluginName}`)
    }

    for (const [key, value] of Object.entries(data.configs)) {
      const configItem = schema.items.find(item => item.key === key)
      if (!configItem) {
        this.logger.warn(`Skipping unknown config key: ${key}`)
        continue
      }

      // 检查是否需要覆写
      if (!options.overwrite) {
        const existingValue = await this.getConfig(pluginName, key, { ...options, includeDefaults: false })
        if (existingValue !== undefined) {
          continue // 跳过已存在的配置
        }
      }

      await this.setConfig(pluginName, key, value, options)
    }

    this.logger.info(`Imported configs for plugin: ${pluginName}`)
  }

  /**
   * 获取环境变量映射
   */
  getEnvironmentVariables(pluginName: string): Record<string, any> {
    const schema = this.schemas.get(pluginName)
    if (!schema) return {}

    const env: Record<string, any> = {}

    for (const item of schema.items) {
      try {
        const value = this.getConfig(pluginName, item.key, { includeDefaults: true })
        if (value !== undefined && !item.sensitive) {
          const envKey = `PLUGIN_${pluginName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${item.key.toUpperCase()}`
          env[envKey] = value
        }
      } catch {
        // 忽略获取失败的配置
      }
    }

    return env
  }

  /**
   * 从数据库加载配置
   */
  async loadFromDatabase(): Promise<void> {
    if (!this.database) return

    try {
      // 加载schemas
      const schemas = await this.database.query('SELECT * FROM plugin_config_schemas')
      for (const row of schemas) {
        const schema = JSON.parse(row.schema)
        this.schemas.set(row.plugin_name, schema)
        if (!this.configs.has(row.plugin_name)) {
          this.configs.set(row.plugin_name, new Map())
        }
      }

      // 加载配置值
      const configs = await this.database.query('SELECT * FROM plugin_configs')
      for (const row of configs) {
        const configValue: ConfigValue = {
          key: row.config_key,
          value: row.value,
          encrypted: row.encrypted,
          scope: row.scope,
          userId: row.user_id,
          tenantId: row.tenant_id,
          updatedAt: new Date(row.updated_at),
          updatedBy: row.updated_by
        }

        const pluginConfigs = this.configs.get(row.plugin_name)!
        const configKey = this.buildConfigKey(
          row.config_key,
          row.scope,
          row.user_id,
          row.tenant_id
        )
        pluginConfigs.set(configKey, configValue)
      }

      this.logger.info(`Loaded ${schemas.length} config schemas and ${configs.length} config values from database`)

    } catch (error) {
      this.logger.error('Failed to load configs from database', error as Error)
    }
  }

  /**
   * 验证配置Schema
   */
  private validateSchema(schema: ConfigSchema): void {
    if (!schema.version) {
      throw new Error('Config schema version is required')
    }

    if (!Array.isArray(schema.items) || schema.items.length === 0) {
      throw new Error('Config schema must have at least one item')
    }

    const keys = new Set<string>()
    for (const item of schema.items) {
      if (!item.key) {
        throw new Error('Config item key is required')
      }

      if (keys.has(item.key)) {
        throw new Error(`Duplicate config key: ${item.key}`)
      }
      keys.add(item.key)

      if (!Object.values(ConfigType).includes(item.type)) {
        throw new Error(`Invalid config type: ${item.type}`)
      }
    }
  }

  /**
   * 验证配置值
   */
  private async validateConfigValue(item: ConfigItem, value: any): Promise<any> {
    // 类型验证
    switch (item.type) {
      case ConfigType.STRING:
        if (typeof value !== 'string') {
          throw new Error(`Config ${item.key} must be a string`)
        }
        if (item.min !== undefined && value.length < item.min) {
          throw new Error(`Config ${item.key} must be at least ${item.min} characters`)
        }
        if (item.max !== undefined && value.length > item.max) {
          throw new Error(`Config ${item.key} must be at most ${item.max} characters`)
        }
        if (item.pattern) {
          const regex = new RegExp(item.pattern)
          if (!regex.test(value)) {
            throw new Error(`Config ${item.key} does not match required pattern`)
          }
        }
        break

      case ConfigType.NUMBER:
        const num = Number(value)
        if (isNaN(num)) {
          throw new Error(`Config ${item.key} must be a number`)
        }
        if (item.min !== undefined && num < item.min) {
          throw new Error(`Config ${item.key} must be at least ${item.min}`)
        }
        if (item.max !== undefined && num > item.max) {
          throw new Error(`Config ${item.key} must be at most ${item.max}`)
        }
        return num

      case ConfigType.BOOLEAN:
        if (typeof value !== 'boolean') {
          // 尝试转换字符串
          if (typeof value === 'string') {
            const lower = value.toLowerCase()
            if (lower === 'true' || lower === '1') return true
            if (lower === 'false' || lower === '0') return false
          }
          throw new Error(`Config ${item.key} must be a boolean`)
        }
        break

      case ConfigType.ARRAY:
        if (!Array.isArray(value)) {
          throw new Error(`Config ${item.key} must be an array`)
        }
        break

      case ConfigType.OBJECT:
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new Error(`Config ${item.key} must be an object`)
        }
        break

      case ConfigType.EMAIL:
        if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          throw new Error(`Config ${item.key} must be a valid email address`)
        }
        break

      case ConfigType.URL:
        if (typeof value !== 'string') {
          throw new Error(`Config ${item.key} must be a string`)
        }
        try {
          new URL(value)
        } catch {
          throw new Error(`Config ${item.key} must be a valid URL`)
        }
        break
    }

    // 选项验证
    if (item.options && !item.options.includes(value)) {
      throw new Error(`Config ${item.key} must be one of: ${item.options.join(', ')}`)
    }

    // 自定义验证器
    if (item.validator && this.validationService) {
      const validator = this.validationService.getValidator(item.validator)
      if (validator) {
        const result = validator(value)
        if (result !== true) {
          throw new Error(`Config ${item.key} validation failed: ${result}`)
        }
      }
    }

    return value
  }

  /**
   * 应用默认值
   */
  private async applyDefaultValues(pluginName: string, schema: ConfigSchema): Promise<void> {
    for (const item of schema.items) {
      if (item.defaultValue !== undefined) {
        try {
          // 检查是否已有配置
          const existing = await this.getConfig(pluginName, item.key, { includeDefaults: false })
          if (existing === undefined) {
            await this.setConfig(pluginName, item.key, item.defaultValue, {
              scope: item.scope || 'global'
            })
          }
        } catch {
          // 忽略设置默认值失败的情况
        }
      }
    }
  }

  /**
   * 检查依赖配置
   */
  private async checkDependencies(
    pluginName: string,
    dependencies: string[],
    options: any
  ): Promise<void> {
    for (const depKey of dependencies) {
      const depValue = await this.getConfig(pluginName, depKey, options)
      if (depValue === undefined || depValue === null) {
        throw new Error(`Dependent configuration '${depKey}' is not set`)
      }
    }
  }

  /**
   * 构建配置键
   */
  private buildConfigKey(
    key: string,
    scope: string,
    userId?: string,
    tenantId?: string
  ): string {
    const parts = [key, scope]
    if (userId) parts.push(`user:${userId}`)
    if (tenantId) parts.push(`tenant:${tenantId}`)
    return parts.join('#')
  }

  /**
   * 查找继承的配置
   */
  private findInheritedConfig(
    pluginConfigs: Map<string, ConfigValue>,
    key: string,
    scope: string,
    userId?: string,
    tenantId?: string
  ): ConfigValue | undefined {
    // 配置继承优先级：user > tenant > global
    const searchKeys = []

    if (scope === 'user' && userId) {
      // 尝试用户级别配置
      searchKeys.push(this.buildConfigKey(key, 'user', userId, tenantId))
      if (tenantId) {
        searchKeys.push(this.buildConfigKey(key, 'tenant', undefined, tenantId))
      }
      searchKeys.push(this.buildConfigKey(key, 'global'))
    } else if (scope === 'tenant' && tenantId) {
      // 尝试租户级别配置
      searchKeys.push(this.buildConfigKey(key, 'tenant', undefined, tenantId))
      searchKeys.push(this.buildConfigKey(key, 'global'))
    } else {
      // 全局级别配置
      searchKeys.push(this.buildConfigKey(key, 'global'))
    }

    for (const searchKey of searchKeys) {
      const config = pluginConfigs.get(searchKey)
      if (config) return config
    }

    return undefined
  }

  /**
   * 加密敏感信息
   */
  private encrypt(value: any): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    const cipher = crypto.createCipher('aes-256-cbc', this.encryptionKey)
    let encrypted = cipher.update(text, 'utf8', 'hex')
    encrypted += cipher.final('hex')
    return encrypted
  }

  /**
   * 解密敏感信息
   */
  private decrypt(encryptedValue: string): any {
    try {
      const decipher = crypto.createDecipher('aes-256-cbc', this.encryptionKey)
      let decrypted = decipher.update(encryptedValue, 'hex', 'utf8')
      decrypted += decipher.final('utf8')

      // 尝试解析JSON，如果失败则返回字符串
      try {
        return JSON.parse(decrypted)
      } catch {
        return decrypted
      }
    } catch (error) {
      this.logger.error('Failed to decrypt config value', error as Error)
      throw new Error('Failed to decrypt sensitive configuration')
    }
  }

  /**
   * 生成加密键
   */
  private generateEncryptionKey(): string {
    return crypto.randomBytes(32).toString('hex')
  }

  /**
   * 持久化Schema
   */
  private async persistSchema(pluginName: string, schema: ConfigSchema): Promise<void> {
    if (!this.database) return

    const sql = `
      INSERT INTO plugin_config_schemas (plugin_name, schema, created_at, updated_at)
      VALUES ($1, $2, NOW(), NOW())
      ON CONFLICT (plugin_name)
      DO UPDATE SET schema = EXCLUDED.schema, updated_at = NOW()
    `

    await this.database.query(sql, [pluginName, JSON.stringify(schema)])
  }

  /**
   * 持久化配置值
   */
  private async persistConfigValue(pluginName: string, configValue: ConfigValue): Promise<void> {
    if (!this.database) return

    const sql = `
      INSERT INTO plugin_configs
      (plugin_name, config_key, value, encrypted, scope, user_id, tenant_id, updated_at, updated_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (plugin_name, config_key, scope, COALESCE(user_id, ''), COALESCE(tenant_id, ''))
      DO UPDATE SET
        value = EXCLUDED.value,
        encrypted = EXCLUDED.encrypted,
        updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by
    `

    await this.database.query(sql, [
      pluginName,
      configValue.key,
      configValue.value,
      configValue.encrypted,
      configValue.scope,
      configValue.userId || null,
      configValue.tenantId || null,
      configValue.updatedAt,
      configValue.updatedBy || null
    ])
  }

  /**
   * 从数据库删除配置
   */
  private async removeConfigFromDatabase(
    pluginName: string,
    key: string,
    scope: string,
    userId?: string,
    tenantId?: string
  ): Promise<void> {
    if (!this.database) return

    const sql = `
      DELETE FROM plugin_configs
      WHERE plugin_name = $1 AND config_key = $2 AND scope = $3
        AND COALESCE(user_id, '') = $4 AND COALESCE(tenant_id, '') = $5
    `

    await this.database.query(sql, [
      pluginName,
      key,
      scope,
      userId || '',
      tenantId || ''
    ])
  }
}

export {
  ConfigType,
  ConfigItem,
  ConfigSchema,
  ConfigValue,
  ConfigChangeEvent
}