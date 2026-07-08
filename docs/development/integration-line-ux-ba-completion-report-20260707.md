# 数据库及系统连接线 — UX + Bridge-Agent 完成报告 — 2026-07-07

## 0. 结论

owner「完成这条开发线的所有开发」mandate(2026-07-07)达成:能力面早已收官
(见 `integration-line-final-closure-report-20260706.md`,BL0→BL4 全 PASS),本轮完成**体验面
(UX 阶梯 IU-1..IU-6 + F)与 Bridge-Agent 可视化线(BA-UI-0..4)全部实现**。终态经三项收尾核验
(§4),对 final main HEAD 完整 integration-guard **34 files / 465 tests 全绿**(Node 20 + 25 双证)。

## 1. 交付账(全 MERGED)

> **PR 计数口径(对外引用请保留此拆法)**:本轮共 **17 个 PR** = **16 个功能 PR**(UX 阶梯 11:
> IU-1/2a/2b/2c/2d/3/4/5a/5b/6/F + Bridge-Agent 5:BA-UI-0/1/2/3/4)+ **1 个收尾报告 PR**(#3868,
> 即本文)。**不是 17 个功能 PR。**


### UX 阶梯(design-lock `integration-ux-workbench-redesign-design-lock-20260706.md`,RATIFIED)

| 片 | 内容 | PR |
| --- | --- | --- |
| IU-1 | 错误码人话化 label 模块 + 4 展示点 + raw errorMessage 泄漏口关闭 + client mirror 补 BOM 族 | #3743 |
| IU-6 | 嵌入式帮助三层(7 空态引导 + 19 字段 hint + /help/integration 帮助中心,错误码对照表程序化消费 IU-1) | #3750 |
| IU-2a | Workbench 壳:PageShell+rail 六组锚点+el-card 分区+hex 140→0+/data-sources 入导航 | #3770 |
| IU-2b | 分区抽取:monitoring/cleaning/mapping 3 组件(view -332) | #3794 |
| IU-2c | 分区抽取续:object-template/preview/connection 3 组件(view -403) | #3800 |
| IU-2d | run-push 分解:pipeline/stock-prep/external-write/table-actions/field-option-sync 5 组件(view -345) | #3822 |
| IU-3 | 读取源四步向导(preset 卡片 + 字节等价 + preset→mode tripwire + 专家模式保留) | #3821 |
| IU-4 | 组合三步向导(固定两跳接线示意 + 字节等价 + IU-3 语汇复用) | #3855 |
| IU-5a | JSON-assist(connection config/capabilities + sample/template;无回显校验 + 双路径 no-leak tripwire) | #3838 |
| IU-5b | optionSets 结构化编辑器(可重复行 + 专家 JSON 回退 + 字节等价 + malformed 不丢数据) | #3851 |
| F | K3 setup 页 token 化(107 hex→0)+ errorSummary 全站点泄漏口 sanitize | #3837 |

**Workbench 主视图 6195 → 5140 行**(-1055,-17%);两个大 view 硬编码 hex → **0**(WorkbenchView 残留 2 处为 issue-ref 注释非颜色,style-guard 已过)。

### Bridge-Agent 可视化线(design-lock `bridge-agent-admin-page-design-lock-20260707.md`,#3746 需求)

| 片 | 内容 | PR |
| --- | --- | --- |
| BA-UI-0 | design-lock(采纳 #3746 安全边界+验收为硬锁) | #3792 |
| BA-UI-1 | 只读可观测页(状态/实例/对象/schema 卡片,脱敏,零新路由,sentinel) | #3824 |
| BA-UI-2 | values-free 一键探测(health→objects→schema early-stop,durationBucket 不露 raw ms) | #3840 |
| BA-UI-3 | 配置校验 6 项 checklist + 变更建议清单(identifier-gate,零 apply/写) | #3858 |
| BA-UI-4 | 计划任务只读提示(不虚构运行态,零 start/stop 控件) | #3862 |

## 2. 质量纪律(全程)

- **零行为变化不变量**:每个 IU-2 抽取片证明 `IntegrationWorkbenchView.spec.ts` **零 diff**
  (50 测试字节未动)——结构重排的最强证明。向导片(IU-3/4)证明产出 config **字节等价**旧表单。
- **mutation 逐守卫**:每片主循环质量闸独立复跑 + mutation(错误码 identity/字节等价/权限门/
  sentinel 泄漏/no-control/step-gating…),全数 KILLED;多处闸内逮到真缺口并补(IU-1 raw
  errorMessage 第二泄漏点、IU-5a 有-position 路径 no-leak、IU-2b IU-6 空态无断言、client mirror
  drift…)。
- **values-free 全程**:BA 线所有诊断/证据/建议为 count/形状/布尔/coarse 码;raw errorMessage 永不
  渲染;凭据仅"已配置/未配置";sentinel 测试在纯层 + DOM 层双证。
- **CI 保护面**:integration-guard 单行 vitest union(33 spec pattern);修复一个 rebase-union 引入的
  **重复 run: key 静默丢 spec** 事故(YAML 只认最后一条)。
- **模型分派**:实现车道 Sonnet(worktree 隔离)+ 主循环 Opus/Fable 质量闸;Fable 不可用回退 Opus。

## 3. 边界(线级,明确不拉入)

写阶梯 W2+(独立轨 W0 锁 #3515,W1-frozen 为收尾口径,W4 生产写 customer-barred)· 递归 REC
(双门冻结)· BL 能力线(已关账 #3736)· BA start/stop 与本机 config 直改(BA-UI 第一版明确不做)。

## 4. 收尾三核验(在本 PR 各版本的 verified head 上执行;PR 合并 SHA 以 GitHub 为准)

```text
核验1 yml run 行 ⊇ 所有存在 integration spec —— PASS(33 spec pattern;JsonAssist 大小写不敏感
       捞 utils/jsonAssist.spec.ts;审阅 P2 后补入 integrationWorkbench.spec.ts(511行service)与
       MetaIntegrationFieldRuleAuthoring.spec.ts(212行,曾漏于 Integration* glob),现审计涵盖全
       apps/web/tests 下 integration/bridge/readSource/jsonAssist/optionSets/fieldHint/errorCode/
       MetaIntegration 前缀)
核验2 逻辑文件(非仅 .vue)全在 main —— PASS(11 文件:6 service/util + 5 组件)
核验3 完整 integration-guard 对 final main HEAD —— PASS(34 files / 465 tests,Node 20;Node 25 复证)
```

## 5. 后续(各自独立轨,非本线)

- BA-UI 后续能力:配置的**受控 apply**(第一版只出"变更建议",不落地)——需 owner opt-in + 后端受控写轨。
- IU-2 尾:export 块 + run-result tail 仍在 Workbench 壳(agent 判为"人为拆分无益"留内联)。
- 写自助化 W2+(#3515 轨)。
