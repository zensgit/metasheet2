# Web 应用认证和 API 调用标准

**版本**: 1.0
**最后更新**: 2025-11-03
**实施**: PR #356 (Auth Utils Standardization)

---

## 📋 概述

本文档定义了 web 应用中认证和 API 调用的标准模式，确保代码一致性、可维护性和类型安全。

## 🎯 设计原则

### 1. 集中配置
- ✅ API base URL 通过 `utils/api.ts` 统一管理
- ✅ 认证逻辑通过 `composables/useAuth.ts` 统一处理
- ❌ 禁止在组件中硬编码 API 地址

### 2. 关注点分离
- **API 配置** (`utils/api.ts`): 管理 API base URL 和基础 headers
- **认证逻辑** (`composables/useAuth.ts`): 处理 token 管理、用户状态
- **业务组件**: 只关注业务逻辑，使用标准工具

### 3. 类型安全
- 所有 API 工具函数提供完整 TypeScript 类型
- 使用 `Record<string, string>` 确保 headers 类型安全

---

## 🔧 核心工具

### utils/api.ts

#### `getApiBase(): string`

**功能**: 获取 API base URL

**优先级顺序**:
1. `VITE_API_URL` 环境变量 (如果非空)
2. `window.location.origin` (当前域名)
3. `http://localhost:8900` (默认开发环境)

**使用示例**:
```typescript
import { getApiBase } from '../utils/api'

const response = await fetch(`${getApiBase()}/api/users`)
```

**类型签名**:
```typescript
function getApiBase(): string
```

---

#### `authHeaders(token?: string): Record<string, string>`

**功能**: 生成包含认证信息的 HTTP headers

**参数**:
- `token` (可选): JWT token 字符串

**返回值**:
- 总是包含 `Content-Type: application/json`
- 如果提供 token，添加 `Authorization: Bearer <token>`

**使用示例**:
```typescript
import { authHeaders } from '../utils/api'

// 无认证的公开 API
const headers1 = authHeaders()
// { 'Content-Type': 'application/json' }

// 需要认证的 API
const token = 'user-jwt-token'
const headers2 = authHeaders(token)
// { 'Content-Type': 'application/json', 'Authorization': 'Bearer user-jwt-token' }
```

**类型签名**:
```typescript
function authHeaders(token?: string): Record<string, string>
```

---

### composables/useAuth.ts

#### `buildAuthHeaders(): Record<string, string>`

**功能**: 响应式的认证 headers 生成器（集成当前用户 token）

**使用示例**:
```typescript
import { useAuth } from '../composables/useAuth'

const { buildAuthHeaders } = useAuth()

const response = await fetch(`${getApiBase()}/api/profile`, {
  headers: buildAuthHeaders()
})
```

**优势**:
- ✅ 自动从当前用户会话获取 token
- ✅ 响应式更新
- ✅ 与 Vue 组件生命周期集成

---

## 📖 标准使用模式

### 模式 1: GET 请求（无认证）

```typescript
import { getApiBase, authHeaders } from '../utils/api'

async function fetchPublicData() {
  const response = await fetch(`${getApiBase()}/api/public/data`, {
    headers: authHeaders()
  })
  return response.json()
}
```

---

### 模式 2: GET 请求（需要认证）

```typescript
import { getApiBase, authHeaders } from '../utils/api'

async function fetchUserData(token: string) {
  const response = await fetch(`${getApiBase()}/api/user/profile`, {
    headers: authHeaders(token)
  })
  return response.json()
}
```

---

### 模式 3: POST 请求（带认证和请求体）

```typescript
import { getApiBase, authHeaders } from '../utils/api'

async function createRecord(data: any, token: string) {
  const response = await fetch(`${getApiBase()}/api/records`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(data)
  })
  return response.json()
}
```

---

### 模式 4: 使用 useAuth composable（推荐）

```vue
<script setup lang="ts">
import { getApiBase } from '../utils/api'
import { useAuth } from '../composables/useAuth'

const { buildAuthHeaders } = useAuth()

async function loadData() {
  const response = await fetch(`${getApiBase()}/api/data`, {
    headers: buildAuthHeaders()
  })
  const result = await response.json()
  // 处理数据
}
</script>
```

