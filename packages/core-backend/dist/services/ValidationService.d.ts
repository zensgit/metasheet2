/**
 * 验证服务实现
 * 基于 Zod 提供强大的数据验证和转换功能
 */
import { z } from 'zod';
import { EventEmitter } from 'eventemitter3';
import type { ValidationService, ValidationSchema, ValidationResult, CustomValidator, DataTransformer, StringSchema, NumberSchema, BooleanSchema, ObjectSchema, ArraySchema, UnionSchema, OptionalSchema } from '../types/plugin';
/**
 * Zod Schema 包装器
 */
declare class ZodSchemaWrapper<T = any> implements ValidationSchema<T> {
    private zodSchema;
    constructor(zodSchema: z.ZodSchema<T>);
    parse(data: unknown): T;
    safeParse(data: unknown): ValidationResult<T>;
    transform<U>(transformer: (value: T) => U): ValidationSchema<U>;
    optional(): ValidationSchema<T | undefined>;
    nullable(): ValidationSchema<T | null>;
    default(value: T): ValidationSchema<T>;
}
/**
 * 字符串 Schema 实现
 */
declare class StringSchemaImpl extends ZodSchemaWrapper<string> implements StringSchema {
    private baseSchema;
    constructor(baseSchema?: z.ZodString);
    min(length: number): StringSchema;
    max(length: number): StringSchema;
    length(length: number): StringSchema;
    email(): StringSchema;
    url(): StringSchema;
    regex(pattern: RegExp): StringSchema;
    uuid(): StringSchema;
}
/**
 * 数字 Schema 实现
 */
declare class NumberSchemaImpl extends ZodSchemaWrapper<number> implements NumberSchema {
    private baseSchema;
    constructor(baseSchema?: z.ZodNumber);
    min(value: number): NumberSchema;
    max(value: number): NumberSchema;
    int(): NumberSchema;
    positive(): NumberSchema;
    negative(): NumberSchema;
    nonnegative(): NumberSchema;
}
/**
 * 布尔 Schema 实现
 */
declare class BooleanSchemaImpl extends ZodSchemaWrapper<boolean> implements BooleanSchema {
    constructor();
}
/**
 * 对象 Schema 实现
 */
declare class ObjectSchemaImpl<T> extends ZodSchemaWrapper<T> implements ObjectSchema<T> {
    private baseSchema;
    constructor(baseSchema?: z.ZodObject<any>);
    shape<S>(shape: {
        [K in keyof S]: ValidationSchema<S[K]>;
    }): ObjectSchema<S>;
    pick<K extends keyof T>(keys: K[]): ObjectSchema<Pick<T, K>>;
    omit<K extends keyof T>(keys: K[]): ObjectSchema<Omit<T, K>>;
    partial(): ObjectSchema<Partial<T>>;
    required(): ObjectSchema<Required<T>>;
    strict(): ObjectSchema<T>;
}
/**
 * 数组 Schema 实现
 */
declare class ArraySchemaImpl<T> extends ZodSchemaWrapper<T[]> implements ArraySchema<T> {
    private baseSchema;
    constructor(baseSchema?: z.ZodArray<any>);
    element<U>(schema: ValidationSchema<U>): ArraySchema<U>;
    min(length: number): ArraySchema<T>;
    max(length: number): ArraySchema<T>;
    length(length: number): ArraySchema<T>;
    nonempty(): ArraySchema<T>;
}
/**
 * 联合 Schema 实现
 */
declare class UnionSchemaImpl<T> extends ZodSchemaWrapper<T> implements UnionSchema<T> {
    private baseSchema;
    constructor(baseSchema: z.ZodUnion<any>);
    or<U>(schema: ValidationSchema<U>): UnionSchema<T | U>;
}
/**
 * 可选 Schema 实现
 */
declare class OptionalSchemaImpl<T> extends ZodSchemaWrapper<T | undefined> implements OptionalSchema<T> {
    constructor(schema: ValidationSchema<T>);
}
/**
 * 验证服务实现
 */
export declare class ValidationServiceImpl extends EventEmitter implements ValidationService {
    private schemas;
    private validators;
    private logger;
    constructor();
    validate<T>(data: unknown, schema: ValidationSchema<T>): Promise<ValidationResult<T>>;
    validateSync<T>(data: unknown, schema: ValidationSchema<T>): ValidationResult<T>;
    registerSchema<T>(name: string, schema: ValidationSchema<T>): void;
    getSchema<T>(name: string): ValidationSchema<T> | null;
    addValidator(name: string, validator: CustomValidator): void;
    getValidator(name: string): CustomValidator | null;
    transform<T>(data: unknown, transformer: DataTransformer<T>): Promise<T>;
    validateBatch<T>(items: unknown[], schema: ValidationSchema<T>): Promise<ValidationResult<T>[]>;
    string(): StringSchema;
    number(): NumberSchema;
    boolean(): BooleanSchema;
    object<T>(): ObjectSchema<T>;
    array<T>(): ArraySchema<T>;
    union<T>(): UnionSchema<T>;
    optional<T>(schema: ValidationSchema<T>): OptionalSchema<T>;
    /**
     * 创建自定义验证 Schema
     */
    custom<T>(validator: (data: unknown) => T | never): ValidationSchema<T>;
    /**
     * 创建枚举 Schema
     */
    enum<T extends string>(values: readonly T[]): ValidationSchema<T>;
    /**
     * 创建字面值 Schema
     */
    literal<T extends string | number | boolean>(value: T): ValidationSchema<T>;
    /**
     * 创建日期 Schema
     */
    date(): ValidationSchema<Date>;
    /**
     * 创建 JSON Schema（任意对象）
     */
    json(): ValidationSchema<any>;
    /**
     * 创建递归 Schema
     */
    lazy<T>(fn: () => ValidationSchema<T>): ValidationSchema<T>;
    /**
     * 预定义常用 Schema
     */
    getCommonSchemas(): {
        email: any;
        url: any;
        uuid: any;
        phoneNumber: any;
        positiveInteger: any;
        percentage: any;
        timestamp: any;
        iso8601: any;
        pagination: any;
        sorting: any;
        apiResponse: <T>(dataSchema: ValidationSchema<T>) => any;
    };
    private setupCommonValidators;
    /**
     * 获取验证统计信息
     */
    getStats(): {
        registeredSchemas: number;
        customValidators: number;
    };
    /**
     * 清理所有注册的 Schema 和验证器
     */
    clear(): void;
}
export { ZodSchemaWrapper, StringSchemaImpl, NumberSchemaImpl, BooleanSchemaImpl, ObjectSchemaImpl, ArraySchemaImpl, UnionSchemaImpl, OptionalSchemaImpl };
//# sourceMappingURL=ValidationService.d.ts.map