# B1 阶段完整指南与执行手册

**创建时间**: 2025-10-28
**目的**: 一站式 B1 阶段完整指南
**适用人员**: 开发者、项目维护者

---

## 📊 当前状态一览

### B1 阶段进度

```
✅ B1-DTO: 完成 (100%) - permissions.ts 类型定义
✅ B1-1:   完成 (100%) - permission.js JSDoc 注解 + tsconfig 修复
⏳ B1-2:   部分完成 (30%) - useUserPermissions.ts composable 类型
📋 B1-3:   待开始 (0%) - 热区错误修复
```

### TypeScript 错误统计

```
起点 (2025-10-27):  1291 errors
B1-1 后:             827 errors (-464, -36%)
B1-2 后:             827 errors (无变化，仅 composable)
B1-3 目标:          <550 errors (需再减 277+)
```

### PR 状态

| PR | 分支 | 状态 | 关键检查 | 说明 |
|----|------|------|----------|------|
| #330 | fix/web-typescript-errors | OPEN | ✅ Pass (BLOCKED) | CI 配置，等待分支保护 |
| #331 | feat/web-types-B1-permissions | OPEN | ✅ All Pass | B1 实施，CI 已修复 |

---

## 📚 文档索引

### 已生成的文档

1. **B1_PERMISSIONS_TYPES_PLAN.md**
   - B1 总体规划
   - 实施策略和目标
   - 路径: `metasheet-v2/claudedocs/`

2. **B1_IMPLEMENTATION_REPORT.md**
   - B1-1 和 B1-2 实施报告
   - 详细指标和分析
   - 路径: `metasheet-v2/claudedocs/`

3. **B1-3_ERROR_FIXING_GUIDE.md**
   - B1-3 热区修复详细指南
   - 7个具体修复方案 + 3个批量策略
   - 路径: `metasheet-v2/claudedocs/`

4. **B1_STATUS_CORRECTION.md**
   - PR 状态更正说明
   - 分支内容范围澄清
   - 路径: `metasheet-v2/claudedocs/`

5. **B1_COMPLETE_GUIDE.md** (本文档)
   - 一站式执行手册
   - 综合所有信息

---

## 🎯 B1-3 执行计划

### 目标

```
当前状态: 827 errors
目标状态: <550 errors
减少目标: 277+ errors (33%+)
预计工时: 3-4 小时
```

### 三阶段执行策略

#### 🚀 Phase 1: 快速胜利 (1-1.5 小时)

**目标**: 827 → ~810 errors (-17)

**任务清单**:

1. **修复 SpreadsheetView.vue 方法名拼写** (10分钟)
   ```bash
   # 1. 查找所有错误调用
   grep -n "loadSpreadsheets" apps/web/src/views/SpreadsheetView.vue

   # 2. 批量替换
   sed -i '' 's/loadSpreadsheets/loadSpreadsheetList/g' apps/web/src/views/SpreadsheetView.vue

   # 3. 验证
   pnpm -C apps/web run type-check 2>&1 | grep -c "TS2551.*loadSpreadsheets"
   # 应该输出 0
   ```

   **预期修复**: 3 个 TS2551 错误

2. **修复 CellPermissionDialog.vue User.name** (15分钟)

   **步骤 A: 创建辅助函数**
   ```bash
   # 编辑或创建 apps/web/src/utils/user-helpers.ts
   ```

   ```typescript
   // apps/web/src/utils/user-helpers.ts
   import type { User } from '@/types/user'

   /**
    * 获取用户显示名称
    * 优先使用 nickname，回退到 email
    */
   export function getUserDisplayName(user: User | null | undefined): string {
     if (!user) return 'Unknown User'
     return user.nickname || user.email || user.id || 'Unknown User'
   }

   /**
    * 获取用户头像 URL
    */
   export function getUserAvatar(user: User | null | undefined): string {
     return user?.avatar || '/default-avatar.png'
   }
   ```

   **步骤 B: 修复 CellPermissionDialog.vue**
   ```bash
   # 查找所有 user.name 使用
   grep -n "user\.name" packages/core/src/components/CellPermissionDialog.vue
   ```

   ```vue
   <script setup lang="ts">
   // 添加导入
   import { getUserDisplayName } from '@/utils/user-helpers'

   // 替换所有 user.name 为 getUserDisplayName(user)
   </script>

   <template>
     <!-- Before -->
     <span>{{ user.name }}</span>

     <!-- After -->
     <span>{{ getUserDisplayName(user) }}</span>
   </template>
   ```

   **预期修复**: 3 个 TS2339 错误

