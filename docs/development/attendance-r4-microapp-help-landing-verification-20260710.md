# R4 + 微应用帮助落地验证（合并稿素材）— 2026-07-10

## A. R4：未绑定钉钉收件人终结为 skipped（PR #3920，MERGED `d642b819d`）

> DingTalk hardening 线 R4（roadmap audit finding 3.E-P2）。缺陷：无 dingtalk 绑定的收件人 delivery 落终态
> failed，把「结构性不可达」与「真实故障」混在同一计数里。本刀分类为 skipped。

### 对抗审阅（opus，refute-first）
审阅 MD：`/tmp/pr3920-r4-review-claude-20260710.md`（head `6209710fd`）。判定 **APPROVE-with-hardening：0 P1 · 0 P2**。

- **核心疑点被彻底反驳**：「真实故障会不会被吞成 skipped？」——三个分类器（DingTalk/Config/Email）+ 两个 catch
  块全部 `retryable:true`/绝不 skip；`skip:true` 仅 3 处（fake channel + not_bound + external_user_id_missing），
  全部结构性且 `retryable:false`；worker 只在 `!retryable && skip` 才路由 skipped——即使未来某 channel 误返
  `retryable:true+skip:true` 也会先重试后落 failed。skipped 是终态（claimDueDeliveries 不再捞）。
- **mutation 双刀承重**：①neuter worker skip-routing → 集成 2 failed（两处 runBatch 断言精确翻转）②去掉
  not_bound 的 skip:true → 单测 1 failed。均还原后绿。
- 实跑：新鲜迁移库集成 6/6 + 单测 22/22 + 邻居 2/2；CI 15 checks 全绿。
- **P3-1（post-merge 硬化，已入池）**：rows.length===0 分支混淆「用户未绑定」与「org 整体无 active 集成」——
  后者应 retryable 以便集成恢复后自愈。非回归（改前同样终态 failed），排 S4 后小刀。

## B. 钉钉微应用配置帮助页 + E4 operator guide（PR #3966，MERGED `64312e255`）

> codex 车道产物。名义 docs 实含 runtime FE（新路由 + AttendanceDingTalkMicroappHelpView.vue 375 行 + 目录页
> 入口链接）——按「self-merge line: doubt is the answer」房规改道 opus 对抗审。

### 对抗审阅
审阅 MD：`/tmp/pr3966-microapp-help-review-claude-20260710.md`（head `7f66b7f2c`）。判定 **APPROVE-with-hardening：0 P1 · 1 P2 · NITs**。

- 安全面核过：新路由 `requiresAuth: true` 经 beforeEach 守卫实测拦截；页面纯静态、无 API、无凭据；
  真凭据（CLIENT_SECRET）已脱敏；4 张 redacted PNG 逐张肉眼验证（唯一瑕疵 = h5-home 图 AgentId 2 位尾数外露，
  非凭据不可重建，接受）。
- **合并前修复（`4c40d0881`）**：①P2-1 标题 docs→feat（runtime FE 不该走 docs 型）②新租户 corpId 全部占位化
  （`<NEW_TENANT_CORP_ID>` 等——公开库卫生，corpId 非凭据但系首次落库的新标识符）③guide §2 字段名与帮助页
  对齐（新版控制台「端内免登地址/HTTP 可信域名/Webview 可信域名」+ 旧称括注），消除 PR 内三方命名分歧。
- 未采纳项：mount 冒烟 spec（静态帮助页，NIT 级，留后续）；#3989 runbook 旧称字段（已合历史文档，不回写）。

## C. 本波账本位点

- E4 真机 smoke 的 operator 备料自此齐全（#3989 runbook + #3966 帮助页/guide）——E4 本体仍 owner 门
  （钉钉开放平台注册 + env 开关）。
- R4 落地后 DingTalk hardening 线 backlog 又清一项；余 H04/05/07/OPS-01..05/PERF-01（另一目标池管辖）。
