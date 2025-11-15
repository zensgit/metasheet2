/**
 * 验证服务实现
 * 基于 Zod 提供强大的数据验证和转换功能
 */

// @ts-nocheck
import { z } from 'zod'
import { EventEmitter } from 'eventemitter3'
import type {
  ValidationService,
  ValidationSchema,
  ValidationResult,
  ValidationError,
  CustomValidator,
  DataTransformer,
  StringSchema,
  NumberSchema,
  BooleanSchema,
  ObjectSchema,
  ArraySchema,
  UnionSchema,
  OptionalSchema
} from '../types/plugin'
import { Logger } from '../core/logger'

/**
 * Zod Schema 包装器
 */
class ZodSchemaWrapper<T = any> implements ValidationSchema<T> {
  constructor(private zodSchema: z.ZodSchema<T>) {}

  parse(data: unknown): T {
    return this.zodSchema.parse(data)
  }

  safeParse(data: unknown): ValidationResult<T> {
    const result = this.zodSchema.safeParse(data)
    if (result.success) {
      return { success: true, data: result.data }
    } else {
      return {
        success: false,
        errors: result.error.errors.map(err => ({
          path: err.path.map(String),
          message: err.message,
          code: err.code,
          expected: (err as any).expected,
          received: (err as any).received
        }))
      }
    }
  }

  transform<U>(transformer: (value: T) => U): ValidationSchema<U> {
    return new ZodSchemaWrapper(this.zodSchema.transform(transformer))
  }

  optional(): ValidationSchema<T | undefined> {
    return new ZodSchemaWrapper(this.zodSchema.optional())
  }

  nullable(): ValidationSchema<T | null> {
    return new ZodSchemaWrapper(this.zodSchema.nullable())
  }

  default(value: T): ValidationSchema<T> {
    return new ZodSchemaWrapper(this.zodSchema.default(value))
  }
}

/**
 * 字符串 Schema 实现
 */
class StringSchemaImpl extends ZodSchemaWrapper<string> implements StringSchema {
  constructor(private baseSchema: z.ZodString = z.string()) {
    super(baseSchema)
  }

  min(length: number): StringSchema {
    return new StringSchemaImpl(this.baseSchema.min(length))
  }

  max(length: number): StringSchema {
    return new StringSchemaImpl(this.baseSchema.max(length))
  }

  length(length: number): StringSchema {
    return new StringSchemaImpl(this.baseSchema.length(length))
  }

  email(): StringSchema {
    return new StringSchemaImpl(this.baseSchema.email())
  }

  url(): StringSchema {
    return new StringSchemaImpl(this.baseSchema.url())
  }

  regex(pattern: RegExp): StringSchema {
    return new StringSchemaImpl(this.baseSchema.regex(pattern))
  }

  uuid(): StringSchema {
    return new StringSchemaImpl(this.baseSchema.uuid())
  }
}

/**
 * 数字 Schema 实现
 */
class NumberSchemaImpl extends ZodSchemaWrapper<number> implements NumberSchema {
  constructor(private baseSchema: z.ZodNumber = z.number()) {
    super(baseSchema)
  }

  min(value: number): NumberSchema {
    return new NumberSchemaImpl(this.baseSchema.min(value))
  }

  max(value: number): NumberSchema {
    return new NumberSchemaImpl(this.baseSchema.max(value))
  }

  int(): NumberSchema {
    return new NumberSchemaImpl(this.baseSchema.int())
  }

  positive(): NumberSchema {
    return new NumberSchemaImpl(this.baseSchema.positive())
  }

  negative(): NumberSchema {
    return new NumberSchemaImpl(this.baseSchema.negative())
  }

  nonnegative(): NumberSchema {
    return new NumberSchemaImpl(this.baseSchema.nonnegative())
  }
}

/**
 * 布尔 Schema 实现
 */
class BooleanSchemaImpl extends ZodSchemaWrapper<boolean> implements BooleanSchema {
  constructor() {
    super(z.boolean())
  }
}

