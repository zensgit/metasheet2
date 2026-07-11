# 连接器/体验模板目录(connector & experience template catalog)— DESIGN-LOCK(PROPOSED,实现排在 BA-apply / W2 之后)— 2026-07-08

> **状态:PROPOSED。docs-only,本文不授权任何实现。**
> **排序硬约束(owner 2026-07-08)**:本线是**产品化价值**(product-ization),
> **排在 BA-apply 或 W2 之后;不是收尾必需**。作为数据库及系统连接线收官后
> (`integration-line-ux-ba-completion-report-20260707.md`)4 条后续优先线中的**第 4 条**,
> 其实现门 = 更高优先的 **BA-apply**(Bridge-Agent 配置受控 apply,完成报告 §5 第一项)与
> **W2**(写阶梯 dry-run 契约,W0 锁
> `integration-core-external-api-write-self-service-direction-design-lock-20260703.md`,#3515)
> **落地之后**才可逐级 opt-in(§4)。本文只锁设计,防止后续实现时重新裁量。

## 0. 问题(为什么要有模板目录)

连接线的能力面与体验面均已收官:读取源四步向导(IU-3,`IntegrationReadSourceWizard.vue` +
`readSourceModePresets.ts` preset 卡片)、组合三步向导(IU-4,`IntegrationCompositionWizard.vue`)、
Bridge-Agent 只读可观测/探测/校验(BA-UI-1..4)、错误码人话化(IU-1 `errorCodeLabels.ts`)、
字段 hint(`fieldHints.ts`)、帮助中心(`/help/integration`)全部在 main。

但每一次新接入仍从**空白向导**开始:用户先要自己判断"我这个场景是哪种系统 + 哪种读取形状 +
要不要组合",才轮到向导渐进披露帮他填。对最常见的几类接入(K3 WISE、遗留 SQL 库经
Bridge-Agent、通用 HTTP 读、两跳组合),这个"从场景到向导初态"的判断是**可以预先做好并命名**的
—— 这就是模板目录:把已验证的接入形态沉淀为**具名的、values-free 的、引导式配置起点**,
选中即预填向导,而不是从空表单开始。

## 1. 模板目录是什么(定位锁定)

**一个精选(curated、平台维护)的目录页**,列出预制的「连接 + 读取源 + 组合」**模板**。
每个模板 = 一个具名的、values-free 的引导式配置起点:

- 选中模板 → **预填既有向导**(IU-3 读取源向导 / IU-4 组合向导 / Bridge-Agent 分区)的
  初始状态(preset/mode 选择、必填字段清单、占位符示例),用户只补少量必填真实值;
- 配套一条 onboarding 引导流:**「选模板 → 填少量必填 → 试跑」**——"试跑"就是既有的
  定位容器探测(probe)/ values-free 一键探测(BA-UI-2),**不新增任何执行路径**。

v1 模板候选集(目录内容,非新能力;全部映射到已存在的 kind / mode / 分区):

| 模板(示意) | 预填目标 | 映射的既有基元 |
| --- | --- | --- |
| K3 WISE WebAPI 读取源 | IU-3 向导 | kind `k3-wise-webapi` + 四 mode preset 卡片之一 |
| K3 WISE SQL 读取通道(高级) | IU-3 向导 | kind `k3-wise-sqlserver`(沿用 2026-05-12 advanced-connectors 锁的"高级连接默认隐藏"口径) |
| 遗留 SQL 库(Bridge-Agent 只读) | Bridge-Agent 分区 | kind `bridge:legacy-sql-readonly` + BA-UI-1..3 观测/探测/校验 |
| 通用 HTTP 读取源(单记录/列表/主从/解析定位) | IU-3 向导 | `READ_SOURCE_MODES` 四值,复用 `readSourceModePresets.ts` 卡片 |
| 两跳组合(读→解析→读) | IU-4 向导 | 既有 composition service,固定两跳形状 |

目录本身**不引入任何新连接种类、新读取模式、新组合形状**;上表若与实现时的 main 有出入,
以 main 上的 kind/mode 集合为准(模板集合是 main 能力的**子集投影**,永不超集)。

## 2. 复用不重建(结构锁定)

**模板 = 既有向导 + preset 基础设施之上的展示层/配置元数据。零新后端,零新 runtime。**

- 模板是一个 **values-free 的配置种子(config seed)**:它描述"向导应该以什么初态打开",
  不描述"如何执行"。执行、校验、探测、审批**全部走既有路径**
  (`readSourceConfigs.ts` / `readSourceCompositions.ts` service、S1 校验、probe 路由、
  save + approve 审批路径、BA-UI 探测)——一条都不新增、不旁路。
- 与 `readSourceModePresets.ts` 同构:该模块已确立"**展示层映射、非新契约**"的范式
  (卡片一一映射既有 mode 值、`requiredFieldKeys` 直读真源 `READ_SOURCE_MODE_REQUIRED_FIELDS`
  永不手抄、mode 集合 tripwire 未配卡片即红)。模板目录是同一范式向"整个接入场景"的推广:
  模板一一映射既有 {kind × 向导 × preset} 组合,必填字段清单直读各自真源。
- 向导不感知模板的存在方式 = **初态注入**:模板选择产生的向导状态,必须与用户手动点选
  同一 preset/mode 所到达的向导状态**完全一致**(见 §5 round-trip 验收)。向导内部逻辑、
  步进、字节等价不变量(IU-3/IU-4 锁)零改动。

## 3. 目录条目契约(数据形状锁定)

一个 typed 模块(风格同 `readSourceModePresets.ts` / `errorCodeLabels.ts`:zh+en、
values-free、编译期 tripwire),每条目:

