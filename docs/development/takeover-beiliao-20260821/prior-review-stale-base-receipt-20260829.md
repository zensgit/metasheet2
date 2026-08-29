# 对《七条主要问题》的基线核验回执(2026-08-29)

> 结论:**七条中 1/2 为 STALE-BASE,3/4 审的是贵方自己的未提交 WIP 而非我方交付,5 半数为 v1.2 自身的条件项,6 为已登记 owner 待决,7 有效保留。** 全部核验对着 `origin/main` 与 PR 分支逐条做过,证据行号如下。此回执同时是 REVIEW-BASE 纪律的第三次触发记录:该清单未声明基线 SHA。

| # | 裁定 | 证据 |
|---|---|---|
| 1 K3 围栏"未实现" | **STALE-BASE** | 四层围栏在 PR #5247(`a4b9cc14b`+`0d8c8953c`):HTTP 凭据剥离 peek → `applyExternalWrite` 首语句 → `writeRows` choke → adapter `upsert` 先于 `login`;11 亲见 RED,全移除基线 SAVE=1 链表;旧 PoC 已改造为围栏证明(mock 全程 0 Save/0 Submit/0 Audit)。合并序列进行中 |
| 2 B2a"完全缺失" | **STALE-BASE** | 全部在 PR #5248:`assertB2aReadAuthorization` 四入口(BOM/C6/runner/sealed-snapshot,先于凭据解密)、v1.2 §6.1 全字段、operation claim、`B2A_*` 全码、R-05/R-06/E3 扩展;39 亲见 RED。排 #5247 后合 |
| 3 PR-A"进程内 Map 锁、query→patch→create" | **审错对象:引用行是贵方 WIP 的 `RECONCILE_LOCKS`** | 已合入 main(`b6c0241d6`)的 PR-A:**迁移 077 持久租约**(scope_key PK,INSERT-acquire+CAS-steal),无租约 fail-closed 501;main 上唯一 `new Map()` 是 `byStableKey` 分组变量(:529);A-04 = 双独立 reconciler → active=1 |
| 4 PR-A"越界:全类入账、三动作开放、FE 暴露 cancelled" | **同上,描述的是贵方 WIP 的行为** | main 实况:`FIRST_CUT_CONFLICT_TYPE='duplicate_expanded_key'` 仅此一类(:106,:23-24);`accept_current`/`manual_hold` 被 `CONFIRMATION_DECISION_ACTION_UNIMPLEMENTED` 定码拒绝(:667);**PR-A 零 FE**——`confirmationDecisions.ts` 在 main 零命中,该文件在贵方工作区 |
| 5 E1/E2/E3 未闭环 | **E3-01 在 #5248;E1/E2 是 v1.2 自己的条件项** | v1.2 §7.1/§8:E1 仅 sandbox 写授权后需全件,E2 仅真实审批启用后;二者 T-E1/T-E2 均 Proposed 且不在 B2a-DRY-ENGINEERING 门内(§15.3)。runner 旁路定码拒绝(armed)与 E3-02~05 证明/守卫在 #5248 |
| 6 客户入口仍挂九张 MVP 表 | **事实成立,定性应改** | "不启用九表"约束新确认面的存储——PR-A 合规(新账本零依赖九表)。`/stock-prep` 工作台存废是**既有 owner 待决**(采纳/退役/parked),不是本波违规;请并入该决策而非 P1 清单 |
| 7 前后端权限不一致 | **有效,保留** | main 无确认 FE,故当前无"看得见点不动";此条转为**贵方确认 FE 的合入条件**(页面权限与 admin 路由对齐,或路由降为专用词表——从属 R-11) |

**流程请求**:P0 两条请按 REVIEW-BASE 纪律改标 STALE-BASE 并对着 `sec/k3-save-permanent-fence` / `feat/b2a-registry-guard` 分支(或合并后的 main)重审;3/4 请撤回;另请今后复核件首行声明 `REVIEW-BASE: <sha>`——这是双方在收敛审阅里共同立的规矩,本回执方过去两轮同样被此纪律纠正过,规矩对双向生效。