/**
 * 对象 Schema 实现
 */
class ObjectSchemaImpl<T> extends ZodSchemaWrapper<T> implements ObjectSchema<T> {
  constructor(private baseSchema: z.ZodObject<any> = z.object({})) {
    super(baseSchema)
  }

  shape<S>(shape: { [K in keyof S]: ValidationSchema<S[K]> }): ObjectSchema<S> {
    const zodShape: any = {}
    for (const [key, schema] of Object.entries(shape)) {
      zodShape[key] = (schema as ZodSchemaWrapper).zodSchema || schema
    }
    return new ObjectSchemaImpl(z.object(zodShape))
  }

  pick<K extends keyof T>(keys: K[]): ObjectSchema<Pick<T, K>> {
    return new ObjectSchemaImpl(this.baseSchema.pick(Object.fromEntries(keys.map(k => [k, true]))))
  }

  omit<K extends keyof T>(keys: K[]): ObjectSchema<Omit<T, K>> {
    return new ObjectSchemaImpl(this.baseSchema.omit(Object.fromEntries(keys.map(k => [k, true]))))
  }

  partial(): ObjectSchema<Partial<T>> {
    return new ObjectSchemaImpl(this.baseSchema.partial())
  }

  required(): ObjectSchema<Required<T>> {
    return new ObjectSchemaImpl(this.baseSchema.required())
  }

  strict(): ObjectSchema<T> {
    return new ObjectSchemaImpl(this.baseSchema.strict())
  }
}

/**
 * 数组 Schema 实现
 */
class ArraySchemaImpl<T> extends ZodSchemaWrapper<T[]> implements ArraySchema<T> {
  constructor(private baseSchema: z.ZodArray<any> = z.array(z.unknown())) {
    super(baseSchema)
  }

  element<U>(schema: ValidationSchema<U>): ArraySchema<U> {
    const zodSchema = (schema as ZodSchemaWrapper).zodSchema || schema
    return new ArraySchemaImpl(z.array(zodSchema))
  }

  min(length: number): ArraySchema<T> {
    return new ArraySchemaImpl(this.baseSchema.min(length))
  }

  max(length: number): ArraySchema<T> {
    return new ArraySchemaImpl(this.baseSchema.max(length))
  }

  length(length: number): ArraySchema<T> {
    return new ArraySchemaImpl(this.baseSchema.length(length))
  }

  nonempty(): ArraySchema<T> {
    return new ArraySchemaImpl(this.baseSchema.nonempty())
  }
}

/**
 * 联合 Schema 实现
 */
class UnionSchemaImpl<T> extends ZodSchemaWrapper<T> implements UnionSchema<T> {
  constructor(private baseSchema: z.ZodUnion<any>) {
    super(baseSchema)
  }

  or<U>(schema: ValidationSchema<U>): UnionSchema<T | U> {
    const zodSchema = (schema as ZodSchemaWrapper).zodSchema || schema
    return new UnionSchemaImpl(z.union([this.baseSchema, zodSchema]))
  }
}

/**
 * 可选 Schema 实现
 */
class OptionalSchemaImpl<T> extends ZodSchemaWrapper<T | undefined> implements OptionalSchema<T> {
  constructor(schema: ValidationSchema<T>) {
    const zodSchema = (schema as ZodSchemaWrapper).zodSchema || schema
    super(zodSchema.optional())
  }
}

/**
 * 验证服务实现
 */
export class ValidationServiceImpl extends EventEmitter implements ValidationService {
  private schemas = new Map<string, ValidationSchema<any>>()
  private validators = new Map<string, CustomValidator>()
  private logger: Logger

  constructor() {
    super()
    this.logger = new Logger('ValidationService')

    // 注册一些常用的自定义验证器
    this.setupCommonValidators()
  }

