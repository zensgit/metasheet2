# 考勤 UI-P0′：hero 打卡卡 design-lock — 2026-07-06

> **Status: RATIFIED（owner 2026-07-06 当日两问"UI 页面可以对标了？"+ /goal「余下的开发作为目标」
> ——员工自助打卡屏是其点名的对标主战场；本刀 = UI arc 首刀，按 UF token 口径校准后的 P0 核心。）**
> 承 `attendance-ui-uplift-plan-20260705`（P0 tokens+hero）与 UF arc（#3696/#3697 tokens.css 已 RATIFIED）：
> **不自立 `--att-*` 体系，新样式全部消费 `--ms-*`**；存量 130+ 硬编码 hex 的批量变量化是纯机械活，
> 拆为后续切片（Sonnet 额度恢复后跑量），本刀不动存量 CSS 值。

## 1. 范围（display-only，零逻辑改动）

总览（overview）header 的打卡区从"两个普通按钮"升级为 **hero 打卡卡**：
- **实时时钟**：HH:MM:SS（`tabular-nums`）+ 日期/星期行；`setInterval` 1s，卸载清理。
- **打卡按钮 hero 化**：上班打卡 = 大主按钮（新增修饰类 `--hero`，56px+ 高），下班打卡 = 次级大按钮。
- 布局：时钟 + 按钮组成卡片（`--ms-bg-card`/`--ms-border-light`/`--ms-radius-lg`/`--ms-space-*`）。

## 2. 保全（测试三条红线）

- **copy 逐字不动**：`Check In/上班打卡`、`Check Out/下班打卡`、`Working.../处理中...`（punch-outcome spec 按文案取按钮）。
- **既有 class 只增不删**：按钮保留 `attendance__btn`/`attendance__btn--primary`；按钮容器保留 `attendance__actions`（classList 断言均为 contains 语义）。
- `punch('check_in'|'check_out')` 绑定、`:disabled="punching"`、外勤备注表单（`data-attendance-punch-note-form`）路径逐字节不变。

## 3. 边界（OUT）

- 今日时间线/大数字数据卡/月历升级 = P1 后续刀；管理台/报表 header 不动；reports/admin 模式 chip 区不动。
- 存量 CSS hex 批量 token 化 = 独立机械切片（Sonnet）。

## 4. 测试契约

真挂载（selfservice/overview 面）：hero 卡存在（`data-testid="attendance-hero-punch"`）+ 时钟格式 `/^\d{2}:\d{2}:\d{2}$/` + `Check In` 按钮带 `--hero` 且原文案可取 + reports 模式不渲染 hero。mutation：中和时钟 computed → 格式断言红。新 spec 进 web-guard（run-list + 双 filter）或并入既有 selfservice spec（其已在 run-list）。

## 5. 完成口径

实现 → opus 对抗审阅 0 P1/P2 → 三红线 → 验证 MD。FE 串行车道（X1 排本刀之后）。
