# 备料 + 系统对接线 · 设计与验证记录(2026-08-19)

> **性质:设计与验证总记录,不是 CLOSEOUT。** 本文回答三个问题:这条线**是什么样的设计**(架构、闸门、信任模型)、**到今天为止验证了什么**(每一项都给 run ID / token / commit)、**还差什么才能写 closeout**(退出条件与精确下一步)。
> 与之配套:状态账本 `stock-preparation-integration-line-status-ledger-20260818.md`(逐行状态)、唯一真源 `stock-preparation-k3wise-first-profile-delivery-plan-20260804.md` §0。
> values-free:除 `222` 标签外无主机名,无 token,无凭据;只有 commit SHA、run ID、摘要与封闭 token。

---

## 0. 结论(一段话)

**备料 MVP 及"单客户 · 只读 · 零外部写"的对接已实体机验收;所有带写入的对接(K3 Save-only Apply)、SQL Server 密封快照(S6-A/S6-B)的实体验收、GIP 运行时接线,均未完成,且全部处于受控/默认 OFF。** 2026-08-18/19 这一轮把**代码与 CI 侧能闭合的全部闭合**:Windows 主机上 S6-A 从"必炸"变为"可跑 + 有 ACL 保证";#4708 的 8 项功能证据在 CI 一次 dispatch 出齐;073/074/075 的角色绑定分支在 PG 15/16/17 上首次被实证;重冻结候选已提交 owner。**剩余项全部是 owner 决定或实体机操作**,代码侧没有已知未完成项。

---

## 1. 设计

### 1.1 分层与信任边界

```
                 ┌──────────────────────────────────────────────────────────────┐
  客户/实体机     │  Windows on-prem host ("222")                                 │
                 │  PM2 · app.env · ARTIFACT_ROOT(NTFS, icacls 收敛)             │
                 │  ┌────────────────────────────────────────────────────────┐  │
                 │  │ MetaSheet core-backend                                  │  │
                 │  │  └ plugin-integration-core (integration-core-mvp)      │  │
                 │  │     ├ 备料 MVP 路由(默认可达,requireAccess 门)          │  │
                 │  │     ├ 只读源适配器 · C6 dry-run · 模板 · 选项同步         │  │
                 │  │     ├ [默认 OFF] ERP/PLM/TableAction 自动持久化 ×3        │  │
                 │  │     ├ [默认 OFF] SQL Server 密封快照运行时(S6-A)          │  │
                 │  │     │    capture → private ingestion → generation → apply│  │
                 │  │     ├ [强制关闭] C6 write Apply(INTEGRATION_C6_WRITE_APPLY_DISABLED)
                 │  │     ├ [RATIFIED 禁用] K3 dead-letter replay               │  │
                 │  │     └ [LATENT] gip-* 全家族 · sealed-export 大部分原语      │  │
                 │  └────────────────────────────────────────────────────────┘  │
                 └──────────────────────────────────────────────────────────────┘
                              ▲ 只读                       ▲ 一次性 owner-bound 写
                 ┌────────────┴───────────┐    ┌───────────┴───────────────────┐
                 │ 客户 SQL Server(快照隔离,│    │ K3 WISE WebAPI(Save-only,      │
                 │ SELECT-only 主体)        │    │ exact-two,#4861 尚未执行)       │
                 └────────────────────────┘    └───────────────────────────────┘
```

**设计原则(从代码里读出的,不是口号)**
1. **fail-closed 命名 token**:所有拒绝走封闭词表(sealed-export §10 三十个 reason 冻结,细节字段开放),没有静默降级。
2. **一切写入默认 OFF,exact-literal `'true'` 才开**;开关名与生效位置见账本 §3。
3. **摘要 pin**:31 个 sealed-export 模块、6 个迁移、8 个 runtime 文件、10 个证据文件被 `sealed-export-package-provenance` 逐字节 pin;改动即需同 PR 刷新 pin,CI 的 S5 evidence / S6-A gate 复核。
4. **owner-bound 一次性执行**:实体机上的任何写动作都需 owner 单行决定 token + 新 operationId + 哈希 pin 的 stage,消耗即作废;请求方 ≠ 决定方。
5. **values-free 证据**:receipt/评论只含 SHA、run、摘要与封闭 token。

### 1.2 本轮新增/变更的设计点

