# 审批表单页优化 — 切片 1 验证件

- 设计件:`approval-form-ux-slice1-design-20260916.md`。分支 `feat/approval-form-ux-slice1`。
- **闸的裁定绑定 head `05c9652ff`**(三轮独立 refute-first 闸的最终 head);之后仅 rebase 到当前 `main`(rebase 后 head `4bc40c229`,内容零变更;rebase 后复跑:vue-tsc exit 0、11 个受影响 spec 文件 345/345、Playwright lane 38/38 exit 0)。
- 三轮闸的完整记录(私有):`reviews/approval-form-ux-slice1-gate{1,2,3}-findings.md`。本件只摘录闸**亲跑**得到的数字与结论。

## 1. 三轮闸的轨迹(实现者 ≠ 闸;修复轮必重跑闸)

| 轮 | 裁定 | 阻塞项 | 闸亲跑的关键证据 |
|---|---|---|---|
| 1 | REJECT | 3 P1:改名漏了两条钉——一条在**必需的 Playwright lane**(`apps/web/verification/approval-canvas-sole-surface.spec.ts:404` 钉 `新模板`),一条在未入闸文件(`myDelegationForm.spec.ts:20`);A4 的重钉丢了判别力(把「计数是派生的」用例改到 1→0→1 后,对「计数被夹成 ≤1」的 mutation 不再红) | 必需 vitest 闸 461/461 文件、6862 测试;机制 A1–A6 逐条自证;17 行纯设置删除逐行核;零弱化断言 |
| 2 | REJECT | 1 P1:分类候选控件**挂载即发** `GET /api/approval-templates/categories`,必需 Playwright lane(`approval-browser-verify`)的 fail-closed"零失败请求"守卫被触发,**11 failed / 27 passed,exit 1**——而 vitest 闸 461/461、6864 全绿 | 闸 1 三条 P1 已确认修好;测试面 18 文件 +352/−72,17 行设置删除、**零**第三类改动;`UpdateApprovalTemplateRequest` 无 `required`(契约零变更) |
| 3 | **ACCEPT WITH CONDITIONS** | 无 | **Playwright lane 38/38,exit 0,跑两次**;vitest 461/461、**6866**(6864→6866 = +1 UPDATE 全形钉 +1 C1 拆分);vue-tsc / tsc exit 0;条件全为正文披露 |

## 2. 验收判据逐条(设计件 §1.3 / §2.3 / §3.3)

| 判据 | 结论 | 闸的证据 |
|---|---|---|
| A1 落库 key 逐字节不变 | ✅ | PATCH body 无 `key`;`ApprovalProductService.ts:5948` 的 `request.key !== undefined` 守卫使其不进 SET 子句(`:5985-5988`);mutation 让 PATCH 带 key ⇒ 恰红 1 条 |
| A2 只读且可见 | ✅ | Element Plus 2.11.8 把 `readonly` 绑到原生 input;去掉该属性 ⇒ 钉红 |
| A3 POST 仍带 key、后端测试零改动 | ✅ | `git diff --stat origin/main..HEAD -- packages/core-backend` = 恰 `ApprovalBreachNotifier.ts` + 其单测;`CreateApprovalTemplateRequest.required` 未动 |
| A4 新草稿无「模板 Key 必填」徽标 | ✅ | 播种提前到建草稿;回退 ⇒ 9 条红;闸 1 指出的判别力丢失已在闸 2 前修复(徽标用例恢复 ≥2 项观测,`Math.min(…,1)` 夹钳 mutation 红) |
| A5 跨模板观测点保留判别力 | ✅ | 闸自建 mutation(强制装错模板的 key)⇒ 3 条跨模板用例红;五条观测行**未改** |
| A6 B0 seed-gate 不变量重钉 | ✅ | 新钉在「PATCH 不发 key」上;原清空场景**逐字保留**作纵深 |
| B1 用户可见零「审批模板」 | ✅ | 声明范围内 19 → 2,剩 2 处是 `api.ts:52-53` 的 mock 模板**名字**(数据非 chrome) |
| B2 禁改边界零 diff | ✅ | 路由 path/name、权限 key、`data-testid`、RATIFIED 串、能力注册表、投影服务、Vue 文件名——闸独立 grep |
| B3 两条内层改名 | ✅ | `字段设计` / `字段权限` |
| B4 钉文案断言重钉不删 | ✅ | 11 条 + 闸 1 找出的 2 条,全部按新文案重钉 |
| C1 候选来自端点、允许新建 | ✅ | 三个 spec 各钉两条:**挂载不取** + **首次聚焦才取**;mutation 恢复挂载取 ⇒ 4 红;永不取 ⇒ 6 红 |
| C2 零后端变更 | ✅ | 同 A3 |
| C3 三处裸 DOM 语义 spec 继续通过 | ✅ | 渲染的 `<input>` 仍挂原 testid,解析为真 `HTMLInputElement` |

