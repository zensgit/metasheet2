# 对标钉钉考勤·余下开发 总目标池 + 排序 + 并行车道 — 2026-07-08

> **owner goal（2026-07-08）**:以对标钉钉考勤的余下开发为总目标池,固定节奏、可并行、每刀设计+验证 MD、
> 按难度自动选模型(Fable5 触额度墙 → 授权用 Opus 4.8;机械跑量待 Sonnet 7/12)、owner 不在场全自动。
>
> **基线**:origin/main @ `8ec4da2a1`。**三路审计**(账本档位 × refresh v3 阶梯 × **代码实证**)。
> ⚠**审计方法红线**:tracker 的"回填注记"多为过时快照(30 处 🟡 中 28 处已实际 ✅);tracker 本身停在 06-26
> 严重落后代码。**一切以 origin/main 代码实证为准**,注记只作历史。

## 0. 审计结论:真余量很小,但有"假配置"缺陷

账本 §1/§2/§3 档位内能力**已 100% 闭环**(MUST×6 / SHOULD×5 / OPTIONAL×3 全 ✅,H3-3a 全 staging-proven)。
refresh v3 的 7 候选也**基本被吃干净**。真余量 = **3 个"半接线/假配置"缺陷 + 4 项能力 + 1 组 operator 门 + 记账债**。

## 1. 排序（价值×风险×车道独立性）

### T0 — 假配置 / 半接线（**是缺陷,不是缺能力;最该先修**）

| # | 项 | 证据 | 车道 |
|---|---|---|---|
| **S1** 🔥 | **`overtimeBankPolicy` 的两个旋钮零强制**:`maxMinutesPerPeriod`(每周期上限)/`validityDays`(额度有效期)只存在于默认值+FE 表单+zod+测试;引擎 `partitionOvertimeBankGrantLots` 只读 `enabled`+`pooledSources`。管理员配了**什么都不发生**;且 `validityDays` 与**真旋钮** `compTimeFromOvertime.expiresInDays` 静默冲突(两个过期开关) | `index.cjs:253-254`(仅默认)、`:10520-10555`(引擎只读 enabled/pooledSources)、`:219-223`+`:12467`+`:21664`(expiresInDays 才是真旋钮)、FE 表单 `AttendanceView.vue:3018/3030` | A(index.cjs) |
| **S2** | **`requirePhoto` 不可上线**:已有默认值(`:195`)+归一化(`:13245`),但线上 zod `punchPolicy.outdoor`(`:21631-21643`)只收 `requireApproval/requireNote/approvalFlowId` → 外勤照片存证配不了 | 同左 | A(index.cjs) |
| **S3** | **年假计提无定时触发**:引擎+run provenance 齐全,但唯一入口是手工路由 `POST /api/attendance/annual-leave-accrual/run`;`AttendanceScheduler` 只注册 3 个 job(unscheduled-reminder / comp-time-expiry / notification-delivery),**无 annual-accrual job** | `index.cjs:41820`;`AttendanceScheduler.ts:367/384/403` | B(services) |

### T1 — 能力补齐（车道独立,可并行）

| # | 项 | 依据 | 车道 |
|---|---|---|---|
| **S4** | **通知渠道 SMS / 企业微信(WeCom)**:adapter seam 干净,现有 `DingTalk*` + `Email*` + `Fake*` 三实现;refresh v3 判定"唯一文件级独立 → 最安全并行首选" | refresh v3:29/47 | B(新 adapter 文件) |
| **S5** | **报表 xlsx 导出**:xlsx **只进不出**(导入用 SheetJS,导出仅 CSV);PDF 零命中 | `AttendanceView.vue:1384/18298`、`importXlsxConvert.ts` | C(FE) |
| **S6** | **批量改余额**(bulk balance edit):批量处理异常已落 #3543、排班 bulk-apply 已落 #3642,**余额侧批量往返** grep 0 | refresh v3:68 | A+C |
| **S7** 🔒 | **A2 审批人 resolver**(direct_manager/dept_head/多级上级):**内核 `ApprovalAssigneeResolver` 已 LIVE**,但 plugin-attendance 零引用,且 zod(`:24357` 无 passthrough)与 normalize(`:20194`)两层静默丢弃未知键 → `direct_manager` step **端到端不可表达**。⚠**owner 明确 gated**:等看过 A1 live 手感再拍 | `index.cjs:20183-20197/20242-20256/20432-20442/24357` | A(index.cjs) |

