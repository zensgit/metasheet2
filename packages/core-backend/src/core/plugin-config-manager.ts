/**
 * 插件配置管理器
 * 提供插件配置的统一管理、验证、持久化和变更通知功能
 */

import { EventEmitter } from 'eventemitter3'
import * as path from 'path'
import * as fs from 'fs/promises'
import { z } from 'zod'
import type { ValidationService } from '../types/plugin'
import { Logger } from './logger'

/**
 * 配置模式定义
 */
export interface ConfigSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean'
  properties?: Record<string, ConfigSchema>
  items?: ConfigSchema
  required?: string[]
  default?: any
  enum?: any[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  description?: string
  title?: string
}

/**
 * 插件配置项
 */
export interface PluginConfig {
  pluginName: string
  config: Record<string, any>
  schema?: ConfigSchema
  version: string
  lastModified: Date
  modifiedBy?: string
}

/**
 * 配置变更事件
 */
export interface ConfigChangeEvent {
  pluginName: string
  key?: string
  oldValue: any
  newValue: any
  timestamp: Date
  modifiedBy?: string
}

/**
 * 配置存储接口
 */
export interface ConfigStorage {
  load(pluginName: string): Promise<PluginConfig | null>
  save(config: PluginConfig): Promise<void>
  delete(pluginName: string): Promise<void>
  list(): Promise<string[]>
  backup(pluginName: string): Promise<string>
  restore(pluginName: string, backupId: string): Promise<void>
}

/**
 * 文件系统配置存储
 */
class FileSystemConfigStorage implements ConfigStorage {
  private basePath: string
  private backupPath: string
  private logger: Logger

  constructor(basePath: string = './config/plugins') {
    this.basePath = basePath
    this.backupPath = path.join(basePath, '.backups')
    this.logger = new Logger('FileSystemConfigStorage')
  }

  async load(pluginName: string): Promise<PluginConfig | null> {
    try {
      const configPath = path.join(this.basePath, `${pluginName}.json`)
      const content = await fs.readFile(configPath, 'utf-8')
      return JSON.parse(content) as PluginConfig
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return null
      }
      this.logger.error(`Failed to load config for ${pluginName}`, error as Error)
      throw error
    }
  }

  async save(config: PluginConfig): Promise<void> {
    try {
      // 确保目录存在
      await fs.mkdir(this.basePath, { recursive: true })

      const configPath = path.join(this.basePath, `${config.pluginName}.json`)
      const content = JSON.stringify(config, null, 2)
      await fs.writeFile(configPath, content, 'utf-8')
    } catch (error) {
      this.logger.error(`Failed to save config for ${config.pluginName}`, error as Error)
      throw error
    }
  }

  async delete(pluginName: string): Promise<void> {
    try {
      const configPath = path.join(this.basePath, `${pluginName}.json`)
      await fs.unlink(configPath)
    } catch (error) {
      if ((error as any).code !== 'ENOENT') {
        this.logger.error(`Failed to delete config for ${pluginName}`, error as Error)
        throw error
      }
    }
  }

  async list(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.basePath)
      return files
        .filter(f => f.endsWith('.json') && !f.startsWith('.'))
        .map(f => f.replace('.json', ''))
    } catch (error) {
      if ((error as any).code === 'ENOENT') {
        return []
      }
      this.logger.error('Failed to list plugin configs', error as Error)
      throw error
    }
  }

  async backup(pluginName: string): Promise<string> {
    try {
      const config = await this.load(pluginName)
      if (!config) {
        throw new Error(`Config not found for plugin: ${pluginName}`)
      }

      // 确保备份目录存在
      await fs.mkdir(this.backupPath, { recursive: true })

      const backupId = `${pluginName}_${Date.now()}`
      const backupPath = path.join(this.backupPath, `${backupId}.json`)

      const backupContent = {
        ...config,
        backupId,
        backupTimestamp: new Date()
      }

      await fs.writeFile(backupPath, JSON.stringify(backupContent, null, 2), 'utf-8')
      return backupId
    } catch (error) {
      this.logger.error(`Failed to backup config for ${pluginName}`, error as Error)
      throw error
    }
  }

  async restore(pluginName: string, backupId: string): Promise<void> {
    try {
      const backupPath = path.join(this.backupPath, `${backupId}.json`)
      const content = await fs.readFile(backupPath, 'utf-8')
      const backupConfig = JSON.parse(content)

      // 移除备份特定字段
      delete backupConfig.backupId
      delete backupConfig.backupTimestamp

      // 更新时间戳
      backupConfig.lastModified = new Date()
      backupConfig.modifiedBy = 'system:restore'

      await this.save(backupConfig)
    } catch (error) {
      this.logger.error(`Failed to restore config for ${pluginName} from ${backupId}`, error as Error)
      throw error
    }
  }
}

