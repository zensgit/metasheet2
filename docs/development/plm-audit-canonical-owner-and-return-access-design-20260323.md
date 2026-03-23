# PLM Audit Canonical Owner And Return Access Design

## Context

`PLM Audit` 的前端状态已经收口到 canonical route、team-view followup/share-entry ownership 和 scene return path 三条合同上，但这轮排查又暴露出三个同类缺口：

- Team views 本地下拉可以漂移到新的 view，而 `Apply filters` / `Reset filters` / 分页以及 shared-entry dismiss 仍然直接读取本地 draft state，导致这些动作会把未提交的 selector 或筛选草稿同步进 canonical route。
- generic team-view controls 只看 `route.teamViewId`，进入 default-change log route 后它会变成空字符串，于是页面仍被 collaboration followup 所有时，用户只改本地下拉就能把 `Share / Set default / Delete / Archive / Rename / Transfer owner` 指到错误对象。
- `returnToPlmPath` 会被 team-view route 和 log route 显式保留，但返回按钮绑死在 scene banner 里；只要 scene banner 被 handoff 清掉，返回链就失去页面入口。

## Goals

- 让 filter/navigation 和 shared-entry marker consumption 只改变它们应该改变的 canonical route 字段。
- 让 generic team-view controls 在 log route 里也继续锁定到真正拥有当前页面上下文的 canonical owner。
- 让 `scene -> audit -> save to team/default -> return to original scene` 这条链在 scene banner 消失后仍然可达。

## Design

### 1. Canonical management target

新增 canonical management target resolver：

- 优先使用 `route.query.auditTeamView`
- 当 route team-view 为空但 collaboration followup 仍然拥有当前页面时，回退到 `auditTeamViewCollaborationFollowup.teamViewId`

generic controls 的 disabled state 和 action guard 继续只依赖一个统一 target，不再把“是否在 log route”当成特例分支写进页面层。

### 2. Canonical route sync ownership

筛选和分页动作继续使用本地输入框里的 draft filters，但 `teamViewId` 一律回退到 canonical route owner，不再把本地下拉 selector 当成已提交状态。

`shared-entry` dismiss / takeover 的 query cleanup 则直接使用 `parsePlmAuditRouteState(route.query)`，只消费 transient `auditEntry=share` marker，不顺手把本地 query draft、selector draft 或 scene draft 写回 URL。

### 3. Persistent return CTA

新增一个纯 helper 来判断何时展示稳定的 return CTA：

- `returnToPlmPath` 非空
- 当前没有 scene banner 可以承载同一个动作

页面顶部在这种情况下显示 `Return to scene` 按钮；scene banner 在存在时继续显示原有按钮，不产生双入口。

## Files

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewControlTarget.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditReturnToScene.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewControlTarget.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditReturnToScene.spec.ts`

## Non-Goals

- 不改后端 API、OpenAPI、team-view persistence contract。
- 不改变 scene metadata 或 `returnToPlmPath` 的保留策略。
- 不为 selector draft 增加新的临时 store；继续复用现有 route/apply 语义。
