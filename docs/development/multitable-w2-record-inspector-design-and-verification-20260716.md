# 多维表 W2 · 统一记录检查器 — 设计与验证记录(2026-07-16)

**类型**:波次收官记录(设计 + 验证台账,docs-only,零 runtime)。
**范围**:W2「记录工作区」的统一右侧记录检查器全实现(S1–S7)+ 本 goal 周期内配套的 correctness/术语/名称投影工作。前序 W0/W0-1/W1 台账见 `multitable-line-w0-w2-design-and-verification-20260715.md`(#4307=`84008b5ce`)与 `multitable-w0-trusted-substrate-design-and-verification-20260714.md`(#4254),本文衔接、不重复。
**治理基线**:RATIFIED 设计锁 = `multitable-w2-unified-record-inspector-design-lock-20260714.md`(owner round-3 PASS,§6bis 八项裁决);每刀独立 Opus 对抗门禁,verdict 绑 exact head SHA,任何 rebase 付 content-zero 或 mutation re-gate;arm 前查 owner review。

---

## §0 一句话

W2 把「记录右缘三个抢位组件」(MetaRecordDrawer 三合一 + 第二个 MetaCommentsDrawer + 权限 modal)统一成**单一 MetaRecordInspector 四 tab 壳**(字段/动态/评论/附件),drawer 退为 deprecated 兼容薄壳;**七刀全落 main、每刀 mutation-proven**;安全关键的附件掩码合同与响应式互斥经构造攻击验证。**最后一刀:OD-W2-5a(R11 回链 badge)a-read-through 进行中**——依赖 `restored_from_version` 早由 #4124 落 main(初稿误判已勘误,§5),owner 2026-07-16 授权直接 GO。

---

## §1 落地台账(S1–S7,全 MERGED,每刀独立 Opus 门禁)

| 刀 | 内容 | merge SHA | 门禁硬点 |
|---|---|---|---|
| **S1** | 抽 `MetaRecordFieldsPanel`(drawer details 主体行为等价) | `e2d0a009d` | token-set 零丢 + 冻结基线 20 spec blob 一致 + masking mutation |
| **S2** | 抽 `MetaRecordHistoryPanel`;helper hoist 去重(解 S1 NIT);恢复复用既有 preview 流 | `eef33bbe6` | LEAK-LOCK 掩码 mutation(changedFieldIds→Object.keys 泄漏)+ `props.visible` drop 结构安全(v-if 非 v-show) |
| **S3** | 新建 `MetaRecordInspector` 壳(tablist/头部/lock banner)+ 完整 ARIA tab pattern;drawer→deprecated 薄壳(OD-W2-7=b) | `ffad80b97` | arrow-scoping guard(panel-input 箭头不切 tab)mutation P2 补 golden;roving tabindex 恰一个 0;jsdom 双 keydown 监听 flake 根因定位+合并单根 handler |
| **S4** | `MetaCommentsPanel` 第 3 tab;收编第二抽屉(右缘单检查器);commentId 缺省(OD-W2-2=c) | `6186dcfdc` | G-8 scope 证 verbatim(scope compute/load/write 全在 diff 外);draft-discard 安全重测;三 mutation |
| **S5** | `MetaRecordAttachmentsPanel` 第 4 tab;**owner Medium-3 掩码合同** | `d891dc11e` | **安全关键**:迭代源 = `filterPropertyVisibleFields∩fieldPermissions.visible≠false∩type=attachment`;两负例(property-hidden/RBAC-denied)+ 正控;每条 bypass 构造(hidden-id key/orphan key/type-flip)失败 |
| **S6** | 恢复接线 = 既有 preview→dialog→execute(OD-W2-4=a) | (S2+workbench 覆盖) | 无残余:history 面板 emit `restore` → workbench `onRestoreRecordVersion`(:2214 `restorePreviewRecord`)已实现;Rev2 缩容「接线非迁移」满足 |
| **S7** | 响应式 768 互斥(OD-W2-6=b) | `42dc78e68` | 断点零分叉(`isInspectorOverlay`=`isRailNarrow` 别名);两 watch 互斥两向 mutation;桌面字节不变 mutation;both-open@≤768 不可达;真 Chromium Playwright(harness CSS byte-identical 防复制漂移);shared beforeEach isolation fix 每 shuffle seed 证正当 |

**PR 量 = 7**(S6 无独立 PR),落在 owner 估 6–10 内。

## §2 设计:一壳四面板 + 兼容薄壳

**为什么壳新建而非改 drawer**:今天 `MetaRecordDrawer` 是「壳+字段+历史」1163 行三合一;评论是**另一个抽屉**、附件散在字段内联、权限是独立 modal——右缘三处抢位。抽壳后:(a) 评论/附件面板作平级 sibling 挂进去(今天进不去);(b) 字段/历史成可独立测试的纯呈现单元;(c) `activeTab` 从二值扩四值由壳统一,ARIA tab pattern 一处补全。

**四 tab**(§6bis OD-W2-1=a):字段(常驻)/动态(历史+逐字段 diff+恢复发起)/评论(收编第二抽屉)/附件(聚合)。缺省 = 上下文(OD-W2-2=c:`commentId` 深链→评论,否则字段)。

**兼容薄壳**(OD-W2-7=b,含 owner barrel-export 勘误):`MetaRecordDrawer`/`MetaCommentsDrawer` 保 `index.ts` barrel export,内部委托到检查器/面板,`@deprecated` JSDoc + `{@link}`;真正移除待消费方核查的后续 major。

**恢复流**(OD-W2-4=a,Rev2 勘误):preview→dialog→execute **已是现状**;检查器**复用**、**不重实现、不新增 direct-restore 路径**——既有「禁 direct restore」测试绿。

## §3 三条安全/正确性承重线(每条构造攻击验证)

### §3.1 字段掩码 verbatim(S1/S2/S5)
掩码是承重的:历史 diff 迭代服务端 masked `changedFieldIds` 读 masked `patch`/`snapshot`——**移 verbatim,不「顺手」读 raw snapshot keys**。S2 的 LEAK-LOCK mutation(迭代源→`Object.keys(snapshot)`)泄漏 `TOP_SECRET`。

### §3.2 附件掩码合同(S5,owner Medium-3,最高安全刀)
迭代源 = **layer-2(property-hidden)∩ layer-3(RBAC field-mask)∩ type=attachment**,`filterPropertyVisibleFields`(与 workbench 同 helper)+ `fieldPermissions?.[id]?.visible !== false`(与 FieldsPanel 一致)。**禁枚举 `attachmentSummariesByField` keys**(keys 可含不可见字段=旁路)。两负例强制 + 正控非空。门禁额外构造:hidden-field-id summary key / orphan key / type-flipped field——**每条 bypass 失败,正控渲染**;key-enumeration bypass mutation 使两负例齐红、正控绿(非空性)。

### §3.3 G-8 评论可见性 verbatim(S4)
评论面板纯呈现,零 fetch;G-8 gating 在 workbench(scope compute/load/write)**全在 diff 外未动**;检查器喂已 gated 的 `commentsState.comments.value`,与旧 drawer 同。

## §4 验证方法学(不是绿了,是为什么信)

- **每刀 Opus 对抗门禁**,refute-first,verdict 绑 head SHA;rebase→content-zero(blob 一致 verdict carry)或 mutation re-gate。
- **mutation 全覆盖**:每条承重守卫「变异落地→红→复原→绿」;变异先证落地。
- **冻结基线纪律**:抽取刀前后既有 spec **byte-identical(blob SHA 比对)+ 绿**;retarget(mock import path)逐行裁定只改瞄准不弱化断言。
- **CSS 真浏览器**(house rule:jsdom 样式断言无效):P2-2c/S7 用 vite harness 挂真 tokens.css + Playwright `getComputedStyle` + 正控;门禁 diff harness CSS vs 组件源防复制漂移空转。
- **CI-mirror 全量**:每刀合前跑完整 `run-required-web-tests.sh`(S7 时 340 文件/4009 测试)+ vue-tsc;真库刀 fresh PG + CI MIGRATION_EXCLUDE。
- **HI-1 零新数据路径**:每面板 source-scan + fetch-monkeypatch,注入 fetch 必红。

## §5 最后一刀:OD-W2-5a a-read-through(owner 2026-07-16 授权直接 GO,进行中)

**⚠️ 勘误(owner 2026-07-16 驳回原盘点)**:本文初稿 §5 曾断言 `restored_from_version` 依赖「全库 0 命中、不在 main、在 #4339」——**全错,可证伪**。根因:我用 `grep -rln` **打了 canonical 工作树**(session-start 陈旧 detached HEAD `0ef106293`),而非 `origin/main`;`git fetch` 更新 ref 不更新工作文件。对 ref 正确核实:`git ls-tree -r 42dc78e68` 直接可见 `zzzz20260711000000_add_meta_record_revisions_restored_from_version.ts`,`git grep origin/main` 命中 11 文件。**该列 + 写 seam + 四处 version-restore 穿线 + History Center badge 早由 #4124(2026-07-11)落 main**;#4339 是 causal-seq(`meta_record_chain_seq`)另一回事、只是继承了它,**不是** OD-W2-5a 的 blocker。教训入 `feedback_verify_against_current_main_not_stale_base`(第三次同根因复发)。

**owner 裁决 = 直接 GO a-read-through,不需 owner 再决定、不需 #4339**。gap 只在**记录级读链 + 一个 FE 半连接**:
- 后端:`listRecordRevisions` SELECT 投影 `restored_from_version` → `RecordRevisionEntry.restoredFromVersion`(entry type 已声明该字段),复用现有 42703 `information_schema` 列探针 fallback(部署窗列缺→null 不 500)。
- FE 类型 + normalizer:`MetaRecordRevision` 加 `restoredFromVersion`;`normalizeRecordHistoryEntry()` 透传。
- **同刀修半连接**:`normalizeHistoryChange()` 现丢弃 `HistoryChange` 已带的 `restoredFromVersion`(base History Center 组件测试注入对象绕过 normalizer 故假绿)——补透传。
- 组件:`MetaRecordHistoryPanel` 复用现有 `restoredFromVersionBadge()`,**仅 `restoredFromVersion != null` 显示**。
- goldens 正负:API/client/component;**`source='restore'` 但字段 NULL 必不显示**(badge 只看 version 非 source)。

**状态**:a-read-through PR 进行中(owner 授权,本轮自主完成)。其落地后 §附录 A 补 a-read-through 验证台账、方为 W2 最终收官。**本文不主张 OD-W2-5a 已完成**——它是本线最后一刀,进行中。

## §6 owner-gated 残余(明标,不被「W2 收官」掩盖)

- **OD-W2-5a**:a-read-through 进行中(owner 授权,§5);非阻塞、非 owner 裁决项。
- **correctness 子线 C2/C3/C6**:v3.6 统一修订锁 PROPOSED(#4328),待 owner OD-V36-*(尤其 L4-0 canonical-fence 收敛——v3.5 fence 前提在 main 为假);C2 §7 裁决已录(#4325)。#4309 Draft/HELD 归其 session。
- **私有 comment-inbox authz 缺陷**:report-owner-only、独立 G-8 血缘 rung,待 owner 处置决定;公开面零机制披露。
- **field-undelete flag = HOLD**:tombstone 观察窗 + 非生产 flag-on smoke 待 owner 起表(批量前置 #4299 已落但不改 HOLD)。
- **follow-up docket(非阻塞)**:#71(#4330 P3 viewName/null 实库对称)· #72(inbox-link/badge 两无-token 蓝加设计系统 token)。

## §7 本文不主张什么

- 不主张 OD-W2-5a 已做(§5 a-read-through 进行中,明标);其依赖在 main 的勘误亦明标。
- 不主张 W2 锁被完整 ratify 超出 §6bis(那是 owner round-3 已裁的八项 + 设计;实现授权按刀)。
- 不主张任何 flag 开启 / C2-C6 已解 / 私有缺陷已修。
- 不主张「整条多维表线全部开发好了」——主张的是:**W2 检查器七刀开发侧完成且经对抗验证;剩余 = 一个依赖缺失刀 + owner 裁决/处置项**,逐条在案。
