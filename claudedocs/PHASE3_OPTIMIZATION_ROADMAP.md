# 🎯 Phase 3 优化改进路线图

**文档日期**: 2025-10-29 23:50 UTC
**版本**: v1.0
**状态**: 📋 规划中
**优先级**: 高性价比增量改进

---

## 📊 执行摘要

本文档整合了一套高性价比的增量改进建议，按影响优先级排列。这些改进将在 Phase 3 执行期间逐步实施，旨在：
- 🎯 提升 CI/CD 效率和可靠性
- 📘 强化类型安全和代码质量
- 🏗️ 优化前端基础设施
- 🔧 改进迁移管理流程
- 📚 完善文档和治理体系

---

## 🔴 P0: CI 与分支保护优化

### 1.1 收敛必需检查范围

**当前问题**:
- v2-web-typecheck 对所有路径触发，即使修改的是后端代码
- 文档类 PR 触发不必要的 CI 工作流

**优化方案**:

#### 1.1.1 精准路径触发
```yaml
# .github/workflows/v2-web-typecheck.yml
name: v2-web-typecheck

on:
  pull_request:
    paths:
      - 'metasheet-v2/apps/web/**'
      - 'metasheet-v2/packages/core/src/**'  # 如果 web 依赖 core
      - '!**.md'  # 排除文档
      - '!**/docs/**'  # 排除文档目录
    types: [opened, synchronize, reopened]
```

**效果**:
- 减少 50-70% 不必要的 typecheck 运行
- 节省 CI 资源和执行时间
- 加快文档 PR 的合并速度

---

#### 1.1.2 文档类 PR 路径忽略
```yaml
# 为所有技术 CI 工作流添加
on:
  pull_request:
    paths-ignore:
      - '**.md'
      - 'docs/**'
      - 'claudedocs/**'
      - 'README*'
      - 'CHANGELOG*'
      - 'LICENSE'
```

**应用工作流**:
- Migration Replay
- typecheck
- lint-type-test-build
- smoke

**预期收益**:
- 文档 PR 只需通过基础检查（label, guard）
- CI 运行时间减少 80%+
- 分支保护临时调整需求降低

---

### 1.2 强化可观测性而不阻塞

**当前问题**:
- Migration Replay 运行结果不透明
- 无法快速了解哪些迁移被 INCLUDE/EXCLUDE
- 调试困难

**优化方案**:

#### 1.2.1 Migration Replay 摘要报告
```yaml
# .github/workflows/migration-replay.yml
- name: Generate Migration Summary
  if: always()
  run: |
    cat << 'EOF' >> $GITHUB_STEP_SUMMARY
    ## 🗄️ Migration Replay Summary

    ### Execution Context
    - **MIGRATION_EXCLUDE**: ${{ env.MIGRATION_EXCLUDE }}
    - **Total Migrations**: $(find packages/core-backend/src/db/migrations -type f | wc -l)
    - **Excluded Count**: $(echo "$MIGRATION_EXCLUDE" | tr ',' '\n' | grep -v '^$' | wc -l)

    ### Executed Migrations
    $(ls -1 packages/core-backend/src/db/migrations/*.{sql,ts} 2>/dev/null | sort)

    ### Execution Result
    - **Status**: ${{ job.status }}
    - **Duration**: ${{ steps.migrate.outputs.duration }}

    ### Next Steps
    $(if [ "$MIGRATION_EXCLUDE" != "" ]; then
      echo "⚠️ **Action Required**: Review and fix excluded migrations"
      echo "$MIGRATION_EXCLUDE" | tr ',' '\n' | sed 's/^/- [ ] /'
    else
      echo "✅ All migrations executed successfully"
    fi)
    EOF
```

**效果**:
- 一目了然的迁移执行情况
- 快速识别待修复的迁移
- 便于 PR 审阅和问题追踪

---

#### 1.2.2 统一 Artifact 保留策略
```yaml
# 标准化所有工作流的 artifact 配置
- name: Upload logs
  uses: actions/upload-artifact@v4
  if: always()
  with:
    name: workflow-logs-${{ github.run_id }}
    path: |
      **/*.log
      **/test-results/
    retention-days: 7  # 统一保留 7 天
    if-no-files-found: warn
    compression-level: 9  # 最大压缩，限制 < 5MB
```

**预期收益**:
- 存储成本降低 60-70%
- 日志可追溯性保持 7 天
- 关键信息不丢失

---

## 🟡 P1: Typecheck 修复与类型治理