## 3. 闸 3 的 mutation 网格(闸自跑,预测先记后跑,`cp`→改→跑→还原→`cmp`)

| # | mutation | 预测 | 结果 |
|---|---|---|---|
| M1 | 恢复挂载时取候选 | 三条"不在挂载取"钉红 | **4 红**(其中一条用例首行同样断言) |
| M2 | 永不取候选 | 三条"聚焦才取"钉红 | **6 红**(3 钉 + 3 依赖候选的既有用例,强耦合非假钉) |
| M3 | UPDATE payload 丢一个基础信息字段(实现者未跑的隔离 mutation) | 新 UPDATE 全形钉红 | **恰红 1 条**——套件里没有别的东西抓得住,证明 P3-3 补的是真洞 |
| M4 | 回退 `templateAuthoring.ts:1427` 的改名 | ? | **全绿**——该字符串**零断言覆盖**,是 `origin/main` 继承的既有缺口,非本切片引入(已披露) |

## 4. 两件闸做得比实现者更进一步的验证

- **P3-6 尺寸回退(TemplateDetailView 的分类控件)**:实现者只在 jsdom 证结构(vitest 配置无 `css: true`,不能诚实地量宽度)。闸跑了**生产构建**,确认 `:where(.category-candidate-input)` 零特异性在压缩后原样存活、两条竞争规则确实落在不同 chunk(工具类在 eager 入口 CSS,组件在 lazy chunk),并在**真 Chromium** 里按两种加载顺序各量一次:详情页控件 **240×24**、与保存按钮同行;编辑页填满容器 32px——与 `origin/main` 基线(`el-input size="small"` + `ms-w-240`)完全一致。负控:去掉 `:where()`、工具类先加载 ⇒ 宽度**792px**,正是闸 2 看到的回归。
- **机械字符串扫描**:实现者第一次扫描**读到零文件**(沙箱的 `find`/`grep` 解析到 `bfs`,不对带引号的多路径变量分词,stderr 被吞)——正是仓内记过的「空读≠不存在」陷阱现场。闸改用真 `git grep` 扫 3736 个跟踪文件,先跑正控(已知字面量 9 命中)与负控(垃圾串 0 命中)再信任任何零;66 个被改字面量逐个查旧断言,11 类命中逐个判定(fixture 名字、注释、用例标题、其它产品面),**零残留**。

## 5. 测试纪律(闸 2 逐 hunk 核)

18 个测试文件 +352/−72:全部为 (i) 按新文案/新机制重钉,或 (ii) 纯设置行删除——**17 行** `setInput('approval-template-key', …)`,每个被删字面量都核过无下游读取;**零**第三类改动、零弱化断言、零移除观测点。`approval-ui-workspace` 的 2 条红与本切片无关:该文件在 `run-required-web-tests.sh:336` 注释里被点名隔离,不在 exec 行上。

## 6. 披露(闸 3 的四条条件,原样)

1. 保留的五个身份串(`TemplateAuthoringView.vue:205,212`、`templateAuthoring.ts:2087,2095`、`templateDetailLabels.ts:69`:「模板 Key」「模板名称」及其必填消息)——有意不改,改了会级联约 10 行不在 B4 表上的测试,且它们指的是**标识**而非概念。
2. 三条本切片新引入的裸「表单」散文(`TemplateAuthoringView.vue:1798,1800`、`ApprovalGraphNodeConfigEditor.vue:755`)——同屏 `:6` 副标题仍在字段区意义上用「表单」;归 owner 的 D2 文案裁决。
3. `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue` 里 16 处「审批模板」——多维表线,不在本切片。
4. `templateAuthoring.ts:1427` 已改名,但**零断言覆盖**(M4)。
5. 必需 Playwright lane 之所以绿,是**懒取避开了守卫**,不是 stub 了端点:守卫在挂载后即卸载监听,仍能抓到"回退成挂载取"的回归;但**将来任何会聚焦分类字段的 verification spec 都必须自带 `page.route` stub**——建议作为纵深防御在后续补。
6. 未解决、交 owner:Q1(按 key 搜索去留)、Q2(散文「表单」)、Q3(分组 org 作用域)。

## 7. 未做 / 边界

无 DDL;无路由、请求、响应形状变更;`.github/**` 零改动;`run-required-web-tests.sh` 只追加一个 token(`categoryCandidateInput`,双向子串碰撞对全部既有 token 为零);未跑 PG 轴(本切片无真库测试);服务端生成 key 不在本切片(设计件 §1.4)。