| 设计点 | 内容 | 落地 |
|---|---|---|
| **win32 目录 fsync** | `DIRECTORY_FSYNC_SUPPORTED = platform!=='win32'`;仅跳过目录持久化屏障,文件 fsync、chunk/manifest 摘要、`EXISTING_IDENTICAL` 字节比对全部保留;POSIX 字节级不变 | `private-ingestion-blob-store.cjs`(#4989) |
| **win32 ACL attestation 门** | 旗标开 + win32 → 必须 `MULTITABLE_STOCK_PREP_SQLSERVER_SEALED_SNAPSHOT_WIN32_ARTIFACT_ACL_ATTESTED='true'`,否则 `SEALED_EXPORT_PROFILE_UNCERTIFIED` + `details.field=win32ArtifactAclAttested`(不新增 reason,尊重 30-token 冻结);`loadStockPreparationRuntimeConfig` 增加可注入 `platform` | `stock-preparation-runtime-config.cjs`、`failure-vocabulary.cjs`(#4989) |
| **deploy path 强制 ACL** | apply-package 阶段按旗标:`icacls <root> /inheritance:r /grant:r <svcSID>:(OI)(CI)F SYSTEM:(OI)(CI)F`,`Get-Acl` SID 级复核(无继承、无 Everyone/Users/Guests/Authenticated Users),通过才写 attestation,失败**撤销**旧 attestation;`-S6aArtifactRootAcl auto\|off` 逃生口;脚本进 `REQUIRED_PATHS` | `multitable-onprem-s6a-artifact-root-acl.ps1`、apply-package、launcher(#4998) |
| **e2e 走廊 `lab_mode`** | 默认路径字节级不变;`lab_mode=true` 增加 PACKAGE 模式(job 内打包→五项校验→解压→对 `dist/src/index.js` 跑同一走廊)与 ON 窗口后 OFF 恢复臂(健康能力 false、sibling 200、S6-A 404、仓库无启用行、artifact root 已删) | `stock-preparation-e2e-functional-smoke.{yml,mjs}`(#4992) |
| **角色绑定迁移臂** | `stock-prep-main-package-verify.yml` PG 15/16/17 三腿:按 runbook 六属性建两个分离角色、设 GUC、迁移、断言非 latent 分支与 GRANT;16/17 负控:CREATEROLE 非超级用户建角色 → 被 073 谓词以 `pg_auth_members` 非零拒绝 | #4991 |
| **provenance pins 与 EOL** | 63 个受 pin 路径 `text eol=lf`(目录规则 + 逐文件),摘要算法保持逐字节 | `.gitattributes`(#4996) |
| **LAB-0 自动盘点** | 非变更性脚本吐出 #4695 六字段与 LAB-0 环境事实(封闭 token),唯一 SQL 为 `pg_roles` 目录 SELECT;新增 artifact-root 文件系统探针(NTFS/REFS/OTHER → hardlink 支持) | `stock-preparation-lab0-inventory.mjs`(#4986、#4999) |
| **冻结块直出** | package-build workflow 在校验后直接输出粘贴即用的 `serviceRuntimeSha/releaseTag/packageFile/packageSha256/packageProvenanceManifestDigest/…` 八行块(日志 + step summary + 工件 `freeze-block.txt`);`serviceRuntimeSha` 从校验和内的 `BUILD_PROVENANCE.json` 读出并须等于 `BUILD_SHA`,`packageSha256` 须等于构建自己的 `.sha256` 边车;`packageProvenanceManifestDigest` = 打包副本的 `verifySealedExportRuntimePackageProvenance().frozenManifestDigest`(pins JSON 的 sha256);未发布时 `releaseTag=NOT_PUBLISHED`;同时把 `no-node-modules` 测试接进 build job | `multitable-onprem-package-build.yml`(#5001) |
| **package-verify 固定字符串契约(热修)** | #4998 把 launcher 对 apply helper 的调用改成 hashtable splat,破坏了 `multitable-onprem-package-verify.sh` 对字面 `-StagingRoot $stagingBase` 的契约 → #4998 之后从 main 打的包全部校验失败。热修恢复字面命名参数,仅可选开关经数组 splat 追加;语义不变 | `multitable-onprem-deploy-launcher.ps1`(#5000) |
| **Recovery07 一次成功包** | PoNR 地图(授权消耗点唯一一行)、15 个必须前移的本地检查、`-DryRunStopBeforePointOfNoReturn`、负控清单、owner block/证据模板、`REMOTE_COMPLETE_LOCAL_EVIDENCE_PENDING` 分类、扁平化建议 | 文档(#4985),launcher 代码由 Codex 实现 |
| **GIP 接线决定书** | 只请求一个接缝(binding-qualification probe 内部路由,旗标默认 OFF),前置表、负控、回滚、`ownerGipRuntimeWiringDecision=` 三候选 | 文档(#4988),等 owner |

---

## 2. 验证

### 2.1 本轮合入 main 的变更(全部 CI 绿)

| PR | 合入 SHA | 类型 | 关键验证 |
|---|---|---|---|
| #4982 | `ad5a16278` | test | 5 个契约套件 Windows 通过;POSIX no-op |
| #4809 | `65a5bb4c9` | fix | 单测 + mutation-tested |
| #4985 | `45d672aed` | docs | — |
| #4986 | `c42671054` | docs+tool | lab0 22 测试;ubuntu+windows 契约 workflow |
| #4987 | `c70eb2534` | docs | — |
| #4988 | `59f21e5b1` | docs | — |
| #4989 | `bd4ad6e60` | fix | `s3-private-ingestion` FAIL→PASS、`s2-producer` FAIL→PASS(Windows);runtime-config +152 行 attestation 电池;S5 evidence/S6-A gate 绿(pins 刷新) |
| #4990 | `350325094` | docs | — |
| #4991 | `7d44a610b` | ci | run 32138432824(见 2.2) |
| #4992 | `05e27aae9` | ci | run 32136849681 / 32144444405 / 32147337030(见 2.2) |
| #4996 | `895b857bb` | chore | Windows 上 `package-provenance`、`s5-evidence` 首次通过;62 pin 0 mismatch |
| #4998 | `c0c9ebbd7` | feat(ops) | 24 项 ACL 测试 pwsh 7 与 PS 5.1 各 24/24(真 icacls);S5 evidence/S6-A gate、integration-guard、PS 5.1 acceptance 绿(两个证据文件 pin 刷新) |
| #4999 | auto-merge | ops | lab0 28 测试;实机探针 `C:` → `NTFS` |
| #5000 | auto-merge | fix(ops) | 61 条 launcher/apply 固定字符串契约全部满足;ACL 24/24、acceptance 契约全过;分支 dispatch package build(run 32202942825,见 2.2) |
| #5001 | auto-merge | ci | 分支 dispatch(run 32202981686,见 2.2) |
| #5002 | auto-merge | test | 61 条 verify.sh 固定字符串契约在 PR 上评估;在 #5000 前的 main 上正确报 1 违例(即 #4998 回归),#5000 后 0 违例;两组内存变异自测 |

### 2.2 CI 实证(按 #4708 八项与部署前置)

| 证据 | Run | 结果 / token |
|---|---|---|
| e2e 走廊 @ main,24,999 行(6 job) | 32118845106 | 全绿:主 S6-A 臂、mid-tier 24,999、拒绝臂 25,000、斜率、负控、语法契约 |
| e2e `lab_mode=true` @ #4992 分支 | 32136849681 | 7 job 全绿,含 PACKAGE 模式 |
| e2e `lab_mode=true` @ main(#4992 合入后) | 32144444405 | 7 job 全绿;`walkMode=package`、`serverRootIsRepoRoot=false`、`postWindowFlagOffRestored=YES`、`postWindowFlagOffHttp=404`、`postWindowFlagOffSiblingRouteHttp=200`、`postWindowFlagEnablingLineCountOther=0`、`captureDirectoryRemoved=YES` |
| e2e `lab_mode=true` @ main `bd4ad6e60`(#4989 后) | 32147337030 | 7 job 全绿(重冻结候选证据) |
| package build @ `bd4ad6e60`,`expected_sha` 精确匹配,`publish_release=false` | 32147404942 | 构建 + 五项校验通过;工件 `multitable-onprem-package-32147404942-1` |
| 角色绑定迁移臂 @ 冻结包 lane(错误宿主) | 32136846204 | 三腿在 `--confirm 074` 失败——**正确**:冻结包 `a45a2fe3f` 缺 074/075(与 #4695 08-04 披露一致);迁移前角色安全探测三腿通过 |
| 角色绑定迁移臂 @ `main-package-verify`(正确宿主) | 32138432824 | PG 15/16/17 全绿:`latentBranchTaken=false`;073/074/075 `Confirmed=PASS`+`ExecutedInThisRun=PASS`;`sealedRoleAttributesRunbookConformant=PASS`;`sealedRolePgAuthMembersRows=0`;`overGrantGuards=PASS`;`predicateWeakened=false`;16/17 负控 `negativeControlRolesCreatedByCreateroleNonSuperuser=PASS`、`negativeControlPgAuthMembersRows=NONZERO`、`negativeControlRefused=PASS`、`negativeControlExclusiveToPgAuthMembers=PASS` |
| package build @ main 之后(#4998 已合) | 32202464007 | **失败,且是有价值的失败**:verify 步 `launcher must pass its resolved staging base to the staged apply helper` → 暴露 #4998 引入的契约回归 → 热修 #5000 |
| package build @ #5000 热修分支 | 32202942825 | **success**——verify 步在字面 `-StagingRoot $stagingBase` 恢复后重新通过 |
| 冻结块直出 @ #5001 分支(含热修) | 32202981686 | **success**;八行块:`serviceRuntimeSha=0a012820d…`(等于 BUILD_SHA)、`releaseTag=NOT_PUBLISHED`、`packageFile=…-freezeblock-validate.zip`、`packageSha256=4303cd15…`、`packageProvenanceManifestDigest=327fb41f7b42c76b…3b4491`(= 当前冻结 manifest 摘要)、`customerScope/sourceMode/externalWrite` 封闭 token;块外 `packageTgzSha256=bbbe85af…` |

**#4708 八项映射**:1 安装包内运行 → 32147337030 PACKAGE 模式 + 32147404942;2 SQL Server 2022 + 快照隔离、3 SELECT-only 主体、5 24,999 行、6 重放 `internal_noop`/`sourceReadCount=1`、7 `externalWrite=false`、8 OFF 恢复+清理 → 32147337030;4 迁移 073 + 分离角色 PG 15/16/17 → 32138432824。**八项全部有绿色 CI 证据。** 仅 Windows **安装器**类主张仍为机器专属。

### 2.3 本机(Windows 11,Node 25.9)验证

- Windows 运行时兼容扫描:`lib/**` 144 文件仅 7 个触 `fs`;0 个 `child_process`/`process.platform`/`path.posix`/symlink;类 1 缺口 2 个(已修),类 2 4 个(1 个已由 lab0 探针覆盖),类 3 6 个(测试/CI 专属)。
- 修复前后:`sealed-export-s3-private-ingestion` FAIL(`STAGING_WRITE_FAILED` 于首个 writeChunk)→ PASS;`sealed-export-sqlserver-s2-producer` FAIL(mode 438≠448)→ PASS;`stock-preparation-*` 37/37;`sealed-export-*` 无新增失败。
- `.gitattributes` 后:63 路径 CRLF=0、pin mismatch=0;`package-provenance`、`s5-evidence` 通过。
- ACL 脚本:24/24(pwsh 7)、24/24(PowerShell 5.1),含真 icacls、篡改 ACL 撤销 attestation。

### 2.4 未验证 / 不能在 CI 验证的

- Windows 主机上 SQL Server 2022 Developer **安装器**路径(#4695 三次失败点)、PM2、真实提权会话、8900 端口、重启行为——机器专属。
- K3 真实 Save-only Apply(#4861)——从未执行;owner-bound。
- S6-B 一次实体窗口——需重冻结包 + LAB-0 就绪回复 + owner 决定。
- 073–075 在**非** superuser DBA 手工路径下的真机表现——CI 已模拟(角色绑定臂 + 负控),真机未跑。

---

## 3. 剩余项与退出条件(全部为 owner / 操作员 / Codex 动作)

| # | 项 | 状态 | 谁 | 精确下一步 | 退出条件 |
|---|---|---|---|---|---|
| R1 | 重冻结候选 mint | 请求已发 #4708(comment 5329543713) | owner | `gh workflow run multitable-onprem-package-build.yml --ref main -f expected_sha=<候选40位SHA> -f package_tag=s6a-<sha7>-<date> -f publish_release=true -f release_tag=stock-prep-onprem-s6a-<date>-<sha7>`;#5000 合入后该 run 直接吐出冻结块 | 冻结块回填于 #4708 / #4693 |
| R2 | LAB-0 六字段就绪回复 | 脚本已合入(#4986/#4999) | 222 操作员 | `node scripts/ops/stock-preparation-lab0-inventory.mjs`(非变更性)→ 贴回 #4695/#4708 | 六字段无 UNKNOWN;`artifactRootHardlinkSupported=YES` |
| R3 | 部署到 222(S6-A 旗标关) | #4989 + #4998 已合入 | 操作员 | 用 R1 冻结包走 deploy launcher;apply-package 自动 icacls + attestation | `s6aArtifactRootAclVerified=PASS`、`s6aWin32ArtifactAclAttested=YES` |
| R4 | S6-B 一次受控窗口 | 需 R1–R3 | owner + 操作员 | 按 #4695/#4693 决定块开一次窗口 | 一次 1..24,999 行运行 PASS + 重放 `internal_noop` + OFF 恢复 |
| R5 | K3 exact-two Save-only Apply(#4861 Recovery07) | 规格已合入(#4985) | Codex(launcher)+ owner(block)+ 操作员 | Codex 按 PoNR 地图重建扁平 executor;先在 222 跑 `-DryRunStopBeforePointOfNoReturn`(不消耗授权);全绿后 owner 一次 owner block | `201 created` → 重放 `200 skipped_existing` → 无第三次;K3 原生清理;`rdK3CallCount=2`、`rdEntityMutationCount=2`、删除=0、残留=0 |
| R6 | GIP 运行时接线 | 决定书草案已合入(#4988) | owner | 回复 `ownerGipRuntimeWiringDecision=APPROVE_WIRING_V1_FLAG_OFF \| DEFER_UNTIL_B1A_REDO \| REJECT` | 决定被记录;若 APPROVE,则接线 PR(旗标默认 OFF)+ 一次受控窗口 |
| R7 | 收尾记录 | — | 本线 | R4 + R5 + R6 完成后写 CLOSEOUT(取代账本"阶段快照") | Apply 关闭、专用开关恢复、私密残留(远端 + 本地 `lia/outputs`、`lia/work`)= 0 |
| ~~R8~~ | package-verify 静态契约在 PR 上跑 | 已完成(#5002) | — | node:test 复用 verify.sh 的 61 条固定字符串契约在 PR 上评估;path-filtered workflow | 再改 `scripts/ops/multitable-onprem-*.ps1` 时 PR 即红 |

**不在本线范围但被顺带发现的**:#4844 事务边界类缺陷(考勤线,W4C-5 前置);#2343 重复展开键 `CONFLICT_POLICY_NOT_IMPLEMENTED`(owner on-hold,设计内)。

---

## 4. 工程过程记录(可复用的教训)

1. **在冻结包上断言当前代码是错的**——角色绑定臂第一次放进冻结包 lane 三腿全红,红得对;所有重冻结前验证都要对"从候选 commit 构建的包"做(#4992 PACKAGE 模式正是为此)。
2. **摘要 pin 是设计的一部分**——改 pinned 文件必须同 PR 刷新 pin(#4989 三个模块、#4998 两个证据文件),否则 S5 gate 红;不要绕。
3. **Windows 是目标平台,不是"稍后再说"**——目录 fsync 与 chmod 两处 POSIX 假设本来会在部署第一分钟炸;本地扫描 + Windows CI 契约比部署后发现便宜一个量级。
4. **授权消耗点之后不允许有本地检查**——#4861 六次 recovery 的共同根因;PoNR 地图 + dry-run-to-PoNR 是通用模式。
5. **仓库治理**:个人账号仓库无 merge queue;`strict=true` + 25 分钟 CI + 30 分钟合并节奏 = 小 PR 永远追不上 main,已改 `strict=false`(required checks 不变)。
6. **dispatch-only 的门不会在 PR 上跑**——`multitable-onprem-package-build.yml` / `stock-prep-main-package-verify.yml` 都是 workflow_dispatch,#4998 破坏 package-verify 契约时 PR 检查全绿;是后续为 #5001 做验证 dispatch 才暴露。教训:凡改 `scripts/ops/multitable-onprem-*.ps1|.sh`,合并前在分支上 dispatch 一次 package build(`expected_sha`=分支 head,`publish_release=false`);更根本的做法是把 verify.sh 的 61 条固定字符串契约抽成一个 PR 上就跑的 node:test(待办,见 §3 R8)。

---

## 5. 模型分工(按难度自动分配)

| 难度 | 模型 | 承担 |
|---|---|---|
| 高:根因/设计/安全判断 | Fable 5(主会话) | 总体规划、PoNR/攻击面判断、pin/治理决策、冲突解决、本文 |
| 中高:多文件实现与实证 | Opus 5 | Windows 兼容扫描与修复、e2e 走廊补缺口、角色绑定迁移臂、ACL 脚本、`.gitattributes` 63 路径核对、冻结块直出、Recovery07 kit、部署路径分析、GIP 决定书 |
| 中低:机械改动与盘点 | Sonnet 5 | draft PR 分诊、LAB-0 文件系统探针 |