### 2.1 先修 PR #337 的"窄口子"

**优先修复清单**:

#### 2.1.1 导入路径与命名错误
```typescript
// ❌ 错误：路径不存在或命名错误
import { PluginInfo } from '@/types/plugin'  // 路径不存在
import { ContributedView } from './types'     // 文件缺失

// ✅ 修复：正确的导入路径
import type { PluginInfo } from '@/utils/api'
import type { ContributedView } from '@/types/views'
```

**验证方法**:
```bash
# 本地验证
pnpm -F @metasheet/web type-check

# 快速检查导入
grep -r "from '@/" apps/web/src/ | grep -v node_modules
```

---

#### 2.1.2 DTO 字段缺失或可选性不一致
```typescript
// ❌ 问题：字段可选性不一致
interface PluginInfoDTO {
  id: string
  name: string
  version?: string  // API 返回时可能不存在
}

// 组件中假设 version 必定存在
const version = plugin.version.split('.')[0]  // 💥 运行时错误

// ✅ 修复：统一可选性并添加防御
interface PluginInfoDTO {
  id: string
  name: string
  version: string | null  // 明确可能为 null
}

// 组件中添加防御
const version = plugin.version?.split('.')[0] ?? '0'
```

**修复步骤**:
1. 对照 API 响应确定字段可选性
2. 更新 DTO 类型定义
3. 修改组件使用处添加空值检查
4. 运行 typecheck 验证

---

#### 2.1.3 第三方库类型补充
```typescript
// apps/web/src/shims.d.ts（已存在）
declare module 'x-data-spreadsheet' {
  // 已有定义
}

declare module '*.css' {
  const content: Record<string, string>
  export default content
}

// 新增：补充缺失的第三方库类型
declare module 'element-plus/dist/locale/zh-cn.mjs' {
  const zhCn: any
  export default zhCn
}

declare module '@element-plus/icons-vue' {
  import { Component } from 'vue'
  export const Edit: Component
  export const Delete: Component
  // ... 其他图标
}
```

**原则**:
- 仅为实际使用的模块添加最小 shims
- 优先使用 `@types/*` 包
- 必要时提 PR 给上游项目

---

### 2.2 渐进式严格策略

**目标**: 对新/改文件启用更严格规则，旧文件宽松过渡

#### 2.2.1 TSConfig Overrides 策略
```json
// apps/web/tsconfig.app.json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": false,  // 全局宽松
    "strictNullChecks": true
  },
  "overrides": [
    {
      // 新文件或已改造文件使用严格模式
      "files": [
        "src/utils/**/*.ts",
        "src/types/**/*.ts",
        "src/components/workflow/**/*.vue",
        "src/components/eventbus/**/*.vue"
      ],
      "compilerOptions": {
        "noImplicitAny": true,
        "strictPropertyInitialization": true,
        "noUncheckedIndexedAccess": true
      }
    }
  ]
}
```

**渐进路径**:
```
Week 1-2: utils/, types/ 目录严格模式
Week 3-4: 新开发的 workflow/, eventbus/ 严格模式
Week 5-6: 逐步扩展到其他目录
Week 7+:  全局启用严格模式
```

---

#### 2.2.2 ApiResponse<T> 包装与错误态
```typescript
// apps/web/src/utils/api.ts
export interface ApiResponse<T> {
  success: boolean
  data: T | null
  error?: {
    code: string
    message: string
  }
}

export interface ApiErrorResponse {
  success: false
  data: null
  error: {
    code: string
    message: string
  }
}

export interface ApiSuccessResponse<T> {
  success: true
  data: T
  error?: never
}

// 类型守卫
export function isApiSuccess<T>(
  response: ApiResponse<T>
): response is ApiSuccessResponse<T> {
  return response.success === true && response.data !== null
}

// 使用示例
const response = await fetchPlugins()
if (isApiSuccess(response)) {
  // TypeScript 知道 response.data 是 T 类型
  console.log(response.data.length)
} else {
  // TypeScript 知道 response.error 存在
  console.error(response.error.message)
}
```

**覆盖范围**:
- usePlugins
- ViewManager
- 所有 API 调用处

**预期收益**:
- 消除 null/undefined 分支爆炸
- 类型安全的错误处理
- 减少运行时错误

---

## 🟢 P2: 前端基础设施

### 3.1 统一请求层

**当前问题**:
- fetch/axios 调用散落各处
- 错误处理不一致
- 无统一的类型约束

**优化方案**:

