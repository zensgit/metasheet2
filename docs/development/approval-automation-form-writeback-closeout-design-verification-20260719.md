# 审批 / 自动化 / 表单回写 · 收尾设计与验证 — 2026-07-19（AS-BUILT · composite only）

> **范围纪律**：本文只陈述 **本 composite 工作树 HEAD 上的 as-built 代码**。  
> **不声明**：任何源 PR/源分支已 merge 到 `main`；任何 runtime flag 已在生产/默认打开。  
> **工作树**：`codex/grok-approval-composite-20260719`（从 `origin/main` 起按序合入已审刷新分支，本地 integration/rehearsal）。  
> **对照锁**：`approval-form-writeback-fwb0-designlock-20260712.md`（RATIFIED 设计契约）· `approval-attachment-pipeline-design-lock-20260709.md`（附件管线锁）。

---

## 0. 一句话状态

| 项 | 状态（本 composite） |
|---|---|
| Tree authoring（条件 + 并行画布 + publish 闸） | **代码在分支上** · 单元/real-DB 有证 |
| Template version history + safe restore | **代码在分支上** · restore 与 create/update 共享 authoring-definition 闸 |
| FWB-1/2/3 生产路径（create / update-bound / decision freeze） | **代码在分支上** · real-DB 有证 · **flag 默认 OFF** |
| Approval attachment lifecycle（upload/bind/download/GC） | **代码在分支上** · real-DB 有证 · **flag 默认 OFF** |
| 源 PR merge 到 main / 生产 enable | **未做**（owner-only） |
| #4450 linked-record multi-value fan-out | **未实现 / 未 ratify**（v1 恰一条，多值 REJECT） |
| 附件锁 rung-4 authorability + 退役 B2-28 strip | **未做**（须 owner ratify ON 后） |

---

## 1. 本 composite 合入内容（as-built 来源）

本 worktree 在 `origin/main` 之上 **本地** 合入（顺序与 rehearsal 一致；冲突按 **union** 解，尤其 CI allowlist / `run-required-web-tests`，不丢 test token）：

