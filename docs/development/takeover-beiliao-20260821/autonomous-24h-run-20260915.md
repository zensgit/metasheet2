# 第六次 24 小时自主开发：设计与验证记录（2026-09-15 18:05 → 2026-09-16 18:05）

授权原话："接下去24小时我不在电脑前，你能帮我持续不间断的开发么？并根据代码难度来选择模型，完成后给出设计及验证MD"。
前置拍板（同日 17:5x，"按建议执行"）：#5741 归审批窗口；阶段二四项默认；顺序 #5742 → #5743 → 阶段二后端 → 阶段二前端；夜间上 222。

状态图例：✅ 合并/完成 ｜ 🟡 进行中 ｜ ⛔ 阻塞/放弃 ｜ 📝 待 owner

## 0. 结果一览（随时更新）

| # | 项 | 模型 | PR / 产物 | 状态 |
| --- | --- | --- | --- | --- |
| Q0 | 铃铛计数 1 / 面板「暂无通知」（顺手，演示记录 §5.4） | 主会话 | #5748（2b67a0462） | ✅ 已合，待 r47 |
| Q1 | #5742 写回 outcome→选项映射（`resultWriteback.outcomeValues`） | opus 实现 / opus 反驳 / fable 裁判 | #5752（f67984b34；裁判 FIX，10 条反驳全落码 + 遗留补 84551a0cb） | ✅ 已合，r47 |
| Q2 | #5743 管理弹窗 1.2 s 轮询 | opus / opus / fable | #5751（268aded99；裁判 MERGE，两项遗留已补 ecfaaaf78；H2 → #5750） | ✅ 已合，待 r47 |
| Q3 | 阶段二后端：记录级送审（提交表、路由、权限码、耐久消费者 v2） | opus / opus / fable | #5754（59d1eac2c；裁判 FIX，10 条反驳 4 真问题已修；realdb 泳道 + G5 注入 + 三处 CI 修） | ✅ 已合，r48 |
| Q4 | 阶段二前端：抽屉送审入口、对话框、审批面板 | opus / opus / fable | #5753（裁判 FIX @8bc1ab1d0，14 条反驳 12 修；遗留 3 项 e91c8c8b0 + guard 镜像 184cf4a20） | ✅ 已合，待 r48 |
| Q5 | componentSpec 中文名「组件规格」 | 主会话 | 222 字段改名（模板已有 labelZh） | ✅ |
| Q6 | 阶段二设计稿 | 主会话（基于 4 代理只读地图） | `multitable-approval-phase2-record-submit-design-20260915.md` | ✅ 草稿 |
| Q7 | 编辑器所有动作类型 config 保留（#5739 泛化） | Explore 普查 → opus / opus / fable | 裁判 MERGE @364ca6a2c（8 条反驳全落码，含字段值字符串化与跨基界面失真两条 major）；PR 见 §2 | 🟡 CI |
| Q8 | #5750 外部上下文同步收敛（先复现） | opus 复现 / opus / opus / fable | 复现成功（5 次重发 = 5 次 HTTP）；裁判 MERGE @dfae6f39f；PR 见 §2 | 🟡 CI |
| — | 222 发布 | — | r47 / r48（夜间） | 📝 |

## 1. 队列与模型选择依据

- **主会话（fable）**：根因判断、设计、拍板项落地、上机操作、跨代理仲裁。
- **opus（impl-hard）**：跨文件逻辑与守卫/权限/幂等代码（Q1–Q4 的实现与修复）。
- **opus（refuter，只读）**：每个 PR 两个不同镜头的反驳者，只准内存级探针，不在共享 worktree 落盘变异。
- **fable（security-judge）**：终审，按五类漏法（假件背书 / 守卫没接线 / 边界无强制 / 逐套绿整链红 / 触发与边界不同量）。
- **sonnet**：机械改动（本轮未用到；Q5 由主会话一条 SQL 完成）。
- 只读地图（Explore，opus）：阶段二前先摸清审批桥接、RBAC 播种、记录抽屉三块，再由批评者补缺口——地图发现了三条会让直觉方案失败的约束（耐久投递清单冻结、createApproval 自校验 approvals:write、审批实例无来源记录列），全部进了设计稿 §2。

## 2. 每项设计要点

### Q0 铃铛（#5748）
根因：`normalizeRecordSubscriptionNotification` 对所有事件类型要求 `recordId` 非空，而 approval.completed 等无记录触发器产生的 `notification.sent` 行 `record_id=''`；服务端未读计数算它，客户端列表丢它。修：仅记录级事件要求 recordId。组件侧对空 recordId 跳过导航的逻辑在 F9b（#5664）已有。附带删掉 `client.ts` 既有 lint 红（未使用导入）。

### Q1 #5742
（流水线完成后补：配置形状、校验与执行一致性、编辑器交互、变异证据）

### Q2 #5743
根因（只读诊断，已核对 origin/main 仍成立）：`MultitableWorkbench.vue` 的 `startDialogMetaRefresh` 在字段/权限/视图/导入四个管理弹窗打开期间以 1200 ms `setInterval` 无条件重拉 fields + context，不比对内容、不看页面可见性；四个按钮仅管理员可见。修：开弹窗拉一次 + 15 s 慢刷新 + 页面隐藏暂停 + 指纹不变则跳过状态替换。
（流水线完成后补：实现细节与测试）