### T2 — 需 design-lock 的行为变更 / 大 arc（本轮不启）

- **§3.1 打卡自动切外勤**(状态驱动兜底):FE 一半已落 #3580,**行为改动半边 owner deferred**。
- **#2 员工自助统一入口**:refresh 判 🟢高,但代码实证 **PARTIAL(缺口已缩小)**——统一 select 已含 6 类。开工前须重新核缺口。
- **#8 后半 多段夜班 + 多午夜**:🟢高(三班倒/制造/医疗刚需)但 **~3-5 周、最热核、碰撞面最大、refresh 明确"冻结"**。不进本轮。

### 🚫 OUT 红线（§6,不碰）

算薪(走 SaaS)/ 防作弊 / 人脸·AI 拍照 / 原生 App / 插件市场 / WiFi·蓝牙·设备围栏(需原生或硬件)。
**澄清**:服务端 `punchPolicy.geoFence` 经纬度围栏**已实现并 staging 实跑**(#2308);红线禁的是自研原生/硬件级围栏与设备绑定。
弹性工时 / 核心工时 / 排班模板克隆 / 多门店实体表 / 极速打卡 / 上班前推送:**账本未列**,属新增能力,须 owner 立项后另起。

### 👤 owner / operator 门（不占我车道）

五连 staging smoke(**MP-6 / HMR-5 / AE-4 / RD-4-5 / OT-bank v1-8**,harness+runbook 全备)· **E4 真机**(#3843)· 档 B 治理门。

### 📒 记账债

tracker 停在 06-26 严重落后;§2 对账表缺行(未排班打卡策略、§0.5 四项 RT/TA/销假/NS 未回填)。→ **S8 tracker refresh**(docs 车道,可并行)。

## 2. 并行车道图（按文件碰撞面切;车道内串行,车道间并行）

```
车道 A  plugins/plugin-attendance/index.cjs   S1 → S2 → S6(后端半) → [S7 🔒 owner-gated]
车道 B  packages/core-backend/src/services/*  S3 → S4(新 adapter 文件)
车道 C  apps/web/src/views/AttendanceView.vue S5 → S6(FE 半)        ← 与 A/B 并行,车道内严格串行
车道 D  docs/                                 S8 tracker refresh     ← 全程并行
```

## 3. 固定节奏（每刀）

design-lock(RATIFIED) → 实现 → **opus 对抗审阅 0 P1/P2** → 三红线(fresh-green + up-to-date,auto-merge + Monitor 自愈)→ **验证 MD** → 账本回填。
模型:设计/审阅/实现 = Opus 4.8(Fable5 额度墙);机械跑量(如 token B2-B6)待 Sonnet 7/12。

## 4. TODO（🔒gated ⬜待办 ✅完成）

- ⬜ **S1** overtimeBankPolicy 两旋钮落地强制(含 `validityDays` vs `expiresInDays` 优先级裁决)— **首刀**
- ⬜ **S2** requirePhoto 进 zod + runtime
- ⬜ **S3** 年假计提 scheduler job
- ⬜ **S4** SMS / WeCom 通知渠道 adapter
- ⬜ **S5** 报表 xlsx 导出
- ⬜ **S6** 批量改余额
- 🔒 **S7** A2 审批人 resolver(owner 明示等 A1 live 手感)
- ⬜ **S8** tracker refresh(记账债)
- 🔒 T2 三项(§3.1 / #2 入口 / #8 后半)· 🚫 OUT 红线 · 👤 五连 smoke + E4
