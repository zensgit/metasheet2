# B1 - Permissions Types 工作计划

**创建时间**: 2025-10-27
**状态**: 规划中
**目标**: 通过为权限域添加类型定义，减少 ≥30% 的 TS2339/TS2322 错误

---

## 📊 当前状态

### TypeScript 错误统计（Baseline）
```
总错误数: 1291 个

主要错误类型:
- TS2339 (Property不存在): 379个 (29.4%)
- TS2322 (类型不匹配): 188个 (14.6%)
- TS18048 (可能undefined): 152个 (11.8%)
- TS18046 (可能null/undefined): 104个 (8.1%)
- TS2345 (参数类型不兼容): 80个 (6.2%)
- TS7053 (索引签名缺失): 70个 (5.4%)
- TS7006 (隐式any): 43个 (3.3%)
```

### PR 状态
- **PR #330**: `fix/web-typescript-errors` - CI配置调整（已修复pnpm action SHA）
- **PR #331**: `feat/web-types-B1-permissions` - 权限 DTO 骨架（已完成）

---

## 🎯 B1 实施路线

### B1-1: 为 stores/permission.js 添加 JSDoc 类型

**文件**: `apps/web/src/stores/permission.js` (1083行)

**当前问题**:
- 所有状态和方法都缺少类型注解
- axios 返回值形状不统一
- ref 类型推断不明确

**实施策略**: 使用 JSDoc 而非改写为 TypeScript

**理由**:
1. 避免大规模重构风险
2. 渐进式类型增强
3. 保持现有代码结构稳定

**任务清单**:

1. **引用 DTO 类型**
   ```javascript
   /**
    * @typedef {import('../types/permissions').PermissionEntry} PermissionEntry
    * @typedef {import('../types/permissions').PermissionListResponse} PermissionListResponse
    * @typedef {import('../types/permissions').PermissionStatistics} PermissionStatistics
    * // ... 其他类型
    */
   ```

2. **状态类型注解**
   ```javascript
   /** @type {import('vue').Ref<PermissionEntry[]>} */
   const permissions = ref([])

   /** @type {import('vue').Ref<boolean>} */
   const loading = ref(false)

   /** @type {import('vue').Ref<string | null>} */
   const error = ref(null)
   ```

3. **方法签名注解**（示例）
   ```javascript
   /**
    * 获取权限列表
    * @param {Object} [params={}] - 查询参数
    * @param {number} [params.page] - 页码
    * @param {number} [params.pageSize] - 每页数量
    * @returns {Promise<PermissionListResponse>}
    */
   const getPermissions = async (params = {}) => {
     // ... 现有实现
   }
   ```

4. **统一 axios 响应处理**
   创建辅助函数:
   ```javascript
   /**
    * @template T
    * @param {Promise<{data: {success: boolean, data: T, message?: string}}>} promise
    * @returns {Promise<T>}
    */
   function unwrapApiResponse(promise) {
     return promise.then(response => {
       if (response.data.success) {
         return response.data.data
       }
       throw new Error(response.data.message || '请求失败')
     })
   }
   ```

**预期效果**:
- VSCode/IDE 提供准确的类型提示
- 减少 API 调用相关的 TS2339 错误
- 为视图层使用提供类型保障

---

### B1-2: 视图层使用 DTO 类型

**目标组件**:
```
apps/web/src/components/settings/PermissionManagement.vue
apps/web/src/components/role/RoleManagement.vue
apps/web/src/composables/useUserPermissions.ts
```

**实施步骤**:

1. **导入 DTO 类型**
   ```typescript
   import type {
     PermissionEntry,
     PermissionListResponse,
     PermissionStatistics
   } from '@/types/permissions'
   ```

2. **为响应式变量添加类型**
   ```typescript
   const permissions = ref<PermissionEntry[]>([])
   const statistics = ref<PermissionStatistics | null>(null)
   const pagination = ref<PaginationMeta>({ total: 0 })
   ```

3. **校准字段名与空值处理**
   - 确保使用 `subject_type` 而非 `subjectType`
   - 为可能为 null 的字段添加非空保护
   - 统一使用 `?.` 可选链操作符

**重点修复区域**:
- PermissionManagement.vue 中权限列表渲染逻辑
- useUserPermissions composable 的状态管理
- RoleManagement.vue 中角色权限关联逻辑

---

### B1-3: 收敛热区错误

