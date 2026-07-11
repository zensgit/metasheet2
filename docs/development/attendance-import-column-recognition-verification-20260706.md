# 考勤导入列识别回显 验证报告 — 2026-07-06

> PR #3718 MERGED（squash `94f4530b0`，2026-07-06）。design-lock:
> `attendance-import-column-recognition-design-lock-20260706.md`。
> 对抗审阅（opus）：**APPROVE-with-hardening，0 P1/P2**（3 P3/3 NIT，硬化已入 `7a6451240`）。
> 同面板三部曲第三刀（xlsx 拦截 #3694 → 勾选生成模板 #3708 → 本刀）。

## 1. 交付

选中 CSV 的瞬间回显：🔴 红警示（缺日期列/缺人员列 + 修复指引）→ 🟢 已识别 chips（悬浮区分
「将作为记录字段导入」vs「用于表头识别/人员匹配」）→ ⚪ 将忽略 chips（提示仍可用于规则匹配）。
共享纯模块 `importHeaderRecognition.ts`；词汇按需**只读**拉取（绝不触碰 payload）；stale-file
守卫防连选竞态；xlsx 被拦不出面板；样式全 UF `--ms-*`。后端零改动。

## 2. 验证证据

- **前后端对齐**：日期/上下文键族 + 归一化逐字镜像后端，fixture-sync 测试直读插件源码锁死；
  审阅实证主路径红警示与后端校验闸门 `validateImportUploadCsvOrThrow` 逐字对齐——无"前端绿灯/后端拒绝"。
- 测试：单测 14（解析含 P3-1 首字符分隔符 parity/分类/降级/fixture-sync）+ 真挂载 3（混合列
  绿灰+双 title 断言 / 缺日期红警示 / xlsx 被拦无面板）。
- Mutation：识别函数短路 → 单测+挂载 7 测齐红 → 还原复绿；审阅方另做 3 处 mutation 确认无未测守卫。
- web-guard 14 spec / 345+ tests 绿（新 spec 进 run-list+双 filter+头注释）；`vue-tsc -b` 干净；审阅方 5 连跑无 flaky。

## 3. 审阅硬化记录（`7a6451240`）

P3-1 分隔符取首字符镜像后端（防两字符分隔符翻转裁决）；P3-3 绿 chip 按来源分语义防过度承诺
（行标签改「已识别」）；P3-2 落锁为 v1 已知限制（显式表头行+前导空行边缘，后端自身三条 header
路径互不一致）；NIT：词汇拉取 in-flight 去重、web-guard 头注释补齐。

## 4. Follow-up（gated）

自定义映射 CRUD/自定义字段进报表（客户"加字段进报表"正解）；orphan Section 面板接入随其挂载
切片；编码嗅探（GBK）如有客诉再议。
