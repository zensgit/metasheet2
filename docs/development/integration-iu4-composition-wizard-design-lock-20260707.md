# IU-4 组合配置向导 — DESIGN-LOCK(PROPOSED→随线授权生效)— 2026-07-07

> 上位锁:`integration-ux-workbench-redesign-design-lock-20260706.md`(RATIFIED)§2 IU-4。
> owner 2026-07-07 授权完成本线全部开发;本锁按 IU-3 锁同构起草,**实现门 = IU-3 落地**
> (两向导共享 preset 卡片/步进模式,IU-4 复用 IU-3 的组件语汇,先后有序防重复造轮)。

## 0. 问题

`IntegrationReadSourceCompositionAuthoringPanel.vue`(465 行)把两跳组合(hop1 输出 → hop2 key
输入)以平铺表单表达;链式语义(上一跳解析值如何变成下一跳输入)只存在于文字说明,用户需要
自行想象数据流。

## 1. 向导三步(锁定交互骨架)

```text
① 选两跳   从已审批 read-source configs 中选 hop1 与 hop2(卡片列表,含各自 preset/模式徽标);
           仅 resolver_lookup 类可作 hop(既有约束,展示层过滤)
② 接线可视  hop1 输出字段 →(连线示意)→ hop2 key 输入:一条固定的两跳数据流图
           (纯展示,v1 组合就是固定二步形状——不是自由画布,零新契约)
③ 审批     命名/保存组合 → 提交审批(既有 service 路径)
```

## 2. 硬锁(与 IU-3 同构)

- **零后端/契约变化**:既有 composition service(readSourceCompositions.ts)、S1 校验、审批路径
  全不动;向导产出的组合 config 与今天平铺表单**字节等价**(同输入→同 normalized 输出,测试证明)。
- **接线图 = 纯展示**:两跳固定形状的静态示意(SVG/CSS 线),不引入自由编排、不引入 >2 跳
  (REC 双门冻结不破)。
- **专家表单保留**(折叠≠删除);既有 `IntegrationReadSourceCompositionAuthoringPanel.spec.ts`
  断言零变化(stub 增加可,断言改动不可)。
- **复用 IU-3 组件语汇**:步进壳/卡片选择/证据展示样式与 IU-3 wizard 同源(可抽共享子件),
  不另起竞争样式词汇;token-only;values-free;zh+en。

## 3. 验收(双 MD)

步进 golden、hop 选择过滤(仅可组合 config 可选)、接线示意渲染(hop1 输出字段名与 hop2 输入
标签正确对应)、字节等价证明、专家模式保留、双 Node 绿。

## 4. 分派

锁/交互裁量 = Fable;实现 = Sonnet + 质量闸。

## 5. 边界

不做:>2 跳、自由编排画布、组合 runtime/审批语义改动、递归。