  async validate<T>(data: unknown, schema: ValidationSchema<T>): Promise<ValidationResult<T>> {
    try {
      const result = schema.safeParse(data)
      this.emit('validation:completed', { data, schema, result })
      return result
    } catch (error) {
      const errorResult: ValidationResult<T> = {
        success: false,
        errors: [{
          path: [],
          message: (error as Error).message,
          code: 'validation_error'
        }]
      }
      this.emit('validation:error', { data, schema, error })
      return errorResult
    }
  }

  validateSync<T>(data: unknown, schema: ValidationSchema<T>): ValidationResult<T> {
    try {
      const result = schema.safeParse(data)
      this.emit('validation:completed', { data, schema, result })
      return result
    } catch (error) {
      const errorResult: ValidationResult<T> = {
        success: false,
        errors: [{
          path: [],
          message: (error as Error).message,
          code: 'validation_error'
        }]
      }
      this.emit('validation:error', { data, schema, error })
      return errorResult
    }
  }

  registerSchema<T>(name: string, schema: ValidationSchema<T>): void {
    this.schemas.set(name, schema)
    this.emit('schema:registered', { name, schema })
  }

  getSchema<T>(name: string): ValidationSchema<T> | null {
    return this.schemas.get(name) as ValidationSchema<T> || null
  }

  addValidator(name: string, validator: CustomValidator): void {
    this.validators.set(name, validator)
    this.emit('validator:registered', { name, validator })
  }

  getValidator(name: string): CustomValidator | null {
    return this.validators.get(name) || null
  }

  async transform<T>(data: unknown, transformer: DataTransformer<T>): Promise<T> {
    try {
      const result = transformer(data)
      this.emit('transformation:completed', { data, result })
      return result
    } catch (error) {
      this.logger.error('Data transformation failed', error as Error)
      this.emit('transformation:error', { data, error })
      throw error
    }
  }

  async validateBatch<T>(items: unknown[], schema: ValidationSchema<T>): Promise<ValidationResult<T>[]> {
    const results = await Promise.all(
      items.map(item => this.validate(item, schema))
    )

    this.emit('validation:batch:completed', { items, schema, results })
    return results
  }

  // Schema builders
  string(): StringSchema {
    return new StringSchemaImpl()
  }

  number(): NumberSchema {
    return new NumberSchemaImpl()
  }

  boolean(): BooleanSchema {
    return new BooleanSchemaImpl()
  }

  object<T>(): ObjectSchema<T> {
    return new ObjectSchemaImpl<T>()
  }

  array<T>(): ArraySchema<T> {
    return new ArraySchemaImpl<T>()
  }

  union<T>(): UnionSchema<T> {
    // 创建一个基础的联合类型，需要调用 or() 来添加选项
    return new UnionSchemaImpl<T>(z.union([z.never(), z.never()]) as any)
  }

  optional<T>(schema: ValidationSchema<T>): OptionalSchema<T> {
    return new OptionalSchemaImpl(schema)
  }

  /**
   * 创建自定义验证 Schema
   */
  custom<T>(validator: (data: unknown) => T | never): ValidationSchema<T> {
    return new ZodSchemaWrapper(z.custom(validator))
  }

  /**
   * 创建枚举 Schema
   */
  enum<T extends string>(values: readonly T[]): ValidationSchema<T> {
    return new ZodSchemaWrapper(z.enum(values as [T, ...T[]]))
  }

  /**
   * 创建字面值 Schema
   */
  literal<T extends string | number | boolean>(value: T): ValidationSchema<T> {
    return new ZodSchemaWrapper(z.literal(value))
  }

  /**
   * 创建日期 Schema
   */
  date(): ValidationSchema<Date> {
    return new ZodSchemaWrapper(z.date())
  }

  /**
   * 创建 JSON Schema（任意对象）
   */
  json(): ValidationSchema<any> {
    return new ZodSchemaWrapper(z.any())
  }

  /**
   * 创建递归 Schema
   */
  lazy<T>(fn: () => ValidationSchema<T>): ValidationSchema<T> {
    return new ZodSchemaWrapper(z.lazy(() => {
      const schema = fn()
      return (schema as ZodSchemaWrapper).zodSchema || schema
    }))
  }

