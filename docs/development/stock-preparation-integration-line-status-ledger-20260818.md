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
| ~~win32 目录 fsync EPERM → S6-A 第一个 chunk 卡死~~ | Windows 主机上 S6-A 不可用 | 已闭环:#4989(`bd4ad6e60`)仅跳过目录 fsync,文件 fsync 与全部完整性校验不变;POSIX 字节级不变 |
| ~~win32 `chmod` 静默无效、仓库无 `icacls`~~ | 声称的私密性在 Windows 运行时不存在 | 已闭环:#4989 attestation 门(win32 + 旗标开 → 需 `..._WIN32_ARTIFACT_ACL_ATTESTED='true'`,否则 `SEALED_EXPORT_PROFILE_UNCERTIFIED`/`field=win32ArtifactAclAttested`);#4998(`c0c9ebbd7`)deploy path 在 apply-package 阶段按旗标 `icacls` + `Get-Acl` 复核,通过才写 attestation、失败撤销 |
| ~~PG 矩阵未设 `PGOPTIONS`/`metasheet.sealed_export_*_role` → 073–075 走 latent 分支~~ | 非 superuser 路径首次在真机跑 | 已闭环并实证:#4991(`7d44a610b`)在 `stock-prep-main-package-verify.yml` 加角色绑定臂,run 32138432824 PG 15/16/17 三腿 `latentBranchTaken=false`、073/074/075 `Confirmed=PASS`+`ExecutedInThisRun=PASS`、`overGrantGuards=PASS` |
| ~~PG16+ `createrole_self_grant` 可能触发 `pg_auth_members` 零行谓词、无诊断~~ | DBA 建角色方式差异即失败 | 已闭环并实证:同上 run,16/17 负控 `negativeControlRefused=PASS`、`negativeControlExclusiveToPgAuthMembers=PASS`;诊断写入 4695 运维检查表 B13(073 迁移与 runbook 均为摘要 pin,未动) |
| ~~provenance pins 按 LF 字节哈希;`core.autocrlf=true` 检出无法过 S5 evidence~~ | 仅影响 Windows 开发机跑 CI 契约 | 已闭环:`.gitattributes` 对 63 个受 pin 文件加 `text eol=lf`(非 `-text`,以便 `git add` 也归一,阻止 CRLF 字节进 blob);`sha256File` 保持逐字节,不做 LF 归一 |
| ~~`PROVENANCE_READ_NOT_IMPLEMENTED` 501;按行 provenance 读缺席~~ | 无——出货注册表命中不到该分支(此前误记为运行时缺口) | 已核实非缺口:`listProvenanceByRow` 已实现于 `lib/pipelines.cjs:727`(读 migration-060 `PROVENANCE_VIEW`、tenant/workspace 作用域、window 先于 limit/offset、`(run_created_at, event_index)` 排序),并由 `createPipelineRegistry` 返回(`lib/pipelines.cjs:802`);`index.cjs:260` 创建后于 `index.cjs:351` 作为 `services.pipelineRegistry` 注入 `registerIntegrationRoutes`,路由注册于 `lib/http-routes.cjs:142`。501 是**设计即如此**的 optional-method 兜底(`listProvenanceByRow` 故意不入 `requireService`,让旧 host 注册表优雅降级而非注册失败——见 `docs/development/data-factory-df-n2-2c-provenance-read-verification-20260528.md` §Scope boundary),仅当 mock 显式 `delete` 该方法时才可达(`__tests__/http-routes.test.cjs:3629-3630`)。保留为 fail-closed 守卫,不改代码。本地:`df-n2-2c-provenance-read.test.cjs`、`http-routes.test.cjs` 绿;`provenance-contracts.test.cjs` 因无 `js-yaml` 报 MODULE_NOT_FOUND(环境性) |

## 6. 与部署速度直接相关的 PR(2026-08-18 / 19)

| PR | 合入 | 用途 |
|---|---|---|
| #4982 | `ad5a16278` | Windows 契约测试规范化 |
| #4809 | `65a5bb4c9` | K3 `config.url` 摘要 fallback |
| #4985 | `45d672aed` | Recovery07 一次成功包(PoNR 地图、预检、负控、owner block/证据模板) |
| #4986 | `c42671054` | 部署路径加速图 + LAB-0 自动盘点脚本(非变更性) |
| #4987 | `c70eb2534` | S6-A 合成 e2e 在 CI 的可行性(#4708 证据映射) |
| #4988 | `59f21e5b1` | GIP 接线决定书草案 |
| #4989 | `bd4ad6e60` | S6-A Windows 运行时兼容修复 |
| #4990 | `350325094` | 本账本 |
| #4991 | `7d44a610b` | PG 15/16/17 角色绑定迁移臂 + PG16 自动成员负控 |
| #4992 | `05e27aae9` | e2e 走廊 `lab_mode`(安装包模式 + ON 后 OFF 恢复臂) |
| #4996 | `895b857bb` | 63 个受 pin 路径 `text eol=lf` |
| #4998 | `c0c9ebbd7` | deploy path:win32 artifact-root ACL 应用+复核+attestation |
| #4999 | auto-merge | LAB-0 盘点加 artifact-root 文件系统探针(hardlink 支持) |
| #5000 | auto-merge | **热修**:恢复 launcher 中字面 `-StagingRoot $stagingBase` 调用——#4998 的 splat 写法破坏了 package-verify 的固定字符串契约,#4998 之后从 main 打的包全部校验失败(run 32202464007) |
| #5001 | auto-merge | package-build workflow 直接吐出粘贴即用的冻结块(+ no-node-modules 测试、provenance manifest 摘要);分支 dispatch run 32202981686 成功 |
| #5002 | auto-merge | package-verify 的 61 条 launcher/apply 固定字符串契约改为 PR 上评估(防 #4998 类回归再次静默进 main) |
| 保留 draft:#4786(K3 API Profile 演进)、#4675(谓词类型诊断 v5) | — | 等 owner |

设计与验证总记录:`stock-preparation-integration-line-design-and-verification-20260819.md`。

## 7. 收尾判据(满足全部才可写 CLOSEOUT)

1. #4861 一次 Save-only Apply 成功 + 清理 + receipt;
2. S6-A 重冻结包在 CI 合成走廊全绿 → S6-B 一次实体窗口 PASS;
3. owner 对 GIP 接线做出 RATIFIED 决定并执行一次受控窗口(或明确 DEFER 并记录);
4. Apply 关闭、专用开关恢复、私密残留(远端 + 本地 `lia/outputs`、`lia/work`)= 0 的 values-free 收尾记录。
