# PR #337 手动Rebase操作指南

**文档日期**: 2025-11-02
**PR编号**: #337
**PR标题**: feat(web): Phase 3 – DTO typing (batch1)
**状态**: 需要手动rebase

---

## 📋 问题概述

### 为何需要手动处理

PR #337包含21个commits，总计**9,771行代码变更**，在自动rebase过程中遇到以下复杂情况：

| 指标 | 数值 | 说明 |
|------|------|------|
| 总commits | 21个 | 完整的Phase 3 DTO typing改造 |
| 代码变更 | +9,771 / -112 | 大规模类型系统重构 |
| 冲突文件 | 至少2个 | KanbanView.vue, GridView.vue |
| GridView.vue冲突 | 7处 | 集中在1500-1580行区域 |
| 已处理进度 | 9/21 (43%) | 在第9个commit遇到GridView冲突 |

**自动解决风险**:
- ❌ 冲突涉及TypeScript类型定义，需要深入理解类型系统
- ❌ GridView.vue是2000+行的大文件，错误解决可能导致运行时错误
- ❌ 21个commits中预计还有更多冲突未被发现
- ❌ 缺乏项目上下文，无法准确判断应保留哪些变更

---

## 🎯 手动Rebase步骤

### 准备工作

```bash
# 1. 确保在正确的仓库和分支
cd /Users/huazhou/Insync/hua.chau@outlook.com/OneDrive/应用/GitHub/smartsheet
git checkout feat/phase3-web-dto-batch1
git status  # 确认无未提交修改

# 2. 备份当前分支（以防万一）
git branch backup/feat/phase3-web-dto-batch1-20251102

# 3. 获取最新main
git fetch origin
git log origin/main --oneline -5  # 查看main最新commits
```

### Step 1: 开始Rebase

```bash
# 开始交互式rebase（推荐）或普通rebase
git rebase origin/main

# 或者使用交互式rebase来跳过某些commits
# git rebase -i origin/main
```

**预期输出**:
```
Rebasing (1/21)
Rebasing (2/21)
Rebasing (3/21)
error: could not apply a7a8afd9... fix(ts): Phase 0 - Remove deprecated config
CONFLICT (content): Merge conflict in metasheet-v2/apps/web/src/views/KanbanView.vue
```

### Step 2: 解决KanbanView.vue冲突

**冲突位置**: Line 56 和 Line 83

#### 冲突1: Import语句 (Line 56)

**HEAD版本** (main分支):
```typescript
import { ref, onMounted } from 'vue'
```

**PR版本** (feat/phase3-web-dto-batch1):
```typescript
import { ref, onMounted, computed } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from '../composables/useAuth'
import { getApiBase } from '../utils/api'
```

**推荐解决**: 保留PR版本（完整的imports）
```bash
# 编辑文件，选择PR版本的imports
# 删除 <<<<<<< HEAD, =======, >>>>>>> 标记
```

#### 冲突2: 变量和函数定义 (Line 83)

**HEAD版本** (main分支):
```typescript
const columns = ref<Column[]>([])
const loading = ref(true)
const error = ref('')
const draggedCard = ref<{ card: Card; fromColumn: string } | null>(null)
```

**PR版本** (feat/phase3-web-dto-batch1):
```typescript
const columns = ref<Column[]>([])
const loading = ref(true)
const error = ref('')
const draggedCard = ref<{ card: Card; fromColumn: string } | null>(null)
const etag = ref<string>('')
const { buildAuthHeaders } = useAuth()

function debounce<T extends (...args: any[]) => any>(fn: T, wait = 400) {
  let t: number | undefined
  return (...args: Parameters<T>) => {
    if (t) window.clearTimeout(t)
    t = window.setTimeout(() => fn(...args), wait)
  }
}
```

**推荐解决**: 保留PR版本（添加了etag, buildAuthHeaders, debounce）