3. **修复 Element Plus 类型问题** (30分钟)

   **步骤 A: 创建类型辅助**
   ```bash
   # 编辑或创建 apps/web/src/utils/element-plus-helpers.ts
   ```

   ```typescript
   // apps/web/src/utils/element-plus-helpers.ts

   /**
    * Element Plus Tag 组件类型
    */
   export type ElTagType = 'success' | 'info' | 'warning' | 'danger'

   /**
    * Element Plus Button 组件类型
    */
   export type ElButtonType = 'primary' | 'success' | 'warning' | 'info' | 'danger' | 'text' | 'default'

   /**
    * 转换为有效的 Tag 类型
    */
   export function toElTagType(type: string | undefined): ElTagType {
     const validTypes: ElTagType[] = ['success', 'info', 'warning', 'danger']
     if (type && validTypes.includes(type as ElTagType)) {
       return type as ElTagType
     }
     return 'info' // 默认值
   }

   /**
    * 转换为有效的 Button 类型
    */
   export function toElButtonType(type: string | undefined): ElButtonType {
     const validTypes: ElButtonType[] = ['primary', 'success', 'warning', 'info', 'danger', 'text', 'default']
     if (type && validTypes.includes(type as ElButtonType)) {
       return type as ElButtonType
     }
     return 'default' // 默认值
   }
   ```

   **步骤 B: 修复 CellPermissionManager.vue**
   ```vue
   <script setup lang="ts">
   import { toElTagType } from '@/utils/element-plus-helpers'
   import type { ElTagType } from '@/utils/element-plus-helpers'

   // 为动态类型添加显式类型
   function getPermissionTagType(status: string): ElTagType {
     if (status === 'active') return 'success'
     if (status === 'pending') return 'warning'
     return 'danger'
   }
   </script>

   <template>
     <!-- Before -->
     <el-tag :type="tagType">Label</el-tag>

     <!-- After -->
     <el-tag :type="getPermissionTagType(status)">Label</el-tag>
   </template>
   ```

   **步骤 C: 修复 FieldPermissionManager.vue**
   ```typescript
   // 修复布尔类型转换
   function handlePermissionChange(value: string | number | boolean) {
     // 类型守卫确保是 boolean
     const boolValue = typeof value === 'boolean' ? value : Boolean(value)
     updatePermission(boolValue)
   }
   ```

   **预期修复**: 6 个错误 (3 TS2322 + 3 TS2345)

4. **修复 SpreadsheetPermissionManager.vue 数组类型** (10分钟)
   ```bash
   # 查看第175行附近
   sed -n '170,180p' apps/web/src/components/SpreadsheetPermissionManager.vue
   ```

   ```typescript
   // Before
   const userIds: string = selectedUsers.map(u => u.id)

   // After - 选项 A: 修正类型为数组
   const userIds: string[] = selectedUsers.map(u => u.id)

   // After - 选项 B: 如果确实需要字符串
   const userIds: string = selectedUsers.map(u => u.id).join(',')
   ```

   **预期修复**: 1 个 TS2322 错误

**Phase 1 验证**:
```bash
cd apps/web
pnpm run type-check 2>&1 | tee /tmp/typecheck-phase1.txt
echo "Phase 1 Errors: $(grep -Ec 'TS[0-9]+' /tmp/typecheck-phase1.txt)"
# 应该显示约 810 个错误
```

