# 一键卡片自助配置 + UI Foundation 地基波 · 设计与验证 MD — 2026-07-07

> `/goal`「以开发方案/TODO MD 为总目标池，固定节奏开发，完成后给出设计及验证 MD」的本波收官交付。
> 覆盖两条线共 **8 个 PR**，全部已落 main。锁文档 as-built 状态随各自 PR 同步翻转，无口径漂移。

## 1. 本波落地总览

| # | PR | 内容 | 实现/审查 |
|---|---|---|---|
| 1 | #3690 | CFG-0 一键卡片配置设计锁（PROPOSED→后随 #3707 翻 RATIFIED as-built） | Opus |
| 2 | #3693 | CFG-1 密钥/URL 解析器：env 优先、stored 加密兜底、fail-closed | Opus / 对抗审阅 APPROVE + 变异 2/2 |
| 3 | #3698 | CFG-2 生成端点（admin-gated、不回显）+ **wipe-trap 修复** | Opus / 对抗审阅 APPROVE + 变异 3/3 |
| 4 | #3707 | CFG-3 设置页 UI（生成按钮 + chip + 重生成确认 + URL 栏）+ 锁 as-built 翻转 | Sonnet 实现 / Opus 审查（ElMessageBox 硬化） |
| 5 | #3696 | UF-0 UI foundation 设计锁（RATIFIED） | Opus |
| 6 | #3697 | UF-1 token 地基：tokens.css + EP 变量映射（唯一主色 #2563eb） | Fable 实现 / Opus 审查（error 色族补映射） |
| 7 | #3706 | UF-2 PageShell/PageHeader：9 个审批视图统一页壳 | Sonnet 实现 / Opus 审查（委托管理命名一致化） |
| 8 | #3710 | UF-3 StatusTag + 状态域表：6 套状态色实现收敛为 1 | Sonnet 实现 / Opus 冲突 rebase + 审查 |

## 2. 一键卡片自助配置线（CFG）设计要点 as-built

- **解析次序不变式**：`APPROVAL_CARD_LINK_SECRET` env 优先 → `directory_integrations.config.
  approvalCardLinkSecret`（encrypted-secrets 解密）→ 空即 fail-closed（不发卡/不验签，绝无兜底密钥）。
  **签验同源**由「env 优先、否则同一 stored 行（active 优先、updated_at 最新）」保证。
- **密钥永不出后端明文**：生成 = 服务端 `randomBytes(32)`，即时 `normalizeStoredSecretValue` 加密落库；
  一切响应/审计/集成摘要只带 presence 布尔（`valuePrinted:false` 纪律同 Agent-ID）。
- **wipe-trap（本波揪出的真缺陷）**：通用集成表单保存按白名单**整体重建** config JSONB，会静默抹掉
  专用端点写入的键 → 在途卡片链接全体失效。修复 = `updateDirectoryIntegration` carry-through
  （密文原样携带、绝不解密）。**推广规则：今后任何绕过通用表单写入 directory_integrations.config
  的新键，必须同步加 carry-through。**
- 写面防御：URL http(s) scheme 白名单（DB 访问之前拒绝）；PUT 缺 `publicAppUrl` = 400（清空须显式 `""`）。
- **对 A-5 的影响 = 零**：env 已设时行为字节级不变；A-5 UAT 现在可全程页面完成（生成密钥 + 填对外地址）。

## 3. UI Foundation 地基（UF-0..3）设计要点 as-built

- **UF-1 token**：`styles/tokens.css` 为唯一色/距/圆角/字阶真源；EP `--el-color-{primary,success,
  warning,danger,error,info}` 全族（light-3/5/7/8/9 + dark-2，按 EP mix 公式预算好写死）映射到
  `--ms-*`；`main.ts` 在 EP 样式后引入使覆盖生效——**一次性全站换装**（锁 §5 有意为之）。
  幽灵 `--ms-color-danger` 自此为真。
- **UF-2 页壳**：`PageShell`（narrow 800 / default 1200 / wide）+ `PageHeader`（标题/副标题/返回/
  actions/meta 槽）。**返回契约是承重设计**：`backTo` 直推路径 vs `back` 事件委托回视图既有 handler
  ——测试断言精确的 `router.push` 形状，naive 单模式设计会破坏。9 视图换装；ApprovalMetricsView
  从全铺获得标准容器；委托双页从无页头到有（管理面统一命名「委托管理」，含路由 titleZh 与入口按钮）。