**操作命令**:
```bash
# 标记冲突已解决
git add metasheet-v2/apps/web/src/views/KanbanView.vue

# 继续rebase
git rebase --continue
```

### Step 3: 解决GridView.vue冲突

**预期**: 在commit 9/21时遇到GridView.vue冲突

**冲突位置**: 7处，集中在1500-1580行

**查看冲突**:
```bash
# 查看所有冲突位置
grep -n "<<<<<<< HEAD" metasheet-v2/apps/web/src/views/GridView.vue

# 输出示例:
# 1501:<<<<<<< HEAD
# 1512:<<<<<<< HEAD
# 1523:<<<<<<< HEAD
# 1534:<<<<<<< HEAD
# 1557:<<<<<<< HEAD
# 1568:<<<<<<< HEAD
# 1579:<<<<<<< HEAD
```

**解决策略**:

由于这是"Phase 1 Batch 5 - fix GridView.vue type errors"的commit，冲突很可能是类型定义相关：

1. **查看commit内容**:
```bash
git show dccdb257 --name-only
git show dccdb257 metasheet-v2/apps/web/src/views/GridView.vue | less
```

2. **分析冲突**:
   - PR版本包含TypeScript类型修复
   - main版本可能是旧的类型定义或没有类型
   - 通常应该保留PR版本（更完善的类型）

3. **编辑冲突区域**:
```bash
# 使用编辑器打开文件
code metasheet-v2/apps/web/src/views/GridView.vue
# 或
vim metasheet-v2/apps/web/src/views/GridView.vue

# 跳转到第1501行开始处理
```

4. **逐个解决冲突**:
   - 阅读两个版本的差异
   - 理解PR版本添加的类型定义
   - 保留PR版本的TypeScript改进
   - 删除冲突标记

5. **标记解决**:
```bash
git add metasheet-v2/apps/web/src/views/GridView.vue
git rebase --continue
```

### Step 4: 处理后续冲突

**预期**: 在剩余12个commits (10-21) 中可能还有冲突

**通用解决流程**:
```bash
# 每次遇到冲突时:
# 1. 查看冲突文件
git status

# 2. 编辑并解决冲突
# 理解两个版本的差异
# 通常保留PR版本（Phase 3的类型改进）

# 3. 标记已解决
git add <resolved_file>

# 4. 继续rebase
git rebase --continue

# 如果某个commit不需要（很少见）:
# git rebase --skip
```

**重要提示**:
- ✅ 保留PR的TypeScript类型定义
- ✅ 保留PR的DTO typing改进
- ✅ 保留PR的API统一化
- ⚠️ 如果不确定，使用`git show <commit>`查看原始intent

### Step 5: 完成Rebase

```bash
# 所有冲突解决后，检查状态
git status
# 应该显示: nothing to commit, working tree clean

# 查看rebase后的log
git log origin/main..HEAD --oneline

# 应该看到21个commits干净地应用在main之上
```

### Step 6: 验证代码

```bash
# 1. 本地typecheck
cd metasheet-v2
pnpm install --frozen-lockfile=false
pnpm -F @metasheet/web exec vue-tsc -b

# 2. 检查是否有语法错误
pnpm -F @metasheet/web lint

# 3. 尝试构建
pnpm -F @metasheet/web build
```

### Step 7: Force Push

⚠️ **警告**: Force push会覆盖远程分支历史

```bash
# 使用 --force-with-lease 更安全
git push --force-with-lease origin feat/phase3-web-dto-batch1

# 如果失败（有其他人push了新commits）:
# git pull --rebase
# git push --force-with-lease
```

### Step 8: 等待CI并合并

```bash
# 1. 检查CI状态
gh pr checks 337

# 预期输出:
# Migration Replay     pass
# lint-type-test-build pass
# smoke                pass
# typecheck            pass

# 2. 合并PR
gh pr merge 337 --squash --delete-branch
```