**Phase 1 提交**:
```bash
git add apps/web/src/views/SpreadsheetView.vue \
        apps/web/src/utils/user-helpers.ts \
        apps/web/src/utils/element-plus-helpers.ts \
        apps/web/src/components/SpreadsheetPermissionManager.vue \
        packages/core/src/components/CellPermissionDialog.vue \
        packages/core/src/components/CellPermissionManager.vue \
        packages/core/src/components/FieldPermissionManager.vue

git commit -m "fix(web): B1-3 Phase1 - fix high-priority permission component errors

- Fix loadSpreadsheets → loadSpreadsheetList typo (3 errors)
- Add getUserDisplayName helper and fix User.name references (3 errors)
- Add Element Plus type helpers and fix type mismatches (6 errors)
- Fix SpreadsheetPermissionManager array type (1 error)

Total: -17 errors (827 → 810)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

#### 🔧 Phase 2: 工具类修复 (15分钟)

**目标**: 810 → ~808 errors (-2)

**任务清单**:

1. **修复 unified-font-patch.ts 模块问题** (10分钟)

   ```bash
   # 检查文件是否存在
   ls packages/core/src/utils/chinese-fonts.*
   ```

   **情况 A: 文件不存在**
   ```typescript
   // packages/core/src/utils/chinese-fonts.ts
   /**
    * 常用中文字体列表
    */
   export const chineseFonts: string[] = [
     'Microsoft YaHei',
     'PingFang SC',
     'Hiragino Sans GB',
     'SimSun',
     'SimHei',
     'STHeiti',
     'WenQuanYi Micro Hei'
   ]

   export default chineseFonts
   ```

   **情况 B: 文件存在但无类型**
   ```typescript
   // packages/core/src/utils/chinese-fonts.d.ts
   declare module './chinese-fonts' {
     const chineseFonts: string[]
     export default chineseFonts
   }
   ```

   **预期修复**: 1 个 TS2307 错误

2. **修复 VirtualizedSpreadsheet.ts 缺少属性** (5分钟)

   ```bash
   # 查看第111行
   sed -n '105,115p' packages/core/src/utils/VirtualizedSpreadsheet.ts
   ```

   ```typescript
   // Before (line 111)
   const config = {
     len: 100,
     width: 80,
     minWidth: 50
   }

   // After - 添加缺少的 indexWidth
   const config = {
     len: 100,
     width: 80,
     indexWidth: 60,  // 添加此属性
     minWidth: 50
   }
   ```

   **预期修复**: 1 个 TS2741 错误

**Phase 2 验证**:
```bash
pnpm run type-check 2>&1 | tee /tmp/typecheck-phase2.txt
echo "Phase 2 Errors: $(grep -Ec 'TS[0-9]+' /tmp/typecheck-phase2.txt)"
# 应该显示约 808 个错误
```

**Phase 2 提交**:
```bash
git add packages/core/src/utils/chinese-fonts.ts \
        packages/core/src/utils/VirtualizedSpreadsheet.ts

git commit -m "fix(core): B1-3 Phase2 - fix utility module errors

- Add chinese-fonts module to fix import error (1 error)
- Add missing indexWidth property in VirtualizedSpreadsheet (1 error)

Total: -2 errors (810 → 808)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

#### 🎯 Phase 3: 批量优化 (2-3 小时)

**目标**: 808 → <550 errors (-258+)

**策略 1: Element Plus 全局应用** (1小时)

```bash
# 1. 查找所有 Element Plus 类型错误
grep "Type 'string' is not assignable to type 'EpPropMergeType" /tmp/typecheck-phase2.txt

# 2. 列出受影响的文件
grep "Type 'string' is not assignable to type 'EpPropMergeType" /tmp/typecheck-phase2.txt | \
  grep -Eo '[^:]+\.vue' | sort -u

# 3. 批量修复每个文件
# 使用之前创建的 toElTagType, toElButtonType 辅助函数
```

**修复模板**:
```vue
<script setup lang="ts">
import { toElTagType, toElButtonType } from '@/utils/element-plus-helpers'

// 为所有动态类型添加显式类型
const getStatusType = (status: string) => {
  if (status === 'active') return 'success' as const
  if (status === 'pending') return 'warning' as const
  return 'danger' as const
}
</script>

<template>
  <!-- 使用显式类型函数 -->
  <el-tag :type="getStatusType(item.status)">{{ item.label }}</el-tag>
  <el-button :type="toElButtonType(buttonType)">Click</el-button>
</template>
```

**预期修复**: ~50 个 Element Plus 类型错误

**策略 2: TS2339 热区批量修复** (1小时)

```bash
# 1. 分析 TS2339 分布
grep 'TS2339' /tmp/typecheck-phase2.txt | \
  grep -Eo '[^/]+\.vue|[^/]+\.ts' | sort | uniq -c | sort -nr | head -20

# 2. 针对高频文件逐个修复
# 主要模式:
# - 添加可选链: obj.prop → obj?.prop
# - 添加非空断言: obj.prop → obj!.prop (确认非空时)
# - 添加类型守卫: if (obj && 'prop' in obj) { ... }
```

