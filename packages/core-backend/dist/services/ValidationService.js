/**
 * 验证服务实现
 * 基于 Zod 提供强大的数据验证和转换功能
 */
// @ts-nocheck
import { z } from 'zod';
import { EventEmitter } from 'eventemitter3';
import { Logger } from '../core/logger';
/**
 * Zod Schema 包装器
 */
class ZodSchemaWrapper {
    zodSchema;
    constructor(zodSchema) {
        this.zodSchema = zodSchema;
    }
    parse(data) {
        return this.zodSchema.parse(data);
    }
    safeParse(data) {
        const result = this.zodSchema.safeParse(data);
        if (result.success) {
            return { success: true, data: result.data };
        }
        else {
            return {
                success: false,
                errors: result.error.errors.map(err => ({
                    path: err.path.map(String),
                    message: err.message,
                    code: err.code,
                    expected: err.expected,
                    received: err.received
                }))
            };
        }
    }
    transform(transformer) {
        return new ZodSchemaWrapper(this.zodSchema.transform(transformer));
    }
    optional() {
        return new ZodSchemaWrapper(this.zodSchema.optional());
    }
    nullable() {
        return new ZodSchemaWrapper(this.zodSchema.nullable());
    }
    default(value) {
        return new ZodSchemaWrapper(this.zodSchema.default(value));
    }
}
/**
 * 字符串 Schema 实现
 */
class StringSchemaImpl extends ZodSchemaWrapper {
    baseSchema;
    constructor(baseSchema = z.string()) {
        super(baseSchema);
        this.baseSchema = baseSchema;
    }
    min(length) {
        return new StringSchemaImpl(this.baseSchema.min(length));
    }
    max(length) {
        return new StringSchemaImpl(this.baseSchema.max(length));
    }
    length(length) {
        return new StringSchemaImpl(this.baseSchema.length(length));
    }
    email() {
        return new StringSchemaImpl(this.baseSchema.email());
    }
    url() {
        return new StringSchemaImpl(this.baseSchema.url());
    }
    regex(pattern) {
        return new StringSchemaImpl(this.baseSchema.regex(pattern));
    }
    uuid() {
        return new StringSchemaImpl(this.baseSchema.uuid());
    }
}
/**
 * 数字 Schema 实现
 */
class NumberSchemaImpl extends ZodSchemaWrapper {
    baseSchema;
    constructor(baseSchema = z.number()) {
        super(baseSchema);
        this.baseSchema = baseSchema;
    }
    min(value) {
        return new NumberSchemaImpl(this.baseSchema.min(value));
    }
    max(value) {
        return new NumberSchemaImpl(this.baseSchema.max(value));
    }
    int() {
        return new NumberSchemaImpl(this.baseSchema.int());
    }
    positive() {
        return new NumberSchemaImpl(this.baseSchema.positive());
    }
    negative() {
        return new NumberSchemaImpl(this.baseSchema.negative());
    }
    nonnegative() {
        return new NumberSchemaImpl(this.baseSchema.nonnegative());
    }
}
/**
 * 布尔 Schema 实现
 */
class BooleanSchemaImpl extends ZodSchemaWrapper {
    constructor() {
        super(z.boolean());
    }
}
/**
 * 对象 Schema 实现
 */
class ObjectSchemaImpl extends ZodSchemaWrapper {
    baseSchema;
    constructor(baseSchema = z.object({})) {
        super(baseSchema);
        this.baseSchema = baseSchema;
    }
    shape(shape) {
        const zodShape = {};
        for (const [key, schema] of Object.entries(shape)) {
            zodShape[key] = schema.zodSchema || schema;
        }
        return new ObjectSchemaImpl(z.object(zodShape));
    }
    pick(keys) {
        return new ObjectSchemaImpl(this.baseSchema.pick(Object.fromEntries(keys.map(k => [k, true]))));
    }
    omit(keys) {
        return new ObjectSchemaImpl(this.baseSchema.omit(Object.fromEntries(keys.map(k => [k, true]))));
    }
    partial() {
        return new ObjectSchemaImpl(this.baseSchema.partial());
    }
    required() {
        return new ObjectSchemaImpl(this.baseSchema.required());
    }
    strict() {
        return new ObjectSchemaImpl(this.baseSchema.strict());
    }
}
/**
 * 数组 Schema 实现
 */