1. Tree authoring（`codex/approval-tree-authoring-v1-clean` 系）  
2. Template version restore（`codex/approval-template-version-restore` 系）  
3. FWB writeback（`codex/grok-fwb-writeback-*` 系）  
4. Attachment runtime（closeout rehearsal merge）  
5. Follow-up：`validateAuthoringDefinition` 把 create/update/**restore** 对齐（empty-rules + decisionFieldIds；`assertNoParallelDynamicAssigneeConflicts` 仍 **publish-only**）

**明确未做**：`git push` · merge PR 到 main · 改任何 flag 默认值 · 改 #4450 fan-out 语义 · 打开附件 authorability / 删 B2-28 strip。

### 1.1 Runtime flags（默认全部 OFF）

| Flag | 默认 | 作用 |
|---|---|---|
| `APPROVAL_FWB_RUNTIME_ENABLED` | **OFF**（仅 `'true'` 打开） | FWB 执行 + enabled 规则激活 |
| `AUTOMATION_DURABLE_DELIVERY_ENABLED` | **OFF**（FWB 生产路径另要求） | durable outbox/claim 同事务 |
| `APPROVAL_ATTACHMENTS_ENABLED` | **OFF**（仅 `'true'` 注册路由/生命周期） | 审批附件 upload/bind/download/GC |

测试可在 **本进程** 内临时置 `true`；产品默认与 staging enable 仍为 owner 闸。

---

## 2. 架构 as-built（本分支代码）

### 2.1 Tree authoring

- **FE**：垂直 flow canvas + topology 编辑（`apps/web/src/approvals/graphTopologyEdit.ts`、`parallelEdit.ts`、`conditionEdit.ts`、`TemplateAuthoringView.vue`）。  
- **BE publish/author 闸**（`ApprovalProductService`）：  
  - `validateConditionBranchRules` — 空 rules 条件支路禁止（vacuous TRUE）  
  - 嵌套 parallel 拒绝（引擎不支持）  
  - `assertNoParallelDynamicAssigneeConflicts` — **仅 publish**（可证明相同动态审批人跨支路）  
- **Runtime**：`ApprovalGraphExecutor` 条件路由 + parallel join（`joinMode=all|any`）；legacy 空 rules 支路 defense-in-depth 不匹配。

### 2.2 Template version restore

- **API**：`POST /api/approval-templates/:id/versions/:versionId/restore`（admin guard + optimistic `expectedLatestVersionId`）。  
- **语义**：总是新建 **draft** 版本；**不**切换 `active_version_id` / 在途实例仍钉 published definition。  
- **再校验**：`validateAuthoringDefinition(...)` 与 create/update **同一函数**（含 empty-rules、`decisionFieldIds`、assignee/perms/formulas/timeouts）。  
- **Publish-only** 闸（placeholder role、parallel dynamic conflict）**不**进 restore — 草稿可修后再 publish。

### 2.3 FWB create / update / decision

- **动作类型**：`write_approval_form_values`（automation action）。  
- **映射核心**：form field → target field，fail-closed coerce（`approval-form-value-mapping.ts`）。  
- **执行闸**：Q6 四闸 + confirmation hash（`approval-fwb-permission-gates.ts` / confirmation）。  
- **Create 模式**：同事务 claim（`meta_fwb_action_applied`）+ record + revision + outbox（D9/D10）。  
- **Update 模式**：`record-link` 服务端钉目标行；`FOR UPDATE` 竞态 fail-closed；行级读拒绝。  
- **Decision（FWB-3）**：`decisionFieldIds` 在 dispatchAction **approve** 路径冻结到 `approval_node_decision_values`（node + entry_epoch）；reject 不冻结；re-entry 新 epoch 新行。  
- **触发**：`approval.completed` / approved 完成事件 → automation executor（durable 路径）。  
- **幂等**：claim identity UNIQUE → redelivery `already_applied`，无二次业务写。

### 2.4 Attachment lifecycle

- **表**：`approval_attachments`（与 multitable_attachments **分离** — 授权/生命周期不共用）。  
- **路径**：uploader-owned unbound 上传 → `createApproval` 事务内 `bindAttachmentsOnSubmit` 冻结 form_snapshot ids → 参与者矩阵下载 → 隐藏字段 fail-closed → GC/reconciler 处理 orphan / infected / 过期 unbound。  
- **失败语义**：infected / foreign / GC-win race → **整单拒绝**，无悬挂 instance；不向 outsider 泄露存在/字节。  
- **Flag OFF**：路由不注册；create 路径不 bind（与锁一致）。

### 2.5 交叉边界（本 composite 修过的真实缝）

| 缝 | As-built |
|---|---|
| restore vs tree empty-rules | restore 经 `validateAuthoringDefinition` → `APPROVAL_CONDITION_BRANCH_RULES_EMPTY` |
| restore vs FWB decisionFieldIds | 同上 → unknown/unsupported decision field 在 REQUEST 上下文 `VALIDATION_ERROR` |
| FWB vs durable delivery | 执行要求 FWB flag + durable flag；缺一 fail-closed |
| attachment vs createApproval | flag ON 时 bind 同事务；flag OFF 不注册/不 bind |

---

## 3. 八场景验收地图（A1–A8）

权威入口文件：

`packages/core-backend/tests/integration/approval-automation-closeout-acceptance.realdb.test.ts`

| ID | 场景 | 本文件角色 | 既有 real-DB 整文件钉（CI 真跑） | 正控 / 负控要点 |
|---|---|---|---|---|
| **A1** | 复杂 authoring 接受并 round-trip 条件+并行 | **composed** create→publish→GET + empty-rules create 拒绝 | + `approval-wp1-parallel-gateway.api.test.ts` · `approval-common-template-presets.api.test.ts` | + condition rules/defaultEdgeKey + 全量 critical edges（order-normalized）+ parallel branch/join · − 空 rules 400 零写 |
| **A2** | 版本 restore 新 draft、保 active、拒非法历史快照 | **composed** 复杂图 restore + empty-rules restore 拒绝 | + `approval-template-authoring-uat.api.test.ts`（含 decisionFieldId / 合约漂移 / 并发 / lock-order） | + draft+active 不变 · − 400 零写 |
| **A3** | 通过 `write_approval_form_values` 建记录 + claim/record/revision/outbox 原子 | **static pin only** | `multitable-fwb-write-action-realdb.test.ts` · `multitable-fwb-production-e2e-realdb.test.ts` | + 同事务提交 · − rollback 擦除 / flag OFF / gate-fail 无 claim |
| **A4** | record-link 更新已有记录；权限/锁 fail-closed | **static pin only** | `multitable-fwb-runtime-modes-realdb.test.ts` · production-e2e record-link | + 可读正控 · − 权限撤销 / FOR UPDATE 竞态 |
| **A5** | 核定值按 node+epoch 冻结并回写；无 re-entry 重复污染 | **static pin only** | production-e2e approve+decisionData · runtime-modes epoch re-entry | + freeze 行 · − reject 不冻 · epoch2 新行 |
| **A6** | 同一完成事件 durable redelivery 幂等 | **static pin only** | write-action duplicate / concurrent · runtime-modes Q6 ack | + already_applied · − 双 ack 恰一成功 |
| **A7** | 清洁附件 upload/submit bind/download；hidden/outsider 拒绝 | **static pin only** | `approval-attachment-create-bind-realdb.test.ts` · `approval-attachment-participant-realdb.test.ts` · bind-reconcile | + clean bind · − outsider / hidden admin |
| **A8** | infected/foreign/stale-GC 不挂 instance、不泄字节/存在 | **static pin only** | create-bind infected/foreign · bind-reconcile foreign/GC race · `approval-attachment-gc-realdb.test.ts` | + clean 仍成功 · − 无 instance / 整单回滚 / live blob 不删 |

**诚实声明**：closeout 文件的 pin **不会** `vitest run` 其它文件；它只静态断言路径存在、标题仍在、且 **two-point CI wiring 未回退**。CI 通过 `vitest.config.ts` exclude + `plugin-tests.yml` whole-file list 分别执行各钉文件与本文件。

### 3.1 本 composite 已独立观测的验证数字（AS-BUILT · 非 full CI / 非 main merge）

下列数字来自本 composite 工作树上**已独立跑过**的证据；**不**声称 GitHub required full CI 全绿，**不**声称已 merge 到 `main`。

| 证据 | 结果 |
|---|---|
| Fresh full migrations（CI `MIGRATION_EXCLUDE` 纪律） | **pass** |
| Real-DB 相关套件（本 closeout 地图覆盖面） | **9 files / 53 tests** |
| 变更面 backend units | **31 files / 346 tests** |
| 变更面 web specs | **17 files / 255 tests** |
| `packages/core-backend` `tsc --noEmit` | **clean** |
| `apps/web` `vue-tsc --noEmit` | **clean** |

### 3.2 精确 mutation 证据（fail-closed · 已观测 RED）

| Mutation | 预期 RED | 说明 |
|---|---|---|
| 从 `restoreTemplateVersion` 去掉 shared `validateAuthoringDefinition` 调用 | **3 restore negatives RED** | empty-rules / invalid decisionFieldId / 合约漂移 revalidation 不再 fail-closed |
| 将 S3 `AccessDenied` 错误分类成 `not_found` | **3 S3 tests RED** | 附件存储错误语义被冲淡 → 值自由/安全断言失败 |
| 关掉 create-time attachment bind（`createApproval` 路径） | **3 production real-DB tests RED** | clean bind 正控 + infected/foreign 负控依赖生产 bind 调用 |

### 3.3 其它闸证据（既有 suite · 不重编造）

- Tree：empty-rules create/publish unit · parallel dynamic conflict publish unit · FE topology/preserve specs。  
- Restore：UAT real-DB revalidation / IDOR / lock-order · routes unit · **shared `validateAuthoringDefinition`** follow-up。  
- FWB：mapping/gates/decision/runtime unit · 三份 real-DB · production-e2e flag-OFF 负控。  
- Attachment：schema invariants · create-bind · participant matrix · bind-reconcile · GC。  
- Closeout pin：**two-point wiring 静态断言**（exact quoted exclude + executable run-list line；comment-only / substring 不绿）。

---

## 4. CI two-point wiring（本 deliverable）

| 点 | 位置 | 要求 |
|---|---|---|
| no-DB exclude | `packages/core-backend/vitest.config.ts` | 每个 manifest primary/supporting 文件必须有 **exact quoted** exclude 条目 |
| real-DB run | `.github/workflows/plugin-tests.yml` | 每个文件必须有 **executable run-list line**（非注释、非子串） |
| 机器断言 | closeout acceptance static suite | `two-point CI wiring: every manifest file is no-DB-excluded AND on an executable real-DB run list` |

FWB/附件 real-DB 文件仍在 multitable real-DB step；authoring UAT / closeout / parallel-gateway 在 approval real-DB step。从 manifest 删掉某个 pin 文件的 CI 行 → closeout 静态 suite **必红**。

---

## 5. Owner-only 闸（本文 **不** 关闭）

下列项 **仅 owner** 可关闭；本 composite / 本文档 **无权** 代为 ratify 或 flip：

1. **Review + merge 源 PR 到 `main`**（本 worktree 仅为 rehearsal）。  
2. **Private ACL 前置**（FWB-0：受限字段回写目标表 = 显式解密；Q6 四闸与确认哈希在生产 enable 前必须按锁强制）。  
3. **DingTalk UAT**（卡片/投递实网，非本 composite 范围）。  
4. **Flag flips**（`APPROVAL_FWB_RUNTIME_ENABLED` · durable delivery · `APPROVAL_ATTACHMENTS_ENABLED`）— 默认保持 OFF。  
5. **#4450 linked-record multi-value fan-out** — 须单独 ratify；v1 仍「恰一条，多值整步 REJECT」。  
6. **Attachment lock rung-4**：authorability 打开 + 退役 B2-28 `stripAttachmentFields` / 禁用占位 — **仅在 owner 显式 ratify ON 且实现+验收后**。

---

## 6. 诚实缺口（不夸大）

| 缺口 | 说明 |
|---|---|
| A3–A8 未在 closeout 文件内重跑全套 fixture | 有意 pin；two-point wiring 测试挡住「从 CI 列表删文件仍绿」 |
| 单进程端到端「author complex → restore → FWB writeback → attachment」长链 | 未做（成本高、与 flag 隔离测试冲突）；交叉缝靠 shared validator + 分文件 real-DB |
| 生产 flag ON 实网 UAT | owner-only |
| Fan-out / authorability | 未实现 / 未打开 |
| 本文件 pin 标题漂移 | 静态 pin 会红；需同步改 manifest |
| Full GitHub required CI / main merge | **未声称** — 本文只记 composite 本地独立观测 |

---

## 7. 本地验证命令（rehearsal）

```bash
export DATABASE_URL=postgresql:///codex_approval_closeout_20260719
# migrate with the same MIGRATION_EXCLUDE discipline as CI when needed
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run \
  tests/integration/approval-automation-closeout-acceptance.realdb.test.ts \
  tests/integration/approval-template-authoring-uat.api.test.ts \
  --reporter=dot
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm --filter @metasheet/web exec vue-tsc --noEmit
```

（FWB/附件全量 real-DB 仍按既有 suite 在 flag 临时 ON 的测试进程内跑。）

---

## 8. 结论

本 composite 把 **tree authoring · version restore · FWB · attachment** 的 as-built 代码与 real-DB 证据收口到可复查的 A1–A8 地图，并修了 restore 与 create/update 的 authoring-definition 漂移。  
**收尾完成 ≠ 可上线**：merge、private ACL 运营、DingTalk UAT、flag ON、#4450、附件 rung-4 仍全部挂在 owner 闸上。