/**
 * 数据库配置存储
 */
class DatabaseConfigStorage implements ConfigStorage {
  private db: any // 数据库连接
  private logger: Logger

  constructor(db: any) {
    this.db = db
    this.logger = new Logger('DatabaseConfigStorage')
  }

  async load(pluginName: string): Promise<PluginConfig | null> {
    try {
      const result = await this.db.selectFrom('plugin_configs')
        .selectAll()
        .where('plugin_name', '=', pluginName)
        .executeTakeFirst()

      if (!result) return null

      return {
        pluginName: result.plugin_name,
        config: result.config,
        schema: result.schema,
        version: result.version,
        lastModified: result.last_modified,
        modifiedBy: result.modified_by
      }
    } catch (error) {
      this.logger.error(`Failed to load config for ${pluginName}`, error as Error)
      throw error
    }
  }

  async save(config: PluginConfig): Promise<void> {
    try {
      await this.db.insertInto('plugin_configs')
        .values({
          plugin_name: config.pluginName,
          config: config.config,
          schema: config.schema,
          version: config.version,
          last_modified: config.lastModified,
          modified_by: config.modifiedBy
        })
        .onConflict((oc: any) => oc.column('plugin_name').doUpdateSet({
          config: config.config,
          schema: config.schema,
          version: config.version,
          last_modified: config.lastModified,
          modified_by: config.modifiedBy
        }))
        .execute()
    } catch (error) {
      this.logger.error(`Failed to save config for ${config.pluginName}`, error as Error)
      throw error
    }
  }

  async delete(pluginName: string): Promise<void> {
    try {
      await this.db.deleteFrom('plugin_configs')
        .where('plugin_name', '=', pluginName)
        .execute()
    } catch (error) {
      this.logger.error(`Failed to delete config for ${pluginName}`, error as Error)
      throw error
    }
  }

  async list(): Promise<string[]> {
    try {
      const results = await this.db.selectFrom('plugin_configs')
        .select('plugin_name')
        .execute()

      return results.map((r: any) => r.plugin_name)
    } catch (error) {
      this.logger.error('Failed to list plugin configs', error as Error)
      throw error
    }
  }

  async backup(pluginName: string): Promise<string> {
    try {
      const config = await this.load(pluginName)
      if (!config) {
        throw new Error(`Config not found for plugin: ${pluginName}`)
      }

      const backupId = `${pluginName}_${Date.now()}`

      await this.db.insertInto('plugin_config_backups')
        .values({
          backup_id: backupId,
          plugin_name: pluginName,
          config: config.config,
          schema: config.schema,
          version: config.version,
          backup_timestamp: new Date()
        })
        .execute()

      return backupId
    } catch (error) {
      this.logger.error(`Failed to backup config for ${pluginName}`, error as Error)
      throw error
    }
  }

  async restore(pluginName: string, backupId: string): Promise<void> {
    try {
      const backup = await this.db.selectFrom('plugin_config_backups')
        .selectAll()
        .where('backup_id', '=', backupId)
        .executeTakeFirst()

      if (!backup) {
        throw new Error(`Backup not found: ${backupId}`)
      }

      const restoredConfig: PluginConfig = {
        pluginName: backup.plugin_name,
        config: backup.config,
        schema: backup.schema,
        version: backup.version,
        lastModified: new Date(),
        modifiedBy: 'system:restore'
      }

      await this.save(restoredConfig)
    } catch (error) {
      this.logger.error(`Failed to restore config for ${pluginName} from ${backupId}`, error as Error)
      throw error
    }
  }
}

/**
 * 插件配置管理器
 */
export class PluginConfigManager extends EventEmitter {
  private storage: ConfigStorage
  private validationService?: ValidationService
  private logger: Logger
  private configCache = new Map<string, PluginConfig>()
  private schemaCache = new Map<string, ConfigSchema>()

  constructor(storage?: ConfigStorage, validationService?: ValidationService) {
    super()
    this.storage = storage || new FileSystemConfigStorage()
    this.validationService = validationService
    this.logger = new Logger('PluginConfigManager')
  }

