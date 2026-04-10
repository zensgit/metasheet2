# DingTalk 堆叠 PR 合并就绪开发说明

日期：2026-04-09  
分支：`codex/dingtalk-pr3-attendance-notify-20260408`

## 当前状态快照

### PR 状态

1. `#725`
   - 标题：`feat(dingtalk): add oauth login foundation`
   - base：`main`
   - 当前状态：`Ready for review`
   - 最新 head：`584fac083`
   - 当前 gate：代码与 full checks 已通过，仅剩人工 review / approval

2. `#723`
   - 标题：`feat(dingtalk): add directory sync admin slice`
   - base：`codex/dingtalk-pr1-foundation-login-20260408`
   - 状态：`draft`
   - 当前 gate：等待 `#725` 合并后 retarget 到 `main`

3. `#724`
   - 标题：`feat(dingtalk): harden attendance sync and delegated admin controls`
   - base：`codex/dingtalk-pr2-directory-sync-20260408`
   - 状态：`draft`
   - 当前 gate：等待 `#723` 合并后 retarget 到 `main`

### Checks 状态

1. `#725`
   - GitHub full checks 已全绿
   - `mergeStateStatus=BLOCKED`
   - `reviewDecision=REVIEW_REQUIRED`

2. `#723`
   - 当前仍是 stacked base
   - retarget 前不以 GitHub checks 作为最终 merge gate

3. `#724`
   - 当前仍是 stacked base
   - retarget 前不以 GitHub checks 作为最终 merge gate

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

### 4. PR1 最终 review-fix 收口

`#725` 在转 ready 之后又完成了三轮最小 review-fix：

1. `68d5d6d85`
   - 拒绝本地已停用/禁用用户通过钉钉登录
   - auto-provision 写入 `password_hash`
2. `cc97a9913`
   - 把上述修复 refresh 到更新后的 `main`
3. `584fac083`
   - `corpId` 存在时，fallback identity lookup 也必须命中同一 `corp_id`

对应文档入口继续使用：

1. [dingtalk-pr1-review-design-20260409.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-review-fixes-20260409/docs/development/dingtalk-pr1-review-design-20260409.md)
2. [dingtalk-pr1-review-development-20260409.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-review-fixes-20260409/docs/development/dingtalk-pr1-review-development-20260409.md)
3. [dingtalk-pr1-review-verification-20260409.md](/Users/huazhou/Downloads/Github/metasheet2/.worktrees/dingtalk-phase1-review-fixes-20260409/docs/development/dingtalk-pr1-review-verification-20260409.md)

### 3. Draft / Ready 状态

执行规则：

1. `#725` 由 draft 转为 `Ready for review`
2. `#723` 继续保持 draft，直到 `#725` 合并后 retarget 到 `main`
3. `#724` 继续保持 draft，直到 `#723` 合并后 retarget 到 `main`

## 后续串行动作

1. 等 owner / reviewer 审并批准 `#725`
2. `#725` 合并后 retarget `#723 -> main`
3. 解决 retarget 引起的最小冲突并跑 full checks
4. `#723` 转 ready 并等待 review
5. `#723` 合并后 retarget `#724 -> main`
6. 解决 retarget 引起的最小冲突并跑 full checks
7. `#724` 转 ready 并等待 review

## 本轮不执行

1. 不合并任何 PR
2. 不改生产参数
3. 不触发生产发布