```text
{
  id                 稳定标识(kebab-case,如 k3-wise-webapi-single-record)
  title              { zh, en } 模板名
  oneLiner           { zh, en } 一句话说明(描述读取/接入的"形状",不含业务值)
  seedsWizard        'read-source' | 'composition' | 'bridge' —— 预填哪个既有入口
  seed               预填内容:preset/mode 选择 + 占位符形态的示例值
                     (占位符 only,如「示例:单据编号形如 XX-000000」;
                      禁真实 material/host/tenant/库名/凭据/URL 值)
  requiredFieldKeys  该模板必填字段清单 —— 直读对应真源常量,永不手抄
}
```

硬性口径:

- **values-free**:目录所有文案、示例、种子值只允许占位符形态;凭据永远不出现
  (连"示例凭据"都不允许——凭据仅后端持有,沿 BA 锁 §1 原则 2)。
- **单一真源**:目录**消费**既有 typed 模块(`readSourceModePresets.ts` /
  `errorCodeLabels.ts` / `fieldHints.ts` / i18n label 模块),**不得**另建一套重复的
  标题/说明/必填字段词汇(multitable i18n 线"helper 不得跨模块重声明"同纪律)。
- **token-only**:目录 UI 骑 UF token,零 hex;zh+en 全量。

## 4. 排序与阶梯(governing constraint;本文授权为零)

```text
TC-0 ✅ 本 design-lock(docs-only,授权任何实现 = 无)
TC-1 🔒 目录数据模块 + 目录页(卡片列表,选中→预填向导)
        门:owner ratify 本锁 + 【BA-apply 与 W2 两线均已落地】+ TC-1 单独 opt-in
TC-2 🔒 onboarding 引导流(选模板→填少量必填→试跑,骑既有 probe/BA-UI-2)
        门:TC-1 落地 + 单独 opt-in
TC-3+ 🔒 任何扩展(新模板条目批次、目录内搜索/分类等)——各自单独 opt-in
```

- **实现门 = BA-apply 与 W2 之后**。owner 原话口径为「排在 BA-apply 或 W2 之后;不是收尾
  必需」;本锁取**保守读法**作为阶梯门:两条更高优先线(BA-apply、W2)**都落地之后**,
  TC-1 才可被 opt-in。若 owner 届时明示"其一落地即可",以 owner 明示为准——但**默认不抢跑**。
- 本文**不授权** TC-1..TC-3 中任何一级;每级是**单独的、之后的、显式的 opt-in**
  (staged opt-in lineage 纪律)。
- 排序理由照录:模板目录是让"已经能做的事更好上手"的产品化价值;BA-apply(把 BA-UI-3 的
  变更建议变成受控落地)与 W2(写阶梯 dry-run)是能力面缺口,收益/风险排序在前。

## 5. 验收计划(TC-1/TC-2 实现时的 verification MD 必含项)

1. **模板→向导 seed round-trip golden**:对每个模板,选中后向导初态(步进位置、preset/mode
   选择、展开的必填字段集、占位符文案)与预期**逐字段断言**;且与"用户手动选同一 preset"
   到达的向导状态**深等价**(证明模板只是初态注入,不是第二条配置路径)。
2. **values-free 扫描**:目录全部文案/种子/示例过 values-free 扫描(禁真实 material/host/
   tenant/库名/凭据/URL 模式);sentinel 测试断言占位符形态,DOM 层复证(BA 线双证同法)。
3. **单一真源 tripwire**:模板集合覆盖断言(每个模板的 kind/mode 必须存在于 main 的真源
   集合;真源新增 mode/kind 而目录未决策收录时**不红**——目录是子集;但目录引用了不存在的
   kind/mode 必须**编译期/import 期红**,`readSourceModePresets.ts` throw 同法);
   `requiredFieldKeys` 与真源常量深等价断言(禁手抄漂移)。
4. **零后端变化证明**:TC-1/TC-2 的 diff 不含 `plugins/` 路由/契约/migration 任何改动;
   既有向导 spec(`IntegrationReadSourceWizard` / `IntegrationCompositionWizard` 及各 Panel
   spec)存量断言零改动(stub 增加可,断言语义改动不可——IU 线同纪律)。
5. **CI 面**:新增 spec 进 integration-guard union(单行 vitest,警惕重复 run: key 静默丢
   spec 的既往事故);Node 20 + 默认双绿。

## 6. 非目标(锁定)

- **不是 marketplace**:无第三方投稿、无评分/分发/安装语义;目录由平台随版本策展维护。
- **不是客户自建模板**:v1 无"另存为模板"/租户自定义模板;那是独立的后续线,需自己的
  design-lock(涉及租户数据进模板 = values-free 边界的全新论证)。
- **不是新 runtime / 新连接器**:不新增 adapter kind、读取模式、组合形状、执行/审批路径;
  不碰凭据模型;不含任何写路径(写自助化 = #3515 轨,本线只在其**之后**排队,不掺入)。
- **不改向导**:向导交互骨架、字节等价不变量、专家模式保留均维持 IU-3/IU-4 锁原样;
  模板只做初态注入。
- 不做移动端、不做目录内试跑历史/统计(观测面已有 BA-UI/monitoring 分区,不重复)。

## 7. 模型分派(实现解锁时)

| 件 | 分派 |
| --- | --- |
| 本锁 / 模板集合裁量 / 文案信息架构 | Fable 主循环 |
| 目录模块 + 目录页 + 测试(TC-1)、引导流(TC-2) | Sonnet agent + 质量闸(mutation 逐守卫) |

## 8. 处置

PROPOSED,docs-only。**本文授权任何实现 = 无**;不授权目录模块、目录页、引导流、任何
后端/契约/runtime 改动。实现按 §4 阶梯,**统一排在 BA-apply 与 W2 落地之后**,每级单独
opt-in。