class ArraySchemaImpl extends ZodSchemaWrapper {
    baseSchema;
    constructor(baseSchema = z.array(z.unknown())) {
        super(baseSchema);
        this.baseSchema = baseSchema;
    }
    element(schema) {
        const zodSchema = schema.zodSchema || schema;
        return new ArraySchemaImpl(z.array(zodSchema));
    }
    min(length) {
        return new ArraySchemaImpl(this.baseSchema.min(length));
    }
    max(length) {
        return new ArraySchemaImpl(this.baseSchema.max(length));
    }
    length(length) {
        return new ArraySchemaImpl(this.baseSchema.length(length));
    }
    nonempty() {
        return new ArraySchemaImpl(this.baseSchema.nonempty());
    }
}
/**
 * 联合 Schema 实现
 */
class UnionSchemaImpl extends ZodSchemaWrapper {
    baseSchema;
    constructor(baseSchema) {
        super(baseSchema);
        this.baseSchema = baseSchema;
    }
    or(schema) {
        const zodSchema = schema.zodSchema || schema;
        return new UnionSchemaImpl(z.union([this.baseSchema, zodSchema]));
    }
}
/**
 * 可选 Schema 实现
 */
class OptionalSchemaImpl extends ZodSchemaWrapper {
    constructor(schema) {
        const zodSchema = schema.zodSchema || schema;
        super(zodSchema.optional());
    }
}
/**
 * 验证服务实现
 */