**优势**: 自动管理 token，响应式更新

---

## ✅ 最佳实践

### 1. 环境配置

**开发环境** (`.env.development`):
```env
VITE_API_URL=http://localhost:8900
```

**生产环境** (`.env.production`):
```env
VITE_API_URL=https://api.production.com
```

---

### 2. 错误处理

```typescript
import { getApiBase, authHeaders } from '../utils/api'

async function safeApiCall(token: string) {
  try {
    const response = await fetch(`${getApiBase()}/api/data`, {
      headers: authHeaders(token)
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    return await response.json()
  } catch (error) {
    console.error('API call failed:', error)
    throw error
  }
}
```

---

### 3. 类型安全的请求

```typescript
import { getApiBase, authHeaders } from '../utils/api'

interface User {
  id: string
  name: string
  email: string
}

async function getUser(id: string, token: string): Promise<User> {
  const response = await fetch(`${getApiBase()}/api/users/${id}`, {
    headers: authHeaders(token)
  })

  if (!response.ok) {
    throw new Error('Failed to fetch user')
  }

  return response.json()
}
```

---

### 4. 并发请求

```typescript
import { getApiBase, authHeaders } from '../utils/api'

async function fetchMultipleEndpoints(token: string) {
  const headers = authHeaders(token)
  const base = getApiBase()

  const [users, posts, comments] = await Promise.all([
    fetch(`${base}/api/users`, { headers }).then(r => r.json()),
    fetch(`${base}/api/posts`, { headers }).then(r => r.json()),
    fetch(`${base}/api/comments`, { headers }).then(r => r.json())
  ])

  return { users, posts, comments }
}
```

---

## ❌ 反模式 (Anti-Patterns)

### 🚫 反模式 1: 硬编码 API 地址

```typescript
// ❌ 错误
const response = await fetch('http://localhost:8900/api/users')

// ✅ 正确
const response = await fetch(`${getApiBase()}/api/users`)
```

---

### 🚫 反模式 2: 手动构建 Authorization header

```typescript
// ❌ 错误
const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${token}`
}

// ✅ 正确
const headers = authHeaders(token)
```

---

### 🚫 反模式 3: 在多处重复相同逻辑

```typescript
// ❌ 错误 - 每个组件都重复实现
function getApiUrl() {
  return import.meta.env.VITE_API_URL || 'http://localhost:8900'
}

// ✅ 正确 - 使用统一工具
import { getApiBase } from '../utils/api'
```

---

### 🚫 反模式 4: 忽略类型安全

```typescript
// ❌ 错误 - 使用 any 类型
const headers: any = { 'Content-Type': 'application/json' }

// ✅ 正确 - 使用明确类型
const headers: Record<string, string> = authHeaders()
```

---

## 🧪 测试覆盖

单元测试位于: `apps/web/tests/utils/api.test.ts`

**测试覆盖**:
- ✅ 17 个测试用例
- ✅ 环境变量配置场景
- ✅ Token 处理逻辑
- ✅ 边界情况和错误处理
- ✅ 类型安全性验证

**运行测试**:
```bash
pnpm -F @metasheet/web test utils/api.test.ts
```

---

## 🔄 迁移指南

### 从硬编码 URL 迁移

**迁移前**:
```typescript
const response = await fetch('http://localhost:8900/api/data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data)
})
```

**迁移后**:
```typescript
import { getApiBase, authHeaders } from '../utils/api'

const response = await fetch(`${getApiBase()}/api/data`, {
  method: 'POST',
  headers: authHeaders(),
  body: JSON.stringify(data)
})
```

**变更摘要**:
1. 添加 import 语句
2. 替换硬编码 URL 为 `${getApiBase()}/...`
3. 替换 headers 对象为 `authHeaders()`

---

### 从 useAuth composable 迁移

如果已经使用 `useAuth`，无需迁移！继续使用 `buildAuthHeaders()`:

```typescript
import { useAuth } from '../composables/useAuth'
import { getApiBase } from '../utils/api'