#### 3.1.1 轻量 http.ts 封装
```typescript
// apps/web/src/utils/http.ts
import type { ApiResponse } from './api'

interface RequestConfig extends RequestInit {
  params?: Record<string, string | number>
  timeout?: number
}

class HttpClient {
  private baseURL: string
  private defaultHeaders: HeadersInit

  constructor(baseURL: string = import.meta.env.VITE_API_BASE_URL || '') {
    this.baseURL = baseURL
    this.defaultHeaders = {
      'Content-Type': 'application/json'
    }
  }

  private async request<T>(
    method: string,
    url: string,
    config?: RequestConfig
  ): Promise<ApiResponse<T>> {
    const { params, timeout = 30000, ...init } = config || {}

    // 构建 URL
    const fullURL = new URL(url, this.baseURL)
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        fullURL.searchParams.append(key, String(value))
      })
    }

    // 设置超时
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    try {
      const response = await fetch(fullURL.toString(), {
        ...init,
        method,
        headers: {
          ...this.defaultHeaders,
          ...init.headers
        },
        signal: controller.signal
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        return {
          success: false,
          data: null,
          error: {
            code: `HTTP_${response.status}`,
            message: response.statusText
          }
        }
      }

      const data = await response.json()
      return {
        success: true,
        data,
        error: undefined
      }
    } catch (error) {
      clearTimeout(timeoutId)
      return {
        success: false,
        data: null,
        error: {
          code: 'NETWORK_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error'
        }
      }
    }
  }

  async get<T>(url: string, config?: RequestConfig) {
    return this.request<T>('GET', url, config)
  }

  async post<T>(url: string, body?: any, config?: RequestConfig) {
    return this.request<T>('POST', url, {
      ...config,
      body: JSON.stringify(body)
    })
  }

  async put<T>(url: string, body?: any, config?: RequestConfig) {
    return this.request<T>('PUT', url, {
      ...config,
      body: JSON.stringify(body)
    })
  }

  async delete<T>(url: string, config?: RequestConfig) {
    return this.request<T>('DELETE', url, config)
  }
}

export const http = new HttpClient()
```

**使用示例**:
```typescript
// 之前：散落的 fetch 调用
const response = await fetch('/api/plugins')
const data = await response.json()

// 之后：统一的类型安全调用
const response = await http.get<PluginInfo[]>('/api/plugins')
if (isApiSuccess(response)) {
  console.log(response.data.length)  // 类型安全
}
```

---

#### 3.1.2 Pinia Store 类型别名
```typescript
// apps/web/src/stores/types.ts
import type { Store, StoreDefinition } from 'pinia'

// 通用 Store 状态类型
export interface BaseState {
  loading: boolean
  error: string | null
}

// Plugin Store 状态
export interface PluginStoreState extends BaseState {
  plugins: PluginInfo[]
  activePlugin: PluginInfo | null
}

// Plugin Store Actions
export interface PluginStoreActions {
  fetchPlugins(): Promise<void>
  activatePlugin(id: string): Promise<void>
}

// Plugin Store Getters
export interface PluginStoreGetters {
  activePlugins: PluginInfo[]
  pluginCount: number
}

// 完整 Store 类型
export type PluginStore = Store<
  'plugin',
  PluginStoreState,
  PluginStoreGetters,
  PluginStoreActions
>
```

---

#### 3.1.3 Router 参数类型定义
```typescript
// apps/web/src/router/types.ts
export interface RouteParams {
  id?: string
  viewType?: 'kanban' | 'calendar' | 'gallery' | 'form'
  workflowId?: string
  processInstanceId?: string
}

export interface RouteQuery {
  tab?: string
  page?: string
  pageSize?: string
  filter?: string
}

// 在路由中使用
import type { RouteParams, RouteQuery } from './types'

router.push({
  name: 'workflow-designer',
  params: {
    id: workflow.id
  } as RouteParams,
  query: {
    tab: 'design'
  } as RouteQuery
})
```

---

### 3.2 最小 UI 冒烟测试

**目标**: 快速检测 UI 渲染回归，非阻塞

