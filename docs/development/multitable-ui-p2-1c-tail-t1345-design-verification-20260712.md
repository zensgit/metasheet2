# 多维表 UI-P2-1c tail(#3866)· T1/T3/T4/T5 实现与验证记录(2026-07-12)

**类型**:实现与验证记录(docs-only,零 runtime,可自验)。承接 owner 的两步走指令(第一步批 12 把 design-lock,第二步只开一条 runtime 车道 = #3866 Lane-A tail),记录 tail 五档中 **T1/T3/T4/T5 四档的落地**;**T2 按 owner 护栏 HOLD**。

**前置**:tail 设计锁 `multitable-ui-p2-1c-tail-resolution-designlock-20260707.md` 于 **2026-07-11 RATIFIED**(owner batch-ratify 指令,12 把锁机械执行 + origin/main 逐把对账)。

---

## 1. owner 的两条护栏(逐条执行记录)

1. **12 锁落地后先对账**:12/12 全 MERGED、header 逐把确为 RATIFIED、零 stale-PROPOSED 残留、`#3814` dup 仍 CLOSED、无漏合无漏翻 → **对账通过后**才开 tail 车道。
2. **T2 必停**:开工前先读 MtButton 变体面 = `primary | ghost | danger`,**无 plain/tinted** → T2(soft-tinted create)**HOLD 等 owner 选 A/B/C**,不许实现自己发明样式语义。**本轮零 T2 触碰**。

## 2. 落地台账(4 PR + 1 冲突 union,全 MERGED)

| 档 | PR | 内容 | 审 |
|---|---|---|---|
| **T1** batch-1 | #4130 | LinkedRecordPopover / MentionPopover / BulkEditDialog 的 close-× → MtIconButton | 独立 Opus subagent 门禁(限额前最后一个) |
| **T1** batch-2 | #4133 | ExportDialog / ConfigHistoryModal / ConditionalFormattingDialog 的 close-× | 主循环 Opus 亲审 |
| **T3** | #4131 | **新原语 MtLink** + 4 处 link-styled 迁移(ExportDialog select-all/clear · FilterGroup add-condition/add-group · NotificationBell mark-all · ViewManager __btn-inline 的 2/4) | 主循环 Opus 亲审(锁要求 Opus 审前置) |
| **T4** | #4140 | **behind-flow mock harness**(`tests/helpers/mount-behind-flow.ts`)+ TrashModal / FormShareManager 通用按钮 | 主循环 Opus 亲审(红线重点) |
| **T5** batch-1 | #4143 | MetaApiTokenManager **22 个 `__btn` sharer 全迁** + close-× | 主循环 Opus 亲审(stateful 语义重点) |

## 3. 各档的关键判断(审阅实证)

### T1 — 「零视觉变」是失实契约,已订正
batch-1 门禁抓出:MtIconButton 把 × **归一到 icon token 尺寸(14px)+ control-height 方块**,3 个 header 各长高约 12px。**但该观感在 main 已有先例**(batch6 #4099 的 Calendar ‹/› 导航、BasePicker +,同为 glyph-slot MtIconButton),故是**延伸已审观感、非新造**(P3 非 P2)。措辞全部订正为 **token-normalized**,batch-2 起沿用(0 处 "zero visual change")。

### T3 — MtLink 的「发明语义」疑点:提出后被基线推翻
亲审初见 MtLink 的 `font-size: 12px` / `line-height: 1` / `white-space: nowrap` / disabled `opacity: .5`,疑为**实现发明锁未定义的样式语义**(owner 红线)。**核对基线后推翻**:已在 main 的 **MtButton 原语本身**就是 `font-size:13px` / `line-height:1` / `white-space:nowrap` / disabled `opacity:.5` / 同款 token focus-ring——MtLink 是**照抄既有原语惯例**;且 `12px` 恰好**精确保住**三处原链接(`.meta-export__link` / `.meta-filter-group__add` / `.meta-notif-bell__mark-all` 原本都是 12px)。锁的「token 化」在本仓既有实践中指**颜色**走 `--ms-*`(MtButton 的 px 亦硬编码)。
**教训:先验既有原语基线,再喊「发明」。**

### T4 — 红线(删除面 / 访问控制面)逐行核验
- component diff **只有 tag swap + class/type + import + 注释,script 块零逻辑改动**。
- **TrashModal**:唯一命中 confirm 的是 **cancel** 按钮(`@click="confirmingId = null"` 逐字节保留);真正的 `.meta-trash__restore`(撤销删除)**根本不在 diff 里**。
- **FormShareManager**:**Regenerate(轮换公开 token)+ Clear-expiry(移除有效期)未迁**,保留原 class + CSS;迁走的 Copy/Preview **主动摘掉该 class** → 无 double-styling、无孤儿。

### T5 — 「22 sharer 无 stateful toggle」:专门证伪,声明成立
本档最大风险是 toggle 的 active 态映射。证伪结果:
- `data-webhook-toggle` / `data-dingtalk-group-toggle` **无 `:class` active、无 `aria-pressed`**,只有**标签文案**随状态变(与 copy/copied 同形)→ 确非 pressed-state affordance,全走锁 step (a) `MtButton`,step (b) 用不上。
- **真正有 active 态的是 tab 按钮**(`meta-api-mgr__tab--active`,**不同 class**)——**diff 零触碰**,且 tab 本就不在 Lane A(tab ≠ button,归 P2-2 结构刀)。
- 红线相邻按钮(revoke/delete)的 `@click` + `:disabled` + `data-*` + **`v-if="canMutateDingTalkGroup(group)"` 权限守卫**全部逐字节保留。

## 4. 门禁纪律的诚实记录(容量事件)

**2026-07-11:Opus subagent 池撞周限额(resets Jul 13 7am PT)**,而 Sonnet 实现代理仍可用(已探测,非假设)。影响:
- #4130 是限额前最后一个**独立 adversarial-reviewer subagent 门禁**。
- **#4131 / #4133 / #4140 / #4143 的对抗审由主循环 Opus 4.8 亲审**(非作者——代码由 Sonnet 代理写),**不是独立 subagent 门禁**。照 #3945 先例,**每个 PR 上都明确标注请 owner 加倍审**,并提出 Jul 13 后可补独立门禁。
- 亲审并非橡皮章:T1 的失实契约、T3 的「发明语义」疑点(提出后自我推翻)、T4 的红线逐行核、T5 的核心声明证伪,均在亲审中完成。

## 5. 落地力学

热 main + strict + enforce_admins:多 PR 同 arm 会互抢绿窗饥饿。**本轮抓到一个自伤 bug**:heartbeat 里「看到全绿就 sync」——但 `update-branch` 会重跑 8 分钟 CI,下一轮又看到绿又 sync,**等于自己不停重置 CI、饿死自己的 PR**。修正为:**REST poke-then-query 判真 `behind` 才 sync**(`clean` 让 auto-merge 收、`blocked` 让 CI 跑完),并对末尾几个 PR **串行聚焦**(一次只顶一个)。修正后立刻连落。

## 6. 剩余(全部 owner-gated)

- **🔒 T2 soft-tinted create**(Gallery/Kanban/Timeline 的 `#ecf5ff` 底 + `#2563eb` 字)——**等 owner 选 A(给 MtButton 加 plain/tinted 变体,锁推荐)/ B / C**。MtButton 现无对应变体;不许实现自行发明。
- **T1 剩余批次**:仍有 close-× 分布在其它 dialog/manager(部分需 T4 harness 挂载)。
- **T5 剩余批次**:MetaRecordDrawer 等其它 shared-class manager。
- 以上均可在 owner 给 T2 决定后与 T2 一并排期;**不主张 tail「完成」**——完成的是 T1/T3/T4/T5 的首批 + T3/T4 的一次性基础设施(MtLink 原语 / behind-flow harness)。

## 7. 本文不主张什么

- 不主张 tail 五档已全部完成(T2 未动、T1/T5 有剩余批次)。
- 不主张 #4131/#4133/#4140/#4143 经过了**独立 subagent** 对抗门禁(它们是主循环 Opus 亲审,已在各 PR 标注)。
- 不主张任何权限/删除/AI 逻辑被触碰——恰恰相反,红线逐行核验为零触碰。
