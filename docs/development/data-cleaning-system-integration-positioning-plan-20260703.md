# 数据清洗与系统对接定位方案 — 2026-07-03

## 1. 一句话定位

我们不做宜搭/飞书低代码平台的平替。我们的方向是:

```text
面向制造、供应链、ERP/BOM 场景的数据清洗与系统对接平台:
支持多源读取、清洗校验、映射转换、冲突处理,并以 sandbox-first 方式受控回写目标系统。
```

换句话说,宜搭更擅长搭业务应用;我们更适合做复杂外部数据进入清洗流后的可信执行层。

## 2. 为什么不是正面打宜搭

宜搭/飞书/钉钉这类平台在以下方面天然更强:

- 表单、流程、审批、移动端、组织权限;
- 连接器生态和低代码应用搭建体验;
- 钉钉/飞书原生身份、消息、工作台入口;
- 普通企业应用的快速交付。

这些不是我们应该硬碰的主战场。若我们把目标定义成"也做一个宜搭",会被拖入通用低代码平台竞争:表单、流程、报表、连接器市场、拖拽编排、SaaS 生态。这条路资源消耗大,差异化弱。

我们的差异化在另一层:

- 老 ERP / K3 / SQL Server / on-prem / 私有网络里的复杂接口;
- 物料、BOM、主数据、编码、单位、规格等制造业语义;
- 数据清洗、校验、去重、冲突处理、人工确认;
- values-free 证据链、实体机验收、fail-closed 边界;
- dry-run / sandbox / re-pull 幂等 / dead-letter / owner-gated production write。

## 3. 客户看到的能力链

目标能力链不是"调一个接口",而是:

```text
外部系统读取
  -> 字段标准化
  -> 清洗校验
  -> 冲突/重复/缺失处理
  -> 人工确认
  -> dry-run
  -> sandbox 写回
  -> re-pull 幂等验证
  -> owner 授权生产写
```

典型场景:

- SQL Server 物料表 -> 清洗 -> K3 物料;
- PLM BOM -> 清洗/展开/对齐 -> ERP BOM;
- MES 工序数据 -> 清洗 -> ERP / 数据仓库;
- Excel / 数据库 / API 混合源 -> 标准化 -> 目标系统;
- 外部系统 A 的客户/物料/订单 -> 去重映射 -> 系统 B。

## 4. 产品分层

### 4.1 Read 自助化

读取可以逐步配置化、自助化。顾问/管理员配置已注册系统的读取源,平台保存时校验:

- endpoint 必须相对 registered system base;
- 凭据只在后端 credential store;
- runtime 用户只传 named input,不能传 raw endpoint/body/filter;
- 证据只出 counts/flags/types/coarse code;
- 支持四类读取模式:
  - `single_record`;
  - `list_page`;
  - `detail_with_lines`;
  - `resolver_lookup`。

这是"标准化读取"的主线,也是后续对接更多 API 系统的基础。

### 4.2 Transform 标准化

清洗层是我们的核心价值:

- 字段映射;
- 类型/格式校验;
- 编码映射;
- 单位/规格转换;
- 主数据匹配;
- BOM 展开与对齐;
- 重复/冲突/缺失分类;
- 人工确认队列;
- values-free 审计证据。

单纯连接 API 会越来越普通,清洗和冲突闭环才是粘性。

### 4.3 Write 受控化

写回不能像读取一样完全自助放开。写/改/删要保持独立 gate:

```text
dry-run -> sandbox apply -> re-pull idempotency -> human review -> token/owner authorization -> production apply
```

最低边界:

- 默认不写;
- production 默认关闭;
- 写入必须 bounded scope;
- per-row 失败隔离;
- dead-letter;
- rollback / recovery plan;
- values-free evidence;
- owner 明确授权。

删除是最高风险能力,不进入 v1 自助范围。

## 5. 和宜搭的关系

### 5.1 会有重叠

会在这些地方被客户放到同一张表里比较:

