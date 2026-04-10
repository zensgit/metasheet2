# DingTalk 堆叠 PR 合并就绪设计

日期：2026-04-09  
分支：`codex/dingtalk-pr3-attendance-notify-20260408`

## 目标

把 DingTalk 三条堆叠 PR 收敛到“可审、可批、可顺序合并”的状态，不在这一步继续扩功能，也不把生产发布纳入执行范围。

## 堆叠结构

当前堆叠顺序固定为：

1. `#725` `main <- codex/dingtalk-pr1-foundation-login-20260408`
2. `#723` `codex/dingtalk-pr1-foundation-login-20260408 <- codex/dingtalk-pr2-directory-sync-20260408`
3. `#724` `codex/dingtalk-pr2-directory-sync-20260408 <- codex/dingtalk-pr3-attendance-notify-20260408`

该顺序不调整，不并栈，不重写历史。

## Gate 设计

### PR1 `#725`

定位：

- OAuth/login foundation
- 作为后续目录同步与考勤/RBAC 的 stack base

合并就绪门槛：

1. GitHub full checks 全绿
2. PR 正文明确 review order、验证命令、已知风险
3. 转为 `Ready for review`

### PR2 `#723`

定位：

- 目录同步 admin slice
- 依赖 `#725` 已先合并

合并就绪门槛：

1. 在 `#725` 合并前保持 draft
2. `#725` 合并后，把 base 改到 `main`
3. retarget 后重新跑完整 GitHub checks
4. 只有 `pr-validate` 不算通过 gate

### PR3 `#724`

定位：

- 考勤加固、钉钉通知、grant login gate、管理员/RBAC 委派控制
- 依赖 `#723` 已先合并

合并就绪门槛：

1. 在 `#723` 合并前保持 draft
2. `#723` 合并后，把 base 改到 `main`
3. retarget 后重新跑完整 GitHub checks
4. review findings 全部清零
5. live tenant 的 attendance/notification 仍可作为“阻塞生产、不阻塞代码审查”的已知风险保留

## 默认策略

本轮计划默认采用以下生产登录策略，但只作为 merge-readiness 的目标策略说明，不在本计划中执行生产切换：

```env
DINGTALK_AUTH_REQUIRE_GRANT=1
DINGTALK_AUTH_AUTO_LINK_EMAIL=1
DINGTALK_AUTH_AUTO_PROVISION=0
```

含义：

1. 必须是系统已有用户
2. 必须已被平台管理员开通钉钉扫码
3. 首次允许按邮箱完成绑定
4. 不自动创建新用户

## 非目标

这一步不做：

1. 生产环境发布
2. 生产环境参数切换
3. 继续新增 DingTalk 功能
4. 重新拆分或合并 PR 栈
