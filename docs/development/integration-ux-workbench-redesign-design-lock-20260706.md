# 数据工厂(集成)页面 UX 重排 — DESIGN-LOCK(RATIFIED)— 2026-07-06

> **状态:RATIFIED(owner 审阅 APPROVE 2026-07-06,P2 补写后拍板 ratify/merge)。**
> 本文锁原则与切片阶梯,不实现任何代码。
> 背景:数据库及系统连接线能力面已收官(integration-line-final-closure-report-20260706.md);
> owner 提出体验目标——让用户操作界面简单方便,并考虑帮助面。本 lock 基于 2026-07-06 全量 UI
> audit(见 §1 事实基线)。

## 0. 三条产品原则(锁定)

1. **任务向导化**:用户带着任务来("接一个系统、读一张表、组一条链"),页面按任务的自然步骤展开
   (选系统 → 定形状 → 试跑验证 → 提交审批),而不是按我们的配置模型平铺字段。多阶段流程用
   `el-steps` 显式呈现,当前步只露当前步的字段。
2. **渐进披露**:默认视图只露高频必填面;JSON/高级字段折叠进"专家模式"区(保留,不移除——
   顾问用户仍需要);机器码(coarse error codes)永不裸渲染,一律经人话标签层。
3. **状态卡片化**:列表页以卡片 + 状态芯片(连接健康 / 审批状态 / 最近运行结果)承载,一眼可扫;
   空状态即引导(这是什么 + 第一步做什么)。

## 1. 事实基线(2026-07-06 audit,file:line 证据)

```text
IntegrationWorkbenchView.vue = 5992 行单页;原生 input×24/select×22/button×49/textarea×6,el-* 仅 19
IntegrationK3WiseSetupView.vue = 2451 行;input×52
IntegrationReadSourceConfigPanel.vue = 581 行,0 el-*;S1→探测→审批流程 = 散文 <p>
design token 违规:Workbench 0 个 var(--ms-*) / 142 硬编码 hex;K3 页 0/107(UF-1 锁明文:新增 hex=缺陷)
PageShell/PageHeader:三个集成视图 0 使用;el-tooltip 0;el-steps 全 app 0
裸 JSON textarea ×5(连接 config/watermark 映射/字段选项同步/样例记录/目标模板)
coarse 码裸渲染:probeEvidence.errorCode / deadLetter.errorCode 原样大写枚举
i18n:集成词汇零 label 模块(仅机器码集);帮助面:零(无 tooltip/无文档链/无帮助页)
/data-sources 路由为孤儿(不在全局导航)
仓内范本:approval/TemplateAuthoringView.vue(PageShell+el-card+el-form+v-loading)
         attendance AdminCenter+Rail(大管理区 = rail + 分区,反单页怪物)
```

## 2. 切片阶梯(每片单独 opt-in;✅=完成 ⬜=ratify 后可执行 🔒=前置未达)

