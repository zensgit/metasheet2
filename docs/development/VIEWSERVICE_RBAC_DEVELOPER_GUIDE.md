# ViewService & RBAC 开发者指南

**版本**: 1.0
**状态**: Baseline (Stub Implementation)
**基础PR**: #259
**更新日期**: 2025-10-14

---

## 📖 目录

1. [概述](#概述)
2. [快速开始](#快速开始)
3. [ViewService 接口](#viewservice-接口)
4. [Table RBAC 接口](#table-rbac-接口)
5. [特性开关](#特性开关)
6. [开发工作流](#开发工作流)
7. [测试指南](#测试指南)
8. [迁移指南](#迁移指南)
9. [常见问题](#常见问题)
10. [API 参考](#api-参考)

---

## 概述

### 目标

建立统一的视图数据查询抽象层（ViewService）和表级权限控制系统（Table RBAC），解决以下问题：

1. **视图类型分散** - Grid, Kanban, Gallery, Form 各自实现查询逻辑
2. **权限检查缺失** - 缺少统一的表级权限控制
3. **代码重复** - 每个视图类型重复相似的数据加载代码
4. **难以扩展** - 添加新视图类型需要修改多处代码

### 架构原则

- **渐进式迁移** - 通过特性开关逐步启用新功能
- **向后兼容** - 保持现有API契约不变
- **Fail-safe设计** - 默认允许访问（MVP阶段）
- **可观测性优先** - 所有操作记录metrics

---

## 快速开始

### 安装依赖

```bash
cd packages/core-backend
pnpm install
```

### 启动开发环境

```bash
# 方式1: 使用默认配置（特性开关OFF）
pnpm dev:core

# 方式2: 启用ViewService（开发测试）
FEATURE_VIEWSERVICE_UNIFICATION=true pnpm dev:core

# 方式3: 同时启用RBAC（开发测试）
FEATURE_VIEWSERVICE_UNIFICATION=true \
FEATURE_TABLE_RBAC_ENABLED=true \
pnpm dev:core
```

### 验证基础接口

```typescript
// test-viewservice.ts
import * as ViewService from './src/services/view-service'
import * as TablePerms from './src/rbac/table-perms'

async function test() {
  // 测试ViewService
  console.log('ViewService enabled:', ViewService.isViewServiceEnabled())
  const result = await ViewService.queryGrid('test-view-id')
  console.log('Grid query result:', result)

  // 测试RBAC
  console.log('Table RBAC enabled:', TablePerms.isTableRBACEnabled())
  const perm = await TablePerms.canReadTable('user-1', 'table-1')
  console.log('Permission result:', perm)
}

test()
```

```bash
# 运行测试
npx tsx test-viewservice.ts
```

**预期输出**（特性开关OFF）:
```
ViewService enabled: false
Grid query result: { data: [], meta: { total: 0, page: 1, pageSize: 50, hasMore: false } }
Table RBAC enabled: false
Permission result: { allowed: true, reason: 'RBAC disabled (stub mode)' }
```

---

## ViewService 接口

### 文件位置

```
packages/core-backend/src/services/view-service.ts
```

### 核心接口

#### 1. 视图配置管理

```typescript
/**
 * 获取视图配置
 * @param viewId - 视图ID
 * @returns 视图配置对象 | null
 */
async function getViewById(viewId: string): Promise<ViewConfig | null>

/**
 * 更新视图配置
 * @param viewId - 视图ID
 * @param config - 部分配置更新
 * @returns 更新后的配置 | null
 */
async function updateViewConfig(
  viewId: string,
  config: Partial<ViewConfig>
): Promise<ViewConfig | null>
```

**ViewConfig 接口定义**:
```typescript
interface ViewConfig {
  id: string
  name: string
  type: 'grid' | 'kanban' | 'gallery' | 'form' | 'calendar'
  tableId?: string
  config?: Record<string, any>
  createdAt?: Date
  updatedAt?: Date
}
```

#### 2. 视图数据查询

```typescript
/**
 * 查询Grid视图数据
 * @param viewId - 视图ID
 * @param options - 查询选项（分页、过滤、排序）
 * @returns 数据结果集
 */
async function queryGrid(
  viewId: string,
  options?: ViewQueryOptions
): Promise<ViewDataResult>

/**
 * 查询Kanban视图数据
 */
async function queryKanban(
  viewId: string,
  options?: ViewQueryOptions
): Promise<ViewDataResult>

/**
 * 查询Gallery视图数据
 */
async function queryGallery(
  viewId: string,
  options?: ViewQueryOptions
): Promise<ViewDataResult>

/**
 * 查询Form视图数据
 */
async function queryForm(
  viewId: string,
  options?: ViewQueryOptions
): Promise<ViewDataResult>
```

**ViewQueryOptions 接口**:
```typescript
interface ViewQueryOptions {
  page?: number          // 页码（从1开始）
  pageSize?: number      // 每页大小（默认50）
  filters?: Record<string, any>  // 过滤条件
  sorting?: Array<{              // 排序规则
    field: string
    direction: 'asc' | 'desc'
  }>
}
```

**ViewDataResult 接口**:
```typescript
interface ViewDataResult {
  data: any[]           // 数据数组
  meta: {
    total: number       // 总记录数
    page: number        // 当前页
    pageSize: number    // 每页大小
    hasMore: boolean    // 是否有更多数据
  }
}
```

#### 3. 特性开关检查

```typescript
/**
 * 检查ViewService是否启用
 * @returns boolean
 */
function isViewServiceEnabled(): boolean
```

### 使用示例

#### 基础用法

```typescript
import * as ViewService from '../services/view-service'

// 1. 检查特性开关
if (!ViewService.isViewServiceEnabled()) {
  console.log('ViewService未启用，使用传统路径')
  // 使用原有逻辑
  return
}

// 2. 获取视图配置
const viewConfig = await ViewService.getViewById('view-123')
if (!viewConfig) {
  return res.status(404).json({ error: 'View not found' })
}

// 3. 根据视图类型查询数据
let result: ViewDataResult

switch (viewConfig.type) {
  case 'grid':
    result = await ViewService.queryGrid('view-123', {
      page: 1,
      pageSize: 50,
      filters: { status: 'active' },
      sorting: [{ field: 'created_at', direction: 'desc' }]
    })
    break

  case 'kanban':
    result = await ViewService.queryKanban('view-123', { page: 1 })
    break

  case 'gallery':
    result = await ViewService.queryGallery('view-123', { pageSize: 20 })
    break

  default:
    throw new Error(`Unsupported view type: ${viewConfig.type}`)
}

// 4. 返回结果
return res.json({ success: true, ...result })
```

#### 在Express路由中使用

```typescript
// routes/views.ts
import { Router, Request, Response } from 'express'
import * as ViewService from '../services/view-service'

const router = Router()

router.get('/:viewId/data', async (req: Request, res: Response) => {
  try {
    const { viewId } = req.params
    const { page = '1', pageSize = '50' } = req.query

    // 解析分页参数
    const options: ViewQueryOptions = {
      page: parseInt(page as string, 10),
      pageSize: parseInt(pageSize as string, 10)
    }

    // 检查ViewService是否启用
    if (!ViewService.isViewServiceEnabled()) {
      // 使用原有逻辑（向后兼容）
      return handleLegacyDataQuery(viewId, options, res)
    }

    // 获取视图配置
    const viewConfig = await ViewService.getViewById(viewId)
    if (!viewConfig) {
      return res.status(404).json({
        success: false,
        error: 'View not found'
      })
    }

    // 根据类型委托查询
    let result: ViewDataResult
    switch (viewConfig.type) {
      case 'grid':
        result = await ViewService.queryGrid(viewId, options)
        break
      case 'kanban':
        result = await ViewService.queryKanban(viewId, options)
        break
      default:
        return res.status(400).json({
          success: false,
          error: `Unsupported view type: ${viewConfig.type}`
        })
    }

    return res.json({ success: true, ...result })

  } catch (error) {
    console.error('Error loading view data:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to load view data'
    })
  }
})
```

---

## Table RBAC 接口

### 文件位置

```
packages/core-backend/src/rbac/table-perms.ts
```

### 核心接口

#### 1. 权限检查方法

```typescript
/**
 * 检查用户是否可以读取表数据
 * @param userId - 用户ID
 * @param tableId - 表ID
 * @returns 权限结果
 */
async function canReadTable(
  userId: string,
  tableId: string
): Promise<PermissionResult>

/**
 * 检查用户是否可以写入表数据
 */
async function canWriteTable(
  userId: string,
  tableId: string
): Promise<PermissionResult>

/**
 * 检查用户是否可以删除表数据
 */
async function canDeleteFromTable(
  userId: string,
  tableId: string
): Promise<PermissionResult>
```

**PermissionResult 接口**:
```typescript
interface PermissionResult {
  allowed: boolean      // 是否允许
  reason?: string       // 原因说明
}
```

#### 2. 权限断言

```typescript
/**
 * 断言权限，拒绝时抛出错误
 * @param result - 权限检查结果
 * @param operation - 操作名称
 * @throws Error 如果权限被拒绝
 */
function assertPermission(
  result: PermissionResult,
  operation: string
): void
```

#### 3. 特性开关检查

```typescript
/**
 * 检查Table RBAC是否启用
 * @returns boolean
 */
function isTableRBACEnabled(): boolean
```

### 使用示例

#### 基础用法

```typescript
import * as TablePerms from '../rbac/table-perms'

// 1. 检查读权限
const readPerm = await TablePerms.canReadTable('user-123', 'table-456')
if (!readPerm.allowed) {
  return res.status(403).json({
    error: 'Permission denied',
    reason: readPerm.reason
  })
}

// 2. 检查写权限
const writePerm = await TablePerms.canWriteTable('user-123', 'table-456')
if (!writePerm.allowed) {
  return res.status(403).json({
    error: 'Cannot modify table',
    reason: writePerm.reason
  })
}

// 3. 使用断言（简化错误处理）
try {
  const perm = await TablePerms.canReadTable('user-123', 'table-456')
  TablePerms.assertPermission(perm, 'Read table data')

  // 继续执行业务逻辑
  const data = await loadTableData('table-456')
  return res.json({ success: true, data })

} catch (error) {
  return res.status(403).json({ error: error.message })
}
```

#### 在Express路由中集成

```typescript
// routes/views.ts
import * as TablePerms from '../rbac/table-perms'
import * as ViewService from '../services/view-service'

router.get('/:viewId/data', async (req: Request, res: Response) => {
  try {
    const { viewId } = req.params
    const userId = req.user?.id || 'anonymous'

    // 1. 获取视图配置
    const viewConfig = await ViewService.getViewById(viewId)
    if (!viewConfig) {
      return res.status(404).json({ error: 'View not found' })
    }

    // 2. RBAC权限检查
    if (!viewConfig.tableId) {
      return res.status(400).json({ error: 'View has no associated table' })
    }

    const perm = await TablePerms.canReadTable(userId, viewConfig.tableId)

    // 方式1: 手动检查
    if (!perm.allowed) {
      return res.status(403).json({
        error: 'Access denied',
        reason: perm.reason
      })
    }

    // 方式2: 使用断言（更简洁）
    // TablePerms.assertPermission(perm, 'Read view data')

    // 3. 查询数据
    const result = await ViewService.queryGrid(viewId, {
      page: 1,
      pageSize: 50
    })

    return res.json({ success: true, ...result })

  } catch (error) {
    if (error.message.includes('denied')) {
      return res.status(403).json({ error: error.message })
    }
    return res.status(500).json({ error: 'Internal server error' })
  }
})
```

#### 写操作权限检查

```typescript
router.put('/:viewId/config', async (req: Request, res: Response) => {
  try {
    const { viewId } = req.params
    const userId = req.user?.id

    // 1. 获取视图配置
    const viewConfig = await ViewService.getViewById(viewId)
    if (!viewConfig || !viewConfig.tableId) {
      return res.status(404).json({ error: 'View not found' })
    }

    // 2. 检查写权限
    const perm = await TablePerms.canWriteTable(userId, viewConfig.tableId)
    TablePerms.assertPermission(perm, 'Update view configuration')

    // 3. 更新配置
    const updated = await ViewService.updateViewConfig(viewId, req.body)
    return res.json({ success: true, data: updated })

  } catch (error) {
    if (error.message.includes('denied')) {
      return res.status(403).json({ error: error.message })
    }
    return res.status(500).json({ error: 'Failed to update view' })
  }
})
```

---

## 特性开关

### 配置文件

**位置**: `packages/core-backend/.env.example`

```bash
# ViewService统一层
FEATURE_VIEWSERVICE_UNIFICATION=false

# 表级RBAC
FEATURE_TABLE_RBAC_ENABLED=false
```

### 环境配置

#### 开发环境

```bash
# .env.development
FEATURE_VIEWSERVICE_UNIFICATION=true
FEATURE_TABLE_RBAC_ENABLED=true
LOG_LEVEL=debug
```

#### 测试环境

```bash
# .env.test
FEATURE_VIEWSERVICE_UNIFICATION=true
FEATURE_TABLE_RBAC_ENABLED=true
```

#### 生产环境（灰度发布）

```bash
# .env.production - Phase 1: 仅启用ViewService
FEATURE_VIEWSERVICE_UNIFICATION=true
FEATURE_TABLE_RBAC_ENABLED=false

# .env.production - Phase 2: 启用RBAC
FEATURE_VIEWSERVICE_UNIFICATION=true
FEATURE_TABLE_RBAC_ENABLED=true
```

### 运行时检查

```typescript
// 在代码中检查特性开关
import * as ViewService from '../services/view-service'
import * as TablePerms from '../rbac/table-perms'

if (ViewService.isViewServiceEnabled()) {
  console.log('✅ ViewService已启用')
} else {
  console.log('❌ ViewService未启用，使用传统路径')
}

if (TablePerms.isTableRBACEnabled()) {
  console.log('✅ Table RBAC已启用')
} else {
  console.log('❌ Table RBAC未启用（允许所有访问）')
}
```

### 日志输出

启动时会自动记录特性开关状态：

```
[ViewService] ViewService unification ENABLED (feature flag)
[TablePerms] Table-level RBAC ENABLED (MVP: allow all authenticated users)
```

或

```
[ViewService] ViewService unification DISABLED (stub mode)
[TablePerms] Table-level RBAC DISABLED (stub mode: allow all)
```

---

## 开发工作流

### 场景1: 实现ViewService查询方法

#### 1. 创建功能分支

```bash
git checkout main
git pull origin main
git checkout -b feat/viewservice-implementation
```

#### 2. 实现Grid查询

```typescript
// packages/core-backend/src/services/view-service.ts

export async function queryGrid(
  viewId: string,
  options: ViewQueryOptions = {}
): Promise<ViewDataResult> {
  // 检查特性开关
  if (!isViewServiceEnabled()) {
    logger.debug(`[STUB] queryGrid: feature disabled`)
    return {
      data: [],
      meta: { total: 0, page: 1, pageSize: 50, hasMore: false }
    }
  }

  // 真实实现
  try {
    const view = await db
      .selectFrom('views')
      .selectAll()
      .where('id', '=', viewId)
      .executeTakeFirst()

    if (!view) {
      throw new Error('View not found')
    }

    const { page = 1, pageSize = 50, filters, sorting } = options

    // 构建查询
    let query = db
      .selectFrom('table_rows')
      .selectAll()
      .where('table_id', '=', view.tableId)

    // 应用过滤
    if (filters) {
      Object.entries(filters).forEach(([key, value]) => {
        query = query.where(key, '=', value)
      })
    }

    // 应用排序
    if (sorting && sorting.length > 0) {
      sorting.forEach(({ field, direction }) => {
        query = query.orderBy(field, direction)
      })
    }

    // 计算总数
    const countQuery = await query.select(db.fn.count('id').as('total')).executeTakeFirst()
    const total = parseInt(countQuery?.total?.toString() || '0', 10)

    // 应用分页
    const offset = (page - 1) * pageSize
    const rows = await query.limit(pageSize).offset(offset).execute()

    return {
      data: rows,
      meta: {
        total,
        page,
        pageSize,
        hasMore: offset + pageSize < total
      }
    }
  } catch (error) {
    logger.error('Error querying grid view:', error)
    throw error
  }
}
```

#### 3. 添加单元测试

```typescript
// packages/core-backend/src/services/__tests__/view-service.test.ts

import { queryGrid, isViewServiceEnabled } from '../view-service'

describe('ViewService', () => {
  describe('queryGrid', () => {
    it('should return empty result when feature is disabled', async () => {
      process.env.FEATURE_VIEWSERVICE_UNIFICATION = 'false'

      const result = await queryGrid('test-view-id')

      expect(result.data).toEqual([])
      expect(result.meta.total).toBe(0)
    })

    it('should query grid data when feature is enabled', async () => {
      process.env.FEATURE_VIEWSERVICE_UNIFICATION = 'true'

      // Mock database
      const mockRows = [
        { id: '1', name: 'Row 1' },
        { id: '2', name: 'Row 2' }
      ]

      const result = await queryGrid('test-view-id', {
        page: 1,
        pageSize: 50
      })

      expect(result.data.length).toBeGreaterThan(0)
      expect(result.meta.page).toBe(1)
    })
  })
})
```

#### 4. 本地测试

```bash
# 启用特性开关
export FEATURE_VIEWSERVICE_UNIFICATION=true

# 运行测试
pnpm test src/services/__tests__/view-service.test.ts

# 启动开发服务器
pnpm dev:core

# 测试API
curl "http://localhost:8900/api/views/test-view-id/data?page=1&pageSize=10"
```

#### 5. 提交PR

```bash
git add packages/core-backend/src/services/view-service.ts
git add packages/core-backend/src/services/__tests__/view-service.test.ts
git commit -m "feat(viewservice): implement Grid query with pagination and filtering"
git push origin feat/viewservice-implementation

gh pr create --title "feat(viewservice): Grid query implementation" \
  --body "Implements real Grid query logic for ViewService..."
```

### 场景2: 实现RBAC权限检查

#### 1. 创建功能分支

```bash
git checkout main
git pull origin main
git checkout -b feat/rbac-table-permissions
```

#### 2. 实现权限检查逻辑

```typescript
// packages/core-backend/src/rbac/table-perms.ts

export async function canReadTable(
  userId: string,
  tableId: string
): Promise<PermissionResult> {
  // 检查特性开关
  if (!isTableRBACEnabled()) {
    return { allowed: true, reason: 'RBAC disabled (stub mode)' }
  }

  try {
    // 查询用户权限
    const permissions = await db
      .selectFrom('table_permissions')
      .selectAll()
      .where('user_id', '=', userId)
      .where('table_id', '=', tableId)
      .executeTakeFirst()

    if (!permissions) {
      return { allowed: false, reason: 'No permissions found for this table' }
    }

    if (permissions.read_access === true) {
      return { allowed: true, reason: 'User has read permission' }
    }

    return { allowed: false, reason: 'Read permission denied' }

  } catch (error) {
    logger.error('Error checking table permissions:', error)
    // Fail-closed: 发生错误时拒绝访问
    return { allowed: false, reason: 'Permission check failed' }
  }
}
```

#### 3. 添加metrics

```typescript
// packages/core-backend/src/metrics/metrics.ts

export const rbacPermissionChecks = new Counter({
  name: 'rbac_permission_checks_total',
  help: 'Total RBAC permission checks',
  labelNames: ['action', 'result'],
  registers: [register]
})

// 在table-perms.ts中使用
import { rbacPermissionChecks } from '../metrics/metrics'

export async function canReadTable(userId: string, tableId: string): Promise<PermissionResult> {
  const startTime = Date.now()

  try {
    // ... 权限检查逻辑 ...

    rbacPermissionChecks.inc({ action: 'read', result: 'allowed' })
    return { allowed: true }

  } catch (error) {
    rbacPermissionChecks.inc({ action: 'read', result: 'denied' })
    return { allowed: false, reason: 'Error' }
  }
}
```

---

## 测试指南

### 单元测试

```typescript
// __tests__/view-service.test.ts
import * as ViewService from '../view-service'

describe('ViewService', () => {
  beforeEach(() => {
    // 重置特性开关
    delete process.env.FEATURE_VIEWSERVICE_UNIFICATION
  })

  test('isViewServiceEnabled returns false by default', () => {
    expect(ViewService.isViewServiceEnabled()).toBe(false)
  })

  test('isViewServiceEnabled returns true when enabled', () => {
    process.env.FEATURE_VIEWSERVICE_UNIFICATION = 'true'
    expect(ViewService.isViewServiceEnabled()).toBe(true)
  })

  test('queryGrid returns empty result when disabled', async () => {
    const result = await ViewService.queryGrid('test-id')
    expect(result.data).toEqual([])
    expect(result.meta.total).toBe(0)
  })
})
```

### 集成测试

```typescript
// __tests__/integration/views-api.test.ts
import request from 'supertest'
import { app } from '../../index'

describe('Views API with ViewService', () => {
  test('GET /api/views/:viewId/data returns data', async () => {
    process.env.FEATURE_VIEWSERVICE_UNIFICATION = 'true'

    const response = await request(app)
      .get('/api/views/test-view-id/data')
      .query({ page: 1, pageSize: 10 })
      .expect(200)

    expect(response.body).toHaveProperty('success', true)
    expect(response.body).toHaveProperty('data')
    expect(response.body).toHaveProperty('meta')
  })
})
```

### E2E测试

```bash
# scripts/test-viewservice-e2e.sh
#!/bin/bash

set -e

echo "Starting E2E test for ViewService..."

# 1. 启动后端（启用特性开关）
export FEATURE_VIEWSERVICE_UNIFICATION=true
export FEATURE_TABLE_RBAC_ENABLED=true
pnpm -F @metasheet/core-backend dev:core &
SERVER_PID=$!

# 2. 等待服务启动
sleep 5

# 3. 测试Grid查询
echo "Testing Grid query..."
RESPONSE=$(curl -s "http://localhost:8900/api/views/test-grid-view/data")
echo "Response: $RESPONSE"

# 4. 测试Kanban查询
echo "Testing Kanban query..."
curl -s "http://localhost:8900/api/views/test-kanban-view/data"

# 5. 测试权限检查
echo "Testing RBAC..."
curl -s -H "X-User-ID: test-user" \
  "http://localhost:8900/api/views/protected-view/data"

# 6. 清理
kill $SERVER_PID

echo "E2E test completed!"
```

---

## 迁移指南

### 从传统路由迁移到ViewService

#### Before (传统方式)

```typescript
// routes/views.ts - 传统实现
router.get('/:viewId/data', async (req, res) => {
  const { viewId } = req.params

  // 直接查询数据库
  const view = await db.selectFrom('views').where('id', '=', viewId).executeTakeFirst()
  const rows = await db.selectFrom('table_rows').where('table_id', '=', view.tableId).execute()

  res.json({ success: true, data: rows })
})
```

#### After (使用ViewService)

```typescript
// routes/views.ts - 使用ViewService
import * as ViewService from '../services/view-service'

router.get('/:viewId/data', async (req, res) => {
  const { viewId } = req.params

  // 委托给ViewService
  const result = await ViewService.queryGrid(viewId, {
    page: 1,
    pageSize: 50
  })

  res.json({ success: true, ...result })
})
```

### 添加RBAC权限检查

#### Before (无权限检查)

```typescript
router.get('/:viewId/data', async (req, res) => {
  const { viewId } = req.params
  const result = await ViewService.queryGrid(viewId)
  res.json(result)
})
```

#### After (添加RBAC)

```typescript
import * as TablePerms from '../rbac/table-perms'

router.get('/:viewId/data', async (req, res) => {
  try {
    const { viewId } = req.params
    const userId = req.user?.id

    // 1. 获取视图配置
    const view = await ViewService.getViewById(viewId)
    if (!view || !view.tableId) {
      return res.status(404).json({ error: 'View not found' })
    }

    // 2. 权限检查
    const perm = await TablePerms.canReadTable(userId, view.tableId)
    TablePerms.assertPermission(perm, 'Read view data')

    // 3. 查询数据
    const result = await ViewService.queryGrid(viewId)
    res.json(result)

  } catch (error) {
    if (error.message.includes('denied')) {
      res.status(403).json({ error: error.message })
    } else {
      res.status(500).json({ error: 'Internal error' })
    }
  }
})
```

### 渐进式迁移策略

```typescript
// 支持新旧两种方式
router.get('/:viewId/data', async (req, res) => {
  const { viewId } = req.params

  // 检查特性开关
  if (ViewService.isViewServiceEnabled()) {
    // 新方式: 使用ViewService
    return handleWithViewService(viewId, req, res)
  } else {
    // 旧方式: 传统实现
    return handleLegacyDataQuery(viewId, req, res)
  }
})

async function handleWithViewService(viewId: string, req: Request, res: Response) {
  const result = await ViewService.queryGrid(viewId)
  return res.json(result)
}

async function handleLegacyDataQuery(viewId: string, req: Request, res: Response) {
  // 原有实现保持不变
  const view = await db.selectFrom('views').where('id', '=', viewId).executeTakeFirst()
  const rows = await db.selectFrom('table_rows').where('table_id', '=', view.tableId).execute()
  return res.json({ success: true, data: rows })
}
```

---

## 常见问题

### Q1: 为什么查询返回空数据？

**A**: 检查特性开关是否启用：

```typescript
import { isViewServiceEnabled } from '../services/view-service'

console.log('ViewService enabled:', isViewServiceEnabled())
// 如果返回false，需要设置环境变量:
// FEATURE_VIEWSERVICE_UNIFICATION=true
```

### Q2: 如何禁用RBAC进行测试？

**A**: 设置环境变量为false：

```bash
export FEATURE_TABLE_RBAC_ENABLED=false
pnpm dev:core
```

或在代码中检查：

```typescript
import { isTableRBACEnabled } from '../rbac/table-perms'

if (!isTableRBACEnabled()) {
  // RBAC已禁用，跳过权限检查
}
```

### Q3: 如何处理权限被拒绝的情况？

**A**: 使用try-catch捕获assertPermission抛出的错误：

```typescript
try {
  const perm = await canReadTable(userId, tableId)
  assertPermission(perm, 'Read table')

  // 继续业务逻辑

} catch (error) {
  if (error.message.includes('denied')) {
    return res.status(403).json({ error: error.message })
  }
  throw error
}
```

### Q4: Stub模式下会影响现有功能吗？

**A**: 不会。Stub模式设计为完全向后兼容：

- ViewService查询返回空结果（不影响现有逻辑）
- RBAC检查返回"允许"（MVP阶段）
- 特性开关默认OFF（现有路由继续工作）

### Q5: 如何在生产环境启用新功能？

**A**: 采用渐进式rollout：

```bash
# Phase 1: 仅在staging启用
export FEATURE_VIEWSERVICE_UNIFICATION=true
export FEATURE_TABLE_RBAC_ENABLED=false

# Phase 2: 生产环境灰度（10%流量）
# 使用feature flag系统或负载均衡器配置

# Phase 3: 全量发布
export FEATURE_VIEWSERVICE_UNIFICATION=true
export FEATURE_TABLE_RBAC_ENABLED=true
```

### Q6: 如何回滚到旧版本？

**A**: 简单设置环境变量并重启：

```bash
export FEATURE_VIEWSERVICE_UNIFICATION=false
export FEATURE_TABLE_RBAC_ENABLED=false

# 重启应用
pm2 restart metasheet-backend
```

---

## API 参考

### ViewService API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `getViewById(viewId)` | `viewId: string` | `Promise<ViewConfig \| null>` | 获取视图配置 |
| `getViewConfig(viewId)` | `viewId: string` | `Promise<ViewConfig \| null>` | 获取视图配置（别名） |
| `updateViewConfig(viewId, config)` | `viewId: string, config: Partial<ViewConfig>` | `Promise<ViewConfig \| null>` | 更新视图配置 |
| `queryGrid(viewId, options?)` | `viewId: string, options?: ViewQueryOptions` | `Promise<ViewDataResult>` | 查询Grid数据 |
| `queryKanban(viewId, options?)` | `viewId: string, options?: ViewQueryOptions` | `Promise<ViewDataResult>` | 查询Kanban数据 |
| `queryGallery(viewId, options?)` | `viewId: string, options?: ViewQueryOptions` | `Promise<ViewDataResult>` | 查询Gallery数据 |
| `queryForm(viewId, options?)` | `viewId: string, options?: ViewQueryOptions` | `Promise<ViewDataResult>` | 查询Form数据 |
| `isViewServiceEnabled()` | - | `boolean` | 检查ViewService是否启用 |

### Table RBAC API

| 方法 | 参数 | 返回值 | 说明 |
|------|------|--------|------|
| `canReadTable(userId, tableId)` | `userId: string, tableId: string` | `Promise<PermissionResult>` | 检查读权限 |
| `canWriteTable(userId, tableId)` | `userId: string, tableId: string` | `Promise<PermissionResult>` | 检查写权限 |
| `canDeleteFromTable(userId, tableId)` | `userId: string, tableId: string` | `Promise<PermissionResult>` | 检查删除权限 |
| `assertPermission(result, operation)` | `result: PermissionResult, operation: string` | `void` | 断言权限（拒绝时抛错） |
| `isTableRBACEnabled()` | - | `boolean` | 检查RBAC是否启用 |

### 类型定义

```typescript
// ViewConfig
interface ViewConfig {
  id: string
  name: string
  type: 'grid' | 'kanban' | 'gallery' | 'form' | 'calendar'
  tableId?: string
  config?: Record<string, any>
  createdAt?: Date
  updatedAt?: Date
}

// ViewQueryOptions
interface ViewQueryOptions {
  page?: number
  pageSize?: number
  filters?: Record<string, any>
  sorting?: Array<{ field: string; direction: 'asc' | 'desc' }>
}

// ViewDataResult
interface ViewDataResult {
  data: any[]
  meta: {
    total: number
    page: number
    pageSize: number
    hasMore: boolean
  }
}

// PermissionResult
interface PermissionResult {
  allowed: boolean
  reason?: string
}
```

---

## 附录

### A. 文件结构

```
packages/core-backend/
├── src/
│   ├── services/
│   │   ├── view-service.ts          # ViewService接口
│   │   └── __tests__/
│   │       └── view-service.test.ts
│   ├── rbac/
│   │   ├── table-perms.ts           # RBAC接口
│   │   └── __tests__/
│   │       └── table-perms.test.ts
│   ├── routes/
│   │   └── views.ts                 # 视图API路由
│   └── metrics/
│       └── metrics.ts               # Prometheus指标
├── .env.example                     # 环境变量模板
└── docs/
    ├── BASELINE_ABSTRACTION_STRATEGY.md
    └── development/
        └── VIEWSERVICE_RBAC_DEVELOPER_GUIDE.md  # 本文档
```

### B. 相关链接

- **基础PR**: https://github.com/zensgit/smartsheet/pull/259
- **策略文档**: `docs/BASELINE_ABSTRACTION_STRATEGY.md`
- **Issue追踪**: #257, #155, #158, #246

### C. 版本历史

| 版本 | 日期 | 变更说明 |
|------|------|----------|
| 1.0 | 2025-10-14 | 初始版本（Baseline stub实现） |

---

**文档维护者**: Claude Code
**最后更新**: 2025-10-14
**状态**: Active (Baseline Phase)