- 外部系统/API 接入;
- 表单或配置入口;
- 数据源展示;
- 简单流程触发;
- 顾问配置能力。

所以确实存在边缘竞争。

### 5.2 核心错位

宜搭主场:

```text
企业低代码应用搭建 + 钉钉生态 + 表单流程 + 快速交付
```

我们的主场:

```text
数据清洗 + ERP/数据库/BOM 对接 + 受控回写 + 可证明安全
```

正确打法不是"我们也是宜搭",而是:

```text
宜搭做业务入口和流程;
我们做复杂数据系统之间的清洗、校验、转换、冲突处理和安全回写。
```

必要时两者可以互补:宜搭承载前台流程/表单,我们作为后端可信数据执行层,从宜搭读取输入或把清洗结果回推到宜搭。

## 6. 宜搭做这件事的难度

宜搭做简单对接并不难:

- 拉列表;
- 查详情;
- 表单展示外部数据;
- 审批后调用接口;
- 简单同步。

但宜搭做完整的"多系统数据清洗 + ERP/BOM/数据库受控回写"难度高。原因:

- 老 ERP / K3 的接口形状与业务字段不稳定;
- BOM/物料语义需要选择规则、冲突处理、人工确认;
- 写回需要 dry-run、sandbox、幂等、dead-letter、rollback;
- 证据要做到 values-free,不能泄露行值/凭据/host/业务标识;
- 多系统差异需要归一到统一清洗模型。

如果宜搭硬做,通常会演变成:

```text
宜搭前台表单/流程
  + FaaS/自定义服务
  + 专门的数据清洗/写回中间层
```

这个中间层正是我们更应该占住的位置。

## 7. 近期路线建议

### 阶段 A — 读取标准化 v1

目标:第三方 API 只读接入标准化。

- 完成 `resolver_lookup` 的 R0/R1/R2;
- 四种 read mode 形成稳定配置合同;
- 顾问可配置读取源,用户 runtime key-only 消费;
- 保持 values-free evidence 和 approved-only。

完成口径:

```text
第三方 API 读取可配置化,但不是任意 API 自由接入。
```

### 阶段 B — 清洗模型强化

目标:把接入的数据变成可治理对象。

- 字段映射模板;
- 数据质量规则;
- 冲突/重复分类;
- 人工确认;
- 可复用行业模板:物料、BOM、供应商、客户、订单。

### 阶段 C — 受控写回 v1

目标:写回可用,但不可随意开。

- write-target config 独立合同;
- dry-run;
- sandbox apply;
- re-pull idempotency;
- dead-letter;
- owner production gate。

写/删不跟读取自助化混合发布。

### 阶段 D — 组合与编排

目标:支持多读源组合,但仍保持可证明边界。

- resolver output -> next read input 的 typed handoff;
- evidence stitching;
- partial failure 语义;
- retry/idempotency;
- composition design-lock 先行。

## 8. 不做什么

短期不做:

- 通用低代码表单平台;
- 通用审批流平台;
- 连接器市场大而全;
- 终端用户自由输入 endpoint/body/filter;
- 自助 production 写;
- 自助删除;
- 客户自定义 JS/SQL/regex/expression runtime。

这些会把产品拉回宜搭主场,并削弱安全边界。

## 9. 对外表达

推荐表达:

```text
我们提供制造业数据清洗场景的可信系统对接能力:
可从数据库、ERP、API 等多源读取数据,进行清洗、校验、映射和冲突处理,
并在需要时通过 sandbox-first 和 owner-gated 机制受控写回目标系统。
```

不推荐表达:

```text
我们是另一个宜搭/飞书低代码平台。
```

## 10. 决策结论

这条路线成立,而且比正面做低代码平台更适合当前能力积累。

战略选择:

```text
不抢"低代码应用平台";
抢"多系统数据清洗与受控回写"。
```

读取侧可以自助化,清洗侧要沉淀行业能力,写回侧必须继续保持 sandbox-first 和 owner gate。