  /**
   * 预定义常用 Schema
   */
  getCommonSchemas() {
    return {
      email: this.string().email(),
      url: this.string().url(),
      uuid: this.string().uuid(),
      phoneNumber: this.string().regex(/^\+?[\d\s\-\(\)]+$/),
      positiveInteger: this.number().int().positive(),
      percentage: this.number().min(0).max(100),
      timestamp: this.number().positive(),
      iso8601: this.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/),

      // 分页参数
      pagination: this.object().shape({
        page: this.number().int().min(1).default(1),
        limit: this.number().int().min(1).max(1000).default(20),
        offset: this.number().int().min(0).optional()
      }),

      // 排序参数
      sorting: this.object().shape({
        sortBy: this.string().min(1),
        sortOrder: this.enum(['asc', 'desc'] as const).default('asc')
      }),

      // API 响应格式
      apiResponse: <T>(dataSchema: ValidationSchema<T>) => this.object().shape({
        success: this.boolean(),
        data: dataSchema.optional(),
        error: this.string().optional(),
        message: this.string().optional(),
        timestamp: this.string().optional()
      })
    }
  }

  private setupCommonValidators(): void {
    // 中国手机号验证
    this.addValidator('chinesePhone', (value: any) => {
      if (typeof value !== 'string') return '必须是字符串'
      if (!/^1[3-9]\d{9}$/.test(value)) return '请输入有效的中国手机号'
      return true
    })

    // 中国身份证号验证
    this.addValidator('chineseIdCard', (value: any) => {
      if (typeof value !== 'string') return '必须是字符串'
      if (!/^[1-9]\d{5}(19|20)\d{2}((0[1-9])|(1[0-2]))(([0-2][1-9])|10|20|30|31)\d{3}[0-9Xx]$/.test(value)) {
        return '请输入有效的身份证号'
      }
      return true
    })

    // 强密码验证
    this.addValidator('strongPassword', (value: any) => {
      if (typeof value !== 'string') return '必须是字符串'
      if (value.length < 8) return '密码至少8位'
      if (!/[a-z]/.test(value)) return '密码必须包含小写字母'
      if (!/[A-Z]/.test(value)) return '密码必须包含大写字母'
      if (!/\d/.test(value)) return '密码必须包含数字'
      if (!/[!@#$%^&*(),.?":{}|<>]/.test(value)) return '密码必须包含特殊字符'
      return true
    })

    // JSON 字符串验证
    this.addValidator('jsonString', (value: any) => {
      if (typeof value !== 'string') return '必须是字符串'
      try {
        JSON.parse(value)
        return true
      } catch {
        return '必须是有效的JSON字符串'
      }
    })

    // 颜色值验证
    this.addValidator('color', (value: any) => {
      if (typeof value !== 'string') return '必须是字符串'
      if (!/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(value)) {
        return '请输入有效的颜色值 (如: #FF0000)'
      }
      return true
    })

    // Base64 验证
    this.addValidator('base64', (value: any) => {
      if (typeof value !== 'string') return '必须是字符串'
      try {
        Buffer.from(value, 'base64').toString('base64') === value
        return true
      } catch {
        return '必须是有效的Base64字符串'
      }
    })
  }

  /**
   * 获取验证统计信息
   */
  getStats() {
    return {
      registeredSchemas: this.schemas.size,
      customValidators: this.validators.size
    }
  }

  /**
   * 清理所有注册的 Schema 和验证器
   */
  clear(): void {
    this.schemas.clear()
    this.validators.clear()
    this.emit('service:cleared')
  }
}

export {
  ZodSchemaWrapper,
  StringSchemaImpl,
  NumberSchemaImpl,
  BooleanSchemaImpl,
  ObjectSchemaImpl,
  ArraySchemaImpl,
  UnionSchemaImpl,
  OptionalSchemaImpl
}
