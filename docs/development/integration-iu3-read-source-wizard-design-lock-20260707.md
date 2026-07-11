# IU-3 读取源配置向导 — DESIGN-LOCK(PROPOSED)— 2026-07-07

> **状态:PROPOSED,等 owner ratify。** 本文锁向导交互与实现约束,不实现代码。
> 上位锁:`integration-ux-workbench-redesign-design-lock-20260706.md`(RATIFIED)§2 IU-3。
> 前置门:IU-2(壳 #3770 + 分区抽取 #3794)落地——向导挂在读取源分区内。

## 0. 问题(IU-1 audit 事实基线)

`IntegrationReadSourceConfigPanel.vue`(581 行,0 el-*)当前把 keyField / containerPaths /
resolverRule / keyEncoding / fieldMap / mode 等**内部配置模型字段平铺一页**,S1→探测→保存→审批流程
只在散文 `<p>` 里说明。用户必须先理解我们的配置模型才能下手。IU-6 已加字段 hint + 空态引导(缓解),
但结构仍是专家表单。

## 1. 向导四步(锁定交互骨架)

用 `el-steps` 呈现;当前步只露当前步字段;上一步可回改;末步才提交。

```text
① 选系统   从已注册 external-system 里点选(卡片或下拉),按 requiredKind 过滤到兼容适配器
② 定形状   读取模式做成【preset 卡片选择】而非裸 mode 下拉:
             - 单记录读(single_record)   - 列表分页读(list_page)
             - 主从明细读(detail_with_lines)- 解析定位读(resolver_lookup)
           选定 preset 后,只展开该模式 MODE_REQUIRED_FIELDS 的必填字段(渐进披露)
③ 探测     "定位容器探测"(既有 probe),证据【卡片化】:人话结论(复用 IU-1 label 模块)+
             容器/字段形状可视,机器码折叠详情;失败给下一步建议
④ 审批     保存版本 → 提交审批(既有 save + approve 路径)
```

## 2. 硬锁(零行为变化 + 专家不降级)

- **零后端/契约变化**:向导只是既有 `IntegrationReadSourceConfigPanel` 的**重排壳**;
  `readSourceConfigs.ts` service、S1 validator、probe 路由、审批路径、字段语义**全不动**。
  向导每一步产出的 config 片段最终拼成与今天**字节等价**的 S1-normalized config。
- **preset 卡片 = 展示层映射,非新契约**:四张卡片一一映射 `READ_SOURCE_MODES` 的四个已存在
  mode 值;卡片元数据(标题/一句话说明/该模式必填字段清单)进一个 typed 模块(如
  `readSourceModePresets.ts`,errorCodeLabels 同风格,zh+en,values-free),供向导消费。**不新增
  mode、不改 MODE_REQUIRED_FIELDS**。
- **专家模式保留**:向导旁提供"专家表单"切换 → 回到今天的全字段平铺面(折叠≠删除);高级字段
  (keyEncoding / resolver 多重性细项 / 多 fieldMap)默认折叠进各步的"高级"区,不移除。
- **既有测试不变量**:`IntegrationReadSourceConfigPanel.spec.ts` 现有断言(含 IU-6 空态、字段门)
  保持通过;向导为**新增**交互层,不改存量断言语义(必要的 el-steps stub 走 IU-2a 的 ElCard stub
  同法,注释说明)。
- **token-only + EP 图标**:骑 UF-1;新样式零 hex;图标走 Element Plus SVG。
- **values-free**:向导文案、preset 说明、探测证据零业务值示例(占位符形态)。

## 3. 验收(双 MD)

verification MD 需含:四步向导渲染 + 步进 golden、preset 卡片→mode 映射覆盖测试(四模式全覆盖 +
mode 集合 tripwire:未来加 mode 未配卡片则红)、专家模式切换保全字段面、向导产出 config 与旧面
**字节等价**证明(同输入 → 同 S1-normalized 输出)、el-*/token 覆盖、Node 20+默认双绿。

## 4. 模型分派

| 件 | 分派 |
| --- | --- |
| 本锁 / preset 卡片信息架构 / 步进交互裁量 | Fable 5 主循环 |
| 向导组件实现 / preset 模块 / 测试 | Sonnet 5 agent + 质量闸 |

## 5. 边界

不做:新读取模式、后端/契约/审批路径改动、组合向导(IU-4)、JSON 结构化(IU-5)、移动端。
向导落地后 IU-4 接续(两跳链可视化)。