export class ValidationServiceImpl extends EventEmitter {
    schemas = new Map();
    validators = new Map();
    logger;
    constructor() {
        super();
        this.logger = new Logger('ValidationService');
        // 注册一些常用的自定义验证器
        this.setupCommonValidators();
    }
    async validate(data, schema) {
        try {
            const result = schema.safeParse(data);
            this.emit('validation:completed', { data, schema, result });
            return result;
        }
        catch (error) {
            const errorResult = {
                success: false,
                errors: [{
                        path: [],
                        message: error.message,
                        code: 'validation_error'
                    }]
            };
            this.emit('validation:error', { data, schema, error });
            return errorResult;
        }
    }
    validateSync(data, schema) {
        try {
            const result = schema.safeParse(data);
            this.emit('validation:completed', { data, schema, result });
            return result;
        }
        catch (error) {
            const errorResult = {
                success: false,
                errors: [{
                        path: [],
                        message: error.message,
                        code: 'validation_error'
                    }]
            };
            this.emit('validation:error', { data, schema, error });
            return errorResult;
        }
    }
    registerSchema(name, schema) {
        this.schemas.set(name, schema);
        this.emit('schema:registered', { name, schema });
    }
    getSchema(name) {
        return this.schemas.get(name) || null;
    }
    addValidator(name, validator) {
        this.validators.set(name, validator);
        this.emit('validator:registered', { name, validator });
    }
    getValidator(name) {
        return this.validators.get(name) || null;
    }
    async transform(data, transformer) {
        try {
            const result = transformer(data);
            this.emit('transformation:completed', { data, result });
            return result;
        }
        catch (error) {
            this.logger.error('Data transformation failed', error);
            this.emit('transformation:error', { data, error });
            throw error;
        }
    }
    async validateBatch(items, schema) {
        const results = await Promise.all(items.map(item => this.validate(item, schema)));
        this.emit('validation:batch:completed', { items, schema, results });
        return results;
    }
    // Schema builders
    string() {
        return new StringSchemaImpl();
    }
    number() {
        return new NumberSchemaImpl();
    }
    boolean() {
        return new BooleanSchemaImpl();
    }
    object() {
        return new ObjectSchemaImpl();
    }
    array() {
        return new ArraySchemaImpl();
    }
    union() {
        // 创建一个基础的联合类型，需要调用 or() 来添加选项
        return new UnionSchemaImpl(z.union([z.never(), z.never()]));
    }
    optional(schema) {
        return new OptionalSchemaImpl(schema);
    }
    /**
     * 创建自定义验证 Schema
     */
    custom(validator) {
        return new ZodSchemaWrapper(z.custom(validator));
    }
    /**
     * 创建枚举 Schema
     */
    enum(values) {
        return new ZodSchemaWrapper(z.enum(values));
    }
    /**
     * 创建字面值 Schema
     */
    literal(value) {
        return new ZodSchemaWrapper(z.literal(value));
    }
    /**
     * 创建日期 Schema
     */
    date() {
        return new ZodSchemaWrapper(z.date());
    }
    /**
     * 创建 JSON Schema（任意对象）
     */
    json() {
        return new ZodSchemaWrapper(z.any());
    }
    /**
     * 创建递归 Schema
     */
    lazy(fn) {
        return new ZodSchemaWrapper(z.lazy(() => {
            const schema = fn();
            return schema.zodSchema || schema;
        }));
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
                sortOrder: this.enum(['asc', 'desc']).default('asc')
            }),
            // API 响应格式
            apiResponse: (dataSchema) => this.object().shape({
                success: this.boolean(),
                data: dataSchema.optional(),
                error: this.string().optional(),
                message: this.string().optional(),
                timestamp: this.string().optional()
            })
        };
    }
    setupCommonValidators() {
        // 中国手机号验证
        this.addValidator('chinesePhone', (value) => {
            if (typeof value !== 'string')
                return '必须是字符串';
            if (!/^1[3-9]\d{9}$/.test(value))
                return '请输入有效的中国手机号';
            return true;
        });
        // 中国身份证号验证
        this.addValidator('chineseIdCard', (value) => {
            if (typeof value !== 'string')
                return '必须是字符串';
            if (!/^[1-9]\d{5}(19|20)\d{2}((0[1-9])|(1[0-2]))(([0-2][1-9])|10|20|30|31)\d{3}[0-9Xx]$/.test(value)) {
                return '请输入有效的身份证号';
            }
            return true;
        });
        // 强密码验证
        this.addValidator('strongPassword', (value) => {
            if (typeof value !== 'string')
                return '必须是字符串';
            if (value.length < 8)
                return '密码至少8位';
            if (!/[a-z]/.test(value))
                return '密码必须包含小写字母';
            if (!/[A-Z]/.test(value))
                return '密码必须包含大写字母';
            if (!/\d/.test(value))
                return '密码必须包含数字';
            if (!/[!@#$%^&*(),.?":{}|<>]/.test(value))
                return '密码必须包含特殊字符';
            return true;
        });
        // JSON 字符串验证
        this.addValidator('jsonString', (value) => {
            if (typeof value !== 'string')
                return '必须是字符串';
            try {
                JSON.parse(value);
                return true;
            }
            catch {
                return '必须是有效的JSON字符串';
            }
        });
        // 颜色值验证
        this.addValidator('color', (value) => {
            if (typeof value !== 'string')
                return '必须是字符串';
            if (!/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/.test(value)) {
                return '请输入有效的颜色值 (如: #FF0000)';
            }
            return true;
        });
        // Base64 验证
        this.addValidator('base64', (value) => {
            if (typeof value !== 'string')
                return '必须是字符串';
            try {
                Buffer.from(value, 'base64').toString('base64') === value;
                return true;
            }
            catch {
                return '必须是有效的Base64字符串';
            }
        });
    }
    /**
     * 获取验证统计信息
     */
    getStats() {
        return {
            registeredSchemas: this.schemas.size,
            customValidators: this.validators.size
        };
    }
    /**
     * 清理所有注册的 Schema 和验证器
     */
    clear() {
        this.schemas.clear();
        this.validators.clear();
        this.emit('service:cleared');
    }
}
export { ZodSchemaWrapper, StringSchemaImpl, NumberSchemaImpl, BooleanSchemaImpl, ObjectSchemaImpl, ArraySchemaImpl, UnionSchemaImpl, OptionalSchemaImpl };
//# sourceMappingURL=ValidationService.js.map