#### 3.2.1 Playwright 冒烟测试
```typescript
// apps/web/tests/smoke/basic.spec.ts
import { test, expect } from '@playwright/test'

test.describe('UI Smoke Tests', () => {
  test('should render home page', async ({ page }) => {
    await page.goto('/')

    // 检查关键元素存在
    await expect(page.locator('h1')).toBeVisible()
    await expect(page.locator('[data-test-id="main-nav"]')).toBeVisible()

    // 截图保存
    await page.screenshot({ path: 'artifacts/home-page.png' })
  })

  test('should load kanban view', async ({ page }) => {
    await page.goto('/')

    // 点击看板视图
    await page.click('[data-test-id="view-kanban"]')

    // 等待视图加载
    await expect(page.locator('.kanban-board')).toBeVisible({ timeout: 5000 })

    // 截图保存
    await page.screenshot({ path: 'artifacts/kanban-view.png' })
  })

  test('should not have console errors', async ({ page }) => {
    const errors: string[] = []

    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text())
      }
    })

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // 允许的已知错误（如果有）
    const allowedErrors = [
      'ResizeObserver loop limit exceeded'  // 已知无害错误
    ]

    const unexpectedErrors = errors.filter(
      err => !allowedErrors.some(allowed => err.includes(allowed))
    )

    expect(unexpectedErrors).toHaveLength(0)
  })
})
```

---

#### 3.2.2 CI 集成（非阻塞）
```yaml
# .github/workflows/ui-smoke.yml
name: UI Smoke Tests

on:
  pull_request:
    paths:
      - 'metasheet-v2/apps/web/**'

jobs:
  smoke:
    runs-on: ubuntu-latest
    continue-on-error: true  # 非阻塞

    steps:
      - uses: actions/checkout@v4

      - name: Setup
        # ... pnpm setup

      - name: Install Playwright
        run: pnpm -F @metasheet/web exec playwright install --with-deps chromium

      - name: Run smoke tests
        run: pnpm -F @metasheet/web test:smoke

      - name: Upload screenshots
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: smoke-screenshots
          path: apps/web/artifacts/*.png
          retention-days: 7

      - name: Comment on PR
        if: always()
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs')
            const screenshots = fs.readdirSync('apps/web/artifacts')

            const body = `## 🖼️ UI Smoke Test Results

            ${screenshots.map(s => `- ![${s}](../artifacts/${s})`).join('\n')}

            ℹ️ This check is **non-blocking** and for reference only.`

            github.rest.issues.createComment({
              issue_number: context.issue.number,
              owner: context.repo.owner,
              repo: context.repo.repo,
              body
            })
```

**预期效果**:
- 快速发现 UI 渲染问题
- 不阻塞 PR 合并
- 提供可视化反馈

---

## 🔧 P2: 迁移与后端优化

### 4.1 TS 等价迁移模板

**目标**: 提供可复用的 TypeScript 迁移模板

#### 4.1.1 标准模板文件
```typescript
// packages/core-backend/src/db/migrations/_template.ts
import { Kysely, sql } from 'kysely'

/**
 * Migration Template
 *
 * Purpose: [描述这个迁移的目的]
 * Tables: [列出涉及的表]
 * Breaking: [是否有破坏性变更]
 *
 * Usage:
 * 1. 复制此模板
 * 2. 重命名为 YYYYMMDD_description.ts
 * 3. 实现 up() 和 down() 方法
 * 4. 添加幂等性检查
 */

export async function up(db: Kysely<any>): Promise<void> {
  // 1. 检查表是否已存在（幂等性）
  const tableExists = await db.schema
    .hasTable('your_table_name')
    .execute()

  if (tableExists) {
    console.log('Table your_table_name already exists, skipping creation')
    return
  }

  // 2. 创建表
  await db.schema
    .createTable('your_table_name')
    .ifNotExists()
    .addColumn('id', 'text', col =>
      col.primaryKey().defaultTo(sql`gen_random_uuid()::text`)
    )
    .addColumn('name', 'text', col => col.notNull())
    .addColumn('created_at', 'timestamptz', col =>
      col.notNull().defaultTo(sql`NOW()`)
    )
    .addColumn('updated_at', 'timestamptz', col =>
      col.notNull().defaultTo(sql`NOW()`)
    )
    .execute()

  // 3. 创建索引
  await db.schema
    .createIndex('idx_your_table_name_name')
    .ifNotExists()
    .on('your_table_name')
    .column('name')
    .execute()

  // 4. 添加约束（如果需要）
  // await db.schema
  //   .alterTable('your_table_name')
  //   .addConstraint('check_name_length', sql`CHECK (length(name) > 0)`)
  //   .execute()
}

export async function down(db: Kysely<any>): Promise<void> {
  // 安全删除（带检查）
  const tableExists = await db.schema
    .hasTable('your_table_name')
    .execute()

  if (tableExists) {
    await db.schema
      .dropTable('your_table_name')
      .ifExists()
      .execute()
  }
}
```

