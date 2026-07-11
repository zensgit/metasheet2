# 「余下的开发」Wave-1 验证报告（SheetJS 安全升级 + hero 打卡卡）— 2026-07-06

> owner /goal「请将余下的开发作为目标」下的固定节奏首轮，双刀均 MERGED。

## 1. #3737 SheetJS 0.18.5 → 0.20.3（`cc87b7bf9`）

- **性质（经对抗审阅勘误）**：就地修复**生产可达** CVE（CVE-2023-30533 原型污染 + CVE-2024-22363 ReDoS）——仓内 4 个动态 `import('xlsx')` 生产消费方（MetaImportModal 用户上传解析 / 两处 workbench 导出 / univer-meta `POST /import-xlsx` 服务端解析），并同时满足考勤 R3 X1 的 D3-a 安全门。npm 渠道停更 → 官方 tarball（lockfile 带 integrity 哈希 fail-closed）。
- 验证：`--frozen-lockfile` 干装通过；web xlsx-mapping 14/14 + backend unit 6/6 于 0.20.3 全绿；8 个 xlsx realdb 套件在 plugin-tests 真 Postgres 门内运行；双 typecheck 清。
- 审阅（opus）：APPROVE-with-hardening 无 P1；P2-1（"仅测试用"叙述错误）已修——R3 锁 D3 勘误 + PR body 重写。**教训入库**：依赖消费面断言必须 grep 静态+动态+require 三形态。

## 2. #3738 考勤 hero 打卡卡（`f5bd8d5a9`，UI 对标 arc 首刀）

- 总览 header 打卡区 → hero 卡：实时时钟（HH:MM:SS tabular-nums，1s interval，卸载清理）+ 日期星期行 + 大主按钮上班打卡 + 次级大按钮下班打卡；768px 纵向堆叠。display-only：punch 逻辑/文案/既有 class 逐字节不变（只增不删）；新样式全 UF `--ms-*`（含 `--ms-shadow-card`），零新 hex。
- 验证：真挂载（hero 存在/时钟格式/双按钮 copy+class 契约/reports 无 hero）；双 mutation（时钟中和 → 红；审阅方另证下班按钮基类缺口 → P3-1 补断言）；web-guard 14 spec 351 绿；typecheck 清。
- 审阅（opus）：**APPROVE 0 P1/P2**；"3 实例 interval 并存"担忧被证伪（ExperienceView 单动态槽，同刻仅 1 实例）；P3-1+NIT 已硬化（`0a77ef20c`）。
- **对标口径**：员工自助屏从"通用小按钮"进到"hero 打卡卡"；余量（大数字数据卡/今日时间线/月历升级）= UI-P1 后续刀；存量 130+ hex 批量 token 化 = Sonnet 恢复后机械切片。

## 3. Wave-2 排程

X1 xlsx 直导（D1=A 前端转换；D3-a 已由 #3737 满足 → R3 锁转 RATIFIED）→ UI-P1 余量 → E1 免登（backend 泳道）。
