# 多维表模板 install dry-run + 详情(S2 缩减版)— 设计锁定 — 2026-06-11

> Status: **DESIGN-LOCK(docs-only)** · arc 副线 S2;**范围按 #1571 C1 包的门控做工程/产品拆分**(见 §4)。
> 地基:2026-06-11 勘察(6 问,file:line 证据)。零迁移;不动 install 语义。

## 0. 范围一句话

S2(工程版)= ①`POST /templates/:id/dry-run`:**零写**模拟 install,返回 wouldCreate 清单 + 冲突诊断(formula dry-run 诊断架构);②模板中心**详情面**:渲染既有 descriptor(sheets/fields/views 结构)+ dry-run 结果 + 既有 install 按钮。**样例数据预览 / onboarding / 回滚策略变更 = PM 门控,明示不做**。

## 1. 承重事实(勘察)

| 事实 | 出处 |
|---|---|
| descriptor:`MultitableTemplate{id,name,description,category,icon,color,sheets[{fields,views}]}`;8 模板;**无 sampleRecords** | template-library.ts:14-45/88-321 |
| install:`installMultitableTemplate`(事务内 createSheet/ensureFields/createView;base ON CONFLICT → `MultitableTemplateConflictError`;sheet/view 冲突先检后写)返回结构对象,**不写记录** | template-library.ts:386-475;univer-meta.ts:3710 |
| 路由:GET /templates = `rbacGuard('multitable','read')`;POST install = `rbacGuard('multitable','write')`,201/404/409/500 | univer-meta.ts:3679/3683-3758 |
| dry-run 诊断先例:`DryRunDiagnostic{severity,kind,message,code?,fieldId?}` + `{success,diagnostics[]}` | formula-engine.ts:18-35/152-216 |
| 前端:卡片列表 + `useTemplateInstall.installAndOpen`(装完直跳工作台);**无详情/预览面;无 templateId 路由** | MultitableTemplateCenterView.vue:79-85;useTemplateInstall.ts:30-63 |
| C1 再入条件 = PM/SME 输入(G-1..G-7;G-4 样例数据、G-6/T7 回滚) | multitable-phase3-lane-c-pmsme-input-checklist-20260515.md:118-133 |

## 2. 锁定设计

### 2.1 后端 `POST /api/multitable/templates/:templateId/dry-run`

- 守卫 `rbacGuard('multitable','write')`(与 install 同门——dry-run 回答"我能否 install",read-only 用户得到的答案无意义);**零写:不开事务、不 INSERT**,纯查询既有 id 占用。
- 请求体 = install 同形(`{baseName?, workspaceId?}`);响应:

```
{ ok: true, data: {
  templateId, wouldCreate: { base: {id,name}, sheets: [{id,name,fieldCount,viewCount}],
                             fields: [{id,sheetId,name,type}], views: [{id,sheetId,name,type}] },
  conflicts: [ {severity:'error', kind:'base_exists'|'sheet_exists'|'view_exists', id, name, message} ],
  installable: boolean   // conflicts 中无 error 即 true
}}
```

- 冲突检测复用 install 的同源检查逻辑:**从 installMultitableTemplate 提取共享的 `detectTemplateConflicts(query, template, ids)` 纯查询函数,install 与 dry-run 同源消费**(防双实现漂移——本仓 wire-vs-fixture 纪律);id 生成与 install 同一 idGenerator 路径派生(dry-run 展示的 id 与真实 install 将创建的 id 同形,文档注明非承诺值)。
- 404(模板不存在)语义同 install。
- 诊断 message 英文 + code,客户端按 code 本地化(formula dry-run 同约)。

### 2.2 前端详情面

- 模板卡新增"查看详情"入口 → 详情视图(路由新增 `templateId` 参数页,挂在模板中心既有路由树下)。
- 详情渲染:descriptor 结构(每 sheet 的字段表[名称/类型/必填示意]、视图列表[类型/分组字段])+ **"检查可安装性"按钮**(调 dry-run,渲染 wouldCreate 摘要与冲突列表,conflict→install 按钮禁用 + 提示改 baseName)+ 既有 install 按钮(`useTemplateInstall` 复用)。
- i18n:模板中心既有模块(workbench-labels 或其归属模块,实现时按现有 template 字符串归属落)。
- **不渲染样例数据**(G-4 门控);详情页留扩展位注释。

### 2.3 边界

不动 install 语义/事务;无迁移;无 OpenAPI(两路由维持 internal 姿态——GET /templates 本就不在 spec,核实后保持一致);无 onboarding;无回滚语义变更(T7);不为 8 个模板authoring 任何内容。

## 3. 测试矩阵(fail-first)

| # | 场景 | 断言 |
|---|---|---|
| S2-T1 | dry-run 干净库:installable=true,wouldCreate 数量与 descriptor 一致 | 路由级(mock pool 先例) |
| S2-T2 | base/sheet/view 各类冲突:对应 conflict 条目 + installable=false;**与真实 install 在同场景下的 409 行为一致**(同源函数共享断言) | 路由级 |
| S2-T3 | **零写证明**:dry-run 前后 INSERT/UPDATE 零(query spy 断言只有 SELECT) | 路由级 |
| S2-T4 | RBAC:read-only 用户 403;404 模板 | 路由级 |
| S2-T5 | 详情面渲染 descriptor 结构;dry-run 按钮调用/冲突渲染/installable 驱动 install 按钮禁用 | 组件 spec |
| S2-T6 | install 回归:#1655 防覆盖语义不变(既有套件) | 既有 |
| S2-T7 | vue-tsc -b + 后端 tsc + 全套 | gates |

## 4. 门控声明(不做,留给 PM 流程)

样例数据预览(G-4:PM/SME 提供每模板 3-5 条脱敏记录)· onboarding 清单(C2,依赖 C1+T7)· 回滚策略(G-6/T7 决策)· 权限矩阵推荐(G-5)。本设计落地后,C1 包的工程地基(dry-run 端点 + 详情面)即就位,PM 输入到位时上述项可作小增量接入。

## 5. 回滚

纯增量(一路由 + 一共享函数提取 + 前端详情页):revert 即消失。
