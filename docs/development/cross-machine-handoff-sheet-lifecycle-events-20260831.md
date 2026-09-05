# 移交件:表生命周期事件与 Time Machine 的衔接(A 机 → B 机,2026-08-31)

> 按跨机公约(单机通道建议当日入库)。本件只**建议**,不改动 Time Machine 车道内任何代码或词表。values-free。

## 一、A 机侧已发生/在途的事实

1. **删表语义在改**:`DELETE /sheets/:sheetId` 原为硬删(`DELETE FROM meta_sheets` + 清 links),门为
   `canManageViews`——#5357 拆分后**仅有写权限的操作员仍可整表硬删**,与"结构操作归管理员"相悖。
   在途 PR(分支 `feat/multitable-rename`)将其改为:**软删**(置 `deleted_at`,列表已过滤该标记)+
   `POST /sheets/:sheetId/restore` 恢复 + 门收紧到 manage-schema 档;同支含表/库改名与命名乱码拒收。
2. **表的删除/恢复目前不产生任何历史事件**:删除路由零历史引用(实测);Time Machine 的
   `config_revision` 实体词表为封闭集 `field | permission | view | sheet_config`
   (`config-revision-recorder.ts:15`),**无"表存在性"实体**;持久归档 D 阶段覆盖规划器现"无生产调用方"。

## 二、给 B 机的建议(Time Machine 车道自裁)

时间线上看不到"表被删除/恢复",对追溯是个盲区(操作员误删场景刚在试用实例上被 owner 亲自问到)。建议
在词表演进时考虑增加表生命周期实体(如 `sheet_lifecycle`:deleted/restored,携 actor 与时刻),或以
D 阶段归档的 section 语义覆盖之——**取舍归 Time Machine 设计,A 机不预设方案**。

## 三、A 机的克制与接口

- A 机**未扩**封闭词表、未写任何伪事件——宁缺毋错,避免与 D 阶段归档语义冲突;
- 软删保住了容器与全部内容行,故未来无论 B 机选哪种事件方案,**回放底座完好**;
- 若 B 机定了事件形状,A 机可在删除/恢复路由处按形状补发事件(一处调用,已留位)。

## 四、互补关系(一句话)

软删守容器,Time Machine 守内容:软删恢复后历史完好如初;若仍是硬删,归档再强也无米下锅。