  /**
   * 注册插件配置模式
   */
  registerSchema(pluginName: string, schema: ConfigSchema): void {
    this.schemaCache.set(pluginName, schema)
    this.logger.debug(`Registered config schema for plugin: ${pluginName}`)
  }

  /**
   * 获取插件配置
   */
  async getConfig(pluginName: string, useCache: boolean = true): Promise<PluginConfig | null> {
    try {
      // 检查缓存
      if (useCache && this.configCache.has(pluginName)) {
        return this.configCache.get(pluginName)!
      }

      // 从存储加载
      const config = await this.storage.load(pluginName)
      if (config) {
        this.configCache.set(pluginName, config)
      }

      return config
    } catch (error) {
      this.logger.error(`Failed to get config for plugin ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 设置插件配置
   */
  async setConfig(
    pluginName: string,
    config: Record<string, any>,
    modifiedBy?: string
  ): Promise<void> {
    try {
      // 获取当前配置
      const currentConfig = await this.getConfig(pluginName) || {
        pluginName,
        config: {},
        version: '1.0.0',
        lastModified: new Date()
      }

      // 验证配置
      await this.validateConfig(pluginName, config)

      // 创建配置变更事件
      const changeEvent: ConfigChangeEvent = {
        pluginName,
        oldValue: currentConfig.config,
        newValue: config,
        timestamp: new Date(),
        modifiedBy
      }

      // 更新配置
      const updatedConfig: PluginConfig = {
        ...currentConfig,
        config,
        lastModified: new Date(),
        modifiedBy
      }

      // 保存配置
      await this.storage.save(updatedConfig)

      // 更新缓存
      this.configCache.set(pluginName, updatedConfig)

      // 发出变更事件
      this.emit('config:changed', changeEvent)
      this.emit(`config:changed:${pluginName}`, changeEvent)

      this.logger.info(`Config updated for plugin: ${pluginName}`)
    } catch (error) {
      this.logger.error(`Failed to set config for plugin ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 更新配置项
   */
  async updateConfigValue(
    pluginName: string,
    key: string,
    value: any,
    modifiedBy?: string
  ): Promise<void> {
    try {
      const config = await this.getConfig(pluginName)
      if (!config) {
        throw new Error(`Config not found for plugin: ${pluginName}`)
      }

      const oldValue = config.config[key]
      const newConfig = { ...config.config, [key]: value }

      // 验证单个配置项
      await this.validateConfigValue(pluginName, key, value)

      // 创建变更事件
      const changeEvent: ConfigChangeEvent = {
        pluginName,
        key,
        oldValue,
        newValue: value,
        timestamp: new Date(),
        modifiedBy
      }

      // 更新配置
      const updatedConfig: PluginConfig = {
        ...config,
        config: newConfig,
        lastModified: new Date(),
        modifiedBy
      }

      // 保存配置
      await this.storage.save(updatedConfig)

      // 更新缓存
      this.configCache.set(pluginName, updatedConfig)

      // 发出变更事件
      this.emit('config:changed', changeEvent)
      this.emit(`config:changed:${pluginName}`, changeEvent)
      this.emit(`config:changed:${pluginName}:${key}`, changeEvent)

      this.logger.info(`Config value updated for plugin ${pluginName}: ${key}`)
    } catch (error) {
      this.logger.error(`Failed to update config value for plugin ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 删除插件配置
   */
  async deleteConfig(pluginName: string): Promise<void> {
    try {
      await this.storage.delete(pluginName)
      this.configCache.delete(pluginName)

      this.emit('config:deleted', { pluginName, timestamp: new Date() })
      this.logger.info(`Config deleted for plugin: ${pluginName}`)
    } catch (error) {
      this.logger.error(`Failed to delete config for plugin ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 获取所有插件配置
   */
  async listConfigs(): Promise<string[]> {
    return this.storage.list()
  }

  /**
   * 备份插件配置
   */
  async backupConfig(pluginName: string): Promise<string> {
    try {
      const backupId = await this.storage.backup(pluginName)
      this.emit('config:backed_up', { pluginName, backupId, timestamp: new Date() })
      this.logger.info(`Config backed up for plugin ${pluginName}: ${backupId}`)
      return backupId
    } catch (error) {
      this.logger.error(`Failed to backup config for plugin ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 恢复插件配置
   */
  async restoreConfig(pluginName: string, backupId: string): Promise<void> {
    try {
      await this.storage.restore(pluginName, backupId)

      // 清除缓存以强制重新加载
      this.configCache.delete(pluginName)

      this.emit('config:restored', { pluginName, backupId, timestamp: new Date() })
      this.logger.info(`Config restored for plugin ${pluginName} from ${backupId}`)
    } catch (error) {
      this.logger.error(`Failed to restore config for plugin ${pluginName}`, error as Error)
      throw error
    }
  }

  /**
   * 验证插件配置
   */
  private async validateConfig(pluginName: string, config: Record<string, any>): Promise<void> {
    const schema = this.schemaCache.get(pluginName)
    if (!schema) {
      // 没有模式定义，跳过验证
      return
    }

    if (this.validationService) {
      // 使用验证服务
      const zodSchema = this.convertToZodSchema(schema)
      const isValid = await this.validationService.validate(zodSchema, config)

      if (!isValid) {
        throw new Error(`Config validation failed for plugin: ${pluginName}`)
      }
    } else {
      // 简单的模式验证
      this.validateConfigWithSchema(config, schema)
    }
  }

  /**
   * 验证单个配置值
   */
  private async validateConfigValue(pluginName: string, key: string, value: any): Promise<void> {
    const schema = this.schemaCache.get(pluginName)
    if (!schema || !schema.properties || !schema.properties[key]) {
      return
    }

    const fieldSchema = schema.properties[key]
    this.validateValueWithSchema(value, fieldSchema, key)
  }

  /**
   * 使用模式验证配置
   */
  private validateConfigWithSchema(config: Record<string, any>, schema: ConfigSchema): void {
    if (schema.type !== 'object' || !schema.properties) {
      return
    }

    // 检查必需字段
    if (schema.required) {
      for (const required of schema.required) {
        if (!(required in config)) {
          throw new Error(`Required field missing: ${required}`)
        }
      }
    }

    // 验证每个字段
    for (const [key, value] of Object.entries(config)) {
      const fieldSchema = schema.properties[key]
      if (fieldSchema) {
        this.validateValueWithSchema(value, fieldSchema, key)
      }
    }
  }

  /**
   * 验证单个值
   */
  private validateValueWithSchema(value: any, schema: ConfigSchema, fieldName: string): void {
    // 类型检查
    if (schema.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value
      if (actualType !== schema.type) {
        throw new Error(`Field ${fieldName}: expected ${schema.type}, got ${actualType}`)
      }
    }

    // 枚举检查
    if (schema.enum && !schema.enum.includes(value)) {
      throw new Error(`Field ${fieldName}: value must be one of ${schema.enum.join(', ')}`)
    }

    // 数字范围检查
    if (schema.type === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) {
        throw new Error(`Field ${fieldName}: value must be >= ${schema.minimum}`)
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        throw new Error(`Field ${fieldName}: value must be <= ${schema.maximum}`)
      }
    }

    // 字符串长度检查
    if (schema.type === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        throw new Error(`Field ${fieldName}: length must be >= ${schema.minLength}`)
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        throw new Error(`Field ${fieldName}: length must be <= ${schema.maxLength}`)
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        throw new Error(`Field ${fieldName}: value does not match pattern`)
      }
    }
  }

  /**
   * 转换为 Zod 模式
   */
  private convertToZodSchema(schema: ConfigSchema): any {
    // 这里应该实现 ConfigSchema 到 Zod schema 的转换
    // 简化实现，返回一个基本的对象模式
    return z.object({})
  }

  /**
   * 清除缓存
   */
  clearCache(pluginName?: string): void {
    if (pluginName) {
      this.configCache.delete(pluginName)
    } else {
      this.configCache.clear()
    }
  }

  /**
   * 获取配置管理器统计
   */
  getStats(): {
    totalConfigs: number
    cachedConfigs: number
    registeredSchemas: number
  } {
    return {
      totalConfigs: this.configCache.size, // 这只是缓存大小，实际应该查询存储
      cachedConfigs: this.configCache.size,
      registeredSchemas: this.schemaCache.size
    }
  }

  /**
   * 创建数据库存储实例
   */
  static createDatabaseStorage(db: any): ConfigStorage {
    return new DatabaseConfigStorage(db)
  }

  /**
   * 创建文件系统存储实例
   */
  static createFileSystemStorage(basePath?: string): ConfigStorage {
    return new FileSystemConfigStorage(basePath)
  }
}

export { FileSystemConfigStorage, DatabaseConfigStorage }