---

#### 4.1.2 常见模式库
```typescript
// packages/core-backend/src/db/migrations/_patterns.ts

/**
 * 模式 1: 添加列（幂等）
 */
export async function addColumnIfNotExists(
  db: Kysely<any>,
  table: string,
  column: string,
  type: string,
  options?: { notNull?: boolean; defaultValue?: any }
): Promise<void> {
  const hasColumn = await db.schema
    .hasColumn(table, column)
    .execute()

  if (hasColumn) {
    console.log(`Column ${table}.${column} already exists, skipping`)
    return
  }

  let builder = db.schema
    .alterTable(table)
    .addColumn(column, type as any)

  if (options?.notNull) {
    builder = builder.modifyColumn(column, col => col.notNull())
  }

  if (options?.defaultValue !== undefined) {
    builder = builder.modifyColumn(column, col =>
      col.defaultTo(options.defaultValue)
    )
  }

  await builder.execute()
}

/**
 * 模式 2: 创建索引（幂等）
 */
export async function createIndexIfNotExists(
  db: Kysely<any>,
  indexName: string,
  tableName: string,
  columns: string[],
  options?: { unique?: boolean; where?: string }
): Promise<void> {
  // Kysely 自动处理 ifNotExists
  let builder = db.schema
    .createIndex(indexName)
    .ifNotExists()
    .on(tableName)

  columns.forEach(col => {
    builder = builder.column(col)
  })

  if (options?.unique) {
    builder = builder.unique()
  }

  if (options?.where) {
    builder = builder.where(sql.raw(options.where))
  }

  await builder.execute()
}

/**
 * 模式 3: 数据迁移（安全）
 */
export async function migrateDataSafely<T>(
  db: Kysely<any>,
  tableName: string,
  transform: (row: T) => Partial<T>,
  batchSize: number = 1000
): Promise<number> {
  let totalUpdated = 0
  let offset = 0

  while (true) {
    const rows = await db
      .selectFrom(tableName as any)
      .selectAll()
      .limit(batchSize)
      .offset(offset)
      .execute() as T[]

    if (rows.length === 0) break

    for (const row of rows) {
      const updates = transform(row)
      if (Object.keys(updates).length > 0) {
        await db
          .updateTable(tableName as any)
          .set(updates)
          .where('id', '=', (row as any).id)
          .execute()
        totalUpdated++
      }
    }

    offset += batchSize
  }

  return totalUpdated
}
```

**使用示例**:
```typescript
// 031_add_optimistic_locking_and_audit.ts
import { Kysely } from 'kysely'
import { addColumnIfNotExists } from './_patterns'

export async function up(db: Kysely<any>): Promise<void> {
  await addColumnIfNotExists(db, 'spreadsheets', 'version', 'integer', {
    notNull: true,
    defaultValue: 0
  })

  await addColumnIfNotExists(db, 'spreadsheets', 'updated_by', 'text')
}
```

---

### 4.2 SQL 健康检查

**目标**: 在运行前检测常见 SQL 语法问题

#### 4.2.1 简单 Lint 脚本
```bash
#!/bin/bash
# scripts/ci/lint-sql-migrations.sh

set -e

MIGRATION_DIR="packages/core-backend/src/db/migrations"
ISSUES_FOUND=0

echo "🔍 Checking SQL migrations for common issues..."

for file in "$MIGRATION_DIR"/*.sql; do
  [ -e "$file" ] || continue

  filename=$(basename "$file")

  # 检查 1: 内联 INDEX 关键字
  if grep -q "INDEX\s\+\w\+\s\+" "$file"; then
    echo "⚠️  $filename: Contains inline INDEX keyword (should be separate CREATE INDEX)"
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
  fi

  # 检查 2: 缺失分号
  if ! tail -n 1 "$file" | grep -q ";"; then
    echo "⚠️  $filename: Missing semicolon at end of file"
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
  fi

  # 检查 3: 关键字大小写不一致
  if grep -q "create table" "$file" && grep -q "CREATE TABLE" "$file"; then
    echo "⚠️  $filename: Inconsistent keyword casing"
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
  fi

  # 检查 4: IF NOT EXISTS 缺失
  if grep -q "CREATE TABLE" "$file" && ! grep -q "IF NOT EXISTS" "$file"; then
    echo "⚠️  $filename: CREATE TABLE without IF NOT EXISTS (not idempotent)"
    ISSUES_FOUND=$((ISSUES_FOUND + 1))
  fi
done

if [ $ISSUES_FOUND -eq 0 ]; then
  echo "✅ All SQL migrations passed health checks"
  exit 0
else
  echo "⚠️  Found $ISSUES_FOUND potential issues (non-blocking)"
  exit 0  # 不阻塞，仅警示
fi
```

