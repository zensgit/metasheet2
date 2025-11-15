# Phase 3 设计总结文档

**文档版本**: 1.0
**创建日期**: 2025-10-30
**作者**: Phase 3 架构团队
**状态**: ✅ 完成

---

## 📋 文档概述

本文档全面总结了 Phase 3 优化实施的设计决策、架构选择、实施策略和最佳实践。涵盖了从 CI 优化到类型安全治理的完整设计思路。

**适用读者**:
- 架构师和技术 Leader
- 前端/后端开发团队
- DevOps 和 CI/CD 工程师
- 新加入项目的开发者

---

## 🎯 设计目标

### 核心目标

#### 1. 渐进式类型安全 (Progressive Type Safety)
**目标**: 在不破坏现有功能的前提下，逐步提升代码库的类型安全性

**设计原则**:
- "窄口子"策略：优先修复高影响、低风险的类型错误
- 增量改进：batch-by-batch 而不是 all-at-once
- 向后兼容：保持现有 API 不变

**预期成果**:
- 类型覆盖率从 40% 提升到 80%+
- TypeScript strict mode 逐步启用
- 减少 runtime 类型错误 50%+

---

#### 2. CI/CD 效率优化 (CI/CD Efficiency)
**目标**: 减少 CI 执行时间，提高开发者体验

**设计原则**:
- Path-ignore: 仅在相关文件变更时运行检查
- 必要检查收敛: 从 6+ 个减少到 4 个核心检查
- 并行执行: 无依赖的检查并行运行

**预期成果**:
- Docs-only PR: 从 5 分钟减少到 30 秒
- 平均 PR CI 时间: 减少 30%
- 开发者等待时间: 显著改善

---

#### 3. 数据库迁移可靠性 (Migration Reliability)
**目标**: 确保所有迁移幂等、可重放、可审计

**设计原则**:
- Idempotency: 所有迁移可安全重复执行
- Self-documenting: 迁移文件清晰表达意图
- Health checks: 自动化迁移健康检查

**预期成果**:
- Migration Replay 通过率: 100%
- MIGRATION_EXCLUDE 清空
- Zero production migration failures

---

#### 4. 开发者体验提升 (Developer Experience)
**目标**: 提供出色的类型提示、错误信息和开发工具

**设计原则**:
- IDE-first: 优先考虑 IDE 支持和自动完成
- Early feedback: 尽早在开发阶段发现问题
- Clear documentation: 清晰的使用文档和示例

**预期成果**:
- IDE 自动完成准确率: 90%+
- 类型错误的清晰度: 显著提升
- 新开发者上手时间: 减少 50%

---

## 🏗️ 架构设计

### 1. 类型安全架构

#### ApiResponse<T> 包装器模式

**设计决策**: 统一所有 API 响应格式

```typescript
interface ApiResponse<T> {
  success: boolean
  data: T | null
  error?: {
    code: string
    message: string
  }
  meta?: {
    timestamp?: string
    requestId?: string
  }
}
```

**优势**:
- ✅ 统一错误处理
- ✅ 类型安全的数据访问
- ✅ 强制错误处理 (success check)
- ✅ 可扩展的元数据支持

**权衡**:
- ⚠️ 增加了一层包装
- ⚠️ 需要更新现有 API 调用

**实施策略**: 渐进式迁移
1. 新 API 强制使用
2. 旧 API 逐步迁移
3. 提供兼容层过渡

---

#### 类型守卫模式 (Type Guards)

**设计决策**: 提供类型守卫函数而不是类型断言

```typescript
// ✅ Good: Type guard
function isApiSuccess<T>(response: ApiResponse<T>): response is ApiSuccessResponse<T> {
  return response.success === true && response.data !== null
}

// ❌ Bad: Type assertion
const data = (response as ApiSuccessResponse<T>).data
```

**优势**:
- ✅ Runtime 类型检查
- ✅ 类型narrowing
- ✅ 避免 unsafe 类型断言

**实施位置**:
- `utils/http.ts`
- 各个 service 层
- Store getters

---

#### 集中类型定义 (Centralized Types)

**设计决策**: 将类型定义集中在专门的 types 文件中

**文件组织**:
```
src/
├── stores/
│   └── types.ts          # Store 类型定义
├── router/
│   └── types.ts          # Router 类型定义
├── types/
│   ├── api.ts            # API 相关类型
│   ├── views.ts          # View 相关类型
│   └── entities.ts       # 实体类型
```