**修复模板**:
```typescript
// Pattern 1: 添加可选链
// Before
const name = user.profile.name

// After
const name = user?.profile?.name ?? 'Unknown'

// Pattern 2: 类型守卫
// Before
if (data.items) {
  data.items.forEach(item => console.log(item.name))
}

// After
if (data.items && Array.isArray(data.items)) {
  data.items.forEach(item => {
    if ('name' in item) {
      console.log(item.name)
    }
  })
}

// Pattern 3: 类型断言 (确认类型时)
// Before
const config = getConfig()
config.debug = true

// After
const config = getConfig() as Config
config.debug = true
```

**预期修复**: ~100 个 TS2339 错误

**策略 3: TS2322 类型不匹配批量修复** (1小时)

```bash
# 1. 分析 TS2322 错误模式
grep 'TS2322' /tmp/typecheck-phase2.txt | head -30

# 2. 常见模式修复
# - 添加类型注解
# - 使用 as const
# - 调整赋值类型
```

**修复模板**:
```typescript
// Pattern 1: 添加显式类型注解
// Before
const items = []
items.push({ id: 1, name: 'test' })

// After
const items: Array<{ id: number; name: string }> = []
items.push({ id: 1, name: 'test' })

// Pattern 2: 使用 as const
// Before
const STATUS_MAP = {
  active: 'success',
  pending: 'warning'
}

// After
const STATUS_MAP = {
  active: 'success',
  pending: 'warning'
} as const

// Pattern 3: 类型兼容转换
// Before
const count: number = getCount() // getCount returns string | number

// After
const count: number = Number(getCount())
// 或
const count = getCount()
if (typeof count === 'number') {
  // 使用 count
}
```

**预期修复**: ~100 个 TS2322 错误

**Phase 3 分批提交**:
```bash
# 提交 1: Element Plus 批量修复
git commit -m "fix(web): B1-3 Phase3.1 - batch fix Element Plus type errors"

# 提交 2: TS2339 批量修复
git commit -m "fix(web): B1-3 Phase3.2 - batch fix property access errors (TS2339)"

# 提交 3: TS2322 批量修复
git commit -m "fix(web): B1-3 Phase3.3 - batch fix type mismatch errors (TS2322)"
```

**Phase 3 最终验证**:
```bash
pnpm run type-check 2>&1 | tee /tmp/typecheck-phase3.txt
FINAL_ERRORS=$(grep -Ec 'TS[0-9]+' /tmp/typecheck-phase3.txt)

echo "=== B1-3 Final Results ==="
echo "Baseline: 827 errors"
echo "Final: $FINAL_ERRORS errors"
echo "Reduction: $((827 - FINAL_ERRORS)) errors"
echo "Percentage: $(((827 - FINAL_ERRORS) * 100 / 827))%"

if [ $FINAL_ERRORS -lt 550 ]; then
  echo "✅ Target achieved! ($FINAL_ERRORS < 550)"
else
  echo "⚠️  Need more fixes (current: $FINAL_ERRORS, target: <550)"
fi
```

---

## 🔧 辅助工具与脚本

### 快速错误分析脚本

```bash
#!/bin/bash
# save as: scripts/analyze-ts-errors.sh

REPORT_FILE="${1:-/tmp/typecheck-report.txt}"

echo "=== TypeScript Error Analysis ==="
echo ""
echo "Total Errors: $(grep -Ec 'TS[0-9]+' $REPORT_FILE)"
echo ""

echo "Top 15 Error Types:"
grep -Eo 'TS[0-9]+' $REPORT_FILE | sort | uniq -c | sort -nr | head -15
echo ""

echo "Top 10 Files with Most Errors:"
grep 'TS[0-9]+' $REPORT_FILE | \
  grep -Eo '[^/]+\.vue|[^/]+\.ts' | \
  sort | uniq -c | sort -nr | head -10
echo ""

echo "Error Distribution by Domain:"
echo "Permissions domain:"
grep -i 'permission' $REPORT_FILE | grep -c 'TS[0-9]+'
echo "User domain:"
grep -i 'user' $REPORT_FILE | grep -c 'TS[0-9]+'
echo "Department domain:"
grep -i 'department' $REPORT_FILE | grep -c 'TS[0-9]+'
```

### 增量验证脚本