---

## 🔍 冲突解决参考

### TypeScript冲突通用原则

1. **Import语句冲突**:
   - 保留PR版本的完整imports
   - PR通常添加了更多类型导入

2. **类型定义冲突**:
   - 保留PR版本的显式类型
   - 例如: `ref<string>('')` 优于 `ref('')`

3. **函数签名冲突**:
   - 保留PR版本的类型注解
   - 例如: `function foo(x: number): string` 优于 `function foo(x)`

4. **接口/类型冲突**:
   - 保留PR版本的完整接口定义
   - 检查是否有向后兼容性问题

### 实际冲突示例

#### 示例1: Import冲突

```typescript
<<<<<<< HEAD
import { ref } from 'vue'
=======
import { ref, computed } from 'vue'
import { useRoute } from 'vue-router'
>>>>>>> PR_COMMIT

// 解决方案: 保留下面的版本（更完整）
import { ref, computed } from 'vue'
import { useRoute } from 'vue-router'
```

#### 示例2: 类型注解冲突

```typescript
<<<<<<< HEAD
const count = ref(0)
=======
const count = ref<number>(0)
>>>>>>> PR_COMMIT

// 解决方案: 保留显式类型
const count = ref<number>(0)
```

#### 示例3: 函数参数类型冲突

```typescript
<<<<<<< HEAD
function handleClick(event) {
  // ...
}
=======
function handleClick(event: MouseEvent): void {
  // ...
}
>>>>>>> PR_COMMIT

// 解决方案: 保留完整类型签名
function handleClick(event: MouseEvent): void {
  // ...
}
```

---

## 🛠️ 故障排除

### 问题1: Rebase中途卡住

**症状**:
```bash
You are currently rebasing branch 'feat/phase3-web-dto-batch1' on '1db630e3'.
(all conflicts fixed: run "git rebase --continue")
```

**解决**:
```bash
# 检查是否所有冲突都已解决
git status

# 如果有未add的文件
git add <file>

# 继续rebase
git rebase --continue
```

### 问题2: 某个commit解决后又出现错误

**症状**:
```
error: commit is not possible because you have unmerged files.
```

**解决**:
```bash
# 查看哪些文件还有冲突
git diff --name-only --diff-filter=U

# 重新编辑这些文件
# 然后
git add <file>
git rebase --continue
```

### 问题3: 想要重新开始

**解决**:
```bash
# 中止当前rebase
git rebase --abort

# 回到备份分支
git checkout backup/feat/phase3-web-dto-batch1-20251102

# 重新创建工作分支
git checkout -b feat/phase3-web-dto-batch1
git push --force-with-lease origin feat/phase3-web-dto-batch1

# 重新开始rebase
git rebase origin/main
```

### 问题4: Typecheck失败

**症状**:
Rebase完成后，`vue-tsc -b`报错

**调查**:
```bash
# 查看具体错误
pnpm -F @metasheet/web exec vue-tsc -b 2>&1 | tee typecheck-errors.txt

# 常见原因:
# 1. 冲突解决时删除了重要的类型导入
# 2. 保留了main的旧类型而不是PR的新类型
# 3. 类型定义不完整
```

**修复**:
```bash
# 查看PR原始版本的文件
git show feat/phase3-web-dto-batch1:<file_path>

# 对比当前版本
git diff origin/feat/phase3-web-dto-batch1 <file_path>

# 手动修复类型错误
# 然后重新commit
git add <file>
git commit --amend --no-edit
git push --force-with-lease
```

---

## 📚 有用命令参考

### Git命令

```bash
# 查看当前rebase状态
git status

# 查看正在应用的commit
cat .git/rebase-merge/stopped-sha

# 查看当前commit的信息
git show $(cat .git/rebase-merge/stopped-sha)

# 查看还有多少commits待处理
cat .git/rebase-merge/git-rebase-todo

# 跳过当前commit（谨慎使用）
git rebase --skip

# 编辑rebase计划（高级）
git rebase --edit-todo

# 中止rebase
git rebase --abort

# 继续rebase
git rebase --continue
```