**优势**:
- ✅ 单一数据源 (Single Source of Truth)
- ✅ 易于维护和更新
- ✅ 避免循环依赖
- ✅ 便于重用

**命名约定**:
- Interface: PascalCase (e.g., `UserState`)
- Type alias: PascalCase (e.g., `ViewType`)
- Enums: PascalCase (e.g., `AppRouteNames`)

---

### 2. CI/CD 架构

#### 分支保护策略

**设计决策**: 4 个核心检查 + 多个信息性检查

**必需检查** (阻塞合并):
1. **Migration Replay**: 最关键，确保迁移完整性
2. **lint-type-test-build**: 前端构建和质量
3. **smoke**: 基本功能验证
4. **typecheck**: TypeScript 类型检查 (Phase 3 新增)

**信息性检查** (不阻塞):
- v2-observability-strict
- Observability E2E
- scan (security)

**设计原则**:
```yaml
必需检查选择标准:
  - 高信噪比: 失败必然表示真实问题
  - 快速执行: < 5 分钟
  - 稳定性高: 无 flaky tests
  - 业务关键: 直接影响生产质量
```

**权衡分析**:
| 决策 | 优势 | 劣势 | 缓解措施 |
|------|------|------|---------|
| 减少必需检查 | 更快合并速度 | 可能错过问题 | 强化信息性检查 |
| 添加 typecheck | 类型安全保障 | 增加 CI 时间 | Path-ignore 优化 |
| 移除 observability | 减少阻塞 | 观测性下降 | 保留为信息性检查 |

---

#### Path-Ignore 优化

**设计决策**: 根据文件路径智能跳过不相关的检查

```yaml
# .github/workflows/v2-web-typecheck.yml
on:
  pull_request:
    paths-ignore:
      - 'docs/**'
      - '*.md'
      - 'claudedocs/**'
      - 'scripts/ci/**'
```

**优势**:
- ✅ Docs-only PR 从 5 分钟减少到 30 秒
- ✅ 减少不必要的 CI 资源消耗
- ✅ 开发者体验改善

**实施策略**:
1. 分析历史 PR 的触发模式
2. 识别高频率低价值触发
3. 添加 path-ignore 规则
4. 监控误跳过率 (目标 < 1%)

---

#### 声明式配置管理

**设计决策**: 使用 JSON 配置 + 自动化脚本管理分支保护

**架构**:
```
claudedocs/policies/
├── branch-protection.json    # 配置（版本控制）
├── apply-branch-protection.sh # 应用脚本
└── BRANCH_PROTECTION.md      # 操作手册
```

**配置示例**:
```json
{
  "version": "2.0",
  "config": {
    "strict": true,
    "contexts": ["Migration Replay", "typecheck", ...]
  },
  "change_log": [
    {
      "date": "2025-10-29",
      "action": "Added typecheck",
      "reason": "Phase 3 type safety",
      "pr": "#337"
    }
  ]
}
```

**优势**:
- ✅ 版本控制的配置
- ✅ 可审计的变更历史
- ✅ 自动化应用
- ✅ 易于回滚

**设计模式**: Infrastructure as Code (IaC)

---

### 3. 迁移架构

#### TypeScript 优先策略

**设计决策**: 新迁移优先使用 TypeScript (Kysely)

**对比**:
| 特性 | SQL | TypeScript (Kysely) |
|------|-----|---------------------|
| 类型安全 | ❌ 无 | ✅ 完全类型安全 |
| IDE 支持 | ⚠️ 有限 | ✅ 完整自动完成 |
| 重构友好 | ❌ 困难 | ✅ 自动重构 |
| 学习曲线 | ✅ 熟悉 | ⚠️ 需要学习 |
| 复杂查询 | ✅ 直观 | ⚠️ 需要 API 理解 |

**决策**: 混合策略
- 简单迁移 (CREATE TABLE): TypeScript
- 复杂迁移 (分区表, 触发器): SQL
- 数据迁移: TypeScript (batch processing)

---

#### 幂等性模式 (Idempotency Patterns)

**设计决策**: 所有迁移必须可重复执行

**实现模式**:

**模式1: hasTable/hasColumn 检查**
```typescript
export async function up(db: Kysely<any>): Promise<void> {
  const exists = await db.schema.hasTable('users').execute()
  if (exists) return

  await db.schema.createTable('users')...
}
```

**模式2: IF NOT EXISTS**
```sql
CREATE TABLE IF NOT EXISTS users (...);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
```