---

#### 4.2.2 CI 集成
```yaml
# .github/workflows/migration-replay.yml
jobs:
  migration-replay:
    steps:
      # ... 其他步骤

      - name: SQL Health Check
        run: bash scripts/ci/lint-sql-migrations.sh
        continue-on-error: true  # 不阻塞

      - name: Run migrations
        # ... 原有迁移步骤
```

---

### 4.3 文档化 EXCLUDE 决策

**目标**: 明确每个 EXCLUDE 的原因和计划

#### 4.3.1 PR 模板更新
```markdown
<!-- .github/pull_request_template.md -->

## Migration Changes

如果此 PR 修改了 MIGRATION_EXCLUDE，请填写：

### EXCLUDE 变更

- [ ] 新增 EXCLUDE
- [ ] 移除 EXCLUDE
- [ ] 修改 EXCLUDE

### 变更原因

**迁移文件**: `XXXXX_description.sql`

**EXCLUDE 类型**:
- [ ] 🔴 临时规避（待修复）
- [ ] 🟡 有意策略（长期保留）

**原因**:
<!-- 详细说明为什么需要 EXCLUDE -->

**修复计划** (如果是临时规避):
- **预计修复时间**:
- **阻塞因素**:
- **责任人**:

**验证方法**:
<!-- 如何验证修复后可以移除 EXCLUDE -->
```

---

#### 4.3.2 EXCLUDE 追踪文档
```markdown
<!-- packages/core-backend/MIGRATION_EXCLUDE_TRACKING.md -->

# Migration Exclude 追踪

## 当前排除的迁移

### 🔴 临时规避（待修复）

#### 048_create_event_bus_tables.sql
- **原因**: 26 个内联 INDEX 语法错误
- **计划**: Week 1 重写
- **责任人**: Backend Team
- **预计完成**: 2025-11-05
- **Issue**: #339

#### 049_create_bpmn_workflow_tables.sql
- **原因**: 84+ 处缺失逗号，22 个内联 INDEX
- **计划**: Week 2 重写
- **责任人**: Backend Team
- **预计完成**: 2025-11-12
- **Issue**: #340

### 🟡 有意策略（长期保留）

暂无

## 已解决的排除

### 031_add_optimistic_locking_and_audit.sql
- **移除日期**: 2025-10-30
- **解决方案**: 转换为 TypeScript 迁移
- **PR**: #338
```

---

## 🚀 P2: 工作流优化

### 5.1 缓存与并行

#### 5.1.1 标准化 pnpm 缓存
```yaml
# 在所有工作流中使用统一的缓存配置
- name: Setup pnpm
  uses: pnpm/action-setup@v4
  with:
    version: 8
    run_install: false

- name: Get pnpm store directory
  shell: bash
  run: echo "STORE_PATH=$(pnpm store path --silent)" >> $GITHUB_ENV

- name: Setup pnpm cache
  uses: actions/cache@v4
  with:
    path: ${{ env.STORE_PATH }}
    key: ${{ runner.os }}-pnpm-store-${{ hashFiles('**/pnpm-lock.yaml') }}
    restore-keys: |
      ${{ runner.os }}-pnpm-store-

- name: Install dependencies
  run: pnpm install --frozen-lockfile
```

---

#### 5.1.2 安装与构建并行
```yaml
jobs:
  install:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup and install
        # ... 缓存和安装
      - name: Save node_modules
        uses: actions/cache/save@v4
        with:
          path: |
            node_modules
            **/node_modules
          key: nm-${{ github.sha }}

  typecheck:
    needs: install
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Restore node_modules
        uses: actions/cache/restore@v4
        with:
          path: |
            node_modules
            **/node_modules
          key: nm-${{ github.sha }}
      - name: Type check
        run: pnpm -F @metasheet/web type-check

  build:
    needs: install
    runs-on: ubuntu-latest
    steps:
      # 类似 typecheck，并行运行
```

**预期收益**:
- CI 总时间减少 30-40%
- 失败快速反馈

---

### 5.2 噪声降级