```text
✅ IU-1 错误码人话化 + 证据展示层 — #3743(26d8cd1f0),verification MD 同 PR:
     46 码人话化(probe 11/resolver 9/组合 8/BOM 族 8/死信 10),4 展示点接线;raw errorMessage
     泄漏口全数消除(含审阅点名的死信处 + 额外发现的 K3-setup 处);client mirror 补齐 BOM 族
     + drift tripwire;Workbench/K3-setup spec 首进 CI + Node-20 调度兼容修复;mutation 4/4
     coarse-code → 人话 label 模块(READ_SOURCE_PROBE_* / RESOLVER_* / K3_WISE_BOM_LIST_* /
     dead-letter 码全集;走既有 useLocale 模式新增集成 label 模块,zh+en);
     probe/组合证据块用标签渲染,机器码保留在折叠详情里(排障需要)。
     **覆盖 errorCode + errorMessage 双面**(owner 审阅 P2,2026-07-06):标签层只消费**精确注册
     闭词表**;未知 code 显著层降级为通用"未知错误"标签(折叠详情仍可见原始 code——code 属注册
     闭集,安全);**raw errorMessage 一律不渲染**(任何层,含折叠),只允许映射为安全原因/固定
     文案——当前 Workbench 直渲 deadLetter.errorMessage 属须消除的泄漏口。
     spec=Fable → 实现=Sonnet;不改任何路由/服务/wire 形状。
⬜ IU-2 Workbench 解构(结构性主刀,零行为变化)
     5992 行单页 → PageShell + 左 rail + 分区组件(镜像考勤 AdminCenter 模式):
     连接管理 / 读取源 / 组合 / 清洗映射 / 运行与推送 / 监控与死信 六区;
     全部原生控件 → tokenized el-*(消灭 142 hex);孤儿 /data-sources 并入或挂导航。
     纯重排:services/*.ts 与后端 wire 零触碰;integration-guard CI 面保持覆盖。
🔒 IU-3 读取源配置向导(门:IU-2 落地)
     平铺 581 行 panel → el-steps 四步:①选系统 ②定读取形状(preset 卡片选择,非下拉)
     ③探测试跑(证据卡片化)④提交审批;专家模式折叠区保留原字段全集。
🔒 IU-4 组合配置向导(门:IU-3 落地)——两跳链的可视化步骤(hop1 输出 → hop2 输入连线示意)。
🔒 IU-5 JSON textarea 逐处结构化(门:IU-2 落地;每处单独评估)
     5 处裸 JSON 各配结构化编辑器;专家 JSON 模式保留切换。
✅ IU-6 嵌入式帮助三层 — #3750(8493b7fe8),verification MD 同 PR:
     7 空态引导 + 19 字段 hint(独立模块供 IU-2 复用)+ /help/integration 帮助中心
     (错误码对照表程序化消费 IU-1 模块,单一来源 tripwire);双 Node 181 测试绿;
     mutation 4/4(闸内补 zh 文案覆盖)
     a. 空状态即引导(每列表空态 = 这是什么 + 第一步);
     b. 字段级 hint(el-tooltip,复用 runbook/dev-verification 已有知识,values-free);
     c. /help/integration 帮助中心页:何时用读取源 vs 组合、错误码对照表(消费 IU-1 的
        label 模块,单一来源)、常见排障 FAQ。内容从既有 MD 提炼,不新造口径。
```

## 3. 硬锁(全切片有效)

- **零行为变化**:UI 切片不改路由契约、service 层 wire 形状、权限门(`integration:write`)、
  后端任何面;integration-guard CI 定向 spec 持续覆盖。
- **token-only**:新样式一律 `var(--ms-*)`(UF-1 锁);图标走 Element Plus SVG(P1a/P1b 模式)。
- **values-free 展示纪律**:帮助文案与错误标签不得内嵌业务值示例(物料号/BOM 号等);示例一律
  占位符形态。**标签层只消费精确注册闭词表;未知码降级为通用未知标签;errorMessage 只允许映射为
  安全原因/固定文案,raw message 永不显示**(owner 审阅 P2:只翻译 code 而放行 raw message 会留下
  更大的泄漏口)。
- **专家能力不降级**:JSON 专家模式、机器码详情、全字段面全部保留(折叠≠删除)。
- **外部对标分析不入正式文档**:本 lock 只声明自有原则;对标材料留 /tmp 或 docs/research。

## 4. 模型分派

| 件 | 分派 |
| --- | --- |
| IU-1 label 模块 spec / IU-2 解构切分设计 / 各片对抗审阅 | Fable 5 主循环 |
| IU-1 实现 / IU-2 机械迁移(section→组件、hex→token)/ IU-6a/b | Sonnet 5 agent(worktree)+ 质量闸 |
| IU-3/IU-4 向导交互设计 | Fable 5 设计 → Sonnet 5 实现 |

## 5. 验收(每片双 MD)

每片交付 verification MD:改动清单、el-*/token 覆盖率前后对比(hex 计数归零曲线)、
integration-guard 面通过、关键交互 Playwright/jsdom golden(向导步进、错误标签渲染、专家模式切换)。

## 6. 边界

不做:移动端适配、暗色模式专项(token 体系自带)、新能力面、后端改动、导航信息架构全局重排
(仅集成入口内);均需另立项。