### Q3 / Q4 阶段二
见 `multitable-approval-phase2-record-submit-design-20260915.md`。
（流水线完成后补：与设计稿的偏差、契约对齐、测试矩阵实际覆盖）

### Q5 componentSpec
模板 `stock-preparation-templates.cjs:754` 早已 `labelZh: '组件规格'`，222 上的字段 `fld_3340800c07dc656a26e7141c`（五个恢复列之一，无 pack fieldId）仍是英文名，直接 `UPDATE meta_fields SET name` 改为「组件规格」（值无关，条件带原名）。新装实例走 zh-CN 时自然取中文。

## 3. 验证记录

### 3.1 r47（main `f67984b34` = r46 + #5748 + #5751 + #5752），2026-09-15 20:17–20:19 上 222
- 升级前备份 `pre-r47-20260915-201741.dump`；in-place 升级退出 0；后端/nginx 健康 OK；维护门 WIRED；包 gitSha == main；后端 dist 含 `outcomeValues`/`resolveWritebackStatusValue`、前端包含 `resultWritebackOutcomeValue-` 与 `visibilitychange` 字面量（提示级，权威是 gitSha）；定时 dry-run 0；pm2 online；9 条 False 与 r46 相同（已知良性）。
- **#5748 铃铛**：打开 bom备料 → 铃铛徽标 1 → 面板列出 1 条 `notification.sent`（r46 上为「暂无通知」）。
- **#5751 轮询**：打开「字段」管理弹窗，20 s 内 fields/context 共 4 次请求（开弹窗 1 对 + 15 s 保活 1 对；修复前约 20 对），关闭后 0。
- **#5752 映射**：先把演示字段「审批状态」的选项从 approved/rejected 改为 已通过/已驳回（同步那条记录的值）；打开规则 A 编辑器出现「审批结果 → 写入值」块，且因选项集不含原文 approved 而正确给出阻断「请在下方选择要写入的选项」；选 已通过、勾选「非通过结果也写回」、选 已驳回后阻断消失，保存成功，DB `actions[0].config.resultWriteback = {statusField, onNonApproved:true, outcomeValues:{approved:已通过, rejected:已驳回}}`。端到端：记录 → 待审批（20:22:08.9）→ AP-100002 pending → 审批中心驳回（必填原因）→ 20:22:43.00 实例 rejected → 20:22:43.03 记录写回「已驳回」→ 规则 B 通知 1 条。规则 A 的执行记录为 failed「Approval completed with rejected」，这是既有设计（非通过结果终止后续动作链），写回仍按 `onNonApproved` 完成。
- 顺带观察：客户自建的「测试」规则（当记录更新时 → 发送通知，无收件人）每次记录更新都失败一次（现 15 次），属既有配置问题，未动。

### 3.2 r48（main `59d1eac2c` = r47 + #5753 + #5754），2026-09-15 22:08–22:10 上 222
- 备份 `pre-r48-20260915-220804.dump`；两条迁移（提交表、`multitable:submit-approval`）执行成功；upgrade 退出 0；健康 OK；后端 dist 含提交服务与路由、前端包含送审入口 testid；探针：表与四个索引存在（含部分唯一 `uniq_mt_record_approval_in_flight`）、admin 已授权限码；dry-run 0；pm2 online；9 条 False 同前。
- **阶段二端到端（记录 rec_bb72a248…，`bom备料`）**：
  1. 抽屉 kebab 出现「送审」→ 对话框只列已发布模板「备料送审示例」→ 选中后渲染 说明/备注 → 提交 → toast「已送审 AP-100003」；DB 提交行 `pending`，`record_version_at_submit=2`，快照非空，绑定真实实例。
  2. 展开抽屉「审批」面板：模板 id / 待处理 / 编号 / 申请人 id / 送审时间（名称 join 留 2a 后续）。
  3. 改一格（审批状态 → 已通过）→ 面板显示「送审后数据已变更（1 个字段）」。
  4. 审批中心通过 AP-100003 → 22:11:59.22 提交行 `approved`（同事务写入申请人通知，`record_id` 有值）+ 规则 B 通知 1 条；回到抽屉面板状态芯片「已通过」，铃铛徽标 4。
  5. 在途唯一：再送审得 AP-100004（前一条已终态，部分索引放行）；紧接着第三次送审被拒，对话框内提示「该记录已在此模板审批中。 AP-100004 查看审批」。随后在审批中心通过 AP-100004 收尾。
- 截图：r48-01 送审对话框、r48-02 面板待处理、r48-03 面板已通过、r48-04 409 提示。

## 4. 过程发现与教训

- 主检出本地 `main` 落后 origin/main 三周（e89f3e15e vs 28d11496b），在那里读代码与派只读诊断会得到旧代码/错行号；已快进并记忆化（读前 ff-only）。
- 只读地图 + 批评者比直接写设计更可靠：三条硬约束（§1 末）任何一条漏掉都会让阶段二返工。

## 5. 未完成 / 交接

（24 小时结束时填写：在飞 PR、未上 222 的合并、待 owner 拍板项、下一步建议）