#### 5.2.1 观测类 Job 标注
```yaml
jobs:
  v2-observability-strict:
    runs-on: ubuntu-latest
    continue-on-error: true  # 不阻塞

    steps:
      # ... 检查步骤

      - name: Add summary notice
        if: always()
        run: |
          cat << 'EOF' >> $GITHUB_STEP_SUMMARY
          ## ℹ️ Observability Check (Non-Blocking)

          This check provides **observability insights** and does **not block** PR merging.

          Results are for **reference only**.

          If you see failures here:
          - ✅ You can safely merge if other required checks pass
          - 📊 Review the failures to improve system health
          - 🔧 Consider addressing issues in a follow-up PR
          EOF
```

---

## 📚 P2: 文档与治理

### 6.1 会话报告索引

#### 6.1.1 更新 DEBUG_SUMMARY.md
```markdown
<!-- metasheet-v2/DEBUG_SUMMARY.md -->

# Debug Summary

## 📑 会话报告索引

快速导航到历史会话报告：

### Phase 2 完成 (2025-10-29)
- [PR332 合并成功报告](./claudedocs/session-reports/PR332_MERGE_SUCCESS_20251029.md) (8.4KB) - 合并过程详细记录
- [PR332 完成报告](./claudedocs/session-reports/PR332_COMPLETION_20251029.md) (9.9KB) - 任务完成与分支保护恢复
- [PR332 完整修复报告](./claudedocs/session-reports/PR332_COMPLETE_FIX_REPORT_20251029.md) (32KB) - 技术分析与可复用模板
- [PR332 最终状态](./claudedocs/PR332_FINAL_STATUS_20251029.md) (22KB) - Phase 2 总结

### Phase 3 启动 (2025-10-29)
- [Phase 3 启动计划](./claudedocs/PHASE3_KICKOFF_PLAN_20251029.md) (26KB) - 完整 7 周规划
- [Phase 3 优化路线图](./claudedocs/PHASE3_OPTIMIZATION_ROADMAP.md) (本文档) - 增量改进建议
- [会话完成报告](./claudedocs/SESSION_COMPLETE_20251029_PHASE3.md) (8KB) - 会话工作总结

### 团队通知
- [PR332 部署通知](./claudedocs/notifications/PR332_TEAM_NOTIFICATION.md) (5.8KB) - 面向团队的部署通知

### 历史报告归档
所有历史报告已归档到 [claudedocs/archive/](./claudedocs/archive/)，按类别组织。
```

---

### 6.2 分支保护"操作手册"

#### 6.2.1 创建策略目录
```bash
mkdir -p claudedocs/policies
```

#### 6.2.2 分支保护配置文件
```json
// claudedocs/policies/branch-protection.json
{
  "description": "Main branch protection configuration",
  "version": "2.0",
  "last_updated": "2025-10-29",
  "config": {
    "strict": true,
    "contexts": [
      "Migration Replay",
      "lint-type-test-build",
      "smoke",
      "typecheck"
    ]
  },
  "change_log": [
    {
      "date": "2025-10-29",
      "action": "Added typecheck to required checks",
      "reason": "Phase 3 type safety initiative",
      "pr": "#337"
    },
    {
      "date": "2025-10-29",
      "action": "Removed v2-observability-strict from required",
      "reason": "Changed to non-blocking for faster iteration",
      "pr": "#332"
    }
  ]
}
```

---

#### 6.2.3 应用脚本
```bash
#!/bin/bash
# claudedocs/policies/apply-branch-protection.sh

set -e

CONFIG_FILE="$(dirname "$0")/branch-protection.json"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "❌ Configuration file not found: $CONFIG_FILE"
  exit 1
fi

echo "📋 Applying branch protection from $CONFIG_FILE"

# 提取配置
STRICT=$(jq -r '.config.strict' "$CONFIG_FILE")
CONTEXTS=$(jq -c '.config.contexts' "$CONFIG_FILE")

# 应用到 GitHub
gh api --method PATCH \
  /repos/zensgit/smartsheet/branches/main/protection/required_status_checks \
  --input <(cat <<EOF
{
  "strict": $STRICT,
  "contexts": $CONTEXTS
}
EOF
)

echo "✅ Branch protection applied successfully"

# 验证
echo "🔍 Verifying configuration..."
gh api /repos/zensgit/smartsheet/branches/main/protection/required_status_checks \
  | jq '.contexts'
```

---