const { buildAuthHeaders } = useAuth()

// 这种模式已经是最佳实践
const response = await fetch(`${getApiBase()}/api/data`, {
  headers: buildAuthHeaders()
})
```

---

## 📊 实施状态

### 已迁移文件

| 文件 | 状态 | PR | 说明 |
|------|------|-----|------|
| `KanbanView.vue` | ✅ 已标准化 | 之前 | 使用 useAuth + getApiBase |
| `GridView.vue` | ✅ 已迁移 | #356 | 使用 getApiBase + authHeaders |

### 待迁移文件

运行以下命令查找待迁移文件:
```bash
grep -r "localhost:8900" apps/web/src/views/*.vue
grep -r "VITE_API_URL" apps/web/src/views/*.vue
```

---

## 🤝 贡献指南

### 添加新的 API 调用

1. **始终使用标准工具**:
   ```typescript
   import { getApiBase, authHeaders } from '../utils/api'
   // 或
   import { useAuth } from '../composables/useAuth'
   ```

2. **遵循命名约定**:
   - API 函数以 `fetch`, `create`, `update`, `delete` 开头
   - 使用 async/await 模式
   - 提供清晰的类型定义

3. **添加错误处理**:
   - 检查 `response.ok`
   - 使用 try-catch 包装
   - 提供有意义的错误信息

4. **编写测试**:
   - 为新的 API 调用编写单元测试
   - 测试成功和失败场景
   - 验证类型安全性

---

## 📚 相关资源

### 内部文档
- **实施 PR**: #356 (Auth Utils Standardization)
- **原始需求**: PR #126 (40天前关闭)
- **Batch 1 计划**: `claudedocs/PR_REIMPLEMENTATION_PLAN.md`

### 代码位置
- **工具函数**: `apps/web/src/utils/api.ts`
- **Auth Composable**: `apps/web/src/composables/useAuth.ts`
- **测试文件**: `apps/web/tests/utils/api.test.ts`

### 外部参考
- [Fetch API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API)
- [Vue 3 Composables](https://vuejs.org/guide/reusability/composables.html)
- [TypeScript Handbook](https://www.typescriptlang.org/docs/handbook/intro.html)

---

## 🔍 常见问题 (FAQ)

### Q: 为什么不直接硬编码 API 地址？
**A**: 硬编码导致：
- ❌ 开发/生产环境切换困难
- ❌ 代码重复和维护成本高
- ❌ 单元测试困难

### Q: `authHeaders()` 和 `buildAuthHeaders()` 有什么区别？
**A**:
- `authHeaders(token)`: 静态函数，需要手动传入 token
- `buildAuthHeaders()`: Composable 方法，自动从用户会话获取 token

### Q: 如何在开发环境使用不同的 API 地址？
**A**: 创建 `.env.development.local` 文件：
```env
VITE_API_URL=http://localhost:3000
```

### Q: 如何处理特殊的 headers 需求？
**A**: 扩展 `authHeaders()` 返回值：
```typescript
const headers = {
  ...authHeaders(token),
  'X-Custom-Header': 'custom-value'
}
```

### Q: 如何测试 API 调用？
**A**: 使用 vitest 的 mock 功能：
```typescript
import { vi } from 'vitest'

vi.mock('../utils/api', () => ({
  getApiBase: () => 'https://test-api.com',
  authHeaders: (token) => ({ Authorization: `Bearer ${token}` })
}))
```

---

## ✅ 检查清单

在提交代码前，确保：

- [ ] 所有 API 调用使用 `getApiBase()`
- [ ] 所有认证请求使用 `authHeaders()` 或 `buildAuthHeaders()`
- [ ] 没有硬编码的 API 地址
- [ ] 提供了 TypeScript 类型定义
- [ ] 添加了适当的错误处理
- [ ] 编写了单元测试（如果是新功能）
- [ ] 更新了相关文档

---

**文档版本**: 1.0
**最后更新**: 2025-11-03
**维护者**: Web 开发团队
