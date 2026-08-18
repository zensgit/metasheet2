# 备料 + 系统对接线 · 状态账本(阶段快照,2026-08-18)

> **STATUS: INTERIM SNAPSHOT — 不是 closeout。** 本线仍有 open 票、默认 OFF 的开关和 LATENT 模块;按 2026-07-26 `line-closeout-record` 分支被退回时的原则("closeout 不能在线仍开放时写出"),本文只记录**今天**每一项的状态、退出条件和推动者。任何一行的状态变化都应更新本表,而不是另起一份快照。
>
> 取代 #4676(2026-07-29 快照,已关闭)。真源仍是 `stock-preparation-k3wise-first-profile-delivery-plan-20260804.md` §0;本表只做索引。values-free:无主机名(仅 `222` 标签)、无 token、无凭据。

## 0. 一句话结论

**备料 MVP + 单客户·只读·零外部写的实体机验收已完成;所有带写入的对接(K3 Save-only Apply)、密封快照(S6-A/S6-B)实体验收、GIP 运行时接线,均未完成,且全部处于受控/默认 OFF 状态。** 对外可说的准确表述:"备料 MVP 及单客户只读对接已实体验收;外部写入与密封快照仍在受控测试阶段,未启用。"

## 1. 已完成(有验收证据)

| 项 | 证据 |
|---|---|
| 备料 MVP 全部内部功能(目标表就绪、选项同步、同步/计划/持久化、PLM/ERP 手动源运行、快照 diff、映射/单位确认、生成、异常、审计读) | 路由默认可达,仅 `requireAccess` 权限门;插件自报 `integration-core-mvp`(`plugins/plugin-integration-core/index.cjs`) |
| 只读快照 → MVP 持久化最后一段代码 | PR #4892(2026-08-14 合并) |
| 单客户·只读·零外部写 实体机验收 | #4628 关闭 `COMPLETED`;delivery-plan-20260804 §0.1 全 PASS;k3wise dev/verification-20260805 §8.4 |
| C6 只读查找投影 + 一次有界 dry-run(Operation16) | #4437 2026-08-13 `operation16Result=PASS`,`applyDisableEffectiveBefore=YES` |
| GIP 协议层代码 | 16 个 `gip-*.cjs`、17 个套件全部合并;`integration-guard` required check;remaining-delivery-plan-20260806 §0/§1 "代码侧已落尽" |

## 2. Open 票

| 票 | 状态(2026-08-18) | 退出条件 | 谁能推动 |
|---|---|---|---|
| #4861 K3 exact-two Save-only Apply | OPEN;Op01–06 / Recovery01–06 均未执行 Apply(`rdK3CallCount=0`,`rdApplyDisabled=YES`);Recovery07 由 Codex 从最新 main 重建 | 一次 Save-only Apply 成功(`201 created` → 重放 `200 skipped_existing`,无第三次)+ K3 原生清理 + values-free receipt | owner(owner block)+ Codex(launcher)+ 实体机操作员;准备包见 #4985 |
| #4693 S6-A 受控 SQL Server 密封快照运行时与包 | OPEN;S6-A walk 已在 CI 端到端跑通(2026-08-04),但冻结包需重冻结 | 从候选 commit 构建的包在 CI 合成走廊(见 #4987)全绿 → 重冻结五字段块 | CI + owner(冻结决定) |
| #4708 合成 SQL Server e2e 实验室 | OPEN,停在 LAB-0 盘点;**6/8 证据项已在 CI 存在**(#4987) | 一次 dispatch(`s6a_row_count=24999`,或新 `lab_mode`)出全 8 项 → 机器只剩 Windows 安装器类主张 | 任何有 workflow 权限者 dispatch;LAB-0 由 #4986 的脚本替代人工 |
| #4695 S6-B 一次受控实体机验收 | CLOSED(2026-08-03,"ops readiness pending",非 PASS);08-04 披露冻结包无法跑通、需重冻结;"PG17 未验证"已被 `stock-prep-s6a-postgres17-validation` 推翻 | 重冻结 + LAB-0 自动盘点通过 + 一次窗口 PASS | owner + ops |
| #4437 RC-A 实体机受控验收 | OPEN;Operation16 PASS,Apply 仍关 | 视 owner 是否再开操作 | owner |
| #4844 事务边界类缺陷(W4C-5 前置) | OPEN;考勤域,非本线,但 soak 前置 | 三类边界助手落地 | 考勤线 |
| #2343 PLM 重复展开键(on-hold) | OPEN,`CONFLICT_POLICY_NOT_IMPLEMENTED` 422 为设计内 | owner 解除 on-hold | owner |

## 3. 默认 OFF 的开关(全部 exact-literal `'true'` 才开)

