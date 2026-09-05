# 222 部署窗口 Runbook —— 一次升级让备料线在 222 上真正活(2026-09-01)

> **地位**:操作员执行脚本,不是设计文档。逐条编号,每条给动作 + 验证 + 失败处理。
> **值域纪律**:本文**不含任何凭据 / 真实主机名 / 真实 IP**——一律用占位符
> `<222-HOST>` / `<PLM-HOST>`。项目号 `230920006`、其名称、行数等是客户已知悉的
> 项目级事实(非凭据、非敏感业务值),按现有姊妹文档(`onsite-connection-test-runbook-20260901.md`
> 等)同等纪律保留。
> **前置阅读**:客户侧现场连接测试与 30 秒数据体检的 SQL 见
> `onsite-connection-test-runbook-20260901.md`——**本文不重复它**,只引用。
> **窗口前提**:owner 在场(生产级机器,考勤/审批数据是真实在跑的业务数据)。

---

## 0. 为什么是这个窗口(先说清楚,再动手)

222 现在跑的是一个**旧构建**。下面逐项核实"这次升级到底带来什么"——**核实结果和最初的设想有出入,以下是核实后的准确状态,不是设想**。

### 0.1 已经在 `origin/main` 上、这次升级就能拿到的

| 内容 | PR / commit | 状态 |
|---|---|---|
| 厂商 preset 目录(dn-pdm family 首个 preset) | #5385 (`25635e67d`) | **已合入 main** |
| UI 选源(工作台里换源,免重启) | #5415 (`0fb0834f2` → 挤压合并) | **已合入 main** |
| 生产写入正式主表的能力(FOS-4b-3-prod P1 策略契约 + P2 受控运行时) | #3195 / #3199(`931c018e2` / `aedc7dbf6`) | **早已在 main 上**,但**默认休眠**(见 §0.4) |

### 0.2 截至本文写作时(2026-09-01)仍是 OPEN、需要在窗口前合入的

| 内容 | PR / branch | 状态(已核实:CI 全绿) |
|---|---|---|
| 源就绪预检 + 拓扑自测 | #5416,`feat/stock-prep-source-preflight-topology`(`424804fb4`) | **OPEN**,`mergeStateStatus` 未知但 PR 正文自称 MERGEABLE,全部 checks pass |
| K3 fence 覆盖两种 K3 kind(SQL 出站写默认拒能力门) | #5402,`sec/k3-sqlserver-fence-parity` | **OPEN**,PR 正文首行自称 `STATUS: UNMERGED`,全部 checks pass |

核实命令(任何人可重跑):
```
gh pr view 5416 --json state,mergeStateStatus
gh pr view 5402 --json state,mergeStateStatus
git merge-base --is-ancestor 424804fb4 origin/main   # NO
git merge-base --is-ancestor <5402 头提交> origin/main # NO
```

### 0.3 "纠正后的 DesignBom 读取拓扑"——核实结论与最初设想不同,这是本窗口真正的第一道门

最初的说法是"纠正后的 DesignBom 读取拓扑已经在 main 上,是被 squash merge 误判成未合并"。**逐项核实后,这个说法不成立**,证据:

- 携带该修正的提交(`32dd7f173` "dn-pdm topology backfill from the first live run")只存在于**本地分支** `feat/stock-prep-vendor-presets`,**从未 push 到 `origin`**(`git ls-remote origin refs/heads/feat/stock-prep-vendor-presets` 空返回),**没有对应的 PR**,`git merge-base --is-ancestor 32dd7f173 origin/main` → `NO`。这不是 squash-merge 误报(那种误报是"内容已在,提交对象不在");这里是**内容本身也不在** `origin/main` 上。
- 已经合入 main 的 #5385(`25635e67d`)只带来了 preset **目录机制**(字典怎么读、join 拓扑怎么走);它的 `dn-pdm-family.preset.json` **不含** `DesignBom`(`git show origin/main:.../dn-pdm-family.preset.json | grep -i designbom` 零命中)。
- 已经合入 main 的 `stock-preparation-bom-expansion.cjs`(部署读取计划的实现)**仍然只实现订单模块桥接**(`pathExAttr → pathInfo → orderHead → orderDetail`),完全没有 DesignBom 分支。
- 本仓库自己的设计文档已经把这件事讲清楚了:`docs/development/platform-overall-design/stock-prep-onboarding-acceleration-20260901.md` §2.A 证据 2——"该分支尚未合入 `origin/main`(`git merge-base --is-ancestor` 核实为 `NO`)……**提交里用的表名仍是 `DN_PDM_BomHeadInfo`/`BomDetailsInfo` 而非现场诊断口中的"`DN_PDM_DesignBom`"——合并该分支时需要把现场诊断的表名 / `product_part_id` 发现与分支内容互相核对,不能假定二者已经是同一件事**"。

**结论**:DesignBom 读取拓扑今天**既不在 main 上,也不是"合并一下就好"**——`32dd7f173` 需要先被推送、审阅,并且审阅时必须核对它用的表名/字段是否与 2026-09-01 现场实读到的真实形状(`DN_PDM_DesignBom`、`product_part_id`、数量在 `Bom_ExAttr` 族第 1 槽)一致,不一致就要改代码,不是简单合并。这件事排进 §1(Step 0)清单,是本窗口成立与否的**第一道真实的门**,比"合并 #5416/#5402"更不确定,必须最先安排时间。

### 0.4 "生产写入正式主表"——另一个必须搞清楚的机制,否则 Step 8 的验收标准无法达成

`plm_stock_preparation_main`(canonical,"备料主表(正式·未启用)")今天为 0 行,**不是因为没人拉取过数据**。核实代码后确认:

