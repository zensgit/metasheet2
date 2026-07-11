# 考勤 UI-P1 余量：今日时间线 + 大数字数据卡 design-lock — 2026-07-07

> **Status: RATIFIED（UI uplift 计划 P1 既定范围；owner /goal 全自动批次；hero 首刀 #3738 已落，
> 本刀补齐后 E2 解锁条件〔E1✅+UI-P1〕达成）。** display-only，零逻辑/接口改动；
> 新样式全 UF `--ms-*`；数据全部复用既有 computed（`activeWorkbenchRecord` 族），零新请求。

## 1. 范围

- **D1 今日时间线（hero 卡内）**：`activeWorkbenchRecord` 存在且为今日（`work_date === todayWorkDateKey`）
  时，hero 卡底部渲染两节点时间线：上班 `first_in_at` → 下班 `last_out_at`（未打 → 占位「--:--」+
  pending 样式）；时间 HH:MM。无今日记录 → 不渲染（`data-testid="attendance-hero-timeline"`）。
- **D2 大数字数据卡**：`attendance__summary--workbench` 四项（最近打卡/工时分钟/迟到早退/需处理）
  升级为 stat 卡：内联 SVG 图标首套（时钟/计时/警示/清单，`currentColor`）+ label（**copy 逐字不动**）+
  大数字 `strong`（`tabular-nums`，22px）。语义色：需处理 >0 → `--ms-color-danger`；迟到/早退非零 →
  `--ms-color-warning`；余 `--ms-text-1`。容器/item 类**只增不删**（`--stat` 修饰）。

## 2. 保全

selfservice spec 对该区零既有断言（已核）；`activeWorkbench*` computed 零改动；copy 不动；
类只增；`data-selfservice-*` 锚点不动。

## 3. 测试契约

selfservice spec 追加：今日记录（mock records 含今日 first_in/last_out）→ 时间线双节点时间正确；
无今日记录 → 无时间线；attention>0 → 对应 stat 卡带 danger 类；stat 卡保留原 copy。
Mutation：拆"仅今日才渲染"判断 → 无今日测试红；拆 danger 绑定 → 语义色测试红。

## 4. 完成口径

实现 → opus 审 0 P1/P2（额度恢复后）→ 三红线 → 验证 MD。FE 串行车道。
