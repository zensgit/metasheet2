# #6668 本地修复与验证

> 本文保留原父切片的历史验证。最新父提交 `69a106f3c767346165f3cb98b59fa45dabb8ba55` 与子切片的组合及 Vite 定位，见同目录 `admin-users-latest-parent-combination-vite-verification-20261101.md`；不要把历史父单独验证当作最新远端 CI。

基线、权限范围见同目录 `admin-users-6668-6676-review-fixes-design-lock-20261101.md`。未提交、未推送、未合并、未部署。

## 实现

Grok 4.7 high 实现；Codex 整合隔离数据库、CI 测试链和回归测试；Astra ultra 独立只读复核。显式角色替换不再由旧显示字段决定是否跳过；命名空间锁、用户锁和实际成员关系读写同事务。保留新角色需要的命名空间，删除旧角色时登记防重新引导见证。状态更新推进 generation 并废止旧恢复证据。双身份键必须指向同一用户；自停用在任何附带写入前拒绝。

四条批量写路由进入权限登记守卫，按 mount+gate 保留已有故障路径覆盖。前端新测试进入领域 workflow 和 required web chain。新增无分支过滤的领域及真实数据库 workflow 支持堆叠 PR；没有删掉现有测试链。

## 本地证据

环境为专用原生 macOS PostgreSQL 15，460 个基线迁移成功；只含合成数据，不代表 Linux CI 等价。Mac mini SSD 空间不足，未启动其环境。环境复查发现早期 Node 20 的 Homebrew 路径不存在，命令实际回退到 Node 24.14.1；下表早期证据保留该限制。最终组合验证另行显式固定 NVM Node 20.20.2 与 pnpm 10.33.0，结果见 #6676 收尾报告及 `node20-*.log`，不把原日志重新标为 Node 20。

| 门槛 | 结果 |
|---|---|
| 后端计划、路由、权限登记及角色边界 | 245 passed |
| 前端批量帮助器及邻近管理页面 | 130 passed |
| 真实 JWT / PostgreSQL 回归 | 8 passed |
| 后端 `tsc --noEmit` | PASS |
| mutation | 角色撤销、generation、自停用、身份冲突、并发序列化、撤销见证均观察到红灯 |
| Astra ultra 两轮复核 | 初轮六项问题；最终限定源码 PASS |
| `pnpm validate:all` | HOLD：未修改 Vite 配置 TS2769；原始 main 配置同依赖下复现 |
| 远端 CI | 未执行，未公开本地补丁 |

命令：`pnpm --filter @metasheet/core-backend exec vitest run --no-cache tests/unit/admin-user-batch-plan.test.ts tests/unit/admin-user-batch-routes.test.ts tests/unit/admin-mounts-write-gate-guard.test.ts tests/unit/role-assignment-boundary.test.ts`；真实数据库使用 `EXPECT_DB=1`、显式专用 `DATABASE_URL`、`vitest.integration.config.ts` 和 `tests/integration/admin-user-batch-review.db.test.ts`。前端运行 `adminUserBatch.spec.ts`、`userManagementView.spec.ts`、`userManagementRoleMembership.spec.ts`。

日志保留在 `artifacts/admin-review-fixes-20261101/parent-*.log`。初版并发测试使用与原角色相同的第二替换值，未杀死 mutation；改为两个不同替换角色后，删除序列化锁会产生多余成员关系，测试确实失败。变异仅在私有副本进行，未污染候选源码。

## 复核边界与剩余项

收尾时远端 #6668 已前进到 `155caa075e4593183f0c5f128b1e671c243dc2bd`，新增生产路由注册和类型收窄修复。本地冻结补丁尚未与这两项并行提交重放整合，不能据此宣称最新 PR 已完成验收；不能用本补丁直接覆盖远端分支。

Astra 最终快照：planner `30f6f52d097a`，route `a446cc8e16f3`，integration `08c6895d26c9`，registry `4d990cd43245`。审阅者没有运行数据库或测试；上述运行证据由 Codex 验证。保留命名空间及批量与认证竞争仅作源码复核，未宣称额外动态覆盖。完整质量门槛和远端 CI 尚未通过，不具备合并结论。#6676 另行验证，不能由本报告替代。