#### 6.2.4 操作手册
```markdown
<!-- claudedocs/policies/BRANCH_PROTECTION.md -->

# 分支保护操作手册

## 📖 概述

本文档说明如何安全地管理 main 分支的保护规则。

## 🔒 当前配置

参见 [branch-protection.json](./branch-protection.json)

当前必需检查：
- Migration Replay
- lint-type-test-build
- smoke
- typecheck

## 🛠️ 常见操作

### 应用标准配置

```bash
cd claudedocs/policies
bash apply-branch-protection.sh
```

### 临时移除保护（合并文档 PR）

```bash
# 1. 备份当前配置
gh api /repos/zensgit/smartsheet/branches/main/protection/required_status_checks \
  > /tmp/backup_protection.json

# 2. 临时移除
gh api --method PATCH \
  /repos/zensgit/smartsheet/branches/main/protection/required_status_checks \
  --input '{"strict": true, "contexts": []}'

# 3. 合并 PR
gh pr merge PR_NUMBER --squash

# 4. 立即恢复
bash apply-branch-protection.sh

# 5. 验证
gh api /repos/zensgit/smartsheet/branches/main/protection/required_status_checks
```

### 添加新的必需检查

```bash
# 1. 编辑配置文件
vim branch-protection.json
# 在 contexts 数组中添加新检查名称

# 2. 更新 change_log

# 3. 应用配置
bash apply-branch-protection.sh

# 4. 提交变更
git add branch-protection.json
git commit -m "docs: Add new required check to branch protection"
```

## ⚠️ 注意事项

1. **最小化风险窗口**: 临时移除保护后，应在 1 分钟内恢复
2. **仅用于文档 PR**: 代码变更必须通过所有检查
3. **记录所有变更**: 在 change_log 中记录每次调整
4. **立即恢复**: 合并后立即恢复保护，不要拖延

## 📊 审计追踪

所有分支保护变更都记录在 `branch-protection.json` 的 `change_log` 中。

查看历史：
```bash
jq '.change_log' branch-protection.json
```
```

---

## 📅 实施时间表

### Week 1 (当前周)
- [x] 创建优化路线图文档
- [ ] 修复 PR #337 typecheck（优先）
- [ ] 合并 PR #338
- [ ] 应用 CI 路径过滤优化
- [ ] 创建 TS 迁移模板

### Week 2
- [ ] 实施 Migration Replay 摘要报告
- [ ] 统一 artifact 保留策略
- [ ] 创建 http.ts 封装
- [ ] 添加 SQL 健康检查

### Week 3
- [ ] 实施 TSConfig overrides 策略
- [ ] 创建 ApiResponse<T> 包装
- [ ] 添加 UI 冒烟测试
- [ ] 更新 PR 模板（EXCLUDE 决策）

### Week 4-5
- [ ] 优化 pnpm 缓存
- [ ] 实施安装与构建并行
- [ ] 完善会话报告索引
- [ ] 创建分支保护操作手册

### Week 6-7
- [ ] 全面类型严格化
- [ ] 性能优化与监控
- [ ] 文档完善
- [ ] 团队培训

---

## ✅ 成功标准

### 短期目标 (Week 1-3)
- [ ] PR #337 typecheck 修复
- [ ] CI 运行时间减少 30%+
- [ ] TS 迁移模板创建并应用
- [ ] 文档类 PR 合并时间减少 80%

### 中期目标 (Week 4-7)
- [ ] 所有新代码使用严格 TypeScript
- [ ] 统一请求层覆盖 80% API 调用
- [ ] UI 冒烟测试覆盖关键流程
- [ ] 分支保护操作手册完成

### 长期目标 (Phase 3 结束)
- [ ] 全局启用 strict 模式
- [ ] CI/CD 流程完全优化
- [ ] 文档和治理体系完善
- [ ] 团队最佳实践建立

---

## 🔗 相关资源

### 本文档系列
- [Phase 3 启动计划](./PHASE3_KICKOFF_PLAN_20251029.md)
- [Phase 3 集成计划](./PHASE3_INTEGRATION_PLAN.md)
- [Phase 2 完成报告](./PR332_FINAL_STATUS_20251029.md)

### GitHub
- PR #338: https://github.com/zensgit/smartsheet/pull/338
- PR #337: https://github.com/zensgit/smartsheet/pull/337

### 技术参考
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/)
- [Kysely Documentation](https://kysely.dev/)
- [Playwright Best Practices](https://playwright.dev/docs/best-practices)

---

**🤖 文档生成时间**: 2025-10-29 23:50 UTC
**📍 版本**: v1.0
**🎯 状态**: 待执行

**这些优化建议将在 Phase 3 执行期间逐步实施，以提升整体开发效率和代码质量。** 🚀