### 冲突分析命令

```bash
# 查看冲突文件列表
git diff --name-only --diff-filter=U

# 查看某个文件的冲突详情
git diff <file>

# 查看冲突数量
grep -r "<<<<<<< HEAD" . | wc -l

# 查看PR分支原始版本
git show origin/feat/phase3-web-dto-batch1:<file_path>

# 查看main分支版本
git show origin/main:<file_path>
```

### PR和CI命令

```bash
# 查看PR状态
gh pr view 337

# 查看PR checks
gh pr checks 337

# 重新运行失败的workflow
gh run list --branch feat/phase3-web-dto-batch1 --limit 5
gh run rerun <RUN_ID>

# 查看特定workflow的logs
gh run view <RUN_ID> --log
```

---

## ⏱️ 预估时间

| 阶段 | 预估时间 | 说明 |
|------|----------|------|
| 准备工作 | 5-10分钟 | 备份分支、理解冲突 |
| 解决KanbanView | 10-15分钟 | 2个简单冲突 |
| 解决GridView | 30-45分钟 | 7个复杂冲突需仔细检查 |
| 解决其他冲突 | 30-60分钟 | 预计还有3-5个冲突文件 |
| 验证和测试 | 20-30分钟 | Typecheck, lint, build |
| Push和CI | 15-20分钟 | 等待CI通过 |
| **总计** | **2-3小时** | 取决于冲突复杂度 |

**建议**:
- 🕐 选择连续的时间段进行，避免中断
- ☕ 休息时执行CI检查
- 📝 记录遇到的问题和解决方案
- 💾 经常保存编辑器状态

---

## ✅ 最终检查清单

完成rebase后，确保：

- [ ] 所有21个commits都已成功rebase
- [ ] `git status`显示working tree clean
- [ ] `git log`显示commits干净地应用在main之上
- [ ] 本地typecheck通过: `pnpm -F @metasheet/web exec vue-tsc -b`
- [ ] 本地lint通过: `pnpm -F @metasheet/web lint`
- [ ] 本地build成功: `pnpm -F @metasheet/web build`
- [ ] Force push成功: `git push --force-with-lease`
- [ ] CI checks全部通过: `gh pr checks 337`
  - [ ] Migration Replay: PASS
  - [ ] lint-type-test-build: PASS
  - [ ] smoke: PASS
  - [ ] typecheck: PASS
- [ ] PR可以合并: `gh pr view 337 --json mergeable`

---

## 🎉 成功标志

Rebase成功后，你应该看到：

```bash
$ gh pr view 337 --json mergeable,mergeStateStatus
{
  "mergeStateStatus": "CLEAN",
  "mergeable": "MERGEABLE"
}

$ gh pr checks 337
Migration Replay         pass ✅
lint-type-test-build     pass ✅
smoke                    pass ✅
typecheck                pass ✅
```

此时可以安全合并：
```bash
gh pr merge 337 --squash --delete-branch
```

---

## 📞 需要帮助?

如果遇到无法解决的问题：

1. **保存当前状态**:
```bash
git bundle create pr337-rebase-state.bundle HEAD
# 保存到安全位置
```

2. **收集信息**:
```bash
git status > rebase-status.txt
git log --oneline -30 > rebase-log.txt
git diff > current-diff.txt
```

3. **中止并寻求帮助**:
```bash
git rebase --abort
git checkout backup/feat/phase3-web-dto-batch1-20251102
# 联系项目维护者或熟悉codebase的人
```

---

**文档生成时间**: 2025-11-02 14:00:00
**适用PR**: #337
**依赖**: Git 2.x, GitHub CLI, pnpm 8+
**作者**: CI Bot (Claude Code)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
