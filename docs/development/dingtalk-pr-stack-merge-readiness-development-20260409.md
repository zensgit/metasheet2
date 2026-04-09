# DingTalk 堆叠 PR 合并就绪开发说明

日期：2026-04-09  
分支：`codex/dingtalk-pr3-attendance-notify-20260408`

## 当前状态快照

### PR 状态

1. `#725`
   - 标题：`feat(dingtalk): add oauth login foundation`
   - base：`main`
   - 初始状态：`draft`

2. `#723`
   - 标题：`feat(dingtalk): add directory sync admin slice`
   - base：`codex/dingtalk-pr1-foundation-login-20260408`
   - 状态：`draft`

3. `#724`
   - 标题：`feat(dingtalk): harden attendance sync and delegated admin controls`
   - base：`codex/dingtalk-pr2-directory-sync-20260408`
   - 状态：`draft`

### Checks 状态

1. `#725`
   - GitHub full checks 已全绿

2. `#723`
   - 当前只看到 `pr-validate`
   - 仍不足以作为 merge gate

3. `#724`
   - 当前只看到 `pr-validate`
   - 仍不足以作为 merge gate

## 本轮动作

### 1. 文档补充

新增 2 份合并就绪文档：

1. [dingtalk-pr-stack-merge-readiness-design-20260409.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/docs/development/dingtalk-pr-stack-merge-readiness-design-20260409.md)
2. [dingtalk-pr-stack-merge-readiness-development-20260409.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase3-20260408/docs/development/dingtalk-pr-stack-merge-readiness-development-20260409.md)

### 2. PR 文本收口

对三条 PR 做统一收口：

1. 补充当前 gate 状态
2. 明确 review 顺序
3. 说明 `#723/#724` 为什么仍保持 draft
4. 在 `#724` 正文里补上本轮 stack merge-readiness 文档入口

### 3. Draft / Ready 状态

执行规则：

1. `#725` 由 draft 转为 `Ready for review`
2. `#723` 继续保持 draft，直到 `#725` 合并后 retarget 到 `main`
3. `#724` 继续保持 draft，直到 `#723` 合并后 retarget 到 `main`

## 后续串行动作

1. review `#725`
2. `#725` 合并后 retarget `#723 -> main`
3. 等 `#723` full checks 跑完，再转 ready
4. `#723` 合并后 retarget `#724 -> main`
5. 等 `#724` full checks 跑完，再转 ready

## 本轮不执行

1. 不合并任何 PR
2. 不改生产参数
3. 不触发生产发布