```bash
#!/bin/bash
# save as: scripts/verify-phase.sh

PHASE=$1
EXPECTED_MAX=$2

if [ -z "$PHASE" ] || [ -z "$EXPECTED_MAX" ]; then
  echo "Usage: $0 <phase> <expected_max_errors>"
  echo "Example: $0 1 810"
  exit 1
fi

echo "=== Verifying Phase $PHASE ==="
cd apps/web
pnpm run type-check 2>&1 | tee /tmp/typecheck-phase-${PHASE}.txt

ACTUAL=$(grep -Ec 'TS[0-9]+' /tmp/typecheck-phase-${PHASE}.txt)

echo ""
echo "Expected: <=$EXPECTED_MAX errors"
echo "Actual: $ACTUAL errors"

if [ $ACTUAL -le $EXPECTED_MAX ]; then
  echo "✅ Phase $PHASE PASSED"
  exit 0
else
  echo "❌ Phase $PHASE needs review (expected <=$EXPECTED_MAX, got $ACTUAL)"
  echo ""
  echo "Analyzing remaining errors..."
  bash scripts/analyze-ts-errors.sh /tmp/typecheck-phase-${PHASE}.txt
  exit 1
fi
```

### Git 提交辅助脚本

```bash
#!/bin/bash
# save as: scripts/commit-phase.sh

PHASE=$1
DESCRIPTION=$2

if [ -z "$PHASE" ]; then
  echo "Usage: $0 <phase> [description]"
  echo "Example: $0 1 'Fix SpreadsheetView and User.name'"
  exit 1
fi

# 获取错误数
ERRORS=$(pnpm -C apps/web run type-check 2>&1 | grep -Ec 'TS[0-9]+')

# 生成提交信息
cat > /tmp/commit-msg-${PHASE}.txt << EOF
fix(web): B1-3 Phase${PHASE} - ${DESCRIPTION:-error fixes}

Current errors: $ERRORS

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF

echo "Generated commit message:"
cat /tmp/commit-msg-${PHASE}.txt
echo ""
echo "Review and edit if needed, then commit with:"
echo "git commit -F /tmp/commit-msg-${PHASE}.txt"
```

---

## 📋 完整执行检查清单

### 准备阶段
- [ ] 确认当前在 `feat/web-types-B1-permissions` 分支
- [ ] 确认当前错误基线（应该是 827）
- [ ] 准备辅助脚本（可选）
- [ ] 设置工作环境（VSCode + TypeScript 扩展）

### Phase 1: 快速胜利 (预计 1-1.5 小时)
- [ ] 修复 SpreadsheetView.vue 方法名（10分钟）
- [ ] 创建 user-helpers.ts（15分钟）
- [ ] 修复 CellPermissionDialog.vue（包含在上一步）
- [ ] 创建 element-plus-helpers.ts（15分钟）
- [ ] 修复 CellPermissionManager.vue（10分钟）
- [ ] 修复 FieldPermissionManager.vue（15分钟）
- [ ] 修复 SpreadsheetPermissionManager.vue（10分钟）
- [ ] 运行 Phase 1 验证（5分钟）
- [ ] Git 提交 Phase 1

**验证点**: 错误数应约为 810

### Phase 2: 工具类修复 (预计 15分钟)
- [ ] 处理 chinese-fonts 模块（10分钟）
- [ ] 修复 VirtualizedSpreadsheet.ts（5分钟）
- [ ] 运行 Phase 2 验证
- [ ] Git 提交 Phase 2

**验证点**: 错误数应约为 808

### Phase 3: 批量优化 (预计 2-3 小时)
- [ ] Element Plus 全局应用（1小时）
  - [ ] 查找所有 Element Plus 错误
  - [ ] 批量修复各文件
  - [ ] 提交 Phase 3.1
- [ ] TS2339 批量修复（1小时）
  - [ ] 分析错误分布
  - [ ] 添加可选链和类型守卫
  - [ ] 提交 Phase 3.2
- [ ] TS2322 批量修复（1小时）
  - [ ] 分析错误模式
  - [ ] 添加类型注解和转换
  - [ ] 提交 Phase 3.3
- [ ] 运行最终验证
- [ ] 推送所有提交到远程

**目标验证点**: 错误数应 <550

### 后续工作
- [ ] 更新 PR #331 描述
- [ ] 生成 B1-3 实施报告
- [ ] 等待 CI 验证
- [ ] 准备 PR 评审

---

## 🚨 常见问题与解决方案

