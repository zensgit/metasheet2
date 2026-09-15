# 第六次 24 小时自主开发：设计与验证记录（2026-09-15 18:05 → 2026-09-16 18:05）

授权原话："接下去24小时我不在电脑前，你能帮我持续不间断的开发么？并根据代码难度来选择模型，完成后给出设计及验证MD"。
前置拍板（同日 17:5x，"按建议执行"）：#5741 归审批窗口；阶段二四项默认；顺序 #5742 → #5743 → 阶段二后端 → 阶段二前端；夜间上 222。

状态图例：✅ 合并/完成 ｜ 🟡 进行中 ｜ ⛔ 阻塞/放弃 ｜ 📝 待 owner

## 0. 结果一览（随时更新）

| # | 项 | 模型 | PR / 产物 | 状态 |
| --- | --- | --- | --- | --- |
| Q0 | 铃铛计数 1 / 面板「暂无通知」（顺手，演示记录 §5.4） | 主会话 | #5748 | 🟡 CI |
| Q1 | #5742 写回 outcome→选项映射（`resultWriteback.outcomeValues`） | opus 实现 / opus 反驳 / fable 裁判 | wt-fe6 `fix/automation-writeback-outcome-values` | 🟡 流水线 |
| Q2 | #5743 管理弹窗 1.2 s 轮询 | opus / opus / fable | wt-flabel `fix/multitable-dialog-meta-poll` | 🟡 流水线 |
| Q3 | 阶段二后端：记录级送审（提交表、路由、权限码、耐久消费者 v2） | opus / opus / fable | wt-p5 `feat/multitable-record-approval-submit-backend` | 🟡 流水线 |
| Q4 | 阶段二前端：抽屉送审入口、对话框、审批面板 | opus / opus / fable | wt-base3 `feat/multitable-record-approval-submit-frontend` | 🟡 流水线 |
| Q5 | componentSpec 中文名「组件规格」 | 主会话 | 222 字段改名（模板已有 labelZh） | ✅ |
| Q6 | 阶段二设计稿 | 主会话（基于 4 代理只读地图） | `multitable-approval-phase2-record-submit-design-20260915.md` | ✅ 草稿 |
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

（每项合并后补：CI 泳道、变异证据、222 上机标记（按 gitSha 与文件哈希）、实测步骤与时序）

## 4. 过程发现与教训

- 主检出本地 `main` 落后 origin/main 三周（e89f3e15e vs 28d11496b），在那里读代码与派只读诊断会得到旧代码/错行号；已快进并记忆化（读前 ff-only）。
- 只读地图 + 批评者比直接写设计更可靠：三条硬约束（§1 末）任何一条漏掉都会让阶段二返工。

## 5. 未完成 / 交接

（24 小时结束时填写：在飞 PR、未上 222 的合并、待 owner 拍板项、下一步建议）