- 表动作的 `apply` 写入路径(`stock-preparation-table-actions.cjs:assertStockPrepApplySandboxAllowed`)对 canonical objectId **无条件 403**(`STOCK_PREP_APPLY_SANDBOX_ONLY`,`reason: prod_canonical`)——这是**故意的 P0 门**,写在代码注释里:"apply is sandbox-only … **production apply is a separate owner gate**"。它只会把真实数据写进**沙箱表**,从不写 canonical。(`mvp-persist` 不走这道门,也不走 `apply` 那条写入——它写的是另一组固定的内部快照表,详见 §0.6 与 Step 6-2 的订正,这里先不展开,避免把两条路径混成一条。)
- "生成"(`POST .../generation/run`)读的是沙箱落地快照,写的是**独立的**"备料行"表 `plm_stock_preparation_line` + 异常队列——代码里(`stock-preparation-generation-runtime.cjs`)从头到尾不引用 `plm_stock_preparation_main`。这条路径**结构上到不了 canonical**。
- 唯一能写 canonical 的机制是 **FOS-4b-3-prod**:P1(策略契约,#3195)+ P2(受控生产运行时,#3199)**都早已在 main 上**,但 P2 commit 原文写明"canonical writable only under an explicit server-config policy authorized by **a future owner gate (P4)**""dormant by default"。P4 不是代码,是**当场的 owner 授权动作**——本仓库已有完整的、values-free 的执行程序:`docs/development/data-factory-fos-4b-3-prod-apply-runbook-20260625.md`。

**结论(2026-09-01 补充核实后已被 §0.6 的 D1 裁决取代,原结论保留仅作机制说明)**:Step 8 要看到 `plm_stock_preparation_main` 里有真实项目行,理论上必须在本窗口内执行一次 FOS-4b-3-prod 生产写入程序(owner 现场授权 + 有时限的服务端策略 + 全新 dry-run token),这不是"顺带发生"的事,是 Step 7 里明确的一个子步骤,机制见 §7.2。**但**核实"有时限的服务端策略"这句话具体怎么落地时发现:承接它的配置键 `context.config.stockPrepApplyProduction` 在 `packages/core-backend/src/plugin-runtime-config.ts` 里**没有任何加载器**(见 §0.6)——也就是说这个子步骤在今天的 `origin/main` 上**做不到**。owner 已就此裁决(D1=B,见 §0.6):本窗口的落地目标改为沙箱表,不是 canonical 主表;Step 8 的验收标准相应改写。

### 0.5 这次窗口实际交付的是什么(修正后的版本)

一次升级 + 一次现场授权动作,合起来交付:

1. K3 出站写默认拒能力门覆盖两种 K3 kind(#5402,纵深防御,见护栏一节)——**需要窗口前合入**;
2. 纠正后的 DesignBom 读取拓扑(需要窗口前**审阅并合入** `feat/stock-prep-vendor-presets` 分支尖端,核对表名后);preset 目录本身已在 main;
3. UI 选源(#5415,**已在 main**)——接入换 PLM 不再改 env 重启;
4. 源就绪预检 + 拓扑自测(#5416,**需要窗口前合入**)——30 秒 go/no-go;
5. ~~一次 owner 现场授权的、有时限有行数上限的生产写入(FOS-4b-3-prod P4),把第一个真实项目的行写进 canonical 主表~~——**已被 §0.6 的 D1 裁决取代**:承接它的服务端配置键在今天的 `origin/main` 上无处可挂(见 §0.6),这一项本窗口**不执行**,标记「设计,未实现」。本窗口真正的第 5 项交付是:一次**沙箱 apply**(§7.2b,同一个 `apply` 写入网关,走的是早已实现、不需要 owner 授权仪式的沙箱分支),把第一个真实项目的行写进 Step 0-7 配置的沙箱表——不是 Step 6-2 的 `mvp-persist`(那一步写的是另一组内部快照/待确认表,结构上不经过 `action.target`,详见 §0.6 与 Step 6-2 的订正)。

第 5 项不是"代码升级自动带来的",是 Step 0 里**当场做的一次配置决定**(见 §0.6 与 Step 0-7),不是运行时开关。

### 0.6 D1 裁决(owner,2026-09-01):本窗口的备料落地表是沙箱表,不是 canonical 主表

**这是本窗口成立与否的配置前提,必须在 Step 0 完成,晚于 Step 6 才发现就是返工。**

- **裁决内容(D1 = 选项 B)**:222 演示窗口(以及第一个现场窗口)期间,备料线的落地 worksheet 是 `plm_stock_preparation_sandbox*` 命名空间下的一张沙箱表,**不是** `plm_stock_preparation_main`(canonical)。真正把行写进这张表的是 §7.2b(沙箱 apply),Step 8 验收的也是它——Step 6 本身不写这张表(6-1 是只读 dry-run,6-2 的 `mvp-persist` 写的是另一组固定内部快照表,不受这条裁决影响,见下面"哪些路径真的读这份绑定"一条)。
- **为什么只能是这样,不是"选择"是"事实"**:`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs` 的 `assertStockPrepApplySandboxAllowed`(约 1513-1529 行)对 `apply`/`mvp-persist` 走的沙箱路径**无条件**拒绝 canonical objectId(`STOCK_PREP_APPLY_SANDBOX_ONLY`,`reason: prod_canonical`,1517-1520 行),只有满足以下两条,写入才会落到某个**非 canonical**目标:
  - `STOCK_PREP_SANDBOX_MODE=true`(`resolveStockPrepApplySandboxPolicy`,同文件 1534-1548 行,读 `env.STOCK_PREP_SANDBOX_MODE === 'true'`);
  - `STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS=<逗号分隔的允许清单>`(同一函数,1541 行,把它拆分成 `allowedTargetObjectIds`)。
- **生产写入(唯一能碰 canonical 的路径)今天在真实部署里打不开**:P2 的 `resolveStockPrepApplyProductionPolicy`(同文件 1550-1559 行)只认服务端配置 `config.stockPrepApplyProduction`,**故意不设 env 开关**(注释原文:"There is deliberately no env switch: production must require explicit server config, never an environment variable")。而承接 `context.config` 的**唯一**函数——`packages/core-backend/src/plugin-runtime-config.ts` 的 `resolvePluginRuntimeConfig`(98-169 行,`packages/core-backend/src/index.ts:2882` 是它唯一的调用点,`config: resolvePluginRuntimeConfig(manifest.name)`)——**没有任何一行读取或转发 `stockPrepApplyProduction` 这个键**(通读 98-169 行,只有 `tableActions`/`stockPreparationTableActions`/`stockPreparationCustomerPacks`/`stockPreparationExtFieldMapping`/`b2aTrialRegistry`/`c6TestFailureInjection` 六个键)。也就是说,`data-factory-fos-4b-3-prod-apply-runbook-20260625.md` §3 那句"按该文档 §3 原样配置到 `context.config.stockPrepApplyProduction`"在今天的 `origin/main` 上**没有任何代码路径可以执行**——这个键没有加载器,配置了也到不了 `context.config`。**这不是本窗口的操作失误,是这个功能本身"设计,未实现"**:策略契约(P1,#3195)和受控运行时(P2,#3199)都已在 main 上且工作正常,缺的是把一份服务端配置文件读进 `context.config` 的那一小段代码(P4 file loader,跟踪为后续工作项,不在本窗口范围)。
  - **不要把这件事和"env 开关"混淆**:P2 comment 明确写了"故意不给 env 开关",所以就算给 `STOCK_PREP_APPLY_PRODUCTION_JSON`(或类似名字)之类的 env 变量赋值也不会生效——`resolveStockPrepApplyProductionPolicy` 根本不读 env,而 `resolvePluginRuntimeConfig` 也没有为它生成任何 `context.config` 键。唯一的修复是给 `plugin-runtime-config.ts` 加一个新的 `readDeployJsonObjectFile` 调用(仿照 `stockPreparationCustomerPacks`/`stockPreparationExtFieldMapping` 已有的模式),这是 P4 loader 的实现工作,**未开始**。
- **本窗口的配置**(D1=B 的机械部分,详细步骤见 Step 0-7):
  1. `STOCK_PREP_SANDBOX_MODE=true`
  2. `STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS=<本窗口沙箱 objectId>`(必须匹配下面的 action 绑定,且落在 `plm_stock_preparation_sandbox` 命名空间——`stock-preparation-target-provisioning.cjs` 的 `SANDBOX_OBJECT_ID_NAMESPACE_PATTERN`,82 行:`/^plm_stock_preparation_sandbox(?:$|[_-])/`,由 `assertSandboxObjectId`,102 行强制)
  3. action 绑定:`INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON`(或等价的 `INTEGRATION_CORE_TABLE_ACTIONS_JSON`)里,`plm.stock-preparation.pull-bom.v1` 这条 action 的 `target.objectId` 必须**显式**写成同一个沙箱 objectId——留空/不写时 `normalizeTarget` 会默认成 canonical(`stock-preparation-table-actions.cjs:147-157`,`objectId: optionalString(input.objectId) || STOCK_PREPARATION_MAIN_TABLE_TEMPLATE.objectId`,canonical 字面量 `plm_stock_preparation_main` 定义在 `stock-preparation-templates.cjs:652`)。这个 JSON 由 `resolvePluginRuntimeConfig` 读入 `context.config.stockPreparationTableActions`,再由 `http-routes.cjs:3082-3096` 的 `configuredTableActions` 喂给 `createStockPreparationTableActionRegistry({ actions: ... })`——纯部署时配置,不需要改代码。
  4. 若这次窗口装了 customer pack:pack 的 `targetObjectId` 也要指向**同一个**沙箱 objectId——`stock-preparation-customer-pack.cjs` 的 `normalizePackTargetObjectId`(269-285 行)本来就只允许 `plm_stock_preparation_sandbox*` 命名空间(通过 `stock-preparation-target-provisioning.cjs` 的 `assertSandboxObjectId`),这条路径**已经**只认沙箱,不需要为 D1=B 额外改。
- **代价,说清楚,不夸大**:D1=B 唯一的成本是 objectId 的名字里带着"sandbox"字样,以及 `STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS` 这份 env 允许清单本身**没有过期机制**——写进 env 之后不会自动失效,需要人工在窗口结束后清理(不像 P4 生产策略那样有 `expiresAt` 强制)。
- **对下游步骤的影响**:export(`stockPreparationPrepLineExport`)、pack 安装、"pull all" 都跟着这条 action 绑定的目标走,**不需要**为 D1=B 单独改代码或改这几条路径的调用方式——它们本来就读 action 里配置的 `target`,只是这次那个 `target` 是沙箱 objectId 而不是 canonical。
- **哪些路径真的读这份 action 绑定,哪些不读——不要混为一谈**:上面这条 export/pack/pull-all 都跟着走的"target",具体说是 `/apply`(`tableActionApply`,`http-routes.cjs:5077-5134`)和大 BOM 的 apply-start 路径调用的 `assertStockPrepApplyAllowed`/`assertStockPrepApplySandboxAllowed`,把行写进 `action.target.objectId` 那张表——这是这份绑定唯一控制的写入。**`mvp-persist`(Step 6-2)不读这份绑定**:它调用的 `prepareStockPreparationMvpSnapshot` 明确写着"this handoff never writes the canonical sheet"(`stock-preparation-table-actions.cjs:1460` 注释),写入的是固定的 MetaSheet 内部快照表(`plm_stock_preparation_project` / `_bom_snapshot_batch` / `_bom_snapshot_line`),跟 `action.target` 无关,不因这份绑定改变。两条路径不是同一件事:`mvp-persist` 是"把这次拉取的内容存一份快照供确认",`/apply` 才是"把确认后的行真正写进目标表"——本窗口新增的落地写入是后者,见 §7.2b。
- **对 Step 7/Step 8 的影响**:见下方 Step 7 顶部的裁决说明、新增的 §7.2b(沙箱 apply,本窗口真正执行的写入)与 Step 8 的改写。

---

## 2026-09-03 r7 实际执行记录与订正

本节记录 r7 窗口(2026-09-03)在 222 上实际执行时发现、且与上面 §0 描述不一致或缺失的细节,供下一个窗口直接用,不要重新踩坑。

1. **打包必须走 CI,不能在本地(尤其 Windows 检出)打包**:用 `gh workflow run multitable-onprem-package-build.yml --ref main -f package_tag=<tag> -f expected_sha=<full sha>` 触发。该 run 会上传产物 `multitable-onprem-package-<run_id>-<attempt>`,内含 `.zip`、`.zip.sha256`、`SHA256SUMS`、`deploy-bootstrap` 的 `.ps1`/`.bat`,以及一个 `verify/` 目录(验证器输出的 json/md)。**在 Windows 检出上本地打包会在 `multitable-onprem-package-verify.sh` 的"S6-A sealed-export package provenance pins did not verify"这一步失败**(CRLF 检出 vs LF blob 不一致)——不要发布本地(尤其 Windows)打出来的包。今天的产物:run `33720470573`,包名 `metasheet-multitable-onprem-v2.5.0-r7-20260903-b9b5a947f`,sha256 `ee3792b2ca141f44b88b4e07ea328a9669f865552518f1bb1a03fbc4bebedb99`,对应 `main` 提交 `b9b5a947f`(= #5460 的 `6ea9b6367` + docs #5465)。
2. **Step 2-2 订正**:`scripts/ops/multitable-onprem-package-upgrade-inplace.ps1` **不在**包里(不在 `REQUIRED_PATHS` 清单中);需要从同一提交的仓库检出中单独复制(例如 scp 到 `C:\metasheet\output\releases\incoming\tools-r7\`),并且调用时必须**显式**传 `-RootDir 'C:\metasheet'`——该脚本的默认 `RootDir` 是 `$PSScriptRoot\..\..`,不传的话会指向 tools 目录而不是部署根目录。示例:
   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File <tools>\multitable-onprem-package-upgrade-inplace.ps1 -PackageArchive <zip> -RootDir 'C:\metasheet' -Pm2AppName 'metasheet-backend'
   ```
3. **Step 1-2 订正**:222 上 PATH 里没有 `pg_dump`/`psql`,需要用完整路径 `C:\Program Files\PostgreSQL\17\bin\pg_dump.exe`(本地 Postgres 17,监听 5432 端口;`postgresql-x64-17` 服务在服务列表里显示 Stopped,但服务器实际在监听——不要去"启动"它)。今天的 DB 快照:`C:\metasheet\output\backups\upgrade-backup-20260903-135009\pre-upgrade-db.dump`(2.0 MB);脚本自带的代码备份:`upgrade-backup-20260903-140619`(docker/config/dist/web dist/plugins)。
4. **时间线与验收**:停机 14:06:18 → 健康检查 OK 14:08:55(约 2.5 分钟);F22 must-exist 清单 OK,插件 hash 校验 OK(436 个文件),node_modules 泄漏检查 OK;执行的迁移:`079`、`080`、`081`、`082`、`084`、`085`、`086`,以及 `zzzz20260830200000`/`211000`/`220000`/`230000`、`zzzz20260831090000`、`zzzz20260902120000`;audit CHECK 现在列出 `handoff_advance` 和 `project_board_read`;`integration_stock_prep_handoff` 表存在;`attendance_records`/`approval_instances` 行数不变(0/0)。**in-place 脚本不会刷新 `C:\metasheet\BUILD_PROVENANCE.json`**——升级完成后要手动从包根目录把新的 `BUILD_PROVENANCE.json` 拷过去(旧的已存到备份目录,存为 `BUILD_PROVENANCE.r6.json`),否则 Step 3-1 读到的还是旧提交。
5. **远程执行注意事项**:一次性 `ssh 192.168.1.222 powershell -Command "..."` 遇到引号会出问题;改用 `powershell -NoProfile -EncodedCommand <脚本的 UTF-16LE base64>`(例如用 Node 生成:`Buffer.from(script,'utf16le').toString('base64')`)。
6. **升级完成后待办(需要 admin Bearer token;preflight 路由在没有 token 时返回 401 UNAUTHORIZED)**:针对**已存在**的 objectId `plm_stock_preparation_sandbox_r6_trial` 重新推导沙箱绑定——调用 `POST /api/integration/stock-preparation/sandbox-target/ensure`(当前绑定的 `sheet_32df959afa3cecfa564e5486` 缺少 #5447 新增的五个部门列 `makeOrBuy`/`procurementDone`/`procurementReplyDate`/`warehouseDone`/`actualArrivalDate`),把返回的 `data.targetBinding` 贴进 `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON`,`pm2 restart metasheet-backend --update-env`,再用 `GET /api/integration/stock-preparation/preflight` 确认 `ready:true`。222 上已有一个做这件事的辅助脚本(token 从文件读取,不会回显):`C:\metasheet\output\releases\incoming\222-rebind-sandbox-target.ps1`。
7. **管理员 token 怎么来的**:用仓库自带的 `scripts/ops/attendance-window-runner-mint-token.mjs`(需复制到 `C:\metasheet\packages\core-backend\scripts\` 下,`import('pg')` 才能解析)——先 `node <它> --find-admin` 找到已存在的活跃 admin 账号,再 `node <它> --mint --user-id <id> --roles admin --expires-in 3600 --tenant-id default` 用宿主机自己的 `JWT_SECRET` 现签一份 HS256 token(用完删掉这个脚本副本);全程不碰密码,secret 也不离开宿主机。**用 `--tenant-id default` 签发后,令牌自带 tenant claim**(本次部署的唯一 org id);请求头 `x-tenant-id` 仍可以继续带,但不再是租户来源。等 flag 开启后,不带 tenant claim 的令牌会被备料相关 admin 路由直接 403。
8. **Step 0-7 订正**:`POST /api/integration/stock-preparation/sandbox-target/ensure` 返回的 `targetBinding` **只有 33 个 TEMPLATE 字段**(20 个 `plm_system` + 13 个人工列,含 #5447 的部门列),**不带** customer pack 的 21 个 `ext_` 列。把它"整段"贴进去会**替换掉**原有 action 配置里的 `fieldIdMap`,`ext_` 列(领料节点/备料日期/毛胚尺寸等)静默变成无法解析。**正确做法是合并**:ensure 返回的映射 + 旧配置里的 `ext_*` 条目(同一张 sheet/objectId ⇒ 旧的物理列 id 依然有效;今天是 33 + 21 = 54)。今天用了一次性 node 脚本做合并(`output/releases/incoming/tools-r7/merge-ext.cjs`);动手前先备份 `app.env`(今天存了两份:`app.env.before-rebind-20260903-143232` 与 `app.env.before-extmerge-20260903063616`)。合并后:`pm2 restart --update-env`,预检确认 `ready:true`、`checks.carryTargetBinding.ownershipState=owned_by_this_project`、没有 `missingHumanFields`。
9. **#5452(统一 SQL 连接绑定,2026-09-03 已合入)带来一个新 blocker**:`data-source:sql-readonly` 外部系统现在要求 `integration_external_systems.connection_id` 非空;该迁移只回填了 `config` 里带服务端打上的 `dataSourceOwnerId` 那些行——r6 时代的两条(`Customer PLM readonly` `104e9bad`、`Synthetic PLM readonly` `7130b124`)都没有这个标记,于是 source-preflight 报 `CONNECTION_LEGACY_FALLBACK_DENIED`。**修法(走认可路径,带 admin token + `x-tenant-id`)**:先 `GET /api/integration/external-systems/:id`,再用同样的公开字段(`id`/`tenantId`/`name`/`kind`/`role`/`status`/`config`/`capabilities`)加上 `connectionId = config.dataSourceId`(分别是 `customer-plm-test` / `synthetic-plm`)调 `POST /api/integration/external-systems`。用 `select id, connection_id from integration_external_systems` 核验。
10. **今天 Step 4/5 的结果**:对 `104e9bad` 的 source-binding `POST` 免重启即生效。对客户测试 PLM 的 source-preflight:可达(13 个对象里 12 个通),`BomHeadInfo` 143 行,`BomDetailsInfo` ≥200 行,`projectData.hasProjectNumbers=true`(样例 FileCode 如 `14-2022817`)但 `projectNodeRows=0`(取样范围内没有 `NodeType=2` 的项目节点);结论是 no-go,唯一 blocker 是 `bom_store_signals_conflict`,原因 `volume-undecidable-at-cap`(权威性+结构都指向 BomDetails——也就是当前配置的方案——但 200 行的取样量无法给出量级排序)。**这个僵局没有声明参数可用**(`declaredBridge` 只覆盖 order-module/DesignBom 这条桥,不覆盖这里);operator 按"旧系统口径"规则裁决(`BomHeadInfo`/`BomDetailsInfo` 权威,`DesignBom` 不用),然后继续走 dry-run。
11. **今天 Step 6-1 的结果**:对 `14-2022817` 和 `14-2023001` 跑 dry-run → `status=ready`、`canApply=true`、`evidence.expansion.status=expanded` 但 `rowsExpanded=0`——测试库里没有带 BOM 树的项目节点。所以彩排单第②步要等客户:要么在测试 PLM 里填一个真实项目,要么把生产 PLM 的只读权限开出来。第①③④步可以照常在已绑定的沙箱表上彩排。
12. **只读枚举配方(平台路由 values-free 列不出项目号时用)**:在 222 上以 `app.env` 环境运行一段 node 脚本——用 `pg` 读 `data_sources` 里该数据源的 `config`,用 `packages/core-backend/dist/src/security/encrypted-secrets.js` 的 `decryptStoredSecretValue` 解密 `credentials`,用 `dist/src/data-adapters/MSSQLAdapter.js` 建适配器并 `query(sql)`;只打印结构/计数/项目号,凭据永不打印;脚本留在 222 的 `C:\metasheet\output\releases\incoming\tools-r7\plm-enum.cjs`。**这是运维用的一次性读取,不是产品能力**。
13. **测试实例事实**:`10.10.52.16` = `LAPTOP-PMD3CA78\TEST1`(客户笔记本上的 SQL Server 测试实例),唯一库 `plm`;71 个项目节点(`NodeType=2`,`FileCode` 如 `230920006`、`230920001`-`005`、`29-2023054`、`1-20232045`、`1-20211987`……;`PathExAttrInfo.Parent_OBJ_ID` 即项目节点 id,如 `230920006` → `15014156`);`BomHeadInfo` 143 行、`BomDetailsInfo` 1319 行、`PathInfo` 1189 行;**订单表头只有 1 张**(`obj_id` `15011146`,挂在项目 `1-20232045` 节点 `15010980` 下,7 行明细)。
14. **该订单 7 行明细的零件缺失**:这 7 行明细的 `part_id`(`600005707`、`600005716`、`600005731`、`600005743`、`600005769`×2,以及一个 `0`)**全部不存在于 `PartLibraryInfo`**(887 个零件,`OBJ_ID` 范围 `600026018`–`600030571`)。逐跳 dry-run:`PathExAttrInfo`=1 → `PathInfo`=1 → `OrderHeadInfo`=1 → `OrderDetailInfo`=7 → `PartLibraryInfo`=0×7 → 7 条 `missing_component`、`manual_confirm_required`、展开 0 行。有完整 BOM 树的零件是存在的(`600028853`:2 张表头/118 行明细;`600026366`:78 行;`600029769`:45 行;`600030316`:41 行),但没有任何订单引用它们。**结论:测试实例数据残缺(订单引用的零件未同步到零件库),映射与读取计划本身正确**——客户提供的 SQL 走法(`FileCode` → `Parent_OBJ_ID` → `PathInfo` → `OrderHeadInfo.path_id` → `OrderDetailInfo.order_id` → `part_id` → `BomHeadInfo` → `bom_id` → `BomDetailsInfo.bom_pid`)与当前配置逐跳一致;其中出现的 `15031762`/`600057923`/`2-20241722.1723` 这类 id 属于生产库,不在测试库里。
15. **演第②步的最短路(客户侧,任选其一)**:
    a. 在测试库为某个已有项目(如 `230920006`,节点 `15014156`)插入一张订单,明细 `part_id` 指向有 BOM 的零件(如 `600028853`),之后对该项目号跑 dry-run 即可展开;
    b. 把订单 `15011146` 引用的 7 个零件同步进 `PartLibraryInfo`;
    c. 给 222 开生产库的只读连接(由 owner 在工作台新建数据源、录入凭据)。
    另记:源预检的 `bom_store_signals_conflict`(`volume-undecidable-at-cap`)在这个实例上是预期的探测器保守表现,不阻断 dry-run/apply。

---

## Step 0 — 窗口开始前的准备(不在 222 上做,在开发机上做)

**0-1. 合入 #5416(源就绪预检 + 拓扑自测)**
- 动作:`gh pr merge 5416 --squash`(或走仓库现行的合并方式)。
- 验证:`git fetch origin && git merge-base --is-ancestor <合并后 SHA> origin/main` → 应为 `origin/main` 本身包含它;`origin/main` 上 `plugins/plugin-integration-core/lib/stock-preparation-source-preflight.cjs` 存在。
- 失败处理:CI 已全绿,若合并冲突,按 PR 正文"与 main 的合并"一节的记录处理(该 PR 上次核对的合并基线是 `bcd5c300e`,之后 main 又往前走,需要重新合并、重新跑一次全链)。

**0-2. 合入 #5402(K3 fence 覆盖两种 K3 kind / SQL 出站写默认拒能力门)**
- 动作:`gh pr merge 5402 --squash`。
- 验证:同上,查 `packages/core-backend/src/data-adapters/outbound-sql-write-gate.ts` 落在 `origin/main`。
- 失败处理:同上,CI 全绿,冲突按标准合并流程处理。

**0-3. 审阅并合入纠正后的 DesignBom 读取拓扑(不是机械合并,见 §0.3)**
- 动作:
  1. 从本地分支 `feat/stock-prep-vendor-presets` 尖端(`32dd7f173`)push 出一个新分支到 `origin`,开 PR。
  2. 审阅时**必须**核对提交里的表名(`DN_PDM_BomHeadInfo`/`BomDetailsInfo`)是否与 2026-09-01 现场实读的真实桥接表名(`DN_PDM_DesignBom`)、连接字段(`product_part_id`)、数量槽(`Bom_ExAttr` 族第 1 槽)一致——不一致就要在这个 PR 里改代码,不能假定"提交标题说是这个,那就是这个"。
  3. 用 `node __tests__/source-vendor-presets.test.cjs` 之类的既有回归先本地验证,再开 PR。
- 验证:PR 合入后,`origin/main` 上的 `dn-pdm-family.preset.json` 或读取拓扑判定逻辑里能看到 `DesignBom`(或等效的、与现场实读一致的桥接标识)。
- 失败处理:如果核对发现代码与现场形状不一致,**先修代码再合并,不要带着已知不一致合入**——这正是 §0.3 引用的设计文档明确写下的风险提示。这一步没有捷径,预留独立的开发时间,不要挤进部署窗口当天。

**0-4. 刷新过期的 `PACKAGE_PROVENANCE_MANIFEST_DIGEST_PIN`(机械操作,owner 已批准)**
- 背景先核实清楚:`.github/workflows/stock-prep-s6a-postgres17-validation.yml` 里这枚 pin(连同 `PACKAGE_SHA256_PIN`、`SERVICE_RUNTIME_SHA_PIN`)绑定的是一个**已冻结的历史 release**(`RELEASE_TAG: stock-prep-onprem-s6a-20260731-a45a2fe3f`),文件自己的注释写着"**LAW — never recomputed, only verified against**"。也就是说,这枚 pin **原本不应该随 `main` 的日常提交漂移**——它验证的是那个历史冻结包自身携带的 provenance 脚本算出来的摘要,不依赖 `main` 当前版本的代码。
- 动作(**先核实是否真的过期,再动**):
  1. `gh workflow run stock-prep-s6a-postgres17-validation.yml`(手动 dispatch,该 workflow 只能手动触发)。
  2. 看 `Sealed-export frozenManifestDigest must equal packageProvenanceManifestDigest pin` 这一步:PASS → **这枚 pin 没有过期,§0-4 到此为止,不要动它**;FAIL 且失败原因确实是 digest 不匹配 → 继续第 3 步。
  3. 只有在第 2 步实测确认失配时,才用失败步骤打印出的 `frozenManifestDigest` 更新 workflow 文件里的 `PACKAGE_PROVENANCE_MANIFEST_DIGEST_PIN`,并在提交信息里写清楚**为什么这枚"LAW"常量在这次例外地被改了**(例如:冻结 release 资产本身被重新生成过,或 provenance 算法有一次得到 owner 认可的追溯性变更)——不要在没有实测失配、也没有写清楚理由的情况下静默改一枚自称"LAW"的常量。
- 验证:重跑一次 `gh workflow run`,该步骤变绿。
- 失败处理:如果 `PACKAGE_SHA256_PIN`(而不是 provenance digest)也对不上,说明冻结 release 资产本身变了,这是比"一枚 pin 过期"大得多的事,先停下来找 owner 确认,不要连锁改三枚 pin。

**0-5. 从当前 main 构建部署制品**
- 动作:`OUTPUT_DIR=... INSTALL_DEPS=1 BUILD_WEB=1 BUILD_BACKEND=1 scripts/ops/multitable-onprem-package-build.sh`(参数按仓库既有约定;该脚本自带 `REQUIRED_PATHS` 清单,缺失会自己报错)。
- 验证 artifact 文件数(**这正是 F22 本该被挡住的地方**,见 `first-deployment-lessons-20260831.md` F22):
  ```
  unzip -l <PACKAGE_NAME>.zip | wc -l
  ```
  与上一次已知良好的包(或 `REQUIRED_PATHS` 清单条目数)比对量级——不要求逐一核对,但如果这次文件数明显比上次少一大截(例如少了几十上百个文件),先别往下走,查是不是又发生了"目录被跳过"。
  再跑一次五项检查器:`scripts/ops/multitable-onprem-package-verify.sh <PACKAGE_NAME>.zip`。
- 失败处理:`multitable-onprem-package-verify.sh` 任一检查失败,按它给出的原因修,不要跳过检查直接上机器——真正的 F22 网(逐文件哈希比对)会在 Step 2 的升级脚本里再兜底一次,但这里的粗筛能省一次上机器才发现的往返。

**0-6. owner 预先了解(不是本窗口要执行的操作)FOS-4b-3-prod 生产写入的授权模板**
- 背景(见 §0.6 D1 裁决):承接生产写入策略的配置键 `context.config.stockPrepApplyProduction` 在今天的 `plugin-runtime-config.ts` 上**没有加载器**,本窗口**不执行**这条路径,标记「设计,未实现」——本条从"预先起草授权记录"降级为"owner 预先读一遍模板,心里有数即可",不产生任何本窗口的配置改动。
- 动作(可选,不阻塞窗口):owner 按 `data-factory-fos-4b-3-prod-apply-runbook-20260625.md` §2 的模板过一遍眼,了解字段形状(项目 `230920006`、action `plm.stock-preparation.pull-bom.v1`、route、`maxCleanRows`、`expiresWithin` ≤ 7 天),为**未来**(P4 file loader 落地之后的某个窗口)做准备,不是这次窗口的交付物。

**0-7. 配置沙箱落地目标(D1=B 裁决的机械部分,必须在窗口前、在开发机上完成)**
- 背景:见 §0.6。本窗口的备料落地表是沙箱表,由三个部署时配置项共同决定,**都不需要改代码**。
- 动作:
  1. 打包前把下面两个 env 键写进部署包的 `docker\app.env`(或该部署既有的 env 配置文件):
     ```
     STOCK_PREP_SANDBOX_MODE=true
     STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS=<本窗口沙箱 objectId,例如 plm_stock_preparation_sandbox_222>
     ```
     （objectId 必须匹配 `plugins/plugin-integration-core/lib/stock-preparation-target-provisioning.cjs:82` 的 `SANDBOX_OBJECT_ID_NAMESPACE_PATTERN`——`plm_stock_preparation_sandbox` 开头,后面接 `_`/`-` 或结尾。)
  2. 在 `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON`(部署既有的 action 配置,通常也在 `docker\app.env` 或它指向的文件里)中,给 `plm.stock-preparation.pull-bom.v1` 这条 action 显式写上同一个 objectId:
     **`objectId` 改了,`sheetId` 必须一起重算——不能留用既有那个。** 本条早先写的是"`sheetId`:既有值,不变",那是错的,照做会出事:

     - `assertStockPrepApplySandboxAllowed`(`stock-preparation-table-actions.cjs`)**只读 `objectId`**;
     - 而 apply 实际写哪张表、导出实际读哪张表,用的是 **`target.sheetId`**(`stock-preparation-apply-writer.cjs` / `stock-preparation-prep-line-export.cjs` 都逐字取用)。

     两者是**互相独立的字段**。于是"objectId 换成沙箱、sheetId 留着正式表那个"的组合会让沙箱门放行,然后**把行写进正式主表**——挂着沙箱的名,干着正式表的事,正好是 D1=B 要避免的那件事。

     **正确做法,一条路,别的都别走**:调 ensure,把它**返回的 `targetBinding` 整段**贴进 action 配置。这个接口就是本仓库认可的绑定生成器——它建表(或确认表已在)、写好所有权登记行,然后把该贴的东西原样给你。

     ```
     POST /api/integration/stock-preparation/sandbox-target/ensure
     { "objectId": "<本窗口沙箱 objectId>", "label": "<表名>" }
     ```
     响应里的 `data.targetBinding` 形如 `{ sheetId, objectId, keyField, fieldIdMap }`,**整段**贴进:
     ```json
     { "plm.stock-preparation.pull-bom.v1": { "target": "<把 data.targetBinding 整段贴在这里>" } }
     ```

     两件事都必须来自这次输出,不能手改:
     - `sheetId` —— apply 写哪张表、导出读哪张表都只看它;
     - `fieldIdMap` —— 物理列 id 是 `fld_+sha1(projectId:objectId:fieldId)`,objectId 一变**整张表的列 id 全变**,沿用旧 map 会让写入落到不存在的列上。而且**必须是完整的一整份**(含 13 个人工列),少一列结转会在部署期被 `STOCK_PREP_CARRY_TARGET_HUMAN_FIELDS_UNBOUND` 拦下。

     （离线场景:没法调接口时,`node scripts/ops/stock-preparation-derive-target-binding.mjs --tenant-id <tenantId> --object-id <objectId> --action-fragment` 能算出**同样**的绑定。但它只算不建——**之后仍要调一次上面的 ensure**,否则表和所有权登记行不存在,结转会被 `CONFIRM_CARRY_TARGET_TENANT_MISMATCH` 拒。)

     不写 `target.objectId`(或写错)会默认成 canonical(`stock-preparation-table-actions.cjs:147-157`),导致 Step 6-2 在 `assertStockPrepApplySandboxAllowed` 那一步被无条件拒绝(`reason: prod_canonical`)。
  3. 若这次窗口装了 customer pack,确认 pack 配置(`INTEGRATION_CORE_STOCK_PREPARATION_CUSTOMER_PACKS_PATH` 指向的文件)里的 `targetObjectId` 是**同一个**沙箱 objectId——这条本来就只允许沙箱命名空间(`stock-preparation-customer-pack.cjs:269-285` 的 `normalizePackTargetObjectId`),不需要为 D1=B 额外改,只需要核对三处(env 允许清单、action 绑定、pack 目标)用的是同一个字符串,不是三个不同的沙箱 objectId。
- 验证:
  - 三处配置里的沙箱 objectId 字符串完全一致(diff 一下三份配置文件里的这个值,不要靠肉眼扫);
  - **action 绑定里的 `sheetId` 等于这次 ensure 返回的那个**(再调一次 ensure,它是幂等的,把 `data.targetBinding.sheetId` 和配置里的值对一下;不一致说明 objectId 换了而绑定没重算);
  - Step 3-3 部署预检 `ready: true`、`blockers` 为空。**特别确认这两条不在里面**:
    - `STOCK_PREP_CARRY_TARGET_NOT_OWNED` —— 绑定的表不属于本部署的项目,结转每次点都会被拒;`detail.carryRouteCode` 里写的就是点击会看到的那个 code。修法就是上面的 ensure。
    - `STOCK_PREP_CARRY_TARGET_HUMAN_FIELDS_UNBOUND` —— 人工列没绑全。
    (`posture.carryTargetBinding.state` 是 `not_derived` **不是**故障、也不拦任何操作,它只提示绑定两半指向不同的表;结转允不允许看 `checks.carryTargetBinding.ownershipState`。)
- 失败处理:三处不一致 → 以 action 绑定里的 `target.objectId` 为准改另外两处(action 绑定是唯一决定"apply 写到哪"的配置,allowlist 和 pack 目标都要跟着它,不是反过来)。

---

**0-8. 配置「通知下一步」接力链(可选功能;要装就配齐,不装就完全不配)**
- 背景:备料多人接力(#5442)把「现在轮到谁」变成一个可见信号,并在交接时往钉钉群发一条提醒。**不配这个键,整套行为与没有这个功能时逐字节相同**(状态读返回 `configured:false`,推进路由按名报 501,不写库不发消息),所以本窗口可以整步跳过。
- 动作(要装才做):
  1. 在部署机上建一个**不进仓库**的 JSON 文件（它会被读进服务端配置键 `stockPreparationHandoff`），并把路径写进 `dockerpp.env`：
     ```
     INTEGRATION_CORE_STOCK_PREPARATION_HANDOFF_PATH=D:\metasheet\config\stock-preparation-handoff.json
     ```
  2. 文件内容(`tenantId` 是**必填**的,理由见下一条):
     ```json
     {
       "tenantId": "<本部署的租户 id,与其他备料配置里用的同一个>",
       "steps": [
         { "key": "prep_entry",   "handlerUserIds": ["<工艺员的 user id>"] },
         { "key": "process",      "handlerUserIds": ["<处理人的 user id>"] },
         { "key": "final_review", "handlerUserIds": ["<审核人的 user id>"] }
       ],
       "notify":   { "groupDestinationId": "<中间每一跳发的钉钉群 destination id>" },
       "terminal": { "groupDestinationIds": ["<仓库群 id>", "<采购群 id>"] }
     }
     ```
- **`tenantId` 为什么是必填的**:钉钉目的地 id 是部署级配置,宿主发送时只能证明「这个目的地是管理员管的」,证明不了「它属于正在被播报的那个租户」。而一个在两个组织里都活跃的账号,其 token 不带租户声明(`resolveSessionTenantId` 对 0 个或 2 个以上组织的账号都不发声明),于是 `x-tenant-id` 请求头就能选择用哪个租户身份推进 —— 若链路不声明自己属于谁,另一个租户的项目号就会被播报进这个群。填了之后，不属于该租户的推进一律返回 **501 `STOCK_PREPARATION_HANDOFF_NOT_CONFIGURED`** —— 故意与「这个部署根本没配接力」逐字节相同，不让外租户从报错里知道「这里有一条链，只是不是你的」；状态读返回 200 `configured:false`；真正的原因只写进服务端日志。两者都不写库、不发消息。多租户部署目前只能服务一条链（按租户分链是后续工作）。
- 验证:重启后用任意一个已有项目号请求 `GET /api/integration/stock-preparation/handoff?projectNo=<项目号>`,应当返回 `configured:true` 且 `stepCount` 等于你配的步数;若返回 500 `STOCK_PREPARATION_HANDOFF_CONFIG_INVALID`,报错体里的 `details.field` 就是写错的那个键(例如缺 `tenantId`)。
- 失败处理:本功能与本窗口的主线(拉取 → 确认 → 沙箱 apply)**无依赖**。配不对就把 `INTEGRATION_CORE_STOCK_PREPARATION_HANDOFF_PATH` 从 `app.env` 里拿掉重启,回到「没有这个功能」的状态,不要占用窗口时间排查。

---

## Step 1 — 备份 / 回滚点(定义一次,后面每一步引用它)

**在 222 上,SSH 进去之后(交互式会话内,不需要转义 `$`;如果是一次性 `ssh host "..."` 单条命令,把 `$` 转义成 `\$`)。**

**1-1. 取出 `DATABASE_URL`(既有教训:`pm2 jlist | ConvertFrom-Json` 会因为重复 JSON key 失败,一律用下面这种形式)**
```powershell
$l = (pm2 env 0 | Select-String '^DATABASE_URL:').Line
$env:DATABASE_URL = $l -replace '^DATABASE_URL:\s*',''
```

**1-2. 数据库快照(migrations 跑之前,一次性)**
```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = "C:\metasheet\output\backups\upgrade-backup-$ts"
New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
pg_dump $env:DATABASE_URL -Fc -f "$backupDir\pre-upgrade-db.dump"
```
记下 `$backupDir`(和它的时间戳)——升级脚本(Step 2)会**另起一个自己的** `upgrade-backup-<它自己的时间戳>` 目录做代码/插件备份,两个目录时间戳相近但不是同一个,操作报告里两个都要记。

**1-3. 代码 / 插件 / dist 备份**——不用手动做,Step 2 的升级脚本第 3/8 步会自动备份 `docker/`、`config/`、`packages/core-backend/dist`、`apps/web/dist`、`plugins/` 到它自己的 `upgrade-backup-<timestamp>` 目录,并把路径打印为 `BACKUP_PATH=...`。**记下这个路径。**

**回滚程序(定义一次,Step 9 引用)**

- **优先(代码/插件级回滚,覆盖绝大多数失败模式——构建坏了、健康检查不过、F22 类文件丢失)**:
  ```powershell
  # 对升级脚本备份下的每个路径:
  Remove-Item -LiteralPath <live-path> -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath (Join-Path $BACKUP_PATH <rel-path>) -Destination <live-path> -Recurse -Force
  pm2 restart metasheet-backend --update-env
  ```
  这段命令**升级脚本失败时会自动打印**(逐路径给出,复制粘贴即可),不需要自己拼。
  **不涉及数据库**——因为 076-080 这批迁移都是纯新增(建表/加列),按既有约定是单事务、失败即整体回滚,不会残留半迁移状态,所以绝大多数失败(构建问题、健康检查不过)只需要代码级回滚。

- **最后手段(数据库级回滚,范围更大,慎用)**:只有在"迁移本身跑成功了但之后发现数据被破坏"这种极小概率场景才用——且**这个盒子是半生产环境,考勤/审批数据是真实业务数据**,`pg_restore --clean` 类操作会把 1-2 快照之后**所有模块**(不只是备料)的新数据一并抹掉。用之前必须 owner 确认,且只在代码级回滚不够用时才考虑:
  ```powershell
  pg_restore --clean --if-exists -d $env:DATABASE_URL "$backupDir\pre-upgrade-db.dump"
  ```

---

## Step 2 — 升级

**2-1. 把 Step 0-5 构建出的包(`.zip` + `.sha256`)传到 222 上。**

**2-2. 执行既有的原地升级脚本**(它已经把停服/备份/替换/F22 防护/迁移/重启/健康检查/失败即回滚提示全部编排好了,不要用手工步骤替代它——手工步骤正是 F22 的成因):
```powershell
.\scripts\ops\multitable-onprem-package-upgrade-inplace.ps1 `
  -PackageArchive <path-to-package>.zip `
  -Pm2AppName metasheet-backend
```
它会依次做(8 步,全部打印到终端):
1. 校验包的 SHA-256(对着 `.sha256` sidecar,不匹配直接拒绝);
2. 停 pm2;
3. 备份(见 Step 1-3,打印 `BACKUP_PATH=...`);
4. 解包 + 替换(**逐文件遍历,不用 `-Exclude`**——这正是 F22 教训的固化,见脚本头注释);
5. F22 断言(必存在文件清单)+ 逐文件哈希核对(比"文件数对得上"更强的检查)+ node_modules 未泄漏检查;
6. 跑迁移(从 `docker\app.env` 加载 env 到本进程,`pm2` 不会自动重新读 env);
7. `pm2 restart --update-env` + 轮询健康检查(默认 `http://127.0.0.1/api/health`,12 次 × 5 秒);
8. 打印最终报告(包名 / 备份路径 / 迁移退出码 / 健康状态)。

**验证**
- 终端最后一段"final report"里 `health: OK`。
- `pm2 list` 显示 `metasheet-backend` 为 `online`。
- `Invoke-RestMethod http://127.0.0.1/api/health` 返回健康。

**失败处理**
- **脚本本身在第 4-7 步之间的任何异常**(校验失败、迁移失败、重启失败、健康检查超时),脚本会**自动**:停 pm2 → 打印一段"RESTORE REQUIRED"框(备份路径 + 每个被替换路径的精确恢复命令)→ 重新抛出异常。**照着它打印的命令做,不用自己回忆 Step 1 的回滚程序**。
- 若脚本尚未开始执行就失败(比如包的 SHA-256 校验不过),说明 Step 0-5 传输过程中包损坏,重新传一次,不要跳过校验强行继续。

---

## Step 3 — 升级后体检(semi-production 盒子,范围要说清楚)

> **本节的检查范围仅限"这次升级动过的东西":备料表动作、preset 目录、K3 出站写门、源预检模块。考勤/审批数据是这台盒子上真实在跑的业务,本节只做存在性/未变化的抽查,不做全量审计。**

**3-1. 版本 / build 存在**
- 动作:`node -e "console.log(require('C:/metasheet/packages/core-backend/dist/src/version.js'))"`(或该次打包生成的 `BUILD_PROVENANCE.json`,若随包携带)。
- 验证:版本号/commit 对应这次打包时记的 SHA,不是升级前的旧值。
- 失败处理:版本号没变 → 升级没有真的生效(可能是 pm2 缓存了旧 dist),重新走一遍 Step 2,升级前先确认停服真的发生。

**3-2. preset 目录 + DesignBom 读取拓扑真的在这台机器上**
- 动作:检查线上文件(`Get-Content C:\metasheet\plugins\plugin-integration-core\lib\source-vendor-presets\dn-pdm-family.preset.json`)含 Step 0-3 合入的 DesignBom 相关内容;
- 验证:不是升级前那份旧文件(可以用文件哈希与本地构建产物比对)。

**3-3. 部署预检(既有能力,先用它把"我方这一侧"配对)**
```
GET /api/integration/stock-preparation/preflight
```
按 `blockers[].fix.run` 逐条修到 `ready: true`。已知 code(照抄 fix,不要自己另起 objectId 或猜 env 名):

| code | 含义 |
|---|---|
| `STOCK_PREP_CONFIRMATION_LEDGER_NOT_READY` | 确认裁决账本表不在(按需建,不在迁移链里) |
| `STOCK_PREP_CUSTOMER_PACK_NOT_CONFIGURED` | 没配 pack |
| `STOCK_PREP_PACK_TARGET_MISSING` | pack 声明的 `targetObjectId` 那张表不存在 |
| `STOCK_PREP_PACK_TARGET_INCOMPLETE` | 表在,但 `ext_` 列没装 |
| `STOCK_PREP_EXT_FIELD_MAPPING_NOT_CONFIGURED` | 没配源列 → `ext_` 映射 |
| `STOCK_PREP_SANDBOX_MODE_NOT_ENABLED` | 写行授权没开(装列和写行是两道独立授权) |
| `STOCK_PREP_SANDBOX_ALLOWLIST_MISSING_TARGET` | 允许清单里没有 pack 声明的目标 |

四条"围栏姿态"(production Apply 关闭 / K3 永久禁写 / B2a 登记休眠 / 通用出站写门不设)只报状态、不给 `fix`——**不设就是当前正确姿态**,预检不会推你去开它们(production Apply 的开启在 Step 7,是当场的、有时限的动作,不是这里的常驻状态)。

**3-3a. 备料列写权限行的一次性回填（#5455，必做，在任何 customer-pack 安装/升级之前）**

背景：#5455 之前，`field_permissions.created_by` 只写插件级标记
`plugin:plugin-integration-core/stock-preparation`，不带 pack id。所以现场每一行列写权限都是
“无主”的：不同 pack 写的行字面上完全一样。新的对账逻辑因此**不猜**：它对矩形内无法归属的
旧行直接拒装（422 `CUSTOMER_PACK_FIELD_WRITE_SCOPE_LEGACY_UNATTRIBUTED`）。没跑这一步，Step 3-3
里的 `STOCK_PREP_PACK_TARGET_INCOMPLETE` 修不回去。

- 先看（默认就是 dry-run，不写库）：
```
DATABASE_URL=... pnpm dlx tsx packages/core-backend/scripts/backfill-stock-preparation-write-scope-pack-ids.ts
```
- 看输出里两个数：`would be stamped`（能归属的行）和 `left unattributed`（归不了的行）。
  - `left unattributed` 为 0 → 直接执行。
  - 不为 0 → 那块 sheet 上装过**两个以上** pack，脚本不会碰它们；**这是设计而不是故障**（猜错了就是删掉另一个
    pack 正在生效的列写禁止）。记下那几行，找 owner 定完再手工处理（手动改 `created_by`，
    或用 `PUT /api/multitable/sheets/:sheetId/field-permissions { remove: true }` 清掉）。
- 再写：
```
DATABASE_URL=... pnpm dlx tsx packages/core-backend/scripts/backfill-stock-preparation-write-scope-pack-ids.ts --apply
```
- 验证：再跑一次 dry-run，`would be stamped` 应为 0（脚本幂等，只改仍然是裸标记的行）。
- 失败处理：不跑也不会造成静默错误——安装会带码拒绝并在错误里点名这个脚本。先拒后修是安全方向。

**3-4. F20 陷阱预防性检查(受管表建成后必须自带默认视图,否则整个 base 打不开)**
- 背景:`first-deployment-lessons-20260831.md` F20——`ensureObject` 只建 sheet/字段,不建 `meta_views` 行;多维表打开 base 时要渲染每张表的默认视图,零视图的表会拖累**整个 base** 打不开。
- 动作:打开备料所在的 base(工作台里点开"备料"),确认能正常打开,四张受管表(确认裁决账本 / 沙箱目标 / canonical 主表 / 其他卫星表)都能点开。
- 失败处理:某张表打不开 → 按 F20 已知修复(数据侧手工补 `meta_views` 行,或确认代码修复是否已包含在这次升级里)处理,**不要跳过这一步直接往下走**——Step 6-8 都要打开表来看行数据。

**3-5. 考勤 / 审批数据未受影响(抽查,不是全量)**
- 动作:挑 1-2 张考勤/审批表,记一下升级前后的行数(`SELECT count(*) FROM ...`)。
- 验证:行数一致(这批迁移是纯新增,不改动其他模块的表)。
- 失败处理:行数变化 → 立即停止,启动 Step 9 的数据库级回滚评估,通知 owner。

---

## Step 4 — 源就绪预检(go/no-go 门,用新能力)

**这是 30 秒内知道"能不能演"的关口,不是走完全套流程之后才发现的意外。**

**动作**
```
GET /api/integration/stock-preparation/source-preflight?externalSystemId=104e9bad-3400-42bb-b427-e7a1d9cf9174
```
(`104e9bad-3400-42bb-b427-e7a1d9cf9174` = 已注册的只读 external system,kind `data-source:sql-readonly`,`config.dataSourceId='customer-plm-test'`,指向客户 PLM 的只读账号。)

**期望的返回(`verdict: 'go'`,`blockers: []`)**

| `checks.*` | 期望 |
|---|---|
| `reachability` | 能连上 |
| `projectData` | 项目号入口表非空,`NodeType=2` 采样行存在 |
| `bomData` | BOM 头 / 明细非空(143 头量级) |
| `topology` | 实测桥接 = DesignBom,且 `matchesConfigured=true`(配置的读取计划已经指向 DesignBom——这就是为什么 §0.3 的合并必须先做完) |
| `presetMatch` | 命中 dn-pdm family preset |
| `quantityField` | 解出的槽位与配置一致(`Bom_ExAttr` 族第 1 槽) |

**已知 blocker code(任一出现,verdict 就是 `no-go`)**:`source_unreachable`、`entry_table_missing`、`no_project_numbers`、`no_bom_rows`、`no_bom_bridge`、`bridge_ambiguous`、`topology_mismatch`。

> **`topology_mismatch` 是这个功能存在的理由**:它的提示原文是"配置走的路,和这家实际的形状对不上——照现在配置跑,会拉到 0 行"。**看到它,或看到无数据类 blocker,STOP,不要往 Step 6 走**——先回到 §0.3,确认 DesignBom 读取拓扑真的合并、真的生效(读取计划 `matchesConfigured` 才会是 `true`)。

**警告级(`warnings`,不阻断,但要看一眼)**:`no_preset_match` / `preset_ambiguous`(认不出厂商不阻断接入,只是没有现成字段字典)、`quantity_field_mismatch`、`quantity_field_unresolved`、`quantity_readings_disagree`、`dictionary_unreadable`、`node_type_column_absent`。

**失败处理**:`no-go` → 不要现场排查表结构(那是上一代靠人工冷读多表定位问题的方式);先看 `blockers[].detail`,它给的是**实测**的桥接/槽位/计数,对照 §0.3 已合入的读取计划配置,找出两者哪里对不上,改配置(不是改探测器)。

---

## Step 5 — UI 选源(把源绑定切到客户 PLM,验证免重启)

**动作**(工作台点法:安装/体检页顶部"选源"面板;等价 API):
```
POST /api/integration/stock-preparation/source-binding
{ "externalSystemId": "104e9bad-3400-42bb-b427-e7a1d9cf9174" }
```
需要 `integration:admin`(比普通连接编辑权限更高——这条绑定改变的是**全体租户**这条备料表动作读哪个外部系统)。

**验证**
1. 响应体 `takesEffectWithoutRestart: true`,且**不需要 `pm2 restart`**——立刻用 `GET /api/integration/stock-preparation/source-binding` 再读一次,确认已经是新值(不用等、不用重启)。
2. 审计行记录了 actor + 新旧值:`GET /api/integration/stock-preparation/audit`,找 `action: 'source_binding_set'`,`mode: 'bound'`(首次绑定;若之前已经指过一次别的源则是 `'rebound'`),`detail.previousExternalSystemId` 带着旧值(env JSON 里那个合成源的 external system id)。
3. 重新跑一次 Step 4 的源就绪预检——现在不传 `externalSystemId` 查询参数,它应该自动读到刚绑定的源,`verdict` 仍是 `go`。

**失败处理**
- 400 `SOURCE_BINDING_REQUEST_INVALID` → body 只能带 `externalSystemId`,不能带 `kind`/`readPlan`/`target` 等字段(这是刻意的窄接口:选源只能换"读哪个源",不能顺带改"怎么读"/"读到哪")。
- 绑定目标必须是**已存在、测试通过**的 external system,且其 `kind` 落在只读集合(`data-source:sql-readonly` / `bridge:legacy-sql-readonly`)——否则会被拒,这不是 bug,是防止"选源"变成一条意外打开 K3 写的路径(见护栏一节)。

---

## Step 6 — 首次真实拉取

**6-1. Dry-run**
```
POST /api/integration/table-actions/plm.stock-preparation.pull-bom.v1/dry-run
{ "parameters": { "projectNo": "230920006" } }
```
**验证(已核对响应实际形状,`status=expanded` 是之前版本的笔误——顶层 `status` 从来没有 `expanded` 这个值,见下)**:

顶层响应有两个不同层级的"状态",不要混为一谈(`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs` `dryRunStatus`,1288-1293 行;`evidenceForDryRun`,1261-1280 行):
- 顶层 `status`(`dryRunStatus()` 算出来的,词表就这五个):`not_found` | `large_bom_bounded` | `ready` | `manual_confirm_required` | `failed`。**没有 `expanded`**。这次是首次拉取、Step 7.1 的确认还没做,预期落在 `ready`(计划完全干净)或 `manual_confirm_required`(有行需要人工确认,这是**正常**的,Step 7.1 会处理)——两者都意味着 `canApply: true`、`dryRunToken` 非空;只有 `not_found` / `failed` / `large_bom_bounded` 才是问题。
- 嵌套的 `evidence.expansion.status`(`stock-preparation-bom-expansion.cjs:977` 赋值,`summarizeBomExpansionForEvidence`,同文件 1002 行投影到 evidence):这一层的取值是 `expanded` | `not_found` | `failed`——**`expanded` 这个词只出现在这里**,不是顶层 `status`。真正要看的行数在 `evidence.expansion.rowsExpanded`(不是顶层 `rowsExpanded`——顶层没有这个字段),是真实数量级(现场诊断记录约 1319 行明细 / 143 个 BOM 头量级),**不是 0**。

样本行的图号(`IdentityNo`)/名称/材料/数量(`Bom_ExAttr` 族第 1 槽)都是真实值,不是占位符或 GUID。记下顶层的 `dryRunToken`(仅在 `canApply: true` 时非空)。

**失败处理**:`evidence.expansion.rowsExpanded=0` → 回到 Step 4,源预检的 `topology`/`quantityField` 一定有问题,**不要在这一步现场排查**,先重新跑预检。顶层 `status=not_found` → 项目号打错,或 `DN_PDM_PathExAttrInfo.FileCode`(`NodeType=2`)那条锚定链路没配对,核对 §0 的字段映射。顶层 `status=failed` → 看 `evidence.expansion.errorTypes`/`rowErrors`,不是重跑就能过。

**6-2. mvp-persist(把这次拉取落成一个真实快照批次)**

**这次请求体之前的版本写成了带 `confirm`/`dryRunToken` 的形式,是错的——已核对 `mvp-persist` 路由自己的字段白名单并订正。** `mvp-persist` 不是 `apply`:它在服务端**重新跑一遍**只读的 table-action 计划(见路由注释:"Re-run the approved readonly table action and commit its expansion directly into the MetaSheet-internal MVP snapshot tables"),不消费 dry-run token,所以请求体**只**接受 `parameters`:

```
POST /api/integration/table-actions/plm.stock-preparation.pull-bom.v1/mvp-persist
{ "parameters": { "projectNo": "230920006" } }
```

字段白名单在 `plugins/plugin-integration-core/lib/http-routes.cjs:1137`:`VALID_TABLE_ACTION_MVP_PERSIST_BODY_KEYS = new Set(['parameters'])`,由该路由(`tableActionMvpPersist`,同文件 4974 行)的 `normalizeTableActionBody(requestBody(req), VALID_TABLE_ACTION_MVP_PERSIST_BODY_KEYS)` 校验;多出的 `confirm` 键会命中 `normalizeTableActionBody` 里"unsupported request field"的分支(同文件约 1458-1464 行),400 `TABLE_ACTION_REQUEST_INVALID`。`confirm`(带 `dryRunToken`)只是**另一个**路由——`/apply`——的字段(`VALID_TABLE_ACTION_APPLY_BODY_KEYS = new Set(['parameters', 'confirm'])`,同文件 1138 行,路由在 5079 行),`mvp-persist` 和 `apply` 是两条不同的写路径,字段形状不能混用。(`onsite-connection-test-runbook-20260901.md` §3 那条"token 放 `confirm.dryRunToken`,放顶层会 400"的教训说的是 `/apply` 路由,不是这里的 `mvp-persist`——两条路由都不接受顶层 `dryRunToken`,但 `mvp-persist` 连 `confirm` 这个外层键都不接受。)

**验证**:响应给出真实的 `snapshotBatchId`;**这一步写入的不是 Step 0-7 配置的那张沙箱主表**,而是 MetaSheet 内部固定的快照表(`plm_stock_preparation_project` / `_bom_snapshot_batch` / `_bom_snapshot_line`,`stock-preparation-sync-run-persist.cjs` 头注释称为"the frozen 9-table set"),不经过 `action.target`,不因 Step 0-7 的 action 绑定改变落点(见 §0.6)。打开工作台确认这批快照里出现了项目 `230920006` 的真实行。真正把行写进 Step 0-7 配置的沙箱表,是 §7.2b 的 `/apply` 调用,不是这一步。

**失败处理**:400 `TABLE_ACTION_REQUEST_INVALID`(`unsupported request field: confirm` 或类似)→ body 里多带了 `confirm`/`dryRunToken`,去掉,只留 `parameters`。

---

## Step 7 — 确认 → 写入本窗口的落地表(§7.2b;生产写正式主表见 §7.2,本窗口不执行)

> **D1=B 裁决执行到这里的具体后果(详见 §0.6)**:§7.2 描述的 FOS-4b-3-prod 生产写入,承接它的配置键 `context.config.stockPrepApplyProduction` 在今天的 `origin/main` 上**没有加载器**(`packages/core-backend/src/plugin-runtime-config.ts` 的 `resolvePluginRuntimeConfig`,98-169 行,通读全函数没有这个键),**本窗口不执行 §7.2**,标记「设计,未实现」——保留下面的描述只是为了记录这条路径的真实机制,给未来 P4 loader 落地之后的窗口用。**本窗口实际执行、且今天就能跑通的写入是 §7.2b(沙箱 apply)**,用的是同一个 `apply` 网关,走的是早已实现、不需要 owner 现场授权仪式的沙箱分支(`assertStockPrepApplySandboxAllowed`)。Step 8 的验收标准相应地看 §7.2b 的落地表,不是 canonical 主表。

### 7.1 把批次里的 `MANUAL_CONFIRM` 清到 0

计划级门槛是"批次内 `MANUAL_CONFIRM` 计数必须为 0"才能进入下一步的 apply——**不论是本窗口的沙箱 apply(§7.2b)还是未来窗口的生产 apply(§7.2)**,两者共享同一段服务端强制(`stock-preparation-table-actions.cjs:1673`:`dryRun.plan.counts[DECISIONS.MANUAL_CONFIRM] > 0 && input.acceptManualConfirmHold !== true` → 409),这条门槛不因 D1=B 的裁决而放松(FOS-4b-3-prod 的 stop rule 原话是"manual_confirm rows present? they MUST stay held"——留着不写,不是不管)。

```
GET  /api/integration/stock-preparation/confirmation-decisions
POST /api/integration/stock-preparation/confirmation-decisions/confirm
```
- **接受 preset 驱动的、高置信度的行**(字典命中、数量候选唯一、槽位已知——preset 已经在 §0.1 合入,这类行直接确认为 `accept_current`/`keep_multiple_rows`)。
- **不要替代客户编造 ERP 码或数量归属**——真正有歧义的行(preset 认不出、多个数量候选、字典冲突)保持 `manual_hold`,留给客户事后确认,**这条门槛本身不放宽**(与 `docs/development/platform-overall-design/stock-prep-onboarding-acceleration-20260901.md` §4⑥ 的原则一致:收窄的是落进 `MANUAL_CONFIRM` 的集合大小,不是绕开这道门)。

**验证**:再跑一次 Step 6-1 的 dry-run(同一批),`counts[MANUAL_CONFIRM] === 0`(或明确记下还剩多少行held,决定是否推迟这批到客户确认之后)。

### 7.2 生产写入正式主表(FOS-4b-3-prod,owner 现场授权,当场执行,执行完立刻关闭)——**「设计,未实现」,本窗口不执行,见 §0.6**

> **先说清楚为什么不执行,再往下看机制**:下面第 2 步"服务端配置……按该文档 §3 原样配置到 `context.config.stockPrepApplyProduction`"这句话,在今天的 `origin/main` 上**没有任何代码会把这份配置读进 `context.config`**——`packages/core-backend/src/index.ts:2882` 是插件激活时唯一给 `context.config` 赋值的地方(`config: resolvePluginRuntimeConfig(manifest.name)`),而 `resolvePluginRuntimeConfig`(`packages/core-backend/src/plugin-runtime-config.ts:98-169`)通读全函数,只组装 `tableActions`/`stockPreparationTableActions`/`stockPreparationCustomerPacks`/`stockPreparationExtFieldMapping`/`b2aTrialRegistry`/`c6TestFailureInjection` 六个键,**没有 `stockPrepApplyProduction`**。策略契约(P1,#3195)和受控运行时本身(P2,#3199,`resolveStockPrepApplyProductionPolicy`,`stock-preparation-table-actions.cjs:1550-1559`,故意不给 env 开关)都已在 main 上且工作正常——缺的只是把一份服务端配置文件读进 `context.config` 这一小段代码(P4 file loader,后续工作项,未开始)。**结论:canonical 主表 `plm_stock_preparation_main` 不是本窗口的落地目标**,以下第 1-6 步是这条路径的真实机制(留作未来窗口参考),本窗口不执行,不要现场尝试"变通"配置这个键(没有变通,是加载器缺失,不是配置写错地方)。

**这是把数据真正写进 `plm_stock_preparation_main` 的唯一代码路径(结构上不受 D1=B 影响,只是今天在真实部署里打不开)。** 完整程序见
`docs/development/data-factory-fos-4b-3-prod-apply-runbook-20260625.md`——**本文引用它,不重复它的全部细节**,这里只列(未来窗口)要执行的顺序:

1. **owner 当场记录授权**(values-free 模板,§2 of that doc):
   ```
   productionApplyAuthorized=true
   authorizationId=<opaque id>
   target=prod_canonical_stock_preparation
   allowedRoute=both
   allowedActionId=plm.stock-preparation.pull-bom.v1
   maxCleanRows=<Step 7.1 之后这批 dry-run 的 clean 计数(add+update)>
   expiresWithin=<≤ 7 天>
   manualConfirmRowsMustStayHeld=true
   k3SaveAuthorized=false  k3SubmitAuthorized=false  k3AuditAuthorized=false  k3BomWriteAuthorized=false
   externalWriteAuthorized=false
   ```
2. **服务端配置**(不是请求参数,不是 env——按该文档 §3 原样配置到 `context.config.stockPrepApplyProduction`,`authorizedTargetObjectId` 必须是 `plm_stock_preparation_main`,`requireFreshDryRun: true`)。**⚠ 本窗口这一步做不到——见本节顶部的说明,`plugin-runtime-config.ts` 没有为这个键写加载器。**
3. **验证门确实生效**:非匹配的 apply(错 route/action/target)仍然被拒(`STOCK_PREP_PRODUCTION_APPLY_DENIED`);去掉配置后 canonical 恢复"拒",证明"开关"是真开关。
4. **全新 dry-run**(不能用 Step 6 的旧 token——`requireFreshDryRun` 会拒绝陈旧/沙箱 token):对项目 `230920006` 重新 dry-run 一次,确认 `cleanCount(add+update) <= maxCleanRows`,`manual_confirm` 行数 = 0(或明确等于本次授权范围之外、保持 held 的那部分)。
5. **Apply**(带全新 token,走 §7.2-1 授权的 route):`canonicalWriteExecuted` 只应在这个策略下发生;`manualConfirmRowsWritten` 必须是 `0`;`failed` 应为 `0`。
6. **立刻退出**:执行完成后,移除 `context.config.stockPrepApplyProduction`(或让它过期)——P2 恢复休眠,canonical 恢复默认拒绝。**不要把这个策略留在配置里过夜。**

**失败处理**:任一 stop rule 触发(策略缺失/过期/不匹配、token 陈旧、`cleanCount > maxCleanRows`、`manualConfirmRowsWritten > 0`、任何 K3/外部写发生)→ **立即停止**,不要重试性地放宽授权范围,回到 owner 重新评估。这条路径本身设计为**默认拒绝、explicit 才开**,失败时的正确反应是"这次先不写",不是"调大 maxCleanRows 再试一次"。

### 7.2b 本窗口实际执行的写入:沙箱 apply(D1=B 的落地动作)

**这才是本窗口 Step 8 要验收的写入。** 用的是和 §7.2 同一个 `apply` 网关(`assertStockPrepApplyAllowed`,`stock-preparation-table-actions.cjs:1568-1589`),但因为没有配置生产策略(§7.2 做不到,见上),网关自动落到沙箱分支(`assertStockPrepApplySandboxAllowed`,同文件 1513-1529 行)——这条分支早已实现、早已在 main 上,不需要 owner 现场授权仪式,配置只是 Step 0-7 已经做好的三项 env/action 绑定。

**动作**:
1. 需要这批数据**最新**一次 dry-run 的 `dryRunToken`(`canApply: true`)——如果 Step 7.1 确认过 `MANUAL_CONFIRM` 行,内容变了,要在确认后重新跑一次 Step 6-1,拿新 token,否则下一步会 409 `TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH`。
2. ```
   POST /api/integration/table-actions/plm.stock-preparation.pull-bom.v1/apply
   {
     "parameters": { "projectNo": "230920006" },
     "confirm": {
       "dryRunToken": "<Step 6-1/7.1 之后最新一次 dry-run 的 token>",
       "acceptManualConfirmHold": true
     }
   }
   ```
   （请求体的字段白名单是 `parameters`/`confirm`,`VALID_TABLE_ACTION_APPLY_BODY_KEYS`,`http-routes.cjs:1138`,路由在同文件 5077-5134 行——和 Step 6-2 的 `mvp-persist` 不是同一条白名单,不要把两条路由的 body 形状搞混,见 Step 6-2 的订正说明。`acceptManualConfirmHold: true` 在这批仍有行留在 `manual_hold` 时是必须的(`stock-preparation-table-actions.cjs:1673`);若这批同时存在被解决的重复 key 分组,还要传 `acceptDuplicateResolution: true`,否则 409 `TABLE_ACTION_DUPLICATE_RESOLUTION_REVIEW_REQUIRED`。）

**验证**:响应体顶层 `status` 与 `apply.status`(`summarizeApplyResultForEvidence`,`stock-preparation-apply-writer.cjs:614-627`;取值词表见 `applyStatus`,同文件 501-505 行:`succeeded` | `partial` | `failed` | `held`)应为 `succeeded`(若这批仍有 held 行,预期是 `partial`,不是失败);`apply.written > 0`;`apply.target.objectId` 等于 Step 0-7 配置的沙箱 objectId(用它确认真的写进了预期的那张表,不是别的表——`apply.target` 是写入函数原样回显的目标,同文件 602-606 行);`apply.counts` 里 `created`/`updated` 之和的量级与 dry-run 的 clean 计数(`ADD`+`UPDATE`)一致。打开工作台确认这张沙箱表里出现了项目 `230920006` 的真实行。

**失败处理**:
- 403 `STOCK_PREP_APPLY_SANDBOX_ONLY`,`reason: prod_canonical` → Step 0-7 的 action 绑定没生效,`target.objectId` 还是默认的 canonical(`normalizeTarget` 的默认值,`stock-preparation-table-actions.cjs:147-157`),回去核对 action 配置里的 `target.objectId` 是不是真的写了沙箱 objectId。
- 403 同错误码,`reason: sandbox_disabled` → env 里没读到 `STOCK_PREP_SANDBOX_MODE=true`,检查这个 env 是否真的加载进了这个 pm2 进程(是否 `pm2 restart --update-env` 过)。
- 403 同错误码,`reason: target_not_allowlisted` → `STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS` 里没有这个 objectId,或者三处配置(env 允许清单 / action 绑定 / pack 目标)用的沙箱 objectId 字符串不一致,回 Step 0-7 核对。
- 409 `TABLE_ACTION_DRY_RUN_TOKEN_MISMATCH` → token 过期或这批内容在 dry-run 之后又变了(比如刚做完 Step 7.1 的确认),回 Step 6-1 重新 dry-run 拿新 token。
- 409 `TABLE_ACTION_MANUAL_CONFIRM_REQUIRED` → 没传 `acceptManualConfirmHold: true` 且这批仍有 `MANUAL_CONFIRM` 行,补上这个字段,或者先完成 Step 7.1 把它们清到 0。

### 7.3(可选,若这次窗口还要产出 ERP 对接用的备料行)

若该客户当次窗口还需要 ERP 物料码映射 / 单位换算(与 §7.1-7.2 的 canonical 写入路径彼此独立、非必需):
```
POST /api/integration/stock-preparation/material-mappings/confirm
POST /api/integration/stock-preparation/unit-conversions/confirm
POST /api/integration/stock-preparation/generation/run   { "projectId": ..., "snapshotBatchId": "<Step 6-2 的批次>" }
```
这条路径写的是**独立的**"备料行"表 `plm_stock_preparation_line` + 异常队列,供 ERP 对接消费——**不是**写沙箱/canonical 主表的路径(见 §0.4),三条路径(§7.2b 的沙箱 apply、§7.2 的生产 apply、§7.3 的 ERP 生成)互不替代。本窗口的核心验收标准(Step 8)只要求 §7.2b 完成;§7.2 本窗口不执行(见上)。

---

## Step 8 — 验证收获(整个窗口的成功标准;D1=B 之后看沙箱表,不是 canonical 主表)

> **本节已按 §0.6 的 D1 裁决改写**:原文本节要求打开 `plm_stock_preparation_main`(canonical),这个要求今天在真实部署里无法达成(§7.2 做不到,见上)。本窗口的验收目标改为 Step 0-7 配置、§7.2b 实际写入的那张沙箱表(`plm_stock_preparation_sandbox*` 命名空间下的具体 objectId,窗口前在 Step 0-7 定下来的那一个)。

**动作**:打开工作台里 Step 0-7 配置的那张沙箱落地表,或:
```
GET /api/multitable/... (该 sheet 的记录列表,sheetId 取自 Step 0-7 action 绑定里的 target.sheetId)
```

**验证(具体检查)**
1. **行数**:项目 `230920006` 对应的行数 > 0,量级接近 §7.2b 那次 `apply` 响应里 `apply.written`(或 `apply.counts` 的 `created`+`updated`)。
2. **抽样一行**,确认四个字段都是真实值而非占位符:
   - 项目号:`230920006`
   - 图号:来自 `IdentityNo`
   - 材料:非空、非 GUID
   - 数量:来自 `Bom_ExAttr` 族第 1 槽,数字合理(不是 0、不是 NULL 转出来的怪值)
3. **canonical 主表 `plm_stock_preparation_main` 本窗口保持原状(升级前是什么行数,现在还是什么行数)**——这是**预期状态**,不是故障:generation runtime(§7.3)、apply 的沙箱分支(§7.2b)都结构上到不了它(见 §0.4),production apply(§7.2)本窗口没有加载器可用、不执行。

**这就是整个窗口的成功标准。** 达成即表示:源已切到客户真实 PLM(Step 5)、真实 BOM 已过预检(Step 4)、真实数据已落地(Step 6)、经人工确认(Step 7.1)+ 沙箱 apply 已执行(§7.2b),Step 0-7 配置的沙箱表第一次装着一个真实项目的真实数据。canonical 主表第一次装真实数据,推迟到 P4 file loader(§0.6)落地之后的未来窗口。

**失败处理**:行数为 0 或抽样值看着像占位符 → 回查 §7.2b 那次 `apply` 响应,`apply.status`(应为 `succeeded`/`partial`)与 `apply.target.objectId`(应等于 Step 0-7 配置的沙箱 objectId,不是别的表)是否对得上;若响应正常但行数对不上,检查是不是 Step 7.1 把大部分行留在了 `manual_hold`(那是**正确行为**,不是故障——held 的行本该不写,`apply.status` 这时预期是 `partial`)。

---

## Step 9 — 如果任何一步失败

**回滚**:用 Step 1 定义的程序——优先代码/插件级(升级脚本失败时自动打印,照抄命令);数据库级是最后手段,且必须先经 owner 确认(会影响考勤/审批的后续数据)。

**排障表**

| 症状 | 可能原因 | 怎么查 |
|---|---|---|
| 升级脚本在第 5 步(F22 断言)失败 | 打包时又发生了目录被跳过 | 对比 Step 0-5 的文件计数与本次解包后的计数;检查打包脚本是否又用了 `-Exclude` 之类不递归过滤目录的写法 |
| Step 3-3 部署预检卡在 `STOCK_PREP_PACK_TARGET_MISSING` 之类 | pack/沙箱配置没跟着这次升级一起配 | 照 `fix.run` 执行,不要另起 objectId |
| Step 4 源预检返回 `topology_mismatch` | §0.3 的读取拓扑修正没有真正合并生效,或合并后配置没同步更新 | 重新核对 `origin/main` 上的读取计划是否真的指向 DesignBom(不是只有 preset 目录合了) |
| Step 4 源预检 `no_project_numbers` / `no_bom_rows` | 绑的源还是旧的合成源,或客户源确实是空的 | 先确认 Step 5 的选源真的生效(`GET source-binding` 读到新值);再用 `onsite-connection-test-runbook-20260901.md` §2 的 SQL 亲自体检一遍 |
| Step 5 选源后预检没变 | 表动作在插件激活时缓存了旧配置,选源的"免重启"没生效 | 确认响应体确实是 `takesEffectWithoutRestart: true`;若为 false 或选源接口本身报错,按错误码处理,不要假设它一定生效就跳过复核 |
| Step 6 dry-run 返回 0 行但预检是 `go` | 项目号打错,或 `FileCode`/`NodeType=2` 锚定字段没配对 | 核对 §0 给出的字段映射表,尤其项目号锚定那一段 |
| §7.2b 沙箱 apply 被拒(403 `STOCK_PREP_APPLY_SANDBOX_ONLY`) | Step 0-7 的三项配置(env 允许清单 / action 绑定 / pack 目标)没生效或不一致 | 见 §7.2b 失败处理,按 `reason` 分支查(`prod_canonical`/`sandbox_disabled`/`target_not_allowlisted`) |
| （未来窗口)Step 7.2 生产写入被拒(任一 stop rule) | 见 §7.2 失败处理 | 不放宽授权重试,回到 owner 重新评估这批数据是否真的"clean"——本窗口不适用,§7.2 本窗口不执行 |
| Step 8 行数为 0 但 apply 显示成功 | 所有行都进了 `manual_hold` 被正确地没写 | 检查 Step 7.1 是否把太多行留在了 hold;这不是故障,是数据本身歧义多,需要客户先确认映射;这时 §7.2b 的 `apply.status` 预期是 `partial` |
| 考勤/审批行数在 Step 3-5 变化了 | 迁移或升级动到了不该动的表 | 立即停止,评估 Step 1 的数据库级回滚,通知 owner |

---

## 护栏(整个窗口期间遵守)

- **owner 在场**——这是一台半生产机器,考勤/审批数据是真实业务数据,不是试验田。
- **只碰备料这条线和 `customer-plm-test` 这一个数据源**——不touch考勤、审批、用户账户等其他任何数据。
- **K3 外部写是纵深防御,不是唯一保证**:可证明的保证是**只读账号**——`customer-plm-test` 对应的外部系统本身就是只读数据源(`kind: data-source:sql-readonly`),这一点在 §5 反复校验(选源只能绑到只读 kind 集合)。K3 出站写默认拒能力门(#5402)、四层永久焊死的 K3 fence(`k3-external-write-permanent-fence.cjs`)是在这之上的第二层——参见 owner 2026-09-01 裁决 `[[k3-external-write-boundary-ruling]]`:"K3 外部写走'只读账号可证明保证 + `#5402` 默认拒能力门纵深防御'两层"。
- **不允许人工伪造行**——本窗口的落地表(Step 0-7 配置的 `plm_stock_preparation_sandbox*` 目标)的每一行必须来自 Step 6 真实的拉取 + §7.2b 真实的沙箱 apply;不允许为了让 Step 8 看起来通过而手工插入行。canonical 主表(`plm_stock_preparation_main`)本窗口保持不变(见 §0.6 D1 裁决)——不允许绕过这条裁决手工写它。
- **§7.2 的生产写入配置(未来窗口执行时)执行完立刻移除**——不留过夜,P2 必须恢复默认休眠姿态。本窗口不执行 §7.2,这条护栏暂不适用,留给未来窗口。

---

## 附:相关文件

- 现场连接测试 + 30 秒数据体检 + 给客户的精确数据要求:`onsite-connection-test-runbook-20260901.md`
- 首次真机部署教训审计(F1-F22,含 F20/F22 两个本文直接引用的陷阱):`first-deployment-lessons-20260831.md`
- 接入提速统一路线图(§0.3/§0.4 引用的诊断证据出处):`docs/development/platform-overall-design/stock-prep-onboarding-acceleration-20260901.md`
- 生产写入正式主表的完整程序(P4 owner 授权,§7.2 引用;本窗口不执行,见 §0.6——加载器缺失,不是这份文档本身有问题):`docs/development/data-factory-fos-4b-3-prod-apply-runbook-20260625.md`
- 生产写入的设计锁(策略契约的规范定义,机制仍然准确,只是 §0.6 说的加载器还没写):`docs/development/data-factory-fos-4b-3-prod-apply-gate-design-lock-20260625.md`
- 原地升级脚本(Step 2 主体):`scripts/ops/multitable-onprem-package-upgrade-inplace.ps1`
- 打包脚本 / 包校验脚本(Step 0):`scripts/ops/multitable-onprem-package-build.sh`、`scripts/ops/multitable-onprem-package-verify.sh`
- 既有部署预检 / 验收脚本(Step 3):`plugins/plugin-integration-core/lib/stock-preparation-preflight.cjs`、`scripts/ops/stock-prep-acceptance-bootstrap.mjs`
- r6/r7 既有升级执行单(本文延续同一批约定):`r6-upgrade-222-runbook.md`、`r7-build-manifest.md`

---

## 大 BOM 分批路径实测(准备)

> **地位**:这一节只覆盖"把超过 `maxRows` 的合成数据灌进 222 上 `synthetic-plm` 数据源实际读取的那套表"这一步准备工作,不是完整的 dry-run/apply 验收程序——那一段仍然照 §3-§8 的既有步骤走,唯一区别是这次源里的项目号展开后 >10000 行,预期会走 `largeBom: true` 的分批预览分支(`isLargeBomBoundedExpansion`,
> `plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs:514-518`),而不是 §3 描述的一次性 `expanded` 结果。这条路径此前**从未实测过**——见
> `plugins/plugin-integration-core/fixtures/stock-preparation-synthetic-sql-source/README.md`
> "what it deliberately does not cover" 一节:该目录下的合成夹具"tens of rows by design",明确不覆盖
> `max_rows_exceeded` / large-BOM bounded path。本节的生成器就是补这个洞用的。
>
> **222 上没有独立的"合成 PLM 库"**——只读核实过:Postgres 实例上只有 `metasheet` 与 `postgres` 两个库,
> 合成 PLM 表就在**应用库 `metasheet` 的 `public` schema**里,而且现场存在**两套并存**的同名表:一套带
> 双引号、保留大小写的 `"DN_PDM_*"`(空表,遗留),一套不带引号、被 Postgres 折成全小写的 `dn_pdm_*`
> (有数据——7 零件/7 明细/1 订单行/1 项目,`synthetic-plm` 数据源真正读的是这一套)。本生成器输出的
> `INSERT`/`DELETE` 语句里的表名/列名全部不加引号(与
> `stock-preparation-synthetic-sql-source/01-schema.sql` 的既有约定一致),会被 Postgres 折成小写,
> 正好落在**有数据、被实际读取**的那一套,不会误伤空的遗留表。

### 怎么生成

```
node scripts/ops/stock-preparation-synth-large-bom.mjs \
  --out /tmp/stock-prep-synth-large-bom.sql \
  --fanout 25,25,20 \
  --project SYN-PROJ-LARGE-0001
```

`--fanout` 省略时就是默认的 `25,25,20`(根件下 25 个一级子件,每个一级子件下 25 个二级子件,每个二级
子件下 20 个三级子件)。**以"含根件"为主口径**:根件自己的订单行也会被展开器 push 进结果
(`lib/stock-preparation-bom-expansion.cjs:946-966`),所以真实 dry-run 的
`evidence.expansion.rowsExpanded` 应为 `1(根件) + 25 + 625 + 12500 = 13151`,这才是要拿去和默认
`maxRows` 10000 比较、判定是否触发大 BOM 分批的数字。三层子件本身的乘积之和(不含根件那一行)是
`25 + 625 + 12500 = 13150`,对应 `DN_PDM_BomDetailsInfo` 的行数,是另一个辅助口径,脚本 stdout 里两个
数字都会打印、并标注各自含义,不会只给一个数混淆。命令结束还会打印每张表的行数以及预期的总数量之和
(数量在每个父级下按 1→2→3 循环,便于手工核对滚算结果)。

所有由该生成器创建的对象 id(路径 id、订单 id、零件 `OBJ_ID`、BOM id)一律带 `SYNL-` 前缀——与
`stock-preparation-synthetic-sql-source/` 目录下既有夹具用的 `SYN-` 前缀**刻意不同**,两者可以同时
灌进同一个库互不干扰、互不清空。生成的 SQL 本身是幂等的:每张表先按 `SYNL-` 前缀 `DELETE`,再
`INSERT`,同名参数重跑、或换一组 `--fanout`/`--project` 重跑,都会先清掉上一次这个生成器留下的行。

### 怎么灌进应用库(`metasheet`)

合成 PLM 表就在应用库里,不是单独的库——用 app.env 里的 `DATABASE_URL` 直接连应用库执行:

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /tmp/stock-prep-synth-large-bom.sql
```

（连接串来自现场 app.env,本文不记录其值,也不记录主机名/账号/密码。生成器输出的语句全部不加引号,
落在 `public.dn_pdm_*` 那一套折成小写、有数据、被 `synthetic-plm` 数据源实际读取的表上,不会碰到
`"DN_PDM_*"` 那套带引号、空的遗留表。)

### 灌完怎么确认(三条 SELECT count)

```sql
-- 期望 = 生成时打印的 part 行数(默认 fanout 下是 13151)
SELECT count(*) FROM DN_PDM_PartLibraryInfo WHERE OBJ_ID LIKE 'SYNL-%';

-- 期望 = 生成时打印的 bomDetail 行数(默认 fanout 下是 13150,即 25+625+12500)
SELECT count(*) FROM DN_PDM_BomDetailsInfo WHERE bom_pid LIKE 'SYNL-%';

-- 期望 = 1(只有一个项目入口:DN_PDM_PathExAttrInfo.FileCode = 本次 --project 的值)
SELECT count(*) FROM DN_PDM_PathExAttrInfo WHERE Parent_OBJ_ID LIKE 'SYNL-%';
```

三条都对得上生成器 stdout 打印的数字,再按 §5-§6 选源、按 §6 对本次 `--project` 的值跑 dry-run。这份数据
是干净的(不缺件、不歧义、版本号统一),所以预期看到的不是别的守卫,恰好是 `max_rows_exceeded`:
展开在推到第 10001 行时停止(`pushRow`,`lib/stock-preparation-bom-expansion.cjs:746-753`),顶层
`status` 变成 `failed`(有一条全局错误即失败,`:977`),`largeBom` 为 `true`
(`isLargeBomBoundedExpansion`,`:514-518`)、附带 `boundedPreview`,`canApply` 为 `false`、不签发
`dryRunToken`(有全局错误就不可 apply,`stock-preparation-table-actions.cjs:1251`)——而不是 §3 描述的
`canApply: true` 干净结果。这正是本节要实测、此前从未跑过的分支。

### 实测后怎么清

生成的 SQL 文件开头有 `-- ==== CLEANUP-START ====` 到 `-- ==== CLEANUP-END ====` 之间的一段 —— 就是
那 7 条按 `SYNL-%` 前缀过滤的 `DELETE`,单独摘出来用同一个 `DATABASE_URL` 对应用库跑一遍即可清空这次
生成的全部行,不影响 `stock-preparation-synthetic-sql-source/` 目录下 `SYN-` 前缀的既有夹具数据。也可以
直接用同一份文件重新跑一次完整生成命令(脚本本身先删后插,天然幂等),效果等价。
