# 备料整体方案(代码核对版)—— 2026-09-02

> 目的:把 owner 的四步业务流("查项目 → 拉 PLM → 多人填写并通知下一步 → 仓库/采购导出 → 推宜搭")落到 **当前代码真实能力** 上,给出分波的工作项、每项的模型分派、以及必须由 owner 裁决的清单。
>
> 写法:每条代码事实都带 `文件:行号`,行号以 `origin/main @ 24942c70f` 与三条在途分支(#5442 @eb39596ba、#5445、#5447 @1dbf3535c)为准,合入后会漂移。**没核实的写在 §10,不混进事实。**
>
> 读法:只想知道"做什么、谁做、什么顺序"看 §5–§7;想知道"为什么这样做"看 §3–§4;owner 只看 §8。

---

## 0. 一句话结论

四步流里 **三步半已有底座**:项目检索(#5445)、拉 PLM(pull-bom 动作 + 三重人工列墙)、多人填写(多维表网格 + #5447 列级写权限)、通知下一步(#5442 交接 + 钉钉群)、导出 Excel(prep-line-export)。缺的不是新功能,而是 **把它们串到一张"项目备料页"上**、补三处守卫缺口(P4 无加载器、#5447 未声明列不设防、导出未解析列不报)、以及一次 owner 裁决。宜搭按 R9 延后。

---

## 1. 业务流 → 系统映射(现状)

| 步 | owner 要的 | 现有能力(已合 / 在途) | 缺口 |
|---|---|---|---|
| ① 查项目 | 一线按项目名找到项目 | #5445 `GET /projects/directory`(operate∧read,租户由认证主体决定,`http-routes.cjs:1438-1447`;宿主 `tenant-principal-directory-boundary.ts:107/:127`) | 在途未合;没有"进入该项目的备料页"的落点 |
| ② 拉 PLM 七字段 | 一键拉取,父图号/父名称/规格进主表(R2) | pull-bom 动作 + `assertNoHumanFields`(`apply-writer.cjs:239/:373/:396`)+ conflict-planner 人工列墙(`:1057`);#5446 已合,主模板含 parentComponentCode/parentComponentName/componentSpec(`stock-preparation-templates.cjs:631-745`) | 正式主表写入要过 P4,而 **P4 生产策略没有加载器**(§3.1);小时批次 opt-in(R7)无 UI |
| ③ 多人填九列 | 生产/采购/仓库各填各的,别人看得见(R4) | 多维表网格编辑 + `field_permissions`(迁移 zzzz20260411140100;`permission-service.ts:857-912`;`permission-derivation.ts:77-119`);#5447 让客户包声明 `fieldWritePolicies` 落成 read_only 行 | #5447 只保护"有角色认领"的列,**plm_system 机器列在网格里对声明角色仍可写**(§3.2);备料日期/领料节点/毛胚尺寸目前在客户包 ext_ 列,不在冻结模板 |
| ③′ 通知下一步 | 接力,最后一棒并行通知仓库+采购(R5),系统发、署名谁批(R6) | #5442 `integration_stock_prep_handoff` 游标、六步封闭词表、终点并行群通知、正文"(本条由系统发送)" | 六条对抗发现待修(CAS 竞态、projectNo 自由文本、配置拼错静默、私有目的地行、handler 校验前重放、审计先于推进);**只有群 webhook,没有个人待办**(仓库无钉钉 todo API;`client.ts:999` 有 ActionCard 可做个人通知) |
| ④ 导出 Excel | 仓库/采购按项目导出 | `stockPreparationPrepLineExport`(`http-routes.cjs:6933-6992`,operate 权限,跟随动作目标,审计 `prep_line_export`) | `unresolvedColumns`(`prep-line-export.cjs:348`)不透传不审计,列缺了用户不知道;`:66 REQUIRED_PERMISSION='admin'` 注释与路由不符 |
| ⑤ 推宜搭 | 最后 | 无。出站写门 `outbound-http-write-gate.cjs`(未设 `INTEGRATION_CORE_OUTBOUND_HTTP_WRITE_TARGETS` ⇒ 禁用) | R9 延后;要走 data_sources 收敛(owner 另一窗口在做) |

---

## 2. 不可改的 owner 裁决(R1–R10)与本方案的对应

| 裁决 | 本方案怎么落 |
|---|---|
| R1 租户内操作员可见本租户数据 | 备料页/多维表深链只放物理句柄(sheetId/viewId)与项目号,不放业务值;目录路由租户由主体决定(#5445) |
| R2 主表回填父图号/父名/规格 | #5446 已合;导出 12 列 fallbackIds `ext_parentDrawingNo/ext_parentName/ext_spec`(`prep-line-export.cjs:101-113`)保留兼容 |
| R3 make-or-buy 是人工封闭选项,不路由 | #5447 新增 `makeOrBuy` 为 human 列;导出/看板只读它,不据它分流 |
| R4 采购/仓库列共享读、只限写 | #5447 `visible` 恒为 `true`(`stock-preparation-field-permissions.ts`,结构上不能隐藏),只写 read_only |
| R5 串行接力 → 终点并行仓库+采购 | #5442 `terminal.groupDestinationIds` |
| R6 系统发、署名谁批 | #5442 正文已带"(本条由系统发送)"+ 批准人 |
| R7 小时批次 opt-in | Wave 3;默认整项目一次拉 |
| R8 轻交接不是审批引擎 | 不做审批流引擎;#5442 游标即"轮到谁" |
| R9 宜搭最后 | Wave 3,按钮灰显 |
| R10 派生开放、只做人工列 | 不做任何"生产列 → 采购列"的自动派生 |

---

## 3. 三个关键发现(本轮逐条证伪后保留)

### 3.1 P4 生产写入策略 **没有加载器**——正式主表在真实部署里写不进去

- `packages/core-backend/src/index.ts:2847` `config: resolvePluginRuntimeConfig(manifest.name)` 是插件 `context.config` 的 **唯一来源**。
- `packages/core-backend/src/plugin-runtime-config.ts:98-170` 只产出六个键:`tableActions / stockPreparationTableActions / stockPreparationCustomerPacks / stockPreparationExtFieldMapping / b2aTrialRegistry / c6TestFailureInjection`。**没有 `stockPrepApplyProduction`,也没有 `stockPrepApplySandbox`。**
- 插件侧 `stock-preparation-table-actions.cjs:1554-1559 resolveStockPrepApplyProductionPolicy(config)` 只读 `config.stockPrepApplyProduction`;`:1568-1590 assertStockPrepApplyAllowed` 有策略走 production 门(标准化 → 到期 ≤7 天 → 显式 canonical objectId → route/actionId 匹配 → maxCleanRows),无策略走 sandbox 门。
- 结论:runbook(`data-factory-fos-4b-3-prod-apply-runbook-20260625.md:10,49,110`、222 runbook `:343-347`)写的"设 `context.config.stockPrepApplyProduction`"在真实部署 **无处可设**。P4 门本身是对的,只是没人能给它钥匙。
- 先例:#5442 在 `plugin-runtime-config.ts:176/:188` 用 `readDeployJsonObjectFile` 加了 `stockPreparationHandoff` 文件加载器——同一模式可以给 P4 加一个。

三个落地形态,owner 三选一(§8 D1):

| 形态 | 代码量 | 保证型 | 说明 |
|---|---|---|---|
| **A. 宿主文件加载器**(推荐,若必须写正式主表) | S(1 文件 + 测试) | 是 | `INTEGRATION_CORE_STOCK_PREPARATION_PRODUCTION_POLICY_PATH` → `config.stockPrepApplyProduction`;7 天窗、requireFreshDryRun、canonical 显式匹配 **一条不动**;每次新项目拉取放一条 ≤7 天策略文件 |
| **B. sandbox 命名空间工作表作上线表** | 0 | 否 | `normalizePackTargetObjectId`(`customer-pack.cjs:203-258`)允许 `plm_stock_preparation_sandbox*`;导出、装包、拉取全跟随动作目标,所以整条链路自动一致;代价:表名带 sandbox,env allowlist 无到期 |
| C. 授权表 + 1 小时派生策略 | L | 是(新守卫) | 面向"每天多项目"的日常化;要 ADR + 对抗验证;不适合 222 窗口 |

**不做**:放宽 `MAX_PRODUCTION_POLICY_WINDOW_MS`(`production-policy.cjs:30`)或 `requireFreshDryRun`。

### 3.2 #5447 的"补集拒写"让 **未认领的列完全不设防**——包括所有 plm_system 机器列

- `stock-preparation-customer-pack.cjs normalizeFieldWritePolicies`:对目录里每一列,若有角色认领,则 **其他已声明角色** 得到一条拒写;"A column NO declared role claims is left completely alone"。
- 20 个 plm_system 列(idempotencyKey、drawingNo、parentComponentCode …)不会被任何部门角色认领 ⇒ 不产生任何 `field_permissions` 行 ⇒ 生产/采购/仓库角色在多维表网格里 **可以直接改机器列**。三重人工列墙(apply-writer / conflict-planner / multitable ownership guard)保护的是"机器不碰人工列",反方向没有墙。
- 另外:`applyRoleWriteScopes` 是 **追加 UPSERT 不撤销**(改包删掉一条 owns 不会收回旧拒写),`roleId` 必须存在于 `roles`(`ROLE_NOT_FOUND`),`visible` 恒 `true`。
- 两种补法(§8 D2):
  - **配置解**:客户包再声明一个"系统列 owner"角色(现有 `roles.id`),`ownsFieldIds` = 全部 plm_system 列。零代码,但每装一次包要记得,且该角色的人就能改机器列。
  - **代码解**(推荐):安装器对每个已声明角色自动生成 plm_system 列的拒写(约 20 行 + 测试),客户包不必知道机器列存在。归入 Wave 1 W1-5。

### 3.3 sandbox 命名空间工作表是 222 窗口的 **零代码上线落点**

- `assertStockPrepApplySandboxAllowed`(`table-actions.cjs:1508-1547`):canonical `plm_stock_preparation_main` **永远** 被 sandbox 路径拒绝;需要 `STOCK_PREP_SANDBOX_MODE=true` + `STOCK_PREP_SANDBOX_TARGET_OBJECT_IDS` 逗号 allowlist(无到期)。
- 导出(`http-routes.cjs:6933-6992`)经 `tableActions.getTableAction({tenantId, actionId})` 解析目标,装包经 `normalizePackTargetObjectId`,拉取经 apply 门——三者都跟着动作绑定走,不需要为 sandbox 单独改任何一处。
- 代价只有"名字":表 objectId 带 `sandbox`。若 owner 接受,222 首个项目可以 **不等 P4 加载器**。

---

## 4. 方案总图:操作员的一天

```
一线(operate)登录 → 默认落「项目备料」页
  ├─ 搜项目名(#5445 目录)→ 进项目页 /stock-prep/projects/:projectNo
  │     页头:项目号 · 拉取状态 · 轮到谁(#5442 游标)· 最近导出
  │     [拉取 PLM] → dry-run 摘要 → 确认 → apply(sandbox 或 A 形态策略)
  │     [到多维表填写] → /multitable/:sheetId/:viewId?filter=projectNo:<no>(临时过滤,不落库)
  │     [通知下一步] → #5442 advance → 钉钉群卡片带本页深链
  │     [导出 Excel] → 跟随动作目标;响应头带 unresolved 列 → 页面黄条提示
  │     [推送宜搭](灰显,R9)
  └─ 仓库/采购 收到终点并行通知 → 点深链 → 导出
```

"填写面"**复用多维表网格**而不是新造:网格已有编辑/自动保存/下拉/列写门/协同,重做要重过三重墙。代价是要补 3.2 的机器列防护与一个临时过滤参数(W1-2)。

---

## 5. 分波工作项

尺寸口径:**S** 单文件 + 测试、半天内;**M** 2–4 文件、一天;**L** 跨包/新边界、2–3 天;**XL** 保证型/需 ADR + 对抗验证。
"保证型 = 是"的项目 **必须** 过对抗验证工作流(攻击 lane → 反驳者默认 refuted=true → 只留确认项)才能合。

### Wave 0 —— 裁决、在途 PR 收口、环境配置(目标:不写新功能)

| # | 工作项 | 目标 / 范围 | 依赖 | 裁决 | 外部依赖 | 风险 | 大小 | 验收 | 保证型 |
|---|---|---|---|---|---|---|---|---|---|
| W0-1 | owner 裁决 D1–D12 | §8 全部拿到答案,写进 `decision-register.md` | — | 全部 | — | 无裁决则 W1-5/W2-1 无法定形 | — | decision-register 每条有日期与选项 | 否 |
| W0-2 | #5442 六条修复 → 对抗 → 合 | CAS 竞态、projectNo 校验(封闭到目录里的项目)、config 未知键报错、目的地必须是 group 且非 private、handler 校验先于重放判定、审计与推进同事务 | 后台修复代理已在 `scratchpad/wt-fix-5442` 起了六条 RED 测试 | — | — | 修完 pins 重算;与 #5447 迁移序号冲突 | M | 六条 RED 变绿;对抗工作流 0 confirmed | **是** |
| W0-3 | #5445 补测 → 合 | pin seam 参数、宿主边界测试 | — | — | — | 低 | S | 现有对抗 lane 跑完;合入 | 否 |
| W0-4 | #5447 rebase → 对抗 → 合 | 对齐 #5446 列序;验证 `fieldWritePolicies` 校验、`ROLE_NOT_FOUND`、追加不撤销的文档化 | W0-2/W0-3 先合(顺序:5445 → 5442 → 5447) | D2 决定是否同 PR 带机器列拒写 | — | 追加不撤销是已知限制,要写进包文档 | M | 对抗 0 confirmed;安装演练包后 `field_permissions` 行数 = 预期 | **是** |
| W0-5 | 222 环境配置清单 | 客户包 JSON(含 `fieldWritePolicies`)、`stockPreparationHandoff` JSON、钉钉群 webhook、B2a 读授权登记、sandbox env(若 D1=B)、动作绑定 | D1/D3/D4/D5 | 钉钉群、客户 PLM 项目数据 | 配置放错静默(#5442 修复后会报错) | S | 按 `222-deploy-window-runbook` Step 0 逐条勾 | 否 |
| W0-6 | 凭据轮换 + 测试库真实项目 | `readonly2` 用后轮换;客户在测试 PLM 填一个真实项目 | — | — | 客户 | 窗口前拿不到 ⇒ 接受"首跑即验证" | — | 新凭据仅在 env;dry-run 出现真实行 | 否 |

### Wave 1 —— 一天跑通四步(目标:222 窗口可演示、可上线)

| # | 工作项 | 目标 / 范围 | 依赖 | 裁决 | 外部依赖 | 风险 | 大小 | 验收 | 保证型 |
|---|---|---|---|---|---|---|---|---|---|
| W1-1 | 项目备料页(board) | `GET /projects/:projectNo/board`(operate∧read):聚合 #5445 目录项 + 动作目标 + 拉取/确认状态 + #5442 游标 + 最近导出审计;前端 `/stock-prep/projects/:projectNo` 页与上面五个按钮;operate 默认 tab 落此页 | W0-2/3/4 | D12 | — | 读路由不写库,风险在租户边界:必须复用 #5445 的租户解析,不接受 query 里的 tenantId | M | 三角色各登一次:看到本租户项目,拉/填/通知/导出四钮可达;跨租户项目号 404 | 否(但对抗 lane 跑租户边界) |
| W1-2 | 多维表临时过滤深链 | `multitableRoute.ts` + `router/types.ts:461` 增 `filter=fieldId:value` 查询参数,只叠加到当次视图 filterInfo,不写 personal-view-config;URL 只放 projectNo | — | — | — | 若网格无"临时 filterInfo 叠加"钩子则升 M→L(§10) | M | 带参进入只见该项目行;刷新仍在;切视图清除;不产生视图/个人视图记录 | 否 |
| W1-3 | 导出未解析列可见 | `unresolvedColumns` → 响应头 `X-Stock-Prep-Export-Unresolved-Columns` + 审计 `prep_line_export` 字段 + 前端黄条;修 `prep-line-export.cjs:66` 注释为 operate | — | D7(部门列是否进导出) | — | 低 | S | 缺可选列时头与审计同时出现;必需列缺仍 500 `PREP_LINE_EXPORT_FIELD_IDS_UNRESOLVED` | 否 |
| W1-4 | 确认队列死按钮 | `StockPreparationConfirmationQueueView.vue:77/87` 两钮 `emit('admin-action')` 在 `StockPreparationWorkspace.vue` 接线或移除 | — | — | — | 低 | S | 点击有响应或按钮不存在;vue-tsc 真绿(注意"假绿"教训) | 否 |
| W1-5 | 机器列防护 | 安装器对每个已声明角色自动追加全部 plm_system 列拒写(代码解);或客户包声明系统列 owner(配置解) | W0-4 | **D2** | — | 代码解改 `applyFieldWritePolicies` 语义,要重跑 #5447 对抗 | S(代码)/0(配置) | 以 production 角色登录网格,改 `drawingNo` 被拒 `FieldWritePermissionDeniedError`;人工列可写 | **是** |
| W1-6 | 合成源四步 E2E + runbook | 用 `factory-a.rehearsal` 包 + 合成 PLM 源跑:搜 → 拉 → 三角色填 → 通知 → 导出;更新 `stock-prep-demo-runbook` 与 222 runbook Step 2 | W1-1..W1-5 | — | — | E2E 在 CI 时长 | M | 一条 vitest/E2E 脚本从空库到导出文件;导出行数 = 拉取行数 | 否 |
| W1-7 | (若 D1=A)P4 文件加载器 | `plugin-runtime-config.ts` 增 `INTEGRATION_CORE_STOCK_PREPARATION_PRODUCTION_POLICY_PATH` → `stockPrepApplyProduction`;沿用 `readDeployJsonObjectFile`;策略形状不变 | W0-1 | **D1** | — | 这是给 P4 门配钥匙,钥匙本身就是保证型 | S | 文件缺 ⇒ 无策略走 sandbox 门;文件坏 ⇒ 启动报错命名 env;策略过期 ⇒ apply 拒;对抗 0 confirmed | **是** |

### Wave 2 —— 日常化(目标:每天多个项目、多人并行不靠人记)

| # | 工作项 | 目标 / 范围 | 依赖 | 裁决 | 外部依赖 | 风险 | 大小 | 验收 | 保证型 |
|---|---|---|---|---|---|---|---|---|---|
| W2-1 | 钉钉个人通知 seam | 宿主 `stockPreparationHandoffNotifier` 增 `sendToUsers`,走 `sendDingTalkWorkNotificationActionCard`(`client.ts:999`)+ `directory_account_links` 映射;#5442 步骤 `handlerUserIds` 已有 | W0-2 | D6 | 钉钉企业应用权限(工作通知) | 无 todo API,只能"通知 + 深链",不是待办完成态 | L | 处理人收到个人卡片,点开即项目页;未映射用户降级群通知并审计 | 否 |
| W2-2 | 三字段模板提升 | `ext_stockPrepDate / ext_pickingNode / ext_blank*` 从客户包提升进冻结模板;`HUMAN_PRESERVED_FIELD_IDS` 13 → 16+;导出 `EXPORT_COLUMNS` 改主 id、旧 ext_ 留 fallback | W1-3 | D3/D4 | — | 模板演进闸 + 全部 fixture;222 已装表要迁列 | L | 新装表列全;旧表 fallback 导出不变;模板 pin 重算 | **是**(模板冻结守卫) |
| W2-3 | 部门列进导出 | `makeOrBuy / procurementDone / procurementReplyDate / warehouseDone / actualArrivalDate` 进 `EXPORT_COLUMNS` | W0-4 | D7 | — | 低 | S | 导出 17 列;老表缺列走 unresolved 头 | 否 |
| W2-4 | #5442 强化二期 | 多租户同项目号隔离测试、步骤自定义标签、"轮到我"看板过滤 | W0-2 | D5 | — | 低 | M | 看板只列自己是 handler 的项目 | 否 |
| W2-5 | (若 D1=C)授权表 + 派生策略 | `integration_stock_prep_apply_grants` + 1 小时派生 `stockPrepApplyProduction`;ADR | W1-7 | D1 | — | 新守卫、新攻击面 | XL | ADR + 对抗 0 confirmed;7 天窗与 requireFreshDryRun 不变 | **是** |

### Wave 3 —— 延后(目标:owner 明确说做再做)

| # | 工作项 | 说明 | 裁决 | 大小 | 保证型 |
|---|---|---|---|---|---|
| W3-1 | 推送宜搭 | 走 owner 另一窗口的 data_sources 收敛(kind `yida`),出站经 `outbound-http-write-gate` 声明身份 allowlist;需 formUuid/字段映射/重推策略 | D9 | L | **是** |
| W3-2 | 小时批次 opt-in UI | R7;拉取对话框加"按创建小时分批"开关,默认关 | — | M | 否 |
| W3-3 | 结转 UI / 匿名 hold 处置 / 无害差异分类 / 大 BOM worker | 首个项目首拉不会触发;逐项都是保证型 | — | L–XL | **是** |
| W3-4 | PLM 侧项目前缀检索 | 新开 SQL 读腿并过 B2a;测试库 project_code 全空无法验证;先用"精确 FileCode + dry-run 即存在性检查" | — | M | **是**(读腿授权) |

---

## 6. 模型分派表(按代码难度)

### 6.1 分派规则

| 级 | 特征 | 模型 | 对抗验证 |
|---|---|---|---|
| **L0 机械** | 注释/文档改字、pin 重算、fixture 同步、按钮删除;判断量≈0 | haiku(effort low) | 不需要;主循环 diff 目检 |
| **L1 有样板的单文件功能** | 有现成模式可抄(`readDeployJsonObjectFile`、现有响应头/审计字段)、单文件 + 测试、边界清楚 | sonnet | 保证型的才需要,且反驳者用 opus |
| **L2 跨模块 / 新边界** | 路由 + 页面 + 宿主 seam、改现有守卫语义、多租户边界、并发修复 | opus | 需要;3 反驳者 opus,默认 refuted=true |
| **L3 保证型 / 架构裁决 / 综合** | 给守卫配钥匙、模板冻结演进、出站身份、ADR、多方案评审与合成 | fable 主循环(或 opus 反驳者 + fable 裁判) | 必须;确认项 0 才合 |

补充规则:
- **写代码的模型 ≠ 反驳的模型**:L2 以上,实现者与反驳者至少一个用不同模型或不同提示角度。
- **主循环只做三件事**:裁决、合成、合并前最后一眼;不亲自写 L0/L1 代码(委派后目检)。
- 任务升级触发:实现者报告"要改第二个包"或"要改守卫语义" ⇒ 升一级重派;不要让 sonnet 自行扩 scope。
- 每个改 `package.json` 测试链或 `pluginPackageJson` pin 的 PR 单独排队合,避免 O(n²) 冲突。

### 6.2 逐项分派

| 工作项 | 难度 | 实现 | 验证 | 备注 |
|---|---|---|---|---|
| W0-1 裁决整理 | L0 | haiku 把 §8 抄进 decision-register | 主循环目检 | — |
| W0-2 #5442 六条修复 | L2 | opus(已在 `wt-fix-5442`) | 对抗:3×opus 反驳 + fable 裁判 | CAS 与事务边界是并发问题,不给 sonnet |
| W0-3 #5445 补测 | L1 | sonnet | 现有 lane 跑完即可 | — |
| W0-4 #5447 rebase + 对抗 | L2 | opus rebase;sonnet 补文档 | 对抗:3×opus | 若 D2 选代码解并同 PR 带上,升 L3 |
| W0-5 222 配置清单 | L0 | haiku 生成清单 | 主循环 + owner 勾 | 真值靠 owner |
| W1-1 项目备料页 | L2 | opus(后端路由)+ sonnet(页面按钮,给定 API 契约) | 租户边界 lane:2×opus | 前后端拆两个代理并行,契约先由 opus 定 |
| W1-2 多维表临时过滤 | L2 | opus | sonnet 写 E2E;1×opus 反驳"是否落库" | 先派 Explore 查网格有无 filterInfo 叠加钩子,没有则升 L3 |
| W1-3 导出未解析列 | L1 | sonnet | 单测即可 | 模式=现有 `X-Stock-Prep-Export-Row-Count` |
| W1-4 死按钮 | L0/L1 | haiku(删)/sonnet(接线) | vue-tsc 真跑 | — |
| W1-5 机器列防护 | L3 | opus 实现 | 3×opus 反驳 + fable 裁判 | 改的是权限语义,必对抗 |
| W1-6 合成源 E2E | L1 | sonnet | 跑绿 | 长脚本但无判断 |
| W1-7 P4 文件加载器 | L3 | sonnet 写(样板 #5442 `:176/:188`) | **3×opus 反驳 + fable 裁判** | 代码 S,但是守卫钥匙——验证按 L3 |
| W2-1 钉钉个人 seam | L2 | opus | 2×opus(降级路径、未映射用户) | 依赖企业应用权限 |
| W2-2 模板提升 | L3 | opus | 3×opus + fable | 模板冻结守卫 + 全 fixture |
| W2-3 部门列进导出 | L1 | sonnet | 单测 | — |
| W2-4 #5442 二期 | L2 | opus | 2×opus | — |
| W2-5 授权表(若 D1=C) | L3 | fable 写 ADR;opus 实现 | 5×opus + fable | XL |
| W3-1 宜搭 | L3 | fable 定身份边界;opus 实现 | 对抗 + owner | 与另一窗口收敛方案对齐后再动 |
| W3-2 小时批次 UI | L1 | sonnet | 单测 | — |
| W3-3 结转/差异/worker | L3 | opus | 对抗 | 逐项立 ADR |
| W3-4 PLM 前缀检索 | L2 | opus | B2a 读腿 lane | — |

---

## 7. 顺序与并行

```
Wave 0: W0-1 ─┬─ W0-3(#5445 合) ─→ W0-2(#5442 合) ─→ W0-4(#5447 合) ─→ pins 重算
              ├─ W0-5 / W0-6(owner/客户并行)
Wave 1: W1-2、W1-3、W1-4 三项无依赖,立即并行(三个代理三个 worktree)
        W1-1 等 W0-4;W1-5 等 W0-4 + D2;W1-7 等 D1
        W1-6 收尾
Wave 2/3: 按 owner 优先级
```

合并纪律沿用:每 PR 审核+修复后合;保证型必对抗;合后重算 pins;不在主检出切分支(代理只在自己的 worktree)。

---

## 8. owner 待裁决 D1–D12

| # | 问题 | 选项 | 我的建议 |
|---|---|---|---|
| D1 | 222 上线工作表落点 | A 正式主表 + P4 文件加载器 / B sandbox 命名空间表(零代码)/ C 授权表(Wave 2) | **B 过窗口,A 在 Wave 1 末补上**,C 不做 |
| D2 | 机器列防护 | 代码解(安装器自动拒写 plm_system)/ 配置解(系统列 owner 角色) | **代码解**,并在 #5447 合后立即做 |
| D3 | 三个角色 `roles.id` 与人员名单;一人多角色是否允许 | — | 允许,但 `fieldWritePolicies` 里同一角色不重复声明(代码已拒重复) |
| D4 | 备料日期/领料节点/毛胚尺寸:留客户包 ext_ 列(222)还是提升进模板 | — | 222 留 ext_,Wave 2 提升 |
| D5 | 接力步骤:六步词表里选哪几步、顺序 | prep_entry/process/planning/technical/production/final_review | 三步:prep_entry → production → final_review(终点并行仓库+采购) |
| D6 | 钉钉:复用客户现有群?申请企业应用权限做个人通知? | — | 群先上;企业应用权限在窗口后申请 |
| D7 | 五个部门列是否进导出 | — | 进(W2-3),222 不急 |
| D8 | "备料情况"= 模板 `stockPreparationStatus` 封闭选项,还是自由文本 | — | 封闭选项 |
| D9 | 宜搭:是否一定做;formUuid/字段结构/重推 | — | 等收敛方案 |
| D10 | 毛胚尺寸五列(长/宽/厚/数量/质量)还是一列文本;导出带几列 | — | 五列,导出全带 |
| D11 | 客户测试 PLM 真实项目何时能填;拿不到是否接受"窗口内首跑即验证" | — | 接受,但 dry-run 摘要必须 owner 过目再 apply |
| D12 | operate 默认 tab 是否为项目备料页;admin 是否也默认落此页 | — | operate 是;admin 仍落工作台 |

---

## 9. 明确不做(本轮)

| 项 | 为什么 |
|---|---|
| 新造备料专用填写网格 | 多维表网格已有编辑/保存/下拉/列写门;重做要重过三重墙 |
| 放宽 7 天策略窗或 requireFreshDryRun | 保证型常量;A/B 形态已能运转 |
| 生产列 → 采购/仓库列自动派生 | R10 开放,只做人工列 |
| 审批引擎 / 待办完成态 | R8;钉钉无 todo API |
| 导出按"轮到我的行"过滤 | 接力粒度是项目 |
| 多维表 filter 参数持久化 | 会碰视图 ACL;URL 承担即可 |
| 合并九张 MVP 冻结表与主表两条管线 | R2 已裁决;`mvp-persist` 保持 env 关闭 |
| 深链把业务值放进 URL | 只放 sheetId/viewId/projectNo |
| PLM 侧项目前缀检索(Wave 1) | 新读腿要过 B2a,测试库无法验证 |

---

## 10. 未核实(写方案时没有读到的)

- 多维表网格是否已有"临时 filterInfo 叠加"钩子 —— W1-2 M/L 的分水岭;先派 Explore 代理查 `MultitableEmbedHost` 及视图组件。
- 插件服务账号的记录写入是否绕过 `field_permissions`(plan-1 提出,未验证)—— 若绕过,W1-5 只保护网格,不保护 API;对抗 lane 要覆盖。
- 真实客户包 JSON 与 222 环境实际配置(客户包/env/动作绑定/B2a 登记/`readDeployJsonObjectFile` 在 Windows+pm2 的路径行为)。
- #5442 六条修复的最终代码形状(修复代理进行中);#5445 未跑完的对抗 lane;#5446 补跑的对抗结果。
- #5447 rebase 到 #5446 之后的列序与 `fieldWritePolicies` 校验是否变化(读的是 1dbf3535c)。
- 钉钉群机器人 webhook 在客户网络能否出站(222 防火墙)。
- 我方 BOM 展开器是否复刻老系统"总图"根选择规则(未读 `bom-expansion.cjs` 根选择段)。
- 导出路由行号 `6933-6992` 在合入 #5442/#5447 后会漂移。

---

## 附:本方案引用的代码事实索引

| 事实 | 位置 |
|---|---|
| 插件 config 唯一来源 | `packages/core-backend/src/index.ts:2847` |
| 运行时配置六键 | `packages/core-backend/src/plugin-runtime-config.ts:98-170`;`readDeployJsonObjectFile :63` |
| #5442 加载器先例 | 同文件 `:176 / :188`(分支 `feat/stock-prep-notify-next`) |
| sandbox / production 门 | `plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:1508-1597` |
| 策略形状与 7 天窗 | `stock-preparation-production-policy.cjs:25 / :30 / :75-150` |
| 包目标 objectId 规范化 | `stock-preparation-customer-pack.cjs:203-258` |
| 补集拒写推导 | 同文件 `normalizeFieldWritePolicies`(分支 `feat/stock-prep-department-fields-column-permissions`) |
| 宿主列权限服务 | `packages/core-backend/src/services/stock-preparation-field-permissions.ts`(同分支) |
| 安装器 applyFieldWritePolicies | `stock-preparation-customer-pack-installer.cjs ~:605-630`(同分支) |
| field_permissions 原语 | 迁移 `zzzz20260411140100`;`permission-service.ts:857-912`;`permission-derivation.ts:77-119`;执行点 `index.ts:4058`、`univer-meta.ts:3853/4730/4741`、`yjs-field-read-access.ts:54` |
| 导出路由 / 模块 | `http-routes.cjs:6933-6992`;`stock-preparation-prep-line-export.cjs:66 / :101-113 / :148 / :237-274 / :348` |
| 人工列墙 | `apply-writer.cjs:239 / :373 / :396`;`conflict-planner.cjs:1057` |
| 模板 | `stock-preparation-templates.cjs:104-113`(8 人工列)、`:631-745`(主表) |
| 多维表路由 | `apps/web/src/router/types.ts:461`;`multitableRoute.ts`;`StockPreparationWorkspace.vue:404-412` |
| 钉钉客户端 | `packages/core-backend/src/integrations/dingtalk/client.ts:837 / :945 / :999 / :1067` |
| 出站写门 | `plugins/plugin-integration-core/lib/outbound-http-write-gate.cjs` |
| #5445 目录路由 | `http-routes.cjs:1438-1447`;`tenant-principal-directory-boundary.ts:107 / :127` |