**模式3: 条件 FK 添加**
```typescript
// Only add FK if referenced table exists
if (await db.schema.hasTable('roles').execute()) {
  await addForeignKeyIfNotExists(...)
}
```

**优势**:
- ✅ 安全的 Migration Replay
- ✅ 开发环境可随意重建
- ✅ 生产环境容错性高

---

#### 迁移模式库 (Pattern Library)

**设计决策**: 提供可重用的迁移辅助函数

**架构**:
```
src/db/migrations/
├── _template.ts      # 迁移模板
├── _patterns.ts      # 模式库
└── YYYYMMDDHHMMSS_*.ts  # 实际迁移
```

**提供的模式**:
1. `addColumnIfNotExists()` - 安全添加列
2. `createIndexIfNotExists()` - 安全创建索引
3. `migrateDataSafely()` - 批量数据迁移
4. `createTableWithDefaults()` - 标准表创建
5. ... 9 个核心模式

**设计原则**:
- DRY (Don't Repeat Yourself)
- 封装复杂性
- 提供安全默认值
- 优秀的错误处理

---

### 4. 前端架构

#### HTTP 客户端架构

**设计决策**: 单例模式 + 拦截器链

**架构图**:
```
Request Flow:
  [Component]
       ↓
  [http.get<T>()]
       ↓
  [Request Interceptor]
    - Add JWT token
    - Add request ID
    - Show loading
       ↓
  [Axios]
       ↓
  [Response Interceptor]
    - Hide loading
    - Handle errors
    - Retry logic
       ↓
  [ApiResponse<T>]
       ↓
  [Component]
```

**关键特性**:
- ✅ 自动 JWT 注入
- ✅ 请求去重
- ✅ 自动重试 (exponential backoff)
- ✅ 全局 loading 状态
- ✅ 统一错误处理

**单例实现**:
```typescript
class HttpClient {
  private static instance: HttpClient

  private constructor() { ... }

  public static getInstance(): HttpClient {
    if (!HttpClient.instance) {
      HttpClient.instance = new HttpClient()
    }
    return HttpClient.instance
  }
}

export const http = HttpClient.getInstance()
```

---

#### Store 类型架构

**设计决策**: 完整类型定义 + 辅助类型

**类型层次**:
```typescript
// 1. State 类型
interface UserState {
  currentUser: User | null
  isAuthenticated: boolean
}

// 2. Getters 类型
interface UserGetters {
  userName: (state: UserState) => string
}

// 3. Actions 类型
interface UserActions {
  login(credentials: LoginCredentials): Promise<void>
}

// 4. Store 组合类型
type UserStore = {
  $id: 'user'
  $state: UserState
  $getters: UserGetters
  $actions: UserActions
}
```

**使用模式**:
```typescript
import { defineStore } from 'pinia'
import type { UserState, UserGetters, UserActions } from './types'

export const useUserStore = defineStore<'user', UserState, UserGetters, UserActions>('user', {
  state: (): UserState => ({ ... }),
  getters: { ... },
  actions: { ... }
})
```

**优势**:
- ✅ 完整的类型推断
- ✅ IDE 自动完成
- ✅ 重构安全
- ✅ 文档即代码

---

#### Router 类型架构

**设计决策**: Enum + 映射类型实现类型安全导航

**类型架构**:
```typescript
// 1. Route names enum
enum AppRouteNames {
  DASHBOARD = 'dashboard',
  USER_PROFILE = 'user-profile'
}

// 2. Route params mapping
interface AppRouteParams {
  [AppRouteNames.DASHBOARD]: Record<string, never>
  [AppRouteNames.USER_PROFILE]: { id: string }
}

// 3. Type-safe navigation
router.push({
  name: AppRouteNames.USER_PROFILE,
  params: { id: '123' }  // ✅ Type checked!
})
```

**高级特性**:
```typescript
// Conditional params (optional vs required)
type RouteNavigation<Name extends AppRouteNames> = {
  name: Name
} & (keyof AppRouteParams[Name] extends never
  ? { params?: never }
  : { params: AppRouteParams[Name] })
```

**优势**:
- ✅ 编译时路由验证
- ✅ 参数类型检查
- ✅ 防止拼写错误
- ✅ 重构时自动更新

---

## 🎨 设计模式

### 1. 渐进式增强 (Progressive Enhancement)

**应用场景**: 类型系统、API 改进、功能升级

**原则**:
- 向后兼容优先
- 新功能可选启用
- 旧代码逐步迁移

**示例**: ApiResponse 迁移
```typescript
// Phase 1: 新 API 使用 ApiResponse
export async function createUser(data: CreateUserDTO): Promise<ApiResponse<User>> {
  return http.post<User>('/api/users', data)
}

// Phase 2: 兼容层
export async function createUserLegacy(data: any): Promise<User> {
  const response = await createUser(data)
  if (response.success) return response.data!
  throw new Error(response.error?.message)
}

// Phase 3: 移除兼容层 (所有调用方迁移后)
```

---

### 2. 工厂模式 (Factory Pattern)

**应用场景**: 迁移创建、配置对象

**示例**: 迁移模式工厂
```typescript
class MigrationFactory {
  static createTable(name: string, builder: TableBuilder): Migration {
    return {
      async up(db) {
        const exists = await db.schema.hasTable(name).execute()
        if (exists) return
        await builder.build(db.schema.createTable(name))
      },
      async down(db) {
        await db.schema.dropTable(name).ifExists().execute()
      }
    }
  }
}
```

---

### 3. 策略模式 (Strategy Pattern)

**应用场景**: 错误重试策略、缓存策略

**示例**: 重试策略
```typescript
interface RetryStrategy {
  shouldRetry(attempt: number, error: Error): boolean
  getDelay(attempt: number): number
}

class ExponentialBackoffStrategy implements RetryStrategy {
  shouldRetry(attempt: number) {
    return attempt < 3
  }

  getDelay(attempt: number) {
    return Math.pow(2, attempt) * 1000  // 1s, 2s, 4s
  }
}

class HttpClient {
  constructor(private retryStrategy: RetryStrategy) {}

  async request(config: RequestConfig) {
    let attempt = 0
    while (true) {
      try {
        return await this.execute(config)
      } catch (error) {
        if (!this.retryStrategy.shouldRetry(attempt, error)) {
          throw error
        }
        await this.delay(this.retryStrategy.getDelay(attempt))
        attempt++
      }
    }
  }
}
```

---

### 4. 装饰器模式 (Decorator Pattern)

**应用场景**: HTTP 拦截器、Store 插件

**示例**: HTTP 拦截器
```typescript
interface RequestInterceptor {
  onRequest(config: RequestConfig): RequestConfig
}

class JWTInterceptor implements RequestInterceptor {
  onRequest(config: RequestConfig) {
    const token = localStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  }
}

class HttpClient {
  private interceptors: RequestInterceptor[] = []

  use(interceptor: RequestInterceptor) {
    this.interceptors.push(interceptor)
  }

  async request(config: RequestConfig) {
    let finalConfig = config
    for (const interceptor of this.interceptors) {
      finalConfig = interceptor.onRequest(finalConfig)
    }
    return this.execute(finalConfig)
  }
}
```

---

### 5. 观察者模式 (Observer Pattern)

**应用场景**: Loading 状态、事件总线

**示例**: Loading 状态管理
```typescript
class LoadingManager {
  private count = 0
  private listeners: Array<(loading: boolean) => void> = []

  subscribe(listener: (loading: boolean) => void) {
    this.listeners.push(listener)
  }

  startLoading() {
    this.count++
    if (this.count === 1) {
      this.notify(true)
    }
  }

  stopLoading() {
    this.count = Math.max(0, this.count - 1)
    if (this.count === 0) {
      this.notify(false)
    }
  }

  private notify(loading: boolean) {
    this.listeners.forEach(listener => listener(loading))
  }
}
```

---

## 🔧 实施策略

### 1. "窄口子"策略 (Narrow Gate Strategy)

**定义**: 优先修复高影响、低风险的问题

**决策矩阵**:
```
Impact vs Risk:

High Impact ↑    ┌─────────┬─────────┐
                 │  P0     │  P1     │
                 │  修复   │  计划   │
                 ├─────────┼─────────┤
Low Impact  ↓    │  P2     │  忽略   │
                 │  延后   │         │
                 └─────────┴─────────┘
                 Low Risk → High Risk
```

**应用**:
- PR #337 typecheck: 先修复 P0 错误 (23个 → 0个)
- 类型迁移: 先修复关键路径文件
- 迁移修复: 先修复 Phase 2 引入的问题

**优势**:
- ✅ 快速看到成效
- ✅ 降低回归风险
- ✅ 持续交付价值

---

### 2. Batch-by-Batch 策略

**定义**: 将大型改进分解为可管理的批次

**批次划分原则**:
- 每个batch: 3-5天工作量
- 独立可测试
- 可独立发布
- 有明确成果

**Phase 3 Batch 划分**:
```yaml
Batch 1 (Week 1-2):
  - DTO typing basics
  - Core type definitions
  - PR #337, #338

Batch 2 (Week 3-4):
  - Store types adoption
  - Router types adoption
  - Migration fixes (P0)

Batch 3 (Week 5-6):
  - Advanced types
  - Migration fixes (P1)
  - UI smoke tests

Batch 4 (Week 7):
  - Polish and cleanup
  - Documentation
  - Migration fixes (P2)
```

---

### 3. 测试驱动实施 (Test-Driven Implementation)

**流程**:
```
1. Write test (will fail)
      ↓
2. Implement feature
      ↓
3. Run test (should pass)
      ↓
4. Refactor
      ↓
5. Run test (should still pass)
```

**应用场景**:
- 迁移模式库函数
- HTTP 客户端功能
- Type guard 函数

**示例**: Type guard TDD
```typescript
// 1. Test first
describe('isApiSuccess', () => {
  it('should return true for success response', () => {
    const response: ApiResponse<User> = {
      success: true,
      data: { id: '1', name: 'John' }
    }
    expect(isApiSuccess(response)).toBe(true)
  })
})

// 2. Implementation
export function isApiSuccess<T>(
  response: ApiResponse<T>
): response is ApiSuccessResponse<T> {
  return response.success === true && response.data !== null
}

// 3. Verify test passes
// 4. Refactor if needed
```

---

### 4. 文档驱动开发 (Documentation-Driven Development)

**流程**:
```
1. Write documentation (usage examples)
      ↓
2. Design API based on ideal usage
      ↓
3. Implement to match documentation
      ↓
4. Update documentation with edge cases
```

**优势**:
- ✅ API 设计以用户为中心
- ✅ 文档永远最新
- ✅ 使用案例驱动设计

**示例**: HTTP 客户端文档
```typescript
/**
 * Unified HTTP Client
 *
 * @example
 * ```typescript
 * // GET request
 * const response = await http.get<User[]>('/api/users')
 * if (isApiSuccess(response)) {
 *   console.log(response.data)  // typed as User[]
 * }
 *
 * // POST request
 * const response = await http.post<User>('/api/users', userData)
 * ```
 */
export class HttpClient { ... }
```

---

## 📊 质量保障

### 1. 类型覆盖率指标

**目标设定**:
```yaml
Current (Phase 2): 40%
Phase 3 Target:    80%+

Breakdown:
  - Core types (src/types/):        100%
  - Store types (src/stores/):       95%
  - Router types (src/router/):      95%
  - Components (src/components/):    70%
  - Services (src/services/):        85%
  - Utils (src/utils/):              90%
```

**测量方式**:
```bash
# 使用 TypeScript 编译器统计
tsc --noEmit --strictNullChecks --strict 2>&1 |
  grep "error TS" |
  wc -l
```

---

### 2. CI 性能指标

**关键指标 (KPIs)**:
```yaml
PR CI Time:
  - P50: < 3 minutes
  - P95: < 8 minutes
  - P99: < 15 minutes

Check Pass Rates:
  - Migration Replay: > 95%
  - typecheck:        > 90%
  - smoke:            > 85%

Flaky Test Rate:
  - Target: < 5%
  - Action threshold: > 10% (investigate)
```

**监控**:
```bash
# 监控最近 30 天的 CI 性能
gh run list --limit 1000 --json conclusion,createdAt,updatedAt |
  jq '[.[] | {duration: ((.updatedAt | fromdateiso8601) - (.createdAt | fromdateiso8601)), conclusion}] |
      group_by(.conclusion) |
      map({conclusion: .[0].conclusion, avg_duration: (map(.duration) | add / length)})'
```

---

### 3. 迁移健康指标

**目标**:
```yaml
Migration Replay Success: 100%
MIGRATION_EXCLUDE Count:   0
SQL Linter Warnings:       0
Idempotency Violations:    0
```

**检查清单**:
- [ ] 所有迁移通过 replay 测试
- [ ] 所有迁移通过 SQL linter
- [ ] 所有迁移有 up/down 实现
- [ ] 所有迁移有测试覆盖
- [ ] 所有迁移有文档说明

---

### 4. 代码审查标准

**类型安全检查**:
```yaml
必须:
  - [ ] 无 any 类型 (除非有 @ts-expect-error 说明)
  - [ ] 所有函数参数有类型
  - [ ] 所有 API 响应使用 ApiResponse<T>
  - [ ] 所有可选属性使用 ? 或 | undefined

推荐:
  - [ ] 使用类型守卫而非类型断言
  - [ ] 复杂类型有 JSDoc 说明
  - [ ] 使用 const assertions 增强类型推断
```

**迁移检查**:
```yaml
必须:
  - [ ] 使用 IF NOT EXISTS / hasTable 检查
  - [ ] 有 up 和 down 实现
  - [ ] 通过 SQL linter
  - [ ] 本地测试通过两次执行 (幂等性)

推荐:
  - [ ] 使用迁移模式库函数
  - [ ] 有内联注释说明意图
  - [ ] 复杂迁移有测试覆盖
```

---

## 🚀 实施时间线

### Week 1-2: 基础设施 (P0)
**目标**: 工具就绪,CI 优化

**交付物**:
- ✅ 分支保护配置应用
- ✅ SQL Linter 修复和应用
- ✅ HTTP 客户端模板创建
- ✅ Store 类型模板创建
- ✅ Router 类型模板创建
- ✅ 迁移模式库创建

**成功标准**:
- CI 平均时间减少 20%
- SQL 迁移 100% 通过 linter
- 类型模板可用

---

### Week 3-4: 类型集成 (P1)
**目标**: 前端类型全面应用

**任务**:
- [ ] 集成 HTTP 客户端到所有 API 调用
- [ ] 应用 Store 类型到所有 stores
- [ ] 应用 Router 类型到所有导航
- [ ] 修复 PR #337 typecheck 错误
- [ ] 修复 5 个 P1 迁移

**成功标准**:
- PR #337 合并
- 类型覆盖率达到 60%
- MIGRATION_EXCLUDE 减少到 2 个

---

### Week 5-6: 优化和测试 (P2)
**目标**: 质量提升和测试覆盖

**任务**:
- [ ] UI smoke 测试添加
- [ ] 修复所有 P2 迁移
- [ ] 类型严格模式逐步启用
- [ ] 性能优化和监控

**成功标准**:
- UI smoke 测试覆盖主要流程
- MIGRATION_EXCLUDE 清空
- 类型覆盖率达到 75%

---

### Week 7: 完成和文档 (Polish)
**目标**: 文档完善,最终打磨

**任务**:
- [ ] 更新所有文档
- [ ] 团队培训准备
- [ ] Phase 3 总结报告
- [ ] Phase 4 规划启动

**成功标准**:
- 所有文档更新完成
- Phase 3 所有目标达成
- 类型覆盖率达到 80%+

---

## 🎓 最佳实践

### 1. TypeScript 最佳实践

#### ✅ DO

```typescript
// 1. 使用 interface 定义对象类型
interface User {
  id: string
  name: string
  email: string
}

// 2. 使用 type 定义联合类型和工具类型
type UserRole = 'admin' | 'user' | 'guest'
type PartialUser = Partial<User>

// 3. 使用泛型增强重用性
function fetchData<T>(url: string): Promise<ApiResponse<T>> {
  return http.get<T>(url)
}

// 4. 使用类型守卫而非断言
if (isApiSuccess(response)) {
  // response.data 自动 narrow 为非 null
  console.log(response.data.id)
}

// 5. 使用可选链和空值合并
const email = user?.profile?.email ?? 'default@example.com'

// 6. 使用 const assertions
const config = {
  mode: 'production',
  port: 8900
} as const  // 类型更精确
```

#### ❌ DON'T

```typescript
// 1. 避免使用 any
const data: any = fetchData()  // ❌

// 2. 避免使用类型断言
const user = data as User  // ❌

// 3. 避免使用 ! 非空断言 (除非确定)
const name = user!.name  // ❌

// 4. 避免重复类型定义
// ❌ 在多处定义相同的 User 接口

// 5. 避免过度复杂的类型
type ComplexType = A & B & C | D & E & F  // ❌ 难以理解

// 6. 避免在函数内部定义接口
function foo() {
  interface Bar { ... }  // ❌ 应该在外部定义
}
```

---

### 2. 迁移最佳实践

#### ✅ DO

```typescript
// 1. 使用幂等性检查
export async function up(db: Kysely<any>) {
  const exists = await db.schema.hasTable('users').execute()
  if (exists) return  // ✅ 幂等性

  await db.schema.createTable('users')...
}

// 2. 使用模式库函数
await addColumnIfNotExists(db, 'users', 'email', 'text', {
  notNull: true
})

// 3. 添加清晰的注释
/**
 * Add email column to users table
 *
 * Migration: 20251030120000_add_user_email.ts
 * Issue: #123
 * Breaking: No
 */

// 4. 分离索引创建
await db.schema.createTable('users')...
await db.schema.createIndex('idx_users_email')
  .ifNotExists()
  .on('users')
  .column('email')
  .execute()

// 5. 使用事务包装多步操作
await db.transaction().execute(async (trx) => {
  await trx.schema.createTable('users')...
  await trx.schema.createTable('profiles')...
})
```

#### ❌ DON'T

```sql
-- 1. 避免内联 INDEX
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT INDEX idx_email  -- ❌ 内联 INDEX
);

-- 2. 避免缺少 IF NOT EXISTS
CREATE TABLE users (...);  -- ❌ 不幂等

-- 3. 避免无注释的复杂逻辑
-- ❌ 复杂的 CASE WHEN 无注释

-- 4. 避免硬编码值
INSERT INTO config VALUES ('timeout', '30');  -- ❌ 魔数

-- 5. 避免跨迁移依赖
-- Migration A 依赖 Migration B 的具体实现  -- ❌
```

---

### 3. API 设计最佳实践

#### ✅ DO

```typescript
// 1. 统一使用 ApiResponse 包装
async function getUser(id: string): Promise<ApiResponse<User>> {
  return http.get<User>(`/api/users/${id}`)
}

// 2. 提供类型守卫
if (isApiSuccess(response)) {
  // 类型安全地访问 data
}

// 3. 详细的错误信息
return {
  success: false,
  data: null,
  error: {
    code: 'USER_NOT_FOUND',
    message: 'User with ID 123 not found',
    details: { userId: '123', timestamp: new Date() }
  }
}

// 4. 使用 DTO 类型
interface CreateUserDTO {
  name: string
  email: string
  password: string
}

async function createUser(dto: CreateUserDTO): Promise<ApiResponse<User>>

// 5. 提供元数据
return {
  success: true,
  data: users,
  meta: {
    total: 100,
    page: 1,
    pageSize: 20
  }
}
```

#### ❌ DON'T

```typescript
// 1. 避免直接返回数据 (无包装)
async function getUser(id: string): Promise<User> {  // ❌
  return fetchUser(id)
}

// 2. 避免使用 throw 作为正常控制流
if (!user) {
  throw new Error('Not found')  // ❌
}

// 3. 避免模糊的错误信息
return { error: 'Error' }  // ❌ 太模糊

// 4. 避免使用 any 作为参数
async function createUser(data: any)  // ❌

// 5. 避免返回不一致的格式
// 有时返回 { data: ... }, 有时返回 data  // ❌
```

---

## 📚 参考资料

### 内部文档
- [Phase 3 Optimization Roadmap](./PHASE3_OPTIMIZATION_ROADMAP.md)
- [Phase 3 Fix Summary](./PHASE3_FIX_SUMMARY_20251030.md)
- [Branch Protection Handbook](./policies/BRANCH_PROTECTION.md)
- [Migration Tracking](../packages/core-backend/MIGRATION_EXCLUDE_TRACKING.md)

### 模板和工具
- [HTTP Client Template](../apps/web/src/utils/http.ts)
- [Store Types Template](../apps/web/src/stores/types.ts)
- [Router Types Template](../apps/web/src/router/types.ts)
- [Migration Template](../packages/core-backend/src/db/migrations/_template.ts)
- [Migration Patterns Library](../packages/core-backend/src/db/migrations/_patterns.ts)
- [SQL Linter](../scripts/ci/lint-sql-migrations.sh)

### 外部参考
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)
- [Kysely Documentation](https://kysely.dev/)
- [Pinia Documentation](https://pinia.vuejs.org/)
- [Vue Router Documentation](https://router.vuejs.org/)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)

---

## 🎯 关键决策记录 (ADR)

### ADR-001: ApiResponse 包装器
**日期**: 2025-10-29
**状态**: ✅ 已采纳

**背景**: API 响应格式不统一，错误处理分散

**决策**: 采用 ApiResponse<T> 统一包装格式

**后果**:
- ✅ 统一错误处理
- ✅ 类型安全提升
- ⚠️ 需要迁移现有 API

---

### ADR-002: TypeScript 优先迁移策略
**日期**: 2025-10-29
**状态**: ✅ 已采纳

**背景**: SQL 迁移缺少类型安全

**决策**: 新迁移优先使用 TypeScript (Kysely)

**后果**:
- ✅ 类型安全
- ✅ 重构友好
- ⚠️ 学习曲线

---

### ADR-003: 4 个核心必需检查
**日期**: 2025-10-29
**状态**: ✅ 已采纳

**背景**: 过多必需检查导致合并缓慢

**决策**: 减少到 4 个核心检查,其余为信息性

**后果**:
- ✅ 更快合并速度
- ✅ 更好的开发体验
- ⚠️ 需要监控信息性检查

---

### ADR-004: 声明式分支保护配置
**日期**: 2025-10-29
**状态**: ✅ 已采纳

**背景**: 分支保护配置频繁变更,缺乏审计

**决策**: 使用 JSON 配置 + 自动化脚本

**后果**:
- ✅ 版本控制
- ✅ 可审计
- ✅ 自动化应用

---

### ADR-005: 迁移模式库
**日期**: 2025-10-29
**状态**: ✅ 已采纳

**背景**: 迁移代码重复,容易出错

**决策**: 创建可重用的迁移模式库

**后果**:
- ✅ 代码重用
- ✅ 降低错误率
- ✅ 最佳实践固化

---

## 🏆 成功标准

### Phase 3 完成标准

#### 必须 (Must Have)
- [ ] 类型覆盖率 ≥ 80%
- [ ] MIGRATION_EXCLUDE 清空
- [ ] PR #337, #338 合并
- [ ] 4 个核心 CI 检查稳定运行

#### 应该 (Should Have)
- [ ] UI smoke 测试覆盖主要流程
- [ ] CI 平均时间减少 30%
- [ ] 类型错误减少 80%
- [ ] 所有文档更新完成

#### 可以 (Could Have)
- [ ] 类型覆盖率 > 90%
- [ ] CI 平均时间减少 50%
- [ ] 完整的类型安全工具链

---

## 📝 维护指南

### 如何添加新的 Store
```typescript
// 1. 在 stores/types.ts 中定义类型
export interface MyState { ... }
export interface MyGetters { ... }
export interface MyActions { ... }

// 2. 创建 store 文件
export const useMyStore = defineStore<'my', MyState, MyGetters, MyActions>('my', {
  state: (): MyState => ({ ... }),
  getters: { ... },
  actions: { ... }
})

// 3. 使用 store
const myStore = useMyStore()
myStore.someAction()  // ✅ 完全类型安全
```

### 如何添加新的 Route
```typescript
// 1. 在 router/types.ts 中添加名称
enum AppRouteNames {
  // ...
  MY_NEW_ROUTE = 'my-new-route'
}

// 2. 添加参数类型
interface AppRouteParams {
  [AppRouteNames.MY_NEW_ROUTE]: { id: string }
}

// 3. 添加路由配置
{
  path: '/my-new/:id',
  name: AppRouteNames.MY_NEW_ROUTE,
  component: () => import('./views/MyNewView.vue')
}

// 4. 类型安全导航
router.push({
  name: AppRouteNames.MY_NEW_ROUTE,
  params: { id: '123' }  // ✅ 类型检查
})
```

### 如何添加新的迁移
```typescript
// 1. 复制模板
cp _template.ts 20251030120000_my_migration.ts

// 2. 使用模式库
import { addColumnIfNotExists, createIndexIfNotExists } from './_patterns'

export async function up(db: Kysely<any>) {
  await addColumnIfNotExists(db, 'users', 'email', 'text', {
    notNull: true,
    unique: true
  })

  await createIndexIfNotExists(db, 'idx_users_email', 'users', 'email')
}

// 3. 测试
pnpm db:migrate
pnpm db:migrate  // 第二次应该也成功 (幂等性)

// 4. Lint
bash scripts/ci/lint-sql-migrations.sh
```

---

## 🎉 总结

Phase 3 设计总结了从架构到实施的完整思路:

### 核心设计原则
1. **渐进式增强**: 向后兼容,逐步改进
2. **类型安全优先**: 编译时捕获错误
3. **开发者体验**: IDE 支持,清晰错误
4. **可维护性**: 模式库,文档齐全

### 关键技术决策
- ✅ ApiResponse<T> 统一包装
- ✅ TypeScript 优先迁移
- ✅ 4 个核心 CI 检查
- ✅ 声明式分支保护
- ✅ 迁移模式库

### 预期成果
- 类型覆盖率: 40% → 80%+
- CI 平均时间: 减少 30%
- 迁移可靠性: 100%
- 开发者满意度: 显著提升

**Phase 3 为项目的长期健康和可维护性奠定了坚实的基础！** 🚀

---

**文档结束**

版本: 1.0
最后更新: 2025-10-30
维护者: Phase 3 架构团队