### Q1: Phase 1 修复后错误数没有明显减少
**A**: 检查以下几点：
- 确认文件保存并且 TypeScript 服务器重启
- 运行 `pnpm run type-check` 而不是依赖 IDE
- 检查是否有语法错误导致新的错误

### Q2: Element Plus 类型辅助函数不生效
**A**: 确保：
- 函数返回类型正确（使用 `as const` 或显式类型）
- 导入路径正确
- 在模板中正确使用函数

### Q3: 批量修复引入新的运行时错误
**A**:
- 仅添加类型注解，不修改逻辑
- 使用可选链 `?.` 而不是非空断言 `!`
- 每个 Phase 完成后运行应用手动测试

### Q4: 错误数减少不够，无法达到 <550
**A**:
- 分析剩余错误的分布
- 考虑扩展到相关域（Department, Workflow）
- 考虑临时使用 `// @ts-ignore` 标记复杂问题（需注释原因）

### Q5: Git 冲突问题
**A**:
- 保持小步提交，及时推送
- 如果需要基于最新 main，使用 `git rebase main`
- 解决冲突后继续 rebase: `git rebase --continue`

---

## 📊 成功指标

### 定量指标

```
✅ 必须达成:
- TypeScript 错误 <550 (当前 827)
- 错误减少率 ≥33%

✅ 期望达成:
- TS2339 错误 <300 (当前 415)
- TS2322 错误 <100 (当前 145)
- TS2345 错误 <40 (当前 56)
```

### 定性指标

- ✅ 所有权限相关组件的高频错误已修复
- ✅ 建立了可复用的类型辅助函数库
- ✅ 代码无破坏性更改，运行时行为不变
- ✅ Git 历史清晰，提交信息完整

---

## 🎯 最终检查清单

### 代码质量
- [ ] 所有修改的文件通过 ESLint
- [ ] 没有使用 `// @ts-ignore` (或有明确注释)
- [ ] 没有使用 `any` 类型（或有明确理由）
- [ ] 所有辅助函数有 JSDoc 注释

### 测试验证
- [ ] 运行 `pnpm run type-check` 无致命错误
- [ ] 运行 `pnpm run build` 成功
- [ ] 手动测试权限相关功能正常
- [ ] 浏览器控制台无新的运行时错误

### Git 管理
- [ ] 所有改动已提交
- [ ] 提交信息清晰且符合规范
- [ ] 已推送到远程分支
- [ ] PR #331 描述已更新

### 文档完善
- [ ] 生成 B1-3 实施报告
- [ ] 更新错误统计数据
- [ ] 记录遇到的问题和解决方案

---

## 📚 参考资源

### 项目文档
- B1_PERMISSIONS_TYPES_PLAN.md - 总体规划
- B1_IMPLEMENTATION_REPORT.md - B1-1/B1-2 报告
- B1-3_ERROR_FIXING_GUIDE.md - 详细修复指南
- B1_STATUS_CORRECTION.md - 状态更正说明

### 外部资源
- [TypeScript 手册](https://www.typescriptlang.org/docs/)
- [Element Plus TypeScript](https://element-plus.org/en-US/guide/typescript.html)
- [Vue 3 TypeScript](https://vuejs.org/guide/typescript/overview.html)
- [Pinia TypeScript](https://pinia.vuejs.org/cookbook/typing.html)

### 工具链
- vue-tsc: TypeScript 编译器
- ESLint: 代码质量检查
- Vite: 构建工具
- pnpm: 包管理器

---

## 🎉 完成后的后续步骤

### 立即行动
1. **推送代码**:
   ```bash
   git push origin feat/web-types-B1-permissions
   ```

2. **更新 PR #331 描述**，添加 B1-3 成果

3. **等待 CI 验证**，确认所有检查通过

### 短期计划
1. **等待代码评审**
2. **合并 PR #331**（在 PR #330 之后）
3. **启动 B2**（Department 域类型）
4. **启动 B3**（User 域类型）

### 中期计划
1. **渐进收紧 TypeScript**
   - 错误 <400 时，启用 `strictNullChecks`
   - 错误 <200 时，启用 `strict`
2. **恢复 ESLint 检查**
   - 将规则从 warn 提升为 error
3. **完善测试覆盖**
   - 为新增辅助函数添加单元测试

---

**文档维护**: 随着工作进展持续更新
**最后更新**: 2025-10-28
**创建人**: Claude Code
**版本**: 1.0

🚀 **准备好开始 B1-3 了吗？按照 Phase 1 开始执行！**