**目标**: 减少 ≥30% 的 TS2339/TS2322 错误

**错误热区**（基于初步扫描）:

1. **SpreadsheetPermissionManager.vue** (60行)
   - Property 'totalPermissions' does not exist on type 'never'
   - Property 'userPermissions' does not exist on type 'never'
   - 原因: 响应式变量类型推断为 never
   - 修复: 添加显式类型注解

2. **DepartmentInfo.vue** (163, 205行)
   - Property 'member_count' does not exist on type 'Department'
   - 原因: Department 类型定义缺失字段
   - 修复: 扩展 Department 类型或使用类型守卫

3. **settings/* 组件** (多个)
   - Type 'string' is not assignable to Element Plus 类型
   - 原因: Element Plus 的 type prop 是联合类型
   - 修复: 使用 as const 或类型断言

**修复优先级**:
1. 高优先级: 权限相关组件（符合B1范围）
2. 中优先级: Department 相关组件（可能在B2处理）
3. 低优先级: Element Plus 类型问题（全局处理）

---

## 📈 成功指标

### 定量指标
```
Baseline: 1291 errors
Target after B1: <900 errors (减少 ≥30%)

重点减少:
- TS2339 (Property不存在): 379 → <265 (减少≥30%)
- TS2322 (类型不匹配): 188 → <132 (减少≥30%)
```

### 定性指标
- ✅ permission.js 所有方法都有 JSDoc 类型注解
- ✅ 权限相关视图可以使用类型提示进行开发
- ✅ axios 响应处理统一且类型安全
- ✅ 权限域相关的 TS 错误减少显著

---

## 🔄 验证流程

### 本地验证
```bash
# 1. 运行 type-check 并统计错误
cd apps/web
pnpm run type-check 2>&1 | tee typecheck-b1-after.txt

# 2. 统计错误类型
grep -Eo 'TS[0-9]+' typecheck-b1-after.txt | sort | uniq -c | sort -nr

# 3. 对比前后变化
# Baseline: 1291 errors
# After B1: ??? errors
# 改进率: ???%
```

### CI 验证
```bash
# PR #331 将触发 typecheck-metrics job
# 检查 artifacts:
# - web-typecheck-report-*.txt
# - typecheck-summary.txt
# - typecheck-metrics.env (total_errors=???)
```

---

## 📋 下一步行动

### 立即可执行（小步快跑）
1. ✅ 修复 PR #330 的 pnpm action SHA（已完成）
2. ⏳ 等待 PR #330 CI 通过
3. ⏳ 合并 PR #330
4. 🔄 在 PR #331 分支实施 B1-1（stores JSDoc）
5. 🔄 在 PR #331 分支实施 B1-2（视图层 DTO）
6. 🔄 在 PR #331 分支实施 B1-3（热区修复）
7. 📊 本地验证并统计改进
8. 🚀 更新 PR #331 并等待 CI

### 并行工作（可选）
- 调研其他域的高频错误类型
- 准备 B2（Department 类型）的 DTO 骨架
- 整理 Element Plus 类型问题的通用解决方案

---

## 🚨 风险与缓解

### 风险1: JSDoc 类型注解工作量超出预期
**缓解**: 优先注解最常用的 10-15 个方法，其他方法标记 `@todo`

### 风险2: axios 响应形状不一致导致类型断言复杂
**缓解**: 创建统一的响应处理辅助函数，封装复杂逻辑

### 风险3: 修复引入新的运行时错误
**缓解**:
- 仅添加类型注解，不修改业务逻辑
- 每个阶段运行 `pnpm run build` 验证
- 保持小步提交，便于回滚

### 风险4: B1 改进不足30%
**缓解**: 如果权限域错误占比不足，扩展到相关域（如用户、角色）

---

## 📚 参考资源

### 已有DTO定义
- `apps/web/src/types/permissions.ts` - 完整的权限域 DTO

### 相关文件
- `apps/web/src/stores/permission.js` - 主要目标文件
- `apps/web/src/composables/useUserPermissions.ts` - 次要目标
- `apps/web/src/components/settings/PermissionManagement.vue` - 主要使用方

### TypeScript文档
- [JSDoc Reference](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html)
- [Type Checking JavaScript Files](https://www.typescriptlang.org/docs/handbook/type-checking-javascript-files.html)

---

**计划创建人**: Claude Code
**计划版本**: 1.0
**预计工作量**: 4-6小时（分3次提交）