| 开关 | 位置 | 今日状态 | 打开条件 |
|---|---|---|---|
| `INTEGRATION_C6_WRITE_APPLY_DISABLED` | `http-routes.cjs` | 部署侧强制 fail-closed 403 `C6_WRITE_APPLY_DISABLED` | 仅在 owner 授权窗口内取消 |
| `MULTITABLE_STOCK_PREP_ERP_AUTOPERSIST_ENABLED` / `_PLM_AUTOPERSIST_ENABLED` / `_TABLE_ACTION_MVP_PERSIST_ENABLED` | `http-routes.cjs` | OFF;仅脚本化 OFF→ON→smoke→OFF 窗口 | owner 决定 + 窗口脚本 |
| `MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_ENABLED` | `sealed-export/stock-preparation-runtime-config.cjs` | OFF;关着时路由不进 `ROUTES` | S6-A/S6-B 决定;**win32 另需** `..._WIN32_ARTIFACT_ACL_ATTESTED='true'`(#4989) |
| K3 dead-letter replay | `pipeline-runner.cjs` `K3_WISE_REPLAY_DISABLED` | RATIFIED 无条件禁用 | 需新的 owner 裁定 |
| GIP 运行时(拟) `INTEGRATION_GIP_BINDING_QUALIFICATION_RUNTIME_ENABLED` | 尚不存在 | 决定书草案 #4988 | `ownerGipRuntimeWiringDecision=` |

## 4. LATENT(已建、已测、无运行时消费者)

`gip-*` 全家族(inert entry、approved-binding resolver、canonical-object / connector-kind registry、system-identity read、server-bound source executor、SQL Server RCSI/paged-read 策略)及 `lib/sealed-export/*` 大部分(canonical-json、digests、contracts、lifecycle、signer-authority、binding-qualification、package-provenance、s2-producer、sqlserver-sealed-snapshot-{action,profile,service,source-session});Bridge Agent 仅只读适配器,apply 路径明文禁止。接线前置:(β) 别名表与 (γ) 回填清单仍为空(#4988 §2)。

## 5. 运行时/部署已知缺口

| 缺口 | 影响 | 处置 |
|---|---|---|
| win32 目录 fsync EPERM → S6-A 第一个 chunk 卡死 | Windows 主机上 S6-A 不可用 | #4989 修复(仅跳过目录 fsync,完整性校验不变) |
| win32 `chmod` 静默无效、仓库无 `icacls` | 声称的私密性在 Windows 运行时不存在 | #4989 attestation 门;后续 deploy launcher 加 `icacls` + 导出 attestation |
| PG 矩阵未设 `PGOPTIONS`/`metasheet.sealed_export_*_role` → 073–075 走 latent 分支 | 非 superuser 路径首次在真机跑 | 待验证 + 角色绑定迁移臂(进行中) |
| PG16+ `createrole_self_grant` 可能触发 `pg_auth_members` 零行谓词、无诊断 | DBA 建角色方式差异即失败 | 待验证 + 负控/诊断(进行中) |
| provenance pins 按 LF 字节哈希;`core.autocrlf=true` 检出无法过 S5 evidence | 仅影响 Windows 开发机跑 CI 契约 | `.gitattributes -text` 或 LF 归一摘要 |
| `PROVENANCE_READ_NOT_IMPLEMENTED` 501 | 按行 provenance 读缺席 | 待排期 |

## 6. 与部署速度直接相关的 PR(2026-08-18)

| PR | 用途 |
|---|---|
| #4982 | Windows 契约测试规范化(auto-merge) |
| #4809 | K3 `config.url` 摘要 fallback(auto-merge) |
| #4985 | Recovery07 一次成功包(PoNR 地图、预检、负控、owner block/证据模板) |
| #4986 | 部署路径加速图 + LAB-0 自动盘点脚本(非变更性) |
| #4987 | S6-A 合成 e2e 在 CI 的可行性(#4708 证据映射) |
| #4988 | GIP 接线决定书草案 |
| #4989 | S6-A Windows 运行时兼容修复 |
| 保留 draft:#4786(K3 API Profile 演进)、#4675(谓词类型诊断 v5) | 等 owner |

## 7. 收尾判据(满足全部才可写 CLOSEOUT)

1. #4861 一次 Save-only Apply 成功 + 清理 + receipt;
2. S6-A 重冻结包在 CI 合成走廊全绿 → S6-B 一次实体窗口 PASS;
3. owner 对 GIP 接线做出 RATIFIED 决定并执行一次受控窗口(或明确 DEFER 并记录);
4. Apply 关闭、专用开关恢复、私密残留(远端 + 本地 `lia/outputs`、`lia/work`)= 0 的 values-free 收尾记录。
