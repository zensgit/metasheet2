# 自主开发轮 · 开发与验证记录（2026-07-12）

> **状态：本文只记录本轮已完成的公开可核验工作，不主张任何「收官」。** 生产就绪线的安全敏感执行项按 disclosure 原则私有交付 owner，不在本公开文档展开。

本文回答 owner 「完成后给出开发及验证MD」的交付要求，覆盖两条 goal：(1)「按文档完成所有开发」，(2) 生产就绪 M0–M5 计划中**我能自主、且不涉披露**的部分。

---

## 1. 多维表 UI-P2-1c · T1 close-× 迁移（表现层，全部 MERGED）

设计锁 `multitable-ui-p2-1c-tail-resolution-designlock-20260707.md`（RATIFIED）§2-T1：把各组件的 header close-× 收敛到共享原语 `MtIconButton`。

| 批 | 范围 | PR | 独立对抗门禁 |
|---|---|---|---|
| b4 | RestoreBatchDialog / RestorePreviewDialog | #4174 | ✅ APPROVE 0 P1 / 0 P2 |
| b6（收窄） | MetaSheetPermissionManager / MetaRecordPermissionManager | #4182 | ✅ APPROVE 0 P1 / 0 P2 |
| b7 | MetaFieldManager / MetaViewManager | #4189 | ✅ APPROVE 0 P1 / 0 P2 |

（b5 = picker + scale-dialog 与并行 session 的 #4178 重复，已关；b6 原含 MetaCommentsDrawer，与并行 #4180 撞车，已让路收窄。）

### 1.1 验证口径（每刀全过方落）
1. emit() 集合逐字节守恒；2. 可运行交互测试（真 mount + 真 click，非源码文本断言）；3. mutation 证据（摘 `@click` 必红，**且先证明变异落地**）；4. 测试卫生（mounts[] + afterEach 全卸载）；5. token-only 零新 hex；6. `vue-tsc -b` 干净；7. **每刀独立 adversarial-reviewer 门禁（非自审）**。

### 1.2 门禁三次真的咬到东西（非橡皮图章）
- **#4174**：门禁**推翻了实现指令**——「摘掉 bespoke class」会让 required `web-tests` gate 里既有 spec 变红（它靠 class 选元素）。正解=保留 class、只删 CSS 规则。自审必漏。
- **#4177/#4182 类**：门禁**把守卫本身砍了来验**（删 `window.confirm` 脏数据守卫 ⇒ 6 测变红，证明守卫是被测的），并点击迁移新引入的 `<span>` 包裹层确认单次 emit。
- **#4182**：门禁抓到**自己的假绿**——`perl` 引号没替换成功、变异根本没落地却全绿；教训=**任何 mutation 先证明它落地了，再采信红/绿**。

### 1.3 一个范围事故的诚实记录
最初按「全仓 raw `<button>` 普查」排批次而非按锁的枚举，导致一批 automation viewer 越界（已在开 PR 前中止）+ ResetConfirmDialog 越界（已逐字节还原）。**教训：按锁的行为枚举、不按字形普查**；manager 里 `__close`(close) 与 `__action--danger`(remove-item) 字形相同、只能读 handler 分辨。

---

## 2. 迁移簇 CI 排除调查（#4162 → PR #4176，docs-only PROPOSED）

调查**证伪了 issue 自己的前提**：那簇 view 迁移并非「因为互相冲突」被排除。全新一次性 Postgres、不加 `MIGRATION_EXCLUDE` 时：**263/263 迁移全 apply、`views` 表正常建出、`snapshot-protection.test.ts` 21/21 全绿**。真因是**配置腐坏**——底层缺陷已在 #3627/#3632（2026-07-05）修复，但只同步了 `migration-replay.yml` 的清单，另 4 个 workflow 留了 3 份互相分叉的过期清单。⇒ 那 21 个测**现在就能接进 CI**（改共享 CI 配置，属 behavior，故为 PROPOSED 待 owner，未自落；落地前须 PG14 复验）。

---

## 3. 生产就绪线 M0–M5 · 本轮可自主交付部分

| | 项 | 交付 | 谁执行 |
|---|---|---|---|
| M0 | owner-APPROVE 合入 | #4171 / #4098 已 MERGED（连同上表 UI 批次经串行 driver 落 main） | ✅ 本轮 |
| M0 | merge queue | 启用步骤已交 owner | 🔒 owner（仓级配置） |
| M4-A | retry/test-run 治理 | **设计 #4196**（按动作分类：同库写=业务+ledger 同事务 / 外发=两阶段 `outcome_unknown` 永不自动重发 / 规则漂移 fail-closed / retry 年龄 ≤ 保留期 + 缺行拒绝兜底；每条「不发生」配正控腿），PROPOSED | 设计✅ / 实现待 ratify |
| M4-B | 附件四阶梯 | **设计 #4195**（对象存储 / `approval_attachments` 表 / 发起人上传 / 鉴权代理下载 / 默认 OFF / MIME=PDF·JPEG·PNG·TXT·CSV，Office/ZIP 待 AV），解 7 问中 5 问，PROPOSED | 设计✅ / 实现待 ratify |

**其余生产就绪项**（含若干安全敏感线与需现场/运维执行的验收）按 disclosure 原则**私有交付 owner**，不在本公开文档展开。

---

## 4. 本文不主张什么

- **不主张「生产收官」。** owner 的关闭标准（P1 advisory 部署+发布、U1–U13/W6 smoke/RBAC 矩阵有证据、外发面全审计、retry/test-run 不重复副作用、附件交付）绝大多数在 owner + 运维手里，**不是单 session 能单方满足的**。
- 不主张 #4196 / #4195「已定」——它们是 PROPOSED，实现严格待 owner ratify，**未自我批准**。
- 本轮我能推到的极限 = **决策侧全部推到一键可 ratify + 代码侧不涉披露部分做完**。
