/**
 * Collection & Field Type Definitions
 * 数据模型元数据定义
 */

export enum FieldType {
  // === 基础类型 ===
  UID = 'uid',           // 主键
  String = 'string',     // 短文本
  Text = 'text',         // 长文本
  Number = 'number',     // 数字
  Boolean = 'boolean',   // 布尔值
  Date = 'date',         // 日期
  DateTime = 'datetime', // 日期时间
  Json = 'json',         // JSON 对象

  // === 选择类型 ===
  Select = 'select',
  MultiSelect = 'multiSelect',
  Checkbox = 'checkbox',       // 新增: 复选框 (等同于Boolean但UI不同)

  // === 文件类型 ===
  Attachment = 'attachment',

  // === 关联与聚合类型 ===
  Link = 'link',         // 关联关系 (Foreign Key)
  Lookup = 'lookup',     // 查找引用
  Rollup = 'rollup',          // 新增: 聚合字段

  // === 计算类型 ===
  Formula = 'formula',
  AutoNumber = 'autoNumber',   // 新增: 自动编号

  // === 格式化数值类型 === (新增)
  Currency = 'currency',       // 新增: 货币
  Percent = 'percent',         // 新增: 百分比
  Rating = 'rating',           // 新增: 评分 (1-5星)

  // === 特殊文本类型 === (新增)
  Phone = 'phone',             // 新增: 电话
  Email = 'email',             // 新增: 邮箱
  URL = 'url',                 // 新增: 链接

  // === 用户类型 === (新增)
  Member = 'member',           // 新增: 成员/用户选择

  // === 交互类型 === (新增)
  Button = 'button',           // 新增: 按钮 (触发动作)

  // === 系统字段 ===
  CreatedAt = 'createdAt',
  UpdatedAt = 'updatedAt',
  CreatedBy = 'createdBy',
  UpdatedBy = 'updatedBy'
}

export interface FieldOption {
  label: string;
  value: string | number;
  color?: string;
}

export interface FieldDefinition {
  name: string;          // 数据库字段名
  type: FieldType;       // 字段类型
  title?: string;        // 显示名称
  description?: string;
  
  // 约束
  primaryKey?: boolean;
  unique?: boolean;
  nullable?: boolean; // default true
  defaultValue?: any;

  // 类型特定配置
  options?: FieldOption[]; // for Select/MultiSelect
  target?: string;         // for Link (target collection name)
  formula?: string;        // for Formula
  
  // 新增字段的属性配置
  property?: Record<string, any>; // 通用属性字段，用于存储CurrencyFieldProperty等
}

export interface CollectionDefinition {
  name: string;          // 集合名称 (唯一标识)
  tableName: string;     // 物理表名
  title?: string;        // 显示名称
  fields: FieldDefinition[];
  
  // 索引配置等可后续扩展
  indexes?: string[][]; 
}