- **UF-3 状态语义**：`statusDomains.ts`（approvalInstance/delegation/automationRun 三域，
  status → tone + zh/en）+ 无框架依赖的 `StatusTag`（颜色只取 CSS 变量，EP 表格与手写视图通吃；
  `data-domain/status/tone` 供测试）。治理：不 fork 状态逻辑——委托状态推导仍归 `delegationStatus.ts`、
  自动化文案仍读 `automationStatusLabel`。顺带修复两个真缺陷：收件箱状态裸文字无色、
  委托页状态不分 locale 恒中文。fail-safe：未知状态 → 中性色 + 原文。

## 4. 验证矩阵（全部在合并前完成）

| 层 | 证据 |
|---|---|
| 后端单测 | CFG 服务矩阵 17/17（加密写入、响应无 64-hex、scheme 白名单、env-override 报告）+ 路由门 32/32（403/404/400/审计脱敏） |
| 真库集成 | 全新库迁移后 CFG 闭环 9/9：生成→解析→签名→wrapper 验签 + **wipe 回归**；一键链既有 17 测在两种 secret 来源下全绿 |
| 变异证明 | CFG-1 2/2（空密钥拒绝、fail-closed catch）；CFG-2 3/3（scheme 白名单、admin 早退、carry-through 键）；CFG-3 2/2（确认门、no-echo tripwire）；UF-2 1/1（back 优先级）；UF-3 1/1（硬编码色守卫——并发现 jsdom 把字面 hex 归一化为 `rgb()`，守卫加固双拦） |
| 前端 | 每刀 `vue-tsc -b` 0 + 生产 build 绿；UF-2 312/314（2 失败为 main 既存病，stash 前后比对证明）；UF-3 post-rebase 联合守护集 413/413；CFG-3 视图规格 50/50 含 no-echo tripwire（DOM 永不含 64-hex/`enc:`） |
| CI 接线 | 新组件/规格按两点法接入 approval-web-guard / multitable-web-guard（多个文件此前无门） |
| 审查 | 两次独立对抗审阅（#3693/#3698）均 APPROVE、全部 NIT 当场修复；每刀 Opus 主循环把关 |

## 5. 流程事实与教训（不粉饰）

- **合并跑马灯**：strict required-checks + 并行会话高频推 main 下，#3698 曾 6 次全绿仍抢不到窗口；
  最终解 = rebase 至 0-behind + **服务端 auto-merge 瞬时触发** + admin 兜底循环。根治仍是仓库
  **merge queue** 设置（owner 一次性动作，未做）。
- **`git checkout -- <file>` 撤变异连带冲掉同文件未提交编辑**（已知禁令再犯一次）：损失三处编辑当场重做、
  全量复验无损。规则重申：撤变异用精确反向 Edit，永不用宽泛 checkout。
- **锁文档状态漂移**（owner 指出）：PROPOSED 锁合入后实现推进，closeout 前必须随收尾 PR 翻 as-built——
  本波 CFG 锁已按此收口，UF 锁随本 MD 同步翻转。
- 并行代理冲突治理：UF-2×UF-3 同视图并行，靠「各守区域 + 不重排未触行」约束把冲突压到 3 处，
  主循环亲手解（CI gate 取并集 / 保 UF-2 结构换入 StatusTag）。

## 6. 未尽事项（菜单，非分母）

- **进行中**：UF-4 自动化编辑器迁回 EP（Fable，两步：容器→控件，最大「两个产品感」修复）·
  UF-5 审批中心共享表格 · UF-3b approvalTemplate 状态域（UF-3 诚实标注的第 4 域缺口）。
- **其后**：UF-6 禁 inline-style + 硬编码色 lint（存量清完再上闸）→ UF-7 i18n 机制收敛 → UF-8 质感包
  （骨架屏/共享空态/`window.confirm` 清理/机器值名称化）。
- **owner 侧**：A-5 真实 DingTalk UAT（现可全程页面配置后按 U1-U7 实跑；跑通前不写「已验收」）；
  merge queue 仓库设置；T3-6 投影 per-row 可见性锁（#3687 PROPOSED，待 ratify + 选 A/B）。

---

**一句话**：本波把「一键处理卡片」从 SSH-only 配置推到管理员页面自助（密钥全程不见光），并给全站
UI 立起 token/页壳/状态语义三块地基——审批操作面从「功能达标、观感拼装」进到「一个产品」的底盘上；
剩余 UF 刀有主、按节奏出货。
