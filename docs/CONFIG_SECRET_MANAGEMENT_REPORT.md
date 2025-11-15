# 配置和密钥管理系统开发报告

## 概述
成功实现了统一的配置和密钥管理系统，提供多源配置、加密存储、密钥轮换等企业级功能。

## 系统架构

### 1. 配置源优先级
按优先级从高到低：
1. **环境变量** (priority: 100)
2. **配置文件** (priority: 50)
3. **数据库** (priority: 30)
4. **默认值** (priority: 0)

### 2. 核心组件

#### ConfigService
- 统一的配置访问接口
- 多源配置合并
- 缓存机制
- 配置验证

#### SecretManager
- AES-256-GCM 加密
- 密钥轮换支持
- 安全审计日志
- 自动过期清理

## 功能特性

### 1. 多源配置管理
```typescript
// 从任意源获取配置
const port = await config.get<number>('app.port', 8900)
const dbUrl = await config.get<string>('database.url')

// 设置配置到指定源
await config.set('app.name', 'MyApp', 'database')

// 获取所有配置
const allConfigs = await config.getAll()
```

### 2. 环境变量支持
- 自动转换命名规则: `app.port` ↔ `APP_PORT`
- 支持 JSON 值解析
- `METASHEET_` 前缀识别

### 3. 配置文件支持
- 支持 YAML 和 JSON 格式
- 热重载能力
- 嵌套键值访问

### 4. 数据库配置
- JSONB 存储
- 加密支持
- 变更历史追踪
- 缓存优化（TTL: 60秒）

### 5. 密钥管理
```typescript
const secretManager = new SecretManager()

// 加密
const encrypted = await secretManager.encrypt('sensitive-data')

// 解密
const decrypted = await secretManager.decrypt(encrypted)

// 密钥轮换
await secretManager.rotateKey(oldKey, newKey)
```

## 数据库架构

### 1. system_configs 表
| 字段 | 类型 | 描述 |
|-----|------|------|
| id | TEXT | 主键 |
| key | VARCHAR(255) | 配置键（唯一） |
| value | JSONB | 配置值 |
| description | TEXT | 描述 |
| category | VARCHAR(100) | 分类 |
| is_encrypted | BOOLEAN | 是否加密 |
| is_secret | BOOLEAN | 是否为密钥 |

### 2. secrets 表
| 字段 | 类型 | 描述 |
|-----|------|------|
| id | TEXT | 主键 |
| name | VARCHAR(255) | 密钥名称（唯一） |
| encrypted_value | TEXT | 加密值 |
| key_version | INTEGER | 密钥版本 |
| rotation_policy | JSONB | 轮换策略 |
| expires_at | TIMESTAMP | 过期时间 |

### 3. secret_access_logs 表
审计所有密钥访问操作

### 4. config_history 表
记录配置变更历史

## 安全特性

### 1. 加密算法
- **算法**: AES-256-GCM
- **密钥派生**: PBKDF2 with SHA-256
- **迭代次数**: 100,000
- **IV**: 16 bytes random
- **Auth Tag**: 16 bytes

### 2. 密钥轮换
```sql
-- 执行密钥轮换
SELECT rotate_encryption_key(1, 2);
```

### 3. 访问审计
- 所有密钥访问都记录日志
- 包含 IP、User Agent、时间戳
- 失败尝试也会记录

### 4. 自动清理
```sql
-- 清理过期密钥
SELECT cleanup_expired_secrets();
```

## 使用示例

### 1. 基本配置读取
```typescript
import { config } from './services/ConfigService'

// 读取配置
const appPort = await config.get<number>('app.port')
const dbConfig = await config.get('database')

// 带默认值
const timeout = await config.get<number>('api.timeout', 30000)
```

### 2. 环境变量覆盖
```bash
# 覆盖配置
export METASHEET_APP_PORT=3000
export METASHEET_DATABASE_URL="postgresql://..."
```

### 3. 配置文件 (config.yaml)
```yaml
app:
  name: MetaSheet
  port: 8900

database:
  host: localhost
  port: 5432
  name: metasheet

logging:
  level: info
  format: json
```

### 4. 数据库配置
```typescript
// 保存配置到数据库
await config.set('feature.newUI', true, 'database')

// 加密敏感配置
const secretManager = new SecretManager()
const encrypted = await secretManager.encrypt('api-key-123')
await config.set('external.apiKey', `enc:${encrypted}`, 'database')
```

### 5. 配置验证
```typescript
const validation = await config.validate()
if (!validation.valid) {
  console.error('Configuration errors:', validation.errors)
  process.exit(1)
}
```

## 迁移指南

### 1. 运行数据库迁移
```bash
npm run migrate:up
```

### 2. 设置环境变量
```bash
# 必需的环境变量
export ENCRYPTION_KEY="your-32-byte-key-here"
export ENCRYPTION_SALT="your-salt-here"
export CONFIG_FILE="./config.yaml"  # 可选
```

### 3. 初始化配置
```typescript
import { config } from './services/ConfigService'

// 应用启动时
async function initApp() {
  // 验证配置
  const validation = await config.validate()
  if (!validation.valid) {
    throw new Error(`Config validation failed: ${validation.errors.join(', ')}`)
  }

  // 加载配置
  const appConfig = await config.getAll()
  console.log('Loaded configuration:', appConfig)
}
```

## 默认配置

系统提供了合理的默认配置：
- **应用端口**: 8900
- **数据库连接池**: min=2, max=10
- **会话超时**: 24小时
- **速率限制**: 100请求/15分钟
- **上传大小**: 10MB
- **日志级别**: info

## 性能优化

### 1. 缓存策略
- 数据库配置缓存 60 秒
- 文件配置懒加载
- 环境变量直接读取

### 2. 批量操作
```typescript
// 批量获取配置
const configs = await config.getAll()

// 按类别获取
const dbConfigs = configs.database
const appConfigs = configs.app
```

### 3. 配置重载
```typescript
// 清除缓存并重新加载
await config.reload()
```

## 监控和告警

### 1. 指标收集
- 配置加载时间
- 缓存命中率
- 加密/解密性能

### 2. 健康检查
```typescript
app.get('/health/config', async (req, res) => {
  const validation = await config.validate()
  res.json({
    healthy: validation.valid,
    errors: validation.errors
  })
})
```

## 最佳实践

### 1. 环境分离
- 开发环境使用文件配置
- 生产环境使用环境变量
- 密钥始终使用加密存储

### 2. 配置命名
- 使用点号分隔的命名空间
- 例如: `app.feature.enabled`

### 3. 密钥管理
- 定期轮换密钥
- 设置过期时间
- 审计所有访问

### 4. 备份和恢复
- 定期备份 system_configs 表
- 保留配置变更历史
- 测试恢复流程

## 故障排查

### 1. 配置未生效
- 检查配置源优先级
- 验证环境变量命名
- 查看配置缓存

### 2. 加密错误
- 验证 ENCRYPTION_KEY 设置
- 检查密钥版本匹配
- 查看 secret_access_logs

### 3. 性能问题
- 启用配置缓存
- 减少配置查询频率
- 使用批量获取

## 总结

成功实现了完整的配置和密钥管理系统：
- ✅ 多源配置支持（环境变量、文件、数据库、默认值）
- ✅ AES-256-GCM 加密
- ✅ 密钥轮换机制
- ✅ 审计日志
- ✅ 配置历史追踪
- ✅ 缓存优化
- ✅ 配置验证

该系统为 MetaSheet 提供了企业级的配置管理能力，支持安全、灵活、可追溯的配置管理。